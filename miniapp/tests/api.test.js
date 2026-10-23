const test = require('node:test');
const assert = require('node:assert/strict');
const methods = new Set(['OPTIONS', 'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'TRACE', 'CONNECT']);
const requests = [];
global.wx = {
  getStorageSync: () => ({ token: 'teacher-test-token', teacher: { id: '1' } }),
  request(options) {
    assert(methods.has(options.method), 'wx.request method must be supported');
    requests.push(options);
    setImmediate(() => { options.success({ statusCode: 200, data: { code: 0, data: { ok: true } } }); options.complete(); });
    return { abort() {} };
  }
};
const api = require('../utils/api');
test('native wrapper sends supported GET/POST/PUT methods, bearer auth and JSON', async () => {
  await api.request('/me');
  await api.request('/admin/teachers/1/update', { method: 'POST', data: { status: 'active' } });
  await api.request('/admin/teachers/1/classes', { method: 'PUT', data: { classIds: ['1'] } });
  assert.deepEqual(requests.map(r => r.method), ['GET', 'POST', 'PUT']);
  assert.equal(requests[0].header.Authorization, 'Bearer teacher-test-token');
  assert.equal(requests[1].header['Content-Type'], 'application/json');
});
test('unsupported PATCH is rejected before reaching wx.request', async () => {
  const count = requests.length;
  await assert.rejects(api.request('/admin/teachers/1', { method: 'PATCH' }), /不支持/);
  assert.equal(requests.length, count);
});
