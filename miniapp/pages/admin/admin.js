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
    section: 'classes',
    loading: false,
    busy: false,
    error: '',
    classes: [],
    teachers: [],
    devices: [],
    classIndex: 0,
    selectedClassName: '',
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
    teacherClasses: [],
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
        api.request('/admin/classes'),
        api.request('/admin/teachers'),
        api.request('/admin/devices'),
        api.request('/admin/settings')
      ]);
      const classes = (result[0].items || []).map(cls => Object.assign({}, cls, { id: String(cls.id) }));
      const teachers = (result[1].items || []).map(teacher => Object.assign({}, teacher, {
        id: String(teacher.id),
        classIds: Array.isArray(teacher.classIds) ? teacher.classIds.map(String) : [],
        roleLabel: teacher.role === 'admin' ? '管理员' : '教师',
        statusLabel: { pending: '待审核', active: '已通过', disabled: '已停用' }[teacher.status] || teacher.status
      }));
      const classIndex = Math.min(this.data.classIndex, Math.max(0, classes.length - 1));
      this.setData({
        classes,
        teachers,
        devices: (result[2].items || []).map(device => Object.assign({}, device, { lastSeenLabel: logic.formatTime(device.lastSeenAt) })),
        settings: result[3],
        quietRules: (result[3].quietHours || []).map(rule => ({ daysText: rule.days.join(','), start: rule.start, end: rule.end })),
        classIndex,
        selectedClassName: classes[classIndex] ? classes[classIndex].name : ''
      });
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

  async loadClasses() {
    const result = await api.request('/admin/classes');
    const classes = (result.items || []).map(cls => Object.assign({}, cls, { id: String(cls.id) }));
    const classIndex = Math.min(this.data.classIndex, Math.max(0, classes.length - 1));
    this.setData({
      classes,
      classIndex,
      selectedClassName: classes[classIndex] ? classes[classIndex].name : '',
      preview: null
    });
    return classes;
  },

  bindClassChange(e) {
    const classIndex = Number(e.detail.value);
    const cls = this.data.classes[classIndex];
    this.setData({ classIndex, selectedClassName: cls ? cls.name : '', bindCode: null });
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

  createClass() {
    return this.action(async () => {
      if (!this.data.className.trim()) throw new Error('请填写班级名称');
      await api.request('/admin/classes', { method: 'POST', data: { name: this.data.className.trim() } });
      this.setData({ className: '', notice: '班级已创建；授权教师会共享该班级名册' });
      await this.loadClasses();
    });
  },

  editClass(e) {
    const cls = this.data.classes.find(item => item.id === String(e.currentTarget.dataset.id));
    if (!cls) return;
    this.setData({ classEditor: Object.assign({}, cls) });
  },

  classEditorInput(e) {
    this.setData({ ['classEditor.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  closeClassEditor() {
    if (!this.data.busy) this.setData({ classEditor: null });
  },

  saveClass() {
    if (this.data.busy || !this.data.classEditor) return;
    const editor = this.data.classEditor;
    const name = String(editor.name || '').trim();
    if (!name) {
      this.setData({ error: '请填写班级名称' });
      return;
    }
    return this.action(async () => {
      // 微信请求不支持 PATCH，服务端为班级更新同时提供了 POST 别名。
      await api.request('/admin/classes/' + encodeURIComponent(editor.id) + '/update', {
        method: 'POST',
        data: { name }
      });
      this.setData({ classEditor: null, notice: '班级名称已更新' });
      await this.loadClasses();
    });
  },

  deleteClass(e) {
    const cls = this.data.classes.find(item => item.id === String(e.currentTarget.dataset.id));
    if (!cls) return;
    wx.showModal({
      title: '删除班级「' + cls.name + '」？',
      content: '该班级的学生名册与教师授权会一并清除，且无法恢复。仍绑定大屏设备的班级不能删除。',
      confirmText: '删除',
      confirmColor: '#A93230',
      success: result => {
        if (!result.confirm) return;
        this.action(async () => {
          const path = '/admin/classes/' + encodeURIComponent(cls.id);
          try {
            await api.request(path, { method: 'DELETE' });
          } catch (err) {
            // 名册还在时服务端会拒绝，用户已在上一步确认过一并删除。
            if (err && err.code === 'CLASS_IN_USE' && String(err.message || '').indexOf('学生') >= 0) {
              await api.request(path + '?force=1', { method: 'DELETE' });
            } else {
              throw err;
            }
          }
          this.setData({ notice: '班级与名册已删除' });
          await this.loadClasses();
        });
      }
    });
  },

  generateCode() {
    return this.action(async () => {
      const cls = this.data.classes[this.data.classIndex];
      if (!cls) throw new Error('请先创建班级');
      const result = await api.request('/admin/classes/' + encodeURIComponent(cls.id) + '/bind-codes', { method: 'POST', data: {} });
      this.setData({ bindCode: { code: result.bindCode, expiresLabel: logic.formatTime(result.expiresAt), className: result.className || cls.name } });
    });
  },

  copyCode() {
    if (this.data.bindCode) wx.setClipboardData({ data: this.data.bindCode.code });
  },

  editTeacher(e) {
    const teacher = this.data.teachers.find(item => item.id === String(e.currentTarget.dataset.id));
    if (!teacher) return;
    const ids = Array.isArray(teacher.classIds) ? teacher.classIds.map(String) : [];
    this.setData({
      editor: Object.assign({}, teacher, {
        roleIndex: teacher.role === 'admin' ? 1 : 0,
        statusIndex: Math.max(0, ['pending', 'active', 'disabled'].indexOf(teacher.status))
      }),
      teacherClasses: this.data.classes.map(cls => Object.assign({}, cls, { checked: ids.includes(cls.id) }))
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

  teacherClass(e) {
    const id = String(e.currentTarget.dataset.id);
    this.setData({ teacherClasses: this.data.teacherClasses.map(cls => cls.id === id ? Object.assign({}, cls, { checked: !cls.checked }) : cls) });
  },

  saveTeacher() {
    return this.action(async () => {
      const teacher = this.data.editor;
      const classIds = this.data.teacherClasses.filter(cls => cls.checked).map(cls => cls.id);
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
        await api.request('/admin/teachers/' + encodeURIComponent(teacher.id) + '/classes', { method: 'PUT', data: { classIds } });
      } catch (error) {
        error.message = '身份已保存，但班级授权未确认。请保留选择后重试。\n' + error.message;
        throw error;
      }
      this.setData({ editor: null, notice: '教师身份与班级权限已保存' });
      await this.load();
    });
  },

  previewRoster() {
    return this.action(async () => {
      const cls = this.data.classes[this.data.classIndex];
      if (!cls) throw new Error('请先创建班级');
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
