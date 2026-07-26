// test/rank-close-regression.test.js
// 针对「排行榜关闭按钮间歇性失灵」修复的回归断言。
//
// 根因：排行榜打开后点左上角 ×，手指从按下到抬起的位移 >12px 时 × 完全不响应
//       —— 此前关闭判定被 `dx/dy < 12` 的轻点阈值门控吞掉。
// 修复：onTouchEnd 的 `screen === 'rank'` 分支把关闭判定移出轻点阈值门控，
//       用 `hit(cr, t) || hit(cr, pressPt)`（按下点或抬起点任一命中 ×）判定关闭；
//       并新增 rankReturnScreen 记录来源界面，关闭时回到该界面。
//
// 复用既有测试基础设施（test/bug-regression.test.js、game-over-rank.test.js 同款风格）：
//   - 用 Proxy 伪造 ctx、伪造 global.tt 运行时，捕获 onTouchStart/onTouchEnd 回调；
//   - 通过 game._t 暴露的 QA 钩子驱动行为（openRank / getScreen / rankCloseRect / getRankReturnScreen / setRankError）。
//
// 覆盖点（重点为「此前会失败的间歇性场景」）：
//   ① 轻点 ×（位移≈0）能关闭并回到来源界面；
//   ②【关键回归】手指在 × 上轻微滑动：按下命中 ×、抬起偏离 × ~35px（或反之）仍能关闭；
//   ③ 错误态（rankError 非 null）下点 × 关闭优先于「点任意处重试」；
//   ④ 错误态轻点空白（非 ×）触发重试 loadRank（保持 rank 界面）；
//   ⑤ rankReturnScreen 动态记录来源（从 room 打开应回到 room，而非硬编码 play）。

let touchStart, touchEnd;
let requestCount = 0;
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
  onTouchMove: () => {},
  enableBackPressed: () => {},
  onBackPressed: () => {},
  // submitScore / loadRank 都走 tt.request；同步回调 success，便于断言请求次数。
  request: (opt) => {
    requestCount++;
    if (opt && opt.success) {
      opt.success({ data: { top: [], selfRank: 1, selfName: '我', selfScore: 0 } });
    }
  },
};
global.requestAnimationFrame = () => 0; // 阻止 loop 真实绘制

const cfg = require('../config.js');
cfg.RANK_ENDPOINT = 'http://localhost:3000/api';
cfg.RANK_SECRET = ''; // 签名留空，mock 忽略 sig

const game = require('../game.js');
const T = game._t;

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// 用真实生产坐标驱动 touch：排行榜关闭 × 矩形中心
const cr = T.rankCloseRect();
const CX = cr.x + cr.w / 2;
const CY = cr.y + cr.h / 2;

// 模拟一次完整点按：press=按下点，release=抬起点
function tap(px, py, rx, ry) {
  touchStart({ touches: [{ clientX: px, clientY: py }] });
  touchEnd({ changedTouches: [{ clientX: rx, clientY: ry }] });
}
// 从 play 打开排行榜，并断言来源界面被记录
function openFromPlay() {
  if (T.getScreen() === 'rank') tap(CX, CY, CX, CY); // 先关回 play
  if (T.getScreen() === 'room') T.roomExit();
  ok(T.getScreen() === 'play', '前置：应在 play 界面');
  T.openRank();
  ok(T.getScreen() === 'rank', 'openRank 后应进入 rank 界面');
  ok(T.getRankReturnScreen() === 'play', 'openRank 应记录来源界面为 play');
}

