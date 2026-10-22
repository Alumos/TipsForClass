const api = require('../../utils/api');
const session = require('../../utils/session');
const config = require('../../config');
Page({
  data: { me: {}, loading: false, busy: false, error: '', bootstrapCode: '', name: '', apiBase: config.apiBase },
  onShow() { if (session.requireLogin()) this.load(); },
  async load() { this.setData({ loading: true, error: '' }); try { const me = await api.request('/me'); this.setData({ me }); const s = session.read(); if (s) { s.teacher = Object.assign({}, s.teacher, me); session.write(s); } } catch (e) { this.setData({ error: api.errorText(e) }); } finally { this.setData({ loading: false }); } },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  admin() { wx.navigateTo({ url: '/pages/admin/admin' }); },
  async setup() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await api.request('/admin/setup', { method: 'POST', data: { bootstrapCode: this.data.bootstrapCode.trim(), name: this.data.name.trim() } }); this.setData({ bootstrapCode: '' }); await this.load(); }
    catch (e) { this.setData({ error: api.errorText(e) }); } finally { this.setData({ busy: false }); }
  },
  logout() { wx.showModal({ title: '退出工作台？', content: '退出会清除本账号的本地草稿。', success: async r => { if (!r.confirm) return; try { await api.request('/auth/logout', { method: 'POST', data: {} }); } catch (_) {} finally { session.clear(); getApp().globalData.copyMessage = null; wx.reLaunch({ url: '/pages/login/login' }); } } }); }
});
