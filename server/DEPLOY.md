# 排行榜后端 · 一键部署清单（Vercel 版）

适用对象：「合成能量」小游戏的全球排行榜后端（`server/` 目录）。
目标：把后端部署到 Vercel，**数据真实持久化**，并能在游戏里看到全球榜。
预计耗时：15–25 分钟（含注册账号）。
难度：照着点就行，不需要写代码。

> 本清单假设你已经把 `douyin-merge-game/server/` 这个**文件夹单独**推到了一个 GitHub 仓库（Vercel 从 GitHub 拉代码）。如果还没推，见第 1 步。
> 文末附「Vercel 控制台界面示意」三张图，对你标好了每一步要点（环境无法登录 Vercel 实拍，故为还原界面，效果等同截图）。

---

## 0. 前置准备（3 样东西）

| # | 要准备的东西 | 去哪弄 | 备注 |
|---|------------|--------|------|
| A | 一个 GitHub 账号 + `server/` 的独立仓库 | github.com | 仓库里**只放 server/ 的内容**（index.js / store.js / worker.js / vercel.json），不要带上层 game.js |
| B | 一个 Upstash Redis 数据库（免费档够用） | upstash.com → Console → Create Database | 选任意区域；建完拿 **REST URL** 和 **REST Token** |
| C | 一把随机签名密钥 `RANK_SECRET` | 本机终端跑：`openssl rand -hex 32`（没有 openssl 就用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`） | 把输出**整串复制保存好**，后面前后端都要填同一个 |

---

## 1. 把 server/ 推成独立 GitHub 仓库（若已推可跳过）

```bash
cd douyin-merge-game/server
git init
git add .
git commit -m "merge-game rank server"
# 在 github.com 新建一个空仓库（如 merge-rank-server），然后：
git remote add origin https://github.com/你的名/merge-rank-server.git
git push -u origin main
```

> ⚠️ 关键：Vercel 项目要**直接指向这个仓库根目录**，而仓库根就是 `server/` 的内容。这样 `vercel.json` 的 `builds` 才能正确命中 `index.js`。

---

## 2. 环境变量速查表（复制即用）

部署前先在记事本里备好这 **4 个必填 + 2 个可选**，照抄到 Vercel 后台：

| 变量名 | 值 | 必填 | 说明 |
|--------|-----|------|------|
| `RANK_SECRET` | 第 0 步 C 生成的随机串 | ✅ | 前后端一致；**不设等于裸奔**，任何人可伪造高分 |
| `RANK_STORE` | `upstash` | ✅ | serverless 必须用 upstash（磁盘临时，file 会丢） |
| `UPSTASH_REDIS_REST_URL` | `https://xxx.upstash.io` | ✅ | Upstash 后台 Database 详情页复制 |
| `UPSTASH_REDIS_REST_TOKEN` | `xxx` | ✅ | Upstash 后台 Database 详情页复制 |
| `RANK_MAX_SCORE` | `10000000` | 否 | 单局分数上限，超范围直接拒（默认即此值） |
| `SIGN_TTL` | `300` | 否 | 签名有效期秒数，默认 300（防重放） |

> 本地自托管（VPS / 常驻 Node）想用文件持久化时，把 `RANK_STORE` 换成 `file`、删掉两个 UPSTASH_ 变量即可，其余不变。

---

## 3. Vercel 七步部署（对应文末图 1 / 图 2）

