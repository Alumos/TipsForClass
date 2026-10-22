const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));

function readRgbaPng(file) {
  const data = fs.readFileSync(file);
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'invalid PNG signature: ' + file);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      assert.equal(chunk[8], 8, 'PNG bit depth must be 8: ' + file);
      assert.equal(chunk[9], 6, 'PNG must be RGBA: ' + file);
      assert.equal(chunk[12], 0, 'interlaced tab icon is not supported: ' + file);
    }
    if (type === 'IDAT') idat.push(chunk);
    offset += 12 + length;
  }
  assert(width && height && idat.length, 'incomplete PNG: ' + file);
  const compressed = Buffer.concat(idat);
  const raw = zlib.inflateSync(compressed);
  const stride = width * 4;
  assert.equal(raw.length, height * (stride + 1), 'unexpected PNG scanline data: ' + file);
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset++];
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset++];
      const left = x >= 4 ? pixels[rowStart + x - 4] : 0;
      const up = y ? pixels[previousStart + x] : 0;
      const upperLeft = y && x >= 4 ? pixels[previousStart + x - 4] : 0;
      let decoded = value;
      if (filter === 1) decoded += left;
      else if (filter === 2) decoded += up;
      else if (filter === 3) decoded += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceUp = Math.abs(estimate - up);
        const distanceUpperLeft = Math.abs(estimate - upperLeft);
        decoded += distanceLeft <= distanceUp && distanceLeft <= distanceUpperLeft ? left : distanceUp <= distanceUpperLeft ? up : upperLeft;
      } else assert.equal(filter, 0, 'unsupported PNG filter: ' + file);
      pixels[rowStart + x] = decoded & 255;
    }
  }
  return { width, height, pixels };
}

assert.equal(config.tabBar.color, '#7C8F84', 'tab bar normal color');
assert.equal(config.tabBar.selectedColor, '#0F6E56', 'tab bar selected color');
for (const item of config.tabBar.list) {
  for (const [relative, color] of [[item.iconPath, '#7C8F84'], [item.selectedIconPath, '#0F6E56']]) {
    assert(relative, 'missing tab icon path for ' + item.pagePath);
    const file = path.join(root, relative);
    assert(fs.existsSync(file), 'missing tab icon ' + relative);
    const png = readRgbaPng(file);
    assert.equal(png.width, 81, 'tab icon width: ' + relative);
    assert.equal(png.height, 81, 'tab icon height: ' + relative);
    let transparent = 0;
    let visible = 0;
    for (let index = 0; index < png.pixels.length; index += 4) {
      const alpha = png.pixels[index + 3];
      if (!alpha) transparent++;
      else {
        visible++;
        const actual = '#' + png.pixels.subarray(index, index + 3).toString('hex').toUpperCase();
        assert.equal(actual, color, 'tab icon color: ' + relative);
      }
    }
    assert(transparent > 0, 'tab icon has no transparent pixels: ' + relative);
    assert(visible > 0, 'tab icon is empty: ' + relative);
  }
}
for (const page of config.pages) {
  for (const ext of ['.js', '.wxml']) assert(fs.existsSync(path.join(root, page + ext)), 'missing page ' + page + ext);
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else {
      const content = fs.readFileSync(file, 'utf8');
      if (file.endsWith('.json')) JSON.parse(content);
      if (file.endsWith('.js')) new vm.Script(content, { filename: file });
      if (file.endsWith('.wxml')) {
        for (const expr of content.match(/\{\{[\s\S]*?\}\}/g) || []) assert(!/[A-Za-z_$][\w.$]*\s*\(/.test(expr), 'WXML method call: ' + expr);
        const stack = [];
        for (const match of content.matchAll(/<(\/?)([\w-]+)\b[^>]*?(\/?)>/g)) {
          const [, closing, tag, selfClosing] = match;
          if (closing) assert.equal(stack.pop(), tag, 'unbalanced WXML ' + file);
          else if (!selfClosing) stack.push(tag);
        }
        assert.equal(stack.length, 0, 'unclosed WXML ' + file);
      }
    }
  }
}
walk(root);
console.log('Miniapp JSON, JS syntax, page routes, WXML structure, tab icon size/color and transparency checks passed.');
