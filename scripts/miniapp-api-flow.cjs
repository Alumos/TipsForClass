const assert = require('node:assert/strict');
const path = require('node:path');
const mini = path.resolve(__dirname, '../miniapp');
/** Executes actual Page methods with minimal wx transport, not a substitute for WeChat UI compilation. */
module.exports = async function run({ base, classId, teacherLogin, rawApi }) {
  const config = require(path.join(mini, 'config.js'));
  const previousBase = config.apiBase;
  config.apiBase = base + '/api/v1';
  const storage = new Map();
  let navigated = '';
  const app = { globalData: { copyMessage: null } };
  const previousWx = global.wx, previousPage = global.Page, previousApp = global.getApp;
  global.getApp = () => app;
  global.wx = {
    getStorageSync: k => storage.get(k),
    setStorageSync: (k,v) => storage.set(k, structuredClone(v)),
    removeStorageSync: k => storage.delete(k),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    request(options) {
      assert(['GET','POST','PUT','DELETE','OPTIONS','HEAD','TRACE','CONNECT'].includes(options.method), 'Unsupported native wx.request method');
      const controller = new AbortController();
      fetch(options.url, { method: options.method, headers: options.header, body: options.method === 'GET' ? undefined : JSON.stringify(options.data), signal: controller.signal })
        .then(async r => options.success?.({ statusCode: r.status, data: await r.json() }))
        .catch(error => options.fail?.({ errMsg: error.name === 'AbortError' ? 'request:fail abort' : error.message }))
        .finally(() => options.complete?.());
      return { abort() { controller.abort(); } };
    },
    showToast() {},
    showModal(options) { options.success?.({ confirm: true }); },
    showActionSheet(options) { options.success?.({ tapIndex: 0 }); },
    redirectTo(o) { navigated = o.url; }, reLaunch(o) { navigated = o.url; },
    navigateTo(o) { navigated = o.url; }, switchTab(o) { navigated = o.url; },
  };
  function page(name) {
    let definition;
    global.Page = p => { definition = p; };
    const filename = path.join(mini, 'pages', name, name + '.js');
    delete require.cache[require.resolve(filename)];
    require(filename);
    return { ...definition, data: structuredClone(definition.data), setData(patch) {
      for(const [key,value] of Object.entries(patch)) {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target=this.data;
        for(const part of parts.slice(0,-1)) { target[part] ??= {}; target=target[part]; }
        target[parts.at(-1)]=value;
      }
    } };
  }
  try {
    const session = require(path.join(mini, 'utils/session.js'));
    session.write(teacherLogin);
    const publish = page('publish');
    await publish.onLoad({ classId });
    assert.equal(publish.data.ready, true, publish.data.error);
    publish.chooseType({ currentTarget: { dataset: { type: 'notice' } } });
    publish.input({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '小程序真实请求联调' } });
    await publish.submit();
    assert.match(navigated, /pages\/detail\/detail\?id=/, publish.data.error);
    const id = new URLSearchParams(navigated.split('?')[1]).get('id');
    assert.equal((await rawApi(`/messages/${id}`, { token: teacherLogin.token })).title, '小程序真实请求联调');
    publish.onUnload();
    const detail = page('detail');
    detail.onLoad({ id }); detail.started=Date.now()-31000;
    await detail.refresh();
    assert.equal(detail.data.message.id, id, detail.data.error);
    assert.equal(detail.data.delivery.targetDeviceCount, 1);
    detail.onUnload();
    const admin = page('admin');
    await admin.load();
    assert.equal(admin.data.error, '');
    assert(admin.data.teachers.length > 0);
    admin.editTeacher({ currentTarget: { dataset: { id: teacherLogin.teacher.id } } });
    await admin.action(async () => {
      const api = require(path.join(mini, 'utils/api.js'));
      await api.request(`/admin/teachers/${teacherLogin.teacher.id}/update`, { method: 'POST', data: { name: '演示管理员', role: 'admin', status: 'active' } });
    });
    assert.equal(admin.data.error, '');
    return id;
  } finally {
    config.apiBase=previousBase;
    global.wx=previousWx; global.Page=previousPage; global.getApp=previousApp;
  }
};
