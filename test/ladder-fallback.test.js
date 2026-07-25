// test/ladder-fallback.test.js
// 回归验证：满格（game over）后「无提示灰黑屏 / 崩溃」的三个原场景（改动 1/2/3）。
//
// 直接对 src/ladder.js 的 drawLadderCard 做单元级验证：
//   - 用 Proxy 伪造 ctx（忽略所有绘制调用），但记录 fillText 的文本内容，
//     以便断言「兜底文案确实被渲染出来」，而非旧代码那样裸 return 留黑屏。
//   - 复刻 game.js 默认布局 L = { W:375, H:667, PAD:12 }（drawLadderCard 仅用到 W/H/PAD）。
//
// 覆盖场景：
//   a) null match        —— 原黑屏场景（旧 `if (!match) return;` 裸返回 → 灰黑无提示）
//   b) 缺 opponent 的 match —— 原更隐蔽的 TypeError 崩溃场景（match.opponent.name 抛错 → render loop 冻结）
//   c) 空对象 match {}     —— 结构异常的另一变体
//   d) 有效 match         —— 回归：正常「你 VS 对手」渲染路径未被破坏

const Ladder = require('../src/ladder.js');

// 复刻 game.js 默认布局（见 game.js line 13/14/33/40）
const L = { W: 375, H: 667, PAD: 12 };

// 伪造 ctx：忽略一切绘制调用，但记录 fillText 文本内容，用于断言兜底文案确实被渲染。
function makeCtx() {
  const rec = { texts: [] };
  const ctx = new Proxy({}, {
    get: (t, p) => {
      if (p === 'fillText') return (s) => { rec.texts.push(String(s)); };
      if (p === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set: () => true,
  });
  return { ctx, rec };
}

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('PASS: ' + msg); }
  else { fail++; console.error('FAIL: ' + msg); }
}

// ---- 场景 a：空 match（null）兜底渲染不抛错，且确实渲染了结束提示文案（非裸 return 黑屏）----
(function () {
  const { ctx, rec } = makeCtx();
  let threw = false;
  try {
    Ladder.drawLadderCard(ctx, L, null, { loading: false, error: null, selfRank: 3, score: 120 });
  } catch (e) { threw = true; console.error(e && e.stack ? e.stack : e); }
  check(!threw, '场景a: null match 调用 drawLadderCard 不抛异常');
  check(rec.texts.includes('游戏结束'), '场景a: 兜底渲染了「游戏结束」标题（非黑屏裸 return）');
  check(rec.texts.includes('点击任意处再来一局'), '场景a: 兜底渲染了「点击任意处再来一局」重开入口');
  check(rec.texts.includes('本局得分：120'), '场景a: 兜底渲染了本局得分（来自 opts.score 透传）');
  check(rec.texts.includes('你的排名：第 3 位'), '场景a: 兜底渲染了个人排名（来自 opts.selfRank）');
})();

// ---- 场景 b：缺 opponent 的异常 match 不抛 TypeError、不崩溃渲染，走兜底 ----
(function () {
  const { ctx, rec } = makeCtx();
  let threw = false;
  try {
    // 旧代码会在此访问 match.opponent.name → 抛 TypeError，使 draw() 抛错、requestAnimationFrame 不再调度 → 灰黑冻结
    Ladder.drawLadderCard(ctx, L, { myScore: 100, result: 'win', diff: 5 },
      { loading: false, error: null, selfRank: 3, score: 100 });
  } catch (e) { threw = true; console.error(e && e.stack ? e.stack : e); }
  check(!threw, '场景b: 缺 opponent 的 match 调用不抛异常（旧代码会抛 TypeError 崩溃）');
  check(rec.texts.includes('游戏结束'), '场景b: 缺 opponent 仍走兜底渲染结束提示（未裸 return）');
})();

// ---- 场景 c：空对象 match（{}）不抛错，走兜底 ----
(function () {
  const { ctx, rec } = makeCtx();
  let threw = false;
  try {
    Ladder.drawLadderCard(ctx, L, {}, { loading: false, error: null, selfRank: 3, score: 0 });
  } catch (e) { threw = true; console.error(e && e.stack ? e.stack : e); }
  check(!threw, '场景c: 空对象 match 调用不抛异常');
  check(rec.texts.includes('游戏结束'), '场景c: 空对象 match 走兜底渲染结束提示（未裸 return）');
})();

// ---- 场景 d：有效 match 仍正常渲染「你 VS 对手」路径（回归：正常路径未被破坏）----
(function () {
  const { ctx, rec } = makeCtx();
  let threw = false;
  try {
    Ladder.drawLadderCard(ctx, L,
      { myScore: 100, opponent: { name: 'A', score: 90 }, result: 'win', diff: 10, synthetic: false },
      { loading: false, error: null, selfRank: 2, score: 100 });
  } catch (e) { threw = true; console.error(e && e.stack ? e.stack : e); }
  check(!threw, '场景d: 有效 match 调用不抛异常');
  check(rec.texts.includes('你 VS 对手'), '场景d: 有效 match 走正常「你 VS 对手」渲染路径（回归）');
  check(rec.texts.includes('再来一局'), '场景d: 有效 match 渲染了「再来一局」按钮');
})();

console.log('ladder-fallback.test: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
