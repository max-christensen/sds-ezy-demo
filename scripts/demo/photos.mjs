// Generates clearly fictional "photos" for the demo audits: a drawn cartoon of a tin, bottle, jerry can, aerosol or tub on a
// bench, with a plain label in blocky pixel-font text and the words FICTIONAL DEMO PHOTO in the corner. Pure JS (jpeg-js), deterministic.
import jpeg from 'jpeg-js';

export const W = 640, H = 480;

const FONT = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.', C: '.####|#....|#....|#....|#....|#....|.####',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.', E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.####|#....|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#', I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#', O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....', Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..', U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.', 2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '####.|....#|....#|.###.|....#|....#|####.', 4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '.###.|#....|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...', 8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|....#|.###.',
  ' ': '.....|.....|.....|.....|.....|.....|.....', '-': '.....|.....|.....|#####|.....|.....|.....', '.': '.....|.....|.....|.....|.....|.##..|.##..',
  '?': '.###.|#...#|....#|...#.|..#..|.....|..#..', ':': '.....|.##..|.##..|.....|.##..|.##..|.....', '/': '....#|....#|...#.|..#..|.#...|#....|#....',
  '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##',
};

class Canvas {
  constructor(seed) { this.d = new Uint8Array(W * H * 4); this.s = seed >>> 0 || 1; }
  rnd() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s / 4294967296; }
  px(x, y, c) { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = 255; }
  rect(x, y, w, h, c) { for (let j = Math.round(y); j < Math.round(y + h); j++) for (let i = Math.round(x); i < Math.round(x + w); i++) this.px(i, j, c); }
  rrect(x, y, w, h, r, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const dx = Math.max(r - i, i - (w - 1 - r), 0), dy = Math.max(r - j, j - (h - 1 - r), 0); if (dx * dx + dy * dy <= r * r) this.px(Math.round(x + i), Math.round(y + j), c); } }
  ellipse(cx, cy, rx, ry, c, alpha = 1) {
    for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) if ((i * i) / (rx * rx) + (j * j) / (ry * ry) <= 1) {
      const x = Math.round(cx + i), y = Math.round(cy + j);
      if (alpha === 1) this.px(x, y, c);
      else if (x >= 0 && y >= 0 && x < W && y < H) { const k = (y * W + x) * 4; for (let q = 0; q < 3; q++) this.d[k + q] = Math.round(this.d[k + q] * (1 - alpha) + c[q] * alpha); }
    }
  }
  text(str, x, y, scale, c) {
    let cx = x;
    for (const ch of String(str).toUpperCase()) {
      const g = (FONT[ch] || FONT['?']).split('|');
      g.forEach((row, ry) => [...row].forEach((v, rx) => { if (v === '#') this.rect(cx + rx * scale, y + ry * scale, scale, scale, c); }));
      cx += 6 * scale;
    }
  }
  textWidth(str, scale) { return String(str).length * 6 * scale - scale; }
  centered(str, cx, y, scale, c) { this.text(str, Math.round(cx - this.textWidth(str, scale) / 2), y, scale, c); }
  noise(amp) { for (let i = 0; i < this.d.length; i += 4) { const n = Math.round((this.rnd() - 0.5) * amp * 2); for (let q = 0; q < 3; q++) this.d[i + q] = Math.max(0, Math.min(255, this.d[i + q] + n)); } }
}

const PALETTE = [[196, 54, 48], [47, 98, 160], [58, 132, 82], [214, 164, 40], [220, 120, 40], [110, 116, 124], [38, 140, 150], [130, 70, 150]];
const dark = (c, f) => c.map(v => Math.min(255, Math.round(v * f)));

function background(cv) {
  for (let y = 0; y < H; y++) { const g = 200 - Math.round(y * 0.1); for (let x = 0; x < W; x++) cv.px(x, y, [g - 12, g - 4, g + 6]); }
  // wall tiles
  for (let x = 0; x < W; x += 80) cv.rect(x, 0, 2, 300, [170, 176, 186]);
  for (let y = 60; y < 300; y += 60) cv.rect(0, y, W, 2, [170, 176, 186]);
  // bench top with grain
  for (let y = 330; y < H; y++) for (let x = 0; x < W; x++) { const grain = Math.sin((y * 0.9 + Math.sin(x * 0.02) * 6) * 0.9) * 8; cv.px(x, y, [Math.round(150 + grain), Math.round(104 + grain), Math.round(60 + grain)]); }
  cv.rect(0, 326, W, 6, [196, 150, 100]);
}

function labelBlock(cv, x, y, w, h, lines, scale, accent) {
  cv.rect(x, y, w, h, [244, 242, 232]); cv.rect(x, y, w, 8, accent);
  const lh = 8 * scale + 4, top = y + 12 + Math.max(0, Math.round((h - 16 - lines.length * lh) / 2));
  lines.forEach((l, i) => cv.centered(l, x + w / 2, top + i * lh, scale, [30, 30, 34]));
}

function fitScale(lines, w, max) { let s = max; while (s > 1 && Math.max(...lines.map(l => l.length * 6 * s - s)) > w - 8) s--; return s; }

