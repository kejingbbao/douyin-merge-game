// server/store.js
// 排行榜存储（纯逻辑，可单测）。
//
// ⚠️ 已支持「持久化」：按环境变量 RANK_STORE 选择后端：
//   - 'memory'  （默认）：进程内 Map，重启即清空，仅本地/测试用
//   - 'file'    ：JSON 文件落盘（自托管 VPS / 普通 Node 服务可直接持久化）
//   - 'upstash' ：Upstash Redis REST（serverless 如 Vercel / Cloudflare 推荐，零原生依赖）
//
// 对外接口（三个后端完全一致，便于切换、无需改 index.js / 前端）：
//   recordScore(uid, name, score)        —— 记录玩家最高分（同名 uid 只保留最高，异步）
//   getRankView(uid, limit)              —— 返回 { top, selfRank, selfName, selfScore }（异步）
//   _dump()                              —— 返回全部条目（测试用）
//   _backend                            —— 后端类型字符串
//
// 接口：
//   recordScore(uid, name, score)  —— 记录某个玩家的最高分（同名 uid 只保留最高）
//   getRankView(uid, limit)        —— 返回 { top, selfRank, selfName, selfScore }

const fs = require('fs');
const path = require('path');

// ---------- 通用层：把后端提供的「条目集合」包装成统一接口 ----------
// backend 需实现：
//   async getEntries()            -> [{ uid, name, score }]
//   async upsertMax(uid, name, s) -> 仅当 s 大于已有分时才写入
function makeStore(backend) {
  async function recordScore(uid, name, score) {
    if (!uid) return false;
    const sc = Math.max(0, Math.floor(Number(score) || 0));
    await backend.upsertMax(String(uid), String(name || '玩家').slice(0, 16), sc);
    return true;
  }

  async function getRankView(uid, limit) {
    limit = limit || 100;
    const all = (await backend.getEntries()).map((p) => ({
      uid: p.uid, name: p.name, score: p.score,
    }));
    // 分数降序；同分按 uid 字典序（稳定、确定）
    all.sort((a, b) => b.score - a.score || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    const ranked = all.map((p, i) => ({
      uid: p.uid, name: p.name, score: p.score, rank: i + 1, isSelf: p.uid === uid,
    }));
    const top = ranked.slice(0, limit).map((x) => ({
      rank: x.rank, name: x.name, score: x.score, isSelf: x.isSelf,
    }));
    let selfRank = ranked.length;
    let selfScore = 0;
    let selfName = '';
    const me = ranked.find((x) => x.uid === uid);
    if (me) { selfRank = me.rank; selfScore = me.score; selfName = me.name; }
    return { top, selfRank, selfName, selfScore };
  }

  return { recordScore, getRankView, _dump: () => backend.getEntries(), _backend: backend.type };
}

// ---------- 内存后端 ----------
function createMemoryStore() {
  const players = new Map(); // uid -> { name, score }
  return makeStore({
    type: 'memory',
    async getEntries() {
      return Array.from(players.entries()).map(([uid, v]) => ({ uid, name: v.name, score: v.score }));
    },
    async upsertMax(uid, name, s) {
      const cur = players.get(uid);
      if (!cur || s > cur.score) players.set(uid, { name, score: s });
    },
  });
}

// ---------- 文件后端（JSON 落盘） ----------
function createFileStore(file) {
  const fp = file || process.env.RANK_FILE || path.join(__dirname, 'rank-data.json');
  let players = new Map();
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const it of arr) players.set(it.uid, { name: it.name, score: it.score });
    }
  } catch (e) { /* 文件不存在或损坏则从头开始 */ }

  function persist() {
    const arr = Array.from(players.entries()).map(([uid, v]) => ({ uid, name: v.name, score: v.score }));
    try { fs.writeFileSync(fp, JSON.stringify(arr, null, 0)); } catch (e) { /* 忽略写失败 */ }
  }

  return makeStore({
    type: 'file',
    async getEntries() {
      return Array.from(players.entries()).map(([uid, v]) => ({ uid, name: v.name, score: v.score }));
    },
    async upsertMax(uid, name, s) {
      const cur = players.get(uid);
      if (!cur || s > cur.score) { players.set(uid, { name, score: s }); persist(); }
    },
  });
}

// ---------- Upstash Redis 后端（serverless） ----------
// 数据模型：有序集合 board(uid=成员, score=分数) + 哈希 meta(uid=字段, name=值)
function createUpstashStore() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) throw new Error('使用 upstash 存储需设置 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN');
  const BOARD = 'rank:board';
  const META = 'rank:meta';

  async function rcmd(...args) {
    const p = args.map((a) => encodeURIComponent(String(a))).join('/');
    const res = await fetch(url + '/' + p, { headers: { Authorization: 'Bearer ' + token } });
    const json = await res.json();
    if (json.error) throw new Error('upstash: ' + json.error);
    return json.result;
  }

  function flatToObj(flat) {
    const o = {};
    for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
    return o;
  }

  return makeStore({
    type: 'upstash',
    async getEntries() {
      const flat = (await rcmd('ZREVRANGE', BOARD, 0, -1, 'WITHSCORES')) || [];
      const meta = flatToObj((await rcmd('HGETALL', META)) || []);
      const out = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const uid = flat[i];
        out.push({ uid, name: meta[uid] || '玩家', score: Number(flat[i + 1]) || 0 });
      }
      return out;
    },
    async upsertMax(uid, name, s) {
      await rcmd('ZADD', BOARD, 'GT', String(s), uid); // GT：仅当新分更高才更新
      await rcmd('HSET', META, uid, name);
    },
  });
}

// ---------- 工厂：按环境变量选择后端 ----------
function createStore(kind) {
  const k = (kind || process.env.RANK_STORE || 'memory').toLowerCase();
  if (k === 'file') return createFileStore();
  if (k === 'upstash') return createUpstashStore();
  return createMemoryStore();
}

module.exports = { createStore, createMemoryStore, createFileStore, createUpstashStore, makeStore };
