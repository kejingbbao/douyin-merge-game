// game.js —— 抖音小游戏入口（合成能量 / Merge Energy）
// 纯 Canvas 渲染，无外部素材，规避版权风险；广告位以占位形式接入，需填入真实 adUnitId。

const Logic = require('./src/logic.js');
const config = require('./config.js');
const HMAC = require('./src/hmac.js'); // 纯 JS HMAC-SHA256（抖音运行时无 Node crypto）

const isTT = typeof tt !== 'undefined' && !!tt.createCanvas;
let canvas = null;
let ctx = null;

let W = 375;
let H = 667;
let dpr = 1;
if (isTT) {
  try {
    const sys = tt.getSystemInfoSync();
    W = sys.windowWidth;
    H = sys.windowHeight;
    dpr = sys.pixelRatio || 1;
  } catch (e) {
    // 使用默认值
  }
  canvas = tt.createCanvas();
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
}

const SIZE = Logic.SIZE;
const PAD = 12;
const boardSize = Math.min(W, H) * 0.88;
const cell = (boardSize - PAD * (SIZE + 1)) / SIZE;
const boardX = (W - boardSize) / 2;
const boardY = (H - boardSize) / 2 + 24;

const COLORS = {
  2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563', 32: '#f67c5f',
  64: '#f65e3b', 128: '#edcf72', 256: '#edcc61', 512: '#edc850',
  1024: '#edc53f', 2048: '#edc22e',
};
const POP_MS = 340;    // 合并缩放/光晕持续时间
const SCORE_MS = 720;  // 分数上浮消散时间

let state = Logic.initGame();
let screen = 'guide'; // 'guide' | 'play'：开局先显示玩法引导

// 视觉特效状态
let mergeFx = [];   // 活跃合并特效：{ cells:[{r,c,val}], t0 }
let particles = []; // 火花粒子：{ x,y,vx,vy,life,maxLife,color,size }
let scorePops = []; // 分数上浮：{ x,y,val,t0 }

// 震动开关：默认开；读取本地存储让用户偏好持久化
let vibrateOn = true;
if (isTT && tt.getStorageSync) {
  try {
    const v = tt.getStorageSync('vibrateOn');
    if (typeof v === 'boolean') vibrateOn = v;
  } catch (e) { /* 用默认值 */ }
}

// ---------- 排行榜（自建云后端，全球榜） ----------
const RANK_ENDPOINT = config.RANK_ENDPOINT;
const RANK_SECRET = config.RANK_SECRET || ''; // 防刷分签名密钥；为空则不上传签名（本地联调用）
let rankScroll = 0;       // 榜单滚动偏移（像素）
let lastMoveY = 0;        // 触摸滑动上一帧 Y
let rankLoading = false;  // 榜单请求中
let rankError = null;     // 榜单请求失败信息
let rankData = null;      // 榜单数据：{ top, selfRank, selfName, selfScore }
let rankUid = '';         // 本机唯一标识（存 storage）
let rankSelfName = '我';  // 展示昵称（首次随机生成，存 storage）

if (isTT) {
  try {
    rankUid = tt.getStorageSync('rankUid') || '';
    rankSelfName = tt.getStorageSync('rankName') || '';
    if (!rankUid) {
      rankUid = 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
      tt.setStorageSync({ key: 'rankUid', data: rankUid });
    }
    if (!rankSelfName) {
      rankSelfName = '玩家' + Math.floor(1000 + Math.random() * 9000);
      tt.setStorageSync({ key: 'rankName', data: rankSelfName });
    }
  } catch (e) { /* 用默认值 */ }
}

// 对「uid|score|ts」做 HMAC 签名（仅当配置了 RANK_SECRET 时）
function signScore(uid, score, ts) {
  if (!RANK_SECRET) return '';
  return HMAC.hmacSha256Hex(RANK_SECRET, uid + '|' + score + '|' + ts);
}

// 上传当前分数到云后端（失败静默，不影响游戏）
function submitScore(s) {
  if (!isTT || !RANK_ENDPOINT) return;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signScore(rankUid, s, ts);
    tt.request({
      url: RANK_ENDPOINT + '/score',
      method: 'POST',
      data: { uid: rankUid, name: rankSelfName, score: s, ts, sig },
      header: { 'Content-Type': 'application/json' },
      success: () => {},
      fail: () => {},
    });
  } catch (e) { /* noop */ }
}

