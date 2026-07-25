// test/gameover-fullboard.test.js
// 针对「满格(棋盘填满)不提示游戏结束」修复的独立回归断言（不轻信实现者自报，直接验证行为）。
//
// 修复核心（src/logic.js move()）：
//   分支 A (moved=false)  -> 返回 { moved:false, over: !canMove(state.grid) }  // 满盘 checkerboard 也能判负
//   分支 B (moved && !canMove(newGrid)) -> 直接判负且不 spawn（防御性分支，见下方说明）
//   分支 C (moved && canMove(newGrid))  -> spawn 后重算 over = !canMove(state.grid)  // 捕获"生成新棋子后恰好满格死局"
// 以及 game.js 单人模式在 res.moved 分支之后新增 `else if (res.over) { state.over=true; triggerGameOver(); }`。
//
// 本文件覆盖三个关键场景：
//   Y：满格 checkerboard，moved=false 但 over=true            -> 分支 A（旧代码此情况 over 为 undefined/false，漏判）
//   X：满格棋盘一次移动后陷入满格死局                          -> 实际走分支 C（合并腾出空格 -> spawn -> 重判死局）
//   Z：仅剩一个空格，滑动(不合并)后 spawn 恰好填满成死局        -> 分支 C（"生成新棋子后满格死局"的典型路径）
//
// 重要 QA 结论：分支 B（moved 后 newGrid 即满格且无相邻相等、不经过 spawn）在数学上不可达
//   —— 一次"改变了棋盘"的移动要么发生合并(腾出空格)、要么只是滑动(原空格仍在)，
//   二者都使 newGrid 留有空格 -> canMove(newGrid)===true -> 走分支 C 而非分支 B。
//   下方 randomized probe 以 2 万次随机满盘采样佐证：从未观察到"moved && over && 未 spawn"的情况。
//   因此分支 B 是防御性死代码；本次修复的"满格死局判负"可观测行为由 分支 A + 分支 C 实际承载，均经验证。

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

// 确定性 rng：始终取第一个空格、且生成的棋子为 2（rng()<0.9）
function rng0() { return 0.0; }

