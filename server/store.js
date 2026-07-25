// server/store.js
// 排行榜 + 天梯存储（纯逻辑，可单测）。零新增 npm 依赖。
//
// ⚠️ 已支持「持久化」：按环境变量 RANK_STORE 选择后端：
//   - 'memory'  （默认）：进程内 Map，重启即清空，仅本地/测试用
//   - 'file'    ：JSON 文件落盘（自托管 VPS / 普通 Node 服务可直接持久化）
//   - 'upstash' ：Upstash Redis REST（serverless 如 Vercel / Cloudflare 推荐，零原生依赖）
//
// 排行榜接口（三个后端完全一致，便于切换、无需改 index.js / 前端）：
//   recordScore(uid, name, score)        —— 记录玩家最高分（同名 uid 只保留最高，异步）
//   getRankView(uid, limit)              —— 返回 { top, selfRank, selfName, selfScore }（异步）
//
// 天梯接口（Phase 1 异步匹配，三个后端一致）：
//   saveSnapshot(s)                      —— 写本人天梯快照 {uid,name,score,steps,boardSummary,ts,synthetic}
//   matchSnapshot(score, uid, band)      —— 按分数带宽取候选（排除本人、排除 24h 内已匹配 uid），返回一条或 null
//   pushHistory(uid, rec)                —— 写战绩 LPUSH + LTRIM 保留最近 50
//   getHistory(uid, limit)               —— 读历史，返回按 ts 倒序数组
//
// 接口：
//   recordScore(uid, name, score)  —— 记录某个玩家的最高分（同名 uid 只保留最高）
//   getRankView(uid, limit)        —— 返回 { top, selfRank, selfName, selfScore }
//   saveSnapshot / matchSnapshot / pushHistory / getHistory —— 天梯相关（见上）

const fs = require('fs');
const path = require('path');

// ---------- 通用层：把后端提供的「条目集合」包装成统一接口 ----------
// backend 需实现：
//   async getEntries()            -> [{ uid, name, score }]
//   async upsertMax(uid, name, s) -> 仅当 s 大于已有分时才写入
// 天梯需额外实现（memory/file/upstash 三后端一致）：
//   async ladderSaveSnapshot(s)
//   async ladderGetSnapshotsInRange(lo, hi) -> [snapshot]
//   async ladderSetLastOpp(uid, oppUid, ts)
//   async ladderGetLastOpp(uid) -> {uid, ts} | null
//   async ladderPushHistory(uid, rec)  (LPUSH + LTRIM 50)
//   async ladderGetHistory(uid, limit) -> [rec]  (newest first)
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

  // ---------- 天梯方法 ----------
  async function saveSnapshot(s) {
    if (!s || !s.uid) return false;
    await backend.ladderSaveSnapshot(s);
    return true;
  }

  // 在快照池按分数带宽匹配对手：排除本人、排除 24h 内已匹配的 uid，
  // 取分数最接近的一条；无候选返回 null（调用方应降级为合成对手）。
  async function matchSnapshot(score, uid, band) {
    const sc = Math.floor(Number(score) || 0);
    const b = Math.max(0, Math.floor(Number(band) || 0));
    const lo = Math.max(0, sc - b);
    const hi = sc + b;
    const last = await backend.ladderGetLastOpp(uid);
    const now = Math.floor(Date.now() / 1000);
    const exclude = new Set([String(uid)]);
    if (last && Number(last.ts) && (now - Number(last.ts)) < 24 * 3600) {
      exclude.add(String(last.uid));
    }
    const cands = (await backend.ladderGetSnapshotsInRange(lo, hi))
      .filter((s) => s && s.uid && !exclude.has(String(s.uid)));
    if (!cands.length) return null;
    cands.sort((a, b) => Math.abs(Number(a.score) - sc) - Math.abs(Number(b.score) - sc));
    const pick = cands[0];
    // 记录本次匹配对手，用于 24h 内去重
    await backend.ladderSetLastOpp(uid, pick.uid, now);
    return pick;
  }

  async function pushHistory(uid, rec) {
    if (!uid) return false;
    await backend.ladderPushHistory(String(uid), rec);
    return true;
  }

  async function getHistory(uid, limit) {
    return backend.ladderGetHistory(String(uid), limit || 50);
  }

  return {
    recordScore,
    getRankView,
    saveSnapshot,
    matchSnapshot,
    pushHistory,
    getHistory,
    _dump: () => backend.getEntries(),
    _backend: backend.type,
  };
}

