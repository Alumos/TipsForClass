const config = require('../config');
const session = require('./session');
const scopes = {};
function request(path, options) {
  const opts = options || {};
  if (!['OPTIONS', 'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'TRACE', 'CONNECT'].includes(opts.method || 'GET')) return Promise.reject(new Error('微信请求不支持该 HTTP 方法，请使用服务端兼容接口'));
  return new Promise((resolve, reject) => {
    const current = session.read();
    let task;
    const cleanup = () => { if (opts.scope && scopes[opts.scope]) scopes[opts.scope].delete(task); };
    task = wx.request({
      url: config.apiBase.replace(/\/$/, '') + path,
      method: opts.method || 'GET', data: opts.data, timeout: 15000,
      header: Object.assign({ 'Content-Type': 'application/json' }, !opts.anonymous && current ? { Authorization: 'Bearer ' + current.token } : {}),
      success(res) {
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 0) return resolve(body.data);
        if (res.statusCode === 401 && !opts.anonymous) { session.clear(); wx.reLaunch({ url: '/pages/login/login' }); }
        if (res.statusCode === 403 && current) session.clearDrafts(current.teacher.id);
        const error = new Error(body.message || '服务暂不可用，请稍后重试');
        error.code = body.code; error.errors = body.errors; error.requestId = body.requestId; error.status = res.statusCode;
        reject(error);
      },
      fail(err) { const error = new Error(err.errMsg && err.errMsg.indexOf('abort') !== -1 ? '请求已取消' : '网络未确认，请检查服务地址和网络后原样重试'); error.network = true; error.aborted = /abort/.test(err.errMsg || ''); reject(error); },
      complete: cleanup
    });
    if (opts.scope) { if (!scopes[opts.scope]) scopes[opts.scope] = new Set(); scopes[opts.scope].add(task); }
  });
}
function upload(path, filePath, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const current = session.read();
    let task;
    const cleanup = () => { if (opts.scope && scopes[opts.scope]) scopes[opts.scope].delete(task); };
    task = wx.uploadFile({
      url: config.apiBase.replace(/\/$/, '') + path,
      filePath,
      name: opts.name || 'file',
      formData: opts.formData || {},
      timeout: 60000,
      header: !opts.anonymous && current ? { Authorization: 'Bearer ' + current.token } : {},
      success(res) {
        let body = {};
        try { body = typeof res.data === 'string' ? JSON.parse(res.data) : (res.data || {}); }
        catch (_) {
          const error = new Error('上传响应无法识别，请稍后重试');
          error.status = res.statusCode;
          reject(error);
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 0) return resolve(body.data);
        if (res.statusCode === 401 && !opts.anonymous) { session.clear(); wx.reLaunch({ url: '/pages/login/login' }); }
        if (res.statusCode === 403 && current) session.clearDrafts(current.teacher.id);
        const error = new Error(body.message || '文件上传失败，请稍后重试');
        error.code = body.code; error.errors = body.errors; error.requestId = body.requestId; error.status = res.statusCode;
        reject(error);
      },
      fail(err) {
        const error = new Error(err.errMsg && err.errMsg.indexOf('abort') !== -1 ? '上传已取消' : '文件上传结果未确认，请检查网络后重试');
        error.network = true; error.aborted = /abort/.test(err.errMsg || ''); reject(error);
      },
      complete: cleanup
    });
    if (opts.scope) { if (!scopes[opts.scope]) scopes[opts.scope] = new Set(); scopes[opts.scope].add(task); }
  });
}
function abortScope(scope) { const tasks = scopes[scope]; if (tasks) tasks.forEach(task => task.abort()); delete scopes[scope]; }
function errorText(error) {
  let text = error.message || '操作失败，请重试';
  if (error.errors) text += '\n' + Object.keys(error.errors).map(k => k + '：' + (Array.isArray(error.errors[k]) ? error.errors[k].join('、') : error.errors[k])).join('\n');
  if (error.requestId) text += '\n排查编号：' + error.requestId;
  return text;
}
module.exports = { request, upload, abortScope, errorText };
