// test/game-over-rank.test.js
// 验证增量功能：合成满格（游戏结束）后，告知用户个人排名，并提示再来一局。
//
// 复用 game-rank.test.js 的 mock 思路：用 Proxy 伪造 ctx、伪造 global.tt 运行时，
// 其 request 实现为同步调用 opt.success，返回 { data: { top: [], selfRank: 1, selfName: '我', selfScore: 0 } }。
// 由于测试里 ctx 是 mock（Proxy 忽略一切绘制调用），仅验证「数据 / 请求 / 状态」层面，不断言 canvas 像素。
let touchStart, touchEnd;
let requests = [];
let backHandler = null;
const fakeCtx = new Proxy({}, {
  get: (t, p) => {
    if (p === 'createRadialGradient') return () => ({ addColorStop() {} });
    return () => {};
  },
  set: () => true,
});
const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
global.tt = {
  createCanvas: () => fakeCanvas,
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2 }),
  getStorageSync: (k) => (k === 'privacyAgreed' ? '1' : ''),
  setStorageSync: () => {},
  vibrateShort: () => {},
  onTouchStart: (fn) => { touchStart = fn; },
  onTouchEnd: (fn) => { touchEnd = fn; },
  onTouchMove: (fn) => {},
  enableBackPressed: () => {},
  onBackPressed: (cb) => { backHandler = cb; },
  request: (opt) => {
    requests.push(opt);
    if (opt.success) opt.success({ data: { top: [], selfRank: 1, selfName: '我', selfScore: 0 } });
  },
};
// 抖音运行时 requestAnimationFrame 是全局函数，mock 需放到 global，避免 loop() 触发真实绘制
global.requestAnimationFrame = () => 0;

// 让排行榜 / 天梯后端地址非空，否则 submitScore / loadRank / submitLadder 会直接 return（不触发云请求）
const cfg = require('../config.js');
cfg.RANK_ENDPOINT = 'http://localhost:3000/api';
cfg.RANK_SECRET = 'test-secret-123'; // 启用签名，与 game-rank.test.js 一致

const game = require('../game.js');
const T = game._t;

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

(async () => {
  // 初始处于引导界面
  ok(T.getScreen() === 'guide', '初始应在 guide 界面');

  // 点击「开始游戏」进入 play 界面，为游戏结束遮罩准备好 play 前置态
  // 开始按钮矩形（见 game.js guide 分支）：{ x: W/2-80, y: H/2+60, w: 160, h: 48 }
  touchStart({ touches: [{ clientX: 187, clientY: 417 }] });
  touchEnd({ changedTouches: [{ clientX: 187, clientY: 417 }] });
  ok(T.getScreen() === 'play', '点击开始游戏后应在 play 界面');

  // 触发游戏结束（triggerGameOver：上报成绩 + 天梯结算 + 拉取个人排名）
  const rankReqBefore = requests.filter((r) => r.url.indexOf('/rank') >= 0).length;
  let threw = false;
  try {
    T.loseGame();
  } catch (e) {
    threw = true;
    console.error('FAIL: loseGame 抛异常: ' + (e && e.stack ? e.stack : e));
  }

  // (d) loseGame() 不应抛异常（遮罩 / 排名代码路径可安全执行）
  ok(!threw, 'loseGame() 不应抛异常（遮罩/排名代码路径可安全执行）');

  // (a) 应触发一次 GET /rank 请求 —— 验证「游戏结束会拉取个人排名」
  const rankReqAfter = requests.filter((r) => r.url.indexOf('/rank') >= 0).length;
  ok(rankReqAfter > rankReqBefore, 'loseGame 应触发 GET /rank 请求拉取个人排名');
  ok(requests.some((r) => r.url.indexOf('/rank') >= 0 && r.method === 'GET'),
     '拉取个人排名应为 GET 方法');

  // (b) rankData 应被填充且 selfRank 为正整數（>0）—— 验证排名数据可用、可在遮罩展示
  const st = T.getRankState();
  ok(st.data && typeof st.data.selfRank === 'number' && st.data.selfRank > 0,
     'loseGame 后 rankData 应被填充且 selfRank > 0（实际：' + JSON.stringify(st.data) + '）');

  // (c) screen 应仍为 'play' —— 天梯匹配失败回退到结束遮罩路径，screen 不丢
  ok(T.getScreen() === 'play', 'loseGame 后 screen 应仍为 play（结束遮罩路径）');

  // 等待天梯异步回调（fetchLadderMatch 的 .then）执行完毕，
  // 确认即便匹配失败回退、screen 仍不丢（不会被误切到 ladder）
  await new Promise((r) => setTimeout(r, 0));
  ok(T.getScreen() === 'play', '天梯异步回调后 screen 仍应为 play（screen 不丢）');

  // (e) 房间入口按钮：点击应进入 room 界面（修复 Bug2：房间按钮此前仅绘制、无点击处理）
  const rm = T.roomEntryBtnRect();
  touchStart({ touches: [{ clientX: rm.x + rm.w / 2, clientY: rm.y + rm.h / 2 }] });
  touchEnd({ changedTouches: [{ clientX: rm.x + rm.w / 2, clientY: rm.y + rm.h / 2 }] });
  ok(T.getScreen() === 'room', '点击房间按钮应进入 room 界面（Bug2 修复）');
  T.roomExit();
  ok(T.getScreen() === 'play', '退出房间应回到 play 界面');

  console.log('game-over-rank.test: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