// ---------- 内存后端 ----------
function createMemoryStore() {
  const players = new Map(); // uid -> { name, score }
  // 天梯状态（进程内）
  const ladderSnaps = new Map();   // member(uid:ts) -> snapshot
  const ladderLastOpp = new Map(); // uid -> { uid, ts }
  const ladderHist = new Map();    // uid -> [rec,...] (newest first, ≤50)

  function normalizeSnap(s) {
    return {
      uid: String(s.uid),
      name: String(s.name || '玩家').slice(0, 16),
      score: Math.floor(Number(s.score) || 0),
      steps: Math.floor(Number(s.steps) || 0),
      boardSummary: s.boardSummary == null ? null : s.boardSummary,
      ts: Number(s.ts),
      synthetic: !!s.synthetic,
    };
  }

  return makeStore({
    type: 'memory',
    async getEntries() {
      return Array.from(players.entries()).map(([uid, v]) => ({ uid, name: v.name, score: v.score }));
    },
    async upsertMax(uid, name, s) {
      const cur = players.get(uid);
      if (!cur || s > cur.score) players.set(uid, { name, score: s });
    },
    // 天梯
    async ladderSaveSnapshot(s) {
      const n = normalizeSnap(s);
      ladderSnaps.set(String(n.uid) + ':' + n.ts, n);
    },
    async ladderGetSnapshotsInRange(lo, hi) {
      const out = [];
      for (const s of ladderSnaps.values()) {
        if (s.score >= lo && s.score <= hi) out.push(s);
      }
      return out;
    },
    async ladderSetLastOpp(uid, oppUid, ts) {
      ladderLastOpp.set(String(uid), { uid: String(oppUid), ts: Number(ts) });
    },
    async ladderGetLastOpp(uid) {
      return ladderLastOpp.get(String(uid)) || null;
    },
    async ladderPushHistory(uid, rec) {
      const arr = ladderHist.get(String(uid)) || [];
      arr.unshift(rec);
      if (arr.length > 50) arr.length = 50; // 仅保留最近 50
      ladderHist.set(String(uid), arr);
    },
    async ladderGetHistory(uid, limit) {
      const arr = ladderHist.get(String(uid)) || [];
      return arr.slice(0, Math.max(1, limit || 50));
    },
  });
}

// ---------- 文件后端（JSON 落盘） ----------
function createFileStore(file) {
  const fp = file || process.env.RANK_FILE || path.join(__dirname, 'rank-data.json');
  const ladderFp = path.join(path.dirname(fp), 'ladder-data.json');
  let players = new Map();
  // 天梯状态
  const ladderSnaps = new Map();
  const ladderLastOpp = new Map();
  const ladderHist = new Map();

  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const it of arr) players.set(it.uid, { name: it.name, score: it.score });
    }
  } catch (e) { /* 文件不存在或损坏则从头开始 */ }

  // 载入天梯数据（best-effort）
  try {
    const rawL = fs.readFileSync(ladderFp, 'utf8');
    const o = JSON.parse(rawL) || {};
    if (o.snaps) for (const [k, v] of Object.entries(o.snaps)) ladderSnaps.set(k, v);
    if (o.lastOpp) for (const [k, v] of Object.entries(o.lastOpp)) ladderLastOpp.set(k, v);
    if (o.hist) for (const [k, v] of Object.entries(o.hist)) ladderHist.set(k, v);
  } catch (e) { /* 忽略加载失败 */ }

  function persist() {
    const arr = Array.from(players.entries()).map(([uid, v]) => ({ uid, name: v.name, score: v.score }));
    try { fs.writeFileSync(fp, JSON.stringify(arr, null, 0)); } catch (e) { /* 忽略写失败 */ }
  }

  function persistLadder() {
    try {
      const o = {
        snaps: Object.fromEntries(ladderSnaps),
        lastOpp: Object.fromEntries(ladderLastOpp),
        hist: Object.fromEntries(ladderHist),
      };
      fs.writeFileSync(ladderFp, JSON.stringify(o, null, 0));
    } catch (e) { /* 忽略写失败（best-effort） */ }
  }

  function normalizeSnap(s) {
    return {
      uid: String(s.uid),
      name: String(s.name || '玩家').slice(0, 16),
      score: Math.floor(Number(s.score) || 0),
      steps: Math.floor(Number(s.steps) || 0),
      boardSummary: s.boardSummary == null ? null : s.boardSummary,
      ts: Number(s.ts),
      synthetic: !!s.synthetic,
    };
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
    // 天梯
    async ladderSaveSnapshot(s) {
      const n = normalizeSnap(s);
      ladderSnaps.set(String(n.uid) + ':' + n.ts, n);
      persistLadder();
    },
    async ladderGetSnapshotsInRange(lo, hi) {
      const out = [];
      for (const s of ladderSnaps.values()) {
        if (s.score >= lo && s.score <= hi) out.push(s);
      }
      return out;
    },
    async ladderSetLastOpp(uid, oppUid, ts) {
      ladderLastOpp.set(String(uid), { uid: String(oppUid), ts: Number(ts) });
      persistLadder();
    },
    async ladderGetLastOpp(uid) {
      return ladderLastOpp.get(String(uid)) || null;
    },
    async ladderPushHistory(uid, rec) {
      const arr = ladderHist.get(String(uid)) || [];
      arr.unshift(rec);
      if (arr.length > 50) arr.length = 50;
      ladderHist.set(String(uid), arr);
      persistLadder();
    },
    async ladderGetHistory(uid, limit) {
      const arr = ladderHist.get(String(uid)) || [];
      return arr.slice(0, Math.max(1, limit || 50));
    },
  });
}

