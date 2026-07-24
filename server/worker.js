// server/worker.js —— Cloudflare Workers 入口（fetch 风格）
// 部署：wrangler publish（在 wrangler.toml 里把 main 指向本文件）
const { recordScore, getRankView } = require('./store.js');

function json(body, code) {
  return new Response(JSON.stringify(body), {
    status: code || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function handle(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  if (req.method === 'POST' && url.pathname === '/api/score') {
    const { uid, name, score } = await req.json().catch(() => ({}));
    if (!uid) return json({ ok: false, error: 'uid required' }, 400);
    recordScore(uid, name, score);
    return json({ ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/rank') {
    const uid = url.searchParams.get('uid') || '';
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    return json(getRankView(uid, limit));
  }
  return json({ ok: false, error: 'not found' }, 404);
}

module.exports = { fetch: handle };
