const api = require('../../utils/api');
const session = require('../../utils/session');
const logic = require('../../utils/logic');

function normalizePosition(value) {
  return value === 'center' ? 'center' : 'top_right';
}

function unique(values) {
  const result = [];
  (Array.isArray(values) ? values : []).forEach(value => {
    const id = String(value || '');
    if (id && !result.includes(id)) result.push(id);
  });
  return result;
}

Page({
  data: {
    roomId: '', rooms: [], otherRooms: [], roomName: '', lockedRoomNames: '', roomIds: [],
    type: 'call', displayPosition: 'top_right', editing: false, editId: '',
    title: '', destination: '', body: '', broadcastTimes: 0,
    broadcastOptions: ['不播报', '播报 1 遍', '播报 2 遍'],
    students: [], selected: [], audienceMode: '待选择', classes: [], classIndex: 0,
    search: '', filtered: [], drawer: false, loading: true, busy: false, error: '',
    more: false, scheduled: false, startDate: '', startTime: '', expireDate: '', expireTime: '',
    restored: false, ready: false
  },
  async onLoad(query) {
    const auth = session.requireLogin();
    if (!auth) return;
    const params = query || {};
    this.userId = auth.teacher.id;
    this.currentRoom = params.roomId ? String(params.roomId) : '';
    this.editId = params.editId ? String(params.editId) : '';
    this.pending = null;
    this.unloaded = false;
    const start = logic.schoolParts(Date.now());
    const editing = !!this.editId;
    const type = editing ? 'call' : (wx.getStorageSync('notice-type:' + this.userId + ':' + this.currentRoom) || 'call');
    this.setData(Object.assign({
      editing,
      editId: this.editId,
      type,
      displayPosition: 'top_right',
      startDate: start.date,
      startTime: start.time
    }, logic.defaults(type)));
    await this.load();
  },
  onHide() { this.saveDraft(); },
  onUnload() { this.saveDraft(); this.unloaded = true; api.abortScope('publish'); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const me = await api.request('/me', { scope: 'publish' });
      if (me.status !== 'active') throw new Error('当前账号尚未获得发布权限，请联系管理员');
      const response = await api.request('/rooms', { scope: 'publish' });
      let message = null;
      if (this.editId) {
        message = await api.request('/messages/' + encodeURIComponent(this.editId), { scope: 'publish' });
        const rawRoomIds = unique(message.roomIds);
        if (!rawRoomIds.length) throw new Error('公告缺少目标教室，无法编辑');
        const inaccessible = rawRoomIds.filter(id => !response.items.some(room => room.id === id));
        if (inaccessible.length) throw new Error('部分目标教室已无权限，无法编辑这条公告');
        this.currentRoom = rawRoomIds[0];
      }
      const room = response.items.find(item => item.id === this.currentRoom);
      if (!room) {
        session.clearDrafts(this.userId);
        throw new Error('该教室已无权限，请返回班级重新选择');
      }
      const roomIds = message ? unique(message.roomIds) : [room.id];
      this.setData({ rooms: response.items, roomId: room.id, roomIds, roomName: room.name });
      await this.loadRoster(room.id);
      if (message) {
        this.populateEdit(message);
        this.setData({ ready: true });
        this.filterStudents();
        this.syncRoomChecks();
        return;
      }
      let draft = wx.getStorageSync(session.key(this.userId, room.id));
      const copied = getApp().globalData.copyMessage;
      if (copied) {
        getApp().globalData.copyMessage = null;
        draft = {
          savedAt: Date.now(),
          form: Object.assign(logic.defaults(copied.type), {
            type: copied.type,
            title: copied.type === 'notice' ? copied.title || '' : '',
            destination: copied.destination || (copied.type !== 'notice' && copied.title.includes(' · 到 ') ? copied.title.split(' · 到 ').slice(1).join(' · 到 ') : ''),
            body: copied.body || '',
            roomIds: copied.roomIds,
            displayPosition: copied.displayPosition,
            scheduled: false
          }),
          selectedIds: (copied.targets || []).map(target => target.studentId)
        };
      }
      if (draft && Date.now() - draft.savedAt <= 86400000) {
        const draftType = ['call', 'batch', 'notice'].includes(draft.form.type) ? draft.form.type : this.data.type;
        const rawRoomIds = unique(draft.form.roomIds);
        const accessibleRoomIds = rawRoomIds.filter(id => response.items.some(item => item.id === id));
        const ids = draftType === 'notice'
          ? unique([room.id].concat(accessibleRoomIds)).slice(0, 20)
          : [room.id];
        const selectedIds = Array.isArray(draft.selectedIds) ? draft.selectedIds : [];
        const selected = this.data.students.filter(student => selectedIds.includes(student.id));
        const validTargets = accessibleRoomIds.length === rawRoomIds.length && selected.length === selectedIds.length;
        const saved = Object.assign({}, logic.defaults(draftType), draft.form, {
          type: draftType,
          roomIds: ids,
          selected,
          displayPosition: normalizePosition(draft.form.displayPosition),
          restored: true
        });
        this.setData(saved);
        if (validTargets && draft.pending) this.pending = draft.pending;
        if (!validTargets) this.setData({ error: '草稿中的部分学生或教室已无权限，已移除，请核对后再发布。' });
      }
      this.setData({ ready: true });
      this.filterStudents();
      this.syncRoomChecks();
    } catch (e) {
      if (!e.aborted) this.setData({ error: api.errorText(e), ready: false });
    } finally {
      this.setData({ loading: false });
    }
  },
  populateEdit(message) {
    const type = ['call', 'batch', 'notice'].includes(message.type) ? message.type : 'call';
    const startAt = Date.parse(message.startAt);
    const expireAt = Date.parse(message.expireAt);
    const start = Number.isFinite(startAt) ? logic.schoolParts(startAt) : logic.schoolParts(Date.now());
    const end = Number.isFinite(expireAt) ? logic.schoolParts(expireAt) : logic.defaults(type);
    const targetIds = (message.targets || []).map(target => String(target.studentId || ''));
    const selected = type === 'notice' ? [] : targetIds.map(id => {
      const current = this.data.students.find(student => student.id === id);
      if (current) return current;
      const target = (message.targets || []).find(item => String(item.studentId || '') === id) || {};
      const studentNo = String(target.studentNoSuffix || '');
      return { id, name: target.name || '已停用学生', className: target.className || '', studentNo, suffix: studentNo.slice(-4) };
    });
    this.setData(Object.assign({}, logic.defaults(type), {
      type,
      title: message.title || '',
      destination: message.destination || '',
      body: message.body || '',
      broadcastTimes: message.broadcast ? Number(message.broadcast.times) || 0 : 0,
      roomIds: unique(message.roomIds),
      selected,
      scheduled: Number.isFinite(startAt) && startAt > Date.now() + 1000,
      startDate: start.date,
      startTime: start.time,
      expireDate: end.date,
      expireTime: end.time,
      displayPosition: normalizePosition(message.displayPosition || message.position),
      restored: false
    }));
  },
  async loadRoster(roomId) {
    const result = await api.request('/classes?roomId=' + encodeURIComponent(roomId), { scope: 'publish' });
    const students = [];
    for (const cls of result.items) {
      let cursor = '';
      do {
        const page = await api.request('/students?classId=' + encodeURIComponent(cls.id) + '&limit=100&cursor=' + encodeURIComponent(cursor), { scope: 'publish' });
        page.items.forEach(student => {
          const studentNo = String(student.studentNo || '');
          students.push(Object.assign({}, student, { studentNo, suffix: studentNo.slice(-4) }));
        });
        cursor = page.nextCursor || '';
      } while (cursor);
    }
    this.setData({ students, classes: [{ id: '', name: '全部班级' }].concat(result.items), classIndex: 0, search: '' });
  },
  syncRoomChecks() {
    const rooms = this.data.rooms.map(room => Object.assign({}, room, { checked: this.data.roomIds.includes(room.id) }));
    const lockedRoomNames = rooms.filter(room => room.id !== this.data.roomId && this.data.roomIds.includes(room.id)).map(room => room.name).join('、');
    this.setData({ rooms, otherRooms: rooms.filter(room => room.id !== this.data.roomId), lockedRoomNames });
  },
  changed(patch) {
    if (this.data.busy) return;
    const next = Object.assign({}, patch);
    if (next.roomIds) {
      const nextType = next.type || this.data.type;
      const roomIds = unique(next.roomIds);
      next.roomIds = nextType === 'notice'
        ? unique([this.data.roomId].concat(roomIds)).slice(0, 20)
        : [this.data.roomId];
    }
    this.pending = null;
    this.setData(Object.assign({ error: '' }, next));
    if (next.roomIds) this.syncRoomChecks();
    this.saveDraft();
  },
  input(e) { this.changed({ [e.currentTarget.dataset.field]: e.detail.value }); },
  timeChange(e) { this.changed({ [e.currentTarget.dataset.field]: e.detail.value }); },
  scheduleChange(e) { this.changed({ scheduled: e.detail.value }); },
  broadcastChange(e) { this.changed({ broadcastTimes: Number(e.detail.value) }); },
  choosePosition(e) {
    const displayPosition = normalizePosition(e.currentTarget.dataset.value);
    if (displayPosition !== this.data.displayPosition) this.changed({ displayPosition });
  },
  toggleMore() { this.setData({ more: !this.data.more }); },
  chooseType(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.type) return;
    if (this.data.editing && type !== 'notice' && this.data.roomIds.length > 1) {
      wx.showToast({ title: '多教室通知不能改为单教室类型', icon: 'none' });
      return;
    }
    const apply = () => {
      const patch = Object.assign({ type }, logic.defaults(type, this.data.scheduled ? Date.parse(logic.toISO(this.data.startDate, this.data.startTime)) : Date.now()));
      if (type === 'notice') {
        patch.selected = [];
      } else {
        if (!this.data.editing) patch.roomIds = [this.data.roomId];
        if (type === 'call') patch.selected = this.data.selected.slice(0, 3);
      }
      this.changed(patch);
      this.filterStudents();
    };
    if ((type === 'notice' && this.data.selected.length) || (type === 'call' && this.data.selected.length > 3) || (!this.data.editing && type !== 'notice' && this.data.roomIds.length > 1)) {
      wx.showModal({ title: '切换公告类型', content: '将清除不适用的学生选择或多教室设置，其他输入会保留。', success: result => { if (result.confirm) apply(); } });
    } else {
      apply();
    }
  },
  switchRoom() {
    if (this.data.editing) {
      wx.showToast({ title: '编辑时不能更改目标教室', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: this.data.rooms.map(room => room.name),
      success: result => {
        const room = this.data.rooms[result.tapIndex];
        if (!room || room.id === this.data.roomId) return;
        wx.showModal({
          title: '切换目标教室？',
          content: '已选学生将清空，当前教室草稿会保存。',
          success: async modal => {
            if (!modal.confirm) return;
            this.saveDraft();
            this.pending = null;
            this.currentRoom = room.id;
            this.setData({ loading: true, ready: false, selected: [], roomId: room.id, roomIds: [room.id], roomName: room.name, restored: false });
            try {
              await this.loadRoster(room.id);
              this.setData({ ready: true });
              this.filterStudents();
              this.syncRoomChecks();
              this.saveDraft();
            } catch (e) {
              this.setData({ error: api.errorText(e) });
            } finally {
              this.setData({ loading: false });
            }
          }
        });
      }
    });
  },
  toggleRoom(e) {
    if (this.data.editing) return;
    const id = String(e.currentTarget.dataset.id || '');
    if (id === this.data.roomId) {
      wx.showToast({ title: '当前教室无需重复选择', icon: 'none' });
      return;
    }
    const roomIds = this.data.roomIds.slice();
    const index = roomIds.indexOf(id);
    if (index >= 0) roomIds.splice(index, 1);
    else if (roomIds.length < 20) roomIds.push(id);
    else {
      wx.showToast({ title: '一次最多选择20间', icon: 'none' });
      return;
    }
    this.changed({ roomIds });
  },
  openDrawer() { this.setData({ drawer: true }); this.filterStudents(); },
  closeDrawer() { this.setData({ drawer: false }); },
  noop() {},
  searchInput(e) { this.setData({ search: e.detail.value }); this.filterStudents(); },
  classChange(e) { this.setData({ classIndex: Number(e.detail.value) }); this.filterStudents(); },
  filterStudents() {
    const q = this.data.search.trim().toLowerCase();
    const cls = this.data.classes[this.data.classIndex];
    const ids = this.data.selected.map(student => student.id);
    const audienceMode = !this.data.selected.length ? '待选择' : this.data.selected.length === 1 ? '个人' : '多人';
    this.setData({
      audienceMode,
      selectedNames: this.data.selected.map(student => student.name).join('、'),
      filtered: this.data.students.filter(student => (!cls || !cls.id || student.classId === cls.id) && (!q || student.name.toLowerCase().includes(q) || student.studentNo.toLowerCase().includes(q))).map(student => Object.assign({}, student, { checked: ids.includes(student.id) }))
    });
  },
  toggleStudent(e) {
    const id = e.currentTarget.dataset.id;
    const selected = this.data.selected.slice();
    const index = selected.findIndex(student => student.id === id);
    if (index >= 0) selected.splice(index, 1);
    else {
      const max = this.data.type === 'call' ? 3 : 60;
      if (selected.length >= max) {
        wx.showToast({ title: '此类型最多选择' + max + '人', icon: 'none' });
        return;
      }
      const found = this.data.students.find(student => student.id === id);
      if (found) selected.push(found);
    }
    this.changed({ selected });
    this.filterStudents();
  },
  selectFiltered() {
    const selected = this.data.selected.slice();
    const max = this.data.type === 'call' ? 3 : 60;
    this.data.filtered.forEach(student => {
      if (!selected.some(item => item.id === student.id)) selected.push(student);
    });
    if (selected.length > max) {
      wx.showToast({ title: '当前筛选超过' + max + '人，请缩小范围', icon: 'none' });
      return;
    }
    this.changed({ selected });
    this.filterStudents();
  },
  saveDraft() {
    if (this.data.editing || !this.userId || !this.data.ready || this.published) return;
    const auth = session.read();
    if (!auth || auth.teacher.id !== this.userId) return;
    const form = {};
    ['type', 'displayPosition', 'title', 'destination', 'body', 'broadcastTimes', 'roomIds', 'scheduled', 'startDate', 'startTime', 'expireDate', 'expireTime'].forEach(key => { form[key] = this.data[key]; });
    wx.setStorageSync(session.key(this.userId, this.data.roomId), { savedAt: Date.now(), form, selectedIds: this.data.selected.map(student => student.id), pending: this.pending });
  },
  async submit() {
    if (this.data.busy || !this.data.ready) return;
    let payload = this.pending;
    if (payload) {
      const payloadType = payload.type || this.data.type;
      const roomIds = payloadType === 'notice'
        ? unique([this.data.roomId].concat(payload.roomIds)).slice(0, 20)
        : [this.data.roomId];
      payload = Object.assign({}, payload, {
        roomIds,
        displayPosition: normalizePosition(payload.displayPosition || this.data.displayPosition)
      });
      this.pending = payload;
    }
    if (!payload) {
      const roomIds = this.data.type === 'notice'
        ? unique([this.data.roomId].concat(this.data.roomIds)).slice(0, 20)
        : [this.data.roomId];
      payload = {
        clientToken: logic.token(),
        type: this.data.type,
        displayPosition: normalizePosition(this.data.displayPosition),
        roomIds,
        studentIds: this.data.type === 'notice' ? [] : this.data.selected.map(student => student.id),
        title: this.data.type === 'notice' ? this.data.title.trim() : '',
        destination: this.data.type === 'notice' ? '' : this.data.destination.trim(),
        body: this.data.body.trim(),
        broadcastTimes: this.data.type === 'notice' ? 0 : this.data.broadcastTimes,
        startAt: this.data.scheduled ? logic.toISO(this.data.startDate, this.data.startTime) : new Date().toISOString(),
        expireAt: logic.toISO(this.data.expireDate, this.data.expireTime)
      };
      const errors = logic.validateMessage(payload);
      const noDevice = this.data.rooms.filter(room => roomIds.includes(room.id) && !room.deviceCount);
      if (noDevice.length) errors.push(noDevice.map(room => room.name).join('、') + '尚未绑定设备，请先由管理员生成绑定码并绑定大屏');
      if (errors.length) {
        this.setData({ error: errors.join('\n') });
        return;
      }
      this.pending = payload;
      this.saveDraft();
    }
    this.setData({ busy: true, error: '' });
    try {
      const path = this.data.editing ? '/messages/' + encodeURIComponent(this.editId) + '/update' : '/messages';
      const result = await api.request(path, { method: 'POST', data: payload, scope: 'publish' });
      this.published = true;
      if (!this.data.editing) {
        wx.removeStorageSync(session.key(this.userId, this.data.roomId));
        wx.setStorageSync('notice-type:' + this.userId + ':' + this.data.roomId, this.data.type);
      }
      const id = result && result.id ? result.id : this.editId;
      wx.redirectTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
    } catch (e) {
      if (e.status === 403) {
        this.setData({ ready: false });
        session.clearDrafts(this.userId);
      }
      if (!e.aborted) {
        const retry = this.data.editing ? '表单已保留，可直接重试。' : '表单已保留。未修改内容时再次点击会使用同一凭证原样重试。';
        this.setData({ error: api.errorText(e) + '\n' + retry });
      }
    } finally {
      this.setData({ busy: false });
    }
  }
});
