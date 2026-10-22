const SESSION = 'notice-session-v1';
const PREFIX = 'notice-draft-v1:';
function read() { return wx.getStorageSync(SESSION) || null; }
function write(value) { wx.setStorageSync(SESSION, value); }
function clearDrafts(userId) {
  const prefix = userId ? PREFIX + userId + ':' : PREFIX;
  (wx.getStorageInfoSync().keys || []).filter(k => k.indexOf(prefix) === 0).forEach(k => wx.removeStorageSync(k));
}
function clear() { const s = read(); if (s) clearDrafts(s.teacher.id); wx.removeStorageSync(SESSION); }
function key(userId, roomId) { return PREFIX + userId + ':' + roomId; }
function pruneDrafts() {
  (wx.getStorageInfoSync().keys || []).filter(k => k.indexOf(PREFIX) === 0).forEach(k => {
    const draft = wx.getStorageSync(k);
    if (!draft || Date.now() - draft.savedAt > 86400000) wx.removeStorageSync(k);
  });
}
function requireLogin() {
  const s = read();
  if (!s || !s.token || Date.parse(s.expiresAt) <= Date.now()) { clear(); wx.reLaunch({ url: '/pages/login/login' }); return null; }
  return s;
}
module.exports = { read, write, clear, clearDrafts, key, pruneDrafts, requireLogin };
