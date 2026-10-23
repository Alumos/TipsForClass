// 开发者工具里连本机服务，真机（预览/真机调试/体验版）连线上域名。
// 真机必须用已备案的 HTTPS 域名：微信不接受 IP、http 和自签名证书。
// 要在真机上连局域网电脑，只能先把该地址配进小程序后台的服务器域名白名单。
function inDevtools() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    return info.platform === 'devtools';
  } catch (e) {
    return false;
  }
}
const local = 'http://127.0.0.1:8080/api/v1';
const remote = 'https://notice.alomos.cn/api/v1';
const devtools = inDevtools();
module.exports = {
  apiBase: devtools ? local : remote,
  // 演示登录只在开发者工具里出现，真机与正式版不显示入口。
  enableDemoLogin: devtools
};
