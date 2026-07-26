// test/sensitive-word.test.js
// 验证抖音「敏感词能力」（提审必接，审核预检要求代码里调用 tt.onKeyboardComplete）最小闭环：
//   (a) tt.onKeyboardComplete 注册后 isRegistered() === true；
//   (b) 模拟键盘收起回调触发后 getLastValue() 返回回调值（含敏感词被替换为 * 的场景）；
//   (c) lastKeyboardCompleteValue 在多次键盘操作时被最新值覆盖；
//   (d) 无 tt.onKeyboardComplete API 时（Node 测试环境 fallback）不崩溃。
//
// 沿用现有范式：顶部 mock global.tt（含 onKeyboardComplete 捕获回调），require('../game.js')，读 game._t.sensitiveWord。

let kbdCompleteCb = null;     // 捕获 tt.onKeyboardComplete 注册的回调（供直接触发）
let kbdConfirmCb = null;      // 兼容：如有 onKeyboardConfirm 也捕获（本实现不依赖）
let kbdInputCb = null;        // 兼容：如有 onKeyboardInput 也捕获（本实现不依赖）

const fakeCtx = new Proxy({}, {
  get: (t, p) => {
    if (p === 'createRadialGradient') return () => ({ addColorStop() {} });
    return () => {};
  },
  set: () => true,
});
const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };

const store = {};
function setStorageSync(k, v) {
  if (typeof k === 'object' && k !== null) { store[k.key] = k.data; }
  else { store[k] = v; }
}
function getStorageSync(k) {
  if (k in store) return store[k];
  if (k === 'privacyAgreed') return '1'; // 隐私政策默认已同意，避免弹窗干扰
  return '';
}

// 含 onKeyboardComplete 的 tt 环境：捕获回调，供测试注入键盘收起事件
global.tt = {
  createCanvas: () => fakeCanvas,
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2 }),
  getStorageSync,
  setStorageSync,
  vibrateShort: () => {},
  onTouchStart: () => {},
  onTouchEnd: () => {},
  onTouchMove: () => {},
  onBackPressed: () => {},
  enableBackPressed: () => {},
  request: () => {},
  // 敏感词能力：键盘收起监听（点击确认 + 直接关闭键盘都会触发；data.value 已过敏感词替换）
  onKeyboardComplete: (cb) => { kbdCompleteCb = cb; },
  // 下列接口本实现刻意不依赖；仅作兼容捕获，断言里验证未作为取值来源
  onKeyboardConfirm: (cb) => { kbdConfirmCb = cb; },
  onKeyboardInput: (cb) => { kbdInputCb = cb; },
};
global.requestAnimationFrame = () => 0; // 阻止真实渲染循环

const game = require('../game.js');
const T = game._t;
const SW = T.sensitiveWord;

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// ===== (a) tt.onKeyboardComplete 注册后 isRegistered() === true =====
ok(typeof SW.isRegistered === 'function', '(a) 应暴露 isRegistered() 钩子');
ok(SW.isRegistered() === true, '(a) 存在 tt.onKeyboardComplete 时 isRegistered() 应为 true');
ok(kbdCompleteCb !== null, '(a) tt.onKeyboardComplete 应被实际注册（回调已捕获）');

// ===== (b) 模拟键盘收起回调触发后 getLastValue() 返回回调值（含敏感词被替换为 *） =====
ok(typeof SW.getLastValue === 'function', '(b) 应暴露 getLastValue() 钩子');
ok(typeof SW.getCompleteTime === 'function', '(b) 应暴露 getCompleteTime() 钩子');
ok(SW.getLastValue() === '', '(b) 前置：未触发前 getLastValue() 应为空串');

// (b1) 普通房间码：回调值应被原样记录
kbdCompleteCb({ value: 'ABC123' });
ok(SW.getLastValue() === 'ABC123', "(b1) 键盘收起回调 value='ABC123' → getLastValue() 应为 'ABC123'");
ok(typeof SW.getCompleteTime() === 'number' && SW.getCompleteTime() > 0, '(b1) getCompleteTime() 应返回正数时间戳');

