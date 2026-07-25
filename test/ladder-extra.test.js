// test/ladder-extra.test.js
// 天梯 Phase 1 健壮性补充测试（QA 独立复核盲区）。
// 不修改业务源码；仅在既有 test/ladder.test.js 之外补充边界与异常路径。
//
// 覆盖：
//  ① 24h 去重：同一对手（lastopp）24h 内不重复匹配；唯一候选被排除时降级合成
//  ② 带宽边界：score 在 ±15%/最小 ±50 边界外的候选不被匹配（边界 inclusive）
//  ③ 合成对手：空池返回 synthetic:true、name 来自占位池、result 仍按 my-opp 正确计算
//  ④ 历史裁剪：写入 >50 条后 getHistory(limit) 返回不超过 limit 且倒序正确
//  ⑤ 参数校验：缺 uid/score/ts 或 sig 错 → code 1/2
//  ⑥ 分数越界：超过 RANK_MAX_SCORE / 负数 → code 1；等于上限应放行
//
// 注意：match 响应结构为 { code, data:{ ..., synthetic, opponent:{...,synthetic} }, message }，
//       synthetic 标志在 data 与 data.opponent 两层均存在；opponent 不含 uid 字段。
//
// 约定（与 server/ladder.js 严格一致）：
//   - 内存 store（与 server.test.js / ladder.test.js 风格一致）
//   - match canonical = uid|score|steps|ts（score/steps 均 floor）
//   - history canonical = uid|ts
//   - 验签密钥 ladder-test-secret，SIGN_TTL=300

// ⚠️ 必须在 require verify/store/ladder 之前设置环境变量
process.env.RANK_SECRET = 'ladder-test-secret';
process.env.SIGN_TTL = '300';
process.env.RANK_STORE = 'memory';

