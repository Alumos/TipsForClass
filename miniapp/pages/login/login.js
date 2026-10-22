const api = require('../../utils/api');
const session = require('../../utils/session');
const config = require('../../config');
Page({
  data: { demoEnabled: config.enableDemoLogin, apiBase: config.apiBase, busy: false, error: '' },
  onShow() { if (session.read()) wx.switchTab({ url: '/pages/home/home' }); },
  demoLogin() { this.login('/auth/demo-login', {}); },
  wxLogin() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    wx.login({ success: res => { if (res.code) this.login('/auth/wx-login', { code: res.code }, true); else this.setData({ busy: false, error: '微信未返回登录凭证，请重试' }); }, fail: () => this.setData({ busy: false, error: '微信登录失败，请使用已配置真实 AppID 的项目重试' }) });
  },
  async login(path, data, fromWx) {
    if (this.data.busy && !fromWx) return;
    this.setData({ busy: true, error: '' });
    try {
      const result = await api.request(path, { method: 'POST', data, anonymous: true });
      session.clear(); session.write(result);
      wx.switchTab({ url: result.teacher.status === 'active' ? '/pages/home/home' : '/pages/profile/profile' });
    } catch (e) { this.setData({ error: api.errorText(e) }); }
    finally { this.setData({ busy: false }); }
  }
});
