// The take-away PDF: ONE print-ready file built in the browser with pdf-lib.
//   cover + disclaimer -> register -> manifest -> for each chemical: its assessment, then its SDS pages.
// A safety data sheet shared by several products is included ONCE, right after the first assessment that uses it;
// later assessments say which page it starts on.
// Text is limited to what the standard PDF fonts can draw (WinAnsi), so anything else is swapped or dropped.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).pdfBundle = m;
})(typeof self !== "undefined" ? self : this, function () {
  function libs() {
    if (typeof module === "object" && module.exports) return { M: require("./export-model.js"), ML: require("./manifest-layout.js") };
    return { M: self.SDSLib.exportModel, ML: self.SDSLib.manifestLayout };
  }

  const SWAPS = {
    "‘": "'", "’": "'", "‚": ",", "“": '"', "”": '"', "–": "-", "—": "-", "−": "-",
    "…": "...", "•": "-", " ": " ", " ": " ", " ": " ", "→": "->", "≤": "<=", "≥": ">=",
    "₂": "2", "₃": "3", "₀": "0", "₁": "1", "²": "2", "³": "3", "℃": "C", "✓": "x", "☐": "[ ]",
  };
  // Keep printable ASCII and Latin-1 letters; swap common punctuation; drop everything else.
  function sanitise(text) {
    let out = "";
    for (const ch of String(text == null ? "" : text)) {
      if (SWAPS[ch] != null) { out += SWAPS[ch]; continue; }
      const c = ch.codePointAt(0);
      if (ch === "\n") out += "\n";
      else if (ch === "\t") out += " ";
      else if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff)) out += ch;
      else if (c === 0x20ac) out += "EUR";
    }
    return out;
  }

  // Break text into lines no wider than maxWidth (font.widthOfTextAtSize). Honours \n and splits over-long words.
  function wrapText(text, font, size, maxWidth) {
    const lines = [];
    for (const para of sanitise(text).split("\n")) {
      if (!para.trim()) { lines.push(""); continue; }
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + " " + word : word;
        if (font.widthOfTextAtSize(test, size) <= maxWidth) { line = test; continue; }
        if (line) lines.push(line);
        if (font.widthOfTextAtSize(word, size) <= maxWidth) { line = word; continue; }
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) { lines.push(chunk); chunk = ch; } else chunk += ch;
        }
        line = chunk;
      }
      lines.push(line);
    }
    return lines;
  }

  const A4 = [595.28, 841.89];
  const A4L = [841.89, 595.28];

  class Writer {
    constructor(PDFLib, doc, fonts, onNewPage) {
      this.P = PDFLib; this.doc = doc; this.f = fonts; this.onNewPage = onNewPage || null;
      this.margin = 40; this.page = null; this.y = 0; this.size = A4; this.footerSpace = 34;
      this.ink = PDFLib.rgb(0.12, 0.16, 0.14); this.soft = PDFLib.rgb(0.35, 0.37, 0.34); this.line = PDFLib.rgb(0.75, 0.74, 0.7);
      this.tint = PDFLib.rgb(0.91, 0.94, 0.93);
    }
    get width() { return this.size[0] - this.margin * 2; }
    newPage(size) {
      if (size) this.size = size;
      this.page = this.doc.addPage(this.size);
      this.y = this.size[1] - this.margin;
      if (this.onNewPage) this.onNewPage(this.page);
      return this.page;
    }
    ensure(h) { if (!this.page || this.y - h < this.margin + this.footerSpace) { this.newPage(); return true; } return false; }
    gap(h) { this.y -= h; }
    draw(str, x, y, size, bold, color) {
      const t = sanitise(str).replace(/\n/g, " ");
      if (!t) return;
      this.page.drawText(t, { x, y, size, font: bold ? this.f.bold : this.f.reg, color: color || this.ink });
    }
    // Wrapped paragraph; returns nothing. opts: size, bold, color, indent, after
    para(text, opts) {
      const o = opts || {};
      const size = o.size || 10, lh = size * 1.3;
      const font = o.bold ? this.f.bold : this.f.reg;
      const lines = wrapText(text, font, size, this.width - (o.indent || 0));
      for (const ln of lines) {
        this.ensure(lh);
        this.y -= lh;
        this.draw(ln, this.margin + (o.indent || 0), this.y + size * 0.25, size, o.bold, o.color);
      }
      this.y -= o.after == null ? 3 : o.after;
    }
    heading(text, size) {
      const sz = size || 14;
      this.ensure(sz * 2.2);
      this.gap(sz * 0.5);
      this.para(text, { size: sz, bold: true, after: 4 });
    }
    // label: value on one block (value wraps under itself)
    kv(label, value) {
      const v = String(value == null ? "" : value).trim();
      if (!v) return;
      const size = 9.5, lh = size * 1.3, labelW = 118;
      const lines = wrapText(v, this.f.reg, size, this.width - labelW);
      this.ensure(lh * Math.min(lines.length, 2));
      this.y -= lh;
      this.draw(label, this.margin, this.y + 2.4, size, true, this.soft);
      lines.forEach((ln, i) => {
        if (i > 0) { this.ensure(lh); this.y -= lh; }
        this.draw(ln, this.margin + labelW, this.y + 2.4, size, false);
      });
      this.y -= 2;
    }
    rule() { this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: this.margin + this.width, y: this.y }, thickness: 0.6, color: this.line }); this.y -= 6; }

    // A framed box of wrapped text lines (used for the OVER banner). opts: fill, border, color, size
    box(title, lines, opts) {
      const o = opts || {};
      const size = o.size || 10, lh = size * 1.35, pad = 8;
      const wrapped = [];
      lines.forEach((t) => wrapText(t, this.f.bold, size, this.width - pad * 2).forEach((l, i) => wrapped.push({ t: l, indent: i ? 10 : 0 })));
      const h = pad * 2 + (title ? lh * 1.4 : 0) + wrapped.length * lh;
      this.ensure(Math.min(h, this.size[1] - this.margin * 2 - this.footerSpace));
      const top = this.y;
      this.page.drawRectangle({ x: this.margin, y: top - h, width: this.width, height: h, color: o.fill, borderColor: o.border, borderWidth: 2 });
      let y = top - pad - size;
      if (title) { this.page.drawText(sanitise(title), { x: this.margin + pad, y, size: size + 2, font: this.f.bold, color: o.color }); y -= lh * 1.4; }
      wrapped.forEach((l) => { this.page.drawText(l.t, { x: this.margin + pad + l.indent, y, size, font: this.f.bold, color: o.color }); y -= lh; });
      this.y = top - h - 8;
    }
    // A row of embedded pictogram images (never larger than 25 mm = about 71 pt).
    pictos(images, sizePt) {
      if (!images.length) return;
      const s = Math.min(sizePt || 50, 70);
      this.ensure(s + 6);
      images.forEach((img, i) => this.page.drawImage(img, { x: this.margin + i * (s + 8), y: this.y - s, width: s, height: s }));
      this.y -= s + 8;
    }

    // Table with a repeating header row. widths: relative. aligns: "l" | "r" per column.
    // opts: size, empty, cellStyle(ri, ci, text) -> {fill, bold, color},
    //       cellImages(ri, ci) -> [PDFImage] drawn in the cell instead of its text (null/empty = the text is used as the fallback),
    //       imgSize (pt, default 18), minTail (default 3: a continuation page never holds fewer rows than this; rows are balanced across the last two pages).
    // Rows flow onto continuation pages with the header repeated.
    table(headLabels, bodyRows, widthsRel, aligns, opts) {
      const o = opts || {};
      const size = o.size || 8, lh = size * 1.25, padX = 3, padY = 3;
      const imgSize = o.imgSize || 18, imgGap = 2;
      const minTail = o.minTail == null ? 3 : o.minTail;
      const total = widthsRel.reduce((a, b) => a + b, 0);
      const cols = widthsRel.map((w) => (w / total) * this.width);
      const xs = []; let x = this.margin; cols.forEach((w) => { xs.push(x); x += w; });
      const bottom = this.margin + this.footerSpace;

      // Lay every row out first: text lines or images per cell, and the row height.
      const layout = (row, isHead, ri) => {
        const font = isHead ? this.f.bold : this.f.reg;
        const cells = row.map((t, i) => {
          const imgs = !isHead && o.cellImages ? o.cellImages(ri, i) : null;
          if (imgs && imgs.length) {
            const per = Math.max(1, Math.floor((cols[i] - padX * 2 + imgGap) / (imgSize + imgGap)));
            return { imgs, per, h: Math.ceil(imgs.length / per) * (imgSize + imgGap) - imgGap };
          }
          const lines = wrapText(t, font, size, cols[i] - padX * 2).slice(0, 8);
          return { lines, h: lines.length * lh };
        });
        return { cells, font, isHead, ri, row, h: Math.max(...cells.map((c) => c.h), lh) + padY * 2 };
      };
      const head = layout(headLabels, true, -1);
      const rows = bodyRows.map((r, i) => layout(r, false, i));

      // Page plan: fill greedily, then balance so the last page is never a lone row or two.
      this.ensure(60);
      const firstAvail = this.y - bottom - head.h;
      const nextAvail = this.size[1] - this.margin * 2 - this.footerSpace - head.h;
      const chunks = [[]];
      let used = 0, avail = firstAvail;
      rows.forEach((r) => {
        if (used + r.h > avail && chunks[chunks.length - 1].length) { chunks.push([]); used = 0; avail = nextAvail; }
        chunks[chunks.length - 1].push(r); used += r.h;
      });
      while (chunks.length > 1) {
        const last = chunks[chunks.length - 1], prev = chunks[chunks.length - 2];
        if (last.length >= minTail || prev.length <= 1) break;
        last.unshift(prev.pop());
      }

      const drawRow = (r) => {
        const top = this.y, h = r.h;
        if (r.isHead) this.page.drawRectangle({ x: this.margin, y: top - h, width: this.width, height: h, color: this.tint });
        r.cells.forEach((c, i) => {
          const st = !r.isHead && o.cellStyle ? o.cellStyle(r.ri, i, r.row[i]) : null;
          if (st && st.fill) this.page.drawRectangle({ x: xs[i], y: top - h, width: cols[i], height: h, color: st.fill });
          if (c.imgs) {
            c.imgs.forEach((img, k) => {
              const col = k % c.per, line = Math.floor(k / c.per);
              this.page.drawImage(img, { x: xs[i] + padX + col * (imgSize + imgGap), y: top - padY - imgSize - line * (imgSize + imgGap), width: imgSize, height: imgSize });
            });
            return;
          }
          const f = st && st.bold ? this.f.bold : r.font;
          c.lines.forEach((ln, j) => {
            const tw = f.widthOfTextAtSize(ln, size);
            const tx = aligns && aligns[i] === "r" ? xs[i] + cols[i] - padX - tw : xs[i] + padX;
            this.page.drawText(ln, { x: tx, y: top - padY - size - j * lh + 1.5, size, font: f, color: (st && st.color) || this.ink });
          });
        });
        this.page.drawLine({ start: { x: this.margin, y: top - h }, end: { x: this.margin + this.width, y: top - h }, thickness: 0.4, color: this.line });
        this.y = top - h;
      };

      drawRow(head);
      if (!rows.length && o.empty) this.para(o.empty, { size: 9, color: this.soft, indent: 3 });
      chunks.forEach((chunk, ci) => {
        if (ci > 0) { this.newPage(); drawRow(head); }
        chunk.forEach(drawRow);
      });
      this.gap(8);
      return chunks.map((c) => c.length);
    }
  }

  const wait = () => new Promise((r) => setTimeout(r, 0));

  // The manifest, one block per counting place (all 43 items, OVER red, NEAR amber, things to check, rows), then the places that do not count.
  function manifestSection(PDFLib, w, ML, model, o, L, prepared) {
    const red = PDFLib.rgb(0.70, 0.15, 0.12), pink = PDFLib.rgb(0.99, 0.85, 0.83), amber = PDFLib.rgb(0.98, 0.95, 0.87), gold = PDFLib.rgb(0.96, 0.77, 0.33);
    const sec = o.sections || { places: [], not_counted: [] };
    w.newPage(A4L);
    w.heading(L.title, 15);
    w.para(L.subtitle + ". Worked out for each place on its own.", { size: 9.5, color: w.soft });
    ML.headerFacts(model.company, prepared, L).forEach((f) => w.kv(f.label, f.value));
    w.gap(6);
    const sm = ML.summaryLines({ places: sec.places });
    if (sm.over.length) w.box("OVER THE PLACARD OR MANIFEST QUANTITY", sm.over.map((b) => b.text), { fill: pink, border: red, color: PDFLib.rgb(0.45, 0.06, 0.04), size: 10 });
    if (sm.near.length) w.box("NEAR THE QUANTITY (80% OR MORE)", sm.near.map((b) => b.text), { fill: amber, border: gold, color: PDFLib.rgb(0.3, 0.2, 0), size: 9.5 });
    if (!sm.over.length && !sm.near.length && sec.places.length) w.para("No place is over or near its placard or manifest quantity.", { size: 10, bold: true });
    if (!sec.places.length) w.para("No place counts towards the placard and manifest totals yet.", { size: 10 });
    sec.places.forEach((p, idx) => {
      const im = ML.itemsModel(p.totals);
      if (idx > 0 || sm.over.length || sm.near.length) w.newPage(A4L);
      w.heading("Place: " + ML.placeTitle(p.place), 13);
      const itm = ML.itemsMatrix(im, L);
      w.table(itm.head.map((h) => (h === "Site total" ? "Total here" : h)), itm.body, L.items.map((c) => c.width), L.items.map((c) => (c.num ? "r" : "l")), {
        size: 7.5, empty: "No quantities recorded.",
        cellStyle: (ri, ci, text) => {
          const key = L.items[ci].key;
          if (key !== "pstatus" && key !== "mstatus") return null;
          if (/^OVER/.test(text)) return { fill: red, bold: true, color: PDFLib.rgb(1, 1, 1) };
          if (/^NEAR/.test(text)) return { fill: gold, bold: true };
          if (/^NOT APPLIED/.test(text)) return { fill: amber };
          return null;
        },
      });
      const groups = ML.groupIssues(p.totals);
      w.heading("Things to check", 11);
      if (!groups.length) w.para("Nothing needs checking.", { size: 9 });
      groups.forEach((g) => {
        w.para(g.title + " (" + g.entries.length + ")", { size: 9, bold: true, after: 1 });
        if (g.help) w.para(g.help, { size: 8, color: w.soft, after: 1 });
        g.entries.forEach((e) => w.para("- " + e.message, { size: 8, indent: 8, after: 1 }));
        w.gap(2);
      });
      w.heading("Hazardous chemicals kept here", 11);
      const rm = ML.rowsMatrix(p.rows, L);
      w.table(rm.head, rm.body, L.rows.map((c) => c.width), L.rows.map((c) => (c.num ? "r" : "l")), { size: 7.5, empty: L.emptyText });
    });
    if (sec.not_counted.length) {
      w.newPage(A4L);
      w.heading("Places that are not counted", 13);
      sec.not_counted.forEach((n) => {
        w.para(ML.placeTitle(n.place), { size: 10, bold: true, after: 1 });
        w.para(n.note || "", { size: 9.5, indent: 8, after: 1 });
        if (n.caveat) w.para(n.caveat, { size: 8.5, indent: 8, color: w.soft });
        w.gap(4);
      });
    }
    w.gap(6);
    w.para(o.ref ? o.ref.ADG_COLUMN_NOTE : "", { size: 8.5, color: w.soft });
    w.heading("How this is worked out", 11);
    if (o.ref) {
      w.para(o.ref.FLAM_LIQ_CAT4_RULE, { size: 8.5 });
      Object.keys(o.ref.PLACARD_NOTES).forEach((n) => w.para("Note " + n + ": " + o.ref.PLACARD_NOTES[n], { size: 8.5, after: 1 }));
      w.para("Vehicles: " + o.ref.VEHICLE_TRANSPORT_NOTE + " " + o.ref.VEHICLE_TRANSPORT_CAVEAT, { size: 8.5 });
    }
    ML.DECISIONS.forEach((d) => w.para("- " + d, { size: 8.5, indent: 6, after: 1 }));
    w.gap(4);
    w.para(ML.SOURCE_LINE, { size: 8, color: w.soft });
  }

  // data: export-model.normalise() result. opts:
  async function buildBundle(PDFLib, model, opts) {
    const { M, ML } = libs();
    const o = Object.assign({}, opts || {});
    const D = o.D;
    const L = o.layout || ML.LAYOUT;
    const doc = await PDFLib.PDFDocument.create();
    doc.setTitle("SDS EZY take-away register");
    doc.setProducer("SDS EZY");
    const fonts = { reg: await doc.embedFont(PDFLib.StandardFonts.Helvetica), bold: await doc.embedFont(PDFLib.StandardFonts.HelveticaBold) };
    o.pictos = o.pictoDeps && o.ref ? await embedPictograms(PDFLib, doc, o.ref, o.pictoDeps) : null;
    const w = new Writer(PDFLib, doc, fonts);
    const progress = o.onProgress || (() => {});
    const notes = { missing: [], skipped: [] };
    const company = model.company.company_name;
    const prepared = M.fmtDate(model.generated_at);

    // Pages that belong to the document's own text (not copied SDS pages) are tracked so footers differ.
    const generated = new Set();
    w.onNewPage = (p) => generated.add(p);

    // ---- cover + disclaimer
    w.newPage(A4);
    w.gap(60);
    w.para("SDS EZY", { size: 12, bold: true, color: w.soft });
    w.para("Chemical register, hazardous chemicals manifest and risk assessments", { size: 22, bold: true, after: 10 });
    if (company) w.para(company, { size: 14 });
    ML.headerFacts(model.company, prepared, L).filter((f) => f.label !== "Business").forEach((f) => w.kv(f.label, f.value));
    w.gap(14);
    w.heading("Important", 13);
    (D.points || [D.full]).forEach((p) => w.para(p, { size: 10.5, indent: 8, after: 6 }));
    w.gap(10);
    const haz = model.chemicals.filter((c) => c.decision === "hazardous").length;
    w.heading("In this file", 12);
    w.para(model.chemicals.length + " chemicals (" + haz + " hazardous). The register comes first, then the hazardous chemicals manifest, then each chemical's risk assessment followed by its safety data sheet (SDS). " +
      "An SDS used by more than one product is included once, after the first assessment that uses it.", { size: 10 });

    // ---- register (landscape)
    w.newPage(A4L);
    w.heading("Chemical register", 15);
    w.table(
      ["Product", "Supplier", "Decision", "Risk level", "Pictograms (GHS)", "SDS issued", "Review due", "Where kept"],
      model.chemicals.map((c) => [c.product_name, c.supplier, (M.DECISION_LABEL[c.decision] || "Not decided") + (c.decision_overridden ? " (admin override)" : ""), M.RISK_LABEL[c.risk_level] || "", c.pictogramList.join(", "), M.fmtDate(c.sds_issue_date), M.fmtDate(c.review_due), M.locationText(c)].map((v) => (v == null ? "" : String(v)))),
      [17, 12, 10, 12, 16, 8, 8, 20], null, { empty: "The register is empty.", cellImages: pictoCells(model.chemicals, 4, o.pictos) }
    );

    // ---- manifest, per place (landscape)
    manifestSection(PDFLib, w, ML, model, o, L, prepared);

    // ---- audit history (one line per audit the export returned)
    auditHistorySection(w, M, model, A4L);

    // ---- assessments, each followed by its SDS
    const sdsFirst = M.planSds(model.chemicals);
    const sdsStart = new Map(); // sds_id -> first page number of the included SDS
    const list = model.chemicals;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (o.cancelled && o.cancelled()) throw new Error("cancelled");
      progress("Adding " + (c.product_name || "chemical"), i + 1, list.length);
      await wait();
      w.newPage(A4);
      assessmentPage(w, M, c, sdsStart, sdsFirst, o);
      if (c.sds_id && sdsFirst.get(c.sds_id) === c.id && o.fetchSds) {
        let bytes = null;
        try { bytes = await o.fetchSds(c.sds_id); } catch (e) { bytes = null; }
        if (bytes) {
          try {
            const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
            const pages = await doc.copyPages(src, src.getPageIndices());
            sdsStart.set(c.sds_id, doc.getPageCount() + 1);
            // note on the assessment page where its SDS starts
            pages.forEach((p) => doc.addPage(p));
            c._sdsPages = pages.length;
          } catch (e) {
            notes.skipped.push(c.product_name + " (the PDF could not be read)");
          }
        } else notes.missing.push(c.product_name);
      }
    }

    // ---- footers + page numbers on every page
    const total = stampFooters(PDFLib, doc, fonts, generated, D, "SDS EZY take-away copy of the supplier's SDS");

    const bytes = await doc.save();
    return { bytes, pageCount: total, notes };
  }

  // One line per audit (place, date, who, counts, photos). A user's export has only their own audits; none = a short note.
  function auditHistorySection(w, M, model, size) {
    w.newPage(size);
    w.heading("Audit history", 15);
    const list = (model.audits || []).slice().sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    if (!list.length) { w.para("No audits have been recorded, or none are visible to you.", { size: 10, color: w.soft }); return; }
    const rowsOut = list.map((a) => {
      const x = M.auditSummary(model, a);
      const date = M.fmtDate(String(a.finished_at || a.started_at || "").slice(0, 10));
      return [(a.place_name || "") + (a.place_registration ? " (" + a.place_registration + ")" : ""), date, a.started_by_name || "", a.status === "finished" ? "Finished" : "In progress", String(x.listed), String(x.present), String(x.not_found), String(x.changed), String(x.not_marked), String(x.found), String(x.disposals), String(x.photos)];
    });
    w.table(["Place", "Date", "Audited by", "Status", "Listed", "Present", "Not found", "Changed", "Not marked", "Found", "Disposal", "Photos"], rowsOut, [20, 10, 14, 10, 5, 6, 6, 6, 6, 5, 6, 5], [null, null, null, null, "r", "r", "r", "r", "r", "r", "r", "r"], { size: 8 });
  }

  // For a register table: the official pictogram images for a row's codes (only when EVERY code has an image; otherwise the text codes stay as the fallback).
  function pictoCells(list, col, pictos) {
    return (ri, ci) => {
      if (ci !== col || !pictos || !list[ri]) return null;
      const codes = list[ri].pictogramList || [];
      if (!codes.length) return null;
      const imgs = codes.map((c) => pictos.get(c));
      return imgs.every(Boolean) ? imgs : null;
    };
  }

  // Page numbers on every page; the disclaimer line (wrapped, never cut) on every GENERATED page; a small credit line on copied SDS pages.
  function stampFooters(PDFLib, doc, fonts, generated, D, sdsLabel) {
    const total = doc.getPageCount();
    const f = fonts.reg, col = PDFLib.rgb(0.35, 0.37, 0.34);
    doc.getPages().forEach((p, idx) => {
      const { width } = p.getSize();
      if (p.getRotation().angle !== 0) return;
      const label = "Page " + (idx + 1) + " of " + total;
      const lw = f.widthOfTextAtSize(label, 7.5);
      if (generated.has(p)) {
        const lines = wrapText(D.short, f, 6.8, width - 80 - lw - 14).slice(0, 2);
        lines.forEach((ln, i) => p.drawText(ln, { x: 40, y: 22 - i * 8.5, size: 6.8, font: f, color: col }));
        p.drawText(label, { x: width - 40 - lw, y: 18, size: 7.5, font: f, color: col });
      } else {
        p.drawText(label, { x: width - 20 - lw, y: 6, size: 7, font: f, color: col });
        p.drawText(sdsLabel, { x: 20, y: 6, size: 7, font: f, color: col });
      }
    });
    return total;
  }

  // A job pack: cover, register, then each chemical's assessment followed by its SDS pages (an SDS shared by several products once).
  // A chemical with no SDS or no assessment is never dropped: the cover names it and a placeholder page stands where the part would be.
  //   pack: {cover:{company:[lines], facts:[[label,value]], items:[{name, supplier, notes:[...]}]}, chemicals:[bundle-shaped chemical]}
  //   opts: {D, ref, fetchSds(sdsId), pictoDeps, onProgress, cancelled}
  async function buildPackPdf(PDFLib, pack, opts) {
    const { M, ML } = libs();
    const o = Object.assign({}, opts || {});
    const D = o.D;
    const doc = await PDFLib.PDFDocument.create();
    doc.setTitle("SDS EZY job pack");
    doc.setProducer("SDS EZY");
    const fonts = { reg: await doc.embedFont(PDFLib.StandardFonts.Helvetica), bold: await doc.embedFont(PDFLib.StandardFonts.HelveticaBold) };
    o.pictos = o.pictoDeps && o.ref ? await embedPictograms(PDFLib, doc, o.ref, o.pictoDeps) : null;
    const w = new Writer(PDFLib, doc, fonts);
    const generated = new Set();
    w.onNewPage = (pg) => generated.add(pg);
    const progress = o.onProgress || (() => {});
    const notes = { missing: [], skipped: [] };
    const cv = pack.cover;
    const list = pack.chemicals;

    w.newPage(A4);
    w.gap(40);
    w.para("SDS EZY", { size: 12, bold: true, color: w.soft });
    w.para("Job pack: safety data sheets and risk assessments", { size: 22, bold: true, after: 10 });
    (cv.company || []).forEach((l, i) => w.para(l, { size: i === 0 ? 14 : 10, bold: i === 0, after: 1 }));
    w.gap(8);
    (cv.facts || []).forEach(([k, v]) => w.kv(k, v));
    w.gap(8);
    w.heading("Chemicals in this pack (" + (cv.items || []).length + ")", 12);
    (cv.items || []).forEach((it) => {
      w.para(it.name + (it.supplier ? " (" + it.supplier + ")" : ""), { size: 10, bold: true, after: 0 });
      (it.notes || []).forEach((n) => w.para(n, { size: 9.5, indent: 12, color: PDFLib.rgb(0.62, 0.15, 0.1), after: 0 }));
      w.gap(2);
    });
    w.gap(6);
    w.heading("Important", 12);
    (D.points || [D.full]).forEach((pt) => w.para(pt, { size: 9.5, indent: 8, after: 4 }));

    w.newPage(A4L);
    w.heading("Register for this job", 15);
    w.table(
      ["Product", "Supplier", "Decision", "Risk level", "Pictograms (GHS)", "SDS issued", "Review", "SDS / assessment"],
      list.map((c) => [c.product_name, c.supplier, (M.DECISION_LABEL[c.decision] || "Not decided") + (c.decision_overridden ? " (admin override)" : ""), M.RISK_LABEL[(c.assessment && c.assessment.risk_level) || c.risk_level] || "", c.pictogramList.join(", "),
        M.fmtDate(c.sds_issue_date), (M.STATUS_LABEL[c.status] || "") + (c.review_due ? " " + M.fmtDate(c.review_due) : ""),
        [c.sds_id ? "SDS on file" : "No SDS on file", c.assessment ? "assessment on file" : "No assessment on file"].join(", ")].map((v) => (v == null ? "" : String(v)))),
      [16, 11, 10, 13, 16, 8, 11, 15], null, { empty: "No chemicals.", cellImages: pictoCells(list, 4, o.pictos) }
    );

    const sdsFirst = M.planSds(list);
    const sdsStart = new Map();
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (o.cancelled && o.cancelled()) throw new Error("cancelled");
      progress("Adding " + (c.product_name || "chemical"), i + 1, list.length);
      await wait();
      w.newPage(A4);
      assessmentPage(w, M, c, sdsStart, sdsFirst, o);
      let placeholder = null;
      if (!c.sds_id) placeholder = "No safety data sheet is on file for this chemical. Ask the supplier for the current SDS.";
      else if (sdsFirst.get(c.sds_id) === c.id) {
        let bytes = null;
        if (c.sds_has_file !== false && o.fetchSds) { try { bytes = await o.fetchSds(c.sds_id); } catch (e) { bytes = null; } }
        if (bytes) {
          try {
            const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
            const pages = await doc.copyPages(src, src.getPageIndices());
            sdsStart.set(c.sds_id, doc.getPageCount() + 1);
            pages.forEach((pg) => doc.addPage(pg));
          } catch (e) { notes.skipped.push(c.product_name); placeholder = "The safety data sheet PDF could not be read, so it is not in this pack. Get the current SDS from the supplier."; }
        } else { notes.missing.push(c.product_name); placeholder = c.sds_has_file === false ? "A safety data sheet record exists but no PDF file is attached, so it is not in this pack." : "The safety data sheet PDF could not be fetched, so it is not in this pack."; }
      }
      if (placeholder) {
        w.newPage(A4);
        w.heading(c.product_name || "Chemical", 16);
        w.para("Safety data sheet", { size: 10, color: w.soft, after: 8 });
        w.para(placeholder, { size: 12, bold: true });
      }
    }
    const total = stampFooters(PDFLib, doc, fonts, generated, D, "SDS EZY job pack: copy of the supplier's SDS");
    const bytes = await doc.save();
    return { bytes, pageCount: total, notes };
  }

  function assessmentPage(w, M, c, sdsStart, sdsFirst, o) {
    const a = c.assessment;
    w.heading(c.product_name || "Chemical", 16);
    w.para("Hazard risk assessment", { size: 10, color: w.soft, after: 6 });
    w.kv("Supplier", c.supplier);
    w.kv("Decision", (M.DECISION_LABEL[c.decision] || "Not decided") + (c.decision_overridden ? " (overridden by an admin)" : "") + (c.decision_note ? " - " + c.decision_note : ""));
    w.kv("Risk level", M.RISK_LABEL[(a && a.risk_level) || c.risk_level] || "");
    w.kv("Signal word", c.signal_word);
    w.kv("GHS classification", M.classificationText(c.classification, o.ref));
    if (c.flags && c.flags.length) w.kv("Check the classification", c.flags.join(" "));
    w.kv("Hazard pictograms", M.pictogramText(c.pictogramList, o.ref) + (c.pictograms_overridden ? " (overridden by an admin)" : ""));
    if (o.pictos) w.pictos(c.pictogramList.map((code) => o.pictos.get(code)).filter(Boolean), 50);
    w.kv("Where kept", M.locationText(c));
    w.kv("SDS issued", [c.sds_issue_date ? M.fmtDate(c.sds_issue_date) : (c.sds_id ? "Date not recorded" : ""), c.review_due ? "review due " + M.fmtDate(c.review_due) : ""].filter(Boolean).join(", "));
    w.kv("Dangerous goods (ADG, for illustration only)", [c.dg_class ? "Class " + c.dg_class + (c.subsidiary_class ? " (" + c.subsidiary_class + ")" : "") : "", c.un_number ? "UN " + String(c.un_number).replace(/^UN\s*/i, "") : "", c.packing_group ? "PG " + c.packing_group : "", c.hazchem_code ? "Hazchem " + c.hazchem_code : ""].filter(Boolean).join(", "));
    w.kv("Proper shipping name", c.proper_shipping_name);
    w.kv("Hazard statements", c.h_statements);
    w.rule();
    if (!a) {
      w.para("No assessment has been prepared for this chemical yet.", { size: 10, color: w.soft });
    } else {
      w.kv("Assessed", M.fmtDate(a.assessed_date) + (a.assessed_by ? " by " + a.assessed_by : ""));
      w.kv("Physical form", a.form);
      w.kv("How it is used", a.use_description || c.use_description);
      w.kv("Ways it can get in", [a.route_inhalation ? "Breathing in" : "", a.route_ingestion ? "Swallowing" : "", a.route_absorption ? "Through the skin" : ""].filter(Boolean).join(", "));
      M.KINDS.forEach((k) => { if (a.grouped[k].length) w.kv(M.KIND_LABEL[k], a.grouped[k].join("; ")); });
      w.kv("Control notes", a.controls_notes);
      w.kv("PPE notes", a.ppe_notes);
      w.kv("If there is a fire", a.fire_response);
      w.kv("If there is a spill", a.spill_response);
      w.kv("Atmospheric monitoring", M.yesNo(a.monitoring_needed) + (a.monitoring_note ? ": " + a.monitoring_note : ""));
      w.kv("Health surveillance", M.yesNo(a.surveillance_needed) + (a.surveillance_note ? ": " + a.surveillance_note : ""));
      const flags = M.flaggedFields(a);
      if (flags.length) w.kv("Check these", flags.join(", ") + " (not found in the SDS text)");
    }
    w.rule();
    if (!c.sds_id) w.para("No safety data sheet is on file for this chemical.", { size: 9.5, color: w.soft });
    else if (sdsFirst.get(c.sds_id) === c.id) w.para("The supplier's safety data sheet follows this page.", { size: 9.5, color: w.soft });
    else {
      const first = sdsStart.get(c.sds_id);
      w.para(first ? "The safety data sheet for this product is included once, from page " + first + " (after the assessment for the first product that uses it)." :
        "The safety data sheet for this product is shared with another product and is included with that product's assessment.", { size: 9.5, color: w.soft });
    }
  }

  // Embed the official pictograms. pdf-lib cannot embed GIF, so a GIF goes through deps.toPng (the browser decodes it with
  // createImageBitmap + canvas and re-encodes losslessly at the same pixel size); the JPEG is embedded as is.
  //   deps.fetchBytes(url) -> Uint8Array | null     deps.toPng(bytes, mime) -> Promise<Uint8Array>
  async function embedPictograms(PDFLib, doc, ref, deps, codes) {
    const out = new Map();
    for (const p of ref.PICTOGRAMS) {
      if (codes && !codes.includes(p.code)) continue;
      try {
        const bytes = await deps.fetchBytes(p.file);
        if (!bytes) continue;
        const isJpg = /\.jpe?g$/i.test(p.file);
        out.set(p.code, isJpg ? await doc.embedJpg(bytes) : await doc.embedPng(await deps.toPng(bytes, "image/gif")));
      } catch (e) { /* the page still shows the code and name as text */ }
    }
    return out;
  }

  return { buildBundle, buildPackPdf, stampFooters, assessmentPage, embedPictograms, sanitise, wrapText, Writer };
});