const crypto = require('crypto');
const { createMemoryStore } = require('../server/store.js');
const { verifyPayload } = require('../server/verify.js');
const { LadderService } = require('../server/ladder.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// ---------- 测试脚手架（与 test/ladder.test.js 对齐） ----------
function fakeRes() {
  return {
    _status: 0, _headers: null, _body: null,
    writeHead(code, headers) { this._status = code; this._headers = headers; return this; },
    end(s) { this._body = s; },
  };
}
function fakeReqPOST(url, obj) {
  const body = JSON.stringify(obj);
  return {
    method: 'POST', url,
    on(evt, cb) { if (evt === 'data') cb(body); else if (evt === 'end') cb(); },
  };
}
function fakeReqGET(url) {
  return { method: 'GET', url };
}
// canonical 必须与 server/ladder.js match() 一致：uid|floor(score)|floor(steps)|ts
function sign(uid, score, steps, ts) {
  const sc = Math.floor(Number(score) || 0);
  const st = Math.floor(Number(steps) || 0);
  return crypto.createHmac('sha256', 'ladder-test-secret')
    .update(String(uid) + '|' + sc + '|' + st + '|' + ts).digest('hex');
}
function signHist(uid, ts) {
  return crypto.createHmac('sha256', 'ladder-test-secret')
    .update(String(uid) + '|' + ts).digest('hex');
}
function makeService(store) {
  return new LadderService(store, { verifyPayload, maxScore: 10000000 });
}
// 构造一次 /api/ladder/match 请求并解析响应（返回 data 层）
async function runMatch(svc, obj) {
  const res = fakeRes();
  await svc.match(fakeReqPOST('/api/ladder/match', obj), res);
  return JSON.parse(res._body);
}

// ---------- ① 24h 去重（lastopp 排除） ----------
async function testDedup24h() {
  const ts = Math.floor(Date.now() / 1000);
  // 场景 A：唯一对手 uA → 首次命中；第二次因 lastopp 排除 uA → 无候选 → 合成降级
  {
    const store = createMemoryStore();
    await store.saveSnapshot({ uid: 'uA', name: 'A', score: 1000, steps: 30, boardSummary: null, ts, synthetic: false });
    const svc = makeService(store);
    const m1 = await runMatch(svc, { uid: 'uC', name: 'C', score: 1020, steps: 32, boardSummary: null, ts, sig: sign('uC', 1020, 32, ts) });
    ok(m1.code === 0 && m1.data.synthetic === false, '① 首次匹配命中真实对手 uA');
    ok(m1.data.opponent.name === 'A', '① 应匹配 uA，实际 ' + (m1.data && m1.data.opponent && m1.data.opponent.name));
    ok(typeof m1.data.diff === 'number' && m1.data.diff === (1020 - m1.data.opponent.score), '① result/diff 应由本局分与对手分算出');

    const m2 = await runMatch(svc, { uid: 'uC', name: 'C', score: 1020, steps: 32, boardSummary: null, ts: ts + 1, sig: sign('uC', 1020, 32, ts + 1) });
    ok(m2.code === 0 && m2.data.synthetic === true, '① 同一对手(uA) 24h 内被 lastopp 排除 → 降级合成对手');
  }
  // 场景 B：多对手 → 不立即重复上一对手（验证 lastopp 排除「最近一个」）
  {
    const store = createMemoryStore();
    await store.saveSnapshot({ uid: 'uA', name: 'A', score: 1000, steps: 30, boardSummary: null, ts, synthetic: false });
    await store.saveSnapshot({ uid: 'uB', name: 'B', score: 1010, steps: 31, boardSummary: null, ts, synthetic: false });
    const svc = makeService(store);
    const m1 = await runMatch(svc, { uid: 'uC', name: 'C', score: 1020, steps: 32, boardSummary: null, ts, sig: sign('uC', 1020, 32, ts) });
    const m2 = await runMatch(svc, { uid: 'uC', name: 'C', score: 1020, steps: 32, boardSummary: null, ts: ts + 1, sig: sign('uC', 1020, 32, ts + 1) });
    ok(m1.code === 0 && m1.data.synthetic === false, '① 多对手首次命中真实对手');
    ok(m2.code === 0 && m2.data.synthetic === false, '① 第二次命中另一真实对手（lastopp 排除上一对手）');
    ok(m1.data.opponent.name !== m2.data.opponent.name, '① 24h 去重应使两次匹配到不同对手（不立即重复）');
  }
}

// ---------- ② 带宽边界（±15% / 最小 ±50，inclusive） ----------
async function testBandBoundary() {
  async function matchWithOpponent(myScore, oppScore) {
    const store = createMemoryStore();
    const ts = Math.floor(Date.now() / 1000);
    if (oppScore != null) {
      await store.saveSnapshot({ uid: 'opp', name: 'Opp', score: oppScore, steps: 10, boardSummary: null, ts, synthetic: false });
    }
    const svc = makeService(store);
    return runMatch(svc, { uid: 'me', name: 'Me', score: myScore, steps: 10, boardSummary: null, ts, sig: sign('me', myScore, 10, ts) });
  }
  // sc=1000 → band=150 → [850, 1150]
  ok((await matchWithOpponent(1000, 1150)).data.synthetic === false, '② 上边界内(1150)应匹配真实对手');
  ok((await matchWithOpponent(1000, 1151)).data.synthetic === true, '② 上边界外(1151)应合成降级');
  ok((await matchWithOpponent(1000, 850)).data.synthetic === false, '② 下边界内(850)应匹配真实对手');
  ok((await matchWithOpponent(1000, 849)).data.synthetic === true, '② 下边界外(849)应合成降级');
  // sc=100 → band=max(50, round(15))=50 → [50, 150]
  ok((await matchWithOpponent(100, 150)).data.synthetic === false, '② 最小±50：上边界150应匹配');
  ok((await matchWithOpponent(100, 151)).data.synthetic === true, '② 最小±50：151应合成降级');
  ok((await matchWithOpponent(100, 50)).data.synthetic === false, '② 最小±50：下边界50应匹配');
  ok((await matchWithOpponent(100, 49)).data.synthetic === true, '② 最小±50：49应合成降级');
  // 空池（无对手）→ 合成降级
  ok((await matchWithOpponent(1000, null)).data.synthetic === true, '② 空池应合成降级');
}

// ---------- ③ 合成对手（占位池 + result 正确） ----------
async function testSynthetic() {
  const names = ['神秘高手', '隐世宗师', '无名强者', '天梯幻影', '合成大师'];
  const my = 800;
  const band = Math.max(50, Math.round(my * 0.15)); // 120
  const store = createMemoryStore();
  const ts = Math.floor(Date.now() / 1000);
  const svc = makeService(store);
  const r = await runMatch(svc, { uid: 'me', name: 'Me', score: my, steps: 10, boardSummary: null, ts, sig: sign('me', my, 10, ts) });

  ok(r.code === 0 && r.data.synthetic === true, '③ 空池应合成降级 synthetic:true');
  ok(r.data.opponent.synthetic === true, '③ opponent.synthetic 应为 true');
  ok(names.includes(r.data.opponent.name), '③ 合成 name 应来自占位池，实际 ' + r.data.opponent.name);
  ok(typeof r.data.opponent.score === 'number', '③ 合成 opponent.score 应为数字');
  // result 仍正确计算：与 diff 符号一致，且 diff = 本局分 - 对手分
  const expResult = r.data.diff > 0 ? 'win' : r.data.diff < 0 ? 'loss' : 'draw';
  ok(r.data.result === expResult, '③ result 应与 diff 符号一致（实际 ' + r.data.result + '，期望 ' + expResult + '）');
  ok(r.data.diff === (r.data.myScore - r.data.opponent.score), '③ diff 应由本局分与对手分算出');
  // 合成对手分数贴近本局（±band 内），制造“势均力敌”体验
  ok(Math.abs(r.data.opponent.score - my) <= band, '③ 合成对手分应贴近本局（±band=' + band + ' 内）');
}

// ---------- ④ 历史裁剪（>50 → ≤limit 且倒序） ----------
async function testHistoryTrim() {
  const store = createMemoryStore();
  const base = 1000;
  for (let i = 0; i < 53; i++) {
    await store.pushHistory('uH2', { matchId: 'm' + i, myScore: i, oppName: 'O', oppScore: i, result: i % 2 ? 'win' : 'loss', diff: 0, ts: base + i });
  }
  const all = await store.getHistory('uH2', 100); // 默认上限 50
  ok(all.length === 50, '④ 写入 53 条应裁剪为 50，实际 ' + all.length);

  const lim = await store.getHistory('uH2', 10);
  ok(lim.length === 10, '④ limit=10 应返回 10 条，实际 ' + lim.length);
  ok(lim[0].matchId === 'm52', '④ 最新一场(m52)应在最前，实际 ' + (lim[0] && lim[0].matchId));

  let desc = true;
  for (let i = 0; i + 1 < lim.length; i++) if (lim[i].ts <= lim[i + 1].ts) desc = false;
  ok(desc, '④ limit=10 内 ts 应严格递减（倒序）');
  let descAll = true;
  for (let i = 0; i + 1 < all.length; i++) if (all[i].ts <= all[i + 1].ts) descAll = false;
  ok(descAll, '④ 整体 ts 应递减（倒序）');

  // 经 LadderService 信封验证 total / list
  const svc = makeService(store);
  const qts = Math.floor(Date.now() / 1000);
  const res = fakeRes();
  await svc.getHistory(fakeReqGET('/api/ladder/history?uid=uH2&limit=10&ts=' + qts + '&sig=' + signHist('uH2', qts)), res);
  const r = JSON.parse(res._body);
  ok(r.code === 0, '④ getHistory 信封 code=0，实际 ' + r.code);
  ok(r.data.total === 50, '④ total 应为 50，实际 ' + (r.data && r.data.total));
  ok(r.data.list.length === 10, '④ list 应为 10，实际 ' + (r.data && r.data.list.length));
}

// ---------- ⑤ 参数校验（缺 uid/score/ts 或 sig 错 → code 1/2） ----------
async function testParamValidation() {
  const store = createMemoryStore();
  const svc = makeService(store);
  const ts = Math.floor(Date.now() / 1000);

  // 缺 uid → code 1
  let r = await runMatch(svc, { name: 'X', score: 100, steps: 5, ts, sig: '' });
  ok(r.code === 1, '⑤ 缺 uid → code 1，实际 ' + r.code);

  // 缺 ts → code 1（ts 在 score/steps 之后单独校验）
  r = await runMatch(svc, { uid: 'u1', name: 'X', score: 100, steps: 5, sig: sign('u1', 100, 5, ts) });
  ok(r.code === 1, '⑤ 缺 ts → code 1，实际 ' + r.code);

  // sig 错 → code 2
  r = await runMatch(svc, { uid: 'u1', name: 'X', score: 100, steps: 5, ts, sig: 'deadbeef' });
  ok(r.code === 2, '⑤ sig 错 → code 2，实际 ' + r.code);

  // 缺 score（undefined）：命中 match() 第 81 行 `if (score == null)` → code 1，正确。
  // 注意：真正未覆盖的盲区是非数字【字符串】（如 "abc" / "123abc" / ""），
  // 它们在第 82 行被 `Math.floor(Number(score) || 0)` 静默 coerce 成 0，
  // 导致第 84 行的 !Number.isFinite(sc) 校验成为死代码，应拒未拒（见 test/ladder-nan.test.js：当前 FAIL，待 engineer 修复）。
  r = await runMatch(svc, { uid: 'u1', name: 'X', steps: 5, ts, sig: sign('u1', 0, 5, ts) });
  ok(r.code === 1, '⑤ 缺 score → code 1（规范：必填字段缺失应拒绝），实际 ' + r.code);
}

// ---------- ⑥ 分数越界（RANK_MAX_SCORE） ----------
async function testScoreBoundary() {
  const store = createMemoryStore();
  const svc = makeService(store);
  const ts = Math.floor(Date.now() / 1000);

  // 等于上限应放行
  let r = await runMatch(svc, { uid: 'u1', name: 'X', score: 10000000, steps: 5, ts, sig: sign('u1', 10000000, 5, ts) });
  ok(r.code === 0, '⑥ score == RANK_MAX_SCORE 应放行 code 0，实际 ' + r.code);

  // 超上限应拒绝（code 1）
  r = await runMatch(svc, { uid: 'u1', name: 'X', score: 10000001, steps: 5, ts, sig: sign('u1', 10000001, 5, ts) });
  ok(r.code === 1, '⑥ score > RANK_MAX_SCORE 应 code 1，实际 ' + r.code);

  // 负数应拒绝（code 1）
  r = await runMatch(svc, { uid: 'u1', name: 'X', score: -5, steps: 5, ts, sig: sign('u1', -5, 5, ts) });
  ok(r.code === 1, '⑥ score < 0 应 code 1，实际 ' + r.code);
}

async function main() {
  await testDedup24h();
  await testBandBoundary();
  await testSynthetic();
  await testHistoryTrim();
  await testParamValidation();
  await testScoreBoundary();

  console.log('ladder-extra.test: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
