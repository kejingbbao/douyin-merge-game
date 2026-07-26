// test/sidebar-revisit.test.js
// 验证抖音「侧边栏复访能力」（提审必接，未调用 tt.navigateToScene 会被拒审）最小完整闭环：
//   (a) checkScene.isExist=false 时主界面入口不显示（showEntry=false）；
//   (b) 点击入口且非侧边栏场景 → tt.navigateToScene 被调用、参数 scene='sidebar'；
//   (c) 从侧边栏启动(location='sidebar_card') → fromSidebar()===true，点击入口标记 claimedToday 并写入存储；
//   (d) 翻日：存储 key 日期变化 → claimedToday 复位。
//
// 沿用现有范式：顶部 mock global.tt（含 checkScene / navigateToScene），require('../game.js')，读 game._t.sidebar。

let touchStart, touchEnd;
let navigateArgs = null;        // 记录 tt.navigateToScene 的入参（供直接断言）
let checkSceneRes = { isExist: false }; // 可切换的 checkScene 返回（默认不支持，对应 (a)）

const fakeCtx = new Proxy({}, {
  get: (t, p) => {
    if (p === 'createRadialGradient') return () => ({ addColorStop() {} });
    return () => {};
  },
  set: () => true,
});
const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };

// 记录存储写入，供断言 (c) 使用（兼容 (key,data) 与 {key,data} 两种入参形态）
const store = {};
function setStorageSync(k, v) {
  if (typeof k === 'object' && k !== null) { store[k.key] = k.data; }
  else { store[k] = v; }
}
function getStorageSync(k) {
  if (k in store) return store[k];
  // 隐私政策默认已同意，避免弹窗干扰渲染
  if (k === 'privacyAgreed') return '1';
  return '';
}

global.tt = {
  createCanvas: () => fakeCanvas,
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2 }),
  getStorageSync,
  setStorageSync,
  vibrateShort: () => {},
  onTouchStart: (fn) => { touchStart = fn; },
  onTouchEnd: (fn) => { touchEnd = fn; },
  onTouchMove: () => {},
  enableBackPressed: () => {},
  onBackPressed: () => {},
  // 侧边栏能力检测：checkScene 同步回调（success），返回可切换的 checkSceneRes
  checkScene: (opt) => { if (opt && opt.success) opt.success(checkSceneRes); },
  // 跳转侧边栏：记录入参供断言
  navigateToScene: (opt) => { navigateArgs = opt; },
  request: () => {},
};
global.requestAnimationFrame = () => 0; // 阻止真实渲染循环

const game = require('../game.js');
const T = game._t;
const S = T.sidebar;

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// ===== (a) checkScene.isExist=false 时主界面入口不显示 =====
ok(S.getSupported() === false, '(a) checkScene.isExist=false → sidebarSupported 应为 false');
ok(S.showEntry() === false, '(a) 不支持侧边栏时主界面入口 showEntry 应为 false（不显示）');

// ===== (b) 点击入口且非侧边栏场景 → tt.navigateToScene 被调用、scene='sidebar' =====
S.setSupported(true);                       // 模拟宿主支持侧边栏
S.setLatestOpts({ scene: 'normal', location: 'home' }); // 非侧边栏场景
S.setClaimedToday(false);                  // 今日未领取（按钮应显示）
ok(S.fromSidebar() === false, '(b) 前置：非侧边栏场景 fromSidebar() 应为 false');
ok(S.showEntry() === true, '(b) 前置：支持且未领取时入口应显示');
const navBefore = S.getNavigateCalled();
S.clickEntry();                            // 模拟点击入口
ok(S.getNavigateCalled() === navBefore + 1, '(b) 点击入口应调用 tt.navigateToScene（计数 +1）');
ok(navigateArgs != null, '(b) tt.navigateToScene 应被实际调用（mock 已捕获入参）');
ok(S.getLastNavigateArgs() != null && S.getLastNavigateArgs().scene === 'sidebar',
   "(b) tt.navigateToScene 入参 scene 应为 'sidebar'");
ok(navigateArgs && navigateArgs.scene === 'sidebar', "(b) mock 捕获的 tt.navigateToScene 入参 scene 应为 'sidebar'");

// ===== (c) 从侧边栏启动(location='sidebar_card') → fromSidebar()===true，点击入口标记 claimed+写入存储 =====
S.setLatestOpts({ scene: '021036', launch_from: 'homepage', location: 'sidebar_card' });
ok(S.fromSidebar() === true, "(c) location='sidebar_card' → fromSidebar() 应为 true");
const navBeforeC = S.getNavigateCalled();
const today = S.todayStr();
S.clickEntry();                            // 模拟点击入口（复访领取）
ok(S.isClaimedToday() === true, '(c) 从侧边栏点击入口应标记 claimedToday=true');
ok(store['sidebar_reward_' + today] === today,
   '(c) 应写入存储 key=sidebar_reward_' + today + ' 且值等于今日日期（实际：' + JSON.stringify(store) + '）');
ok(S.getNavigateCalled() === navBeforeC, '(c) 从侧边栏领取路径不应触发 tt.navigateToScene（计数未增加）');

// ===== (d) 翻日：存储 key 日期变化 → claimedToday 复位 =====
// 先令存储中存有「今日」记录 → 重算应为 true
store['sidebar_reward_' + today] = today;
S.recomputeClaimed();
ok(S.isClaimedToday() === true, '(d) 前置：存储存今日日期 → recompute 后 claimedToday 应为 true');
// 翻日：存储中日期变为非今日（模拟跨天，旧 key 不再等于今天）→ 重算应复位为 false
store['sidebar_reward_' + today] = '1999-01-01';
S.recomputeClaimed();
ok(S.isClaimedToday() === false, '(d) 翻日后存储日期≠今日 → claimedToday 应复位为 false');

console.log('sidebar-revisit.test: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
