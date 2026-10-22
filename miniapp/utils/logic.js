// 幂等标识，不作为登录凭据或保密随机值。
function token() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); }); }
function schoolParts(value) {
  const d = new Date(new Date(value).getTime() + 8 * 3600000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
function toISO(date, time) { const n = Date.parse(date + 'T' + time + ':00+08:00'); return Number.isFinite(n) ? new Date(n).toISOString() : ''; }
function formatTime(value) { if (!value || !Number.isFinite(Date.parse(value))) return '尚无记录'; const p = schoolParts(value); return p.date + ' ' + p.time; }
function defaults(type, now) {
  const start = now === undefined ? Date.now() : now;
  let end = start + (type === 'batch' ? 120 : 40) * 60000;
  if (type === 'notice') {
    const date = schoolParts(start).date;
    end = Date.parse(toISO(date, '22:00'));
    if (end <= start) end += 86400000;
  }
  const parts = schoolParts(end);
  return { broadcastTimes: 0, expireDate: parts.date, expireTime: parts.time };
}
function messageView(message) {
  const now = Date.now();
  let state = message.status === 'revoked' ? '已撤回' : Date.parse(message.expireAt) <= now ? '已到期' : Date.parse(message.startAt) > now ? '定时待生效' : '有效期内';
  const names = (message.targets || []).map(target => target.name).filter(Boolean);
  const targetNames = names.join('、');
  const personNames = names.length > 3 ? names.slice(0, 3).join('、') + '等 ' + names.length + ' 人' : targetNames;
  const destination = String(message.destination || '').trim();
  const info = message.type === 'call'
    ? (destination ? '请到 ' + destination : '请到指定地点')
    : message.type === 'batch'
      ? (destination ? '作业地点：' + destination : '作业地点：未填写')
      : String(message.title || '').trim();
  return Object.assign({}, message, {
    typeLabel: { call: '呼叫学生', batch: '作业布置', notice: '普通通知' }[message.type] || message.type,
    stateLabel: state,
    createdLabel: formatTime(message.createdAt),
    startLabel: formatTime(message.startAt),
    expireLabel: formatTime(message.expireAt),
    targetNames,
    recordTitle: message.type === 'notice' ? (String(message.title || '').trim() || '班级通知') : (personNames || message.title || '学生提醒'),
    recordInfo: message.type === 'notice' ? String(message.body || '').trim() : [info, String(message.body || '').trim()].filter(Boolean).join('\n')
  });
}
function charCount(value) { return Array.from(value || '').length; }
function validateMessage(payload, now) {
  const errors = [];
  const type = payload.type;
  const roomIds = Array.isArray(payload.roomIds) ? payload.roomIds : [];
  const studentIds = Array.isArray(payload.studentIds) ? payload.studentIds : [];
  const title = String(payload.title || '');
  const destination = String(payload.destination || '');
  const body = String(payload.body || '');
  if (!['call', 'batch', 'notice'].includes(type)) errors.push('请选择公告类型');
  if (!roomIds.length || roomIds.length > 20) errors.push('请选择 1–20 间目标教室');
  if (payload.type !== 'notice') {
    if (roomIds.length !== 1) errors.push('呼叫和作业布置只能选择一间教室');
    const max = type === 'call' ? 3 : 60;
    if (!studentIds.length || studentIds.length > max) errors.push('请选择 1–' + max + ' 名学生');
    if (!destination.trim()) errors.push(type === 'call' ? '请填写呼叫地点' : '请填写作业地点');
    if (charCount(destination) > 40) errors.push('地点最多 40 字');
    if (type === 'batch' && !body.trim()) errors.push('请填写作业内容');
  } else {
    if (!title.trim() || charCount(title) > 60) errors.push('通知标题必填，最多 60 字');
    if (studentIds.length) errors.push('普通通知不应包含学生名单');
    if (destination.trim()) errors.push('普通通知不应包含地点');
    if (payload.broadcastTimes !== 0) errors.push('普通通知不播报');
  }
  const bodyLimit = type === 'call' ? 120 : 300;
  if (charCount(body) > bodyLimit) errors.push((type === 'notice' ? '通知正文' : type === 'batch' ? '作业内容' : '补充说明') + '最多 ' + bodyLimit + ' 字');
  if (![0, 1, 2].includes(payload.broadcastTimes)) errors.push('播报次数应为 0、1 或 2');
  const start = Date.parse(payload.startAt), end = Date.parse(payload.expireAt), current = now || Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) errors.push('请选择有效的日期和时间');
  else {
    if (end <= Math.max(start, current)) errors.push('到期时间必须晚于生效时间和当前时间');
    if (start > current + 7 * 86400000) errors.push('定时生效不能超过未来 7 天');
    if (end - start > 7 * 86400000) errors.push('有效期最长 7 天');
  }
  return errors;
}

function normalizeDisplaySettings(value) {
  const source = value || {};
  const settings = source.settings || source.displaySettings || source;
  const rawMessages = Array.isArray(source.messages) ? source.messages : Array.isArray(source.items) ? source.items : Array.isArray(settings.messages) ? settings.messages : [];
  const rawPinned = settings.pinnedMessageIds || settings.pinnedIds || source.pinnedMessageIds || [];
  const rawOrder = settings.messageOrder || settings.orderedMessageIds || settings.order || source.messageOrder || source.orderedMessageIds || [];
  const position = settings.displayPosition || settings.position || settings.placement || source.displayPosition || source.position;
  return {
    roomId: String(settings.roomId || source.roomId || ''),
    position: position === 'center' ? 'center' : 'top_right',
    displayPosition: position === 'center' ? 'center' : 'top_right',
    pinnedMessageIds: (Array.isArray(rawPinned) ? rawPinned : []).map(String),
    messageOrder: (Array.isArray(rawOrder) ? rawOrder : []).map(item => String(typeof item === 'string' ? item : item.messageId || item.id || '')).filter(Boolean),
    messages: rawMessages
  };
}

function orderDisplayMessages(messages, config) {
  const normalized = normalizeDisplaySettings(config || {});
  const source = Array.isArray(messages) ? messages : [];
  const byId = {};
  source.forEach(message => { const id = String(message.id || message.messageId || ''); if (id) byId[id] = message; });
  const ordered = [];
  normalized.messageOrder.forEach(id => { if (byId[id]) { ordered.push(byId[id]); delete byId[id]; } });
  source.forEach(message => { const id = String(message.id || message.messageId || ''); if (byId[id]) { ordered.push(message); delete byId[id]; } });
  const pinned = new Set(normalized.pinnedMessageIds);
  return ordered.map(message => Object.assign({}, message, { id: String(message.id || message.messageId || ''), pinned: pinned.has(String(message.id || message.messageId || '')) }));
}

function displaySettingsPayload(roomId, position, messages) {
  const source = Array.isArray(messages) ? messages : [];
  return {
    roomId: String(roomId),
    displayPosition: position === 'center' ? 'center' : 'top_right',
    pinnedMessageIds: source.filter(message => message.pinned).map(message => String(message.id || message.messageId)),
    messageOrder: source.map(message => String(message.id || message.messageId))
  };
}
// RFC 4180 quoted cells; also accepts tab-delimited text copied from a spreadsheet.
function parseRoster(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const delimiter = input.split(/\r?\n/)[0].includes('\t') ? '\t' : ',';
  const records = []; let row = [], cell = '', quoted = false, afterQuote = false;
  for (let i = 0; i <= input.length; i++) {
    const c = i === input.length ? '\n' : input[i];
    if (quoted) { if (c === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; afterQuote = true; } } else { if (i === input.length) throw new Error('CSV 引号未闭合'); cell += c; } }
    else if (c === '"' && !cell && !afterQuote) quoted = true;
    else if (c === delimiter || c === '\n' || c === '\r') {
      row.push(cell.trim()); cell = ''; afterQuote = false;
      if (c !== delimiter) { if (row.some(Boolean)) records.push(row); row = []; if (c === '\r' && input[i + 1] === '\n') i++; }
    } else { if (afterQuote && c.trim()) throw new Error('CSV 引号后存在非法字符'); cell += c; }
  }
  if (records[0] && ['studentNo', '学号'].includes(records[0][0]) && ['name', '姓名'].includes(records[0][1])) records.shift();
  if (!records.length) throw new Error('请粘贴名册，格式为：学号,姓名');
  if (records.length > 1000) throw new Error('每次最多导入 1000 行');
  return records.map((r, i) => { if (r.length !== 2) throw new Error('第 ' + (i + 1) + ' 条数据应只有学号、姓名两列'); return { studentNo: r[0], name: r[1] }; });
}
module.exports = { token, schoolParts, toISO, formatTime, defaults, messageView, validateMessage, normalizeDisplaySettings, orderDisplayMessages, displaySettingsPayload, parseRoster, charCount };