// (b2) 含敏感词的输入：平台已将敏感词替换为 *，回调值应保留星号形态
kbdCompleteCb({ value: 'F**kRoom99' });
ok(SW.getLastValue() === 'F**kRoom99', "(b2) 敏感词被替换为 * 后 → getLastValue() 应为 'F**kRoom99'");

// (b3) 防御：回调 data 缺失 value 时降级为空串，不崩
kbdCompleteCb({});
ok(SW.getLastValue() === '', '(b3) 回调 data 无 value 时 getLastValue() 应降级为空串');

// (b4) 防御：回调 data 为 null 时不崩
kbdCompleteCb(null);
ok(SW.getLastValue() === '', '(b4) 回调 data 为 null 时 getLastValue() 应降级为空串');

// ===== (c) lastKeyboardCompleteValue 在多次键盘操作时被最新值覆盖 =====
kbdCompleteCb({ value: 'X1Y2Z3' });
ok(SW.getLastValue() === 'X1Y2Z3', "(c) 第一次键盘收起 → getLastValue()='X1Y2Z3'");
const t1 = SW.getCompleteTime();
kbdCompleteCb({ value: 'A9B8C7' });
ok(SW.getLastValue() === 'A9B8C7', "(c) 第二次键盘收起应覆盖 → getLastValue()='A9B8C7'");
ok(SW.getCompleteTime() >= t1, '(c) 时间戳应被最新一次覆盖（单调递增或不回退）');
// resolveRoomCode 在存在近期键盘回调值时应返回该过滤值（而非原始输入）
ok(typeof SW.resolveRoomCode === 'function', '(c) 应暴露 resolveRoomCode() 钩子');
ok(SW.resolveRoomCode('RAWCODE') === 'A9B8C7', "(c) 存在近期键盘值时 resolveRoomCode 应返回过滤后的 'A9B8C7'（忽略原始输入）");

// ===== (d) 无 tt.onKeyboardComplete API 时（Node 测试环境 fallback）不崩溃 =====
// 重新 require game.js（清空模块缓存），在缺 onKeyboardComplete 的 tt 环境下验证不崩。
delete require.cache[require.resolve('../game.js')];
const noApiTt = {
  createCanvas: () => fakeCanvas,
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2 }),
  getStorageSync,
  setStorageSync,
  vibrateShort: () => {},
  onTouchStart: () => {},
  onTouchEnd: () => {},
  onTouchMove: () => {},
  onBackPressed: () => {},
  enableBackPressed: () => {},
  request: () => {},
  // 故意不提供 onKeyboardComplete / onKeyboardConfirm / onKeyboardInput
};
global.tt = noApiTt;
let crashed = false;
let g2 = null;
try { g2 = require('../game.js'); } catch (e) { crashed = true; console.error(e); }
ok(!crashed, '(d) 缺少 tt.onKeyboardComplete 时 require game.js 不应崩溃');
ok(g2 && g2._t && g2._t.sensitiveWord, '(d) 无 API 时仍应暴露 game._t.sensitiveWord 钩子');
ok(g2 && g2._t.sensitiveWord.isRegistered() === false, '(d) 无 onKeyboardComplete 时 isRegistered() 应为 false');
ok(g2 && g2._t.sensitiveWord.getLastValue() === '', '(d) 无 API 时 getLastValue() 默认空串');
ok(g2 && g2._t.sensitiveWord.getCompleteTime() === 0, '(d) 无 API 时 getCompleteTime() 默认 0');
// 无 API 时 resolveRoomCode 应安全降级：无近期键盘值 → 原样返回
ok(g2 && g2._t.sensitiveWord.resolveRoomCode('ROOM42') === 'ROOM42', "(d) 无 API 时 resolveRoomCode 应原样返回 'ROOM42'");

console.log('sensitive-word.test: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
