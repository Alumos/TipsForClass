const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const logic = require('../utils/logic');
function page(file, api, session, wx) {
  let definition;
  const context = { Page: value => { definition = value; }, wx: wx || {}, require: id => id.endsWith('/api') ? api : id.endsWith('/session') ? session : logic, setTimeout: () => 1, clearTimeout: () => {}, getApp: () => ({ globalData: {} }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', file), 'utf8'), context);
  definition.data = JSON.parse(JSON.stringify(definition.data));
  definition.setData = function(patch) { Object.assign(this.data, patch); };
  return definition;
}
test('uncertain create retains full frozen payload, token and original immediate startAt', async () => {
  const calls = [], storage = new Map();
  const auth = { teacher: { id: 'teacher-a' } };
  const api = { request: async (url, opts) => { calls.push(JSON.parse(JSON.stringify(opts.data))); throw new Error('timeout'); }, errorText: e => e.message };
  const session = { read: () => auth, key: (id, cls) => id + ':' + cls };
  const wx = { setStorageSync: (key, value) => storage.set(key, value) };
  const publish = page('publish/publish.js', api, session, wx);
  publish.userId = 'teacher-a';
  const end = logic.schoolParts(Date.now() + 3600000);
  Object.assign(publish.data, { ready: true, classId: '1', classIds: ['1'], targetClasses: [{ id: '1', deviceCount: 1 }], destination: '办公室', selected: [{ id: '1', name: '同学' }], expireDate: end.date, expireTime: end.time });
  await publish.submit();
  assert.equal(publish.data.destination, '办公室');
  assert.equal(publish.data.busy, false);
  assert(publish.data.error.includes('原样重试'));
  assert.equal(calls[0].displayPosition, 'top_right');
  await publish.submit();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(storage.get('teacher-a:1').pending.clientToken, calls[0].clientToken);
  publish.changed({ body: '请带作业' });
  await publish.submit();
  assert.notEqual(calls[2].clientToken, calls[1].clientToken);
});
test('drafts do not persist under a different signed-in identity', () => {
  let writes = 0;
  const publish = page('publish/publish.js', {}, { read: () => ({ teacher: { id: 'teacher-b' } }) }, { setStorageSync: () => { writes++; } });
  publish.userId = 'teacher-a'; publish.data.ready = true; publish.saveDraft();
  assert.equal(writes, 0);
});
test('delivery page can resume after being hidden during a request; stale response cannot replace it', async () => {
  const pending = [];
  const api = { request: () => new Promise(resolve => pending.push(resolve)), abortScope: () => {}, errorText: e => e.message };
  const detail = page('detail/detail.js', api, { requireLogin: () => true });
  detail.onLoad({ id: '1' }); detail.started = Date.now();
  const oldRequest = detail.refresh();
  assert.equal(detail.data.loading, true);
  detail.onHide();
  assert.equal(detail.data.loading, false);
  detail.visible = true;
  const resumed = detail.refresh();
  assert.equal(pending.length, 4);
  const message = { id: '1', title: '新数据', type: 'notice', status: 'active', targets: [], startAt: new Date().toISOString(), expireAt: new Date(Date.now() + 3600000).toISOString() };
  pending[2](message); pending[3]({ devices: [], targetDeviceCount: 0, displayedDeviceCount: 0 });
  await resumed;
  pending[0](Object.assign({}, message, { title: '过时响应' })); pending[1]({ devices: [], targetDeviceCount: 0, displayedDeviceCount: 0 });
  await oldRequest;
  assert.equal(detail.data.message.title, '新数据');
  assert.equal(detail.data.loading, false);
});
test('teacher with null classIds opens permission editor safely', () => {
  const admin = page('admin/admin.js', {}, {});
  admin.data.teachers = [{ id: '1', classIds: null, status: 'pending', role: 'teacher' }];
  admin.data.classes = [{ id: '1', name: '班级' }];
  admin.editTeacher({ currentTarget: { dataset: { id: '1' } } });
  assert.equal(admin.data.teacherClasses[0].checked, false);
});
test('arrange page only reorders pinned messages and saves their order without a global position control', async () => {
  const calls = [];
  const api = {
    request: async (path, options) => {
      const opts = options || {};
      calls.push({ path, method: opts.method || 'GET', data: opts.data ? JSON.parse(JSON.stringify(opts.data)) : null });
      if (path === '/classes') {
        return { items: [{ id: '1', name: '一班' }, { id: '2', name: '二班' }] };
      }
      if (path === '/classes/2/display-settings' && !opts.method) {
        return {
          displaySettings: {
            displayPosition: 'center',
            pinnedMessageIds: ['2'],
            messageOrder: ['2', '1']
          },
          messages: [
            { id: '1', type: 'call', title: '甲', targets: [], status: 'active', startAt: '2026-10-22T00:00:00.000Z', expireAt: '2099-10-22T01:00:00.000Z', createdAt: '2026-10-22T00:00:00.000Z' },
            { id: '2', type: 'notice', title: '乙', targets: [], status: 'active', startAt: '2026-10-22T00:00:00.000Z', expireAt: '2099-10-22T01:00:00.000Z', createdAt: '2026-10-22T00:01:00.000Z' }
          ]
        };
      }
      if (path === '/classes/2/display-settings' && opts.method === 'PUT') return {};
      throw new Error('unexpected request ' + path + ' ' + (opts.method || 'GET'));
    },
    abortScope: () => {},
    errorText: error => error.message
  };
  const arrange = page('arrange/arrange.js', api, { requireLogin: () => ({ teacher: { id: 't1' } }) }, { showToast: () => {} });
  await arrange.onLoad({ classId: '2' });
  assert.equal(arrange.data.classId, '2');
  assert.equal(arrange.data.position, 'center');
  assert.deepEqual(arrange.data.messages.map(message => message.id), ['2', '1']);
  assert.equal(arrange.data.positionOptions, undefined);

  arrange.moveMessage(1, -1);
  assert.deepEqual(arrange.data.messages.map(message => message.id), ['2', '1']);
  assert.equal(arrange.data.messages[1].canMoveUp, false);
  assert.match(arrange.data.messages[1].orderHint, /发布时间/);

  arrange.togglePin({ currentTarget: { dataset: { id: '1' } } });
  assert.equal(arrange.data.dirty, true);
  assert.deepEqual(arrange.data.messages.map(message => message.id), ['2', '1']);
  arrange.moveUp({ currentTarget: { dataset: { index: 1 } } });
  assert.deepEqual(arrange.data.messages.map(message => message.id), ['1', '2']);

  await arrange.saveSettings();
  const save = calls.find(call => call.method === 'PUT');
  assert(save);
  assert.equal(save.path, '/classes/2/display-settings');
  assert.deepEqual(save.data, {
    classId: '2',
    displayPosition: 'center',
    pinnedMessageIds: ['1', '2'],
    messageOrder: ['1', '2']
  });
  assert.equal(arrange.data.dirty, false);
});

test('admin chooses and uploads XLSX to the roster endpoint while preserving text IDs', async () => {
  let chooseOptions;
  let uploadCall;
  const wx = {
    chooseMessageFile: options => {
      chooseOptions = options;
      options.success({ tempFiles: [{ path: '/tmp/students.xlsx', name: 'students.xlsx', size: 2048 }] });
    }
  };
  const api = {
    upload: async (path, filePath, options) => {
      uploadCall = { path, filePath, options: JSON.parse(JSON.stringify(options)) };
      return {
        preview: {
          importId: 'import-7',
          valid: true,
          rows: [
            { row: 2, studentNo: '000042', name: '陈同学' },
            { row: 3, studentNo: '000043', name: '林同学' }
          ],
          errors: [],
          newCount: 2,
          updateCount: 0
        }
      };
    },
    request: async () => { throw new Error('preview fallback should not run'); },
    errorText: error => error.message
  };
  const admin = page('admin/admin.js', api, {}, wx);
  admin.data.classes = [{ id: 'class-9', name: '三年二班' }];
  admin.data.classIndex = 0;
  admin.chooseXlsx();
  assert.deepEqual(Array.from(chooseOptions.extension), ['xlsx']);
  assert.equal(admin.data.xlsxPath, '/tmp/students.xlsx');

  await admin.uploadXlsx();
  assert.equal(uploadCall.path, '/admin/rosters/xlsx');
  assert.equal(uploadCall.filePath, '/tmp/students.xlsx');
  assert.deepEqual(uploadCall.options.formData, { classId: 'class-9' });
  assert.equal(admin.data.preview.valid, true);
  assert.equal(admin.data.preview.rows[0].studentNo, '000042');
  assert.equal(admin.data.preview.displayRows[1].studentNo, '000043');
});

test('publish keeps the current notice class fixed and sends the selected display position', async () => {
  const calls = [];
  const toasts = [];
  const redirects = [];
  const api = {
    request: async (path, options) => {
      const opts = options || {};
      calls.push({ path, method: opts.method || 'GET', data: opts.data ? JSON.parse(JSON.stringify(opts.data)) : null });
      return { id: 'message-new' };
    },
    errorText: error => error.message
  };
  const session = { read: () => ({ teacher: { id: 'teacher-a' } }), key: (teacher, cls) => teacher + ':' + cls };
  const wx = {
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: options => toasts.push(options.title),
    redirectTo: options => redirects.push(options.url)
  };
  const publish = page('publish/publish.js', api, session, wx);
  const end = logic.schoolParts(Date.now() + 3600000);
  Object.assign(publish.data, {
    ready: true,
    editing: false,
    type: 'notice',
    classId: '1',
    classIds: ['1'],
    targetClasses: [{ id: '1', name: '一班', deviceCount: 1 }, { id: '2', name: '二班', deviceCount: 1 }],
    className: '一班',
    title: '通知',
    body: '正文',
    expireDate: end.date,
    expireTime: end.time
  });
  publish.userId = 'teacher-a';

  publish.changed({ classIds: ['2', '2'] });
  assert.deepEqual(Array.from(publish.data.classIds), ['1', '2']);
  publish.toggleClass({ currentTarget: { dataset: { id: '1' } } });
  assert.deepEqual(Array.from(publish.data.classIds), ['1', '2']);
  assert.equal(toasts.at(-1), '当前班级无需重复选择');
  publish.choosePosition({ currentTarget: { dataset: { value: 'center' } } });
  await publish.submit();

  const create = calls.find(call => call.path === '/messages');
  assert(create);
  assert.equal(create.method, 'POST');
  assert.deepEqual(create.data.classIds, ['1', '2']);
  assert.equal(create.data.displayPosition, 'center');
  assert.deepEqual(create.data.studentIds, []);
  assert.equal(redirects[0], '/pages/detail/detail?id=message-new');
});

test('edit mode hydrates all message types, locks classes and posts to the update endpoint', async () => {
  const calls = [];
  const toasts = [];
  const message = {
    id: '88',
    type: 'batch',
    title: '批量作业',
    body: '完成练习册',
    destination: '物理实验室',
    classIds: ['2'],
    targets: [{ studentId: '11', name: '陈同学', className: '三年一班', studentNoSuffix: '0042' }],
    broadcast: { times: 1 },
    startAt: new Date(Date.now() - 60000).toISOString(),
    expireAt: new Date(Date.now() + 3600000).toISOString(),
    displayPosition: 'center'
  };
  const api = {
    request: async (path, options) => {
      const opts = options || {};
      calls.push({ path, method: opts.method || 'GET', data: opts.data ? JSON.parse(JSON.stringify(opts.data)) : null });
      if (path === '/me') return { status: 'active' };
      if (path === '/classes') return { items: [{ id: '1', name: '一班', deviceCount: 1 }, { id: '2', name: '二班', deviceCount: 1 }] };
      if (path === '/messages/88' && !opts.method) return message;
      if (path.indexOf('/students?classId=1') === 0) return { items: [{ id: '11', name: '陈同学', classId: '1', studentNo: '000042' }], nextCursor: '' };
      if (path.indexOf('/students?') === 0) return { items: [], nextCursor: '' };
      if (path === '/messages/88/update') return { id: '88' };
      throw new Error('unexpected request ' + path);
    },
    errorText: error => error.message
  };
  const auth = { teacher: { id: 'teacher-a' } };
  const session = { requireLogin: () => auth, read: () => auth, key: (teacher, cls) => teacher + ':' + cls, clearDrafts: () => {} };
  const wx = {
    removeStorageSync: () => {},
    setStorageSync: () => {},
    redirectTo: () => {},
    showToast: options => toasts.push(options.title),
    showActionSheet: () => { throw new Error('class picker must stay locked while editing'); }
  };
  const publish = page('publish/publish.js', api, session, wx);
  await publish.onLoad({ editId: '88', classId: '2' });

  assert.equal(publish.data.editing, true);
  assert.equal(publish.data.type, 'batch');
  assert.deepEqual(Array.from(publish.data.classIds), ['2']);
  assert.deepEqual(Array.from(publish.data.selected, student => student.id), ['11']);
  assert.equal(publish.data.displayPosition, 'center');
  publish.switchClass();
  assert.equal(toasts.at(-1), '编辑时不能更改目标班级');

  publish.populateEdit(Object.assign({}, message, { type: 'notice', classIds: ['1', '2'], targets: [] }));
  assert.equal(publish.data.type, 'notice');
  assert.deepEqual(Array.from(publish.data.classIds), ['1', '2']);
  publish.chooseType({ currentTarget: { dataset: { type: 'call' } } });
  assert.equal(publish.data.type, 'notice');
  assert.equal(toasts.at(-1), '多班级通知不能改为单班级类型');

  publish.populateEdit(Object.assign({}, message, { type: 'call' }));
  assert.equal(publish.data.type, 'call');
  publish.populateEdit(message);
  publish.choosePosition({ currentTarget: { dataset: { value: 'top_right' } } });
  await publish.submit();

  const update = calls.find(call => call.path === '/messages/88/update');
  assert(update);
  assert.equal(update.method, 'POST');
  assert.equal(update.data.displayPosition, 'top_right');
  assert.equal(update.data.type, 'batch');
  assert.deepEqual(update.data.classIds, ['2']);
  assert.deepEqual(update.data.studentIds, ['11']);
});

test('records exposes edit navigation and refreshes after confirmed deletion', async () => {
  const calls = [];
  const navigations = [];
  const toasts = [];
  let modal;
  const api = {
    request: async (path, options) => {
      const opts = options || {};
      calls.push({ path, method: opts.method || 'GET' });
      if (opts.method === 'DELETE') return {};
      if (path.startsWith('/messages?')) return { items: [], nextCursor: '' };
      throw new Error('unexpected request ' + path);
    },
    errorText: error => error.message
  };
  const wx = {
    navigateTo: options => navigations.push(options.url),
    showModal: options => {
      modal = options;
      options.success({ confirm: true, cancel: false });
    },
    showToast: options => toasts.push(options.title),
    stopPullDownRefresh: () => {}
  };
  const records = page('records/records.js', api, { requireLogin: () => ({ teacher: { id: 'teacher-a' } }) }, wx);
  records.data.items = [{ id: '42', classIds: ['2'], title: '待删除公告' }];

  records.edit({ currentTarget: { dataset: { id: '42' } } });
  assert.equal(navigations[0], '/pages/publish/publish?editId=42&classId=2');
  assert.equal(modal, undefined);

  const removed = await records.remove({ currentTarget: { dataset: { id: '42' } } });
  assert.equal(removed, true);
  assert.equal(modal.title, '删除这条公告？');
  assert.match(modal.content, /已撤回.*保留审计信息/);
  assert.deepEqual(calls[0], { path: '/messages/42', method: 'DELETE' });
  assert.match(calls[1].path, /^\/messages\?limit=20&status=active&cursor=/);
  assert.equal(toasts[0], '公告已删除');
  assert.equal(records.data.items.length, 0);
});
