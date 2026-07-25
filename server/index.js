// server/index.js
// 零依赖 Node HTTP 服务（Vercel Serverless / 任意云函数 / 本地均可跑）。
//
// 兼容两种运行模式：
//   ① Vercel Serverless：导出默认函数，由 Vercel 运行时调用
//   ② 本地开发：node index.js 启动 HTTP 服务器（监听 PORT 或 3000）
//
// 接口：
//   POST /api/score            body: { uid, name, score, ts, sig }
//                               -> 校验 HMAC 签名 + 时间戳 + 分数范围，记录最高分
//   GET  /api/rank?uid=xxx&limit=100&ts=xxx&sig=xxx
//                               -> 校验签名后返回榜单视图
//   POST /api/ladder/match     body: { uid, name, score, steps, boardSummary, ts, sig }
//                               -> 异步天梯匹配（Phase 1）：写快照、匹配对手、比拼、写历史、返回结算
//   GET  /api/ladder/history?uid=&limit=&ts=&sig=
//                               -> 校验签名后返回本人天梯战绩
//
// 环境变量：
//   RANK_SECRET         —— 签名密钥（前后端一致）。未设置则「开发模式」跳过验签（仅本地测试用）
//   STORAGE             —— 'memory'(默认) | 'file' | 'upstash'
//   UPSTASH_REDIS_REST_URL / _TOKEN —— upstash 后端凭据
//   RANK_MAX_SCORE      —— 单局分数上限（防极端伪造，默认 10,000,000）
//   SIGN_TTL            —— 签名有效期秒数（默认 300）

const http = require('http');
const { createStore } = require('./store.js');
const { verifyPayload } = require('./verify.js');
const { LadderService } = require('./ladder.js');
const { makeRoomService } = require('./room.js');

const RANK_SECRET = process.env.RANK_SECRET || '';
const SIGN_TTL = parseInt(process.env.SIGN_TTL || '300', 10);
const RANK_MAX_SCORE = parseInt(process.env.RANK_MAX_SCORE || '10000000', 10);
const store = createStore(process.env.STORAGE || process.env.RANK_STORE);

if (!RANK_SECRET) {
  console.warn('[rank-server] ⚠️ 未设置 RANK_SECRET：签名校验已关闭（仅限本地测试）。上线前务必设置随机密钥！');
}

// 统一 JSON 发送（含 CORS，沿用现有约定）
function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

// 天梯服务（复用全局 store 与 verify）
const ladder = new LadderService(store, { verifyPayload, maxScore: RANK_MAX_SCORE, send: sendJson });

// 房间对战服务（Phase 2，复用同一 store 实例与 RANK_SECRET）
const roomService = makeRoomService(store, RANK_SECRET);

// ---------- 核心路由处理函数（Vercel + 本地共用） ----------
function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const send = (code, obj) => sendJson(res, code, obj);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---------- 天梯路由（Phase 1） ----------
  // POST /api/ladder/match
  if (req.method === 'POST' && req.url.startsWith('/api/ladder/match')) {
    return ladder.match(req, res);
  }
  // GET /api/ladder/history
  if (req.method === 'GET' && req.url.startsWith('/api/ladder/history')) {
    return ladder.getHistory(req, res);
  }

  // ---------- 旧接口（行为不变） ----------
  // POST /api/score
  if (req.method === 'POST' && req.url.startsWith('/api/score')) {
    // Vercel Serverless 已预解析 body 为对象；本地模式需要手动拼接
    const rawBody = typeof req.body === 'string' ? req.body :
                     (typeof req.body === 'object' ? JSON.stringify(req.body) : '');
    let body = rawBody;
    if (!body && !req.bodyUsed) {
      // 本地模式：手动读取流
      return new Promise((resolve) => {
        let buf = '';
        req.on('data', (c) => (buf += c));
        req.on('end', () => {
          handleScorePost(buf, send, resolve);
        });
      });
    }
    return handleScorePost(body, send, () => {});
  }

  // GET /api/rank
  if (req.method === 'GET' && req.url.startsWith('/api/rank')) {
    return (async () => {
      const u = new URL(req.url, 'http://localhost');
      const uid = u.searchParams.get('uid') || '';
      const ts = u.searchParams.get('ts') || '';
      const sig = u.searchParams.get('sig') || '';
      const limit = parseInt(u.searchParams.get('limit') || '100', 10);
      if (!verifyPayload(uid + '|' + ts, ts, sig)) {
        return send(403, { code: 403, message: 'invalid signature' });
      }
      try {
        const view = await store.getRankView(uid, limit);
        return send(200, { code: 0, data: view });
      } catch (e) {
        // upstash 不可达 / 出错：降级返回默认视图，绝不让前端卡死（前端会显示「排名暂不可用」）。
        // 注意：store.getRankView 仍按契约在 upstash 错误时抛错（store-upstash.test 已覆盖），
        // 此处仅在 HTTP 信封层兜底，保证 /api/rank 永远返回 200 + 结构化默认数据。
        return send(200, { code: 0, data: { top: [], selfRank: 0, selfName: '', selfScore: 0 } });
      }
    })();
  }

  // ---------- 房间对战路由（Phase 2） ----------
  const roomMatch = req.url.match(/^\/api\/room\/([a-z]+)/);
  if (roomMatch && ROOM_ROUTES[roomMatch[1]] && req.method === ROOM_ROUTES[roomMatch[1]].method) {
    return handleRoomRoute(roomMatch[1], req, res, send);
  }

  send(404, { code: 404, message: 'not found' });
}

