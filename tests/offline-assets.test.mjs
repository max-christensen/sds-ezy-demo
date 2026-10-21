import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeVersion, shellFiles, render, listFiles } from '../scripts/bump-version.mjs';
import { readLogo, build, decode, measureCharcoal, isLettering, CHARCOAL, CHARCOAL_HEX, SOURCE, SAFE_RADIUS, plain } from '../scripts/make-icons.mjs';

const pub = (f) => new URL('../public/' + f, import.meta.url);
const LOGO_SHA256 = 'a0e77c6437dcd0b0f6a8f888ac42aba9b6eee76c48384f84500a23509b864fb7';
const logo = readLogo();
const ihdr = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
function letterStats(img) {
  let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, sx = 0, sy = 0, far = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (isLettering(...px(img, x, y))) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); sx += x + 0.5; sy += y + 0.5; far = Math.max(far, Math.hypot(x + 0.5 - img.width / 2, y + 0.5 - img.height / 2)); }
  }
  return { n, x0, x1, y0, y1, cx: sx / n, cy: sy / n, far };
}

test('the source logo is Brand/SDS-EZY.png, 1024x1024 RGBA, and has not been edited (sha256)', () => {
  const buf = readFileSync(SOURCE);
  assert.equal(createHash('sha256').update(buf).digest('hex'), LOGO_SHA256, 'Brand/SDS-EZY.png changed: it must never be edited, only resampled');
  assert.deepEqual([logo.width, logo.height, buf[25]], [1024, 1024, 6]);
  assert.deepEqual(measureCharcoal(logo).rgb, CHARCOAL);
  assert.equal(CHARCOAL_HEX, '#282828');
});

const SIZES = { 'icons/favicon-16.png': 16, 'icons/favicon-32.png': 32, 'icons/apple-touch-icon.png': 180, 'icons/icon-192.png': 192, 'icons/icon-512.png': 512, 'icons/icon-maskable-512.png': 512, 'icons/logo-128.png': 128, 'icons/logo-256.png': 256 };

test('every produced icon exists with exactly the expected pixel size', () => {
  for (const [f, n] of Object.entries(SIZES)) {
    const buf = readFileSync(pub(f));
    assert.equal(buf.subarray(1, 4).toString(), 'PNG', f);
    assert.deepEqual([ihdr(buf).w, ihdr(buf).h], [n, n], f);
  }
});

test('icons are deterministic: regenerating gives identical bytes, and the committed files hold the same pixels', () => {
  const a = build(logo), b = build(logo);
  for (const f of Object.keys(a)) assert.ok(a[f].equals(b[f]), f + ' differs between runs');
  for (const f of Object.keys(a)) {
    const disk = readFileSync(pub(f));
    if (f.endsWith('.ico')) { assert.equal(disk.length, a[f].length, f); continue; }
    assert.deepEqual(decode(disk).data, decode(a[f]).data, f + ' is out of date: run node scripts/make-icons.mjs');
  }
});

test('apple-touch-icon and the maskable icon are fully opaque and all four corners are the logo charcoal', () => {
  for (const f of ['icons/apple-touch-icon.png', 'icons/icon-maskable-512.png']) {
    const img = decode(readFileSync(pub(f)));
    for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255, f + ' has a non-opaque pixel');
    for (const [x, y] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) assert.deepEqual(px(img, x, y), [...CHARCOAL, 255], f + ' corner ' + x + ',' + y);
  }
});

test('the maskable icon keeps all lettering inside the centre safe circle (radius 0.40 of the width)', () => {
  const img = decode(readFileSync(pub('icons/icon-maskable-512.png')));
  const s = letterStats(img);
  assert.ok(s.n > 20000, 'lettering found: ' + s.n);
  assert.ok(s.far <= SAFE_RADIUS * img.width, 'lettering reaches ' + s.far.toFixed(1) + ' px from the centre, the safe radius is ' + SAFE_RADIUS * img.width);
  assert.ok(s.x0 >= img.width * 0.1 && s.x1 <= img.width * 0.9 && s.y0 >= img.height * 0.1 && s.y1 <= img.height * 0.9, 'also inside the middle 80% square');
});

test('the apple icon has the lettering at the same scale and position as the plain logo at 180 px (within 1 px)', () => {
  const a = letterStats(decode(readFileSync(pub('icons/apple-touch-icon.png'))));
  const p = letterStats(plain(logo, 180));
  for (const k of ['x0', 'x1', 'y0', 'y1', 'cx', 'cy']) assert.ok(Math.abs(a[k] - p[k]) <= 1, k + ': ' + a[k] + ' vs ' + p[k]);
  assert.ok(Math.abs(a.n - p.n) / p.n < 0.02, 'same amount of lettering');
});

