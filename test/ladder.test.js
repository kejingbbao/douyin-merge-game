// test/ladder.test.js
// 天梯 Phase 1 单测：验签复用、匹配命中、合成降级、历史读写（含倒序与裁剪 50）。
// 使用 memory store（与现有 server.test.js 风格一致），通过 mock 的 req/res 驱动 LadderService。
const crypto = require('crypto');

// ⚠️ 必须在 require verify/store 之前设置环境变量：verify.js 在加载时读取 RANK_SECRET / SIGN_TTL
process.env.RANK_SECRET = 'ladder-test-secret';
process.env.SIGN_TTL = '300';
process.env.RANK_STORE = 'memory';

const { createMemoryStore } = require('../server/store.js');
const { verifyPayload } = require('../server/verify.js');
const { LadderService } = require('../server/ladder.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// 假响应：捕获 writeHead / end
function fakeRes() {
  return {
    _status: 0, _headers: null, _body: null,
    writeHead(code, headers) { this._status = code; this._headers = headers; return this; },
    end(s) { this._body = s; },
  };
}
// 假请求：POST，body 为 JSON 字符串，立即触发 data/end
function fakeReqPOST(url, obj) {
  const body = JSON.stringify(obj);
  return {
    method: 'POST', url,
    on(evt, cb) {
      if (evt === 'data') cb(body);
      else if (evt === 'end') cb();
    },
  };
}
function fakeReqGET(url) {
  return { method: 'GET', url };
}
// 与后端一致的签名
function sign(uid, score, steps, ts) {
  return crypto.createHmac('sha256', 'ladder-test-secret').update(String(uid) + '|' + score + '|' + steps + '|' + ts).digest('hex');
}
function signHist(uid, ts) {
  return crypto.createHmac('sha256', 'ladder-test-secret').update(String(uid) + '|' + ts).digest('hex');
}
function makeService(store) {
  return new LadderService(store, { verifyPayload, maxScore: 10000000 });
}

async function main() {
  // ① 验签复用：合法 sig 通过、篡改 sig 被拒（code 2）
  {
    const store = createMemoryStore();
    const svc = makeService(store);
    const ts = Math.floor(Date.now() / 1000);
    const good = sign('uA', 1000, 20, ts);
    const res1 = fakeRes();
    await svc.match(fakeReqPOST('/api/ladder/match', { uid: 'uA', name: 'A', score: 1000, steps: 20, boardSummary: [[2, 2], [0, 0]], ts, sig: good }), res1);
    const r1 = JSON.parse(res1._body);
    ok(r1.code === 0, '① 合法签名应匹配成功 code=0，实际 ' + r1.code);

    const res2 = fakeRes();
    await svc.match(fakeReqPOST('/api/ladder/match', { uid: 'uA', name: 'A', score: 1000, steps: 20, boardSummary: null, ts, sig: 'deadbeef' }), res2);
    const r2 = JSON.parse(res2._body);
    ok(r2.code === 2, '① 篡改 sig 应被拒 code=2，实际 ' + r2.code);
  }

  // ② 匹配：命中相近分对手（排除本人）
  {
    const store = createMemoryStore();
    const ts = Math.floor(Date.now() / 1000);
    await store.saveSnapshot({ uid: 'uA', name: 'A', score: 900, steps: 30, boardSummary: null, ts, synthetic: false });
    await store.saveSnapshot({ uid: 'uB', name: 'B', score: 1025, steps: 35, boardSummary: null, ts, synthetic: false });
    const svc = makeService(store);
    const ts2 = Math.floor(Date.now() / 1000);
    const res = fakeRes();
    await svc.match(fakeReqPOST('/api/ladder/match', {
      uid: 'uC', name: 'C', score: 1020, steps: 32, boardSummary: null, ts: ts2,
      sig: sign('uC', 1020, 32, ts2),
    }), res);
    const r = JSON.parse(res._body);
    ok(r.code === 0, '② 匹配应成功 code=0，实际 ' + r.code);
    // 响应 opponent 按约定不含 uid（隐私），用 name 区分真实对手（uB 名为 'B'，合成名不冲突）
    ok(r.data && r.data.opponent && r.data.opponent.name === 'B',
      '② 应匹配到最近分的 uB（name=B），实际 ' + (r.data && r.data.opponent && r.data.opponent.name));
    ok(r.data.synthetic === false, '② 真实对手 synthetic 应为 false');
    ok(typeof r.data.diff === 'number', '② 返回应为数值分差');
  }

  // ③ 合成对手降级：空池返回 synthetic
  {
    const store = createMemoryStore();
    const svc = makeService(store);
    const ts = Math.floor(Date.now() / 1000);
    const res = fakeRes();
    await svc.match(fakeReqPOST('/api/ladder/match', {
      uid: 'uX', name: 'X', score: 800, steps: 25, boardSummary: null, ts,
      sig: sign('uX', 800, 25, ts),
    }), res);
    const r = JSON.parse(res._body);
    ok(r.code === 0, '③ 空池应成功降级，code=0，实际 ' + r.code);
    ok(r.data.synthetic === true, '③ 应返回 synthetic 对手');
    ok(r.data.opponent.synthetic === true, '③ opponent.synthetic 应为 true');
    ok(typeof r.data.opponent.score === 'number', '③ opponent.score 应为数字');
    ok(!!r.data.opponent.name, '③ opponent.name 应非空');
  }

  // ④ 历史读写：push 后 get 倒序、裁剪 50
  {
    const store = createMemoryStore();
    for (let i = 0; i < 60; i++) {
      await store.pushHistory('uH', { matchId: 'm' + i, myScore: i, oppName: 'O', oppScore: i, result: 'win', diff: 0, ts: 1000 + i });
    }
    const list = await store.getHistory('uH', 100);
    ok(list.length === 50, '④ 历史应裁剪为 50，实际 ' + list.length);
    ok(list[0].matchId === 'm59', '④ 最新一场应在最前（倒序），实际 ' + (list[0] && list[0].matchId));
    ok(list[0].ts > list[1].ts, '④ 倒序 ts 应递减');

    // 走完整 LadderService.getHistory 信封
    const svc = makeService(store);
    const ts = Math.floor(Date.now() / 1000);
    const res = fakeRes();
    await svc.getHistory(fakeReqGET('/api/ladder/history?uid=uH&limit=20&ts=' + ts + '&sig=' + signHist('uH', ts)), res);
    const r = JSON.parse(res._body);
    ok(r.code === 0, '④ getHistory 信封 code=0，实际 ' + r.code);
    ok(r.data.total === 50, '④ total 应为 50，实际 ' + (r.data && r.data.total));
    ok(r.data.list.length === 20, '④ 限制 20 条，实际 ' + (r.data && r.data.list.length));
  }

  // ⑤ 历史接口验签：错误 sig 应 code 2
  {
    const store = createMemoryStore();
    const svc = makeService(store);
    const ts = Math.floor(Date.now() / 1000);
    const res = fakeRes();
    await svc.getHistory(fakeReqGET('/api/ladder/history?uid=uZ&limit=20&ts=' + ts + '&sig=bad'), res);
    const r = JSON.parse(res._body);
    ok(r.code === 2, '⑤ 历史错误 sig 应 code=2，实际 ' + r.code);
  }

  // ⑥ 参数校验：缺 uid / 分数越界 应 code 1
  {
    const store = createMemoryStore();
    const svc = makeService(store);
    const ts = Math.floor(Date.now() / 1000);
    const res1 = fakeRes();
    await svc.match(fakeReqPOST('/api/ladder/match', { name: 'X', score: 100, steps: 5, ts, sig: '' }), res1);
    ok(JSON.parse(res1._body).code === 1, '⑥ 缺 uid 应 code=1');
    const res2 = fakeRes();
    await svc.match(fakeReqPOST('/api/ladder/match', { uid: 'uY', name: 'Y', score: 99999999, steps: 5, ts, sig: sign('uY', 99999999, 5, ts) }), res2);
    ok(JSON.parse(res2._body).code === 1, '⑥ 分数越界应 code=1');
  }

  console.log('ladder.test: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
