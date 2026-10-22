const api = require('../../utils/api');
const session = require('../../utils/session');
const logic = require('../../utils/logic');

function compareUnpinned(a, b) {
  const timeDiff = (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
  if (timeDiff) return timeDiff;
  const aIndex = Number.isInteger(a.sourceOrder) ? a.sourceOrder : 0;
  const bIndex = Number.isInteger(b.sourceOrder) ? b.sourceOrder : 0;
  return aIndex - bIndex;
}

function partitionMessages(messages) {
  const source = (messages || []).map((message, index) => Object.assign({}, message, {
    sourceOrder: Number.isInteger(message.sourceOrder) ? message.sourceOrder : index
  }));
  return source.filter(message => message.pinned)
    .concat(source.filter(message => !message.pinned).sort(compareUnpinned));
}

function decorateMessages(messages) {
  const ordered = partitionMessages(messages);
  const pinned = ordered.filter(message => message.pinned);
  return ordered.map(message => {
    const id = String(message.id || message.messageId || '');
    const view = logic.messageView(Object.assign({}, message, { id }));
    const title = view.recordTitle || view.title || view.targetNames || view.body || '学生提醒';
    const displayPosition = message.displayPosition === 'center' ? 'center' : 'top_right';
    const pinnedIndex = message.pinned ? pinned.findIndex(item => item.id === message.id) : -1;
    return Object.assign(view, {
      id,
      titleText: title,
      bodyText: view.recordInfo || '无补充内容',
      displayPosition,
      displayPositionLabel: displayPosition === 'center' ? '居中窗口' : '右上角浮窗',
      pinned: !!message.pinned,
      orderHint: message.pinned ? '置顶消息，可调整与其他置顶消息的先后' : '未置顶，始终按发布时间从新到旧排列',
      canMoveUp: pinnedIndex > 0,
      canMoveDown: pinnedIndex >= 0 && pinnedIndex < pinned.length - 1
    });
  });
}

Page({
  data: {
    rooms: [],
    roomIndex: 0,
    roomId: '',
    roomName: '',
    position: 'top_right',
    messages: [],
    pinnedCount: 0,
    loading: true,
    busy: false,
    dirty: false,
    error: '',
    notice: ''
  },

  async onLoad(query) {
    const auth = session.requireLogin();
    if (!auth) return;
    this.preferredRoomId = query && query.roomId ? String(query.roomId) : '';
    this.scope = 'arrange';
    this.visible = true;
    await this.loadRooms();
  },

  onUnload() {
    this.visible = false;
    api.abortScope(this.scope);
  },

  onPullDownRefresh() {
    this.loadSettings().finally(() => wx.stopPullDownRefresh());
  },

  async loadRooms() {
    this.setData({ loading: true, error: '', notice: '' });
    try {
      const result = await api.request('/rooms', { scope: this.scope });
      const rooms = result.items || [];
      if (!rooms.length) throw new Error('当前账号还没有可排序的教室');
      const preferred = rooms.findIndex(room => String(room.id) === this.preferredRoomId);
      const roomIndex = preferred >= 0 ? preferred : 0;
      this.setData({ rooms, roomIndex, roomId: String(rooms[roomIndex].id), roomName: rooms[roomIndex].name });
      await this.loadSettings();
    } catch (e) {
      if (!e.aborted) this.setData({ error: api.errorText(e) });
      this.setData({ loading: false });
    }
  },

  async roomChange(e) {
    if (this.data.busy) return;
    const roomIndex = Number(e.detail.value);
    const room = this.data.rooms[roomIndex];
    if (!room) return;
    this.setData({ roomIndex, roomId: String(room.id), roomName: room.name, dirty: false, notice: '' });
    await this.loadSettings();
  },

  async loadSettings() {
    if (!this.data.roomId) return;
    this.setData({ loading: true, error: '', notice: '' });
    try {
      const path = '/rooms/' + encodeURIComponent(this.data.roomId) + '/display-settings';
      const result = await api.request(path, { scope: this.scope });
      const normalized = logic.normalizeDisplaySettings(result);
      this.applyMessages(logic.orderDisplayMessages(normalized.messages, normalized));
      this.setData({ position: normalized.position, dirty: false });
    } catch (e) {
      if (!e.aborted) this.setData({ error: api.errorText(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyMessages(messages, patch) {
    const decorated = decorateMessages(messages);
    this.setData(Object.assign({
      messages: decorated,
      pinnedCount: decorated.filter(message => message.pinned).length
    }, patch || {}));
  },

  togglePin(e) {
    if (this.data.busy) return;
    const id = String(e.currentTarget.dataset.id);
    const messages = this.data.messages.map(message => message.id === id ? Object.assign({}, message, { pinned: !message.pinned }) : message);
    this.applyMessages(messages, { dirty: true, notice: '', error: '' });
  },

  moveMessage(index, offset) {
    if (this.data.busy) return;
    const messages = this.data.messages.slice();
    const current = messages[index];
    if (!current || !current.pinned) return;
    const pinned = messages.filter(message => message.pinned);
    const pinnedIndex = pinned.findIndex(message => message.id === current.id);
    const target = pinnedIndex + offset;
    if (pinnedIndex < 0 || target < 0 || target >= pinned.length) return;
    pinned[pinnedIndex] = pinned[target];
    pinned[target] = current;
    let cursor = 0;
    const reordered = messages.map(message => message.pinned ? pinned[cursor++] : message);
    this.applyMessages(reordered, { dirty: true, notice: '', error: '' });
  },

  moveUp(e) {
    this.moveMessage(Number(e.currentTarget.dataset.index), -1);
  },

  moveDown(e) {
    this.moveMessage(Number(e.currentTarget.dataset.index), 1);
  },

  async saveSettings() {
    if (this.data.busy || !this.data.roomId) return;
    this.setData({ busy: true, error: '', notice: '' });
    try {
      const path = '/rooms/' + encodeURIComponent(this.data.roomId) + '/display-settings';
      await api.request(path, {
        method: 'PUT',
        data: logic.displaySettingsPayload(this.data.roomId, this.data.position, this.data.messages),
        scope: this.scope
      });
      this.setData({ busy: false, dirty: false, notice: '置顶顺序已保存，大屏同步后应用；未置顶消息继续按发布时间排列。' });
      wx.showToast({ title: '置顶顺序已保存', icon: 'success' });
    } catch (e) {
      if (!e.aborted) this.setData({ busy: false, error: api.errorText(e) + '\n当前排序已保留，可再次保存。' });
    }
  },

  retry() {
    this.loadSettings();
  }
});