test('the plain icons keep their transparent rounded corners and have no dark fringe', () => {
  for (const f of ['icons/icon-192.png', 'icons/icon-512.png', 'icons/logo-128.png', 'icons/logo-256.png', 'icons/favicon-32.png']) {
    const img = decode(readFileSync(pub(f)));
    for (const [x, y] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) assert.ok(px(img, x, y)[3] <= 8, f + ' corner is transparent (alpha ' + px(img, x, y)[3] + ')');
  }
  // No translucent pixel is darker than the logo's own dark outline (12,37,49 / 4,36,51): premultiplied resampling gives no black halo.
  const img = decode(readFileSync(pub('icons/icon-512.png')));
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] >= 32 && img.data[i + 3] < 255) assert.ok(img.data[i + 1] >= 30 && img.data[i + 2] >= 30, 'dark fringe pixel ' + [...img.data.subarray(i, i + 4)]);
  }
});

test('favicon.ico parses: 3 PNG entries of 16, 32 and 48', () => {
  const b = readFileSync(pub('favicon.ico'));
  assert.deepEqual([b.readUInt16LE(0), b.readUInt16LE(2), b.readUInt16LE(4)], [0, 1, 3]);
  const sizes = [];
  for (let i = 0; i < 3; i++) {
    const e = 6 + 16 * i, len = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
    assert.equal(b.readUInt16LE(e + 6), 32);
    assert.deepEqual([...b.subarray(off, off + 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
    assert.ok(off + len <= b.length);
    sizes.push([b[e], b[e + 1], b.readUInt32BE(off + 16), b.readUInt32BE(off + 20)]);
  }
  assert.deepEqual(sizes, [[16, 16, 16, 16], [32, 32, 32, 32], [48, 48, 48, 48]]);
});

test('manifest is installable: name, start_url, scope, standalone, separate any and maskable icons that exist', () => {
  const m = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'SDS EZY');
  assert.ok(m.short_name);
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.background_color.toLowerCase(), CHARCOAL_HEX, 'splash background matches the logo plate');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(m.icons.map((i) => [i.src, i.sizes, i.purpose, i.type]), [
    ['/icons/icon-192.png', '192x192', 'any', 'image/png'],
    ['/icons/icon-512.png', '512x512', 'any', 'image/png'],
    ['/icons/icon-maskable-512.png', '512x512', 'maskable', 'image/png']
  ]);
  for (const i of m.icons) assert.equal(ihdr(readFileSync(pub(i.src.slice(1)))).w, Number(i.sizes.split('x')[0]));
});

test('_headers makes the worker, the version file and the manifest no-cache', () => {
  const h = readFileSync(pub('_headers'), 'utf8');
  for (const p of ['/sw.js', '/app-version.js', '/manifest.webmanifest']) assert.match(h, new RegExp('^' + p.replace(/[.]/g, '\\.') + '\\n\\s+Cache-Control: no-cache', 'm'));
});

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ezy-ver-'));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
  return dir;
}

test('version is a stable content hash: ignores app-version.js, OS noise and line endings; changes with any file', () => {
  const base = { 'index.html': '<p>a\n</p>', 'app.js': 'x', 'lib/a.js': 'y', 'sw.js': 's' };
  const d1 = tree(base);
  const v = computeVersion(d1);
  assert.match(v, /^[0-9a-f]{16}$/);
  assert.equal(computeVersion(d1), v);
  assert.equal(computeVersion(tree({ ...base, 'app-version.js': 'self.APP_VERSION="zzz"', '.DS_Store': 'q', 'lib/Thumbs.db': 'q' })), v);
  assert.equal(computeVersion(tree({ ...base, 'index.html': '<p>a\r\n</p>' })), v, 'CRLF does not change it');
  assert.notEqual(computeVersion(tree({ ...base, 'lib/a.js': 'y2' })), v);
  assert.notEqual(computeVersion(tree({ ...base, 'lib/b.js': 'z' })), v);
  assert.notEqual(computeVersion(tree({ ...base, 'sw.js': 's2' })), v, 'the worker itself is part of the version');
  rmSync(d1, { recursive: true, force: true });
});

test('shell list: app files and icons yes; vendor, sw.js, _headers and licences no; index.html is "/"', () => {
  const d = tree({ 'index.html': 'i', 'app.js': 'a', 'sw.js': 's', '_headers': 'h', 'vendor/big.js': 'v', 'vendor/LICENSES.txt': 'l', 'views/a.js': 'a', 'icons/x.png': 'p', 'lib/ghs-ref.mjs': 'g', 'pictograms/flame.gif': 'f' });
  assert.deepEqual(shellFiles(d), ['/', '/app-version.js', '/app.js', '/icons/x.png', '/lib/ghs-ref.mjs', '/pictograms/flame.gif', '/views/a.js']);
  const text = render(d);
  assert.match(text, /^self\.APP_VERSION = "[0-9a-f]{16}";\n/);
  const ctx = { self: {} };
  new Function('self', text)(ctx.self);
  assert.equal(ctx.self.APP_SHELL.length, 7);
});

test('the real public/ tree: the shell list names only files that exist', () => {
  const have = new Set(listFiles().map((f) => '/' + f));
  for (const u of shellFiles()) if (u !== '/' && u !== '/app-version.js') assert.ok(have.has(u), u);
  assert.ok(shellFiles().includes('/lib/ghs-ref.mjs'));
});
