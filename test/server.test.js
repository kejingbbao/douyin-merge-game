// test/server.test.js
// 排行榜存储后端单测：内存 / 文件(持久化) / upstash(Redis REST，用假 fetch 验证正确性)
// 三个后端走同一组断言，确保接口一致、可随时切换。
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createMemoryStore, createFileStore, createUpstashStore } = require('../server/store.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

// 同一组场景跑在任意「全新 store」上（makeFresh 每次返回干净后端）
async function runScenarios(makeFresh, label) {
  const s = makeFresh();
  await s.recordScore('uA', '小明', 500);
  await s.recordScore('uB', '小红', 300);
  await s.recordScore('uC', '小刚', 100);
  let v = await s.getRankView('uA', 100);
  ok(v.top.length === 3, label + ': 应 3 条，实际 ' + v.top.length);
  ok(v.selfRank === 1, label + ': 小明(500) 应第 1，实际 ' + v.selfRank);
  ok(v.top[0].name === '小明' && v.top[0].isSelf === true, label + ': 第 1 应为小明且 isSelf');
  ok(v.selfScore === 500, label + ': selfScore 应为 500，实际 ' + v.selfScore);

  // 同 uid 提交更高分覆盖，更低分不降
  await s.recordScore('uA', '小明', 800);
  ok((await s.getRankView('uA', 100)).selfScore === 800, label + ': 覆盖为更高分 800');
  await s.recordScore('uA', '小明', 100);
  ok((await s.getRankView('uA', 100)).selfScore === 800, label + ': 低分提交不应下降');

  // 百名外场景（全新 store，仅 105 个其他玩家 + 自己低分）
  const s2 = makeFresh();
  for (let i = 0; i < 105; i++) await s2.recordScore('o' + i, '玩家' + i, 9000 - i * 80);
  await s2.recordScore('me', '我', 10);
  let v4 = await s2.getRankView('me', 100);
  ok(v4.top.length === 100, label + ': top 应截断为 100，实际 ' + v4.top.length);
  ok(v4.selfRank === 106, label + ': 百名外应第 106，实际 ' + v4.selfRank);
  ok(v4.top.every((x) => !x.isSelf), label + ': top 内不应包含自己');
  ok((await s2.getRankView('me', 50)).top.length === 50, label + ': limit=50 应 50 条');

  // 单人独占榜首（全新 store）
  const s3 = makeFresh();
  await s3.recordScore('only', '我', 0);
  let v6 = await s3.getRankView('only', 100);
  ok(v6.top.length === 1 && v6.selfRank === 1, label + ': 单人应独占榜首');
}

async function main() {
  // 1) 内存
  await runScenarios(() => createMemoryStore(), 'memory');

  // 2) 文件：持久化验证（记录后换一个 store 读同一文件）
  const file = path.join(os.tmpdir(), 'rank-test-' + Date.now() + '.json');
  const f1 = createFileStore(file);
  await f1.recordScore('p1', '甲', 1234);
  await f1.recordScore('p2', '乙', 5678);
  const reload = createFileStore(file);
  const rv = await reload.getRankView('p1', 100);
  ok(rv.top.length === 2, 'file: 重载后应有 2 条，实际 ' + rv.top.length);
  ok(rv.selfScore === 1234, 'file: 重载后 p1 分数应为 1234，实际 ' + rv.selfScore);
  ok(rv.top[0].name === '乙', 'file: 最高分应为乙');
  try { fs.unlinkSync(file); } catch (e) {}
  // 文件场景（每个 fresh 用独立临时文件，互不污染）
  await runScenarios(() => createFileStore(path.join(os.tmpdir(), 'rank-' + Date.now() + '-' + Math.random().toString(36) + '.json')), 'file');

  // 3) upstash（用假 fetch 模拟 Redis 命令）
  const board = new Map();
  const meta = new Map();
  // upstash 真·后端模拟：从 rcmd 发出的 POST body { command: [...] } 解析命令
  // （与改造后的 rcmd 一致：命令不再拼在 URL 路径里）。保留 URL 路径兜底以免旧调用形态失效。
  global.fetch = async function fakeFetch(u, opts) {
    let command;
    if (opts && opts.body) {
      try { command = JSON.parse(opts.body).command; } catch (e) { command = null; }
    }
    if (!Array.isArray(command) || !command.length) {
      const url = typeof u === 'string' ? u : (u && u.url);
      const parts = String(url || '').replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean);
      command = parts.map(decodeURIComponent);
    }
    if (!Array.isArray(command) || !command.length) return { json: async () => ({ result: null }) };
    const cmd = command[0];
    const args = command.slice(1);
    let result;
    if (cmd === 'ZADD') {
      let i = 1, gt = false;
      if (args[i] === 'GT') { gt = true; i++; }
      const score = Number(args[i]); const member = args[i + 1];
      const cur = board.get(member);
      if (cur === undefined || !gt || score > cur) board.set(member, score);
      result = 1;
    } else if (cmd === 'ZREVRANGE') {
      const start = Number(args[1]), stop = Number(args[2]);
      const withScores = args.includes('WITHSCORES');
      let items = Array.from(board.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      if (stop >= 0) items = items.slice(start, stop + 1); else items = items.slice(start);
      result = [];
      if (withScores) for (const [m, s] of items) { result.push(m); result.push(String(s)); }
      else for (const [m] of items) result.push(m);
    } else if (cmd === 'HSET') {
      meta.set(args[1], args[2]); result = 1;
    } else if (cmd === 'HGETALL') {
      result = []; for (const [f, v] of meta) { result.push(f); result.push(v); }
    } else { result = null; }
    return { json: async () => ({ result }) };
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  await runScenarios(() => { board.clear(); meta.clear(); return createUpstashStore(); }, 'upstash');
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  console.log('server.test: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
