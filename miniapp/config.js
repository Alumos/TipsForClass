// 服务地址：默认连线上域名，开发者工具和真机走同一套后端。
// 只有想连本机 Go 服务、做不依赖服务器的纯前端调试时，才把 USE_LOCAL 改成 true。
// 注意：微信不接受 IP、http 和自签名证书，真机只能走已备案的 HTTPS 域名，
// 并且该域名要填进小程序后台「开发设置 → 服务器域名」。
const USE_LOCAL = false;

const local = 'http://127.0.0.1:8080/api/v1';
const remote = 'https://notice.alumos.cn/api/v1';

module.exports = {
  apiBase: USE_LOCAL ? local : remote,
  // 演示登录依赖服务端 demo 模式，只在连本机时显示入口。
  enableDemoLogin: USE_LOCAL
};
