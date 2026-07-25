// src/logic.js
// 合成能量（2048 式）核心逻辑 —— 纯函数，无任何平台依赖，可在 Node 中直接单测。
// 抖音小游戏与 Node 均支持 CommonJS（require / module.exports）。

const SIZE = 4;

function createEmptyGrid() {
  const grid = [];
  for (let r = 0; r < SIZE; r++) grid.push(new Array(SIZE).fill(0));
  return grid;
}

function cloneGrid(grid) {
  return grid.map((row) => row.slice());
}

function getEmptyCells(grid) {
  const cells = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (grid[r][c] === 0) cells.push([r, c]);
  return cells;
}

// 在随机空格生成新棋子：rng() 返回 [0,1)，rng() < 0.9 出 2，否则出 4
function spawnTile(grid, rng) {
  rng = rng || Math.random;
  const cells = getEmptyCells(grid);
  if (cells.length === 0) return false;
  const [r, c] = cells[Math.floor(rng() * cells.length)];
  grid[r][c] = rng() < 0.9 ? 2 : 4;
  return true;
}

function initGame(rng) {
  const grid = createEmptyGrid();
  spawnTile(grid, rng);
  spawnTile(grid, rng);
  return { grid, score: 0, over: false };
}

// 将一行向左压缩并合并：返回 { row, gained }
function compress(row) {
  const filtered = row.filter((v) => v !== 0);
  const result = [];
  const mergedAt = [];
  let gained = 0;
  for (let i = 0; i < filtered.length; i++) {
    if (i + 1 < filtered.length && filtered[i] === filtered[i + 1]) {
      const merged = filtered[i] * 2;
      result.push(merged);
      mergedAt.push(result.length - 1);
      gained += merged;
      i++; // 跳过被合并的下一个
    } else {
      result.push(filtered[i]);
    }
  }
  while (result.length < SIZE) result.push(0);
  return { row: result, gained, mergedAt };
}

// 顺时针旋转 grid times 次（90°/次），使任意方向统一成「向左」处理
function rotate(grid, times) {
  let g = cloneGrid(grid);
  const t = ((times % 4) + 4) % 4;
  for (let k = 0; k < t; k++) {
    const ng = createEmptyGrid();
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) ng[c][SIZE - 1 - r] = g[r][c];
    g = ng;
  }
  return g;
}

// 将坐标 (r,c) 顺时针旋转 t 次，映射回原坐标系（用于把「向左压缩」后的合并位置还原到真实棋盘坐标）
function mapCoord(r, c, t) {
  let nr = r, nc = c;
  const k = ((t % 4) + 4) % 4;
  for (let i = 0; i < k; i++) {
    const tr = nc;
    const tc = SIZE - 1 - nr;
    nr = tr; nc = tc;
  }
  return [nr, nc];
}

// direction: 'left' | 'right' | 'up' | 'down'
const ROT_MAP = { left: 0, up: 3, right: 2, down: 1 };

function move(state, direction, rng) {
  rng = rng || Math.random;
  if (state.over) return { moved: false };
  const times = ROT_MAP[direction] || 0;
  const rotated = rotate(state.grid, times);

  let gainedTotal = 0;
  let moved = false;
  const newRows = [];
  const mergedRot = [];
  for (let r = 0; r < SIZE; r++) {
    const { row, gained, mergedAt } = compress(rotated[r]);
    gainedTotal += gained;
    for (const col of mergedAt) mergedRot.push([r, col]);
    if (row.some((v, i) => v !== rotated[r][i])) moved = true;
    newRows.push(row);
  }

  if (!moved) return { moved: false };

  const t = (4 - times) % 4;
  const newGrid = rotate(newRows, t);
  const merged = mergedRot.map(([r, c]) => mapCoord(r, c, t));
  const score = state.score + gainedTotal;
  const over = !canMove(newGrid);
  const newState = { grid: newGrid, score, over };
  if (!over) spawnTile(newState.grid, rng);
  return { moved: true, state: newState, gained: gainedTotal, merged };
}

// 是否还能移动：有空格 或 存在相邻相等
function canMove(grid) {
  if (getEmptyCells(grid).length > 0) return true;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = grid[r][c];
      if (c + 1 < SIZE && grid[r][c + 1] === v) return true;
      if (r + 1 < SIZE && grid[r + 1][c] === v) return true;
    }
  }
  return false;
}

function maxTile(grid) {
  let m = 0;
  for (const row of grid) for (const v of row) if (v > m) m = v;
  return m;
}

// ---------- Phase 2：种子随机数（design-lock §5.1，零依赖，纯 JS） ----------
// 同 seed → 同一 PRNG 序列：双方用同一服务端 seed 开局，棋盘起点一致、RNG 零优势。
// 客户端每次 Logic.move 必须传入「同一个 rng 实例」（见 src/room.js）。

// xmur3：将任意字符串哈希为 32 位种子初值（确定性）
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32：32 位种子 → [0,1) 均匀分布伪随机序列（确定性）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// makeRng：将种子字符串转为可注入 Logic 的 rng 函数
function makeRng(seedStr) {
  const seedFn = xmur3(String(seedStr));
  return mulberry32(seedFn());
}

module.exports = {
  SIZE,
  createEmptyGrid,
  cloneGrid,
  getEmptyCells,
  spawnTile,
  initGame,
  compress,
  rotate,
  move,
  canMove,
  maxTile,
  makeRng,
};
