const test = require('node:test');
const assert = require('node:assert/strict');
const storage = new Map();
global.wx = { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: k => storage.delete(k), getStorageInfoSync: () => ({ keys: [...storage.keys()] }) };
const session = require('../utils/session');
test('drafts separate users and rooms, prune after 24h, logout clears current identity only', () => {
  storage.clear();
  storage.set(session.key('a', 'room1'), { savedAt: Date.now() });
  storage.set(session.key('a', 'room2'), { savedAt: Date.now() - 86400001 });
  storage.set(session.key('b', 'room1'), { savedAt: Date.now() });
  session.pruneDrafts();
  assert.equal(storage.has(session.key('a', 'room2')), false);
  session.write({ token: 'test', teacher: { id: 'a' } }); session.clear();
  assert.equal(storage.has(session.key('a', 'room1')), false);
  assert.equal(storage.has(session.key('b', 'room1')), true);
  assert.equal(session.read(), null);
});
