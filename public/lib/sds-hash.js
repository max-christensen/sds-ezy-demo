// SHA-256 of a file (hex), computed in the browser so the Worker never has to read the PDF just to spot a duplicate.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).sdsHash = m;
})(typeof self !== "undefined" ? self : this, function () {
  function toHex(buf) {
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
  }
  // data: ArrayBuffer or Uint8Array
  async function sha256Hex(data) {
    const subtle = (typeof crypto !== "undefined" && crypto.subtle) || null;
    if (!subtle) throw new Error("This browser cannot check the file (it needs a secure https page).");
    const view = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return toHex(await subtle.digest("SHA-256", view));
  }
  // The body for POST /api/uploads/precheck.
  function precheckBody(hash, fileName, fileSize, text) {
    return { file_hash: hash, file_name: fileName, file_size: fileSize, text_head: String(text || "").slice(0, 4000) };
  }
  return { sha256Hex, toHex, precheckBody };
});