// 辅助：棋盘是否"满格且无相邻相等"（即 canMove 应为 false）
function isFullDeadlock(grid) {
  const empty = L.getEmptyCells(grid).length;
  if (empty !== 0) return false;
  for (let r = 0; r < L.SIZE; r++) {
    for (let c = 0; c < L.SIZE; c++) {
      const v = grid[r][c];
      if (c + 1 < L.SIZE && grid[r][c + 1] === v) return false;
      if (r + 1 < L.SIZE && grid[r + 1][c] === v) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 场景 Y（分支 A）：满格 checkerboard，moved=false 但 over=true
// 根因验证：旧代码在 moved=false 时未返回 over，导致满盘死局被当成"无效滑动"而不判负。
// ---------------------------------------------------------------------------
(function scenarioY_branchA() {
  const grid = [
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ];
  const r = L.move({ grid, score: 0, over: false }, 'left');
  ok(r.moved === false, 'Y: 满格 checkerboard 左移应 moved=false，实际 ' + r.moved);
  ok(r.over === true, 'Y: 满格无相邻相等应 over=true（修复核心：旧代码此情况 over 为 undefined/false 导致不判负），实际 ' + r.over);
  ok(L.canMove(grid) === false, 'Y: 满格无相邻相等 -> canMove(grid) 应为 false');
})();

// ---------------------------------------------------------------------------
// 场景 X（满格棋盘一次移动后陷入满格死局）：实际走分支 C
// 构造：满盘且只有 row0 含一对可合并 [2,2]，其余行列无相邻相等；move('left') 合并腾出 (0,3) 空格，
//       -> canMove(newGrid)===true -> 分支 C -> spawnTile(rng0) 在 (0,3) 填 2 -> 整盘仍满格无相邻相等 -> over=true。
// 根因验证：证明"移动后满格死局"现在能被正确判负（旧代码分支 C 不会重判，over 永远为 undefined/false）。
// 说明：工程师将其标注为"分支 B"，但本构造经 spawn 后判负，实际命中分支 C（分支 B 不可达，见文末 probe）。
// ---------------------------------------------------------------------------
(function scenarioX_fullBoardMoveDeadlock() {
  const grid = [
    [2, 2, 8, 16],
    [32, 64, 128, 256],
    [64, 32, 256, 128],
    [128, 256, 64, 32],
  ];
  const r = L.move({ grid, score: 0, over: false }, 'left', rng0);
  ok(r.moved === true, 'X: 满盘含可合并对，左移应 moved=true，实际 ' + r.moved);
  ok(r.state && r.state.over === true, 'X: 移动后陷入满格死局应 over=true，实际 ' + (r.state && r.state.over));
  ok(r.state && L.getEmptyCells(r.state.grid).length === 0, 'X: 移动+生成后棋盘应满格(16 占用)，实际空格=' + (r.state && L.getEmptyCells(r.state.grid).length));
  ok(r.state && isFullDeadlock(r.state.grid), 'X: 结果棋盘应满格且无相邻相等（死局），实际 ' + JSON.stringify(r.state && r.state.grid));
})();

// ---------------------------------------------------------------------------
// 场景 Z（分支 C 典型路径）：仅剩一个空格，滑动(不合并)后 spawn 恰好填满成死局
// 构造：row3=[128,256,0,32]，其余为满格无相邻相等棋盘；move('left') 仅将空格从第 2 列滑到第 3 列，
//       -> newGrid 仍留 1 空格 -> 分支 C -> spawnTile(rng0) 在 (3,3) 填 2 -> 整盘满格且无相邻相等 -> over=true。
// 根因验证：证明"生成新棋子后恰好满格死局"现在能被捕获（旧代码分支 C 用错误的 over 值）。
// ---------------------------------------------------------------------------
(function scenarioZ_spawnFillsToDeadlock() {
  const grid = [
    [4, 8, 16, 2],
    [32, 64, 128, 256],
    [64, 32, 256, 128],
    [128, 256, 0, 32],
  ];
  const r = L.move({ grid, score: 0, over: false }, 'left', rng0);
  ok(r.moved === true, 'Z: 滑动(不合并)应 moved=true，实际 ' + r.moved);
  ok(r.state && r.state.over === true, 'Z: 生成新棋子后恰好满格死局应 over=true，实际 ' + (r.state && r.state.over));
  ok(r.state && L.getEmptyCells(r.state.grid).length === 0, 'Z: 生成后棋盘应满格(16 占用)，实际空格=' + (r.state && L.getEmptyCells(r.state.grid).length));
  ok(r.state && isFullDeadlock(r.state.grid), 'Z: 结果棋盘应满格且无相邻相等（死局），实际 ' + JSON.stringify(r.state && r.state.grid));
})();

// ---------------------------------------------------------------------------
// 反例（ sanity ）：普通有效滑动应 over=false，避免"误判负"
// ---------------------------------------------------------------------------
(function control_normalMove_notOver() {
  const grid = L.createEmptyGrid();
  grid[0][0] = 2; grid[0][1] = 2;
  const r = L.move({ grid, score: 0, over: false }, 'left');
  ok(r.moved === true && (r.state && r.state.over === false), '控制: 普通合并滑动不应判负(over=false)');
})();

// ---------------------------------------------------------------------------
// 佐证：分支 B（moved && !canMove(newGrid) 且未 spawn）不可达。
// 以 2 万次随机满盘采样，对 4 个方向各跑一次 move；若观察到 moved=true & over=true 且结果棋盘非满(=1 空格，说明未 spawn)，
// 即为分支 B 命中。预期计数恒为 0。
// ---------------------------------------------------------------------------
(function probe_branchB_unreachable() {
  let branchB = 0;
  for (let t = 0; t < 20000; t++) {
    const vals = [2, 4, 8, 16];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const row = [];
      for (let j = 0; j < 4; j++) row.push(vals[Math.floor(Math.random() * vals.length)]);
      b.push(row);
    }
    for (const dir of ['left', 'right', 'up', 'down']) {
      const r = L.move({ grid: b.map((x) => x.slice()), score: 0, over: false }, dir, rng0);
      if (r.moved && r.state && r.state.over === true && L.getEmptyCells(r.state.grid).length === 1) {
        branchB++; // 1 空格 = 合并腾出后未 spawn -> 分支 B
      }
    }
  }
  ok(branchB === 0, '分支 B(未 spawn 即满格死局) 在 2 万次随机满盘采样中应为 0 命中，实际=' + branchB + '（佐证其为不可达的防御性死代码）');
})();

console.log('\n满格死局回归测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
