// Zip of all SDS PDFs, built in the browser with fflate. PDFs are already compressed so they are STORED (no
// re-deflate): each file's bytes are handed to the zip and the caller drops its copy straight away, so memory
// holds the finished zip once, not the PDFs twice.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).zipBuild = m;
})(typeof self !== "undefined" ? self : this, function () {
  // File-name safe: no path characters, no control characters, no trailing dots/spaces.
  function sanitiseFileName(s, fallback) {
    let t = String(s == null ? "" : s)
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+|[\s.]+$/g, "");
    if (!t) t = fallback || "SDS";
    return t;
  }

  // A file name for an SDS that may be shared by several products: "Product A + Product B (+3 more)", truncated.
  function sdsBaseName(item, max) {
    const limit = max || 80;
    const names = (item.product_names || []).map((n) => sanitiseFileName(n, "")).filter(Boolean);
    let base;
    if (!names.length) base = sanitiseFileName(String(item.file_name || "").replace(/\.pdf$/i, ""), "SDS " + item.sds_id);
    else {
      base = names[0];
      for (let i = 1; i < names.length; i++) {
        const next = base + " + " + names[i];
        if (next.length > limit - 12) { base += " (+" + (names.length - i) + " more)"; break; }
        base = next;
      }
    }
    if (base.length > limit) base = base.slice(0, limit).replace(/[\s.+(]+$/, "");
    return base || "SDS " + item.sds_id;
  }

  // Make a name unique within `used` (a Set of lower-case names), keeping the extension.
  function uniqueName(base, ext, used) {
    let name = base + ext, n = 2;
    while (used.has(name.toLowerCase())) name = base + " (" + n++ + ")" + ext;
    used.add(name.toLowerCase());
    return name;
  }

  class ZipBuilder {
    // fflate: the fflate module (global `fflate` in the browser)
    constructor(fflate) {
      this.f = fflate;
      this.chunks = [];
      this.error = null;
      this.used = new Set();
      this.zip = new fflate.Zip((err, chunk) => {
        if (err) { this.error = err; return; }
        this.chunks.push(chunk);
      });
    }
    addPdf(baseName, bytes) {
      const name = uniqueName(baseName, ".pdf", this.used);
      const file = new this.f.ZipPassThrough(name);
      this.zip.add(file);
      file.push(bytes, true);
      return name;
    }
    addText(name, text) {
      const file = new this.f.ZipDeflate(name, { level: 6 });
      this.zip.add(file);
      file.push(new TextEncoder().encode(text), true);
      this.used.add(name.toLowerCase());
      return name;
    }
    finish() {
      this.zip.end();
      if (this.error) throw this.error;
      const parts = this.chunks;
      this.chunks = [];
      return new Blob(parts, { type: "application/zip" });
    }
  }

  function readme(disclaimerFull, companyName, generated, count, missing, source, extra) {
    const lines = ["SDS EZY - take-away safety data sheets"];
    if (companyName) lines.push("Business: " + companyName);
    lines.push(
      "Prepared: " + generated,
      "Files: " + count + " safety data sheet PDF" + (count === 1 ? "" : "s"),
      "",
      "IMPORTANT",
      disclaimerFull,
      "",
      source || "",
      "",
      "Each file is named after the product it covers. A sheet shared by several products carries all their names."
    );
    if (missing && missing.length) {
      lines.push("", "No PDF could be fetched for:");
      missing.forEach((m) => lines.push("  - " + m));
    }
    (extra || []).forEach((l) => lines.push(l));
    return lines.join("\r\n") + "\r\n";
  }

  return { sanitiseFileName, sdsBaseName, uniqueName, ZipBuilder, readme };
});
