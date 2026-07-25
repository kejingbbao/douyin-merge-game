// test/server-http.test.js
// 直接启动真实 HTTP 服务，验证防刷分：签名校验 / 时间戳防重放 / 分数范围。
process.env.RANK_SECRET = 'server-test-secret';
process.env.RANK_STORE = 'memory';
const http = require('http');
// server/index.js 导出的是 Vercel Serverless 请求处理函数（handler），
// 本地测试需自行用 http.createServer 包一层才能 listen。
const server = http.createServer(require('../server/index.js'));
const HMAC = require('../src/hmac.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

const SECRET = 'server-test-secret';
const signScore = (uid, score, ts) => HMAC.hmacSha256Hex(SECRET, uid + '|' + score + '|' + ts);
const signRank = (uid, ts) => HMAC.hmacSha256Hex(SECRET, uid + '|' + ts);

function postScore(uid, score, ts, sig) {
  const body = JSON.stringify({ uid, name: 'T', score, ts, sig });
  return fetch(base + '/api/score', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
}
function getRank(uid, ts, sig) {
  return fetch(base + '/api/rank?uid=' + encodeURIComponent(uid) + '&limit=100&ts=' + ts + '&sig=' + encodeURIComponent(sig));
}

let base = '';
server.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    const now = Math.floor(Date.now() / 1000);

    // 1) 合法签名 -> 200
    let r = await postScore('u1', 500, now, signScore('u1', 500, now));
    let j = await r.json();
    ok(r.status === 200 && j.code === 0 && j.data && j.data.ok === true, '合法签名应 200，实际 ' + r.status + ' ' + JSON.stringify(j));

    // 2) 错误签名 -> 403
    r = await postScore('u1', 999999, now, 'deadbeef');
    ok(r.status === 403, '错误签名应 403，实际 ' + r.status);

    // 3) 分数超范围 -> 400
    r = await postScore('u1', 999999999, now, signScore('u1', 999999999, now));
    ok(r.status === 400, '超大分数应 400，实际 ' + r.status);
    r = await postScore('u1', -5, now, signScore('u1', -5, now));
    ok(r.status === 400, '负分应 400，实际 ' + r.status);

    // 4) 合法后查榜 -> 200 且含该玩家
    r = await getRank('u1', now, signRank('u1', now));
    j = await r.json();
    ok(r.status === 200 && j.code === 0 && j.data && j.data.selfRank === 1, '查榜应 200 且自己第 1，实际 ' + r.status + ' ' + JSON.stringify(j));

    // 5) 查榜错误签名 -> 403
    r = await getRank('u1', now, 'bad');
    ok(r.status === 403, '查榜错误签名应 403，实际 ' + r.status);

    // 6) 过期时间戳（年份 1970）-> 403，即使签名正确
    r = await getRank('u1', 100, signRank('u1', 100));
    ok(r.status === 403, '过期时间戳应 403，实际 ' + r.status);
  } catch (e) {
    fail++; console.error('ERROR', e);
  } finally {
    server.close();
    console.log('server-http.test: pass=' + pass + ' fail=' + fail);
    process.exit(fail === 0 ? 0 : 1);
  }
});
