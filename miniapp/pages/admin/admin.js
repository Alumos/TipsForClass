const api = require('../../utils/api');
const session = require('../../utils/session');
const logic = require('../../utils/logic');

function normalizeRosterPreview(value) {
  const source = value || {};
  const errors = Array.isArray(source.errors) ? source.errors.map(error => {
    if (typeof error === 'string') return { row: '', message: error };
    const item = error || {};
    return {
      row: item.row === undefined ? '' : item.row,
      message: item.message || '名册格式有误'
    };
  }) : [];
  const rows = Array.isArray(source.rows) ? source.rows.map((value, index) => {
    const row = value || {};
    return {
      studentNo: String(row.studentNo === undefined || row.studentNo === null ? '' : row.studentNo),
      name: String(row.name === undefined || row.name === null ? '' : row.name),
      row: row.row === undefined ? index + 1 : row.row
    };
  }) : [];
  return Object.assign({}, source, {
    importId: source.importId || '',
    valid: source.valid === true && errors.length === 0,
    rows,
    displayRows: rows.slice(0, 100),
    hiddenRowCount: Math.max(0, rows.length - 100),
    errors,
    newCount: Number(source.newCount || 0),
    updateCount: Number(source.updateCount || 0)
  });
}

Page({
  data: {
    section: 'rooms',
    loading: false,
    busy: false,
    error: '',
    rooms: [],
    teachers: [],
    devices: [],
    roomIndex: 0,
    selectedRoomName: '',
    classes: [],
    classIndex: 0,
    selectedClassName: '',
    roomName: '',
    className: '',
    bindCode: null,
    csv: '',
    csvReady: false,
    xlsxPath: '',
    xlsxName: '',
    xlsxSizeLabel: '',
    preview: null,
    settings: { schoolName: '', timezone: 'Asia/Shanghai' },
    quietRules: [],
    editor: null,
    classEditor: null,
    roleOptions: ['教师', '管理员'],
    statusOptions: ['待审核', '已通过', '停用'],
    teacherRooms: [],
    sharedTeacherText: '暂无其他已授权教师',
    sharedTeacherCount: 0,
    notice: ''
  },

  onLoad() {
    if (session.requireLogin()) this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const me = await api.request('/me');
      if (me.role !== 'admin' || me.status !== 'active') throw new Error('管理页面仅对已通过审核的管理员开放');
      this.currentUserId = String(me.id);
      const result = await Promise.all([
        api.request('/rooms'),
        api.request('/admin/teachers'),
        api.request('/admin/devices'),
        api.request('/admin/settings')
      ]);
      const rooms = (result[0].items || []).map(room => Object.assign({}, room, { id: String(room.id) }));
      const teachers = (result[1].items || []).map(teacher => Object.assign({}, teacher, {
        id: String(teacher.id),
        roomIds: Array.isArray(teacher.roomIds) ? teacher.roomIds.map(String) : [],
        roleLabel: teacher.role === 'admin' ? '管理员' : '教师',
        statusLabel: { pending: '待审核', active: '已通过', disabled: '已停用' }[teacher.status] || teacher.status
      }));
      const roomIndex = Math.min(this.data.roomIndex, Math.max(0, rooms.length - 1));
      this.setData({
        rooms,
        teachers,
        devices: (result[2].items || []).map(device => Object.assign({}, device, { lastSeenLabel: logic.formatTime(device.lastSeenAt) })),
        settings: result[3],
        quietRules: (result[3].quietHours || []).map(rule => ({ daysText: rule.days.join(','), start: rule.start, end: rule.end })),
        roomIndex,
        selectedRoomName: rooms[roomIndex] ? rooms[roomIndex].name : ''
      });
      this.updateSharedTeachers();
      await this.loadClasses();
    } catch (e) {
      this.setData({ error: api.errorText(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  section(e) {
    this.setData({ section: e.currentTarget.dataset.section, error: '', notice: '' });
  },

  input(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    const patch = { [field]: value };
    if (field === 'csv') {
      patch.preview = null;
      patch.csvReady = Boolean(String(value || '').trim());
    }
    this.setData(patch);
  },

  async roomChange(e) {
    const roomIndex = Number(e.detail.value);
    const room = this.data.rooms[roomIndex];
    this.setData({
      roomIndex,
      selectedRoomName: room ? room.name : '',
      selectedClassName: '请先在教室中创建班级',
      preview: null,
      bindCode: null,
      xlsxPath: '',
      xlsxName: '',
      xlsxSizeLabel: '',
      classEditor: null
    });
    this.updateSharedTeachers();
    try {
      await this.loadClasses();
    } catch (error) {
      this.setData({ error: api.errorText(error) });
    }
  },

  async loadClasses() {
    const room = this.data.rooms[this.data.roomIndex];
    if (!room) {
      this.setData({ classes: [], classIndex: 0, selectedClassName: '', preview: null });
      return;
    }
    const result = await api.request('/classes?roomId=' + encodeURIComponent(room.id));
    const classes = (result.items || []).map(item => Object.assign({}, item, {
      id: String(item.id),
      roomId: String(item.roomId || room.id)
    }));
    this.setData({
      selectedRoomName: room.name,
      classes,
      classIndex: 0,
      selectedClassName: classes.length ? classes[0].name : '请先在教室中创建班级',
      preview: null
    });
  },

  classChange(e) {
    const classIndex = Number(e.detail.value);
    const cls = this.data.classes[classIndex];
    this.setData({
      classIndex,
      selectedClassName: cls ? cls.name : '',
      preview: null,
      xlsxPath: '',
      xlsxName: '',
      xlsxSizeLabel: ''
    });
  },

  updateSharedTeachers() {
    const room = this.data.rooms[this.data.roomIndex];
    if (!room) {
      this.setData({ sharedTeacherText: '暂无其他已授权教师', sharedTeacherCount: 0 });
      return;
    }
    const names = this.data.teachers
      .filter(teacher => teacher.status === 'active' && Array.isArray(teacher.roomIds) && teacher.roomIds.includes(room.id))
      .map(teacher => teacher.name)
      .filter(Boolean);
    this.setData({ sharedTeacherText: names.length ? names.join('、') : '暂无其他已授权教师', sharedTeacherCount: names.length });
  },

  async action(fn) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '', notice: '' });
    try {
      await fn();
    } catch (e) {
      this.setData({ error: api.errorText(e) });
    } finally {
      this.setData({ busy: false });
    }
  },

  createRoom() {
    return this.action(async () => {
      if (!this.data.roomName.trim()) throw new Error('请填写教室名称');
      await api.request('/admin/rooms', { method: 'POST', data: { name: this.data.roomName.trim() } });
      this.setData({ roomName: '', notice: '教室已创建' });
      await this.load();
    });
  },

  createClass() {
    return this.action(async () => {
      const room = this.data.rooms[this.data.roomIndex];
      if (!room || !this.data.className.trim()) throw new Error('请选择教室并填写班级名称');
      await api.request('/admin/classes', { method: 'POST', data: { name: this.data.className.trim(), roomId: room.id } });
      this.setData({ className: '', notice: '班级已创建；同一教室的授权教师会共享该班级名册' });
      await this.loadClasses();
    });
  },

  editClass(e) {
    const cls = this.data.classes.find(item => item.id === String(e.currentTarget.dataset.id));
    if (!cls) return;
    const originalRoomId = String(cls.roomId || (this.data.rooms[this.data.roomIndex] || {}).id || '');
    const roomIndex = Math.max(0, this.data.rooms.findIndex(room => room.id === originalRoomId));
    const room = this.data.rooms[roomIndex];
    this.setData({
      classEditor: Object.assign({}, cls, {
        originalRoomId,
        roomIndex,
        roomName: room ? room.name : '请选择教室'
      })
    });
  },

  classEditorInput(e) {
    this.setData({ ['classEditor.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  classRoomChange(e) {
    const roomIndex = Number(e.detail.value);
    const room = this.data.rooms[roomIndex];
    this.setData({ 'classEditor.roomIndex': roomIndex, 'classEditor.roomName': room ? room.name : '请选择教室' });
  },

  closeClassEditor() {
    if (!this.data.busy) this.setData({ classEditor: null });
  },

  saveClass() {
    if (this.data.busy || !this.data.classEditor) return;
    const editor = this.data.classEditor;
    const name = String(editor.name || '').trim();
    const room = this.data.rooms[editor.roomIndex];
    if (!name) {
      this.setData({ error: '请填写班级名称' });
      return;
    }
    if (!room) {
      this.setData({ error: '请选择班级所属教室' });
      return;
    }
    const moved = room.id !== editor.originalRoomId;
    const persist = confirmImpact => this.action(async () => {
      await api.request('/admin/classes/' + encodeURIComponent(editor.id) + '/update', {
        method: 'POST',
        data: { name, roomId: room.id, confirmImpact }
      });
      this.setData({ classEditor: null, notice: moved ? '班级已编辑并移动；原有公告不会迁移' : '班级名称已更新' });
      await this.loadClasses();
    });
    if (moved) {
      wx.showModal({
        title: '移动班级？',
        content: '移动后，该班学生将归入新教室。同一教室的多位授权教师会共享变更后的班级名册，历史公告不会迁移。',
        success: result => { if (result.confirm) persist(true); }
      });
    } else {
      persist(false);
    }
  },

  deleteClass(e) {
    const cls = this.data.classes.find(item => item.id === String(e.currentTarget.dataset.id));
    if (!cls) return;
    wx.showModal({
      title: '删除班级「' + cls.name + '」？',
      content: '同一教室的多位授权教师将同时失去该班级与名册。若班级仍有学生或关联公告，服务器会阻止删除并提示处理方式。',
      success: result => {
        if (!result.confirm) return;
        this.action(async () => {
          await api.request('/admin/classes/' + encodeURIComponent(cls.id), { method: 'DELETE' });
          this.setData({ notice: '班级已删除' });
          await this.loadClasses();
        });
      }
    });
  },

  generateCode() {
    return this.action(async () => {
      const room = this.data.rooms[this.data.roomIndex];
      if (!room) throw new Error('请先创建教室');
      const result = await api.request('/admin/rooms/' + encodeURIComponent(room.id) + '/bind-codes', { method: 'POST', data: {} });
      this.setData({ bindCode: { code: result.bindCode, expiresLabel: logic.formatTime(result.expiresAt), roomName: room.name } });
    });
  },

  copyCode() {
    if (this.data.bindCode) wx.setClipboardData({ data: this.data.bindCode.code });
  },

  editTeacher(e) {
    const teacher = this.data.teachers.find(item => item.id === String(e.currentTarget.dataset.id));
    if (!teacher) return;
    const ids = Array.isArray(teacher.roomIds) ? teacher.roomIds.map(String) : [];
    this.setData({
      editor: Object.assign({}, teacher, {
        roleIndex: teacher.role === 'admin' ? 1 : 0,
        statusIndex: Math.max(0, ['pending', 'active', 'disabled'].indexOf(teacher.status))
      }),
      teacherRooms: this.data.rooms.map(room => Object.assign({}, room, { checked: ids.includes(room.id) }))
    });
  },

  closeEditor() {
    if (!this.data.busy) this.setData({ editor: null });
  },

  noop() {},

  editorInput(e) {
    this.setData({ ['editor.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  editorChoice(e) {
    this.setData({ ['editor.' + e.currentTarget.dataset.field]: Number(e.detail.value) });
  },

  teacherRoom(e) {
    const id = String(e.currentTarget.dataset.id);
    this.setData({ teacherRooms: this.data.teacherRooms.map(room => room.id === id ? Object.assign({}, room, { checked: !room.checked }) : room) });
  },

  saveTeacher() {
    return this.action(async () => {
      const teacher = this.data.editor;
      const roomIds = this.data.teacherRooms.filter(room => room.checked).map(room => room.id);
      if (!String(teacher.name || '').trim()) throw new Error('请填写教师姓名');
      const auth = session.read();
      if (auth && String(teacher.id) === String(auth.teacher.id) && (teacher.roleIndex !== 1 || teacher.statusIndex !== 1)) {
        throw new Error('为避免保存中途失去管理权限，请由另一位管理员变更你本人的角色或停用状态');
      }
      await api.request('/admin/teachers/' + encodeURIComponent(teacher.id) + '/update', {
        method: 'POST',
        data: {
          name: teacher.name.trim(),
          role: ['teacher', 'admin'][teacher.roleIndex],
          status: ['pending', 'active', 'disabled'][teacher.statusIndex]
        }
      });
      try {
        await api.request('/admin/teachers/' + encodeURIComponent(teacher.id) + '/rooms', { method: 'PUT', data: { roomIds } });
      } catch (error) {
        error.message = '身份已保存，但教室授权未确认。请保留选择后重试。\n' + error.message;
        throw error;
      }
      this.setData({ editor: null, notice: '教师身份与教室权限已保存' });
      await this.load();
    });
  },

  previewRoster() {
    return this.action(async () => {
      const cls = this.data.classes[this.data.classIndex];
      if (!cls) throw new Error('请先在教室中创建班级');
      const rows = logic.parseRoster(this.data.csv);
      const result = await api.request('/admin/rosters/preview', { method: 'POST', data: { classId: cls.id, rows } });
      this.setData({ preview: normalizeRosterPreview(result), notice: '' });
    });
  },

  chooseXlsx() {
    if (this.data.busy) return;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx'],
      success: result => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file || !/\.xlsx$/i.test(file.name || file.path || '')) {
          this.setData({ error: '请选择 .xlsx 格式的学生名册' });
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          this.setData({ error: 'XLSX 文件不能超过 10 MB' });
          return;
        }
        this.setData({
          xlsxPath: file.path,
          xlsxName: file.name || '学生名册.xlsx',
          xlsxSizeLabel: Math.max(1, Math.ceil((file.size || 0) / 1024)) + ' KB',
          preview: null,
          error: ''
        });
      },
      fail: error => {
        if (!/cancel/i.test(error.errMsg || '')) this.setData({ error: '无法选择文件：' + (error.errMsg || '请稍后重试') });
      }
    });
  },

  uploadXlsx() {
    return this.action(async () => {
      const cls = this.data.classes[this.data.classIndex];
      if (!cls) throw new Error('请先选择班级');
      if (!this.data.xlsxPath) throw new Error('请先选择 XLSX 文件');
      const uploaded = await api.upload('/admin/rosters/xlsx', this.data.xlsxPath, {
        formData: { classId: cls.id },
        scope: 'admin-xlsx'
      });
      let result = uploaded && uploaded.preview ? uploaded.preview : uploaded;
      if (!result || (!result.importId && !Array.isArray(result.rows))) throw new Error('服务器未返回可预检的名册数据');
      if (!result.importId) {
        const rows = result.rows.map(row => ({
          studentNo: String(row && row.studentNo !== undefined && row.studentNo !== null ? row.studentNo : ''),
          name: String(row && row.name !== undefined && row.name !== null ? row.name : '')
        }));
        result = await api.request('/admin/rosters/preview', { method: 'POST', data: { classId: cls.id, rows } });
      }
      this.setData({ preview: normalizeRosterPreview(result), notice: 'XLSX 已解析；学号按文本显示，请核对预检结果后确认导入' });
    });
  },

  commitRoster() {
    return this.action(async () => {
      if (!this.data.preview || !this.data.preview.valid) throw new Error('请先通过名册预检');
      const result = await api.request('/admin/rosters/commit', { method: 'POST', data: { importId: this.data.preview.importId } });
      this.setData({
        csv: '',
        csvReady: false,
        xlsxPath: '',
        xlsxName: '',
        xlsxSizeLabel: '',
        preview: null,
        notice: '导入完成：新增 ' + result.created + ' 人，更新 ' + result.updated + ' 人'
      });
    });
  },

  revokeDevice(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '吊销此大屏设备？',
      content: '设备将失去同步权限，需要重新生成绑定码绑定。',
      success: result => {
        if (!result.confirm) return;
        this.action(async () => {
          await api.request('/admin/devices/' + encodeURIComponent(id) + '/revoke', { method: 'POST', data: {} });
          await this.load();
          this.setData({ notice: '设备凭据已吊销' });
        });
      }
    });
  },

  schoolInput(e) {
    this.setData({ 'settings.schoolName': e.detail.value });
  },

  ruleInput(e) {
    this.setData({ ['quietRules[' + e.currentTarget.dataset.index + '].' + e.currentTarget.dataset.field]: e.detail.value });
  },

  addRule() {
    this.setData({ quietRules: this.data.quietRules.concat({ daysText: '1,2,3,4,5', start: '08:00', end: '08:45' }) });
  },

  removeRule(e) {
    this.setData({ quietRules: this.data.quietRules.filter((_, index) => index !== Number(e.currentTarget.dataset.index)) });
  },

  saveSettings() {
    return this.action(async () => {
      if (!this.data.settings.schoolName.trim()) throw new Error('请填写学校名称');
      const quietHours = this.data.quietRules.map((rule, index) => {
        const days = rule.daysText.split(/[,，\s]+/).filter(Boolean).map(Number);
        if (!days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(days).size !== days.length) {
          throw new Error('第 ' + (index + 1) + ' 条规则：星期填写不重复的 1–7，用逗号分隔');
        }
        if (rule.start >= rule.end) throw new Error('第 ' + (index + 1) + ' 条规则：结束时间需晚于开始，跨午夜请拆成两段');
        return { days, start: rule.start, end: rule.end };
      });
      const result = await api.request('/admin/settings', {
        method: 'PUT',
        data: {
          schoolName: this.data.settings.schoolName.trim(),
          timezone: 'Asia/Shanghai',
          quietHours,
          configRevision: this.data.settings.configRevision
        }
      });
      this.setData({ settings: result, notice: '学校设置已保存，大屏同步后应用' });
    });
  }
});
