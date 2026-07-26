// test/game-rank.test.js
// 验证：①排行榜滑动方向修复（手指上滑 → 列表上滚）②打开榜单触发云后端请求
// 用 mock 的 tt 运行时让 game.js 走 isTT 分支。
let touchStart, touchMove, touchEnd;
let requests = [];
let backHandler = null;
const HMAC = require('../src/hmac.js');
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
  onTouchMove: (fn) => { touchMove = fn; },
  enableBackPressed: () => {},
  onBackPressed: (cb) => { backHandler = cb; },
  request: (opt) => {
    requests.push(opt);
    if (opt.success) opt.success({ data: { top: [], selfRank: 1, selfName: '我', selfScore: 0 } });
  },
};
// 抖音运行时 requestAnimationFrame 是全局函数，mock 需放到 global
global.requestAnimationFrame = () => 0;

// 让排行榜后端地址非空，否则 submitScore/loadRank 会直接 return（不触发云请求）
const cfg = require('../config.js');
cfg.RANK_ENDPOINT = 'http://localhost:3000/api';
cfg.RANK_SECRET = 'test-secret-123'; // 启用签名，验证上报带 sig

const game = require('../game.js');
const T = game._t;

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// 初始在引导界面，系统返回应走系统默认（返回 false，不消费）
ok(T.getScreen() === 'guide', '初始应在 guide 界面');
ok(typeof backHandler === 'function' && backHandler() === false, '非排行榜界面系统返回应返回 false（交由系统默认）');

// ① 滑动方向：模拟手指上滑（clientY 减小）→ rankScroll 应增大
T.openRank();           // 切入 rank 界面
T.setScroll(0);
touchStart({ touches: [{ clientX: 100, clientY: 300 }] });
touchMove({ touches: [{ clientX: 100, clientY: 250 }] }); // 上滑 50
touchMove({ touches: [{ clientX: 100, clientY: 200 }] }); // 再上滑 50
ok(T.getScroll() > 0, '手指上滑时 rankScroll 应增大，实际 ' + T.getScroll());

// ⑤ 系统返回关闭排行榜：rank 界面调用返回处理器应消费事件（true）并切回 play
ok(T.getScreen() === 'rank', 'openRank 后应在 rank 界面');
ok(backHandler() === true, '排行榜界面系统返回应消费事件（返回 true）');
ok(T.getScreen() === 'play', '系统返回后应从排行榜切回 play');

// ② openRank 触发云后端：/score 上传 + /rank 拉取
const scoreReq = requests.find((r) => r.url.endsWith('/score'));
ok(!!scoreReq, 'openRank 应上传分数到 /score');
ok(requests.some((r) => r.url.indexOf('/rank') >= 0), 'openRank 应拉取 /rank');

// ③ 上报分数应带 HMAC 签名：sig 非空且与密钥算出的签名一致
const st0 = T.getRankState();
ok(!!scoreReq && scoreReq.data && !!scoreReq.data.sig, '/score 请求应携带 sig 签名');
ok(!!scoreReq && !!scoreReq.data.ts, '/score 请求应携带 ts 时间戳');
if (scoreReq && scoreReq.data) {
  const expected = HMAC.hmacSha256Hex('test-secret-123', st0.uid + '|' + scoreReq.data.score + '|' + scoreReq.data.ts);
  ok(scoreReq.data.sig === expected, 'sig 应与 HMAC(uid|score|ts) 一致');
}

// ③ 首次进入生成本机 uid + 昵称
const st = T.getRankState();
ok(!!st.uid && !!st.name, '应生成本机 uid 与展示昵称');

// ④ 错误态下关闭按钮优先：榜单拉取失败时，点 × 应关闭榜单而非「点哪都重试」
T.openRank();                       // 进入 rank（请求成功，error 清零）
T.setRankError('榜单请求失败');      // 强制错误态
ok(T.getScreen() === 'rank', '应处于 rank 界面');
ok(T.getRankState().error !== null, '应已进入榜单错误态');
// × 按钮中心坐标：rankCloseRect() = {x:PAD+10, y:56+10, w:28, h:28} = (22,66,28,28)，中心约 (36,80)
touchStart({ touches: [{ clientX: 36, clientY: 80 }] });
touchEnd({ changedTouches: [{ clientX: 36, clientY: 80 }] });
ok(T.getScreen() === 'play', '错误态点 × 应关闭排行榜回到 play（而非重试）');
// 错误态下点非关闭区（如列表中部）仍应触发重试
T.openRank();
T.setRankError('榜单请求失败');
const reqBefore = requests.length;
touchStart({ touches: [{ clientX: 187, clientY: 300 }] });
touchEnd({ changedTouches: [{ clientX: 187, clientY: 300 }] });
ok(T.getScreen() === 'rank' && requests.length > reqBefore, '错误态点非关闭区应重试拉榜且仍停留在 rank');

console.log('game-rank.test: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
