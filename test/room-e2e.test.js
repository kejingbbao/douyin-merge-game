// test/room-e2e.test.js
// 房间对战「带合法签名」的端到端集成测试。
//
// 覆盖目标：不依赖两台真机，真实启动 HTTP 服务，用与前端一致的 HMAC（src/hmac.js 的
// HMAC.hmacSha256Hex）跑完整房间链路，证明服务端房间逻辑闭环：
//   create → join → progress → state → result → state(终局) → leave → reset → 再来一局，
//   以及两个反例：非法签名（code=2）、满员保护（code=4）。
//
// 关键约束：
//   1) 必须在 require('../server/index.js') 之前设置环境变量（index.js / verify.js 在模块
//      加载时读取 RANK_SECRET / RANK_STORE）。
//   2) 签名 canonical 严格对齐 server/index.js 的 ROOM_ROUTES 表（已锁定，不可改）：
//        create/join/state/leave/reset → String(uid) + '|' + ts
//        progress/result              → String(uid) + '|' + score + '|' + steps + '|' + ts
//   3) 服务端验签密钥来自 process.env.RANK_SECRET，时间窗 SIGN_TTL 默认 300s。
//
// 依赖：RANK_SECRET / RANK_STORE 环境变量（memory 后端，进程内隔离）。
process.env.RANK_SECRET = 'room-e2e-secret';
process.env.RANK_STORE = 'memory';
const http = require('http');
// server/index.js 导出 Vercel Serverless 请求处理函数（handler），本地需自行包一层 createServer。
const server = http.createServer(require('../server/index.js'));
const HMAC = require('../src/hmac.js');

const SECRET = 'room-e2e-secret';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL: ' + msg); } }

// ---------- 签名辅助（对齐 ROOM_ROUTES 的 canonical） ----------
function sign(uid, ts) {
  return HMAC.hmacSha256Hex(SECRET, String(uid) + '|' + ts);
}
function signScore(uid, score, steps, ts) {
  return HMAC.hmacSha256Hex(SECRET, String(uid) + '|' + score + '|' + steps + '|' + ts);
}

// ---------- 请求辅助 ----------
async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function getState(code, uid, ts, sig) {
  const url = base + '/api/room/state' +
    '?code=' + encodeURIComponent(code) +
    '&uid=' + encodeURIComponent(uid) +
    '&ts=' + ts +
    '&sig=' + encodeURIComponent(sig);
  const res = await fetch(url);
  return { status: res.status, json: await res.json() };
}

