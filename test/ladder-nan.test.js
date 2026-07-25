// test/ladder-nan.test.js
// 回归测试：/api/ladder/match 的 score 字段类型校验（对应源码缺陷）。
// 设计约定（server/ladder.js 注释 + 系统设计要求）：score 为必填数值，
// 缺失或非数字字符串应返回 code 1（PARAM），禁止被静默当成 0 落库。
//
// ⚠️ 当前源码（server/ladder.js:82 `Math.floor(Number(score) || 0)`）会把
//    非数字字符串 / 空串静默 coerce 成 0，导致第 84 行的 !Number.isFinite(sc)
//    校验成为死代码。以下「应返回 code 1」用例在修复前会失败 —— 这是预期的，
//    用于驱动 engineer 修复（修复后重跑应全绿）。
//
// 脚手架与 ladder-extra.test.js 对齐。
process.env.RANK_SECRET = 'ladder-test-secret';
process.env.SIGN_TTL = '300';
process.env.RANK_STORE = 'memory';

const crypto = require('crypto');
const { createMemoryStore } = require('../server/store.js');
const { verifyPayload } = require('../server/verify.js');
const { LadderService } = require('../server/ladder.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

function fakeRes() {
  return { _status: 0, _headers: null, _body: null,
    writeHead(c, h) { this._status = c; this._headers = h; return this; },
    end(s) { this._body = s; } };
}
function fakeReqPOST(url, obj) {
  const body = JSON.stringify(obj);
  return { method: 'POST', url,
    on(evt, cb) { if (evt === 'data') cb(body); else if (evt === 'end') cb(); } };
}
// 客户端签名（与 src/ladder.js / server 一致：floor(score|steps)）
function sign(uid, score, steps, ts) {
  return crypto.createHmac('sha256', 'ladder-test-secret')
    .update(String(uid) + '|' + Math.floor(Number(score) || 0) + '|' + Math.floor(Number(steps) || 0) + '|' + ts).digest('hex');
}
async function runMatch(svc, obj) {
  const res = fakeRes();
  await svc.match(fakeReqPOST('/api/ladder/match', obj), res);
  return JSON.parse(res._body);
}

async function main() {
  const store = createMemoryStore();
  const svc = new LadderService(store, { verifyPayload, maxScore: 10000000 });
  const ts = Math.floor(Date.now() / 1000);

  // —— 非数字字符串：应被拒 code 1（当前被静默当 0 → code 0，BUG）——
  let r = await runMatch(svc, { uid: 'u1', name: 'X', score: 'abc', steps: 5, ts, sig: sign('u1', 'abc', 5, ts) });
  ok(r.code === 1, '非数字字符串 score="abc" 应返回 code 1，实际 ' + r.code);

  r = await runMatch(svc, { uid: 'u1', name: 'X', score: '123abc', steps: 5, ts, sig: sign('u1', '123abc', 5, ts) });
  ok(r.code === 1, '含数字字符串 score="123abc" 应返回 code 1，实际 ' + r.code);

  r = await runMatch(svc, { uid: 'u1', name: 'X', score: '', steps: 5, ts, sig: sign('u1', '', 5, ts) });
  ok(r.code === 1, '空串 score="" 应返回 code 1，实际 ' + r.code);

  // 正例对照：合法数值不应被拒（确保测试本身有效）
  r = await runMatch(svc, { uid: 'u2', name: 'Y', score: 1000, steps: 5, ts, sig: sign('u2', 1000, 5, ts) });
  ok(r.code === 0, '合法数值 score=1000 应放行 code 0，实际 ' + r.code);

  // score=0 仍应放行（设计保留显式 0 为合法值）
  r = await runMatch(svc, { uid: 'u3', name: 'Z', score: 0, steps: 5, ts, sig: sign('u3', 0, 5, ts) });
  ok(r.code === 0, '显式零分 score=0 应放行 code 0，实际 ' + r.code);

  console.log('ladder-nan.test: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