// 从云后端拉取榜单（前 100 + 自己名次）
function loadRank() {
  if (!isTT || !RANK_ENDPOINT) {
    rankError = '未配置榜单地址：请在 config.js 填写 RANK_ENDPOINT';
    rankLoading = false;
    return;
  }
  rankLoading = true;
  rankError = null;
  const ts = Math.floor(Date.now() / 1000);
  const sig = RANK_SECRET ? HMAC.hmacSha256Hex(RANK_SECRET, rankUid + '|' + ts) : '';
  tt.request({
    url: RANK_ENDPOINT + '/rank?uid=' + encodeURIComponent(rankUid) + '&limit=100&ts=' + ts + '&sig=' + encodeURIComponent(sig),
    method: 'GET',
    success: (res) => {
      if (res && res.data) { rankData = res.data; rankLoading = false; }
      else { rankError = '榜单数据格式异常'; rankLoading = false; }
    },
    fail: () => { rankError = '榜单请求失败，请检查网络或后端地址'; rankLoading = false; },
  });
}

// 打开排行榜：上传分数并拉榜
function openRank() {
  rankLoading = true;
  rankError = null;
  rankData = null;
  rankScroll = 0;
  screen = 'rank';
  submitScore(state.score);
  loadRank();
}

function rankBtnRect() {
  return { x: W - 86, y: 16, w: 74, h: 30 };
}
function rankPanelRect() {
  return { x: PAD, y: 56, w: W - PAD * 2, h: H - 56 - 24 };
}
function rankCloseRect() {
  // 放在面板左上角，避开抖音小游戏右上角的系统胶囊按钮（菜单/关闭），保证可点
  const p = rankPanelRect();
  return { x: p.x + 10, y: p.y + 10, w: 28, h: 28 };
}

function drawRank() {
  const p = rankPanelRect();
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, W, H);
  // 面板
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#faf8ef';
  roundRect(p.x, p.y, p.w, p.h, 16); ctx.fill();
  ctx.restore();
  // 标题
  ctx.fillStyle = '#776e65'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('全球排行榜 · 前 100 名', W / 2, p.y + 30);
  // 关闭提示：系统返回键或左上角 × 均可关闭
  ctx.fillStyle = '#bbada0'; ctx.font = '12px sans-serif';
  ctx.fillText('系统返回键 / × 关闭', W / 2, p.y + 48);
  // 关闭按钮（×）
  const cr = rankCloseRect();
  ctx.strokeStyle = '#bbada0'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cr.x + 8, cr.y + 8); ctx.lineTo(cr.x + cr.w - 8, cr.y + cr.h - 8);
  ctx.moveTo(cr.x + cr.w - 8, cr.y + 8); ctx.lineTo(cr.x + 8, cr.y + cr.h - 8);
  ctx.stroke();

  // 加载中
  if (rankLoading) {
    ctx.fillStyle = '#776e65'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '16px sans-serif';
    ctx.fillText('榜单加载中…', W / 2, p.y + p.h / 2);
    return;
  }
  // 出错
  if (rankError) {
    ctx.fillStyle = '#c0392b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '15px sans-serif';
    ctx.fillText(rankError, W / 2, p.y + p.h / 2 - 12);
    ctx.fillStyle = '#8f7a66'; ctx.font = 'bold 15px sans-serif';
    ctx.fillText('点击任意处重试', W / 2, p.y + p.h / 2 + 16);
    return;
  }
  // 无数据
  if (!rankData) {
    ctx.fillStyle = '#776e65'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '16px sans-serif';
    ctx.fillText('暂无数据', W / 2, p.y + p.h / 2);
    return;
  }

  const view = rankData;
  const listTop = p.y + 56;
  const listBottom = p.y + p.h - 56;
  const rowH = 34;
  const contentH = view.top.length * rowH;
  const maxScroll = Math.max(0, contentH - (listBottom - listTop));
  rankScroll = Math.max(0, Math.min(maxScroll, rankScroll));

  ctx.save();
  ctx.beginPath(); ctx.rect(p.x, listTop, p.w, listBottom - listTop); ctx.clip();
  for (let i = 0; i < view.top.length; i++) {
    const ry = listTop + i * rowH - rankScroll;
    if (ry + rowH < listTop || ry > listBottom) continue;
    const item = view.top[i];
    if (item.isSelf) {
      ctx.fillStyle = 'rgba(237,194,46,0.25)';
      roundRect(p.x + 8, ry + 2, p.w - 16, rowH - 4, 8); ctx.fill();
    }
    ctx.fillStyle = item.rank <= 3 ? '#edc22e' : '#776e65';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('#' + item.rank, p.x + 16, ry + rowH / 2);
    ctx.fillStyle = '#5b4a1f';
    ctx.font = '15px sans-serif';
    let nm = item.name; if (nm.length > 10) nm = nm.slice(0, 9) + '…';
    ctx.fillText(nm, p.x + 56, ry + rowH / 2);
    ctx.textAlign = 'right'; ctx.fillStyle = '#776e65'; ctx.font = 'bold 14px sans-serif';
    ctx.fillText(String(item.score), p.x + p.w - 16, ry + rowH / 2);
  }
  ctx.restore();

  // 底部固定条：始终显示「你的排名」
  const fy = p.y + p.h - 44;
  ctx.fillStyle = '#8f7a66';
  roundRect(p.x + 8, fy, p.w - 16, 34, 10); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText('你的排名：第 ' + view.selfRank + ' 位', p.x + 20, fy + 17);
  ctx.textAlign = 'right'; ctx.font = '14px sans-serif';
  ctx.fillText('最高 ' + view.selfScore, p.x + p.w - 20, fy + 17);
}