let base = '';
server.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    const now = Math.floor(Date.now() / 1000);
    const P1 = 'p1-e2e';
    const P2 = 'p2-e2e';
    const P3 = 'p3-e2e';

    // ---------- 1) create：p1 建房 ----------
    const created = await post('/api/room/create', { uid: P1, name: 'P1', ts: now, sig: sign(P1, now) });
    ok(created.status === 200 && created.json.code === 0, 'create 应 200/code0，实际 ' + created.status + ' ' + JSON.stringify(created.json));
    const roomCode = created.json.data && created.json.data.code;
    const createdSeed = created.json.data && created.json.data.seed;
    ok(typeof roomCode === 'string' && /^[A-Z0-9]{6}$/.test(roomCode), '房码应为 6 位大写字母+数字，实际 ' + JSON.stringify(roomCode));
    ok(created.json.data.status === 'waiting', 'create 后 status 应为 waiting，实际 ' + JSON.stringify(created.json.data && created.json.data.status));
    ok(typeof createdSeed === 'number', 'create 应下发数字 seed，实际 ' + JSON.stringify(createdSeed));
    ok(created.json.data.startAt === null, 'create 后 startAt 应为 null，实际 ' + JSON.stringify(created.json.data && created.json.data.startAt));
    ok(created.json.data.ttl === 600, 'create 后 ttl 应为 600，实际 ' + JSON.stringify(created.json.data && created.json.data.ttl));

    // ---------- 2) join：p2 加入同一房码 ----------
    const joined = await post('/api/room/join', { code: roomCode, uid: P2, name: 'P2', ts: now, sig: sign(P2, now) });
    ok(joined.status === 200 && joined.json.code === 0, 'join 应 200/code0，实际 ' + joined.status + ' ' + JSON.stringify(joined.json));
    ok(joined.json.data.status === 'playing', '两人均到齐后 status 应为 playing，实际 ' + JSON.stringify(joined.json.data && joined.json.data.status));
    ok(typeof joined.json.data.startAt === 'number', 'join 后 startAt 应为数字（含 SYNC_BUFFER 补偿），实际 ' + JSON.stringify(joined.json.data && joined.json.data.startAt));

    // ---------- 3) progress：双方上报进度 ----------
    const pr1 = await post('/api/room/progress', { code: roomCode, uid: P1, score: 100, steps: 5, over: false, ts: now, sig: signScore(P1, 100, 5, now) });
    const pr2 = await post('/api/room/progress', { code: roomCode, uid: P2, score: 150, steps: 6, over: false, ts: now, sig: signScore(P2, 150, 6, now) });
    ok(pr1.status === 200 && pr1.json.code === 0 && pr1.json.data.ok === true, 'p1 progress 应 200/code0/ok，实际 ' + pr1.status + ' ' + JSON.stringify(pr1.json));
    ok(pr2.status === 200 && pr2.json.code === 0 && pr2.json.data.ok === true, 'p2 progress 应 200/code0/ok，实际 ' + pr2.status + ' ' + JSON.stringify(pr2.json));

    // ---------- 4) state：p1 轮询进度 ----------
    const st1 = await getState(roomCode, P1, now, sign(P1, now));
    ok(st1.status === 200 && st1.json.code === 0, 'state 应 200/code0，实际 ' + st1.status + ' ' + JSON.stringify(st1.json));
    ok(st1.json.data.status === 'playing', 'state 中 status 应为 playing，实际 ' + JSON.stringify(st1.json.data && st1.json.data.status));
    ok(st1.json.data.myScore === 100, 'p1 的 myScore 应为 100，实际 ' + JSON.stringify(st1.json.data && st1.json.data.myScore));
    ok(st1.json.data.oppScore === 150, 'p1 视角 oppScore 应为 150，实际 ' + JSON.stringify(st1.json.data && st1.json.data.oppScore));

    // ---------- 5) result：双方提交终局结果（p2 分高且 won=true） ----------
    const rs1 = await post('/api/room/result', { code: roomCode, uid: P1, score: 100, steps: 5, won: false, ts: now, sig: signScore(P1, 100, 5, now) });
    const rs2 = await post('/api/room/result', { code: roomCode, uid: P2, score: 150, steps: 6, won: true, ts: now, sig: signScore(P2, 150, 6, now) });
    ok(rs1.status === 200 && rs1.json.code === 0 && rs1.json.data.ok === true, 'p1 result 应 200/code0/ok，实际 ' + rs1.status + ' ' + JSON.stringify(rs1.json));
    ok(rs2.status === 200 && rs2.json.code === 0 && rs2.json.data.ok === true, 'p2 result 应 200/code0/ok，实际 ' + rs2.status + ' ' + JSON.stringify(rs2.json));

    // ---------- 6) state（终局）：双方 results 齐 → finished / matchResult=2 ----------
    const stEnd = await getState(roomCode, P1, now, sign(P1, now));
    ok(stEnd.status === 200 && stEnd.json.code === 0, '终局 state 应 200/code0，实际 ' + stEnd.status + ' ' + JSON.stringify(stEnd.json));
    ok(stEnd.json.data.status === 'finished', '终局 state.status 应为 finished，实际 ' + JSON.stringify(stEnd.json.data && stEnd.json.data.status));
    ok(stEnd.json.data.matchResult === 2, 'uids[0]=p1 / uids[1]=p2，p2 分高且 won，matchResult 应为 2，实际 ' + JSON.stringify(stEnd.json.data && stEnd.json.data.matchResult));

    // ---------- 7) leave：p1 离开（终局态，仅返回 ok，不改终局） ----------
    const lv = await post('/api/room/leave', { code: roomCode, uid: P1, ts: now, sig: sign(P1, now) });
    ok(lv.status === 200 && lv.json.code === 0 && lv.json.data.ok === true, 'leave 应 200/code0/ok，实际 ' + lv.status + ' ' + JSON.stringify(lv.json));

    // ---------- 8) reset：终局后 p1 触发再来一局 ----------
    const rst = await post('/api/room/reset', { code: roomCode, uid: P1, ts: now, sig: sign(P1, now) });
    ok(rst.status === 200 && rst.json.code === 0, 'reset 应 200/code0，实际 ' + rst.status + ' ' + JSON.stringify(rst.json));
    ok(rst.json.data.status === 'waiting', 'reset 后 status 应为 waiting，实际 ' + JSON.stringify(rst.json.data && rst.json.data.status));
    ok(typeof rst.json.data.seed === 'number' && rst.json.data.seed !== createdSeed, 'reset 后应下发新 seed 且不同于旧 seed，实际 new=' + JSON.stringify(rst.json.data && rst.json.data.seed) + ' old=' + createdSeed);

    // ---------- 9) 非法签名：带错误 sig → code=2（签名失效） ----------
    const bad = await post('/api/room/create', { uid: 'x-bad', name: 'X', ts: now, sig: 'deadbeefdeadbeef' });
    ok(bad.status === 200 && bad.json.code === 2, '非法签名应返回 code=2，实际 ' + bad.status + ' ' + JSON.stringify(bad.json));

    // ---------- 10) 满员保护：同一房码第 3 人 join → code=4（房间已满） ----------
    // reset 后房间仍保留 p1、p2 两个槽位；第 3 人加入应被拒。
    const third = await post('/api/room/join', { code: roomCode, uid: P3, name: 'P3', ts: now, sig: sign(P3, now) });
    ok(third.status === 200 && third.json.code === 4, '满员后第 3 人 join 应返回 code=4，实际 ' + third.status + ' ' + JSON.stringify(third.json));
  } catch (e) {
    fail++;
    console.error('ERROR', e);
  } finally {
    server.close();
    console.log('room-e2e.test: pass=' + pass + ' fail=' + fail);
    process.exit(fail === 0 ? 0 : 1);
  }
});
