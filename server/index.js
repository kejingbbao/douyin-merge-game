// server/index.js
// 零依赖 Node HTTP 服务（Vercel / 任意云函数 / 本地均可跑）。
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
//   RANK_STORE          —— 'memory'(默认) | 'file' | 'upstash'
//   RANK_FILE           —— file 后端的 JSON 路径（可选）
//   UPSTASH_REDIS_REST_URL / _TOKEN —— upstash 后端凭据
//   RANK_MAX_SCORE      —— 单局分数上限（防极端伪造，默认 10,000,000）
//   SIGN_TTL            —— 签名有效期秒数（默认 300）
const http = require('http');
const { createStore } = require('./store.js');
const { verifyPayload } = require('./verify.js');
const { LadderService } = require('./ladder.js');

const RANK_SECRET = process.env.RANK_SECRET || '';
const SIGN_TTL = parseInt(process.env.SIGN_TTL || '300', 10);
const RANK_MAX_SCORE = parseInt(process.env.RANK_MAX_SCORE || '10000000', 10);
const store = createStore(process.env.RANK_STORE);

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

const server = http.createServer((req, res) => {
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
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { uid, name, score, ts, sig } = JSON.parse(body || '{}');
        if (!uid) return send(400, { ok: false, error: 'uid required' });
        const sc = Math.floor(Number(score) || 0);
        if (!Number.isFinite(sc) || sc < 0 || sc > RANK_MAX_SCORE) {
          return send(400, { ok: false, error: 'score out of range' });
        }
        if (!verifyPayload(uid + '|' + sc + '|' + ts, ts, sig)) {
          return send(403, { ok: false, error: 'invalid signature' });
        }
        await store.recordScore(uid, name, sc);
        send(200, { ok: true });
      } catch (e) { send(400, { ok: false, error: String(e && e.message || e) }); }
    });
    return;
  }

  // GET /api/rank
  if (req.method === 'GET' && req.url.startsWith('/api/rank')) {
    (async () => {
      const u = new URL(req.url, 'http://localhost');
      const uid = u.searchParams.get('uid') || '';
      const ts = u.searchParams.get('ts') || '';
      const sig = u.searchParams.get('sig') || '';
      const limit = parseInt(u.searchParams.get('limit') || '100', 10);
      if (!verifyPayload(uid + '|' + ts, ts, sig)) {
        return send(403, { ok: false, error: 'invalid signature' });
      }
      try {
        const view = await store.getRankView(uid, limit);
        return send(200, view);
      } catch (e) { return send(500, { ok: false, error: String(e && e.message || e) }); }
    })();
    return;
  }

  send(404, { ok: false, error: 'not found' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('[rank-server] listening on http://localhost:' + PORT + ' (store=' + (store._backend) + ')'));
}
module.exports = server;