// ---------- Upstash Redis 后端（serverless） ----------
// 排行榜数据模型：有序集合 board(uid=成员, score=分数) + 哈希 meta(uid=字段, name=值)
// 天梯数据模型：
//   ladder:snapshots            ZSET  score=分值, member=uid:ts
//   ladder:snap                 HASH  member(uid:ts) -> json 快照
//   ladder:history:<uid>        LIST  战绩（LPUSH + LTRIM 50）
//   ladder:lastopp:<uid>        HASH  {uid, ts}  最近对手（24h 去重）
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
    // 天梯
    async ladderSaveSnapshot(s) {
      const member = String(s.uid) + ':' + Number(s.ts);
      const snap = {
        uid: String(s.uid),
        name: String(s.name || '玩家').slice(0, 16),
        score: Math.floor(Number(s.score) || 0),
        steps: Math.floor(Number(s.steps) || 0),
        boardSummary: s.boardSummary == null ? null : s.boardSummary,
        ts: Number(s.ts),
        synthetic: !!s.synthetic,
      };
      await rcmd('ZADD', 'ladder:snapshots', String(snap.score), member);
      await rcmd('HSET', 'ladder:snap', member, JSON.stringify(snap));
    },
    async ladderGetSnapshotsInRange(lo, hi) {
      const members = (await rcmd('ZRANGEBYSCORE', 'ladder:snapshots', String(lo), String(hi))) || [];
      const all = flatToObj((await rcmd('HGETALL', 'ladder:snap')) || []);
      const out = [];
      for (const m of members) {
        if (all[m]) {
          try { out.push(JSON.parse(all[m])); } catch (e) { /* 忽略损坏项 */ }
        }
      }
      return out;
    },
    async ladderSetLastOpp(uid, oppUid, ts) {
      await rcmd('HSET', 'ladder:lastopp:' + String(uid), 'uid', String(oppUid), 'ts', String(ts));
    },
    async ladderGetLastOpp(uid) {
      const o = flatToObj((await rcmd('HGETALL', 'ladder:lastopp:' + String(uid))) || []);
      if (!o.uid) return null;
      return { uid: o.uid, ts: Number(o.ts) || 0 };
    },
    async ladderPushHistory(uid, rec) {
      await rcmd('LPUSH', 'ladder:history:' + String(uid), JSON.stringify(rec));
      await rcmd('LTRIM', 'ladder:history:' + String(uid), '0', '49'); // 保留最近 50
    },
    async ladderGetHistory(uid, limit) {
      const arr = (await rcmd('LRANGE', 'ladder:history:' + String(uid), '0', String(Math.max(0, (limit || 50) - 1)))) || [];
      return arr.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
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
