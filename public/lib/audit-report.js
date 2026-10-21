// Audit report: the pure model (counts, ordering, captions, missing-photo handling) and the PDF builder (pdf-lib, in the browser).
// Input is the reply of GET /api/audits/:id: {audit, items, found, disposals, findings, photos}. Photos are fetched by the caller-supplied
// fetchPhoto(id) so the builder needs no network once it has the data. JPEG photos are embedded AS IS (no re-encode).
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).auditReport = m;
})(typeof self !== "undefined" ? self : this, function () {
  function PB() { return typeof module === "object" && module.exports ? require("./pdf-bundle.js") : self.SDSLib.pdfBundle; }
  const s = (v) => (v == null ? "" : String(v).trim());
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const RESULT_LABEL = { present: "Present", not_found: "Not found", changed: "Changed" };
  const OUTCOME_LABEL = {
    linked: "Linked to this place on the register",
    link_suggested: "Suggested to an admin: link it to this place",
    created: "Added to the register (needs an SDS)",
    recorded: "Recorded in the audit only",
  };
  const REASON_LABEL = { expired: "Expired", unlabelled: "Unlabelled", damaged: "Damaged", unknown: "Unknown contents", no_sds: "No SDS" };
  const DISPOSAL_STATUS = { to_dispose: "To be disposed of", disposed: "Disposed of" };
  const REVIEW_LABEL = { overdue: "Overdue", due_soon: "Due soon", ok: "In date", no_sds: "No SDS", unknown: "No issue date" };
  const FINDING_KIND = { not_found: "Not found: unlink from this place", changed: "Changed: update quantity or container", found_link: "Found: link to this place" };
  const FINDING_STATUS = { open: "Open", accepted: "Accepted", dismissed: "Dismissed" };

  // "20 Oct 2026" and "20 Oct 2026, 1:05 pm" in the viewer's time.
  function fmtDate(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return "";
    return d.getDate() + " " + MON[d.getMonth()] + " " + d.getFullYear();
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return "";
    const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
    return fmtDate(iso) + ", " + ((h % 12) || 12) + ":" + m + " " + (h < 12 ? "am" : "pm");
  }
  function fmtMb(bytes) { const n = Number(bytes) || 0; return n < 1048576 ? Math.max(0, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  const qty = (q, u) => (q == null || q === "" ? "" : (Math.round(Number(q) * 100) / 100) + " " + (s(u) || "L"));

  // Out-of-date first (the same order as the audit screen): overdue, due soon, no SDS, no assessment, the rest; then by name.
  function itemRank(i) {
    if (i.review_status === "overdue") return 0;
    if (i.review_status === "due_soon") return 1;
    if (i.review_status === "no_sds" || !i.has_sds) return 2;
    if (!i.has_assessment) return 3;
    return 4;
  }
  function orderItems(items) {
    return (items || []).slice().sort((a, b) => itemRank(a) - itemRank(b) || s(a.product_name).toLowerCase().localeCompare(s(b.product_name).toLowerCase()));
  }

  function changedText(i) {
    const bits = [];
    const q = qty(i.new_quantity, i.new_unit);
    if (q) bits.push("now " + q);
    if (s(i.new_container_note)) bits.push("container: " + s(i.new_container_note));
    return bits.join("; ");
  }
  function expectedText(i) {
    return [qty(i.expected_quantity, i.expected_unit), s(i.expected_container_note)].filter(Boolean).join(", ");
  }

  // Everything the screen and the PDF need, worked out once.
  function buildModel(data) {
    const a = data.audit || {};
    const items = orderItems(data.items);
    const found = (data.found || []).slice().sort((x, y) => s(x.found_at).localeCompare(s(y.found_at)));
    const disposals = (data.disposals || []).slice().sort((x, y) => s(x.flagged_at).localeCompare(s(y.flagged_at)));
    const findings = data.findings || [];
    const photos = data.photos || [];
    const count = (r) => items.filter((i) => i.result === r).length;
    const photoBytes = photos.reduce((n, p) => n + (Number(p.bytes) || 0), 0);
    const summary = {
      listed: items.length, present: count("present"), not_found: count("not_found"), changed: count("changed"),
      not_marked: items.filter((i) => !i.result).length, found: found.length, disposals: disposals.length, photos: photos.length, photo_bytes: photoBytes,
    };
    const finished = a.status === "finished";
    const placeBits = [s(a.place_name), a.place_type ? "(" + ({ workshop: "Workshop or depot", vehicle: "Vehicle", site: "Site" }[a.place_type] || a.place_type) + (a.place_registration ? ", " + s(a.place_registration) : "") + ")" : ""].filter(Boolean);

    const itemRows = items.map((i) => ({
      chemical_id: i.chemical_id, product_name: s(i.product_name), supplier: s(i.supplier),
      result: i.result || null, resultLabel: RESULT_LABEL[i.result] || "Not marked",
      note: s(i.note), changed: i.result === "changed" ? changedText(i) : "", expected: expectedText(i),
      review: REVIEW_LABEL[i.review_status] || (i.has_sds ? "" : "No SDS") + (i.review_due ? "" : ""), review_due: s(i.review_due),
      reviewText: (REVIEW_LABEL[i.review_status] || "") + (i.review_due && i.review_status && i.review_status !== "no_sds" ? " (due " + fmtDate(i.review_due) + ")" : ""),
      assessment: i.has_assessment ? "Assessment on file" : "No assessment on file", has_sds: !!i.has_sds, has_assessment: !!i.has_assessment,
      markedAt: i.marked_at ? fmtDateTime(i.marked_at) : "",
    }));
    const foundRows = found.map((f) => ({
      client_id: f.client_id, product_name: s(f.product_name), supplier: s(f.supplier), source: f.source === "ai" ? "Read from the label photo" : "Typed in",
      outcome: f.outcome, outcomeLabel: OUTCOME_LABEL[f.outcome] || s(f.outcome), note: s(f.note), foundAt: fmtDateTime(f.found_at),
    }));
    const disposalRows = disposals.map((d) => ({
      client_id: d.client_id, description: s(d.description), reasonLabel: REASON_LABEL[d.reason] || s(d.reason), note: s(d.note),
      status: d.status, statusLabel: DISPOSAL_STATUS[d.status] || s(d.status), flaggedBy: s(d.flagged_by_name), flaggedAt: fmtDateTime(d.flagged_at),
      closedBy: s(d.closed_by_name), closedAt: d.closed_at ? fmtDateTime(d.closed_at) : "", closeNote: s(d.close_note),
    }));
    const findingRows = findings.map((f) => ({ kind: f.kind, kindLabel: FINDING_KIND[f.kind] || s(f.kind), product_name: s(f.product_name), status: f.status, statusLabel: FINDING_STATUS[f.status] || s(f.status), resolvedBy: s(f.resolved_by_name), resolvedAt: f.resolved_at ? fmtDateTime(f.resolved_at) : "" }));

    return {
      audit: a, finished, statusText: finished ? "Finished" : "In progress, not finished",
      title: placeBits.join(" "), date: fmtDate(finished ? a.finished_at : a.started_at), startedText: fmtDateTime(a.started_at), finishedText: finished ? fmtDateTime(a.finished_at) : "Not finished yet",
      auditor: s(a.started_by_name), finishedBy: s(a.finished_by_name), notes: s(a.notes),
      summary, storageText: fmtMb(photoBytes), itemRows, foundRows, disposalRows, findingRows, photos: photoPlan({ items, found, disposals, photos }),
    };
  }

  // Photos in report order (chemicals, found items, disposals, closing photos, the whole place), each with its caption.
  const OWNER_ORDER = { item: 0, found: 1, disposal: 2, disposal_close: 3, audit: 4 };
  function photoPlan({ items, found, disposals, photos }) {
    const itemName = new Map(items.map((i) => [String(i.chemical_id), s(i.product_name)]));
    const foundName = new Map(found.map((f) => [s(f.client_id), s(f.product_name)]));
    const dispName = new Map(disposals.map((d) => [s(d.client_id), s(d.description)]));
    const itemPos = new Map(items.map((i, n) => [String(i.chemical_id), n]));
    const label = (p) => {
      switch (p.owner_type) {
        case "item": return "Chemical: " + (itemName.get(s(p.owner_key)) || "chemical #" + s(p.owner_key));
        case "found": return "Found item: " + (foundName.get(s(p.owner_key)) || "unknown");
        case "disposal": return "Flagged for disposal: " + (dispName.get(s(p.owner_key)) || "unknown");
        case "disposal_close": return "Disposal closed: " + (dispName.get(s(p.owner_key)) || "unknown");
        default: return "Whole place";
      }
    };
    return (photos || []).slice().sort((x, y) =>
      (OWNER_ORDER[x.owner_type] ?? 9) - (OWNER_ORDER[y.owner_type] ?? 9) ||
      (x.owner_type === "item" ? (itemPos.get(s(x.owner_key)) ?? 9999) - (itemPos.get(s(y.owner_key)) ?? 9999) : 0) ||
      s(x.taken_at).localeCompare(s(y.taken_at)) || (x.id || 0) - (y.id || 0)
    ).map((p) => ({ id: p.id, owner_type: p.owner_type, owner_key: p.owner_key, bytes: p.bytes, width: p.width, height: p.height, taken_at: p.taken_at, label: label(p), caption: label(p) + ". Taken " + (fmtDateTime(p.taken_at) || "time not recorded") }));
  }

  // The cover lines (also used by the screen).
  function summaryLines(m) {
    const x = m.summary;
    return [
      ["Chemicals listed", String(x.listed)], ["Present", String(x.present)], ["Not found", String(x.not_found)], ["Changed", String(x.changed)],
      ["Not marked", String(x.not_marked)], ["Found items", String(x.found)], ["Flagged for disposal", String(x.disposals)],
      ["Photos", x.photos + " (" + m.storageText + " stored)"],
    ];
  }

  // File name for a report: "Place 2026-10-20" (sanitised by the caller's zip helper where used).
  function reportFileBase(data, sanitise) {
    const a = data.audit || {};
    const d = s(a.finished_at || a.started_at).slice(0, 10);
    const clean = sanitise || ((x) => x.replace(/[\\/:*?"<>|]+/g, " ").trim());
    return clean([s(a.place_name) || "Audit", d].filter(Boolean).join(" ")) || "Audit report";
  }

  // Fetch photos up to `concurrency` at a time. fetchPhoto(id) -> Uint8Array | null. Returns Map id -> bytes (failed ones are absent).
  async function fetchPhotos(plan, fetchPhoto, o) {
    const out = new Map();
    const queue = plan.slice();
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        if (o && o.cancelled && o.cancelled()) throw new Error("cancelled");
        const p = queue.shift();
        let b = null;
        try { b = await fetchPhoto(p.id); } catch (e) { b = null; }
        if (b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) out.set(p.id, b);
        done++;
        if (o && o.onProgress) o.onProgress("Photo " + done + " of " + plan.length, done, plan.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  const wait = () => new Promise((r) => setTimeout(r, 0));

  // opts: {D, company:{company_name,...}, fetchPhoto, onProgress(label, done, total), cancelled, preparedBy}
  // Returns {bytes, pageCount, notes:{unavailable:[caption]}}.
  async function buildPdf(PDFLib, data, opts) {
    const o = opts || {};
    const D = o.D || { short: "", full: "", points: [] };
    const m = buildModel(data);
    const { Writer, stampFooters } = PB();
    const A4 = [595.28, 841.89], A4L = [841.89, 595.28];
    const progress = o.onProgress || (() => {});
    const notes = { unavailable: [] };

    // photos first (so nothing is half-built when the user cancels)
    let got = new Map();
    if (m.photos.length && o.fetchPhoto) got = await fetchPhotos(m.photos, o.fetchPhoto, { cancelled: o.cancelled, onProgress: (l, d, t) => progress(l, d, t) });
    if (o.cancelled && o.cancelled()) throw new Error("cancelled");

    const doc = await PDFLib.PDFDocument.create();
    doc.setTitle("Chemical audit report");
    doc.setProducer("SDS EZY");
    const fonts = { reg: await doc.embedFont(PDFLib.StandardFonts.Helvetica), bold: await doc.embedFont(PDFLib.StandardFonts.HelveticaBold) };
    const w = new Writer(PDFLib, doc, fonts);
    const generated = new Set();
    w.onNewPage = (pg) => generated.add(pg);
    const red = PDFLib.rgb(0.62, 0.15, 0.1);
    const co = o.company || {};

    // ---- cover
    w.newPage(A4);
    w.gap(30);
    w.para("SDS EZY", { size: 12, bold: true, color: w.soft });
    w.para("Chemical audit report", { size: 24, bold: true, after: 6 });
    w.para(m.title, { size: 15, bold: true, after: 6 });
    if (!m.finished) w.para("IN PROGRESS, NOT FINISHED. This report shows the audit as it stands now.", { size: 11, bold: true, color: red, after: 8 });
    [s(co.company_name), s(co.company_address), [s(co.company_phone), s(co.company_email)].filter(Boolean).join("  |  ")].filter(Boolean).forEach((l, i) => w.para(l, { size: i === 0 ? 12 : 10, bold: i === 0, after: 1 }));
    w.gap(8);
    w.kv("Place", m.title);
    w.kv("Date", m.date);
    w.kv("Audited by", m.auditor);
    w.kv("Started", m.startedText);
    w.kv("Finished", m.finishedText);
    if (m.finished && m.finishedBy && m.finishedBy !== m.auditor) w.kv("Finished by", m.finishedBy);
    w.kv("Status", m.statusText);
    if (m.notes) w.kv("Notes", m.notes);
    if (o.preparedBy) w.kv("Report prepared by", o.preparedBy);
    w.gap(8);
    w.heading("Summary", 13);
    summaryLines(m).forEach(([k, v]) => w.kv(k, v));
    w.gap(10);
    w.heading("Important", 12);
    (D.points && D.points.length ? D.points : [D.full]).forEach((pt) => w.para(pt, { size: 9.5, indent: 8, after: 4 }));

    // ---- chemicals
    w.newPage(A4L);
    w.heading("Chemicals on the register for this place (" + m.itemRows.length + ")", 14);
    w.para("Ordered with out-of-date first. The review and assessment columns show how things stood when the audit started.", { size: 8.5, color: w.soft });
    w.table(
      ["Product", "Supplier", "Result", "Note / what changed", "Expected", "SDS review", "Assessment", "Marked"],
      m.itemRows.map((r) => [r.product_name, r.supplier, r.resultLabel, [r.changed, r.note].filter(Boolean).join(". "), r.expected, r.reviewText, r.assessment, r.markedAt]),
      [17, 10, 8, 20, 11, 11, 11, 12], null, {
        size: 7.5, empty: "No chemicals were listed for this place.",
        cellStyle: (ri, ci, text) => (ci === 2 && text === "Not found" ? { fill: PDFLib.rgb(0.99, 0.85, 0.83), bold: true } : ci === 2 && text === "Changed" ? { fill: PDFLib.rgb(0.98, 0.95, 0.87), bold: true } : ci === 2 && text === "Not marked" ? { fill: PDFLib.rgb(0.93, 0.93, 0.9) } : null),
      }
    );

    // ---- found items
    w.heading("Found items (" + m.foundRows.length + ")", 14);
    w.table(["Product", "Supplier", "How it was identified", "What happened", "Note", "Found"], m.foundRows.map((f) => [f.product_name, f.supplier, f.source, f.outcomeLabel, f.note, f.foundAt]), [20, 12, 16, 22, 18, 12], null, { size: 7.5, empty: "Nothing was found that is not on the register." });

    // ---- disposals
    w.heading("Flagged for disposal (" + m.disposalRows.length + ")", 14);
    w.table(["Item", "Reason", "Note", "Status", "Flagged by", "Flagged", "Closed by / when", "Closing note"],
      m.disposalRows.map((d) => [d.description, d.reasonLabel, d.note, d.statusLabel, d.flaggedBy, d.flaggedAt, [d.closedBy, d.closedAt].filter(Boolean).join(", "), d.closeNote]),
      [16, 9, 14, 10, 10, 12, 15, 14], null, { size: 7.5, empty: "Nothing was flagged for disposal." });

    if (m.findingRows.length) {
      w.heading("Findings for an admin (" + m.findingRows.length + ")", 14);
      w.table(["What", "Product", "Status", "Resolved by / when"], m.findingRows.map((f) => [f.kindLabel, f.product_name, f.statusLabel, [f.resolvedBy, f.resolvedAt].filter(Boolean).join(", ")]), [34, 28, 10, 28], null, { size: 7.5 });
    }

    // ---- photos: two to a page, JPEG embedded as is, caption with the capture time
    if (m.photos.length) {
      const slotH = (A4[1] - 2 * w.margin - w.footerSpace) / 2;
      for (let i = 0; i < m.photos.length; i += 2) {
        if (o.cancelled && o.cancelled()) throw new Error("cancelled");
        progress("Placing photos (" + Math.min(i + 2, m.photos.length) + " of " + m.photos.length + ")", Math.min(i + 2, m.photos.length), m.photos.length);
        await wait();
        const pg = w.newPage(A4);
        if (i === 0) { w.para("Photos (" + m.photos.length + ")", { size: 14, bold: true, after: 2 }); }
        const top0 = w.y;
        for (let k = 0; k < 2 && i + k < m.photos.length; k++) {
          const ph = m.photos[i + k];
          const bytes = got.get(ph.id);
          const boxTop = k === 0 ? top0 : (A4[1] - w.margin) - slotH;
          let img = null;
          if (bytes) { try { img = await doc.embedJpg(bytes); } catch (e) { img = null; } }
          const capH = 34;
          const maxW = w.width, maxH = (k === 0 ? top0 - (A4[1] - w.margin - slotH) : slotH) - capH - 14;
          if (img) {
            const sc = Math.min(maxW / img.width, maxH / img.height, 1.5);
            const dw = img.width * sc, dh = img.height * sc;
            pg.drawImage(img, { x: w.margin, y: boxTop - dh, width: dw, height: dh });
            drawCaption(pg, fonts, ph.caption, w.margin, boxTop - dh - 12, w.width, w);
          } else {
            notes.unavailable.push(ph.caption);
            pg.drawRectangle({ x: w.margin, y: boxTop - 90, width: w.width, height: 90, borderColor: PDFLib.rgb(0.7, 0.7, 0.7), borderWidth: 1 });
            pg.drawText("Photo not available", { x: w.margin + 10, y: boxTop - 36, size: 12, font: fonts.bold, color: red });
            drawCaption(pg, fonts, ph.caption, w.margin + 10, boxTop - 54, w.width - 20, w);
          }
        }
      }
      if (notes.unavailable.length) {
        w.newPage(A4);
        w.heading("Photos that could not be included (" + notes.unavailable.length + ")", 13);
        w.para("These photos exist on the record but could not be fetched when this report was built.", { size: 9.5, color: w.soft });
        notes.unavailable.forEach((c) => w.para("- " + c, { size: 9, indent: 6, after: 2 }));
      }
    }

    const total = stampFooters(PDFLib, doc, fonts, generated, D, "SDS EZY audit report");
    const bytes = await doc.save();
    return { bytes, pageCount: total, notes, model: m };
  }

  function drawCaption(page, fonts, text, x, y, width, w) {
    const { wrapText, sanitise } = PB();
    const lines = wrapText(sanitise(text), fonts.reg, 9, width).slice(0, 3);
    lines.forEach((ln, i) => page.drawText(ln, { x, y: y - i * 11, size: 9, font: fonts.reg, color: w.ink }));
  }

  return {
    buildModel, buildPdf, fetchPhotos, summaryLines, photoPlan, orderItems, itemRank, reportFileBase, fmtDate, fmtDateTime, fmtMb,
    RESULT_LABEL, OUTCOME_LABEL, REASON_LABEL, DISPOSAL_STATUS, FINDING_KIND,
  };
});
