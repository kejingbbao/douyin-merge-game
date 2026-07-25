// server/room.js
// Phase 2 实时房间对战 —— RoomService（房间状态机 + 终局权威判定 + 再来一局）。
//
// 纯逻辑，零新增 npm 依赖；复用全局 store（memory / file / upstash 三后端）与 verifyPayload。
//
// 信封：{ code, data, message }
//   code: 0 成功 / 1 参数错 / 2 签名失效(由 index.js 判定) / 3 未找到 / 4 房间已满或频率 / 5 服务端错
// 存储键：room:<code>（整体 JSON，EXPIRE 600s，读后 roomTouch 续期）
//
// 服务端只负责「房间状态」与「终局权威判定」：
//   - seed 仅由服务端 create 生成并下发；RNG 在客户端跑（src/logic.js makeRng），服务端绝不跑 PRNG。
//   - 胜负规则（design-lock §3 Q1/Q2）：先到 2048 者胜 → 否则 180s 到点比分高者胜 → 平分平局。

'use strict';

// ---------- 锁定的服务端常量（design-lock §1.1） ----------
const ROOM_PLAYERS = 2;            // 房间固定 2 人
const ROOM_TTL_SECONDS = 600;      // Redis key EXPIRE（重连窗口）
const ROOM_CODE_LEN = 6;           // 房码长度（固定 6 位）
const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 仅大写字母 + 数字
const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/; // 加入时校验房码格式
const SYNC_BUFFER_MS = 3000;       // 第 2 人加入: startAt = Date.now() + 3000
const MATCH_DURATION_MS = 180000;  // 180s 到点判定边界 = startAt + 180000
const STALE_ABANDON_MS = 600000;   // 对手 lastSeen 超过此值(>TTL) → abandoned
const PROGRESS_THROTTLE_MS = 500;  // progress 节流下限（或每步取先到者，服务端不强制）
const SEED_MAX = 0x7FFFFFFF;       // makeSeed() 取值范围 [0, SEED_MAX]

// ---------- 终局权威判定（幂等，design-lock §4.7） ----------
// 返回 1(P1胜) / 2(P2胜) / 3(平局)。P1 = uids[0]（先加入者），P2 = uids[1]。
function computeMatch(room) {
  const uids = Object.keys(room.players || {});
  if (uids.length < 2) return 3; // 异常兜底（理论上不会进入）
  // 1) 先到 2048：任一方 won=true → 该方胜
  for (const u of uids) {
    if (room.results && room.results[u] && room.results[u].won) {
      return u === uids[0] ? 1 : 2;
    }
  }
  // 2) 到点：比最新分数（来自 players 的最新一手快照）
  const s0 = (room.players[uids[0]] && room.players[uids[0]].score) || 0;
  const s1 = (room.players[uids[1]] && room.players[uids[1]].score) || 0;
  if (s0 > s1) return 1;
  if (s1 > s0) return 2;
  return 3; // 平分
}

// 组装 getState 的 data 载荷（design-lock §4.4）
function buildStateData(room, uid, opp, matchResult) {
  const myP = room.players[String(uid)] || {};
  const oppP = opp ? room.players[opp] : {};
  return {
    status: room.status,
    startAt: room.startAt,
    seed: room.seed,
    matchResult: matchResult || 0,
    myScore: myP.score || 0,
    oppScore: oppP.score || 0,
    opponent: opp ? {
      score: oppP.score || 0,
      steps: oppP.steps || 0,
      over: !!oppP.over,
      updatedAt: oppP.updatedAt || 0,
    } : null,
  };
}

