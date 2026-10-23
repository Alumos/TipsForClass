const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../utils/logic');
test('CSV preserves leading zero, quoted commas, escaped quotes, BOM and CRLF', () => {
  assert.deepEqual(logic.parseRoster('\uFEFF学号,姓名\r\n001,"陈,小禾"\r\n002,"林""一诺"\r\n'), [{ studentNo: '001', name: '陈,小禾' }, { studentNo: '002', name: '林"一诺' }]);
});
test('pasted spreadsheet text and malformed CSV', () => {
  assert.deepEqual(logic.parseRoster('学号\t姓名\n0001\t李明\n\n'), [{ studentNo: '0001', name: '李明' }]);
  assert.throws(() => logic.parseRoster('001,"未闭合'), /引号未闭合/);
  assert.throws(() => logic.parseRoster('001,李,明'), /两列/);
  assert.throws(() => logic.parseRoster(''), /请粘贴名册/);
  assert.throws(() => logic.parseRoster(Array(1001).fill('01,学生').join('\n')), /1000/);
});
test('UUID v4 idempotency identifiers are accepted shape and unique', () => {
  const values = Array.from({ length: 1000 }, () => logic.token());
  assert.equal(new Set(values).size, values.length);
  values.forEach(v => assert.match(v, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
});
test('school date conversion is independent of host timezone', () => {
  assert.equal(logic.toISO('2026-10-22', '08:00'), '2026-10-22T00:00:00.000Z');
  assert.deepEqual(logic.schoolParts('2026-10-22T23:30:00.000Z'), { date: '2026-10-23', time: '07:30' });
});
test('voice defaults to zero and notice rolls to the next day after 22:00', () => {
  const now = Date.parse('2026-10-22T02:00:00Z');
  assert.deepEqual(logic.defaults('call', now), { broadcastTimes: 0, expireDate: '2026-10-22', expireTime: '10:40' });
  assert.deepEqual(logic.defaults('batch', now), { broadcastTimes: 0, expireDate: '2026-10-22', expireTime: '12:00' });
  assert.deepEqual(logic.defaults('notice', now), { broadcastTimes: 0, expireDate: '2026-10-22', expireTime: '22:00' });
  assert.deepEqual(logic.defaults('notice', Date.parse('2026-10-22T14:00:00Z')), { broadcastTimes: 0, expireDate: '2026-10-23', expireTime: '22:00' });
});
const now = Date.parse('2026-10-22T02:00:00Z');
const base = { type: 'call', classIds: ['1'], studentIds: ['1'], title: '', body: '', destination: '办公室', broadcastTimes: 2, startAt: new Date(now).toISOString(), expireAt: new Date(now + 40 * 60000).toISOString() };
test('message validation supports empty notice body, forbids wrong type combinations', () => {
  assert.deepEqual(logic.validateMessage(base, now), []);
  assert.deepEqual(logic.validateMessage(Object.assign({}, base, { type: 'notice', title: '通知', destination: '', studentIds: [], broadcastTimes: 0 }), now), []);
  assert(logic.validateMessage(Object.assign({}, base, { classIds: ['1', '2'] }), now).length);
  assert(logic.validateMessage(Object.assign({}, base, { studentIds: ['1', '2', '3', '4'] }), now).length);
  assert(logic.validateMessage(Object.assign({}, base, { expireAt: new Date(now - 1).toISOString() }), now).length);
  assert(logic.validateMessage(Object.assign({}, base, { expireAt: new Date(now + 8 * 86400000).toISOString() }), now).length);
});
test('call and homework both require a location, and homework requires content', () => {
  const callErrors = logic.validateMessage(Object.assign({}, base, { destination: '', body: '' }), now);
  assert(callErrors.includes('请填写呼叫地点'));
  const homeworkErrors = logic.validateMessage(Object.assign({}, base, { type: 'batch', destination: '', body: '' }), now);
  assert(homeworkErrors.includes('请填写作业地点'));
  assert(homeworkErrors.includes('请填写作业内容'));
});
test('record cards keep people and follow-up information on separate lines', () => {
  const view = logic.messageView({
    type: 'call', status: 'active', destination: '三楼办公室', body: '请携带练习册',
    targets: [{ studentId: '1', name: '张三' }, { studentId: '2', name: '李四' }],
    createdAt: new Date(now).toISOString(), startAt: new Date(now).toISOString(), expireAt: new Date(now + 40 * 60000).toISOString()
  });
  assert.equal(view.recordTitle, '张三、李四');
  assert.equal(view.recordInfo, '请到 三楼办公室\n请携带练习册');
  const homework = logic.messageView({
    type: 'batch', status: 'active', destination: '物理实验室', body: '完成练习册第 3 页',
    targets: [{ studentId: '1', name: '王五' }],
    createdAt: new Date(now).toISOString(), startAt: new Date(now).toISOString(), expireAt: new Date(now + 120 * 60000).toISOString()
  });
  assert.equal(homework.recordTitle, '王五');
  assert.equal(homework.recordInfo, '作业地点：物理实验室\n完成练习册第 3 页');
});
test('validation counts Unicode characters rather than UTF16 code units', () => {
  assert.equal(logic.charCount('𠮷😀'), 2);
  assert.deepEqual(logic.validateMessage(Object.assign({}, base, { destination: '😀'.repeat(40) }), now), []);
  assert(logic.validateMessage(Object.assign({}, base, { destination: '😀'.repeat(41) }), now).length);
});
test('display settings normalize target fields and preserve explicit message order', () => {
  const normalized = logic.normalizeDisplaySettings({
    displaySettings: {
      displayPosition: 'center',
      pinnedMessageIds: ['2'],
      messageOrder: ['2', '1']
    },
    messages: [
      { id: '1', type: 'call' },
      { id: '2', type: 'batch' }
    ]
  });
  assert.equal(normalized.position, 'center');
  assert.equal(normalized.displayPosition, 'center');
  assert.deepEqual(normalized.pinnedMessageIds, ['2']);
  const ordered = logic.orderDisplayMessages(normalized.messages, normalized);
  assert.deepEqual(ordered.map(message => message.id), ['2', '1']);
  assert.equal(ordered[0].pinned, true);
  assert.equal(ordered[1].pinned, false);
});
test('display settings PUT payload carries position, pins and current order', () => {
  assert.deepEqual(logic.displaySettingsPayload('class-9', 'center', [
    { id: '2', pinned: true },
    { id: '1', pinned: false }
  ]), {
    classId: 'class-9',
    displayPosition: 'center',
    pinnedMessageIds: ['2'],
    messageOrder: ['2', '1']
  });
});
