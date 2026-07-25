// test/logic.test.js
// 在 Node 下直接运行：node test/logic.test.js
const L = require('../src/logic.js');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('  ✗ ' + msg);
  }
}

// 初始化：rng()=0 时总是取第一个空格，便于断言
let s = L.initGame(() => 0.0);
ok(s.grid[0][0] === 2 && s.grid[0][1] === 2, 'init 应在前两格生成 2/2, got ' + JSON.stringify(s.grid[0]));
ok(s.score === 0 && s.over === false, 'init score=0, over=false');

// 向左合并
let g = L.createEmptyGrid();
g[0][0] = 2; g[0][1] = 2;
let r = L.move({ grid: g, score: 0, over: false }, 'left');
ok(r.moved === true, 'left 应判定为移动');
ok(r.state.grid[0][0] === 4, '两 2 合并为 4, got ' + r.state.grid[0][0]);
ok(r.state.score === 4, 'score 应为 4, got ' + r.state.score);

// 向右合并到最右
g = L.createEmptyGrid();
g[0][0] = 2; g[0][1] = 2;
r = L.move({ grid: g, score: 0, over: false }, 'right');
ok(r.state.grid[0][3] === 4, 'right 合并到最右=4, got ' + r.state.grid[0][3]);

// 向上合并
g = L.createEmptyGrid();
g[0][0] = 2; g[1][0] = 2;
r = L.move({ grid: g, score: 0, over: false }, 'up');
ok(r.state.grid[0][0] === 4, 'up 合并到顶=4, got ' + r.state.grid[0][0]);

// 向下合并
g = L.createEmptyGrid();
g[0][0] = 2; g[1][0] = 2;
r = L.move({ grid: g, score: 0, over: false }, 'down');
ok(r.state.grid[3][0] === 4, 'down 合并到底=4, got ' + r.state.grid[3][0]);

// 满盘无合并：moved=false
const full = [
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 4, 2],
];
r = L.move({ grid: full, score: 0, over: false }, 'left');
ok(r.moved === false, '满盘无合并应 moved=false');
ok(r.over === true, '满盘无相邻相等应 over=true（满格死局必须判负）');

// canMove 判定
ok(L.canMove(full) === false, '满盘无相邻相等 -> canMove=false');
ok(L.canMove(L.createEmptyGrid()) === true, '空盘 -> canMove=true');

// 合并后空格数正确（4x4=16，去掉 2 个原数 + 1 个合并产物 + 1 个新生成 = 12 占用 -> 4 空格？）
// 实际：原 2 格占用，合并成 1 格，再 spawn 1 格 => 占用 2 格 => 空格 14
g = L.createEmptyGrid();
g[0][0] = 2; g[0][1] = 2;
r = L.move({ grid: g, score: 0, over: false }, 'left');
ok(L.getEmptyCells(r.state.grid).length === 14, '合并+spawn 后应有 14 个空格, got ' + L.getEmptyCells(r.state.grid).length);

// maxTile
ok(L.maxTile([[2, 4], [8, 16]]) === 16, 'maxTile 应为 16');

console.log('\n逻辑测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
