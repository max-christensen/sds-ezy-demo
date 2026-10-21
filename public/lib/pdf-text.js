// Text extraction from a PDF with pdf.js, in the browser. The Worker does NO PDF parsing.
// The pdf.js module is passed in (the view loads it with import('/vendor/pdf.min.mjs')) so this file has no DOM
// and can be tested in node.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).pdfText = m;
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_CHARS = 150000; // the Worker caps the text at this size too

  // Join pdf.js text items into lines. Items carry hasEOL when a line ends.
  function joinItems(items) {
    let out = "";
    for (const it of items || []) {
      if (typeof it.str !== "string") continue;
      out += it.str;
      if (it.hasEOL) out += "\n";
    }
    return out;
  }

  function tidy(text) {
    return String(text || "")
      .replace(/\u0000/g, "")
      .replace(/[ \t ]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t ]{2,}/g, " ");
  }

  // "Scanned" = a PDF with pages but (almost) no real text, so there is nothing to read.
  function looksScanned(text, pageCount) {
    const letters = (String(text || "").match(/[A-Za-z]/g) || []).length;
    const pages = Math.max(1, pageCount || 1);
    return letters < 40 || letters / pages < 25;
  }

  // pdfjs: the pdf.js module. data: Uint8Array (pdf.js takes ownership of it, so pass a copy).
  // opts.onProgress(done, total), opts.maxChars. Resolves {text, pages, pagesRead, truncated, scanned}.
  async function extractText(pdfjs, data, opts) {
    const o = opts || {};
    const maxChars = o.maxChars || MAX_CHARS;
    const task = pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    try {
      const total = doc.numPages;
      let text = "";
      let pagesRead = 0;
      let truncated = false;
      for (let p = 1; p <= total; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        text += joinItems(content.items) + "\n\n";
        if (page.cleanup) page.cleanup();
        pagesRead = p;
        if (o.onProgress) o.onProgress(p, total);
        if (text.length >= maxChars) { truncated = p < total; break; }
      }
      text = tidy(text);
      if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
      return { text, pages: total, pagesRead, truncated, scanned: looksScanned(text, pagesRead) };
    } finally {
      try { await doc.destroy(); } catch (e) { /* ignore */ }
    }
  }

  return { extractText, joinItems, tidy, looksScanned, MAX_CHARS };
});
