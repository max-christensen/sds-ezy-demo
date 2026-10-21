// SDSLib.photo: take or choose a photo, shrink it on the device (about 1600 px on the long side, JPEG 0.7) and hand back a Blob.
// Re-drawing on a canvas applies the EXIF rotation and strips every EXIF tag (including GPS). Needs audit-model.js for the maths.
(function () {
  'use strict';
  const L = (window.SDSLib = window.SDSLib || {});
  const M = () => L.auditModel;
  const FAIL = 'That photo could not be read. Try taking it again.';

  const realDeps = {
    now: () => Date.now(),
    createImageBitmap: (file, opts) => window.createImageBitmap(file, opts),
    makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    // Old browsers without createImageBitmap on a Blob: decode through an <img> (the browser applies EXIF rotation when drawing it).
    async decodeViaImg(file) {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return { width: img.naturalWidth, height: img.naturalHeight, source: img, close() {} };
      } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
    },
  };

  async function decode(file, d) {
    if (typeof d.createImageBitmap === 'function') {
      try { const b = await d.createImageBitmap(file, { imageOrientation: 'from-image' }); return { width: b.width, height: b.height, source: b, close: () => { try { b.close(); } catch (e) { /* ignore */ } } }; }
      catch (e) {
        try { const b = await d.createImageBitmap(file); return { width: b.width, height: b.height, source: b, close: () => { try { b.close(); } catch (e2) { /* ignore */ } } }; }
        catch (e2) { /* fall through */ }
      }
    }
    if (d.decodeViaImg) return d.decodeViaImg(file);
    throw new Error(FAIL);
  }

  // -> {blob, width, height, takenAt}. `deps` is for tests only.
  async function compress(file, deps) {
    const d = Object.assign({}, realDeps, deps || {});
    const model = M();
    if (!file) throw new Error(FAIL);
    let img;
    try { img = await decode(file, d); } catch (e) { throw new Error(FAIL); }
    try {
      if (!(img.width > 0 && img.height > 0)) throw new Error(FAIL);
      const size = model.scaleSize(img.width, img.height, model.MAX_SIDE);
      const canvas = d.makeCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(FAIL);
      ctx.fillStyle = '#fff'; ctx.fillRect && ctx.fillRect(0, 0, size.width, size.height); // a JPEG has no transparency
      ctx.drawImage(img.source, 0, 0, size.width, size.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', model.JPEG_QUALITY));
      if (!blob) throw new Error(FAIL);
      return { blob, width: size.width, height: size.height, takenAt: model.pickTakenAt(file.lastModified, d.now()) };
    } finally { img.close(); }
  }

  // Opens the camera on a phone (the gallery on a computer). Resolves the File, or null when the person cancels.
  function pick(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      if (opts.capture !== false) input.setAttribute('capture', 'environment');
      input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      input.setAttribute('aria-hidden', 'true'); input.tabIndex = -1;
      let done = false;
      const finish = (f) => { if (done) return; done = true; input.remove(); resolve(f); };
      input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
      input.addEventListener('cancel', () => finish(null));
      document.body.appendChild(input);
      input.click();
    });
  }

  // <img> for a photo already on the server (needs a signed-in session; the server checks every request).
  function thumb(photoId, alt) {
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async';
    img.alt = alt || 'Audit photo';
    img.src = L.auditClient ? L.auditClient.photoUrl(photoId) : '/api/audit-photos/' + encodeURIComponent(photoId);
    return img;
  }

  L.photo = { compress, pick, thumb, FAIL_MESSAGE: FAIL };
})();
