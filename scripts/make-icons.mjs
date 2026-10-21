// Makes the app icons from the real logo, Brand/SDS-EZY.png (1024x1024 RGBA). Run: node scripts/make-icons.mjs
// The artwork is never redrawn or recoloured: it is only resampled (Lanczos-3 on premultiplied alpha, so the transparent rounded
// corners get no dark fringe), cropped, and composited over its own charcoal. Deterministic: same input, same bytes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = join(root, 'Brand', 'SDS-EZY.png');
const outDir = join(root, 'public', 'icons');

// The logo plate's own charcoal (measured: the colour of 480,379 of the opaque pixels; see measureCharcoal).
export const CHARCOAL = [40, 40, 40];
export const CHARCOAL_HEX = '#282828';
// The crop that is composited for the full-bleed icons. The source plate is rounded with a thin dark outline; an inset of
// 52 px on every side is the smallest that has no transparent and no outline pixel inside it (60 would clip the last row of lettering).
export const CROP_INSET = 52;
export const SAFE_RADIUS = 0.40; // of the icon's width, for the maskable icon

export const isLettering = (r, g, b, a) => r > 180 && g > 120 && b < 110 && a > 200;

export function readLogo(buf = readFileSync(SOURCE)) {
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: p.data };
}
export function measureCharcoal(img) {
  const h = new Map();
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] === 255) { const k = img.data[i] + ',' + img.data[i + 1] + ',' + img.data[i + 2]; h.set(k, (h.get(k) || 0) + 1); }
  const [k, n] = [...h.entries()].sort((a, b) => b[1] - a[1])[0];
  return { rgb: k.split(',').map(Number), pixels: n };
}

// ---------------------------------------------------------------- resampling (premultiplied, Lanczos-3)
const lanczos = (x) => { if (x === 0) return 1; if (Math.abs(x) >= 3) return 0; const px = Math.PI * x; return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px); };

function premultiply(img) {
  const f = new Float32Array(img.width * img.height * 4);
  for (let i = 0; i < f.length; i += 4) { const a = img.data[i + 3] / 255; f[i] = img.data[i] * a; f[i + 1] = img.data[i + 1] * a; f[i + 2] = img.data[i + 2] * a; f[i + 3] = img.data[i + 3]; }
  return f;
}
function taps(o, s, t, n, edge) {
  const c = (o + 0.5 - t) / s - 0.5;               // where output pixel o falls in source pixel coordinates
  const k = Math.min(1, s), sup = 3 / k;
  const list = []; let total = 0;
  for (let i = Math.floor(c - sup) + 1; i <= Math.floor(c + sup); i++) {
    const w = lanczos((i - c) * k); if (w === 0) continue;
    total += w;
    if (edge === 'clamp') list.push([Math.min(n - 1, Math.max(0, i)), w]);
    else if (i >= 0 && i < n) list.push([i, w]);   // 'zero': outside the picture counts as transparent
  }
  return list.map(([i, w]) => [i, w / total]);
}
// Scale by s and shift by (tx, ty) output pixels; returns premultiplied floats (outW x outH x 4).
export function resample(img, s, tx, ty, outW, outH, edge = 'clamp') {
  const src = premultiply(img), W = img.width, H = img.height;
  const mid = new Float32Array(outW * H * 4);
  const hx = Array.from({ length: outW }, (_, x) => taps(x, s, tx, W, edge));
  for (let y = 0; y < H; y++) for (let x = 0; x < outW; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [i, w] of hx[x]) { const p = (y * W + i) * 4; r += src[p] * w; g += src[p + 1] * w; b += src[p + 2] * w; a += src[p + 3] * w; }
    const q = (y * outW + x) * 4; mid[q] = r; mid[q + 1] = g; mid[q + 2] = b; mid[q + 3] = a;
  }
  const out = new Float32Array(outW * outH * 4);
  const vy = Array.from({ length: outH }, (_, y) => taps(y, s, ty, H, edge));
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [j, w] of vy[y]) { const p = (j * outW + x) * 4; r += mid[p] * w; g += mid[p + 1] * w; b += mid[p + 2] * w; a += mid[p + 3] * w; }
    const q = (y * outW + x) * 4;
    a = Math.min(255, Math.max(0, a));
    out[q] = Math.min(a, Math.max(0, r)); out[q + 1] = Math.min(a, Math.max(0, g)); out[q + 2] = Math.min(a, Math.max(0, b)); out[q + 3] = a;
  }
  return { width: outW, height: outH, pm: out };
}
// Premultiplied -> straight RGBA bytes (transparent corners stay transparent, no fringe).
function toStraight(r) {
  const d = Buffer.alloc(r.width * r.height * 4);
  for (let i = 0; i < r.pm.length; i += 4) {
    const a = r.pm[i + 3];
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) d[i + c] = Math.round(Math.min(255, (r.pm[i + c] * 255) / a));
    d[i + 3] = Math.round(a);
  }
  return { width: r.width, height: r.height, data: d };
}
// Premultiplied image over an opaque fill -> opaque RGBA.
function overFill(r, fill) {
  const d = Buffer.alloc(r.width * r.height * 4);
  for (let i = 0; i < r.pm.length; i += 4) {
    const k = 1 - r.pm[i + 3] / 255;
    for (let c = 0; c < 3; c++) d[i + c] = Math.round(Math.min(255, r.pm[i + c] + fill[c] * k));
    d[i + 3] = 255;
  }
  return { width: r.width, height: r.height, data: d };
}
function crop(img, inset) {
  const w = img.width - 2 * inset, h = img.height - 2 * inset;
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(d, y * w * 4, ((y + inset) * img.width + inset) * 4, ((y + inset) * img.width + inset + w) * 4);
  return { width: w, height: h, data: d };
}
export function encode(img) { return PNG.sync.write(Object.assign(new PNG({ width: img.width, height: img.height }), { data: img.data }), { colorType: 6, deflateLevel: 9 }); }
export function decode(buf) { return readLogo(buf); }

