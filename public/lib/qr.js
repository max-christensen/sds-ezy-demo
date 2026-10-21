// QR code as an SVG string, from the vendored qrcode-generator (global `qrcode`, or passed in for tests).
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).qr = m;
})(typeof self !== "undefined" ? self : this, function () {
  // Returns an <svg> string. The code is drawn as ONE path so it prints crisply at any size.
  function qrSvg(qrcodeFactory, text, opts) {
    const o = opts || {};
    const margin = o.margin == null ? 4 : o.margin; // quiet zone in modules; 4 is the QR standard
    const qr = qrcodeFactory(0, o.ecc || "M");
    qr.addData(String(text), "Byte");
    qr.make();
    const n = qr.getModuleCount();
    const size = n + margin * 2;
    let d = "";
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (qr.isDark(r, c)) {
          let end = c;
          while (end + 1 < n && qr.isDark(r, end + 1)) end++;
          const w = end - c + 1;
          d += "M" + (c + margin) + " " + (r + margin) + "h" + w + "v1h-" + w + "z";
          c = end + 1;
        } else c++;
      }
    }
    const label = o.label ? ' role="img" aria-label="' + String(o.label).replace(/[&<>"]/g, "") + '"' : ' aria-hidden="true"';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size + '" shape-rendering="crispEdges"' + label +
      '><rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  return { qrSvg };
});