const SCENES = {
  tin(cv, c, lines) {
    cv.ellipse(320, 345, 140, 22, [90, 60, 36], 0.45);
    cv.rect(200, 170, 240, 170, c); cv.ellipse(320, 340, 120, 20, c); cv.ellipse(320, 170, 120, 22, dark(c, 1.25)); cv.ellipse(320, 170, 100, 15, dark(c, 0.8));
    cv.rect(200, 170, 14, 170, dark(c, 0.8)); cv.rect(420, 170, 14, 170, dark(c, 0.75));
    labelBlock(cv, 222, 205, 196, 105, lines, fitScale(lines, 196, 3), dark(c, 0.7));
    cv.rect(250, 118, 140, 4, [60, 60, 60]); cv.rect(250, 118, 4, 52, [60, 60, 60]); cv.rect(386, 118, 4, 52, [60, 60, 60]);
  },
  bottle(cv, c, lines) {
    cv.ellipse(320, 345, 100, 18, [90, 60, 36], 0.45);
    cv.rrect(250, 190, 140, 150, 18, c); cv.rrect(298, 128, 44, 70, 8, c); cv.rrect(292, 104, 56, 30, 6, dark(c, 0.6));
    cv.rect(256, 200, 10, 130, dark(c, 1.25));
    labelBlock(cv, 262, 225, 116, 90, lines, fitScale(lines, 116, 3), dark(c, 0.7));
  },
  jerry(cv, c, lines) {
    cv.ellipse(320, 345, 150, 20, [90, 60, 36], 0.45);
    cv.rrect(190, 150, 260, 190, 14, c); cv.rect(220, 118, 70, 36, c); cv.rect(236, 132, 38, 22, [190, 200, 210]); cv.rect(380, 100, 40, 54, dark(c, 0.7)); cv.rect(392, 112, 16, 40, [190, 200, 210]);
    cv.rect(200, 160, 12, 170, dark(c, 1.2));
    labelBlock(cv, 232, 205, 176, 100, lines, fitScale(lines, 176, 3), dark(c, 0.7));
  },
  aerosol(cv, c, lines) {
    cv.ellipse(320, 345, 70, 14, [90, 60, 36], 0.45);
    cv.rect(268, 170, 104, 172, c); cv.ellipse(320, 170, 52, 30, dark(c, 1.15)); cv.rect(300, 114, 40, 36, [40, 40, 44]); cv.rect(340, 118, 26, 10, [40, 40, 44]);
    cv.rect(274, 180, 8, 150, dark(c, 1.3));
    labelBlock(cv, 276, 215, 88, 100, lines, fitScale(lines, 88, 2), dark(c, 0.7));
  },
  tub(cv, c, lines) {
    cv.ellipse(320, 345, 170, 24, [90, 60, 36], 0.45);
    cv.rect(170, 210, 300, 130, c); cv.ellipse(320, 338, 150, 20, c); cv.rrect(160, 188, 320, 34, 10, dark(c, 1.2)); cv.ellipse(320, 205, 120, 8, dark(c, 0.8));
    labelBlock(cv, 205, 235, 230, 88, lines, fitScale(lines, 230, 3), dark(c, 0.7));
  },
  shelf(cv, c, lines) {
    cv.rect(60, 330, 520, 12, [120, 84, 50]);
    const cans = [[110, 70, 130], [200, 80, 150], [300, 70, 170], [390, 90, 120], [490, 70, 140]];
    cans.forEach(([x, w, h], i) => { const k = PALETTE[(i * 3 + 1) % PALETTE.length]; cv.rect(x, 330 - h, w, h, k); cv.ellipse(x + w / 2, 330 - h, w / 2, 8, dark(k, 1.2)); cv.rect(x + 6, 330 - h + 20, w - 12, 30, [244, 242, 232]); });
    cv.centered(lines[0], 320, 230, 4, [20, 20, 24]); cv.centered(lines[1] || '', 320, 262, 4, [20, 20, 24]);
  },
  empty(cv, c, lines) {
    cv.rect(180, 250, 280, 78, [244, 242, 232]); cv.rect(180, 250, 280, 8, [58, 132, 82]);
    cv.centered(lines[0], 320, 280, 5, [30, 30, 34]); cv.centered(lines[1] || '', 320, 316 - 2, 2, [30, 30, 34]);
  },
};

/** spec: {kind, lines:[...], seed, color (index), tag (optional red tag text, e.g. EXPIRED)} -> {data: Uint8Array, width, height} */
export function renderPhoto(spec) {
  const cv = new Canvas(spec.seed * 7919 + 13);
  background(cv);
  (SCENES[spec.kind] || SCENES.tin)(cv, PALETTE[(spec.color ?? 0) % PALETTE.length], spec.lines);
  if (spec.tag) { cv.rect(470, 120, 150, 44, [210, 40, 40]); cv.centered(spec.tag, 545, 132, 3, [255, 255, 255]); }
  cv.noise(5);
  cv.rect(0, 0, 252, 24, [20, 20, 24]); cv.text('FICTIONAL DEMO PHOTO', 6, 5, 2, [255, 240, 120]);
  const q = jpeg.encode({ data: Buffer.from(cv.d), width: W, height: H }, 70);
  return { data: new Uint8Array(q.data), width: W, height: H };
}