// ---------------------------------------------------------------- the icons
// The logo as is, scaled to n x n (transparent corners kept).
export function plain(logo, n) { return toStraight(resample(logo, n / logo.width, 0, 0, n, n, 'clamp')); }

// Full-bleed, opaque, charcoal-filled; the central crop is composited at the same scale and position it has in the plain logo.
export function appleTouch(logo, n = 180) {
  const c = crop(logo, CROP_INSET), s = n / logo.width, off = CROP_INSET * s;
  return overFill(resample(c, s, off, off, n, n, 'zero'), CHARCOAL);
}

// Furthest distance from the source centre of any pixel that is not plain charcoal inside the crop (lettering and its shadow/outline).
export function contentRadius(logo) {
  const cx = logo.width / 2, cy = logo.height / 2;
  let far = 0;
  for (let y = CROP_INSET; y < logo.height - CROP_INSET; y++) for (let x = CROP_INSET; x < logo.width - CROP_INSET; x++) {
    const i = (y * logo.width + x) * 4, d = logo.data;
    if (Math.abs(d[i] - CHARCOAL[0]) + Math.abs(d[i + 1] - CHARCOAL[1]) + Math.abs(d[i + 2] - CHARCOAL[2]) > 3) {
      // farthest corner of the pixel
      const dx = Math.max(Math.abs(x - cx), Math.abs(x + 1 - cx)), dy = Math.max(Math.abs(y - cy), Math.abs(y + 1 - cy));
      far = Math.max(far, Math.hypot(dx, dy));
    }
  }
  return far;
}
// Maskable: all lettering inside the circle of radius SAFE_RADIUS x n (1.5 px of margin for the resampling).
export function maskableScale(logo, n = 512) { return (SAFE_RADIUS * n - 1.5) / contentRadius(logo); }
export function maskable(logo, n = 512) {
  const c = crop(logo, CROP_INSET), s = maskableScale(logo, n);
  const t = n / 2 - (logo.width / 2) * s; // the logo's centre is the icon's centre
  return overFill(resample(c, s, t + CROP_INSET * s, t + CROP_INSET * s, n, n, 'zero'), CHARCOAL);
}

// ICO with PNG-compressed entries (16, 32, 48).
export function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, png }, i) => {
    const p = 6 + 16 * i;
    head[p] = size >= 256 ? 0 : size; head[p + 1] = size >= 256 ? 0 : size; head[p + 2] = 0; head[p + 3] = 0;
    head.writeUInt16LE(1, p + 4); head.writeUInt16LE(32, p + 6); head.writeUInt32LE(png.length, p + 8); head.writeUInt32LE(off, p + 12);
    off += png.length;
  });
  return Buffer.concat([head, ...pngs.map((x) => x.png)]);
}

// Every file this script writes: [path under public/, builder].
export function build(logo = readLogo()) {
  const files = {
    'icons/favicon-16.png': encode(plain(logo, 16)),
    'icons/favicon-32.png': encode(plain(logo, 32)),
    'icons/apple-touch-icon.png': encode(appleTouch(logo, 180)),
    'icons/icon-192.png': encode(plain(logo, 192)),
    'icons/icon-512.png': encode(plain(logo, 512)),
    'icons/icon-maskable-512.png': encode(maskable(logo, 512)),
    'icons/logo-128.png': encode(plain(logo, 128)),
    'icons/logo-256.png': encode(plain(logo, 256)),
  };
  files['favicon.ico'] = ico([16, 32, 48].map((size) => ({ size, png: encode(plain(logo, size)) })));
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const logo = readLogo();
  const m = measureCharcoal(logo);
  let n = 0;
  for (let i = 0; i < logo.data.length; i += 4) if (isLettering(logo.data[i], logo.data[i + 1], logo.data[i + 2], logo.data[i + 3])) n++;
  mkdirSync(outDir, { recursive: true });
  for (const [f, buf] of Object.entries(build(logo))) { writeFileSync(join(root, 'public', f), buf); console.log(`public/${f}  ${buf.length} bytes`); }
  console.log(`charcoal ${m.rgb.join(',')} (${m.pixels} px); lettering pixels ${n}; maskable scale ${maskableScale(logo).toFixed(4)}; content radius ${contentRadius(logo).toFixed(1)} source px`);
}