// ---------- 广告（占位，需真实 adUnitId） ----------
const BANNER_AD_ID = config.BANNER_AD_ID;   // ← 在 config.js 填写
const REWARD_AD_ID = config.REWARD_AD_ID;   // ← 在 config.js 填写
let bannerAd = null;

function showBanner() {
  if (!isTT || !BANNER_AD_ID) return;
  try {
    if (!bannerAd) {
      bannerAd = tt.createBannerAd({
        adUnitId: BANNER_AD_ID,
        adIntervals: 30,
        style: { left: 0, top: H - 100, width: W },
      });
    }
    if (bannerAd.show) bannerAd.show().catch(() => {});
  } catch (e) {
    // 广告失败不应影响游戏
  }
}

function hideBanner() {
  if (bannerAd && bannerAd.hide) {
    try { bannerAd.hide(); } catch (e) { /* noop */ }
  }
}

function watchRewardedThenRestart() {
  const reset = () => { state = Logic.initGame(); screen = 'play'; hideBanner(); };
  if (!isTT || !REWARD_AD_ID) { reset(); return; }
  try {
    const ad = tt.createRewardedVideoAd({ adUnitId: REWARD_AD_ID });
    ad.onClose(reset);
    if (ad.show) ad.show().catch(reset);
  } catch (e) { reset(); }
}

function restart() {
  state = Logic.initGame();
  screen = 'play';
  hideBanner();
}