// ---------- RoomService 工厂 ----------
// @param {object} store  由 createStore 创建的全局存储实例（须含房间方法）
// @param {string} secret 签名密钥（RANK_SECRET）；验签在 index.js 完成，此处仅保留引用
function makeRoomService(store, secret) {
  // secret 预留：与 verifyPayload 共用 RANK_SECRET，验签由 index.js 负责

  // 生成 6 位房码：循环至 roomGet 为 null（34^6≈1.5e9 组合，memory 下极难碰撞）
  async function makeCode() {
    for (let i = 0; i < 50; i++) {
      let code = '';
      for (let j = 0; j < ROOM_CODE_LEN; j++) {
        code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
      }
      const exists = await store.roomGet(code);
      if (!exists) return code;
    }
    // 兜底：极偶然碰撞时追加一位，避免无限循环
    let code = '';
    for (let j = 0; j < ROOM_CODE_LEN; j++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    return code;
  }

  // 生成整数 seed ∈ [0, SEED_MAX]
  function makeSeed() {
    return Math.floor(Math.random() * (SEED_MAX + 1));
  }

  return {
    makeCode,
    makeSeed,
    computeMatch,

    // POST /api/room/create —— 建房（design-lock §4.1）
    async create({ uid, name }) {
      if (!uid) return { code: 1, data: null, message: '缺少 uid' };
      const code = await makeCode();
      const seed = makeSeed();
      const now = Date.now();
      const room = {
        code,
        seed,
        status: 'waiting',
        startAt: null,
        orphan: false,
        players: {
          [String(uid)]: {
            uid: String(uid),
            name: String(name || '玩家').slice(0, 16),
            ready: true,
            score: 0,
            steps: 0,
            over: false,
            updatedAt: now,
            left: false,
          },
        },
        results: {},
        matchResult: 0,
      };
      await store.roomSet(code, room);
      return {
        code: 0,
        data: { code, seed, status: 'waiting', startAt: null, ttl: ROOM_TTL_SECONDS },
        message: 'ok',
      };
    },

    // POST /api/room/join —— 加入 / 重连（design-lock §4.2）
    async join({ code, uid, name }) {
      if (!code || !uid) return { code: 1, data: null, message: '缺少 code 或 uid' };
      if (!ROOM_CODE_REGEX.test(String(code))) return { code: 1, data: null, message: '房码格式非法' };
      const room = await store.roomGet(code);
      if (!room) return { code: 3, data: null, message: '房间不存在或已过期' };
      const now = Date.now();
      const uidStr = String(uid);
      // 重连：已存在则刷新 updatedAt、清 left（不重复加人，AC-7）
      if (room.players[uidStr]) {
        room.players[uidStr].updatedAt = now;
        room.players[uidStr].left = false;
      } else {
        // 满员（且非终局后 reset 重开场景）
        if (Object.keys(room.players).length >= ROOM_PLAYERS) {
          return { code: 4, data: null, message: '房间已满' };
        }
        room.players[uidStr] = {
          uid: uidStr,
          name: String(name || '玩家').slice(0, 16),
          ready: true,
          score: 0,
          steps: 0,
          over: false,
          updatedAt: now,
          left: false,
        };
      }
      // 凑满 2 人 → 首局 playing；或终局后 reset 回到 waiting 且双方仍在 → 重开 playing
      // （design-lock §3 Q5：再来一局后任一方重连即重开，写新 startAt）
      if (room.status === 'waiting' && Object.keys(room.players).length >= ROOM_PLAYERS) {
        room.status = 'playing';
        room.startAt = now + SYNC_BUFFER_MS;
        room.orphan = false;
      }
      await store.roomSet(code, room);
      return {
        code: 0,
        data: { seed: room.seed, players: room.players, status: room.status, startAt: room.startAt },
        message: 'ok',
      };
    },

    // POST /api/room/progress —— 落子进度上报（design-lock §4.3）
    async progress({ code, uid, score, steps, over }) {
      if (!code || !uid) return { code: 1, data: null, message: '缺少 code 或 uid' };
      const room = await store.roomGet(code);
      if (!room) return { code: 3, data: null, message: '房间不存在或已过期' };
      if (room.status !== 'playing') return { code: 3, data: null, message: '当前不在对局中' };
      await store.roomProgress(code, uid, {
        score: Math.floor(Number(score) || 0),
        steps: Math.floor(Number(steps) || 0),
        over: !!over,
      });
      await store.roomTouch(code); // 续期 600s
      return { code: 0, data: { ok: true }, message: 'ok' };
    },

    // GET /api/room/state —— 轮询房间状态（含终局判定，design-lock §4.4）
    async getState({ code, uid }) {
      if (!code || !uid) return { code: 1, data: null, message: '缺少 code 或 uid' };
      const room = await store.roomGet(code);
      if (!room) return { code: 3, data: null, message: '房间不存在或已过期' };
      await store.roomTouch(code); // 续期 600s
      const now = Date.now();
      const uids = Object.keys(room.players);
      const opp = uids.length === 2 ? uids.find((u) => u !== String(uid)) : null;
      // 仅当仍为 playing 才做终局判定（left → stale → results齐 → timeout），幂等
      if (room.status === 'playing') {
        if (opp && room.players[opp] && room.players[opp].left === true) {
          room.matchResult = 4;        // 对手主动离开（我方胜）
          room.status = 'opponent_left';
        } else if (opp && room.players[opp] && (now - (room.players[opp].updatedAt || 0)) > STALE_ABANDON_MS) {
          room.matchResult = 5;        // 对手断线超 TTL（我方胜）
          room.status = 'abandoned';
        } else if (uids.length === 2 && room.results[uids[0]] && room.results[uids[1]]) {
          room.matchResult = computeMatch(room); // 双方结果齐
          room.status = 'finished';
        } else if (now >= (room.startAt || 0) + MATCH_DURATION_MS) {
          room.matchResult = computeMatch(room); // 180s 到点
          room.status = 'finished';
        }
        if (room.matchResult) await store.roomSet(code, room);
      }
      return { code: 0, data: buildStateData(room, String(uid), opp, room.matchResult), message: 'ok' };
    },

    // POST /api/room/result —— 提交终局结果（design-lock §4.5）
    async submitResult({ code, uid, score, steps, won }) {
      if (!code || !uid) return { code: 1, data: null, message: '缺少 code 或 uid' };
      const room = await store.roomGet(code);
      if (!room) return { code: 3, data: null, message: '房间不存在或已过期' };
      const now = Date.now();
      room.results[String(uid)] = {
        uid: String(uid),
        score: Math.floor(Number(score) || 0),
        steps: Math.floor(Number(steps) || 0),
        ts: Math.floor(now / 1000),
        won: !!won,
      };
      const uids = Object.keys(room.players);
      // 仅当仍为 playing 且双方结果齐才写终局（幂等，避免覆盖 opponent_left/abandoned）
      if (room.status === 'playing' && uids.length === 2 && room.results[uids[0]] && room.results[uids[1]]) {
        room.matchResult = computeMatch(room);
        room.status = 'finished';
      }
      await store.roomSet(code, room);
      return { code: 0, data: { ok: true }, message: 'ok' };
    },

    // POST /api/room/leave —— 离开房间（design-lock §4.6 / §3 Q6）
    async leave({ code, uid }) {
      if (!code || !uid) return { code: 1, data: null, message: '缺少 code 或 uid' };
      const room = await store.roomGet(code);
      if (!room) return { code: 3, data: null, message: '房间不存在或已过期' };
      if (room.status === 'waiting') {
        // waiting 期退出：移除槽位，房间保留（清空则标记 orphan）
        delete room.players[String(uid)];
        if (Object.keys(room.players).length === 0) room.orphan = true;
        await store.roomSet(code, room);
      } else if (room.status === 'playing') {
        // playing 期退出：标记 left，写 matchResult=4、status=opponent_left
        if (!room.players[String(uid)]) {
          room.players[String(uid)] = { uid: String(uid), name: '玩家', score: 0, steps: 0, over: false, updatedAt: Date.now() };
        }
        room.players[String(uid)].left = true;
        room.matchResult = 4;
        room.status = 'opponent_left';
        await store.roomSet(code, room);
      }
      // 其余终局态（finished/opponent_left/abandoned）：不改终局，仅返回 ok
      return { code: 0, data: { ok: true }, message: 'ok' };
    },

    // POST /api/room/reset —— 再来一局（design-lock §3 Q5）
    async reset({ code, uid }) {
      if (!code) return { code: 1, data: null, message: '缺少 code' };
      const room = await store.roomGet(code);
      if (!room) return { code: 3, data: null, message: '房间不存在或已过期' };
      // 仅终局后允许（matchResult ∈ {1,2,3,4,5}）
      if (![1, 2, 3, 4, 5].includes(room.matchResult)) {
        return { code: 4, data: null, message: '对局尚未结束，无法重开' };
      }
      const now = Date.now();
      const newSeed = makeSeed();
      // 清空双方进度（保留 name），新 seed、回 waiting
      for (const u of Object.keys(room.players)) {
        room.players[u] = {
          uid: u,
          name: room.players[u].name || '玩家',
          ready: true,
          score: 0,
          steps: 0,
          over: false,
          updatedAt: now,
          left: false,
        };
      }
      room.seed = newSeed;
      room.results = {};
      room.matchResult = 0;
      room.status = 'waiting';
      room.startAt = null;
      room.orphan = false;
      await store.roomSet(code, room); // 续 600s
      return { code: 0, data: { seed: newSeed, status: 'waiting' }, message: 'ok' };
    },
  };
}

module.exports = { makeRoomService, computeMatch, ROOM_CODE_REGEX };
