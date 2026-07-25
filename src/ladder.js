// src/ladder.js —— 天梯（异步匹配）前端客户端 + Canvas UI（零依赖，原生 tt + Canvas）
// 抖音小游戏运行时无 Node crypto，签名复用 src/hmac.js 的纯 JS HMAC-SHA256。
//
// 约定（与后端严格一致）：
//   - 字段 snake_case；ts 秒级 Unix；HMAC-SHA256 密钥 RANK_SECRET；canonical 用 | 拼接。
//   - match 签名 canonical = uid|score|steps|ts
//   - history 签名 canonical = uid|ts
//   - 所有自定义按钮避开右上角系统胶囊：关闭×与“天梯历史”入口放左上角。
//
// 该模块在 Node 下也可被安全 require（仅定义函数/常量，不触碰 tt 全局），便于 QA。

const HMAC = require('./hmac.js');
const cfg = require('../config.js');

const isTT = typeof tt !== 'undefined' && !!tt.createCanvas;

// ---------- 签名 ----------
function signLadder(uid, score, steps, ts) {
  if (!cfg.RANK_SECRET) return '';
  return HMAC.hmacSha256Hex(
    cfg.RANK_SECRET,
    String(uid) + '|' + Math.floor(Number(score) || 0) + '|' + Math.floor(Number(steps) || 0) + '|' + ts
  );
}
function signLadderHistory(uid, ts) {
  if (!cfg.RANK_SECRET) return '';
  return HMAC.hmacSha256Hex(cfg.RANK_SECRET, String(uid) + '|' + ts);
}

// ---------- 网络请求 ----------
function fetchLadderMatch(payload) {
  return new Promise((resolve, reject) => {
    if (!isTT || !cfg.RANK_ENDPOINT) { reject(new Error('未配置天梯后端')); return; }
    const sig = signLadder(payload.uid, payload.score, payload.steps, payload.ts);
    tt.request({
      url: cfg.LADDER_MATCH_PATH,
      method: 'POST',
      data: Object.assign({}, payload, { sig }),
      header: { 'Content-Type': 'application/json' },
      success: (res) => resolve(res && res.data ? res.data : { code: 5, data: null, message: 'empty response' }),
      fail: (e) => reject(e),
    });
  });
}

function fetchLadderHistory(uid, limit) {
  return new Promise((resolve, reject) => {
    if (!isTT || !cfg.RANK_ENDPOINT) { reject(new Error('未配置天梯后端')); return; }
    const ts = Math.floor(Date.now() / 1000);
    const sig = signLadderHistory(uid, ts);
    const q = 'uid=' + encodeURIComponent(uid) +
      '&limit=' + (limit || 20) +
      '&ts=' + ts +
      '&sig=' + encodeURIComponent(sig);
    tt.request({
      url: cfg.LADDER_HISTORY_PATH + '?' + q,
      method: 'GET',
      success: (res) => resolve(res && res.data ? res.data : { code: 5, data: null, message: 'empty response' }),
      fail: (e) => reject(e),
    });
  });
}

// ================= Canvas UI =================
// 绘制函数均接收 ctx 与布局对象 L = { W, H, PAD, boardX, boardY, boardSize, cell }，
// 不依赖 game.js 内部变量，保持本模块自洽。矩形位置由各 rect 导出供点击判定复用（单一数据源）。

