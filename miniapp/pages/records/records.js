const api = require('../../utils/api');
const session = require('../../utils/session');
const { messageView } = require('../../utils/logic');

function recordView(message) {
  const view = messageView(message);
  view.recordInfoLong = Array.from(view.recordInfo || '').length > 120;
  return view;
}

Page({
  data: { items: [], filters: ['有效消息', '已撤回', '全部记录'], filterIndex: 0, cursor: '', hasMore: false, loading: false, deletingId: '', error: '' },
  onShow() { if (session.requireLogin()) this.load(true); },
  onPullDownRefresh() { this.load(true); },
  onReachBottom() { if (this.data.hasMore) this.load(false); },
  filterChange(e) { this.setData({ filterIndex: Number(e.detail.value) }); this.load(true); },
  async load(reset) {
    if (this.data.loading) return;
    if (typeof reset !== 'boolean') reset = true;
    this.setData({ loading: true, error: '' });
    try {
      const status = ['active', 'revoked', ''][this.data.filterIndex];
      const result = await api.request('/messages?limit=20&status=' + status + '&cursor=' + encodeURIComponent(reset ? '' : this.data.cursor));
      this.setData({ items: (reset ? [] : this.data.items).concat(result.items.map(recordView)), cursor: result.nextCursor || '', hasMore: !!result.nextCursor });
    } catch (e) { this.setData({ error: api.errorText(e) }); }
    finally { this.setData({ loading: false }); wx.stopPullDownRefresh(); }
  },
  arrange() { wx.navigateTo({ url: '/pages/arrange/arrange' }); },
  more() { this.load(false); },
  detail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  edit(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const item = this.data.items.find(message => message.id === id);
    const roomId = item && Array.isArray(item.roomIds) && item.roomIds.length ? item.roomIds[0] : '';
    const query = 'editId=' + encodeURIComponent(id) + (roomId ? '&roomId=' + encodeURIComponent(roomId) : '');
    wx.navigateTo({ url: '/pages/publish/publish?' + query });
  },
  remove(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id || this.data.deletingId) return Promise.resolve(false);
    return new Promise(resolve => {
      wx.showModal({
        title: '删除这条公告？',
        content: '删除后会立即从所有目标教室大屏撤下，并在“已撤回”记录中保留审计信息，且无法恢复。',
        confirmText: '删除',
        confirmColor: '#A93230',
        success: async result => {
          if (!result.confirm) {
            resolve(false);
            return;
          }
          this.setData({ deletingId: id, error: '' });
          try {
            await api.request('/messages/' + encodeURIComponent(id), { method: 'DELETE' });
            wx.showToast({ title: '公告已删除', icon: 'success' });
            await this.load(true);
            resolve(true);
          } catch (error) {
            this.setData({ error: api.errorText(error) });
            resolve(false);
          } finally {
            this.setData({ deletingId: '' });
          }
        }
      });
    });
  }
});
