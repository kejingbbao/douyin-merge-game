// server/ladder.js
// 天梯（异步匹配）Phase 1 服务端：LadderService
// 路由入口在 server/index.js：
//   POST /api/ladder/match    —— 写本人快照、按分数带宽匹配对手（无则合成降级）、比拼、写历史、返回结算
//   GET  /api/ladder/history  —— 验签后返回本人战绩（按 ts 倒序）
//
// 信封：{ code, data, message }
//   code: 0 成功 / 1 参数错 / 2 签名失效 / 3 未找到 / 5 服务端错
// 复用全局 store 实例与 verifyPayload（HMAC-SHA256，密钥 RANK_SECRET）。
//
// 设计要点：
//   - 旧接口 /api/score、/api/rank 仍使用 { ok, error } 信封，本服务不改动它们。
//   - 匹配带宽是服务端算的：band = max(50, round(score * 0.15))，即 ±15% 且最小 ±50 分。
//   - 合成对手（synthetic）：池空时生成“神秘高手”，name 随机、分数贴近本人，保证有对手可玩。

const CODE = { OK: 0, PARAM: 1, SIGN: 2, NOT_FOUND: 3, SERVER: 5 };

// 从 http.IncomingMessage 读取完整请求体（兼容真实流式与测试用同步 fake req）
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

