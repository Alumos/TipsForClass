const SESSION = 'notice-session-v1';
const PREFIX = 'notice-draft-v1:';
// 旧版本把发布目标存在别的 *Ids 字段里；这里只保留 classIds，读到旧缓存也能安全降级。
const LEGACY_TARGETS = /^[a-z]+Ids$/i;
function normalize(value) {
  if (!value || typeof value !== 'object' || !value.teacher || typeof value.teacher !== 'object') return null;
  const teacher = Object.assign({}, value.teacher);
  const id = String(teacher.id || '');
  if (!id) return null;
  Object.keys(teacher).filter(field => LEGACY_TARGETS.test(field) && field !== 'classIds').forEach(field => { delete teacher[field]; });
  teacher.id = id;
  teacher.classIds = (Array.isArray(teacher.classIds) ? teacher.classIds : []).map(String).filter(Boolean);
  return Object.assign({}, value, { teacher });
}
// 缺少教师身份或结构异常时返回 null，调用方会重新登录。
function read() { return normalize(wx.getStorageSync(SESSION)); }
function write(value) { wx.setStorageSync(SESSION, value); }
function clearDrafts(userId) {
  const prefix = userId ? PREFIX + userId + ':' : PREFIX;
  (wx.getStorageInfoSync().keys || []).filter(k => k.indexOf(prefix) === 0).forEach(k => wx.removeStorageSync(k));
}
function clear() { const s = read(); if (s) clearDrafts(s.teacher.id); wx.removeStorageSync(SESSION); }
function key(userId, classId) { return PREFIX + userId + ':' + classId; }
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
module.exports = { read, write, clear, clearDrafts, key, pruneDrafts, requireLogin, normalize };
