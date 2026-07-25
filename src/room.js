// src/room.js —— 房间对战前端客户端 + Canvas UI（零依赖，原生 tt + Canvas）
// 抖音小游戏运行时无 Node crypto，签名复用 src/hmac.js 的纯 JS HMAC-SHA256。
//
// 约定（与后端 / design-lock 严格一致）：
//   - 字段 snake_case；ts 秒级 Unix；HMAC-SHA256 密钥 RANK_SECRET；canonical 用 | 拼接。
//   - create/join/state/leave/reset 签名 canonical = uid|ts
//   - progress/result 签名 canonical = uid|score|steps|ts
//   - 色板复用 #edc22e(金) / #5b4a1f(深棕)（design-lock §7）。
//   - 所有自定义按钮避开右上角系统胶囊：大厅/等待/结算卡的「退出/返回」放左上角。
//
// 该模块在 Node 下也可被安全 require（仅定义函数/常量，不触碰 tt 全局），便于 QA。
// 轮询容错三原则（design-lock §6）已落实：
//   ① 超时 race（withTimeout 3500ms）② 指数退避（1500→3000→4500→6000，成功复位）③ 本地不阻塞。

const HMAC = require('./hmac.js');
const cfg = require('../config.js');
const Logic = require('./logic.js');

const isTT = typeof tt !== 'undefined' && !!tt.createCanvas;

// ---------- 设计锁定常量（design-lock §1.2） ----------
const ROOM_POLL_MS = cfg.ROOM_POLL_MS || 1500;
const ROOM_WAIT_POLL_MS = cfg.ROOM_WAIT_POLL_MS || 1000;
const ROOM_TIMEOUT_RACE_MS = cfg.ROOM_TIMEOUT_RACE_MS || 3500;
const ROOM_BACKOFF_MS = cfg.ROOM_BACKOFF_MS || [1500, 3000, 4500, 6000];
const ROOM_BACKOFF_MAX_MS = cfg.ROOM_BACKOFF_MAX_MS || 6000;
const ROOM_PROGRESS_THROTTLE_MS = cfg.ROOM_PROGRESS_THROTTLE_MS || 500;

// ---------- 色板（design-lock §7） ----------
const GOLD = '#edc22e';
const BROWN = '#5b4a1f';
const PANEL = '#faf8ef';
const INK = '#776e65';
const BTN = '#8f7a66';

const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// ================= 工具函数 =================

// ① 超时 race：抖音 tt.request 无原生 timeout，必须用 Promise.race 兜底
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

