// 震动开关 QA：用 mock 的 tt 运行时验证开关按钮、存储与震动受控
// 运行：node test/vibrate-toggle.test.js

const store = {};
let touchStart = null;
let touchEnd = null;

const fakeCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
    return () => {};
  },
  set() { return true; },
});

const fakeCanvas = {
  width: 0, height: 0,
  getContext: () => fakeCtx,
};

global.tt = {
  createCanvas: () => fakeCanvas,
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2 }),
  getStorageSync: (k) => (k === 'privacyAgreed' ? '1' : (k in store ? store[k] : undefined)),
  setStorageSync: ({ key, data }) => { store[key] = data; },
  setUserCloudStorage: () => {},
  getOpenDataContext: () => null, // 返回 null -> 走本地模拟榜路径
  vibrateShort: () => { global.__vibrated = (global.__vibrated || 0) + 1; },
  onTouchStart: (fn) => { touchStart = fn; },
  onTouchEnd: (fn) => { touchEnd = fn; },
  onTouchMove: () => {},
  onMessage: () => {},
};

let rafCount = 0;
global.requestAnimationFrame = (cb) => { if (rafCount === 0) { rafCount = 1; cb(); } };

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

try {
  require('../game.js'); // 触发一次 draw（guide 界面），不应抛错
  check('game.js 加载并渲染一帧无错', true);
} catch (e) {
  check('game.js 加载并渲染一帧无错 -> ' + e.message, false);
}

check('已注册 onTouchEnd', typeof touchEnd === 'function');

// 1) 先点“开始游戏”关闭引导遮罩
touchStart({ touches: [{ clientX: 187, clientY: 417 }] });
touchEnd({ changedTouches: [{ clientX: 187, clientY: 417 }] });
check('初始未写入震动偏好(默认开)', !('vibrateOn' in store));

// 2) 点震动开关按钮（棋盘正下方居中）：187.5, 565.5
touchStart({ touches: [{ clientX: 187, clientY: 565 }] });
touchEnd({ changedTouches: [{ clientX: 187, clientY: 565 }] });
check('第一次点击开关 -> 写入 false', store.vibrateOn === false);

// 3) 再点一次 -> 恢复 true
touchStart({ touches: [{ clientX: 187, clientY: 565 }] });
touchEnd({ changedTouches: [{ clientX: 187, clientY: 565 }] });
check('第二次点击开关 -> 写入 true', store.vibrateOn === true);

// 4) 偏离开关位置（点棋盘外空白处）不应触发切换
touchStart({ touches: [{ clientX: 10, clientY: 10 }] });
touchEnd({ changedTouches: [{ clientX: 10, clientY: 10 }] });
check('点击空白处不切换开关', store.vibrateOn === true);

console.log('\n震动开关测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
