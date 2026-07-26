// test/bug-regression.test.js
// 针对「4 个关联 Bug 修复 + 2 个支撑性降级修复」的独立回归断言（不轻信实现者自报，直接验证行为）。
//
// 已覆盖（由其它测试负责，本文件仅确认绿灯，不重复）：
//   Bug1 / rcmd 裸数组：store-upstash.test.js 断言 Array.isArray(body) 且 body[0]==='GET'（及全字符串）
//   Bug2 / 房间按钮命中：game-over-rank.test.js 用 _t.roomEntryBtnRect() + 模拟 touch → 'room' → roomExit → 'play'
//
// 本文件新增覆盖：
//   Bug3 / 游戏结束遮罩（triggerGameOver 整体 try/catch、fire-and-forget）：
//         触发 loseGame() 后，draw() 必须绘制「游戏结束」遮罩（→ 进入该分支的充要条件 state.over===true），
//         且绘制过程无异常、screen 保持 'play'。
//   Bug4 / 排名降级文案（loadRank 失败静默降级）：
//         mock 请求走 fail 分支 → rankError 被记录、rankData 为空、screen 不丢、
//         draw() 的排名行必须显示「排名暂不可用」（而非报错卡死）。
//   支撑修复 #2 / ladderGetHistory 降级：Upstash 后端 rcmd 抛错时 getHistory 返回 []（不抛异常）。
//   支撑修复 #3 / GET /api/rank 降级：store.getRankView 抛错时 HTTP 信封层返回 200 + 默认视图。

const http = require('http');
const { createUpstashStore } = require('../server/store.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

const realFetch = global.fetch; // 原生 fetch（用于向本地 server 发请求）

// ---------- 游戏端（Bug3 / Bug4） ----------
// 用 Proxy 伪造 ctx，并捕获所有 fillText 调用，用于断言「游戏结束遮罩 / 排名降级文案」实际被绘制。
let drawnTexts = [];
const fakeCtx = new Proxy({}, {
  get: (t, p) => {
    if (p === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (p === 'fillText') return (txt) => { drawnTexts.push(String(txt)); };
    return () => {};
  },
  set: () => true,
});
const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };

let touchStart, touchEnd;
global.tt = {
  createCanvas: () => fakeCanvas,
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2 }),
  getStorageSync: (k) => (k === 'privacyAgreed' ? '1' : ''),
  setStorageSync: () => {},
  vibrateShort: () => {},
  onTouchStart: (fn) => { touchStart = fn; },
  onTouchEnd: (fn) => { touchEnd = fn; },
  onTouchMove: () => {},
  enableBackPressed: () => {},
  onBackPressed: () => {},
};
global.requestAnimationFrame = () => 0; // 阻止 loop 真实绘制，避免无谓递归

const cfg = require('../config.js');
cfg.RANK_ENDPOINT = 'http://localhost:3000/api';
cfg.RANK_SECRET = ''; // 游戏端签名留空，便于 mock 忽略 sig

const game = require('../game.js');
const T = game._t;

