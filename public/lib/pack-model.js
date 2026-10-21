// Job pack model: pure helpers (no DOM). Turns GET /api/pack?ids= plus the job details into what the PDF and the zip need,
// works out what is missing, the cover lines, file names and the zip README. Nothing here talks to the server.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).packModel = m;
})(typeof self !== "undefined" ? self : this, function () {
  function libs() {
    if (typeof module === "object" && module.exports) return { M: require("./export-model.js"), Z: require("./zip-build.js") };
    return { M: self.SDSLib.exportModel, Z: self.SDSLib.zipBuild };
  }
  const s = (v) => (v == null ? "" : String(v).trim());
  const PLACE_TYPE_TEXT = { workshop: "Workshop or depot", vehicle: "Vehicle", site: "Site" };

  function placeText(p) {
    if (!p) return "";
    return s(p.name) + (p.place_type ? " (" + (PLACE_TYPE_TEXT[p.place_type] || p.place_type) + (p.registration ? ", " + s(p.registration) : "") + ")" : "");
  }

  // One entry of the pack reply ({chemical, sds, assessment, places}) as the shape the PDF writer uses.
  function toBundleChem(entry, today) {
    const { M } = libs();
    const c = entry.chemical || {};
    const sds = entry.sds || null;
    const a = entry.assessment || null;
    const row = Object.assign({}, sds ? { un_number: sds.un_number, dg_class: sds.dg_class, subsidiary_class: sds.subsidiary_class, packing_group: sds.packing_group, hazchem_code: sds.hazchem_code, proper_shipping_name: sds.proper_shipping_name, h_statements: sds.h_statements } : {}, c);
    row.id = Number(c.id);
    row.sds_id = sds && sds.id != null ? Number(sds.id) : (c.sds_id != null ? Number(c.sds_id) : null);
    row.sds_has_file = sds ? !!sds.has_file : null;
    row.sds_file_name = sds ? sds.file_name : null;
    row.sds_issue_date = (sds && sds.issue_date) || c.sds_issue_date || null;
    row.review_due = (sds && sds.review_due) || c.review_due || null;
    row.status = M.reviewStatus(Object.assign({}, row, { review_status: c.review_status }), today);
    row.pictogramList = s(c.pictograms).split(",").map((x) => x.trim().toUpperCase()).filter((x) => /^GHS0[1-9]$/.test(x));
    row.classification = M.parseClassification(c.classification);
    row.decision_overridden = !!(c.decision_overridden || c.decision_override);
    row.pictograms_overridden = !!(c.pictograms_overridden || c.pictograms_override);
    row.flags = Array.isArray(c.classification_flags) ? c.classification_flags.map(String) : [];
    row.assessment = a ? Object.assign({}, a, { grouped: M.groupControls(a) }) : null;
    row.links = (entry.places || []).map((p) => ({ quantity: p.quantity, unit: p.unit, container_note: p.container_note, place: { name: p.name, place_type: p.place_type, registration: p.registration, archived: p.archived } }));
    return row;
  }

  // What is missing for a chemical: [] when it has an SDS PDF and an assessment.
  function missingParts(c) {
    const out = [];
    if (!c.sds_id) out.push("No SDS on file");
    else if (c.sds_has_file === false) out.push("No SDS PDF on file");
    if (!c.assessment) out.push("No assessment on file");
    return out;
  }

  // job: {client, jobRef, date, place (place object or null), preparedBy, company:{company_name,...}}
  function coverModel(chemicals, job) {
    const co = job.company || {};
    const company = [s(co.company_name), s(co.company_address), [s(co.company_phone), s(co.company_email)].filter(Boolean).join("  |  "), s(co.company_reg) ? "Reg: " + s(co.company_reg) : ""].filter(Boolean);
    const facts = [
      ["Client or site", s(job.client) || "Not entered"],
      ["Job reference", s(job.jobRef) || "Not entered"],
      ["Date", s(job.date)],
      ["Place", job.place ? placeText(job.place) : "Not chosen (chemicals picked from the register)"],
      ["Prepared by", s(job.preparedBy)],
    ];
    const items = chemicals.map((c) => ({ name: s(c.product_name), supplier: s(c.supplier), notes: missingParts(c) }));
    return { company, facts, items, missingCount: items.filter((i) => i.notes.length).length };
  }

  // A friendly file name, no path characters: "Job pack - Smith Plumbing - J-104 - 2026-10-20"
  function fileBase(job) {
    const { Z } = libs();
    const bits = ["Job pack", s(job.client), s(job.jobRef), s(job.date)].filter(Boolean).map((b) => Z.sanitiseFileName(b, ""));
    return Z.sanitiseFileName(bits.filter(Boolean).join(" - "), "Job pack").slice(0, 100).replace(/[\s.-]+$/, "");
  }

  // Zip names for the SDS PDFs, one per SDS (shared sheets named by the products that use them, in this pack).
  function zipEntries(chemicals) {
    const { Z } = libs();
    const bySds = new Map();
    for (const c of chemicals) {
      if (!c.sds_id || c.sds_has_file === false) continue;
      if (!bySds.has(c.sds_id)) bySds.set(c.sds_id, { sds_id: c.sds_id, file_name: c.sds_file_name || "", product_names: [] });
      bySds.get(c.sds_id).product_names.push(s(c.product_name));
    }
    const used = new Set();
    return [...bySds.values()].map((e) => ({ sds_id: e.sds_id, name: Z.uniqueName(Z.sdsBaseName(e), ".pdf", used), products: e.product_names }));
  }

  function zipReadme(cover, job, D, extraMissing, saved) {
    const L = ["SDS EZY job pack: safety data sheets"];
    cover.company.forEach((l) => L.push(l));
    L.push("");
    cover.facts.forEach(([k, v]) => L.push(k + ": " + v));
    L.push("Safety data sheet PDFs in this zip: " + saved);
    L.push("", "Chemicals in this pack (" + cover.items.length + "):");
    cover.items.forEach((i) => L.push("  - " + i.name + (i.supplier ? " (" + i.supplier + ")" : "") + (i.notes.length ? "  [" + i.notes.join("; ") + "]" : "")));
    if (extraMissing && extraMissing.length) { L.push("", "The SDS PDF could not be fetched for:"); extraMissing.forEach((m) => L.push("  - " + m)); }
    L.push("", "IMPORTANT", D.full, "", "Each file is named after the product it covers. A sheet shared by several products carries all their names.");
    return L.join("\r\n") + "\r\n";
  }

  // The ids from "?ids=1,2,x" (only whole positive numbers, no repeats, at most 100).
  function parseIds(v) {
    const seen = new Set(), out = [];
    String(v || "").split(",").forEach((x) => { const n = Number(x.trim()); if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); } });
    return out.slice(0, 100);
  }

  return { placeText, toBundleChem, missingParts, coverModel, fileBase, zipEntries, zipReadme, parseIds, PLACE_TYPE_TEXT };
});
