const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
  assert(match, 'missing CSS rule ' + selector);
  return match[1];
}

test('home class cards stack title, status and heartbeat without horizontal squeeze', () => {
  const wxml = read('pages/home/home.wxml');
  const wxss = read('pages/home/home.wxss');
  const head = wxml.indexOf('class="class-card-head"');
  const status = wxml.indexOf('class="class-device-status');
  const heartbeat = wxml.indexOf('class="class-heartbeat"');

  assert(head >= 0 && head < status && status < heartbeat, 'class card sections must stack in visual order');
  assert.doesNotMatch(wxml, /class="card row class-card"/, 'class card must not use the old three-column row');
  assert.match(rule(wxss, '.class-name'), /white-space:nowrap/);
  assert.match(rule(wxss, '.class-name'), /text-overflow:ellipsis/);
  assert.match(rule(wxss, '.class-identity'), /min-width:0/);
  assert.match(rule(wxss, '.class-actions'), /flex-shrink:0/);
  assert.match(rule(wxss, '.class-heartbeat'), /border-top:/);
});

test('long-name layouts keep actions visible and text containers shrinkable', () => {
  const records = read('pages/records/records.wxss');
  const publish = read('pages/publish/publish.wxss');
  const admin = read('pages/admin/admin.wxss');
  const arrange = read('pages/arrange/arrange.wxss');

  assert.match(rule(records, '.records-toolbar'), /flex-direction:column/);
  assert.match(rule(records, '.record-meta'), /min-width:0/);
  assert.match(rule(records, '.record-action-row'), /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(rule(records, '.record-action-row button'), /white-space:nowrap/);
  assert.match(rule(records, '.record-detail'), /flex-shrink:0/);

  assert.match(rule(publish, '.class-switch'), /display:flex/);
  assert.match(rule(publish, '.class-current-name'), /text-overflow:ellipsis/);
  assert.match(rule(publish, '.class-switch-copy'), /min-width:0/);
  assert.match(rule(publish, '.class-switch-link'), /flex-shrink:0/);
  assert.match(rule(publish, '.student-copy'), /min-width:0/);
  assert.doesNotMatch(publish, /\.current-class-lock/);

  assert.match(rule(admin, '.admin-card-copy'), /min-width:0/);
  assert.match(rule(admin, '.admin-head-badge'), /flex-shrink:0/);
  assert.match(rule(admin, '.class-manage-copy'), /min-width:0/);
  assert.match(rule(admin, '.mini-actions'), /flex-shrink:0/);
  assert.match(rule(admin, '.file-name'), /text-overflow:ellipsis/);
  assert.match(rule(admin, '.admin-option-copy'), /min-width:0/);

  assert.match(rule(arrange, '.arrange-item'), /flex-direction:column/);
  assert.match(rule(arrange, '.arrange-actions'), /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(rule(arrange, '.arrange-actions .small-button'), /min-height:44px/);
  assert.doesNotMatch(arrange, /\.arrange-actions\{width:132rpx/);
});

test('arrange page keeps display position on each message and out of global controls', () => {
  const wxml = read('pages/arrange/arrange.wxml');
  assert.doesNotMatch(wxml, /class="position-grid"/);
  assert.doesNotMatch(wxml, /bindtap="choosePosition"/);
  assert.match(wxml, /item\.displayPositionLabel/);
  assert.match(wxml, /展示位置[^<]*发布[^<]*逐条选择/);
});

test('message management exposes edit, delete, long-body preview and accurate pinned ordering', () => {
  const records = read('pages/records/records.wxml');
  const detail = read('pages/detail/detail.wxml');
  const detailCss = read('pages/detail/detail.wxss');
  const arrange = read('pages/arrange/arrange.wxml');
  const arrangeJs = read('pages/arrange/arrange.js');

  assert.match(records, /record-info-preview/);
  assert.match(records, /catchtap="edit"/);
  assert.match(records, /删除公告/);
  assert(records.indexOf('catchtap="edit"') < records.indexOf('catchtap="remove"'));

  assert(detail.indexOf('class="notice-title detail-title"') < detail.indexOf('class="pre detail-body"'));
  assert(detail.indexOf('bindtap="edit"') < detail.indexOf('bindtap="remove"'));
  assert.match(detail, /class="danger detail-delete" bindtap="remove"/);
  assert.match(rule(detailCss, '.detail-actions'), /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(detailCss, /@media \(max-width:360px\)/);

  assert.match(arrange, /!item\.pinned \|\| !item\.canMoveUp/);
  assert.match(arrange, /item\.orderHint/);
  assert.match(arrangeJs, /if \(!current \|\| !current\.pinned\) return;/);
});

test('publish offers both per-message positions with narrow-screen fallbacks', () => {
  const wxml = read('pages/publish/publish.wxml');
  const wxss = read('pages/publish/publish.wxss');
  assert.match(wxml, /data-value="top_right"/);
  assert.match(wxml, /data-value="center"/);
  assert.match(rule(wxss, '.position-grid'), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(wxss, /@media \(max-width:360px\)\{[\s\S]*\.position-grid\{grid-template-columns:1fr\}/);
  assert.match(rule(wxss, '.bottom-actions button'), /white-space:normal/);
});