// ---------- 输入 ----------
if (isTT) {
  let sx = 0;
  let sy = 0;
  tt.onTouchStart((e) => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    lastMoveY = sy;
  });
  tt.onTouchEnd((e) => {
    const t = e.changedTouches[0];
    // 排行榜界面：关闭按钮优先判定（任何状态都可关），否则错误态点击重试
    if (screen === 'rank') {
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        // 关闭按钮优先：错误态下也不能让「点哪都重试」吞掉关闭，否则榜单关不掉
        const cr = rankCloseRect();
        if (t.clientX >= cr.x && t.clientX <= cr.x + cr.w &&
            t.clientY >= cr.y && t.clientY <= cr.y + cr.h) {
          screen = 'play';
          return;
        }
        if (rankError) { loadRank(); return; }
      }
      return;
    }
    if (screen === 'guide') {
      const bx = W / 2 - 80, by = H / 2 + 60, bw = 160, bh = 48;
      if (t.clientX >= bx && t.clientX <= bx + bw && t.clientY >= by && t.clientY <= by + bh) {
        screen = 'play';
      }
      return;
    }
    // 震动开关按钮：命中即切换并返回，不触发移动
    {
      const tg = vibrateToggleRect();
      if (t.clientX >= tg.x && t.clientX <= tg.x + tg.w &&
          t.clientY >= tg.y && t.clientY <= tg.y + tg.h) {
        vibrateOn = !vibrateOn;
        if (isTT && tt.setStorageSync) {
          try { tt.setStorageSync({ key: 'vibrateOn', data: vibrateOn }); } catch (e) { /* noop */ }
        }
        return;
      }
    }
    // 排行榜按钮：命中即打开榜单
    {
      const rb = rankBtnRect();
      if (screen === 'play' && t.clientX >= rb.x && t.clientX <= rb.x + rb.w &&
          t.clientY >= rb.y && t.clientY <= rb.y + rb.h) {
        openRank();
        return;
      }
    }
    if (state.over) {
      watchRewardedThenRestart();
      return;
    }
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return; // 视作点击，忽略
    let dir;
    if (Math.abs(dx) > Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else dir = dy > 0 ? 'down' : 'up';
    const res = Logic.move(state, dir);
    if (res.moved) {
      state = res.state;
      if (res.merged && res.merged.length) {
        const cells = res.merged.map(([r, c]) => ({ r, c, val: state.grid[r][c] }));
        mergeFx.push({ cells, t0: Date.now() });
        for (const cc of cells) spawnParticles(cc.r, cc.c, cc.val);
        if (res.gained) {
          scorePops.push({ x: boardX + boardSize / 2, y: boardY - 14, val: res.gained, t0: Date.now() });
        }
        // 合并时轻微震动（受震动开关控制），强化“撞击”手感
        try { if (vibrateOn && tt.vibrateShort) tt.vibrateShort({ type: 'light' }); } catch (e) { /* noop */ }
      }
      if (state.over) { submitScore(state.score); showBanner(); }
    }
  });

  // 排行榜界面：拖动滚动列表（手指上滑 → 列表上滚 → rankScroll 增大）
  tt.onTouchMove((e) => {
    if (screen !== 'rank') return;
    const ty = e.touches[0].clientY;
    rankScroll += (lastMoveY - ty);
    lastMoveY = ty;
  });

  // 系统返回（Android 返回键 / iOS 返回手势）：排行榜界面消费返回事件，仅关闭榜单不退出小游戏。
  // 抖音基础库存在新旧两种 API 形态，需兼容：
  //   新版：enableBackPressed() 开启监听（无参） + onBackPressed(cb) 注册回调
  //   旧版：enableBackPressed(cb) 直接把回调当作参数
  // 回调返回 true = 消费事件（拦截，不退出）；false = 放行系统默认（退出小游戏）。
  const onBack = () => {
    if (screen === 'rank') {
      screen = 'play';
      return true; // 消费返回事件，仅关闭排行榜
    }
    return false; // 游戏主界面走系统默认（退出小游戏）
  };
  if (typeof tt.onBackPressed === 'function') {
    try {
      tt.onBackPressed(onBack);
      if (typeof tt.enableBackPressed === 'function') {
        try { tt.enableBackPressed(); } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略，仍可点 × 返回 */ }
  } else if (typeof tt.enableBackPressed === 'function') {
    // 兼容旧版：enableBackPressed(cb)
    try { tt.enableBackPressed(onBack); } catch (e) { /* 忽略，仍可点 × 返回 */ }
  }
}

// ---------- 视觉工具 ----------
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 把十六进制颜色提亮 amt(0~1)，返回 rgb 字符串，供火花/光晕使用
function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.min(255, Math.round(r + (255 - r) * amt));
  g = Math.min(255, Math.round(g + (255 - g) * amt));
  b = Math.min(255, Math.round(b + (255 - b) * amt));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function cellTop(r, c) {
  return { x: boardX + PAD + c * (cell + PAD), y: boardY + PAD + r * (cell + PAD) };
}
function cellCenter(r, c) {
  const t = cellTop(r, c);
  return { x: t.x + cell / 2, y: t.y + cell / 2 };
}