// 提取 POST /api/score 处理逻辑（复用于 Vercel 和本地模式）
function handleScorePost(body, send, done) {
  try {
    const { uid, name, score, ts, sig } = JSON.parse(body || '{}');
    if (!uid) return send(400, { code: 400, message: 'uid required' });
    const sc = Math.floor(Number(score) || 0);
    if (!Number.isFinite(sc) || sc < 0 || sc > RANK_MAX_SCORE) {
      return send(400, { code: 400, message: 'score out of range' });
    }
    if (!verifyPayload(uid + '|' + sc + '|' + ts, ts, sig)) {
      return send(403, { code: 403, message: 'invalid signature' });
    }
    store.recordScore(uid, name, sc).then(() => {
      send(200, { code: 0, data: { ok: true } });
      done();
    }).catch((e) => {
      send(500, { code: 500, message: String(e && e.message || e) });
      done();
    });
  } catch (e) {
    send(400, { code: 400, message: String(e && e.message || e) });
    done();
  }
}

// ---------- 房间对战路由辅助（Phase 2） ----------
// 从请求体读取完整 JSON（兼容 Vercel 预解析 req.body 与本地流式）
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined) {
      const b = typeof req.body === 'string' ? req.body : (req.body ? JSON.stringify(req.body) : '');
      return resolve(b);
    }
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

// 房间路由表：method=HTTP 方法，svc=RoomService 方法名，
// sig=验签 canonical 拼接，args=提取传入 RoomService 的参数。
// canonical 严格对齐 design-lock §4（create/join/state/leave → uid|ts；progress/result → uid|score|steps|ts）。
const ROOM_ROUTES = {
  create:   { method: 'POST', svc: 'create',        sig: (b) => String(b.uid) + '|' + b.ts,                                  args: (b) => ({ uid: b.uid, name: b.name }) },
  join:     { method: 'POST', svc: 'join',          sig: (b) => String(b.uid) + '|' + b.ts,                                  args: (b) => ({ code: b.code, uid: b.uid, name: b.name }) },
  progress: { method: 'POST', svc: 'progress',      sig: (b) => String(b.uid) + '|' + b.score + '|' + b.steps + '|' + b.ts, args: (b) => ({ code: b.code, uid: b.uid, score: b.score, steps: b.steps, over: b.over }) },
  state:    { method: 'GET',  svc: 'getState',      sig: (q) => String(q.uid) + '|' + q.ts,                                  args: (q) => ({ code: q.code, uid: q.uid }) },
  result:   { method: 'POST', svc: 'submitResult',  sig: (b) => String(b.uid) + '|' + b.score + '|' + b.steps + '|' + b.ts, args: (b) => ({ code: b.code, uid: b.uid, score: b.score, steps: b.steps, won: b.won }) },
  leave:    { method: 'POST', svc: 'leave',         sig: (q) => String(q.uid) + '|' + q.ts,                                  args: (q) => ({ code: q.code, uid: q.uid }) },
  // 再来一局（design-lock §3 Q5）：终局后由先点击方触发 status→waiting；对手轮询到 waiting 后重连重开
  reset:    { method: 'POST', svc: 'reset',         sig: (b) => String(b.uid) + '|' + b.ts,                                  args: (b) => ({ code: b.code, uid: b.uid }) },
};

async function handleRoomRoute(name, req, res, send) {
  const cfg = ROOM_ROUTES[name];
  let params;
  if (cfg.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    params = {
      code: u.searchParams.get('code'),
      uid: u.searchParams.get('uid'),
      ts: u.searchParams.get('ts'),
      sig: u.searchParams.get('sig'),
    };
  } else {
    const raw = await readBody(req);
    try { params = JSON.parse(raw || '{}'); } catch (e) {
      return send(200, { code: 4, data: null, message: '请求体格式错误' });
    }
  }
  // 验签（secret 为空→开发模式跳过；对齐 verifyPayload）
  if (!verifyPayload(cfg.sig(params), params.ts, params.sig)) {
    return send(200, { code: 2, data: null, message: '签名失效' });
  }
  try {
    const result = await roomService[cfg.svc](cfg.args(params));
    return send(200, result);
  } catch (e) {
    return send(200, { code: 5, data: null, message: '服务端错误：' + (e && e.message || e) });
  }
}

// ---------- 导出：Vercel Serverless 模式 ----------
// Vercel 运行时直接调用此函数（不需要 http.createServer）
module.exports = handleRequest;
// 同时支持 module.exports.default（部分 Vercel 版本偏好）
module.exports.default = handleRequest;

// ---------- 本地开发模式：启动 HTTP 服务器 ----------
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => console.log('[rank-server] listening on http://localhost:' + PORT + ' (store=' + (store._backend) + ')'));
}
