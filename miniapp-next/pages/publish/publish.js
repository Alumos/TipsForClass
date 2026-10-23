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

function normalizeClasses(value) {
  return (Array.isArray(value) ? value : []).map(item => Object.assign({}, item, { id: String(item.id || '') })).filter(item => item.id);
}

Page({
  data: {
    classId: '', classIds: [], className: '', targetClasses: [], otherClasses: [], lockedClassNames: '',
    type: 'call', displayPosition: 'top_right', editing: false, editId: '',
    minuteOptions: ['1 分钟', '3 分钟', '5 分钟', '10 分钟', '15 分钟', '30 分钟'],
    minuteValues: [1, 3, 5, 10, 15, 30], minuteIndex: 0,
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
    this.currentClass = params.classId ? String(params.classId) : '';
    this.editId = params.editId ? String(params.editId) : '';
    this.pending = null;
    this.unloaded = false;
    const start = logic.schoolParts(Date.now());
    const editing = !!this.editId;
    const type = editing ? 'call' : (wx.getStorageSync('notice-type:' + this.userId + ':' + this.currentClass) || 'call');
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
      const response = await api.request('/classes', { scope: 'publish' });
      const classes = normalizeClasses(response.items);
      let message = null;
      if (this.editId) {
        message = await api.request('/messages/' + encodeURIComponent(this.editId), { scope: 'publish' });
        const rawClassIds = unique(message.classIds);
        if (!rawClassIds.length) throw new Error('公告缺少目标班级，无法编辑');
        const inaccessible = rawClassIds.filter(id => !classes.some(cls => cls.id === id));
        if (inaccessible.length) throw new Error('部分目标班级已无权限，无法编辑这条公告');
        this.currentClass = rawClassIds[0];
      }
      const current = classes.find(item => item.id === this.currentClass);
      if (!current) {
        session.clearDrafts(this.userId);
        throw new Error('该班级已无权限，请返回班级重新选择');
      }
      const classIds = message ? unique(message.classIds) : [current.id];
      this.setData({ targetClasses: classes, classId: current.id, classIds, className: current.name });
      await this.loadRoster(classes);
      if (message) {
        this.populateEdit(message);
        this.setData({ ready: true });
        this.filterStudents();
        this.syncClassChecks();
        return;
      }
      let draft = wx.getStorageSync(session.key(this.userId, current.id));
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
            classIds: unique(copied.classIds),
            displayPosition: copied.displayPosition,
            scheduled: false
          }),
          selectedIds: (copied.targets || []).map(target => target.studentId)
        };
      }
      // 旧缓存可能缺少字段或采用旧结构，一律按“可安全忽略”处理，必要时退回当前班级。
      const form = draft && draft.form && typeof draft.form === 'object' ? draft.form : null;
      if (form && Date.now() - Number(draft.savedAt || 0) <= 86400000) {
        const draftType = ['call', 'batch', 'notice'].includes(form.type) ? form.type : this.data.type;
        const rawClassIds = unique(form.classIds);
        const accessibleClassIds = rawClassIds.filter(id => classes.some(item => item.id === id));
        const ids = draftType === 'notice'
          ? unique([current.id].concat(accessibleClassIds)).slice(0, 20)
          : [current.id];
        const selectedIds = Array.isArray(draft.selectedIds) ? draft.selectedIds : [];
        const selected = this.data.students.filter(student => selectedIds.includes(student.id));
        const validTargets = accessibleClassIds.length === rawClassIds.length && selected.length === selectedIds.length;
        const saved = Object.assign({}, logic.defaults(draftType), form, {
          type: draftType,
          classIds: ids,
          selected,
          displayPosition: normalizePosition(form.displayPosition),
          restored: true
        });
        this.setData(saved);
        if (validTargets && draft.pending) this.pending = draft.pending;
        if (!validTargets) this.setData({ error: '草稿中的部分学生或班级已无权限，已移除，请核对后再发布。' });
      }
      this.setData({ ready: true });
      this.filterStudents();
      this.syncClassChecks();
    } catch (e) {
      if (!e.aborted) this.setData({ error: api.errorText(e), ready: false });
    } finally {
      this.setData({ loading: false });
    }
  },
  chooseMinutes(e) {
    this.setData({ minuteIndex: Number(e.detail.value) || 0 });
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
      classIds: unique(message.classIds),
      selected,
      scheduled: Number.isFinite(startAt) && startAt > Date.now() + 1000,
      startDate: start.date,
      startTime: start.time,
      expireDate: end.date,
      expireTime: end.time,
      displayPosition: normalizePosition(message.displayPosition || message.position),
      minuteIndex: Math.max(0, this.data.minuteValues.indexOf(Number(message.displayMinutes) || 1)),
      restored: false
    }));
  },
  async loadRoster(classes) {
    const students = [];
    for (const cls of classes) {
      let cursor = '';
      do {
        const page = await api.request('/students?classId=' + encodeURIComponent(cls.id) + '&limit=100&cursor=' + encodeURIComponent(cursor), { scope: 'publish' });
        (page.items || []).forEach(student => {
          const studentNo = String(student.studentNo || '');
          students.push(Object.assign({}, student, { studentNo, suffix: studentNo.slice(-4) }));
        });
        cursor = page.nextCursor || '';
      } while (cursor);
    }
    this.setData({ students, classes: [{ id: '', name: '全部班级' }].concat(classes), classIndex: 0, search: '' });
  },
  syncClassChecks() {
    const targets = this.data.targetClasses.map(item => Object.assign({}, item, { checked: this.data.classIds.includes(item.id) }));
    const lockedClassNames = targets.filter(item => item.id !== this.data.classId && this.data.classIds.includes(item.id)).map(item => item.name).join('、');
    this.setData({ targetClasses: targets, otherClasses: targets.filter(item => item.id !== this.data.classId), lockedClassNames });
  },
  changed(patch) {
    if (this.data.busy) return;
    const next = Object.assign({}, patch);
    if (next.classIds) {
      const nextType = next.type || this.data.type;
      const classIds = unique(next.classIds);
      next.classIds = nextType === 'notice'
        ? unique([this.data.classId].concat(classIds)).slice(0, 20)
        : [this.data.classId];
    }
    this.pending = null;
    this.setData(Object.assign({ error: '' }, next));
    if (next.classIds) this.syncClassChecks();
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
    if (this.data.editing && type !== 'notice' && this.data.classIds.length > 1) {
      wx.showToast({ title: '多班级通知不能改为单班级类型', icon: 'none' });
      return;
    }
    const apply = () => {
      const patch = Object.assign({ type }, logic.defaults(type, this.data.scheduled ? Date.parse(logic.toISO(this.data.startDate, this.data.startTime)) : Date.now()));
      if (type === 'notice') {
        patch.selected = [];
      } else {
        if (!this.data.editing) patch.classIds = [this.data.classId];
        if (type === 'call') patch.selected = this.data.selected.slice(0, 3);
      }
      this.changed(patch);
      this.filterStudents();
    };
    if ((type === 'notice' && this.data.selected.length) || (type === 'call' && this.data.selected.length > 3) || (!this.data.editing && type !== 'notice' && this.data.classIds.length > 1)) {
      wx.showModal({ title: '切换公告类型', content: '将清除不适用的学生选择或多班级设置，其他输入会保留。', success: result => { if (result.confirm) apply(); } });
    } else {
      apply();
    }
  },
  switchClass() {
    if (this.data.editing) {
      wx.showToast({ title: '编辑时不能更改目标班级', icon: 'none' });
      return;
    }
    const options = this.data.targetClasses.filter(item => item.id !== this.data.classId);
    if (!options.length) {
      wx.showToast({ title: '没有其他可切换的班级', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: options.map(item => item.name),
      success: result => {
        const target = options[result.tapIndex];
        if (!target || target.id === this.data.classId) return;
        wx.showModal({
          title: '切换目标班级？',
          content: '已选学生将清空，当前班级草稿会保存。',
          success: modal => {
            if (!modal.confirm) return;
            this.saveDraft();
            this.pending = null;
            this.currentClass = target.id;
            this.setData({ selected: [], classId: target.id, classIds: [target.id], className: target.name, classIndex: 0, restored: false });
            this.filterStudents();
            this.syncClassChecks();
            this.saveDraft();
          }
        });
      }
    });
  },
  toggleClass(e) {
    if (this.data.editing) return;
    const id = String(e.currentTarget.dataset.id || '');
    if (id === this.data.classId) {
      wx.showToast({ title: '当前班级无需重复选择', icon: 'none' });
      return;
    }
    const classIds = this.data.classIds.slice();
    const index = classIds.indexOf(id);
    if (index >= 0) classIds.splice(index, 1);
    else if (classIds.length < 20) classIds.push(id);
    else {
      wx.showToast({ title: '一次最多选择20个', icon: 'none' });
      return;
    }
    this.changed({ classIds });
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
    ['type', 'displayPosition', 'title', 'destination', 'body', 'broadcastTimes', 'classIds', 'scheduled', 'startDate', 'startTime', 'expireDate', 'expireTime'].forEach(key => { form[key] = this.data[key]; });
    wx.setStorageSync(session.key(this.userId, this.data.classId), { savedAt: Date.now(), form, selectedIds: this.data.selected.map(student => student.id), pending: this.pending });
  },
  async submit() {
    if (this.data.busy || !this.data.ready) return;
    let payload = this.pending;
    if (payload) {
      const payloadType = payload.type || this.data.type;
      const classIds = payloadType === 'notice'
        ? unique([this.data.classId].concat(payload.classIds)).slice(0, 20)
        : [this.data.classId];
      payload = Object.assign({}, payload, {
        classIds,
        displayPosition: normalizePosition(payload.displayPosition || this.data.displayPosition)
      });
      this.pending = payload;
    }
    if (!payload) {
      const classIds = this.data.type === 'notice'
        ? unique([this.data.classId].concat(this.data.classIds)).slice(0, 20)
        : [this.data.classId];
      payload = {
        clientToken: logic.token(),
        type: this.data.type,
        displayPosition: normalizePosition(this.data.displayPosition),
        // 只有非默认值才下发，旧服务端不认识该字段会直接 400。
        ...(this.data.minuteValues[this.data.minuteIndex] > 1 ? { displayMinutes: this.data.minuteValues[this.data.minuteIndex] } : {}),
        classIds,
        studentIds: this.data.type === 'notice' ? [] : this.data.selected.map(student => student.id),
        title: this.data.type === 'notice' ? this.data.title.trim() : '',
        destination: this.data.type === 'notice' ? '' : this.data.destination.trim(),
        body: this.data.body.trim(),
        broadcastTimes: this.data.type === 'notice' ? 0 : this.data.broadcastTimes,
        startAt: this.data.scheduled ? logic.toISO(this.data.startDate, this.data.startTime) : new Date().toISOString(),
        expireAt: logic.toISO(this.data.expireDate, this.data.expireTime)
      };
      const errors = logic.validateMessage(payload);
      const noDevice = this.data.targetClasses.filter(cls => classIds.includes(cls.id) && !cls.deviceCount);
      if (noDevice.length) errors.push(noDevice.map(cls => cls.name).join('、') + '尚未绑定设备，请先由管理员生成绑定码并绑定大屏');
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
        wx.removeStorageSync(session.key(this.userId, this.data.classId));
        wx.setStorageSync('notice-type:' + this.userId + ':' + this.data.classId, this.data.type);
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