async function runGameTests() {
  // 引导 → 开始游戏，进入 play 界面，为游戏结束遮罩准备前置态
  touchStart({ touches: [{ clientX: 187, clientY: 417 }] });
  touchEnd({ changedTouches: [{ clientX: 187, clientY: 417 }] });
  ok(T.getScreen() === 'play', 'Bug3/4 前置：应在 play 界面');

  // ===== Bug3：游戏结束遮罩能绘制（state.over===true 且无异常） =====
  {
    // 成功请求 mock：triggerGameOver 拉榜拿到有效排名（遮罩显示「你的排名」）
    global.tt.request = (opt) => { if (opt.success) opt.success({ data: { top: [], selfRank: 1, selfName: '我', selfScore: 0 } }); };
    let threw = false;
    try { T.loseGame(); } catch (e) {
      threw = true; console.error('FAIL: Bug3 loseGame 抛异常: ' + (e && e.stack ? e.stack : e));
    }
    ok(!threw, 'Bug3: loseGame() 不应抛异常（triggerGameOver 整体 try/catch、fire-and-forget）');

    // 渲染一帧：遮罩仅在 state.over===true && screen==='play' 时绘制「游戏结束」标题
    drawnTexts = [];
    let drawThrew = false;
    try { T.draw(); } catch (e) {
      drawThrew = true; console.error('FAIL: Bug3 draw 抛异常: ' + (e && e.stack ? e.stack : e));
    }
    ok(!drawThrew, 'Bug3: 结束遮罩绘制不应抛异常');
    ok(drawnTexts.includes('游戏结束'), 'Bug3: 结束遮罩应绘制「游戏结束」标题（state.over===true 已生效、遮罩未被阻断）');
    ok(T.getScreen() === 'play', 'Bug3: 结束遮罩期间 screen 应保持 play');
  }

  // ===== Bug4：loadRank 失败时 rankLine 显示「排名暂不可用」而非卡死 =====
  {
    // 失败请求 mock：request 的 fail 分支被触发
    global.tt.request = (opt) => { if (opt.fail) opt.fail({ errMsg: 'request:fail' }); };
    let threw = false;
    try { T.loseGame(); } catch (e) {
      threw = true; console.error('FAIL: Bug4 loseGame 抛异常: ' + (e && e.stack ? e.stack : e));
    }
    ok(!threw, 'Bug4: loadRank 失败也不应让 loseGame 抛异常（结束遮罩不被阻断）');

    await new Promise((r) => setTimeout(r, 0)); // 保险：等可能的异步回调落地

    const rs = T.getRankState();
    ok(rs.error != null, 'Bug4: 拉榜失败应被记录到 rankError（而非静默吞没成“无提示卡死”）');
    ok(rs.data == null, 'Bug4: 失败时应无 rankData（保持降级态）');
    ok(T.getScreen() === 'play', 'Bug4: 拉榜失败 screen 不应丢失（仍为 play）');

    // 渲染一帧：结束遮罩的排名行应为「排名暂不可用」
    drawnTexts = [];
    let drawThrew = false;
    try { T.draw(); } catch (e) {
      drawThrew = true; console.error('FAIL: Bug4 draw 抛异常: ' + (e && e.stack ? e.stack : e));
    }
    ok(!drawThrew, 'Bug4: 失败态下结束遮罩绘制不应抛异常');
    ok(drawnTexts.includes('排名暂不可用'), 'Bug4: 排名行应显示「排名暂不可用」（降级文案，而非报错卡死）');
  }
}

// ---------- 后端（支撑修复 #2 / #3） ----------
async function runStoreTests() {
  // 支撑修复 #2：Upstash getHistory 在 rcmd 抛错时降级返回 []（不抛异常）
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash-fake.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  global.fetch = async () => { throw new Error('upstash unreachable'); };
  const store = createUpstashStore();
  let histThrew = false, hist;
  try { hist = await store.getHistory('uX', 50); } catch (e) { histThrew = true; console.error('FAIL: #2 getHistory 抛异常: ' + e); }
  ok(!histThrew, '支撑#2: upstash getHistory 在后端异常时不应抛异常（ladderGetHistory try/catch 降级）');
  ok(Array.isArray(hist) && hist.length === 0, '支撑#2: 失败时应降级返回空数组 []，实际 ' + JSON.stringify(hist));
  global.fetch = realFetch; // 还原，避免影响后续 server 测试（server 测试需真实 fetch 发本地请求）

  // 支撑修复 #3：GET /api/rank 在 store.getRankView 抛错时 HTTP 信封层返回 200 + 默认视图
  process.env.STORAGE = 'upstash';
  process.env.RANK_SECRET = ''; // 开发模式跳过验签
  // 仅对 Upstash URL 让 fetch 失败；本地 server 的 client 请求显式走 realFetch
  global.fetch = (u, opts) => {
    const url = typeof u === 'string' ? u : (u && u.url);
    if (url && url.indexOf('upstash-fake.invalid') >= 0) return Promise.reject(new Error('upstash unreachable'));
    return realFetch(u, opts);
  };

  return new Promise((resolve) => {
    const server = http.createServer(require('../server/index.js'));
    server.listen(0, async () => {
      const port = server.address().port;
      try {
        const now = Math.floor(Date.now() / 1000);
        const r = await realFetch('http://127.0.0.1:' + port + '/api/rank?uid=u1&limit=100&ts=' + now + '&sig=');
        const j = await r.json();
        ok(r.status === 200, '支撑#3: /api/rank 在后端异常时应返回 200（降级而非 500），实际 ' + r.status);
        ok(j.code === 0 && j.data && Array.isArray(j.data.top) && j.data.top.length === 0
           && j.data.selfRank === 0 && j.data.selfName === '' && j.data.selfScore === 0,
           '支撑#3: 降级视图应为默认 {top:[],selfRank:0,selfName:\'\',selfScore:0}，实际 ' + JSON.stringify(j));
      } catch (e) {
        fail++; console.error('ERROR 支撑#3: ' + e);
      } finally {
        server.close();
        resolve();
      }
    });
  });
}

(async () => {
  await runGameTests();
  await runStoreTests();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.STORAGE;
  global.fetch = realFetch;
  console.log('bug-regression.test: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