// 震动开关按钮的屏幕矩形（棋盘正下方居中）
function vibrateToggleRect() {
  const w = 104, h = 30;
  return { x: W / 2 - w / 2, y: boardY + boardSize + 28, w, h };
}

function spawnParticles(r, c, val) {
  const ct = cellCenter(r, c);
  const base = COLORS[val] || '#3c3a32';
  const spark = lighten(base, 0.55);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const ang = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const sp = cell * 0.003 + Math.random() * cell * 0.004;
    particles.push({
      x: ct.x, y: ct.y,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      life: 0, maxLife: 360 + Math.random() * 180,
      color: spark, size: cell * 0.05 + Math.random() * cell * 0.05,
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
    p.vx -= p.vx * 0.012 * dt;
    p.vy -= p.vy * 0.012 * dt;
    p.vy += cell * 0.0006 * dt; // 轻微重力，粒子下坠更有质感
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

function drawGlow(cx, cy, val, k) {
  const rad = cell * (0.9 + k * 0.7);
  const g = ctx.createRadialGradient(cx, cy, cell * 0.2, cx, cy, rad);
  g.addColorStop(0, 'rgba(255,236,150,' + (0.55 * (1 - k)).toFixed(3) + ')');
  g.addColorStop(0.5, 'rgba(246,178,89,' + (0.30 * (1 - k)).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(246,178,89,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fill();
}

function drawRing(cx, cy, k) {
  ctx.save();
  ctx.globalAlpha = (1 - k) * 0.7;
  ctx.strokeStyle = 'rgba(255,239,160,0.95)';
  ctx.lineWidth = cell * 0.10 * (1 - k) + 1;
  ctx.beginPath();
  ctx.arc(cx, cy, cell * (0.5 + k * 0.7), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawCell(x, y, val, scale, flash) {
  const s = scale || 1;
  const w = cell * s;
  const off = (w - cell) / 2;
  const px = x - off, py = y - off;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = cell * 0.06;
  ctx.shadowOffsetY = cell * 0.03;
  ctx.fillStyle = val ? (COLORS[val] || '#3c3a32') : '#cdc1b4';
  roundRect(px, py, w, w, cell * 0.12);
  ctx.fill();
  ctx.restore();
  if (flash && flash > 0) {
    ctx.save();
    ctx.globalAlpha = flash;
    ctx.fillStyle = '#ffffff';
    roundRect(px, py, w, w, cell * 0.12);
    ctx.fill();
    ctx.restore();
  }
  if (val) {
    ctx.fillStyle = val <= 4 ? '#776e65' : '#f9f6f2';
    ctx.font = 'bold ' + Math.floor(cell * 0.38 * s) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(val), px + w / 2, py + w / 2);
  }
}

function draw() {
  const now = Date.now();
  mergeFx = mergeFx.filter((fx) => now - fx.t0 < POP_MS);
  scorePops = scorePops.filter((s) => now - s.t0 < SCORE_MS);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#faf8ef';
  ctx.fillRect(0, 0, W, H);

  // 顶部标题与分数
  ctx.fillStyle = '#776e65';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('合成能量', boardX, boardY - 36);
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('分数 ' + state.score, boardX + boardSize, boardY - 36);

  // 棋盘底板
  ctx.fillStyle = '#bbada0';
  roundRect(boardX, boardY, boardSize, boardSize, cell * 0.12);
  ctx.fill();

  // 合并特效映射：key = r*SIZE+c
  const mmap = {};
  for (const fx of mergeFx) {
    const k = (now - fx.t0) / POP_MS;
    if (k >= 1) continue;
    for (const cc of fx.cells) {
      mmap[cc.r * SIZE + cc.c] = {
        scale: 1 + 0.22 * Math.sin(k * Math.PI), // 弹性放大：1 → 1.22 → 1
        flash: Math.max(0, 1 - k) * 0.5,
        val: cc.val,
        k,
      };
    }
  }

  // 第一遍：光晕（在方块之下）
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const m = mmap[r * SIZE + c];
      if (!m) continue;
      const ct = cellCenter(r, c);
      drawGlow(ct.x, ct.y, m.val, m.k);
    }
  }

  // 第二遍：方块本体
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = cellTop(r, c);
      const m = mmap[r * SIZE + c];
      drawCell(t.x, t.y, state.grid[r][c], m ? m.scale : 1, m ? m.flash : 0);
    }
  }

  // 第三遍：冲击波光环（方块之上）
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const m = mmap[r * SIZE + c];
      if (!m) continue;
      const ct = cellCenter(r, c);
      drawRing(ct.x, ct.y, m.k);
    }
  }

  // 火花粒子
  for (const p of particles) {
    const a = 1 - p.life / p.maxLife;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 分数上浮消散
  for (const s of scorePops) {
    const k = (now - s.t0) / SCORE_MS;
    const a = 1 - k;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = '#f59563';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+' + s.val, s.x, s.y - k * 26);
    ctx.restore();
  }

  // 震动开关按钮（棋盘正下方居中，仅游戏进行中显示）
  if (screen === 'play') {
    const tg = vibrateToggleRect();
    ctx.fillStyle = vibrateOn ? '#edc22e' : '#cdc1b4';
    roundRect(tg.x, tg.y, tg.w, tg.h, tg.h / 2);
    ctx.fill();
    ctx.fillStyle = vibrateOn ? '#5b4a1f' : '#776e65';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('震动 ' + (vibrateOn ? '开' : '关'), W / 2, tg.y + tg.h / 2);
  }

  // 排行榜按钮（右上角，仅游戏进行中显示）
  if (screen === 'play') {
    const rb = rankBtnRect();
    ctx.fillStyle = '#8f7a66';
    roundRect(rb.x, rb.y, rb.w, rb.h, rb.h / 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('排行榜', rb.x + rb.w / 2, rb.y + rb.h / 2);
  }

  // 游戏结束遮罩
  if (state.over && screen === 'play') {
    ctx.fillStyle = 'rgba(250,248,239,0.80)';
    ctx.fillRect(boardX, boardY, boardSize, boardSize);
    ctx.fillStyle = '#776e65';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('游戏结束', W / 2, H / 2 - 16);
    ctx.font = '16px sans-serif';
    ctx.fillText('点击看广告重开', W / 2, H / 2 + 18);
  }

  // 开局引导
  if (screen === 'guide') {
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('合成能量', W / 2, H / 2 - 130);
    ctx.font = '15px sans-serif';
    const lines = [
      '滑动屏幕，相同数字撞一起就合成翻倍',
      '2+2=4，4+4=8，越合越大',
      '每步随机冒出新数字，别让格子填满',
      '目标：挑战你的最高分！',
    ];
    lines.forEach((ln, i) => ctx.fillText(ln, W / 2, H / 2 - 80 + i * 26));
    const bx = W / 2 - 80, by = H / 2 + 60, bw = 160, bh = 48;
    ctx.fillStyle = '#edc22e';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#5b4a1f';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('开始游戏', W / 2, by + bh / 2);
  }

  // 排行榜弹窗（覆盖在最上层）
  if (screen === 'rank') drawRank();
}

let lastT = Date.now();
function loop() {
  const now = Date.now();
  const dt = Math.min(50, now - lastT);
  lastT = now;
  updateParticles(dt);
  draw();
  if (isTT) requestAnimationFrame(loop);
}

if (isTT) {
  requestAnimationFrame(loop);
} else {
  // 非小游戏环境（例如误在 Node 下执行）给出提示，不崩溃
  console.log('[merge-energy] 这是抖音小游戏工程，请在「抖音开发者工具」中导入运行。');
}

// 测试钩子（仅供 QA 在 Node 下 require 验证；不影响抖音运行时）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _t: {
      getScroll: () => rankScroll,
      setScroll: (v) => { rankScroll = v; },
      openRank,
      isTT,
      getScreen: () => screen,
      getRankState: () => ({ loading: rankLoading, error: rankError, data: rankData, uid: rankUid, name: rankSelfName }),
      setRankError: (v) => { rankError = v; },
      rankBtnRect,
    },
  };
}
