/**
 * 微信小程序全局配置
 * API_BASE_URL：后端服务地址（与网页版及 /admin 管理端共用同一套 Cloudflare Pages + R2 服务）
 * 若后续为微信小程序正式版绑定已 ICP 备案的自定义域名，仅需修改此处的 API_BASE_URL 即可。
 */
module.exports = {
  API_BASE_URL: 'https://dance.lage.us.ci',
  MAX_FILE_SIZE_BYTES: 500 * 1024 * 1024, // 500MB
  OVERSIZE_ERROR_MESSAGE: '视频太大啦（超过500M），请换个清晰度低一点的',
  QUICK_SUFFIXES: ['背面', '正面', '分解教学', '慢速'],
};
