const api = require('../../utils/api');
const session = require('../../utils/session');
const { formatTime } = require('../../utils/logic');
Page({
  data: { teacher: {}, classes: [], loading: false, error: '', ready: false },
  onShow() { if (session.requireLogin()) this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const me = await api.request('/me');
      this.setData({ teacher: me });
      if (me.status !== 'active') { wx.switchTab({ url: '/pages/profile/profile' }); return; }
      const response = await api.request('/classes');
      const current = session.read(); if (!current) return;
      const recent = wx.getStorageSync('notice-recent:' + current.teacher.id);
      const classes = (response.items || []).map(item => Object.assign({}, item, { id: String(item.id), initial: String(item.name || '').slice(0, 1), lastSeenLabel: formatTime(item.lastSeenAt) })).sort((a, b) => a.id === recent ? -1 : b.id === recent ? 1 : 0);
      this.setData({ classes, ready: true });
    } catch (e) { this.setData({ error: api.errorText(e) }); }
    finally { this.setData({ loading: false }); wx.stopPullDownRefresh(); }
  },
  onPullDownRefresh() { this.load(); },
  arrange(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/arrange/arrange' + (id ? '?classId=' + encodeURIComponent(id) : '') });
  },
  publish(e) {
    const id = e.currentTarget.dataset.id;
    const s = session.read(); if (s) wx.setStorageSync('notice-recent:' + s.teacher.id, id);
    wx.navigateTo({ url: '/pages/publish/publish?classId=' + encodeURIComponent(id) });
  },
  profile() { wx.switchTab({ url: '/pages/profile/profile' }); }
});
