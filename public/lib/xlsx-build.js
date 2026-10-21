// Builds the take-away spreadsheet's sheet definitions (for write-excel-file). Pure data in, plain objects out.
// Every sheet starts with the business name, the disclaimer line, the Safe Work Australia source line and a blank row.
// opts: { ref (ghs-ref.mjs module), sections ({places:[{place,totals,rows}], not_counted:[{place,note,caveat}]} from manifest-layout.sectionsFromExport), layout }
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).xlsxBuild = m;
})(typeof self !== "undefined" ? self : this, function () {
  function libs() {
    if (typeof module === "object" && module.exports) return { M: require("./export-model.js"), ML: require("./manifest-layout.js") };
    return { M: self.SDSLib.exportModel, ML: self.SDSLib.manifestLayout };
  }

  const bold = (v) => ({ value: v == null ? "" : String(v), fontWeight: "bold" });
  const str = (v) => (v == null || v === "" ? null : { value: String(v), type: String });
  const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : { value: Number(v), type: Number });
  const head = (labels) => labels.map((l) => ({ value: l, fontWeight: "bold", backgroundColor: "#E7EFEE", wrap: true }));
  const widths = (list) => list.map((w) => ({ width: w }));
  const OVER_FILL = "#F4B6B0";
  const NEAR_FILL = "#FBE3A1";
  const status = (s) => (s === "OVER" ? { value: "OVER", type: String, fontWeight: "bold", backgroundColor: OVER_FILL, textColor: "#8C1A12" } : s === "NEAR" ? { value: "NEAR", type: String, fontWeight: "bold", backgroundColor: NEAR_FILL, textColor: "#5C3D00" } : str(s));

  function top(model, title, D, ML) {
    const name = model.company.company_name;
    return [
      [bold(title + (name ? " - " + name : ""))],
      [{ value: D.short, type: String }],
      [{ value: ML.SOURCE_LINE, type: String }],
      [{ value: "Prepared " + model.generated_at.slice(0, 10), type: String }],
      [],
    ];
  }

  const REGISTER_HEAD = ["Product", "Supplier", "Decision", "Decision overridden by an admin", "Risk level", "GHS classification", "Classification flags (check)", "Pictograms (GHS codes)", "Signal word", "ADG class (illustration only)", "SDS issue date", "Review due", "Review status", "Where kept (quantity)", "Use"];
  const HAZ_HEAD = REGISTER_HEAD.slice(0, 14).concat(["UN number", "Subsidiary risk", "Packing group", "Hazchem", "Proper shipping name", "Hazard statements", "Use"]);
  const REGISTER_W = [30, 24, 14, 16, 26, 44, 40, 34, 11, 14, 14, 14, 18, 40, 36];
  const HAZ_W = [30, 24, 14, 16, 26, 44, 40, 34, 11, 14, 14, 14, 18, 40, 11, 11, 9, 9, 28, 50, 36];

  function chemRow(M, ref, c, extended) {
    const base = [
      str(c.product_name), str(c.supplier), str(M.DECISION_LABEL[c.decision] || "Not decided"), str(c.decision_overridden ? "Yes" : ""),
      str(M.RISK_LABEL[c.risk_level] || ""), str(M.classificationText(c.classification, ref)), str((c.flags || []).join(" ")),
      str(M.pictogramText(c.pictogramList, ref) + (c.pictograms_overridden ? " (overridden)" : "")),
      str(c.signal_word), str(c.dg_class), str(M.fmtDate(c.sds_issue_date)), str(M.fmtDate(c.review_due)), str(M.STATUS_LABEL[c.status] || ""),
      str(M.locationText(c)),
    ];
    if (!extended) return base.concat([str(c.use_description)]);
    return base.concat([
      str(c.un_number ? "UN " + String(c.un_number).replace(/^UN\s*/i, "") : ""), str(c.subsidiary_class), str(c.packing_group),
      str(c.hazchem_code), str(c.proper_shipping_name), str(c.h_statements), str(c.use_description),
    ]);
  }

  function registerSheet(model, D, o) {
    const { M, ML } = libs();
    const data = top(model, "Chemical register", D, ML);
    data.push(head(REGISTER_HEAD));
    model.chemicals.forEach((c) => data.push(chemRow(M, o.ref, c, false)));
    return { sheet: "Register", data, columns: widths(REGISTER_W) };
  }

  function hazardousSheet(model, D, o) {
    const { M, ML } = libs();
    const data = top(model, "Hazardous chemicals", D, ML);
    data.push(head(HAZ_HEAD));
    model.chemicals.filter((c) => c.decision === "hazardous").forEach((c) => data.push(chemRow(M, o.ref, c, true)));
    return { sheet: "Hazardous", data, columns: widths(HAZ_W) };
  }

  // Hazardous chemicals per counting place (one line each, the place named in the first column).
  function manifestSheet(model, D, o) {
    const { ML } = libs();
    const L = o.layout || ML.LAYOUT;
    const sec = o.sections;
    const data = [[bold(L.title + (model.company.company_name ? " - " + model.company.company_name : ""))], [{ value: D.short, type: String }], [{ value: ML.SOURCE_LINE, type: String }], []];
    ML.headerFacts(model.company, model.generated_at.slice(0, 10), L).forEach((f) => data.push([bold(f.label), str(f.value)]));
    data.push([]);
    data.push(head(["Place"].concat(L.rows.map((c) => c.label))));
    let n = 0;
    sec.places.forEach((p) => p.rows.forEach((r) => { n++; data.push([str(ML.placeTitle(p.place))].concat(L.rows.map((c) => (c.num ? num(c.raw ? c.raw(r) : c.get(r)) : str(c.get(r)))))); }));
    if (!n) data.push([str(L.emptyText)]);
    data.push([]);
    data.push([{ value: o.ref ? o.ref.ADG_COLUMN_NOTE : "", type: String }]);
    return { sheet: "Manifest", data, columns: widths([34].concat(L.rows.map((c) => Math.max(8, c.width * 1.6)))) };
  }

  // Placard and manifest quantities: a block per counting place, ALL 43 items in each, OVER and NEAR marked; places that do not count listed with the note.
  const ITEMS_HEAD = ["Item", "Group", "Description", "Unit", "Placard quantity", "Manifest quantity", "Total here", "Placard status", "Manifest status", "ADG class (illustration only)", "Products counted"];
  function itemsSheet(model, D, o) {
    const { ML } = libs();
    const sec = o.sections;
    const data = top(model, "Placard and manifest quantities by item, per place", D, ML);
    const summary = ML.summaryLines({ places: sec.places });
    summary.over.forEach((b) => data.push([{ value: b.text, type: String, fontWeight: "bold", backgroundColor: OVER_FILL, textColor: "#8C1A12" }]));
    summary.near.forEach((b) => data.push([{ value: b.text, type: String, fontWeight: "bold", backgroundColor: NEAR_FILL, textColor: "#5C3D00" }]));
    if (summary.over.length || summary.near.length) data.push([]);
    sec.places.forEach((p) => {
      const im = ML.itemsModel(p.totals);
      data.push([bold("PLACE: " + ML.placeTitle(p.place))]);
      data.push(head(ITEMS_HEAD));
      im.forEach((m) => data.push([
        num(m.item), str(m.def.group), str(m.isMix ? "Any mix of items " + m.def.mixOf.join(", ") : m.def.desc), str(m.unit), num(m.placard), num(m.manifest),
        num(m.total), status(m.pstatus), status(m.mstatus), str(m.adg),
        str([m.productsText, m.pnote ? "Placard: " + m.pnote : "", m.mnote ? "Manifest: " + m.mnote : ""].filter(Boolean).join(". ")),
      ]));
      data.push([]);
    });
    if (!sec.places.length) { data.push([str("No place counts towards the placard and manifest totals yet.")]); data.push([]); }
    if (sec.not_counted.length) {
      data.push([bold("Places that are not counted")]);
      sec.not_counted.forEach((n) => data.push([str(ML.placeTitle(n.place)), str(n.note), str(n.caveat)]));
      data.push([]);
    }
    data.push([{ value: o.ref ? o.ref.ADG_COLUMN_NOTE : "", type: String }]);
    data.push([{ value: "Quantities are not converted between litres and kilograms. Where a mixing item is shown as NOT APPLIED, one of its items is already over on its own. NEAR means 80% or more of the quantity but not over it (a reading aid, not part of the table).", type: String }]);
    return { sheet: "Placard and manifest", data, columns: widths([34, 34, 44, 9, 12, 12, 12, 14, 14, 18, 70]) };
  }

  function issuesSheet(model, D, o) {
    const { ML } = libs();
    const data = top(model, "Things to check", D, ML);
    data.push(head(["Place", "What", "Product and message", "Why it matters"]));
    let n = 0;
    o.sections.places.forEach((p) => ML.groupIssues(p.totals).forEach((g) => g.entries.forEach((e) => { n++; data.push([str(ML.placeTitle(p.place)), str(g.title), str(e.message), str(g.help)]); })));
    if (!n) data.push([str("Nothing needs checking.")]);
    return { sheet: "Issues", data, columns: widths([34, 46, 100, 80]) };
  }

  const PLACE_TYPE_TEXT = { workshop: "Workshop or depot", vehicle: "Vehicle", site: "Site" };
  function placesSheet(model, D) {
    const { ML } = libs();
    const data = top(model, "Places", D, ML);
    data.push(head(["Place", "Type", "Registration", "Counts toward placard and manifest totals", "Archived", "Chemicals", "Notes"]));
    const count = new Map();
    (model.links || []).forEach((l) => count.set(Number(l.place_id), (count.get(Number(l.place_id)) || 0) + 1));
    (model.places || []).forEach((p) => data.push([str(p.name), str(PLACE_TYPE_TEXT[p.place_type] || p.place_type), str(p.registration), str(p.counts_toward_totals ? "Yes" : "No"), str(p.archived ? "Yes" : ""), num(count.get(Number(p.id)) || 0), str(p.notes)]));
    return { sheet: "Places", data, columns: widths([34, 18, 14, 22, 10, 11, 50]) };
  }

  function placeLinksSheet(model, D) {
    const { ML } = libs();
    const data = top(model, "Where each chemical is kept", D, ML);
    data.push(head(["Place", "Type", "Registration", "Product", "Quantity", "Unit", "Container", "Spill compound"]));
    const byId = new Map((model.places || []).map((p) => [Number(p.id), p]));
    const names = new Map(model.chemicals.map((c) => [c.id, c.product_name]));
    const rows = (model.links || []).map((l) => ({ l, p: byId.get(Number(l.place_id)) || {}, name: names.get(Number(l.chemical_id)) || "" }));
    rows.sort((a, b) => String(a.p.name || "").localeCompare(String(b.p.name || "")) || a.name.localeCompare(b.name));
    rows.forEach(({ l, p, name }) => data.push([str(p.name), str(PLACE_TYPE_TEXT[p.place_type] || p.place_type), str(p.registration), str(name), num(l.quantity), str(l.quantity == null ? "" : l.unit), str(l.container_note), str(l.spill_compound)]));
    return { sheet: "Place links", data, columns: widths([34, 18, 14, 34, 10, 7, 24, 24]) };
  }

  const ASSESS_HEAD = ["Product", "Assessed", "Assessed by", "Risk level", "Form", "Use", "Breathing in", "Swallowing", "Skin absorption", "Isolation", "Ventilation", "Other controls", "PPE", "Additional PPE", "Controls notes", "PPE notes", "Fire response", "Spill response", "Atmospheric monitoring", "Health surveillance", "Check these (not found in the SDS text)"];
  const ASSESS_W = [30, 13, 22, 26, 11, 36, 11, 11, 13, 36, 30, 34, 30, 30, 36, 30, 40, 40, 28, 28, 34];

  function assessmentsSheet(model, D) {
    const { M, ML } = libs();
    const data = top(model, "Risk assessments", D, ML);
    data.push(head(ASSESS_HEAD));
    model.chemicals.forEach((c) => {
      const a = c.assessment;
      if (!a) return;
      const g = a.grouped;
      data.push([
        str(c.product_name), str(M.fmtDate(a.assessed_date)), str(a.assessed_by), str(M.RISK_LABEL[a.risk_level] || ""), str(a.form), str(a.use_description),
        str(M.yesNo(a.route_inhalation)), str(M.yesNo(a.route_ingestion)), str(M.yesNo(a.route_absorption)),
        str(g.isolation.join("; ")), str(g.ventilation.join("; ")), str(g.other.join("; ")), str(g.ppe.join("; ")), str(g.additional_ppe.join("; ")),
        str(a.controls_notes), str(a.ppe_notes), str(a.fire_response), str(a.spill_response),
        str(M.yesNo(a.monitoring_needed) + (a.monitoring_note ? ": " + a.monitoring_note : "")),
        str(M.yesNo(a.surveillance_needed) + (a.surveillance_note ? ": " + a.surveillance_note : "")),
        str(M.flaggedFields(a).join(", ")),
      ]);
    });
    return { sheet: "Assessments", data, columns: widths(ASSESS_W) };
  }

  // ---- audits (only what the server returned: a user's export holds only their own audits)
  const AUDIT_STATUS = { in_progress: "In progress, not finished", finished: "Finished" };
  const RESULT = { present: "Present", not_found: "Not found", changed: "Changed" };
  const OUTCOME = { linked: "Linked to this place", link_suggested: "Link suggested to an admin", created: "Added to the register (needs an SDS)", recorded: "Recorded only" };
  const REASON = { expired: "Expired", unlabelled: "Unlabelled", damaged: "Damaged", unknown: "Unknown contents", no_sds: "No SDS" };
  const DSTATUS = { to_dispose: "To be disposed of", disposed: "Disposed of" };
  const FKIND = { not_found: "Not found: unlink from the place", changed: "Changed: update quantity or container", found_link: "Found: link to the place" };
  const auditPlace = (model) => { const m = new Map(); (model.audits || []).forEach((a) => m.set(Number(a.id), a)); return m; };
  const when = (iso) => (iso ? String(iso).replace("T", " ").replace(/:\d\d(\.\d+)?Z?$/, "") : "");

  function auditsSheet(model, D) {
    const { M, ML } = libs();
    const data = top(model, "Audits", D, ML);
    data.push(head(["Audit", "Place", "Type", "Registration", "Status", "Audited by", "Started", "Finished", "Chemicals listed", "Present", "Not found", "Changed", "Not marked", "Found items", "For disposal", "Photos", "Photo storage (MB)", "Notes"]));
    (model.audits || []).forEach((a) => {
      const x = M.auditSummary(model, a);
      data.push([num(a.id), str(a.place_name), str(a.place_type), str(a.place_registration), str(AUDIT_STATUS[a.status] || a.status), str(a.started_by_name), str(when(a.started_at)), str(when(a.finished_at)), num(x.listed), num(x.present), num(x.not_found), num(x.changed), num(x.not_marked), num(x.found), num(x.disposals), num(x.photos), num(Math.round((x.photo_bytes / 1048576) * 100) / 100), str(a.notes)]);
    });
    if (!(model.audits || []).length) data.push([str("No audits have been recorded (or none are visible to you).")]);
    return { sheet: "Audits", data, columns: widths([8, 28, 12, 12, 22, 20, 18, 18, 10, 9, 9, 9, 9, 9, 9, 8, 12, 40]) };
  }
  function auditItemsSheet(model, D) {
    const { M, ML } = libs();
    const data = top(model, "Audit items", D, ML);
    data.push(head(["Audit", "Place", "Product", "Supplier", "Result", "Expected quantity", "Unit", "Expected container", "Now quantity", "Now unit", "Now container", "Note", "SDS review then", "Review due", "SDS on file", "Assessment on file", "Marked"]));
    const am = auditPlace(model);
    (model.auditItems || []).forEach((i) => { const a = am.get(Number(i.audit_id)) || {}; data.push([num(i.audit_id), str(a.place_name), str(i.product_name), str(i.supplier), str(RESULT[i.result] || "Not marked"), num(i.expected_quantity), str(i.expected_unit), str(i.expected_container_note), num(i.new_quantity), str(i.new_unit), str(i.new_container_note), str(i.note), str(M.STATUS_LABEL[i.review_status] || i.review_status), str(M.fmtDate(i.review_due)), str(i.has_sds ? "Yes" : "No"), str(i.has_assessment ? "Yes" : "No"), str(when(i.marked_at))]); });
    return { sheet: "Audit items", data, columns: widths([8, 26, 30, 22, 12, 11, 7, 18, 11, 8, 18, 36, 16, 14, 9, 11, 18]) };
  }
  function auditFoundSheet(model, D) {
    const { ML } = libs();
    const data = top(model, "Found items", D, ML);
    data.push(head(["Audit", "Place", "Product", "Supplier", "Identified", "What happened", "Note", "Found"]));
    const am = auditPlace(model);
    (model.auditFound || []).forEach((f) => { const a = am.get(Number(f.audit_id)) || {}; data.push([num(f.audit_id), str(a.place_name), str(f.product_name), str(f.supplier), str(f.source === "ai" ? "Read from the label photo" : "Typed in"), str(OUTCOME[f.outcome] || f.outcome), str(f.note), str(when(f.found_at))]); });
    return { sheet: "Found items", data, columns: widths([8, 26, 30, 22, 22, 32, 36, 18]) };
  }
  function auditDisposalsSheet(model, D) {
    const { ML } = libs();
    const data = top(model, "Disposals", D, ML);
    data.push(head(["Audit", "Place", "Item", "Reason", "Note", "Status", "Flagged by", "Flagged", "Closed by", "Closed", "Closing note"]));
    (model.auditDisposals || []).forEach((d) => data.push([num(d.audit_id), str(d.place_name), str(d.description), str(REASON[d.reason] || d.reason), str(d.note), str(DSTATUS[d.status] || d.status), str(d.flagged_by_name), str(when(d.flagged_at)), str(d.closed_by_name), str(when(d.closed_at)), str(d.close_note)]));
    return { sheet: "Disposals", data, columns: widths([8, 26, 32, 18, 30, 18, 18, 18, 18, 18, 30]) };
  }
  function auditFindingsSheet(model, D) {
    const { ML } = libs();
    const data = top(model, "Findings", D, ML);
    data.push(head(["Audit", "Place", "What", "Product", "Status", "Resolved by", "Resolved", "Resolution note"]));
    (model.auditFindings || []).forEach((f) => data.push([num(f.audit_id), str(f.place_name), str(FKIND[f.kind] || f.kind), str(f.product_name), str(f.status), str(f.resolved_by_name), str(when(f.resolved_at)), str(f.resolve_note)]));
    return { sheet: "Findings", data, columns: widths([8, 26, 36, 30, 12, 18, 18, 36]) };
  }

  function reviewSheet(model, D) {
    const { M, ML } = libs();
    const data = top(model, "Safety data sheets due for review", D, ML);
    data.push(head(["Product", "Supplier", "Status", "Review due", "SDS issue date"]));
    const order = { overdue: 0, due_soon: 1, no_sds: 2, unknown: 3 };
    const list = model.chemicals.filter((c) => c.status !== "ok");
    list.sort((a, b) => (order[a.status] - order[b.status]) || String(a.review_due || "9999").localeCompare(String(b.review_due || "9999")));
    list.forEach((c) => data.push([str(c.product_name), str(c.supplier), str(M.STATUS_LABEL[c.status]), str(M.fmtDate(c.review_due)), str(M.fmtDate(c.sds_issue_date))]));
    if (!list.length) data.push([str("Nothing is due for review.")]);
    return { sheet: "Review due", data, columns: widths([30, 24, 20, 14, 14]) };
  }

  // model: export-model.normalise(); D: window.DISCLAIMER; opts: {ref, totals, layout}
  function buildSheets(model, D, opts) {
    const o = opts || {};
    return [registerSheet(model, D, o), hazardousSheet(model, D, o), placesSheet(model, D), placeLinksSheet(model, D), manifestSheet(model, D, o), itemsSheet(model, D, o), issuesSheet(model, D, o), assessmentsSheet(model, D), reviewSheet(model, D), auditsSheet(model, D), auditItemsSheet(model, D), auditFoundSheet(model, D), auditDisposalsSheet(model, D), auditFindingsSheet(model, D)];
  }

  return { buildSheets, registerSheet, hazardousSheet, placesSheet, placeLinksSheet, manifestSheet, itemsSheet, issuesSheet, assessmentsSheet, reviewSheet, auditsSheet, auditItemsSheet, auditFoundSheet, auditDisposalsSheet, auditFindingsSheet };
});
