const test = require('node:test');
const assert = require('node:assert/strict');
const storage = new Map();
global.wx = { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: k => storage.delete(k), getStorageInfoSync: () => ({ keys: [...storage.keys()] }) };
const session = require('../utils/session');
test('drafts separate users and classes, prune after 24h, logout clears current identity only', () => {
  storage.clear();
  storage.set(session.key('a', 'class1'), { savedAt: Date.now() });
  storage.set(session.key('a', 'class2'), { savedAt: Date.now() - 86400001 });
  storage.set(session.key('b', 'class1'), { savedAt: Date.now() });
  session.pruneDrafts();
  assert.equal(storage.has(session.key('a', 'class2')), false);
  session.write({ token: 'test', teacher: { id: 'a' } }); session.clear();
  assert.equal(storage.has(session.key('a', 'class1')), false);
  assert.equal(storage.has(session.key('b', 'class1')), true);
  assert.equal(session.read(), null);
});
test('abnormal cached session degrades to re-login instead of crashing', () => {
  storage.clear();
  storage.set('notice-session-v1', 'broken');
  assert.equal(session.read(), null);
  storage.set('notice-session-v1', { token: 'test' });
  assert.equal(session.read(), null);
  storage.set('notice-session-v1', { token: 'test', teacher: { id: 'a', classIds: ['1', 2] } });
  assert.deepEqual(session.read().teacher.classIds, ['1', '2']);
});