const TILE_COLORS = {
  2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563', 32: '#f67c5f',
  64: '#f65e3b', 128: '#edcf72', 256: '#edcc61', 512: '#edc850',
  1024: '#edc53f', 2048: '#edc22e',
};

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ladderEntryBtnRect() {
  // 游戏进行中：左上角，紧挨排行榜按钮右侧（避开右上角系统胶囊）
  return { x: 92, y: 56, w: 74, h: 30 };
}
function ladderPanelRect(L) {
  return { x: L.PAD, y: 56, w: L.W - L.PAD * 2, h: L.H - 56 - 24 };
}
function ladderCloseRect(L) {
  // 面板左上角 ×（避开系统胶囊）
  const p = ladderPanelRect(L);
  return { x: p.x + 10, y: p.y + 10, w: 28, h: 28 };
}
function ladderHistoryBtnRect(L) {
  // 面板左上角“天梯历史”入口（紧随 × 右侧）
  const p = ladderPanelRect(L);
  return { x: p.x + 10 + 28 + 8, y: p.y + 10, w: 92, h: 28 };
}
function ladderAgainBtnRect(L) {
  // 结算卡底部“再来一局”
  const p = ladderPanelRect(L);
  return { x: p.x + 16, y: p.y + p.h - 52, w: (p.w - 16 * 3) / 2, h: 40 };
}
function ladderRecordsBtnRect(L) {
  // 结算卡底部“看战绩”
  const p = ladderPanelRect(L);
  return { x: p.x + 16 * 2 + (p.w - 16 * 3) / 2, y: p.y + p.h - 52, w: (p.w - 16 * 3) / 2, h: 40 };
}
function ladderHistPanelRect(L) { return ladderPanelRect(L); }
function ladderHistCloseRect(L) {
  const p = ladderHistPanelRect(L);
  return { x: p.x + 10, y: p.y + 10, w: 28, h: 28 };
}

function drawMiniBoard(ctx, x, y, w, grid) {
  const n = grid.length;
  if (!n) return;
  const pad = 4;
  const cw = (w - pad * (n + 1)) / n;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = grid[r][c];
      const px = x + pad + c * (cw + pad);
      const py = y + pad + r * (cw + pad);
      ctx.fillStyle = v ? (TILE_COLORS[v] || '#3c3a32') : '#cdc1b4';
      rr(ctx, px, py, cw, cw, cw * 0.12); ctx.fill();
      if (v) {
        ctx.fillStyle = v <= 4 ? '#776e65' : '#f9f6f2';
        ctx.font = 'bold ' + Math.floor(cw * 0.42) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(v), px + cw / 2, py + cw / 2);
      }
    }
  }
}

function drawPlayer(ctx, x, y, w, name, score, boardSummary, synthetic) {
  // 头像占位（圆）
  const cx = x + 24, cy = y + 24, r = 22;
  ctx.fillStyle = synthetic ? '#b9aaa0' : '#8f7a66';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(synthetic ? '?' : (name ? String(name).slice(0, 1) : '?'), cx, cy);
  // 昵称
  ctx.fillStyle = '#5b4a1f'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 15px sans-serif';
  let nm = String(name || '玩家'); if (nm.length > 8) nm = nm.slice(0, 7) + '…';
  ctx.fillText(nm, x + 54, y + 16);
  // 分数
  ctx.fillStyle = '#776e65'; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(String(score), x + 54, y + 40);
  // 迷你棋盘（若有 boardSummary）
  if (Array.isArray(boardSummary) && boardSummary.length) {
    drawMiniBoard(ctx, x, y + 66, w, boardSummary);
  }
}

