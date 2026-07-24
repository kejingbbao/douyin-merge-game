# 排行榜云后端（全球榜）

「合成能量」小游戏的排行榜后端。负责接收玩家分数、计算并下发**全平台前 100 名 + 玩家自身名次**。零依赖 Node，可跑在 Vercel / Cloudflare Workers / 任意 Node 服务 / 本地。

## 接口（均带 HMAC 签名校验）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/score` | 上报分数。body：`{ uid, name, score, ts, sig }`。同名 `uid` 只保留最高分。 |
| `GET`  | `/api/rank?uid=xxx&limit=100&ts=xxx&sig=xxx` | 拉榜单。返回 `{ top:[{rank,name,score,isSelf}], selfRank, selfName, selfScore }`。 |

- `uid`：前端本地生成并持久化（`game.js` 的 `rankUid`，首次进入随机创建）。
- `name`：展示昵称（首次随机生成，存本地）。
- `ts`：Unix 秒级时间戳；`sig = HMAC-SHA256(密钥, 载荷)`。
  - 上报载荷：`uid + '|' + score + '|' + ts`
  - 查榜载荷：`uid + '|' + ts`
- 客户端密钥与后端环境变量 `RANK_SECRET` 必须一致（见 `config.js`）。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `RANK_SECRET` | 上线必填 | 签名密钥（前后端一致）。**留空则关闭验签（仅本地测试）**，任何人可伪造高分，切勿用于生产。 |
| `RANK_STORE` | 否 | 存储后端：`memory`(默认) / `file` / `upstash` |
| `RANK_FILE` | 否 | `file` 后端的 JSON 路径（默认 `server/rank-data.json`） |
| `UPSTASH_REDIS_REST_URL` | upstash 必填 | Upstash Redis REST 地址 |
| `UPSTASH_REDIS_REST_TOKEN` | upstash 必填 | Upstash Redis REST 令牌 |
| `RANK_MAX_SCORE` | 否 | 单局分数上限，默认 `10000000`（超范围直接拒绝） |
| `SIGN_TTL` | 否 | 签名有效期秒数，默认 `300`（防重放） |

## 存储后端（持久化）

- **`memory`**（默认）：进程内 Map，**重启即清空**，仅本地/测试用。
- **`file`**：JSON 文件落盘（`RANK_FILE`）。**自托管 VPS / 普通常驻 Node 服务可直接持久化**，零外部依赖。命令：`RANK_STORE=file node index.js`。
- **`upstash`**：Upstash Redis REST（serverless 推荐，零原生依赖）：
  1. 去 [upstash.com](https://upstash.com) 建一个 Redis 数据库，拿到 REST URL + Token
  2. 设置 `RANK_STORE=upstash` + `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
  3. 数据模型：有序集合 `rank:board`（成员=uid，分=score，用 `ZADD GT` 只升不降）+ 哈希 `rank:meta`（uid→昵称）

> Vercel / Cloudflare Workers 的磁盘是**临时**的，`file` 后端在 serverless 上不会跨实例持久化；**serverless 部署请选 `upstash`**。

## 本地调试

```bash
cd server
RANK_SECRET=dev-secret RANK_STORE=file node index.js   # 监听 http://localhost:3000
# 另开终端：
curl -X POST http://localhost:3000/api/score -H 'Content-Type: application/json' \
  -d '{"uid":"u1","name":"小明","score":500,"ts":'"$(date +%s)"',"sig":"__计算后填入__"}'
curl "http://localhost:3000/api/rank?uid=u1&ts=$(date +%s)&sig=__"
```

> 抖音小游戏里 `tt.request` 要求 **HTTPS** 且域名加入开放平台「服务器域名」白名单。本地开发者工具勾选「不校验合法域名」即可直连 `http://localhost:3000`。

## 部署

### 方案 A：Vercel（最省事）
1. 把 `server/` 目录作为独立项目推到 GitHub
2. Vercel 导入 → Framework 选 `Other` → Build Command 留空
3. 在 Vercel 后台设置环境变量：`RANK_SECRET`、`RANK_STORE=upstash`、`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`
4. 部署完拿到 `https://xxx.vercel.app`，把 `config.js` 的 `RANK_ENDPOINT` 填成 `https://xxx.vercel.app/api`

### 方案 B：Cloudflare Workers
1. 安装 wrangler，`wrangler.toml` 的 `main` 指向 `worker.js`，并配置Upstash环境变量
2. `wrangler publish` 拿到 `*.workers.dev` 域名
3. `RANK_ENDPOINT` 填 `https://xxx.workers.dev/api`

## ⚠️ 安全说明（防刷分边界）
HMAC 签名能挡住「随手改分数/脚本乱刷」，但**密钥存在于客户端代码中**，懂技术的人仍可反编译提取。它属于「提高作弊门槛」，不是绝对安全。若后续需要更强防护，建议：
- 服务端对高分做合理性校验（如单局分数随时间增长有上限）
- 用一次性 token（登录态）代替静态密钥
- 结合设备/行为风控
当前 MVP 阶段，签名 + 分数范围校验 + 时间戳防重放已足够挡住绝大多数作弊。
