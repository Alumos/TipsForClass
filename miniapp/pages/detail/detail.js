const api = require('../../utils/api');
const session = require('../../utils/session');
const logic = require('../../utils/logic');
Page({
  data: { id: '', message: null, delivery: null, loading: false, busy: false, error: '', pollEnded: false, waited: false },
  onLoad(query) { if (!session.requireLogin()) return; this.setData({ id: query.id }); this.scope = 'detail-' + query.id; this.visible = true; this.replayPending = null; },
  onShow() { if (!this.data.id) return; this.visible = true; this.started = Date.now(); this.setData({ pollEnded: false }); this.refresh(); },
  onHide() { this.stop(); }, onUnload() { this.stop(); },
  stop() { this.visible = false; this.requestVersion = (this.requestVersion || 0) + 1; clearTimeout(this.timer); api.abortScope(this.scope); this.setData({ loading: false }); },
  async refresh() {
    if (this.data.loading || !this.visible) return;
    const version = this.requestVersion = (this.requestVersion || 0) + 1;
    clearTimeout(this.timer); this.setData({ loading: true, error: '' });
    try {
      const results = await Promise.all([api.request('/messages/' + encodeURIComponent(this.data.id), { scope: this.scope }), api.request('/messages/' + encodeURIComponent(this.data.id) + '/delivery', { scope: this.scope })]);
      if (!this.visible || version !== this.requestVersion) return;
      const delivery = results[1];
      delivery.devices = delivery.devices.map(d => Object.assign({}, d, { receivedLabel: logic.formatTime(d.receivedAt), displayedLabel: logic.formatTime(d.displayedAt), revokedLabel: logic.formatTime(d.revokedAt),
        ttsLabel: ({ windows_zh_ready: '中文语音可用', windows_no_chinese_voice: '未安装中文语音', windows_adapter_missing: '语音组件未安装', windows_adapter_unavailable: '语音组件不可用', windows_tts_failed: '语音播放失败', not_windows_no_native_tts: '当前为非 Windows 预览', preview_browser_zh: '浏览器中文语音可用', preview_no_chinese_voice: '浏览器未找到中文语音', preview_unavailable: '浏览器语音不可用', unknown: '等待设备报告' })[d.ttsStatus] || '等待设备报告',
        broadcastReceipts: (d.broadcastReceipts || []).map(receipt => Object.assign({}, receipt, { label: '第 ' + receipt.round + ' 遍：' + (receipt.status === 'played' ? '已播报' : receipt.status === 'failed' ? '播报失败' : ({ device_muted: '设备静音，未播报', quiet_hours: '学校静默时段，未播报', deadline_expired: '已超过播报时间', restore_uncertain: '恢复数据后暂停补播', crash_uncertain: '上次播报结果未确认，不自动重复', maintenance_pause: '提醒已暂停', authorization_revoked: '设备授权失效', replaced_or_expired: '公告已撤回、到期或有新的重播任务' })[receipt.reason] || '已跳过') })) }));
      this.setData({ message: logic.messageView(results[0]), delivery });
    } catch (e) { if (!e.aborted && this.visible && version === this.requestVersion) this.setData({ error: api.errorText(e) }); }
    finally {
      if (version === this.requestVersion) this.setData({ loading: false });
      if (this.visible && version === this.requestVersion) {
        const elapsed = Date.now() - this.started;
        this.setData({ loading: false, pollEnded: elapsed >= 30000, waited: elapsed >= 30000 });
        if (elapsed < 30000) this.timer = setTimeout(() => this.refresh(), Math.min(2000, 30000 - elapsed));
      }
    }
  },
  manualRefresh() { this.refresh(); },
  edit() {
    const message = this.data.message;
    if (!message || !message.roomIds || !message.roomIds.length) return;
    wx.navigateTo({ url: '/pages/publish/publish?roomId=' + encodeURIComponent(message.roomIds[0]) + '&editId=' + encodeURIComponent(message.id) });
  },
  remove() {
    if (this.data.busy) return;
    wx.showModal({ title: '删除这条公告？', content: '公告会立即从教室大屏移除，发布记录与投递回执仍会保留。', confirmText: '删除', confirmColor: '#A93230', success: async r => {
      if (!r.confirm) return; this.setData({ busy: true, error: '' });
      try { await api.request('/messages/' + this.data.id, { method: 'DELETE', scope: this.scope }); await this.refresh(); }
      catch (e) { if (!e.aborted) this.setData({ error: api.errorText(e) }); } finally { this.setData({ busy: false }); }
    } });
  },
  replay() {
    if (this.data.busy) return;
    if (this.replayPending) { this.sendReplay(); return; }
    wx.showActionSheet({ itemList: ['重新播报 1 遍', '重新播报 2 遍'], success: r => { this.replayPending = { clientToken: logic.token(), times: r.tapIndex + 1 }; this.sendReplay(); } });
  },
  async sendReplay() {
    this.setData({ busy: true, error: '' });
    try { await api.request('/messages/' + this.data.id + '/rebroadcast', { method: 'POST', data: this.replayPending, scope: this.scope }); this.replayPending = null; wx.showToast({ title: '重播任务已保存', icon: 'none' }); await this.refresh(); }
    catch (e) { if (!e.aborted) this.setData({ error: api.errorText(e) + '\n再次点击重播将原样重试同一任务。' }); }
    finally { this.setData({ busy: false }); }
  },
  copy() { const message = this.data.message; if (!message || !message.roomIds.length) return; getApp().globalData.copyMessage = message; wx.navigateTo({ url: '/pages/publish/publish?roomId=' + encodeURIComponent(message.roomIds[0]) }); },
  home() { wx.switchTab({ url: '/pages/home/home' }); }
});