class LadderService {
  /**
   * @param {object} store 由 createStore 创建的全局存储实例（须含天梯方法）
   * @param {object} opts { verifyPayload, maxScore, send }
   *   - verifyPayload(payload, ts, sig) -> boolean
   *   - maxScore  单局分数上限（默认 10,000,000）
   *   - send(res, code, obj) 可注入带 CORS 的发送函数（index.js 注入）；缺省自带 CORS。
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.verifyPayload = opts.verifyPayload || (() => true);
    this.maxScore = opts.maxScore || 10000000;
    this._send = opts.send || null;
  }

  // 统一 JSON 发送（含 CORS，沿用现有约定）
  send(res, code, obj) {
    if (this._send) return this._send(res, code, obj);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(obj));
  }

  // 生成合成对手（池空降级）。分数贴近本人，制造势均力敌的体验。
  makeSynthetic(score) {
    const sc = Math.floor(Number(score) || 0);
    const band = Math.max(50, Math.round(sc * 0.15));
    const delta = Math.floor((Math.random() * 2 - 1) * band);
    const oppScore = Math.max(0, sc + delta);
    const steps = Math.max(1, Math.round(sc / 4 + Math.random() * 20));
    const names = ['神秘高手', '隐世宗师', '无名强者', '天梯幻影', '合成大师'];
    const name = names[Math.floor(Math.random() * names.length)];
    return { uid: 'synthetic', name, score: oppScore, steps, boardSummary: null, synthetic: true };
  }

  // POST /api/ladder/match
  async match(req, res) {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      return this.send(res, 400, { code: CODE.PARAM, data: null, message: 'invalid json' });
    }

    const { uid, name, score, steps, boardSummary, ts, sig } = payload;

    // 1) 参数校验
    if (!uid) return this.send(res, 400, { code: CODE.PARAM, data: null, message: 'uid required' });
    // 必填字段 score 缺失：按架构约定（docs/system_design.md §7）返回 code 1（PARAM）。
    // 用 == null 而非 falsy，以保留 score=0 这一合法分数值。
    if (score == null) return this.send(res, 400, { code: CODE.PARAM, data: null, message: 'score required' });
    // score 必须是有限数值（必填数值）。字符串（含 ''/'abc'/'123abc'）一律视为缺失，
    // 禁止被 Number() 静默 coerce 成 0 后当合法 score=0 落库（详见 test/ladder-nan.test.js）。
    // 注意：Number('') === 0（非 NaN），故不能仅靠 !Number.isFinite 捕获空串，需显式按类型拒绝。
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return this.send(res, 400, { code: CODE.PARAM, data: null, message: 'score required' });
    }
    const sc = Math.floor(score);
    // steps 同理：必须为有限数值，非数字字符串一律拒绝（与 score 保持一致）。
    if (typeof steps !== 'number' || !Number.isFinite(steps) || steps < 0) {
      return this.send(res, 400, { code: CODE.PARAM, data: null, message: 'steps invalid' });
    }
    const st = Math.floor(steps);
    if (sc < 0 || sc > this.maxScore) {
      return this.send(res, 400, { code: CODE.PARAM, data: null, message: 'score out of range' });
    }
    if (ts == null) return this.send(res, 400, { code: CODE.PARAM, data: null, message: 'ts required' });

    // 2) 验签：canonical = uid|score|steps|ts
    const canonical = String(uid) + '|' + sc + '|' + st + '|' + ts;
    if (!this.verifyPayload(canonical, ts, sig)) {
      return this.send(res, 403, { code: CODE.SIGN, data: null, message: 'invalid signature' });
    }

    try {
      // 3) 写本人快照（供他人匹配）
      await this.store.saveSnapshot({
        uid: String(uid),
        name: String(name || '玩家').slice(0, 16),
        score: sc,
        steps: st,
        boardSummary: boardSummary == null ? null : boardSummary,
        ts: Number(ts),
        synthetic: false,
      });

      // 4) 匹配对手（band 默认 ±15% 且最小 ±50 分）
      const band = Math.max(50, Math.round(sc * 0.15));
      let opponent = await this.store.matchSnapshot(sc, uid, band);
      let synthetic = false;
      if (!opponent) {
        opponent = this.makeSynthetic(sc);
        synthetic = true;
      }

      // 5) 比拼：用已签名的本局 score 与对手 score 比较
      const oppScore = Math.floor(Number(opponent.score) || 0);
      const diff = sc - oppScore;
      let result = 'draw';
      if (diff > 0) result = 'win';
      else if (diff < 0) result = 'loss';

      const matchId = 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

      // 6) 写历史（本人）
      const rec = {
        matchId,
        myScore: sc,
        oppName: String(opponent.name || '对手'),
        oppScore,
        oppUid: String(opponent.uid || 'synthetic'),
        opponentSynthetic: !!synthetic,
        result,
        diff,
        ts: Number(ts),
      };
      await this.store.pushHistory(uid, rec);

      // 7) 返回结算卡数据
      const data = {
        matchId,
        myScore: sc,
        opponent: {
          name: String(opponent.name || '对手'),
          score: oppScore,
          steps: Math.floor(Number(opponent.steps) || 0),
          boardSummary: opponent.boardSummary == null ? null : opponent.boardSummary,
          synthetic: !!synthetic,
        },
        result,
        diff,
        synthetic,
      };
      return this.send(res, 200, { code: CODE.OK, data, message: 'ok' });
    } catch (e) {
      return this.send(res, 500, { code: CODE.SERVER, data: null, message: String(e && e.message || e) });
    }
  }

  // GET /api/ladder/history?uid=&limit=&ts=&sig=
  async getHistory(req, res) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const uid = u.searchParams.get('uid') || '';
      const ts = u.searchParams.get('ts') || '';
      const sig = u.searchParams.get('sig') || '';
      const limit = parseInt(u.searchParams.get('limit') || '20', 10);

      if (!uid) return this.send(res, 400, { code: CODE.PARAM, data: null, message: 'uid required' });
      // 验签：canonical = uid|ts（与排行榜一致）
      if (!this.verifyPayload(String(uid) + '|' + ts, ts, sig)) {
        return this.send(res, 403, { code: CODE.SIGN, data: null, message: 'invalid signature' });
      }

      const full = await this.store.getHistory(uid); // 取全部（最多 50，由 store LTRIM 保证）
      const total = full.length;
      const list = full.slice(0, Math.max(1, Math.min(50, limit || 20)));
      return this.send(res, 200, {
        code: CODE.OK,
        data: { list, total },
        message: 'ok',
      });
    } catch (e) {
      return this.send(res, 500, { code: CODE.SERVER, data: null, message: String(e && e.message || e) });
    }
  }
}

module.exports = { LadderService, CODE };
