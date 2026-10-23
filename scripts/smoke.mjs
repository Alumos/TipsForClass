#!/usr/bin/env node
/** Real HTTP + WebSocket integration test against an isolated demo server. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import runMiniapp from './miniapp-api-flow.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SMOKE_PORT || 18080);
const base = `http://127.0.0.1:${port}`;
const temp = await mkdtemp(path.join(tmpdir(), 'classroom-smoke-'));
const binary = path.join(temp, process.platform === 'win32' ? 'notice-api.exe' : 'notice-api');
const cache = path.join(root, '.tools');
await mkdir(cache, { recursive: true });
const env = { ...process.env, APP_MODE: 'demo', HTTP_ADDR: `127.0.0.1:${port}`, DATABASE_PATH: path.join(temp, 'notice.db'), GOCACHE: process.env.GOCACHE || path.join(cache, 'go-build'), GOMODCACHE: process.env.GOMODCACHE || path.join(cache, 'go-mod') };
let server;
let output = '';
const sockets = [];
const checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function mark(label) { checks.push(label); console.log(`✓ ${label}`); }
async function api(route, { method = 'GET', token, body, status = 200 } = {}) {
  const response = await fetch(`${base}${route.startsWith('/health') ? route : '/api/v1' + route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(payload)}`);
  if (status < 300) assert.equal(payload.code, 0);
  return payload.data ?? payload;
}
async function start() {
  server = spawn(binary, [], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  output = '';
  server.stdout.on('data', b => { output += b; });
  server.stderr.on('data', b => { output += b; });
  let last;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try { await api('/healthz'); return; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Server not ready: ${last}\n${output}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const stopped = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([stopped, sleep(5000).then(() => { if (server.exitCode === null) server.kill('SIGKILL'); })]);
}
async function connect(token) {
  const ticket = await api('/device/ws-ticket', { method: 'POST', token, body: {} });
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws/device?ticket=${encodeURIComponent(ticket.ticket)}`);
  const events = [];
  sockets.push(ws);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS ready timeout')), 5000);
    ws.addEventListener('message', e => {
      const event = JSON.parse(e.data);
      events.push(event);
      if (event.event === 'ready') { clearTimeout(timer); resolve(); }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS connect failed')); });
  });
  await ready;
  return { ws, events, wait: async predicate => {
    for (let i = 0; i < 100; i++) { const found = events.find(predicate); if (found) return found; await sleep(50); }
    throw new Error(`WS event missing. Seen: ${events.map(e => e.event).join(', ')}`);
  } };
}
try {
  // Do not accidentally test or overwrite a server already using this port.
  try { await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) }); throw new Error(`Port ${port} is already in use; choose SMOKE_PORT.`); }
  catch (e) { if (e.message.includes('already in use')) throw e; }
  const build = spawnSync('go', ['build', '-o', binary, './cmd/server'], { cwd: path.join(root, 'server'), env, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  await start();
  const login = await api('/auth/demo-login', { method: 'POST', body: {} });
  const teacher = login.token;
  await api('/classes', { status: 401 });
  const classes = (await api('/classes', { token: teacher })).items;
  assert(classes.length >= 2);
  assert.equal(classes[0].deviceCount, 0);
  mark('演示登录有效；未登录读取被拒绝；不伪造已绑定设备');

  async function bind(item, label) {
    const code = await api(`/admin/classes/${item.id}/bind-codes`, { method: 'POST', token: teacher, body: {}, status: 201 });
    const body = { bindCode: code.bindCode, installationId: randomUUID(), label };
    const bound = await api('/devices/bind', { method: 'POST', body });
    return { ...bound, body };
  }
  const first = await bind(classes[0], '自动验证屏一');
  const second = await bind(classes[1], '自动验证屏二');
  await api('/devices/bind', { method: 'POST', body: { ...first.body, installationId: randomUUID() }, status: 400 });
  const token = first.deviceToken;
  const connection = await connect(token);
  const snapshot = await api('/device/snapshot', { token });
  assert.equal(snapshot.class.id, classes[0].id);
  assert.equal(snapshot.protocolVersion, 1);
  mark('绑定码一次消费；WebSocket 票据连接；快照只返回绑定班级');

  const students = (await api(`/students?classId=${classes[0].id}`, { token: teacher })).items;
  const body = { clientToken: randomUUID(), type: 'call', classIds: [classes[0].id], studentIds: [students[0].id], destination: '三楼办公室', body: '自动验证样例', broadcastTimes: 2, expireAt: new Date(Date.now() + 40 * 60000).toISOString() };
  const created = await api('/messages', { method: 'POST', token: teacher, body, status: 201 });
  const repeat = await api('/messages', { method: 'POST', token: teacher, body });
  assert.equal(repeat.id, created.id);
  await api('/messages', { method: 'POST', token: teacher, body: { ...body, destination: '不同地点' }, status: 409 });
  const event = await connection.wait(e => e.event === 'message.upsert' && e.data.id === created.id);
  assert(BigInt(event.seq) > BigInt(snapshot.watermark));
  assert.equal(event.data.broadcast.generation, 0);
  assert.equal(event.syncEpoch, snapshot.syncEpoch);
  assert(event.data.speechText.includes(students[0].name));
  assert(!event.data.title.includes(students[0].name));
  assert(!(await api('/device/snapshot', { token: second.deviceToken })).messages.some(m => m.id === created.id));
  mark('发布持久化、幂等重试、冲突拒绝、真实 WS 事件和班级数据隔离');

  const display = await api(`/classes/${classes[0].id}/display-settings`, { method: 'PUT', token: teacher, body: { classId: classes[0].id, position: 'center', pinnedMessageIds: [created.id] } });
  assert.equal(display.displayPosition, 'center');
  assert.deepEqual(display.pinnedMessageIds, [created.id]);
  const displayEvent = await connection.wait(e => e.event === 'class.display' && e.data.displaySettings.revision === display.revision);
  assert.deepEqual(displayEvent.data.displaySettings.pinnedMessageIds, [created.id]);
  const pinnedSnapshot = await api('/device/snapshot', { token });
  assert.equal(pinnedSnapshot.displaySettings.displayPosition, 'center');
  assert.deepEqual(pinnedSnapshot.displaySettings.pinnedMessageIds, [created.id]);
  assert.equal(pinnedSnapshot.messages[0].id, created.id);
  mark('共享屏幕位置与置顶顺序持久化，class.display 事件和快照同步');

  const items = [{ messageId: created.id, revision: created.revision, kind: 'delivery', state: 'received' }, { messageId: created.id, revision: created.revision, kind: 'delivery', state: 'displayed' }, { messageId: created.id, generation: 0, round: 1, kind: 'broadcast', status: 'played' }];
  await api('/device/receipts', { method: 'POST', token, body: { syncEpoch: snapshot.syncEpoch, items } });
  await api('/device/receipts', { method: 'POST', token, body: { syncEpoch: snapshot.syncEpoch, items } });
  const delivery = await api(`/messages/${created.id}/delivery`, { token: teacher });
  assert.equal(delivery.displayedDeviceCount, 1);
  assert.equal(delivery.targetDeviceCount, 1);
  mark('真实展示/播报回执与重复回执幂等，投递详情可查询');

  const replayBody = { clientToken: randomUUID(), times: 1 };
  const replay = await api(`/messages/${created.id}/rebroadcast`, { method: 'POST', token: teacher, body: replayBody });
  assert.equal(replay.generation, 1);
  assert.equal((await api(`/messages/${created.id}/rebroadcast`, { method: 'POST', token: teacher, body: replayBody })).generation, 1);
  await connection.wait(e => e.event === 'message.replay' && e.data.broadcast.generation === 1);
  mark('手动重播生成独立批次，网络重试不重复增加批次');

  await api(`/messages/${created.id}/revoke`, { method: 'POST', token: teacher, body: {} });
  await connection.wait(e => e.event === 'message.revoked' && e.data.id === created.id);
  const afterRevoke = await api('/device/snapshot', { token });
  assert(!afterRevoke.messages.some(m => m.id === created.id));
  assert.deepEqual(afterRevoke.displaySettings.pinnedMessageIds, []);
  mark('撤回事件抵达，快照不再包含公告且自动移除置顶');

  const preview = await api('/admin/rosters/preview', { method: 'POST', token: teacher, body: { classId: classes[0].id, rows: [{ studentNo: '000090', name: '测试同学' }] } });
  assert.equal(preview.valid, true);
  const imported = await api('/admin/rosters/commit', { method: 'POST', token: teacher, body: { importId: preview.importId } });
  assert.equal(imported.created, 1);
  assert.equal((await api('/admin/rosters/commit', { method: 'POST', token: teacher, body: { importId: preview.importId } })).created, 1);
  mark('名册预检和幂等导入，保留学号前导零');

  await runMiniapp({ base, classId: classes[0].id, teacherLogin: login, rawApi: api });
  mark('小程序原始 Page 方法真实调用 API：发布、投递详情、管理员 POST 修改');

  connection.ws.close();
  await stop();
  await start();
  assert.equal((await api(`/messages/${created.id}`, { token: teacher })).status, 'revoked');
  assert.equal((await api('/device/snapshot', { token })).syncEpoch, snapshot.syncEpoch);
  mark('服务重启后公告状态、会话、绑定与同步纪元保持');
  console.log(`\n${checks.length} 项跨端协议验证通过。测试使用临时数据库，不修改本地演示数据。`);
} catch (error) {
  console.error(error);
  console.error(output.slice(-4000));
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close();
  await stop();
  await rm(temp, { recursive: true, force: true });
}
