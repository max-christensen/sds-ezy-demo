import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const model = require("../public/lib/audit-model.js");

// photo.js is a browser script (window.SDSLib.photo). Run it in a context with just enough of a window.
const win = { SDSLib: { auditModel: model } };
vm.runInNewContext(fs.readFileSync(new URL("../public/lib/photo.js", import.meta.url), "utf8"), { window: win, document: {}, URL, Image: class {} });
const photo = win.SDSLib.photo;

function fakes({ w, h, now, failBitmap, nullBlob } = {}) {
  const log = { bitmapArgs: [], drawn: null, toBlob: null, canvas: null, closed: false };
  return {
    log,
    deps: {
      now: () => now,
      createImageBitmap: async (file, opts) => {
        log.bitmapArgs.push(opts);
        if (failBitmap) throw new Error("decode failed");
        return { width: w, height: h, close() { log.closed = true; } };
      },
      makeCanvas: (cw, ch) => {
        log.canvas = { cw, ch };
        return {
          getContext: () => ({ fillRect() {}, drawImage: (src, x, y, dw, dh) => { log.drawn = { x, y, dw, dh }; } }),
          toBlob: (cb, type, q) => { log.toBlob = { type, q }; cb(nullBlob ? null : new Blob(["jpegdata"], { type: type })); },
        };
      },
      decodeViaImg: undefined,
    },
  };
}

test("compress: 4000x3000 becomes 1600x1200 JPEG at quality 0.7, orientation from the image", async () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const f = fakes({ w: 4000, h: 3000, now });
  const r = await photo.compress({ lastModified: now - 60000, size: 5e6 }, f.deps);
  assert.equal(JSON.stringify(f.log.bitmapArgs[0]), JSON.stringify({ imageOrientation: "from-image" }));
  assert.deepEqual(f.log.canvas, { cw: 1600, ch: 1200 });
  assert.deepEqual(f.log.toBlob, { type: "image/jpeg", q: 0.7 });
  assert.deepEqual([r.width, r.height], [1600, 1200]);
  assert.equal(r.blob.type, "image/jpeg");
  assert.equal(r.takenAt, new Date(now - 60000).toISOString());
  assert.equal(f.log.closed, true, "bitmap released");
  assert.deepEqual(f.log.drawn, { x: 0, y: 0, dw: 1600, dh: 1200 });
});

test("compress never upscales a small photo", async () => {
  const f = fakes({ w: 640, h: 480, now: 1e12 });
  const r = await photo.compress({ lastModified: 1 }, f.deps);
  assert.deepEqual([r.width, r.height], [640, 480]);
});

test("compress: an old or future lastModified falls back to now", async () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const f1 = fakes({ w: 100, h: 100, now });
  assert.equal((await photo.compress({ lastModified: now - 30 * 86400e3 }, f1.deps)).takenAt, new Date(now).toISOString());
  const f2 = fakes({ w: 100, h: 100, now });
  assert.equal((await photo.compress({ lastModified: now + 5000 }, f2.deps)).takenAt, new Date(now).toISOString());
});

test("compress: a failed decode gives a plain message", async () => {
  const f = fakes({ failBitmap: true, now: 1e12 });
  await assert.rejects(photo.compress({ lastModified: 1 }, f.deps), (e) => e.message === "That photo could not be read. Try taking it again.");
  const g = fakes({ w: 10, h: 10, nullBlob: true, now: 1e12 });
  await assert.rejects(photo.compress({}, g.deps), /could not be read/);
  await assert.rejects(photo.compress(null, g.deps), /could not be read/);
});

test("the size and quality constants are exactly 1600 and 0.7", () => {
  assert.equal(model.MAX_SIDE, 1600);
  assert.equal(model.JPEG_QUALITY, 0.7);
});
