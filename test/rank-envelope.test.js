// test/rank-envelope.test.js
// 验证：API 信封解包 + drawRank 防御性降级（修复「打开排行榜白屏 + TypeError: Cannot read
// properties of undefined (reading 'length')」Bug）。
// 用 mock 的 tt 运行时让 game.js 走 isTT 分支，模拟两种响应形态与一个畸形形态。
let touchStart, touchEnd, touchMove;
let requests = [];      // 记录所有 tt.request 调用
let drawnTexts = [];    // 记录 draw() 中 ctx.fillText 画出的所有文本（用于断言降级文案）
let responseProvider = null; // 可切换的 tt.request success 响应构造器

const fakeCtx = new Proxy({}, {
  get: (t, p) => {
    if (p === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (p === 'fillText') return (txt) => { drawnTexts.push(txt); };
    return () => {};
  },
  set: () => true,
});
const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
global.tt = {
  createCanvas: () => fakeCanvas,
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2 }),
  getStorageSync: (k) => (k === 'privacyAgreed' ? '1' : ''), // 跳过隐私弹窗，避免干扰渲染
  setStorageSync: () => {},
  vibrateShort: () => {},
  onTouchStart: (fn) => { touchStart = fn; },
  onTouchEnd: (fn) => { touchEnd = fn; },
  onTouchMove: (fn) => { touchMove = fn; },
  enableBackPressed: () => {},
  onBackPressed: () => {},
  request: (opt) => {
    requests.push(opt);
    if (responseProvider && opt.success) responseProvider(opt);
    else if (opt.success) opt.success({ data: { top: [], selfRank: 0, selfName: '', selfScore: 0 } });
  },
};
// 抖音运行时 requestAnimationFrame 是全局函数，mock 需放到 global
global.requestAnimationFrame = () => 0;

// 让排行榜后端地址非空，否则 submitScore/loadRank 会直接 return（不触发云请求）
const cfg = require('../config.js');
cfg.RANK_ENDPOINT = 'http://localhost:3000/api';
cfg.RANK_SECRET = ''; // 本地联调用，不上传签名

const game = require('../game.js');
const T = game._t;

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// ---- 三种响应构造器 ----
// ① 标准信封（字符串）：res.data 是 JSON 字符串，需手动 parse 后取内层 data
function envelopeString(top) {
  return (opt) => {
    const body = { code: 0, data: { top: top || [], selfRank: 0, selfName: '', selfScore: 0 } };
    opt.success({ data: JSON.stringify(body) });
  };
}
// ② 已解包对象：抖音 tt.request 已自动解包 JSON 到 res.data（对象形态，non-envelope）
function unpackedObject(top) {
  return (opt) => {
    opt.success({ data: { top: top || [], selfRank: 0, selfName: '', selfScore: 0 } });
  };
}
// ③ 异常：响应内层 data 无 .top 字段（畸形结构，用于验证防御性降级）
function noTop() {
  return (opt) => {
    opt.success({ data: JSON.stringify({ code: 0, data: { foo: 'bar' } }) });
  };
}

// ① 信封字符串 → rankData.top 应为数组，且正确解包内层 data（核心修复点）
responseProvider = envelopeString([]);
T.openRank();
let st = T.getRankState();
ok(!!st.data, '信封字符串响应：rankData 应已赋值（非整个 API 信封）');
ok(Array.isArray(st.data.top), '信封字符串响应：rankData.top 应为数组（已正确解包内层 data）');
ok(st.data.top.length === 0, '信封字符串响应：空榜单 top 长度应为 0');

// ② 已解包对象 → 兼容：rankData.top 应为数组，且内容被保留
responseProvider = unpackedObject([{ rank: 1, name: 'Alice', score: 9999 }]);
T.openRank();
st = T.getRankState();
ok(Array.isArray(st.data.top) && st.data.top.length === 1, '已解包对象响应：rankData.top 应为长度 1 的数组（兼容非信封格式）');
ok(st.data.top[0].name === 'Alice', '已解包对象响应：榜单内容应被保留');
ok(st.data.selfRank === 0, '已解包对象响应：selfRank 字段可安全访问');

// ③ 异常（无 .top）→ drawRank 防御性降级「暂无数据」，绝不崩溃
responseProvider = noTop();
T.openRank();
st = T.getRankState();
ok(st.data && !Array.isArray(st.data.top), '异常响应：rankData.top 应仍为非数组（模拟畸形结构）');
drawnTexts = [];
let crashed = false;
try { T.draw(); } catch (e) { crashed = true; console.error('draw() 抛异常: ' + (e && e.message)); }
ok(!crashed, 'rankData 无 .top 时 draw() 不应崩溃（修复前的 TypeError）');
ok(drawnTexts.indexOf('暂无数据') >= 0, 'rankData 无 .top 时 drawRank 应优雅降级显示「暂无数据」');

console.log('rank-envelope.test: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
