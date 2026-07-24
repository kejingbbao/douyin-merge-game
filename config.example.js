// config.example.js —— config.js 的模板，提交到仓库（无真实密钥）。
// 使用方式：复制本文件为 config.js，填入你自己的值后本地/上线使用。
// 注意：config.js 已被 .gitignore 排除，不会进版本库，避免 RANK_SECRET 泄露。
module.exports = {
  APP_ID: 'ttYOUR_APPID_HERE', // ← 你的小游戏 appid（同时填到 project.config.json）
  BANNER_AD_ID: '', // ← Banner 广告位 ID（流量主后台创建）
  REWARD_AD_ID: '', // ← 激励视频广告位 ID（流量主后台创建）
  // 排行榜云后端地址（部署 server/ 后填入）。本地调试可填 'http://localhost:3000/api'
  RANK_ENDPOINT: '',
  // 防刷分签名密钥：必须与 server 端环境变量 RANK_SECRET 完全一致（建议用长随机串）。
  // 留空 = 不上传签名（便于本地联调）；上线前务必设置，否则任何人可伪造高分。
  RANK_SECRET: '',
};
