// test/privacy-modal.test.js
// 验证隐私政策弹窗合规功能（抖音小游戏提审要求）：
//   ① 首次运行（未同意）初始化时 privacyModalOpen===true，且游戏被阻断；
//   ② 点「同意并继续」后 privacyModalOpen===false，且 tt.setStorageSync 写入 'privacyAgreed'='1'；
//   ③ 游戏内常驻入口（≤4 次点击）可再次打开弹窗（查看模式，不改存储标记），含「查看详情/返回」。
//
// 复用 game-rank.test.js 的 mock 思路：Proxy 伪造 ctx、伪造 global.tt 运行时，捕获 onTouchEnd 回调；
// 通过 game._t 暴露的 QA 钩子驱动行为（privacyAgreeRect / privacyEntryBtnRect / privacyDetailRect / privacyBackRect 等）。
let touchStart, touchEnd;
let backHandler = null;
const fakeCtx = new Proxy({}, {
  get: (t, p) => {
    if (p === 'createRadialGradient') return () => ({ addColorStop() {} });
    return () => {};
  },
  set: () => true,
});
const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };

// 记录存储写入，供断言 ② 使用（兼容 (key,data) 与 {key,data} 两种入参形态）
const store = {};
function setStorageSync(k, v) {
  if (typeof k === 'object' && k !== null) { store[k.key] = k.data; }
  else { store[k] = v; }
}
global.tt = {
  createCanvas: () => fakeCanvas,
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2 }),
  // 关键：未同意（privacyAgreed 为空）→ 弹窗应在首次运行打开
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync,
  vibrateShort: () => {},
  onTouchStart: (fn) => { touchStart = fn; },
  onTouchEnd: (fn) => { touchEnd = fn; },
  onTouchMove: () => {},
  enableBackPressed: () => {},
  onBackPressed: (cb) => { backHandler = cb; },
  request: () => {},
};
global.requestAnimationFrame = () => 0; // 阻止 loop 真实绘制

const game = require('../game.js');
const T = game._t;

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// ① 首次运行（未同意）初始化：弹窗打开、处于首次运行阻断态
ok(T.getPrivacyModalOpen() === true, '① 未同意时初始化 privacyModalOpen 应为 true');
ok(T.getPrivacyFirstRun() === true, '① 未同意时应处于首次运行阻断态（privacyFirstRun=true）');
ok(T.getPrivacyAgreed() === false, '① 本地未同意标记应为 false');

// ① 补充：首次运行弹窗下，点「开始游戏」应被阻断（不进入 play）
touchStart({ touches: [{ clientX: 187, clientY: 417 }] });
touchEnd({ changedTouches: [{ clientX: 187, clientY: 417 }] });
ok(T.getScreen() === 'guide', '① 首次弹窗下点开始游戏应被阻断，仍停留在 guide');

// ② 点「同意并继续」（主按钮中心）→ 弹窗关闭、写入存储、标记置位
const ar = T.privacyAgreeRect();
touchStart({ touches: [{ clientX: ar.x + ar.w / 2, clientY: ar.y + ar.h / 2 }] });
touchEnd({ changedTouches: [{ clientX: ar.x + ar.w / 2, clientY: ar.y + ar.h / 2 }] });
ok(T.getPrivacyModalOpen() === false, '② 点同意后 privacyModalOpen 应为 false');
ok(store['privacyAgreed'] === '1', '② setStorageSync 应写入 privacyAgreed=1（实际：' + JSON.stringify(store) + '）');
ok(T.getPrivacyAgreed() === true, '② 内存同意标记应置位为 true');
ok(T.getPrivacyFirstRun() === false, '② 同意后应解除首次运行阻断态');

// ② 补充：弹窗关闭后系统返回走系统默认（不影响既有行为）
ok(backHandler() === false, '② 弹窗关闭后系统返回应返回 false（交由系统默认）');

// ③ 游戏内常驻入口：先进入 play（点开始游戏），再点「隐私政策」按钮重新打开弹窗
touchStart({ touches: [{ clientX: 187, clientY: 417 }] });
touchEnd({ changedTouches: [{ clientX: 187, clientY: 417 }] });
ok(T.getScreen() === 'play', '③ 同意后可点击开始游戏进入 play 界面');

const pe = T.privacyEntryBtnRect();
touchStart({ touches: [{ clientX: pe.x + pe.w / 2, clientY: pe.y + pe.h / 2 }] });
touchEnd({ changedTouches: [{ clientX: pe.x + pe.w / 2, clientY: pe.y + pe.h / 2 }] });
ok(T.getPrivacyModalOpen() === true, '③ 游戏内入口点击后应再次打开隐私弹窗');
ok(T.getPrivacyFirstRun() === false, '③ 再次打开应为查看模式（privacyFirstRun=false），不改存储标记');

// ③ 补充：查看模式下点「我已阅读」关闭弹窗，不应改写存储标记
const ar2 = T.privacyAgreeRect();
touchStart({ touches: [{ clientX: ar2.x + ar2.w / 2, clientY: ar2.y + ar2.h / 2 }] });
touchEnd({ changedTouches: [{ clientX: ar2.x + ar2.w / 2, clientY: ar2.y + ar2.h / 2 }] });
ok(T.getPrivacyModalOpen() === false, '③ 查看模式点「我已阅读」应关闭弹窗');
ok(store['privacyAgreed'] === '1', '③ 查看模式关闭不应改写存储标记（仍为 1）');

// ③ 补充：查看详情子页 + 返回
touchStart({ touches: [{ clientX: pe.x + pe.w / 2, clientY: pe.y + pe.h / 2 }] });
touchEnd({ changedTouches: [{ clientX: pe.x + pe.w / 2, clientY: pe.y + pe.h / 2 }] });
ok(T.getPrivacyModalOpen() === true, '③ 再次打开弹窗（详情测试前置）');
const dr = T.privacyDetailRect();
touchStart({ touches: [{ clientX: dr.x + dr.w / 2, clientY: dr.y + dr.h / 2 }] });
touchEnd({ changedTouches: [{ clientX: dr.x + dr.w / 2, clientY: dr.y + dr.h / 2 }] });
ok(T.getPrivacyViewDetail() === true, '③ 点「查看详情」应进入详情子页');
const br = T.privacyBackRect();
touchStart({ touches: [{ clientX: br.x + br.w / 2, clientY: br.y + br.h / 2 }] });
touchEnd({ changedTouches: [{ clientX: br.x + br.w / 2, clientY: br.y + br.h / 2 }] });
ok(T.getPrivacyViewDetail() === false, '③ 点「返回」应从详情子页退回主弹窗');
// 详情子页下系统返回应拦截（true）并退回主弹窗，不退出游戏
ok(backHandler() === true, '③ 详情子页下系统返回应拦截（true）并退回主弹窗');

console.log('privacy-modal.test: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