// 绘制天梯结算卡（你 VS 对手）。返回 void。
function drawLadderCard(ctx, L, match, opts) {
  opts = opts || {};
  const p = ladderPanelRect(L);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, L.W, L.H);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#faf8ef';
  rr(ctx, p.x, p.y, p.w, p.h, 16); ctx.fill();
  ctx.restore();

  // 关闭 ×（左上角，避开系统胶囊）
  const cr = ladderCloseRect(L);
  ctx.strokeStyle = '#bbada0'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cr.x + 8, cr.y + 8); ctx.lineTo(cr.x + cr.w - 8, cr.y + cr.h - 8);
  ctx.moveTo(cr.x + cr.w - 8, cr.y + 8); ctx.lineTo(cr.x + 8, cr.y + cr.h - 8);
  ctx.stroke();
  // “天梯历史”入口（左上角，紧随 ×）
  const hb = ladderHistoryBtnRect(L);
  ctx.fillStyle = '#8f7a66';
  rr(ctx, hb.x, hb.y, hb.w, hb.h, hb.h / 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('天梯历史', hb.x + hb.w / 2, hb.y + hb.h / 2);

  // 加载中
  if (opts.loading) {
    ctx.fillStyle = '#776e65'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '16px sans-serif';
    ctx.fillText('天梯匹配中…', L.W / 2, p.y + p.h / 2);
    return;
  }
  // 出错
  if (opts.error) {
    ctx.fillStyle = '#c0392b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '15px sans-serif';
    ctx.fillText(opts.error, L.W / 2, p.y + p.h / 2 - 12);
    ctx.fillStyle = '#8f7a66'; ctx.font = 'bold 15px sans-serif';
    ctx.fillText('点击任意处重试', L.W / 2, p.y + p.h / 2 + 16);
    return;
  }
  if (!match) return;

  // 标题
  ctx.fillStyle = '#776e65'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('你 VS 对手', L.W / 2, p.y + 30);
  ctx.fillStyle = '#bbada0'; ctx.font = '12px sans-serif';
  ctx.fillText('系统返回键 / × 关闭', L.W / 2, p.y + 48);

  // 双方信息
  const cardY = p.y + 72;
  const colW = (p.w - 40) / 2;
  drawPlayer(ctx, p.x + 16, cardY, colW, '你', match.myScore, null, false);
  // VS
  ctx.fillStyle = '#edc22e'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('VS', L.W / 2, cardY + 40);
  drawPlayer(ctx, p.x + p.w - 16 - colW, cardY, colW,
    match.opponent.name, match.opponent.score, match.opponent.boardSummary, match.opponent.synthetic);

  // 结果
  const resY = cardY + 100;
  const resText = match.result === 'win' ? '胜利！' : match.result === 'loss' ? '惜败' : '平局';
  const resColor = match.result === 'win' ? '#3a8a3a' : match.result === 'loss' ? '#c0392b' : '#8f7a66';
  ctx.fillStyle = resColor; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText(resText, L.W / 2, resY);
  ctx.fillStyle = '#776e65'; ctx.font = '16px sans-serif';
  const sign = match.diff > 0 ? '+' : '';
  ctx.fillText('分差 ' + sign + match.diff + (match.synthetic ? '（合成对手）' : ''), L.W / 2, resY + 28);

  // 底部按钮：再来一局 / 看战绩
  const ab = ladderAgainBtnRect(L);
  ctx.fillStyle = '#edc22e'; rr(ctx, ab.x, ab.y, ab.w, ab.h, ab.h / 2); ctx.fill();
  ctx.fillStyle = '#5b4a1f'; ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('再来一局', ab.x + ab.w / 2, ab.y + ab.h / 2);
  const rb = ladderRecordsBtnRect(L);
  ctx.fillStyle = '#8f7a66'; rr(ctx, rb.x, rb.y, rb.w, rb.h, rb.h / 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif';
  ctx.fillText('看战绩', rb.x + rb.w / 2, rb.y + rb.h / 2);
}

function formatTs(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = new Date(t * 1000);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 绘制天梯战绩面板。返回裁剪后的 scroll（供 game.js 写回状态）。
function drawLadderHistory(ctx, L, hist, opts) {
  opts = opts || {};
  const p = ladderHistPanelRect(L);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, L.W, L.H);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#faf8ef';
  rr(ctx, p.x, p.y, p.w, p.h, 16); ctx.fill();
  ctx.restore();

  // × 关闭（左上角）
  const cr = ladderHistCloseRect(L);
  ctx.strokeStyle = '#bbada0'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cr.x + 8, cr.y + 8); ctx.lineTo(cr.x + cr.w - 8, cr.y + cr.h - 8);
  ctx.moveTo(cr.x + cr.w - 8, cr.y + 8); ctx.lineTo(cr.x + 8, cr.y + cr.h - 8);
  ctx.stroke();

  // 标题
  ctx.fillStyle = '#776e65'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('天梯战绩', L.W / 2, p.y + 30);
  ctx.fillStyle = '#bbada0'; ctx.font = '12px sans-serif';
  ctx.fillText('系统返回键 / × 关闭', L.W / 2, p.y + 48);

  if (opts.loading) {
    ctx.fillStyle = '#776e65'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '16px sans-serif';
    ctx.fillText('战绩加载中…', L.W / 2, p.y + p.h / 2);
    return opts.scroll || 0;
  }
  if (opts.error) {
    ctx.fillStyle = '#c0392b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '15px sans-serif';
    ctx.fillText(opts.error, L.W / 2, p.y + p.h / 2 - 12);
    ctx.fillStyle = '#8f7a66'; ctx.font = 'bold 15px sans-serif';
    ctx.fillText('点击任意处重试', L.W / 2, p.y + p.h / 2 + 16);
    return opts.scroll || 0;
  }
  if (!hist || !hist.list || !hist.list.length) {
    ctx.fillStyle = '#776e65'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '16px sans-serif';
    ctx.fillText('暂无战绩', L.W / 2, p.y + p.h / 2);
    return opts.scroll || 0;
  }

  const list = hist.list;
  const listTop = p.y + 64;
  const listBottom = p.y + p.h - 24;
  const rowH = 46;
  const contentH = list.length * rowH;
  const maxScroll = Math.max(0, contentH - (listBottom - listTop));
  const scroll = Math.max(0, Math.min(maxScroll, opts.scroll || 0));

  ctx.save();
  ctx.beginPath(); ctx.rect(p.x, listTop, p.w, listBottom - listTop); ctx.clip();
  for (let i = 0; i < list.length; i++) {
    const ry = listTop + i * rowH - scroll;
    if (ry + rowH < listTop || ry > listBottom) continue;
    const it = list[i];
    const rx = p.x + 10;
    const rw = p.w - 20;
    const rc = it.result === 'win' ? '#3a8a3a' : it.result === 'loss' ? '#c0392b' : '#8f7a66';
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    rr(ctx, rx, ry + 4, rw, rowH - 8, 8); ctx.fill();
    // 结果色条
    ctx.fillStyle = rc;
    ctx.fillRect(rx, ry + 4, 4, rowH - 8);
    // 对手名 + 时间
    ctx.fillStyle = '#5b4a1f'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 14px sans-serif';
    let nm = String(it.oppName || '对手'); if (nm.length > 8) nm = nm.slice(0, 7) + '…';
    ctx.fillText(nm + (it.opponentSynthetic ? '（合成）' : ''), rx + 14, ry + rowH / 2 - 9);
    ctx.fillStyle = '#a89b8c'; ctx.font = '11px sans-serif';
    ctx.fillText(formatTs(it.ts), rx + 14, ry + rowH / 2 + 9);
    // 比分 + 结果
    ctx.fillStyle = '#776e65'; ctx.textAlign = 'right'; ctx.font = 'bold 13px sans-serif';
    const sign = (it.diff > 0 ? '+' : '');
    ctx.fillText(it.myScore + ' : ' + it.oppScore, rx + rw - 14, ry + rowH / 2 - 9);
    ctx.fillStyle = rc; ctx.font = 'bold 13px sans-serif';
    const rt = it.result === 'win' ? '胜' : it.result === 'loss' ? '负' : '平';
    ctx.fillText(rt + ' ' + sign + it.diff, rx + rw - 14, ry + rowH / 2 + 9);
  }
  ctx.restore();
  return scroll;
}

module.exports = {
  // 客户端
  signLadder,
  signLadderHistory,
  fetchLadderMatch,
  fetchLadderHistory,
  // 绘制
  drawLadderCard,
  drawLadderHistory,
  drawMiniBoard,
  // 矩形（点击判定复用）
  ladderEntryBtnRect,
  ladderPanelRect,
  ladderCloseRect,
  ladderHistoryBtnRect,
  ladderAgainBtnRect,
  ladderRecordsBtnRect,
  ladderHistPanelRect,
  ladderHistCloseRect,
};
