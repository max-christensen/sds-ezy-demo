// Browser-only helpers shared by the take-away and job pack screens: fetching bytes, and turning the GIF pictograms into PNG
// (pdf-lib cannot embed GIF). Kept here once so both screens do it the same way.
(function () {
  window.SDSLib = window.SDSLib || {};

  // Decode a GIF and hand back a lossless PNG of the same pixel size (no resampling).
  async function gifToPng(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/gif' }));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function fetchBytes(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }
  // The SDS PDF for an SDS id, or null if there is none or it cannot be fetched.
  async function fetchSdsPdf(sdsId) {
    try { return await fetchBytes('/api/sds/' + Number(sdsId) + '/file'); } catch (e) { return null; }
  }
  window.SDSLib.pdfAssets = { gifToPng, fetchBytes, fetchSdsPdf };
})();