1. 打开 [vercel.com](https://vercel.com) → 右上角 **Add New… → Project**（图 1）。
2. **Import Git Repository**：选第 1 步那个 `merge-rank-server` 仓库 → 点 **Import**。
3. **Configure Project**（图 1 下半部）：
   - Framework Preset：**Other**
   - Build Command：**留空**（零依赖，无需构建）
   - Output Directory：**留空**
   - Install Command：留默认即可（无依赖）
   - 先别急着 Deploy，**点 "Environment Variables" 展开**（或先 Deploy 后在 Settings 里补也行）。
4. 在 **Environment Variables** 区（图 2）逐项粘贴第 2 步的 4 个变量：
   - `RANK_SECRET` = 你的随机串
   - `RANK_STORE` = `upstash`
   - `UPSTASH_REDIS_REST_URL` = `https://xxx.upstash.io`
   - `UPSTASH_REDIS_REST_TOKEN` = `xxx`
   - 每条填完点 **Add**（或回车）；Environment 选 **Production / Preview / Development 全勾**。
5. 点 **Deploy**。等进度条走完，状态变 **Ready（绿色）**。
6. 进 **Settings → Environment Variables** 复查 4 条都在、值无误（图 2 下半部）。
7. 进 **Deployments** 页，点最新那次部署 → 复制域名，形如 `https://merge-rank-server-xxx.vercel.app`（图 3 上半部）。

---

## 4. 回填前端 `config.js`（对应图 3）

打开 `douyin-merge-game/config.js`，改这两行：

```js
module.exports = {
  // …其他不变…
  RANK_ENDPOINT: 'https://merge-rank-server-xxx.vercel.app/api', // ← 第 3 步第 7 小步拿到的域名 + /api
  RANK_SECRET: '这里填和第 0 步 C / Vercel 后台完全一致的随机串',   // ← 同一个 RANK_SECRET
};
```

> ⚠️ `RANK_ENDPOINT` 末尾**必须带 `/api`**（接口挂在 `/api` 下）；`RANK_SECRET` 前后端必须一模一样，差一个字符就验签失败、榜单拉不到。

---

## 5. 抖音侧：加白名单 + 开发者工具验证

1. 登录 **抖音开放平台 → 你的小游戏 → 开发 → 服务器域名**（或「合法域名」）。
2. 把后端域名 `merge-rank-server-xxx.vercel.app` 加进 **request 合法域名**（HTTPS）。
3. 抖音开发者工具里**重新编译** `douyin-merge-game/` 工程。
4. 进游戏玩一局 → 点右上角「排行榜」：
   - 看到「榜单加载中…」→ 然后出现前 100 名 → ✅ 成功。
   - 若提示「未配置」→ `RANK_ENDPOINT` 空了；若一直「加载失败」→ 检查白名单 / 域名 / 变量名拼写。

> 本地开发者工具预览时，可在「详情 → 本地设置」勾选 **不校验合法域名**，用 `http://localhost:3000/api` 先联调（后端本地跑：`cd server && RANK_SECRET=xxx RANK_STORE=file node index.js`）。

---

## 6. 一键自检命令（部署后验证后端活着）

```bash
# 把下面域名换成你的
curl https://merge-rank-server-xxx.vercel.app/api/rank?uid=selftest&ts=$(date +%s)&sig=__nop__
# 未设 RANK_SECRET 时应返回 {"top":[],"selfRank":0,...}；设了密钥会 403（需带正确 sig）——均属正常
```

---

## 7. 常见坑（排错）

| 现象 | 原因 | 解决 |
|------|------|------|
| 榜单一直「加载失败」 | Vercel 域名没加抖音白名单 / 本地没勾不校验 | 见第 5 步 |
| 拉榜 403 invalid signature | `RANK_SECRET` 前后端不一致 / 含多余空格 / 时区差 | 两端复制同一串；确认无首尾空格 |
| 分数不持久（重启清零） | 误用 `RANK_STORE=memory` 或 serverless 上用 `file` | 改为 `upstash` |
| Deploy 后 404 | 仓库根不是 server/ 内容 / vercel.json 没命中 | 确认仓库根直接是 index.js |
| 榜单空白但无报错 | `RANK_SECRET` 在 Vercel 留空（开发模式放行，但前端带了 sig） | 两端都设同一密钥 |

---

## 附：Vercel 控制台界面示意（三张，见对话内图）

- **图 1｜Import & Configure**：Import 仓库 → Framework 选 Other → Build 留空 → 展开 Environment Variables。
- **图 2｜Environment Variables**：4 条变量逐项 Add，Environment 全勾；Deploy 后在 Settings 复核。
- **图 3｜拿域名 & 填前端**：Deployments 复制 `*.vercel.app` → `config.js` 的 `RANK_ENDPOINT` 填 `域名/api`、`RANK_SECRET` 填同串。

---

## 8. 故障复盘 / 坑位（生产化真踩过的坑）

> 以下两节是 `.cn` 生产化与 Upstash 改造过程中真实踩到的坑，供后续部署/维护对照，避免重蹈覆辙。部署步骤章节（0–7）不受影响。

### 8.1 `.cn` 自定义域名 + EdgeOne 收口（生产化）

**是什么**：用国内自定义域名 `kejingbbao.cn` 收口 Vercel 后端，绕开 `.vercel.app` 域名在抖音侧的稳定性问题，并借 EdgeOne 做免备案当天可用的加速。

**配置链路（已落地）**：

- 域名 `kejingbbao.cn` 已在腾讯云 DNSPod 注册 + 实名。
- Vercel 绑定 `kejingbbao.cn` 与 `www.kejingbbao.cn`，两者状态均为 **Valid Configuration（双绿）**。
- DNSPod 解析由 **EdgeOne 托管接入** 自动接管：`@`（根域名）与 `www` 的 CNAME 均指向 `*.eo.dnse1.com`。
- EdgeOne 配置：
  - 套餐：个人版（¥29.9/年）
  - 加速区域：**全球可用区（不含中国大陆）** —— 免 ICP 备案、当天可用
  - 两条加速域名源站均填 `cname.vercel-dns.com`
  - 模板：API 加速
  - 强制 HTTPS（302 跳转）
- 抖音开放平台：request 合法域名已加 `https://kejingbbao.cn`。
- `config.js` 的 `RANK_ENDPOINT` 已切到 `https://kejingbbao.cn/api`
  （`config.js` 被 `.gitignore` 忽略，**不入库**）。

**为什么这么做**：`.vercel.app` 在某些网络/抖音环境下不稳定；`.cn` + EdgeOne 全球加速区可当天生效且不用等备案，先把链路跑通。

**待办 / 提醒**：

- ICP 备案通过后，可一键把 EdgeOne 加速区域从「全球（不含中国大陆）」切到「境内 + 全球」，拉满国内速度。
  - 备案需买一台境内轻量服务器做接入，周期约 1–2 周。
- `config.js` 是**本地配置、不进版本库**：换机器部署需重新填 `RANK_ENDPOINT` / `RANK_SECRET`，别指望 git 拉下来就有。

### 8.2 Upstash REST `rcmd` 必须发「裸 JSON 数组」的坑（血泪）

**是什么**：把 Redis 命令从 URL 路径拼接改成 POST body 时，body 格式写错，导致线上 `.cn` 一度全挂。

**现象**：body 写成 `{"command":[...]}` 对象时，Upstash 返回 `expected JSON array`，**每一个**命令失败，连锁拖垮排行榜 / 天梯 / 房间（线上 `.cn` 一度全挂）。

**为什么（根因）**：Upstash REST API 的 POST body **必须是裸 JSON 数组** `["GET","key",...]`，不是对象；命令参数需全部转字符串。

**正确写法**（`server/store.js` 的 `rcmd`）：

```js
fetch(url, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(args.map(String)), // ← 裸数组 + 全转字符串
});
```

**验证**：单测 `test/store-upstash.test.js` 已断言请求体是 `Array.isArray(body)` 且元素全为 string、`body[0] === 'GET'`（或对应命令）。

> ⚠️ 此前假 fetch 按 `body.command` 解析，导致「假绿」掩盖真 bug —— 单测全过、线上全崩。现已修正为假 fetch 解析 `JSON.parse(opts.body)` 的裸数组。

**教训**：Upstash 客户端 + 假 fetch 单测要**逐字节对齐真实请求形态**，否则单测全绿线上崩。