(async () => {
  // ---- 进入 play 前置态 ----
  ok(T.getScreen() === 'guide', '初始应在 guide 界面');
  // 开始按钮矩形（见 game.js guide 分支）：{ x: W/2-80, y: H/2+60, w: 160, h: 48 }
  tap(187, 417, 187, 417);
  ok(T.getScreen() === 'play', '点击开始游戏后应在 play 界面');

  // ===== ① 轻点 ×（位移≈0）能关闭并回到来源界面 =====
  {
    openFromPlay();
    tap(CX, CY, CX, CY);
    ok(T.getScreen() === 'play', '回归①：轻点 ×（位移≈0）应关闭并回到 play');
  }

  // ===== ②【关键回归】手指在 × 上轻微滑动仍可关闭 =====
  // 2a. 按下命中 ×、抬起偏离 ~35px（原 >12px 即被轻点阈值吞掉的失败场景）
  {
    openFromPlay();
    // 抬起点在 × 外（× 半宽 19px），位移约 35px，方向任意
    tap(CX, CY, CX + 25, CY + 25);
    ok(T.getScreen() === 'play', '回归②a(关键)：按下命中 ×、抬起偏移~35px 仍可关闭（不再被轻点阈值吞掉）');
  }
  // 2b. 反向：按下偏离 ×、抬起命中 × 仍可关闭
  {
    openFromPlay();
    tap(CX + 25, CY + 25, CX, CY);
    ok(T.getScreen() === 'play', '回归②b：按下偏移 ×、抬起命中 × 仍可关闭');
  }
  // 2c. 更大位移（~40px）仍应关闭——确认未被阈值门控
  {
    openFromPlay();
    tap(CX, CY, CX + 28, CY + 28);
    ok(T.getScreen() === 'play', '回归②c：按下命中 ×、抬起偏移~40px 仍可关闭');
  }

  // ===== ③ 错误态下点 × 关闭优先于「点任意处重试」 =====
  {
    openFromPlay();
    T.setRankError('榜单请求失败，请检查网络或后端地址');
    ok(T.getRankState().error != null, '错误态前置：rankError 应为非 null');
    const before = requestCount;
    tap(CX, CY, CX, CY); // 点 ×
    ok(T.getScreen() === 'play', '回归③：错误态下点 × 关闭优先（已返回 play）');
    ok(requestCount === before, '回归③：关闭路径不应触发重试 loadRank（request 未增加）');
  }

  // ===== ④ 错误态轻点空白（非 ×）触发重试 loadRank，且保持 rank 界面 =====
  {
    openFromPlay();
    T.setRankError('榜单请求失败，请检查网络或后端地址');
    const before = requestCount;
    // 点一个明确不在 × 内、且几乎无位移的位置（轻点空白）
    tap(200, 400, 200, 400);
    ok(T.getScreen() === 'rank', '回归④：错误态轻点空白（非 ×）不应关闭，仍留在 rank');
    ok(requestCount > before, '回归④：错误态轻点空白应触发重试 loadRank（request 增加）');
    // 收尾：关闭回 play，避免影响后续用例
    tap(CX, CY, CX, CY);
    ok(T.getScreen() === 'play', '回归④后：关闭回 play');
  }

  // ===== ⑤ rankReturnScreen 动态记录来源（非硬编码 play） =====
  {
    // 从 play 进入 room，再从 room 打开排行榜
    const rm = T.roomEntryBtnRect();
    tap(rm.x + rm.w / 2, rm.y + rm.h / 2, rm.x + rm.w / 2, rm.y + rm.h / 2);
    ok(T.getScreen() === 'room', '回归⑤前置：点击房间按钮应进入 room 界面');
    T.openRank();
    ok(T.getScreen() === 'rank', '回归⑤：从 room 打开排行榜应进入 rank');
    ok(T.getRankReturnScreen() === 'room', '回归⑤：rankReturnScreen 应记录来源 room（非硬编码 play）');
    tap(CX, CY, CX, CY); // 点 ×
    ok(T.getScreen() === 'room', '回归⑤：从 room 打开后关闭应回到 room（证明使用 rankReturnScreen）');
    T.roomExit();
    ok(T.getScreen() === 'play', '回归⑤后：退出 room 回到 play');
  }

  console.log('rank-close-regression.test: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
