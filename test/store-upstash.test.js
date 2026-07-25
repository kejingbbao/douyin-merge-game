// test/store-upstash.test.js
// 针对 Task B 的安全加固：验证 createUpstashStore 的 rcmd() 已改造为「POST body 命令」方式，
// 彻底规避「命令拼在 URL 路径里」导致的线上 400 input length too long（房间 JSON / boardSummary 等大值写入时易触顶 URL 长度上限）。
//
// 覆盖 6 个断言：
//   (a) rcmd 发出的是 POST 方法
//   (b) 请求 URL 是 base url（不含命令参数拼在路径里）
//   (c) body 是裸 JSON 数组 ["COMMAND","ARG",...]（Upstash REST 官方格式，非 { command: [...] } 包裹）且参数为原始字符串
//   (d) 带 Authorization: Bearer <token> 头（以及 Content-Type: application/json）
//   (e) 当返回 { error: 'xxx' } 时 rcmd 抛错
//   (f) 正常返回 json.result
const { createUpstashStore } = require('../server/store.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.error('FAIL: ' + m); } }

// 用假 fetch 捕获请求细节；handler 返回 { result } 或 { error }
function withFakeFetch(handler) {
  const calls = [];
  global.fetch = async (u, opts) => {
    calls.push({ url: typeof u === 'string' ? u : (u && u.url), opts: opts || {} });
    return await handler(u, opts, calls);
  };
  return calls;
}

async function main() {
  const URL = 'https://fake-upstash.example.com';
  const TOKEN = 'tok-abcdef-123456';

  // 前置：设置环境变量以便 createUpstashStore 走真实分支
  process.env.UPSTASH_REDIS_REST_URL = URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;

  // ---------- (a)(b)(c)(d)：验证请求形态 ----------
  {
    const calls = withFakeFetch(async () => ({ json: async () => ({ result: JSON.stringify({ status: 'waiting' }) }) }));
    const store = createUpstashStore();
    // roomGet -> rcmd('GET', 'room:CODE') 单次调用，最容易验证 body 形态
    await store.roomGet('ROOMAB');
    const call = calls[calls.length - 1];
    const opts = call.opts;

    // (a) POST
    ok((opts.method || 'GET').toUpperCase() === 'POST', '(a) rcmd 应为 POST 方法，实际 ' + (opts.method || 'GET'));

    // (b) URL 为 base，无命令拼路径
    ok(call.url === URL, '(b) 请求 URL 应为 base url，实际 ' + call.url);
    ok(!/\/(GET|SET|ZADD|HSET|HGETALL|ZREVRANGE|EXPIRE|LPUSH|LTRIM|ZRANGEBYSCORE|LRANGE)/.test(call.url), '(b) URL 不应包含命令参数');

    // (c) body 为裸 JSON 数组 [原始字符串]（Upstash REST 官方格式，非 { command: [...] } 包裹）
    let body;
    try { body = JSON.parse(opts.body); } catch (e) { /* ignore */ }
    ok(body && Array.isArray(body), '(c) body 应为裸 JSON 数组（Upstash REST 官方格式）');
    if (body && Array.isArray(body)) {
      ok(body.every((x) => typeof x === 'string'), '(c) 数组元素应为原始字符串（未 encodeURIComponent）');
      ok(body[0] === 'GET' && body[1] === 'room:ROOMAB', "(c) 数组应为 ['GET','room:ROOMAB',...]（原始值）");
      // 进一步验证「大值 JSON」原样进 body、未做 URL 编码（这是触发 400 的关键场景）
      const calls2 = withFakeFetch(async () => ({ json: async () => ({ result: 'OK' }) }));
      const s2 = createUpstashStore();
      const bigRoom = { name: '玩家 A/小明', note: 'a b', board: '4,4,4,4,2,2,2' };
      await s2.roomSet('CODE2', bigRoom);
      const c2 = calls2[calls2.length - 1];
      const b2 = JSON.parse(c2.opts.body);
      // roomSet -> rcmd('SET', 'room:CODE2', '<json>', 'EX', '600')
      ok(b2[2] === JSON.stringify(bigRoom), '(c) 大值 JSON 应原样进 body，未做 URL 编码');
    }

    // (d) 请求头
    const h = opts.headers || {};
    ok(h.Authorization === 'Bearer ' + TOKEN, '(d) 应带 Authorization: Bearer <token>，实际 ' + JSON.stringify(h.Authorization));
    ok(h['Content-Type'] === 'application/json', '(d) 应带 Content-Type: application/json，实际 ' + JSON.stringify(h['Content-Type']));
  }

  // ---------- (e)：返回 { error } 时抛错 ----------
  {
    withFakeFetch(async () => ({ json: async () => ({ error: 'ERR input length too long' }) }));
    const store = createUpstashStore();
    let threw = false, msg = '';
    try {
      // getRankView -> getEntries -> rcmd('ZREVRANGE'...) 不吞异常（与 room* 的静默失败不同）
      await store.getRankView('uX', 10);
    } catch (e) { threw = true; msg = e.message; }
    ok(threw === true, '(e) 返回 { error } 时 rcmd 应抛错');
    ok(/^upstash:/.test(msg), '(e) 错误应以 upstash: 前缀，实际 ' + JSON.stringify(msg));
  }

  // ---------- (f)：正常返回 json.result ----------
  {
    const sample = { status: 'playing', code: 'XYZ789', players: { u1: { score: 10, steps: 3 } } };
    withFakeFetch(async () => ({ json: async () => ({ result: JSON.stringify(sample) }) }));
    const store = createUpstashStore();
    const got = await store.roomGet('XYZ789');
    ok(got && got.status === 'playing' && got.code === 'XYZ789', '(f) rcmd 应返回 json.result（解析后对象）');
    ok(got && got.players && got.players.u1 && got.players.u1.score === 10, '(f) result 内容应被正确透传');
  }

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  console.log('store-upstash.test: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
