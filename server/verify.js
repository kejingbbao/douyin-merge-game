// server/verify.js
// 从 server/index.js 原样抽取的「请求签名校验」逻辑，供 /api/score、/api/rank、
// /api/ladder/* 等多个接口复用。行为与原内联实现逐字一致（secret 为空→开发跳过、
// 时间窗校验、HMAC-SHA256 + timingSafeEqual），不得改动。
const crypto = require('crypto');

const RANK_SECRET = process.env.RANK_SECRET || '';
const SIGN_TTL = parseInt(process.env.SIGN_TTL || '300', 10);

// 验签：secret 为空（开发模式）直接通过；否则校验签名 + 时间窗
function verifyPayload(payload, ts, sig) {
  if (!RANK_SECRET) return true;
  if (!sig || ts == null) return false;
  const t = parseInt(ts, 10);
  if (!Number.isFinite(t)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > SIGN_TTL) return false; // 过期 / 重放
  const expected = crypto.createHmac('sha256', RANK_SECRET).update(payload).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

module.exports = { verifyPayload, RANK_SECRET, SIGN_TTL };