// ② 失败次数 → 退避间隔（取序列上限）
function computeBackoffMs(failCount) {
  const i = Math.max(0, Math.min(failCount, ROOM_BACKOFF_MS.length - 1));
  return ROOM_BACKOFF_MS[i];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hit(r, t) {
  return t.clientX >= r.x && t.clientX <= r.x + r.w &&
         t.clientY >= r.y && t.clientY <= r.y + r.h;
}

// ---------- 签名（复用 RANK_SECRET） ----------
function signUidTs(uid, ts) {
  if (!cfg.RANK_SECRET) return '';
  return HMAC.hmacSha256Hex(cfg.RANK_SECRET, String(uid) + '|' + ts);
}
function signScore(uid, score, steps, ts) {
  if (!cfg.RANK_SECRET) return '';
  return HMAC.hmacSha256Hex(
    cfg.RANK_SECRET,
    String(uid) + '|' + Math.floor(Number(score) || 0) + '|' + Math.floor(Number(steps) || 0) + '|' + ts
  );
}

// ---------- 网络请求（Promise 化 tt.request） ----------
function doRequest(method, url, data) {
  return new Promise((resolve, reject) => {
    if (!isTT || !tt || typeof tt.request !== 'function') {
      reject(new Error('tt.request unavailable'));
      return;
    }
    const opt = {
      url,
      method,
      header: { 'Content-Type': 'application/json' },
      success: (res) => resolve(res && res.data ? res.data : { code: 5, data: null, message: 'empty response' }),
      fail: (e) => reject(e || new Error('request fail')),
    };
    if (method === 'POST') opt.data = data || {};
    tt.request(opt);
  });
}

// ================= RoomClient 工厂 =================
// @param {object} opts
//   requestFn: 可选，注入请求函数（用于测试；默认 doRequest）
//   beginMatch: (seed) => void  用 seed 初始化本地棋盘（由 game.js 注入）
//   exit:       () => void      返回主界面（由 game.js 注入）
function createRoomClient(opts) {
  opts = opts || {};
  let requestFn = opts.requestFn || doRequest;
  const api = { beginMatch: opts.beginMatch || null, exit: opts.exit || null };

  let active = false;          // 房间流程是否活动（screen==='room'）
  let phase = 'hall';          // 'hall' | 'joinEntry' | 'waiting' | 'playing' | 'result'
  let code = '';
  let uid = '';
  let name = '';
  let amCreator = false;       // 是否为建房者（P1）
  let everJoined = false;      // 是否已在某房间（用于区分「新房主等对手」与「终局后重连重开」）
  let seed = 0;
  let startAt = 0;
  let serverStatus = '';       // 服务端 status：waiting/playing/finished/opponent_left/abandoned
  let matchResult = 0;         // 0 未定 / 1 P1胜 / 2 P2胜 / 3 平 / 4 对手离开 / 5 对手断线
  let oppScore = 0;
  let oppSteps = 0;
  let oppOver = false;
  let myScore = 0;
  let mySteps = 0;
  let lastProgressAt = 0;
  let failCount = 0;
  let backoffMs = ROOM_BACKOFF_MS[0];
  let roomSeq = 0;             // ③ 竞态守门：每次进入新房间/重开自增，过期回调丢弃
  let pollTimer = null;
  let beginTimer = null;
  let begunSeed = null;        // 当前这一局已用哪个 seed 开局（防重复 init）
  let hasBegunMatch = false;   // 是否曾开过局（用于终局后自动重连重开判定）
  let resultSent = false;      // 是否已提交终局 result（防重复）
  let errorMsg = null;
  let joinInput = '';          // 加入房码输入（最多 6 位）
  let lastL = null;            // 最近一次 render 的布局（供 handleTouch 命中判定）

  // ---------- 轮询（§6 三原则） ----------
  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (beginTimer) { clearTimeout(beginTimer); beginTimer = null; }
  }
  function schedulePoll() {
    if (!active || !code) return;
    const interval = (phase === 'waiting') ? ROOM_WAIT_POLL_MS : Math.max(ROOM_POLL_MS, backoffMs);
    pollTimer = setTimeout(pollLoop, interval);
  }
  function pollLoop() {
    if (!active || !code) return;
    const seq = ++roomSeq;
    withTimeout(getStateReq(), ROOM_TIMEOUT_RACE_MS)
      .then((resp) => {
        if (seq !== roomSeq || !active || !code) return; // 过期回调丢弃
        failCount = 0;
        backoffMs = ROOM_BACKOFF_MS[0];
        handleState(resp);
        // 仅当仍未终局、房间仍有效时继续轮询（本地不阻塞）
        if (active && code && matchResult === 0 && serverStatus !== 'finished' && serverStatus !== 'opponent_left' && serverStatus !== 'abandoned') {
          schedulePoll();
        }
      })
      .catch(() => {
        if (seq !== roomSeq || !active || !code) return;
        failCount = Math.min(failCount + 1, ROOM_BACKOFF_MS.length - 1);
        backoffMs = ROOM_BACKOFF_MS[failCount];
        schedulePoll(); // 退避后继续轮询（绝不阻断本地棋盘）
      });
  }

  function getStateReq() {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signUidTs(uid, ts);
    const q = 'code=' + encodeURIComponent(code) +
      '&uid=' + encodeURIComponent(uid) +
      '&ts=' + ts +
      '&sig=' + encodeURIComponent(sig);
    return requestFn('GET', cfg.ROOM_STATE_PATH + '?' + q);
  }

  // 处理一次 state 轮询结果（design-lock §4.4 + §2 状态机）
  function handleState(resp) {
    if (!resp || resp.code !== 0) {
      if (resp && resp.code === 3) {
        errorMsg = '房间不存在或已过期';
        stopPolling();
      }
      return;
    }
    serverStatus = resp.data.status || serverStatus;
    seed = (typeof resp.data.seed === 'number') ? resp.data.seed : seed;
    startAt = (typeof resp.data.startAt === 'number') ? resp.data.startAt : startAt;
    matchResult = resp.data.matchResult || 0;
    if (resp.data.opponent) {
      oppScore = resp.data.opponent.score || 0;
      oppSteps = resp.data.opponent.steps || 0;
      oppOver = !!resp.data.opponent.over;
    }
    myScore = resp.data.myScore || 0;

    // 终局：切结算卡，停止轮询
    if (matchResult > 0) {
      phase = 'result';
      stopPolling();
      return;
    }
    // 对局中
    if (serverStatus === 'playing') {
      if (phase !== 'playing') {
        phase = 'playing';
        scheduleBegin();
      }
      return; // 保持轮询
    }
    // waiting / 其它：进入等待态
    if (phase === 'waiting') return; // 已在等待
    phase = 'waiting';
    begunSeed = null; // 新一局（可能是终局后 reset）准备用新 seed 重开
    stopPolling();
    if (hasBegunMatch) {
      // 之前已开过局（终局后被 reset）→ 自动重连重开（对手 polling 到此态同理）
      rejoinToRestart();
    } else {
      schedulePoll(); // 新房主等对手
    }
  }

  // 到达 playing 后，按 startAt 本地时钟精确开局（双方同 startAt → 同步开局）
  function scheduleBegin() {
    const now = Date.now();
    const delay = Math.max(0, (startAt || 0) - now);
    if (beginTimer) { clearTimeout(beginTimer); beginTimer = null; }
    beginTimer = setTimeout(() => {
      beginTimer = null;
      if (!active || phase !== 'playing') return;
      if (begunSeed === seed) return; // 本局已开局，防重复 init
      begunSeed = seed;
      hasBegunMatch = true;
      if (api.beginMatch) api.beginMatch(seed);
    }, delay);
    schedulePoll();
  }

  // ---------- 对外动作 ----------
  function open(u, n) {
    active = true;
    uid = u || uid;
    name = n || name;
    phase = 'hall';
    code = '';
    seed = 0; startAt = 0; serverStatus = ''; matchResult = 0;
    oppScore = oppSteps = 0; oppOver = false;
    myScore = mySteps = 0;
    failCount = 0; backoffMs = ROOM_BACKOFF_MS[0];
    roomSeq++; // 作废旧回调
    everJoined = false; begunSeed = null; hasBegunMatch = false; resultSent = false;
    errorMsg = null; joinInput = '';
    stopPolling();
  }

  function exit() {
    // playing/waiting 期礼貌 POST leave；无论如何回到主界面
    const wasInRoom = !!code && (serverStatus === 'playing' || serverStatus === 'waiting' || phase === 'playing' || phase === 'waiting');
    active = false;
    stopPolling();
    if (wasInRoom && isTT) {
      const ts = Math.floor(Date.now() / 1000);
      const sig = signUidTs(uid, ts);
      const req = requestFn('POST', cfg.ROOM_LEAVE_PATH, { code, uid, ts, sig });
      withTimeout(req, ROOM_TIMEOUT_RACE_MS).catch(() => {}); // 失败静默
    }
    code = ''; serverStatus = ''; phase = 'hall';
    if (api.exit) api.exit();
  }

  function createRoom() {
    if (!uid) return;
    const ts = Math.floor(Date.now() / 1000);
    const sig = signUidTs(uid, ts);
    errorMsg = null;
    withTimeout(requestFn('POST', cfg.ROOM_CREATE_PATH, { uid, name, ts, sig }), ROOM_TIMEOUT_RACE_MS)
      .then((resp) => {
        if (resp && resp.code === 0 && resp.data) {
          code = resp.data.code;
          seed = resp.data.seed;
          amCreator = true;
          everJoined = true;
          phase = 'waiting';
          serverStatus = 'waiting';
          startAt = resp.data.startAt || 0;
          begunSeed = null;
          roomSeq++; // 新房间作废旧回调
          schedulePoll();
        } else {
          errorMsg = (resp && resp.message) || '建房失败';
        }
      })
      .catch(() => { errorMsg = '建房请求失败，请检查网络'; });
  }

  function joinRoom(inputCode) {
    if (!uid) return;
    const c = String(inputCode || '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) { errorMsg = '房码格式为 6 位字母或数字'; return; }
    const ts = Math.floor(Date.now() / 1000);
    const sig = signUidTs(uid, ts);
    errorMsg = null;
    withTimeout(requestFn('POST', cfg.ROOM_JOIN_PATH, { code: c, uid, name, ts, sig }), ROOM_TIMEOUT_RACE_MS)
      .then((resp) => {
        if (resp && resp.code === 0 && resp.data) {
          code = c;
          seed = resp.data.seed;
          serverStatus = resp.data.status || 'waiting';
          const players = resp.data.players || {};
          amCreator = Object.keys(players)[0] === String(uid);
          everJoined = true;
          begunSeed = null;
          if (serverStatus === 'playing') {
            phase = 'playing';
            startAt = resp.data.startAt || 0;
            scheduleBegin();
          } else {
            phase = 'waiting';
            startAt = resp.data.startAt || 0;
            schedulePoll();
          }
        } else if (resp && resp.code === 3) {
          errorMsg = '房间不存在或已过期';
        } else if (resp && resp.code === 4) {
          errorMsg = '房间已满';
        } else {
          errorMsg = (resp && resp.message) || '加入失败';
        }
      })
      .catch(() => { errorMsg = '加入请求失败，请检查网络'; });
  }

  // 再来一局（design-lock §3 Q5）：reset → waiting；随后自动重连重开（对手 polling 到此态同理）
  function requestRestart() {
    if (!code || !uid) return;
    const ts = Math.floor(Date.now() / 1000);
    const sig = signUidTs(uid, ts);
    withTimeout(requestFn('POST', cfg.ROOM_RESET_PATH, { code, uid, ts, sig }), ROOM_TIMEOUT_RACE_MS)
      .then((resp) => {
        if (resp && resp.code === 0) {
          phase = 'waiting';
          serverStatus = 'waiting';
          matchResult = 0;
          begunSeed = null;
          resultSent = false;
          stopPolling();
          rejoinToRestart(); // 自动重连触发重开
        } else if (resp && resp.code === 4) {
          // 对手已先 reset（status 已 waiting），我直接重连重开
          rejoinToRestart();
        } else {
          errorMsg = (resp && resp.message) || '再来一局失败';
        }
      })
      .catch(() => { errorMsg = '再来一局请求失败'; });
  }

  // 重连 / 重开：POST join（reconnect）触发 playing（reset 后双方槽位仍在）
  function rejoinToRestart() {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signUidTs(uid, ts);
    withTimeout(requestFn('POST', cfg.ROOM_JOIN_PATH, { code, uid, name, ts, sig }), ROOM_TIMEOUT_RACE_MS)
      .then((resp) => {
        if (resp && resp.code === 0) {
          seed = (typeof resp.data.seed === 'number') ? resp.data.seed : seed;
          serverStatus = resp.data.status || serverStatus;
          if (serverStatus === 'playing' && phase !== 'playing') {
            phase = 'playing';
            startAt = resp.data.startAt || 0;
            scheduleBegin();
          }
          schedulePoll();
        } else {
          errorMsg = (resp && resp.message) || '重连失败';
        }
      })
      .catch(() => { errorMsg = '重连失败，请重试'; });
  }

  // 进度上报（§4 Q4：≥500ms 或每步取先到者；仅展示层，不回放棋局）
  function reportProgress(score, steps, over) {
    if (!active || phase !== 'playing' || !code) return;
    myScore = score; mySteps = steps;
    const now = Date.now();
    if (over) { sendProgress(score, steps, over); return; }     // 终局立即上报
    if (now - lastProgressAt < ROOM_PROGRESS_THROTTLE_MS) return; // 节流
    sendProgress(score, steps, over);
  }
  function sendProgress(score, steps, over) {
    lastProgressAt = Date.now();
    const ts = Math.floor(Date.now() / 1000);
    const sig = signScore(uid, score, steps, ts);
    const req = requestFn('POST', cfg.ROOM_PROGRESS_PATH, { code, uid, score, steps, over, ts, sig });
    withTimeout(req, ROOM_TIMEOUT_RACE_MS).catch(() => {}); // 失败静默，本地不阻塞
  }

  // 提交终局结果（§4.5）：满格(over) won=false；先到 2048 won=true。由轮询 matchResult 驱动结算卡。
  function submitMyResult(score, steps, won) {
    if (!active || !code || resultSent) return;
    resultSent = true;
    const ts = Math.floor(Date.now() / 1000);
    const sig = signScore(uid, score, steps, ts);
    const req = requestFn('POST', cfg.ROOM_RESULT_PATH, { code, uid, score, steps, won, ts, sig });
    withTimeout(req, ROOM_TIMEOUT_RACE_MS).catch(() => {});
  }

  // ---------- 触摸（UI 按钮命中；棋盘滑动由 game.js 处理） ----------
  function handleTouch(sx, sy, t) {
    if (!active || !lastL) return false;
    const L = lastL;
    if (phase === 'hall') {
      if (hit(hallBackRect(L), t)) { exit(); return true; }
      if (hit(hallCreateRect(L), t)) { createRoom(); return true; }
      if (hit(hallJoinRect(L), t)) { phase = 'joinEntry'; joinInput = ''; return true; }
      return false;
    }
    if (phase === 'joinEntry') {
      if (hit(joinBackRect(L), t)) { phase = 'hall'; return true; }
      if (hit(joinBackspaceRect(L), t)) { joinInput = joinInput.slice(0, -1); return true; }
      if (joinInput.length === 6 && hit(joinConfirmRect(L), t)) { joinRoom(joinInput); return true; }
      const keys = joinKeyRects(L);
      for (const k of keys) {
        if (hit(k, t)) {
          if (joinInput.length < 6) joinInput += k.ch;
          return true;
        }
      }
      return false;
    }
    if (phase === 'waiting') {
      if (hit(waitingBackRect(L), t)) { exit(); return true; }
      return false;
    }
    if (phase === 'result') {
      if (hit(resultAgainRect(L), t)) { requestRestart(); return true; }
      if (hit(resultBackRect2(L), t)) { exit(); return true; }
      return false;
    }
    // playing 期无 UI 按钮（滑动交给 game.js），不消费
    return false;
  }

  // ---------- 渲染（game.js 在 draw() 末尾调用，screen==='room' 时） ----------
  function render(ctx, L) {
    if (!active) return;
    lastL = L;
    if (phase === 'playing') { drawHUD(ctx, L); return; } // 对战期仅画 HUD，棋盘由 game.js 画
    // hall / joinEntry / waiting / result：全屏覆盖
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, L.W, L.H);
    if (phase === 'hall') drawHall(ctx, L);
    else if (phase === 'joinEntry') drawJoinEntry(ctx, L);
    else if (phase === 'waiting') drawWaiting(ctx, L);
    else if (phase === 'result') drawResult(ctx, L);
  }

  // ================= Canvas UI（单一数据源：rect 同时供绘制与命中判定） =================
  function panelRect(L) { return { x: L.PAD, y: 56, w: L.W - L.PAD * 2, h: L.H - 56 - 24 }; }

  function hallBackRect(L) { const p = panelRect(L); return { x: p.x + 10, y: p.y + 10, w: 28, h: 28 }; }
  function hallCreateRect(L) { const p = panelRect(L); return { x: p.x + 16, y: p.y + p.h - 120, w: (p.w - 16 * 3) / 2, h: 44 }; }
  function hallJoinRect(L) { const p = panelRect(L); return { x: p.x + 16 * 2 + (p.w - 16 * 3) / 2, y: p.y + p.h - 120, w: (p.w - 16 * 3) / 2, h: 44 }; }

  function joinBackRect(L) { const p = panelRect(L); return { x: p.x + 10, y: p.y + 10, w: 28, h: 28 }; }
  function joinKeyRects(L) {
    const p = panelRect(L);
    const cols = 6, rows = 6, pad = 8;
    const areaX = p.x + 16;
    const areaY = p.y + 100;
    const areaW = p.w - 32;
    const kw = (areaW - pad * (cols - 1)) / cols;
    const kh = 36;
    const rects = [];
    for (let i = 0; i < 36; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      rects.push({ ch: ROOM_CODE_CHARS[i], x: areaX + c * (kw + pad), y: areaY + r * (kh + pad), w: kw, h: kh });
    }
    return rects;
  }
  function joinBackspaceRect(L) {
    const p = panelRect(L); const ks = joinKeyRects(L); const last = ks[ks.length - 1];
    return { x: p.x + 16, y: last.y + last.h + 10, w: (p.w - 32) * 0.5 - 4, h: 40 };
  }
  function joinConfirmRect(L) {
    const p = panelRect(L); const ks = joinKeyRects(L); const last = ks[ks.length - 1];
    return { x: p.x + 16 + (p.w - 32) * 0.5 + 4, y: last.y + last.h + 10, w: (p.w - 32) * 0.5 - 4, h: 40 };
  }

  function waitingBackRect(L) { const p = panelRect(L); return { x: p.x + 10, y: p.y + 10, w: 28, h: 28 }; }
  function resultBackRect(L) { const p = panelRect(L); return { x: p.x + 10, y: p.y + 10, w: 28, h: 28 }; }
  function resultAgainRect(L) { const p = panelRect(L); return { x: p.x + 16, y: p.y + p.h - 120, w: (p.w - 16 * 3) / 2, h: 44 }; }
  function resultBackRect2(L) { const p = panelRect(L); return { x: p.x + 16 * 2 + (p.w - 16 * 3) / 2, y: p.y + p.h - 120, w: (p.w - 16 * 3) / 2, h: 44 }; }

  function drawPanel(ctx, L) {
    const p = panelRect(L);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6;
    ctx.fillStyle = PANEL; roundRect(ctx, p.x, p.y, p.w, p.h, 16); ctx.fill();
    ctx.restore();
    return p;
  }
  function drawCloseX(ctx, r) {
    ctx.strokeStyle = '#bbada0'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r.x + 8, r.y + 8); ctx.lineTo(r.x + r.w - 8, r.y + r.h - 8);
    ctx.moveTo(r.x + r.w - 8, r.y + 8); ctx.lineTo(r.x + 8, r.y + r.h - 8);
    ctx.stroke();
  }

  function drawHall(ctx, L) {
    const p = drawPanel(ctx, L);
    drawCloseX(ctx, hallBackRect(L));
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('好友对战 · 房间', L.W / 2, p.y + 30);
    ctx.fillStyle = BTN; ctx.font = '12px sans-serif';
    ctx.fillText('系统返回键 / × 退出', L.W / 2, p.y + 48);
    ctx.fillStyle = INK; ctx.font = '14px sans-serif';
    ctx.fillText('创建房间分享房码，或输入房码加入', L.W / 2, p.y + 86);
    if (errorMsg) { ctx.fillStyle = '#c0392b'; ctx.font = '14px sans-serif'; ctx.fillText(errorMsg, L.W / 2, p.y + 112); }
    const cb = hallCreateRect(L);
    ctx.fillStyle = GOLD; roundRect(ctx, cb.x, cb.y, cb.w, cb.h, cb.h / 2); ctx.fill();
    ctx.fillStyle = BROWN; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('创建房间', cb.x + cb.w / 2, cb.y + cb.h / 2);
    const jb = hallJoinRect(L);
    ctx.fillStyle = BTN; roundRect(ctx, jb.x, jb.y, jb.w, jb.h, jb.h / 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText('加入房间', jb.x + jb.w / 2, jb.y + jb.h / 2);
  }

  function drawJoinEntry(ctx, L) {
    const p = drawPanel(ctx, L);
    drawCloseX(ctx, joinBackRect(L));
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('输入房码加入', L.W / 2, p.y + 26);
    // 已输入房码（6 格）
    const dispY = p.y + 52; const cellW = (p.w - 32) / 6;
    for (let i = 0; i < 6; i++) {
      const x = p.x + 16 + i * cellW;
      ctx.fillStyle = '#cdc1b4'; roundRect(ctx, x, dispY, cellW - 6, 40, 8); ctx.fill();
      const ch = joinInput[i] || '';
      ctx.fillStyle = ch ? BROWN : '#bbada0'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ch, x + (cellW - 6) / 2, dispY + 20);
    }
    // 键盘 6×6
    const keys = joinKeyRects(L);
    for (const k of keys) {
      ctx.fillStyle = '#eee4da'; roundRect(ctx, k.x, k.y, k.w, k.h, 8); ctx.fill();
      ctx.fillStyle = BROWN; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(k.ch, k.x + k.w / 2, k.y + k.h / 2);
    }
    // 退格 + 加入
    const bs = joinBackspaceRect(L);
    ctx.fillStyle = BTN; roundRect(ctx, bs.x, bs.y, bs.w, bs.h, bs.h / 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⌫', bs.x + bs.w / 2, bs.y + bs.h / 2);
    const jb = joinConfirmRect(L);
    ctx.fillStyle = joinInput.length === 6 ? GOLD : '#cdc1b4';
    roundRect(ctx, jb.x, jb.y, jb.w, jb.h, jb.h / 2); ctx.fill();
    ctx.fillStyle = joinInput.length === 6 ? BROWN : '#fff';
    ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('加入', jb.x + jb.w / 2, jb.y + jb.h / 2);
    if (errorMsg) { ctx.fillStyle = '#c0392b'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(errorMsg, L.W / 2, jb.y + jb.h + 16); }
  }

  function drawWaiting(ctx, L) {
    const p = drawPanel(ctx, L);
    drawCloseX(ctx, waitingBackRect(L));
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('房间已创建', L.W / 2, p.y + 30);
    ctx.fillStyle = BTN; ctx.font = '12px sans-serif';
    ctx.fillText('系统返回键 / × 退出', L.W / 2, p.y + 48);
    ctx.fillStyle = BROWN; ctx.font = 'bold 40px sans-serif';
    ctx.fillText(code, L.W / 2, p.y + 108);
    ctx.fillStyle = INK; ctx.font = '14px sans-serif';
    ctx.fillText('把房码分享给好友，等待对手加入…', L.W / 2, p.y + 148);
    if (errorMsg) { ctx.fillStyle = '#c0392b'; ctx.font = '14px sans-serif'; ctx.fillText(errorMsg, L.W / 2, p.y + 178); }
  }

  function drawHUD(ctx, L) {
    // 右上：对手信息（§7 Q7：仅分数 + 步数小字，不渲染缩略棋盘）
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = INK; ctx.font = 'bold 13px sans-serif';
    const oppLabel = amCreator ? '对手: P2' : '对手: P1';
    ctx.fillText(oppLabel + '  ' + oppScore + ' · ' + oppSteps + '步', L.W - 12, 30);
    // 顶部中间：比分条
    const bw = L.W - 24, bx = 12, by = 44;
    ctx.fillStyle = '#bbada0'; roundRect(ctx, bx, by, bw, 6, 3); ctx.fill();
    const total = Math.max(1, myScore + oppScore);
    const myW = bw * (myScore / total);
    ctx.fillStyle = GOLD; roundRect(ctx, bx, by, myW, 6, 3); ctx.fill();
    ctx.fillStyle = INK; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('比分  ' + myScore + ' vs ' + oppScore, L.W / 2, by + 22);
    // 底部：我方信息 + 同步状态（失败 failCount>0 显示「同步中…」）
    ctx.fillStyle = BTN; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const sync = (failCount > 0) ? '同步中…' : '对战中';
    const endHint = (state && state.over) ? '  已终局，等待结算…' : '';
    ctx.fillText('我: ' + myScore + ' · ' + mySteps + '步   ' + sync + endHint, L.W / 2, L.H - 16);
  }

  function resultText() {
    const iWin = (matchResult === 1 && amCreator) || (matchResult === 2 && !amCreator) || matchResult === 4 || matchResult === 5;
    const iLose = (matchResult === 1 && !amCreator) || (matchResult === 2 && amCreator);
    if (matchResult === 3) return { title: '平局', sub: '比分相同，势均力敌', color: '#8f7a66' };
    if (iWin) return { title: '你胜利！', sub: (matchResult >= 4 ? '对手已离开，你赢了' : '恭喜你赢了'), color: '#3a8a3a' };
    if (iLose) return { title: '惜败', sub: '再接再厉', color: '#c0392b' };
    return { title: '对战中', sub: '', color: INK };
  }

  function drawResult(ctx, L) {
    const p = drawPanel(ctx, L);
    drawCloseX(ctx, resultBackRect(L));
    const r = resultText();
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('对战结果', L.W / 2, p.y + 30);
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = r.color;
    ctx.fillText(r.title, L.W / 2, p.y + 78);
    ctx.fillStyle = INK; ctx.font = '16px sans-serif';
    ctx.fillText(r.sub, L.W / 2, p.y + 114);
    ctx.fillStyle = BROWN; ctx.font = 'bold 20px sans-serif';
    ctx.fillText('你 ' + myScore + '  ·  对手 ' + oppScore, L.W / 2, p.y + 152);
    const ab = resultAgainRect(L);
    ctx.fillStyle = GOLD; roundRect(ctx, ab.x, ab.y, ab.w, ab.h, ab.h / 2); ctx.fill();
    ctx.fillStyle = BROWN; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('再来一局', ab.x + ab.w / 2, ab.y + ab.h / 2);
    const rb = resultBackRect2(L);
    ctx.fillStyle = BTN; roundRect(ctx, rb.x, rb.y, rb.w, rb.h, rb.h / 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText('返回', rb.x + rb.w / 2, rb.y + rb.h / 2);
  }

  // drawHUD 中引用 state 用于「已终局」提示；game.js 注入当前棋盘
  let state = null;
  function setStateRef(s) { state = s; }

  return {
    open,
    exit,
    handleTouch,
    render,
    reportProgress,
    submitMyResult,
    createRoom,
    joinRoom,
    requestRestart,
    setStateRef,
    // 查询 / 注入
    isActive: () => active,
    getPhase: () => phase,
    getCode: () => code,
    getState: () => ({
      code, seed, status: serverStatus, matchResult, phase,
      oppScore, oppSteps, oppOver, myScore, mySteps,
      amCreator, errorMsg, joinInput, startAt,
    }),
    onBeginMatch: (fn) => { api.beginMatch = fn; },
    onExit: (fn) => { api.exit = fn; },
    // 测试辅助
    _setRequestFn: (fn) => { requestFn = fn; },
    _getRoomSeq: () => roomSeq,
    _computeBackoffMs: computeBackoffMs,
    _withTimeout: withTimeout,
  };
}

module.exports = {
  createRoomClient,
  withTimeout,
  computeBackoffMs,
};
