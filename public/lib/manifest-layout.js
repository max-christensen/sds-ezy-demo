// MANIFEST LAYOUT AND MODEL: the one place that says what the placard / manifest screen and its exports show.
// The totals themselves come from computeSiteTotals() in ghs-ref.mjs (the single rule); this file only SHAPES them for display.
// Functions that need the reference module take it as an argument (`ref`, from import("/lib/ghs-ref.mjs")) so this file
// stays a plain script that works in the browser and in node tests.
//
//   LAYOUT.rows   : the table of storage locations of hazardous chemicals (one line each)
//   LAYOUT.items  : the table of placard / manifest items (all 43 are always in the exports)
//   ADG class is shown "for illustration only" (ref.ADG_COLUMN_NOTE).
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).manifestLayout = m;
})(typeof self !== "undefined" ? self : this, function () {
  const clean = (v) => (v == null ? "" : String(v).trim());
  const fmtNum = (n) => { const x = Number(n); return isFinite(x) ? String(Math.round(x * 100) / 100) : ""; };

  const SOURCE_LINE = "Reference data: Safe Work Australia, Placard and manifest requirements under the model WHS Regulations (Schedule 11) and Classification and labelling for workplace hazardous chemicals. The regulations and the supplier's SDS are the authority.";

  const LAYOUT = {
    title: "Hazardous chemicals manifest",
    subtitle: "Placard and manifest quantities by item (Schedule 11, WHS Regulations)",
    header: [
      { label: "Business", from: "company_name" },
      { label: "Address", from: "company_address" },
      { label: "Emergency contact", from: "company_phone" },
      { label: "Email", from: "company_email" },
      { label: "Prepared", from: "generated" },
    ],
    // One line per storage location. `items` = the placard items the product counts towards.
    rows: [
      { key: "product", label: "Product", width: 20, get: (r) => clean(r.product_name) },
      { key: "un", label: "UN no.", width: 6, get: (r) => (clean(r.un_number) ? "UN " + clean(r.un_number).replace(/^UN\s*/i, "") : "") },
      { key: "class", label: "ADG class (illustration only)", width: 9, get: (r) => clean(r.dg_class) + (clean(r.subsidiary_class) ? " (" + clean(r.subsidiary_class) + ")" : "") },
      { key: "pg", label: "PG", width: 4, get: (r) => clean(r.packing_group) },
      { key: "hazchem", label: "Hazchem", width: 6, get: (r) => clean(r.hazchem_code) },
      { key: "psn", label: "Proper shipping name", width: 17, get: (r) => clean(r.proper_shipping_name) },
      { key: "qty", label: "Quantity", width: 6, num: true, get: (r) => (r.quantity == null || r.quantity === "" ? "not recorded" : fmtNum(r.quantity)), raw: (r) => (r.quantity == null || r.quantity === "" ? "" : Number(r.quantity) || 0) },
      { key: "unit", label: "Unit", width: 4, get: (r) => (r.quantity == null || r.quantity === "" ? "" : clean(r.unit) || "L") },
      { key: "note", label: "Container", width: 10, get: (r) => clean(r.container_note) },
      { key: "items", label: "Counts towards item", width: 9, get: (r) => itemsText(r) },
    ],
    // One line per placard item.
    items: [
      { key: "item", label: "Item", width: 4, num: true },
      { key: "desc", label: "Description", width: 25 },
      { key: "adg", label: "ADG class (illustration only)", width: 9 },
      { key: "placard", label: "Placard quantity", width: 8, num: true },
      { key: "manifest", label: "Manifest quantity", width: 8, num: true },
      { key: "total", label: "Site total", width: 9, num: true },
      { key: "pstatus", label: "Placard", width: 7 },
      { key: "mstatus", label: "Manifest", width: 7 },
      { key: "products", label: "Products counted", width: 23 },
    ],
    emptyText: "No hazardous chemicals are kept at this place yet.",
  };

  function itemsText(r) {
    const a = Array.isArray(r.items) ? r.items : [];
    if (a.length) return a.map((n) => "Item " + n).join(", ");
    if (r.classification == null) return "Not classified";
    return "None";
  }

  // ---- plain wording for each kind of issue (the message text itself comes from ghs-ref.mjs)
  const ISSUE_GROUPS = [
    { code: "unit_mismatch", title: "Quantity in a unit the item does not use (NOT counted)", help: "The table gives the item in litres or kilograms only, and there is no density here to convert. Fix the unit or check by hand." },
    { code: "multiple_items", title: "Product counts towards more than one item", help: "The table does not say how to combine them, so the whole quantity is counted in each item. This can overstate the position; it never understates it." },
    { code: "category_unconfirmed", title: "Category not confirmed against the SDS", help: "The item depends on a category that could not be found in the SDS text. Check the classification on the chemical's page." },
    { code: "category_unknown", title: "Category not known", help: "The class is recorded without a category, so no item can be worked out." },
    { code: "no_classification", title: "No GHS classification recorded (not counted)", help: "These products cannot be placed in an item until they are classified. Open each one and record its classification." },
    { code: "explosives_not_in_table", title: "Explosives not in this table", help: "Divisions 1.1 to 1.6 are covered by the Australian Explosives Code, not this table." },
    { code: "desens_not_in_table", title: "Desensitised explosives not in this table", help: "" },
    { code: "ox_gas_alone", title: "Oxidising gas with no item", help: "Oxidising gases have no item of their own. If it is a gas under pressure, record that class too." },
    { code: "gas_lc50", title: "Gas: check the LC50", help: "Item 2 covers acute toxicity category 4 only up to an LC50 of 5000 ppmV. The LC50 is not held here." },
    { code: "acute4_not_in_table", title: "Acute toxicity category 4 (liquids and solids): no item", help: "" },
    { code: "no_item", title: "No item in the table for this category", help: "" },
  ];

  // Issues from computeSiteTotals plus "category not confirmed" taken from the contributors. Returns [{code,title,help,entries:[{name,message}]}].
  function groupIssues(totals) {
    const groups = new Map(ISSUE_GROUPS.map((g) => [g.code, Object.assign({}, g, { entries: [] })]));
    const seen = new Set();
    const add = (code, name, message) => {
      let g = groups.get(code);
      if (!g) { g = { code, title: code.replace(/_/g, " "), help: "", entries: [] }; groups.set(code, g); }
      const k = code + "|" + name + "|" + message;
      if (seen.has(k)) return;
      seen.add(k);
      g.entries.push({ name, message });
    };
    for (const i of (totals && totals.issues) || []) add(i.code, i.name || "", i.message || "");
    for (const t of (totals && totals.items) || []) {
      for (const c of t.contributors || []) {
        if (c.check) add("category_unconfirmed", c.name, c.name + ": counted in item " + t.item + " from " + c.via + ", but the category was not confirmed against the SDS.");
      }
    }
    return [...groups.values()].filter((g) => g.entries.length);
  }

  // ---- items model
  const lower = (s) => clean(s).toLowerCase();
  const lcFirst = (s) => { const t = clean(s); return t ? t.charAt(0).toLowerCase() + t.slice(1) : ""; };
  function itemTitle(def) {
    if (def.mixOf) return def.group + ": any mix of items " + def.mixOf.join(", ");
    return def.group + (def.desc ? ", " + lcFirst(def.desc) : "");
  }
  // The same words in a sentence: "flammable liquids category 2"
  function itemPhrase(def) {
    if (def.mixOf) return lower(def.group) + " (mix of items " + def.mixOf.join(", ") + ")";
    return lower(def.group) + (def.desc ? " " + lcFirst(def.desc) : "");
  }
  function unitText(def) { return def.unit; }
  function qtyText(n, def) { return fmtNum(n) + " " + (def.unit === "kg or L" ? "kg or L" : def.unit); }
  function totalText(t) {
    const def = t.def;
    if (def.unit !== "kg or L" || !(t.totalL > 0 && t.totalKg > 0)) return qtyText(t.total, def);
    return fmtNum(t.total) + " (" + fmtNum(t.totalL) + " L + " + fmtNum(t.totalKg) + " kg)";
  }

  // totals: the result of computeSiteTotals (as the server sends it). Returns one model row per item (always all items).
  function itemsModel(totals) {
    const byItem = new Map((totals.items || []).map((t) => [t.item, t]));
    return (totals.items || []).map((t) => {
      const def = t.def;
      let pstatus = t.placardOver ? "OVER" : t.placardNear ? "NEAR" : "OK", mstatus = t.manifestOver ? "OVER" : t.manifestNear ? "NEAR" : "OK";
      const blocked = { placard: [], manifest: [] };
      if (t.isMix && t.mixApplies) {
        for (const n of def.mixOf) {
          const p = byItem.get(n);
          if (p && p.counted > p.def.placard) blocked.placard.push(n);
          if (p && p.counted > p.def.manifest) blocked.manifest.push(n);
        }
        if (!t.mixApplies.placard) pstatus = "NOT APPLIED";
        if (!t.mixApplies.manifest) mstatus = "NOT APPLIED";
      }
      const stock = (t.contributors || []).length > 0 || (t.mixParts || []).some((p) => p.total > 0);
      const note = (col) => (blocked[col].length ? "not applied: item " + blocked[col].join(", ") + " already over" : "");
      return {
        item: def.item, def, isMix: !!t.isMix, title: itemTitle(def), phrase: itemPhrase(def), adg: clean(def.adg),
        placard: def.placard, manifest: def.manifest, unit: def.unit,
        total: t.total, totalText: totalText(t), pstatus, mstatus, pnote: note("placard"), mnote: note("manifest"),
        placardOver: !!t.placardOver, manifestOver: !!t.manifestOver, placardNear: !!t.placardNear, manifestNear: !!t.manifestNear,
        pctPlacard: Math.round((t.total / def.placard) * 100), pctManifest: Math.round((t.total / def.manifest) * 100),
        mixParts: t.mixParts || null, contributors: t.contributors || [], hasStock: stock, notes: def.notes || [],
        productsText: productsText(t),
      };
    });
  }
  function productsText(t) {
    if (t.isMix && t.mixParts) {
      const parts = t.mixParts.filter((p) => p.total > 0).map((p) => "item " + p.item + ": " + fmtNum(p.total));
      return parts.length ? "Adds up " + parts.join(", ") : "";
    }
    const seen = new Map();
    for (const c of t.contributors || []) {
      const k = c.name;
      const prev = seen.get(k) || { q: 0, u: c.unit, counted: true };
      prev.q += c.quantity; prev.counted = prev.counted && c.counted; seen.set(k, prev);
    }
    return [...seen.entries()].map(([n, v]) => n + " (" + fmtNum(v.q) + " " + v.u + (v.counted ? "" : ", not counted") + ")").join("; ");
  }

  // ---- banner: one line per item that is over (placard and/or manifest). The wording is asserted in the tests.
  function overBanners(model) {
    const out = [];
    for (const m of model) {
      if (m.placardOver) out.push({ kind: "placard", item: m.item, text: "Over the placard quantity: Item " + m.item + " " + m.phrase + ": " + m.totalText + ", placard quantity " + fmtNum(m.placard) + " " + m.unit });
      if (m.manifestOver) out.push({ kind: "manifest", item: m.item, text: "Over the manifest quantity: Item " + m.item + " " + m.phrase + ": " + m.totalText + ", manifest quantity " + fmtNum(m.manifest) + " " + m.unit });
    }
    return out;
  }

  // Amber "near" lines: at least 80% of the quantity but not over it (a reading aid; the table has no such threshold).
  function nearBanners(model) {
    const out = [];
    for (const m of model) {
      if (m.placardNear) out.push({ kind: "placard", item: m.item, text: "Near the placard quantity: Item " + m.item + " " + m.phrase + ": " + m.totalText + ", placard quantity " + fmtNum(m.placard) + " " + m.unit + " (" + m.pctPlacard + "%)" });
      if (m.manifestNear) out.push({ kind: "manifest", item: m.item, text: "Near the manifest quantity: Item " + m.item + " " + m.phrase + ": " + m.totalText + ", manifest quantity " + fmtNum(m.manifest) + " " + m.unit + " (" + m.pctManifest + "%)" });
    }
    return out;
  }

  // ---- inputs from the take-away export (/api/export/all)
  function parseClass(v) {
    if (v == null || v === "") return null;
    if (Array.isArray(v)) return v;
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch (e) { return null; }
  }
  // The export sends `classification` (parsed); older shapes sent `ghs_classification` (JSON text). Accept either.
  function classOf(c) { return parseClass(c.classification !== undefined ? c.classification : c.ghs_classification); }
  const chemMap = (data) => { const m = new Map(); for (const c of data.chemicals || []) m.set(Number(c.chemical_id != null ? c.chemical_id : c.id), c); return m; };

  // One entry per chemical-place link, for computePlaceTotals.
  function entriesFromExport(data) {
    const chems = chemMap(data);
    const out = [];
    for (const l of data.links || []) {
      const c = chems.get(Number(l.chemical_id));
      if (!c) continue;
      out.push({ id: l.id, place_id: l.place_id, chemical_id: Number(l.chemical_id), name: c.product_name, classification: classOf(c), quantity: l.quantity == null ? 0 : Number(l.quantity), unit: l.unit, spill_compound: l.spill_compound || null });
    }
    return out;
  }
  // The per-place results: the export's place_totals if the server sent them, otherwise computePlaceTotals here (the same function).
  function placeResults(data, ref) {
    if (Array.isArray(data.place_totals) && data.place_totals.length) return data.place_totals;
    return ref.computePlaceTotals(data.places || [], entriesFromExport(data));
  }
  // Rows (one per hazardous chemical kept in the place) with the items each counts towards.
  function rowsForPlace(data, placeId, ref) {
    const chems = chemMap(data);
    const rows = [];
    for (const l of data.links || []) {
      if (String(l.place_id) !== String(placeId)) continue;
      const c = chems.get(Number(l.chemical_id));
      if (!c || c.decision !== "hazardous") continue;
      const cl = classOf(c);
      rows.push({
        link_id: l.id, chemical_id: Number(l.chemical_id), product_name: c.product_name, supplier: c.supplier,
        spill_compound: l.spill_compound, quantity: l.quantity, unit: l.unit, container_note: l.container_note, classification: cl,
        items: ref && cl ? ref.itemsForClassification(cl).items.map((i) => i.item).sort((a, b) => a - b) : [],
        dg_class: c.dg_class, subsidiary_class: c.subsidiary_class, un_number: c.un_number, packing_group: c.packing_group,
        hazchem_code: c.hazchem_code, proper_shipping_name: c.proper_shipping_name,
      });
    }
    rows.sort((a, b) => clean(a.product_name).localeCompare(clean(b.product_name)));
    return rows;
  }
  // Manifest-shaped sections from export data: {places:[{place,counts,totals,over,near,rows}], not_counted:[{place,note,caveat}]}.
  function sectionsFromExport(data, ref) {
    const places = [], notCounted = [];
    for (const r of placeResults(data, ref)) {
      if (r.place && r.place.archived) continue;
      if (r.counts) places.push({ place: r.place, counts: true, totals: r.totals, over: r.over, near: r.near, rows: rowsForPlace(data, r.place.id, ref) });
      else notCounted.push({ place: r.place, note: r.note, caveat: r.caveat });
    }
    return { places, not_counted: notCounted };
  }

  function headerFacts(company, generatedText, layout) {
    const L = layout || LAYOUT;
    const src = Object.assign({}, company || {}, { generated: generatedText || "" });
    return L.header.map((h) => ({ label: h.label, value: clean(src[h.from]) })).filter((h) => h.value);
  }

  function rowsMatrix(rows, layout) {
    const L = layout || LAYOUT;
    return { head: L.rows.map((c) => c.label), body: (rows || []).map((r) => L.rows.map((c) => c.get(r))) };
  }
  function itemCells(m) {
    return {
      item: String(m.item), desc: m.title, adg: m.adg, placard: fmtNum(m.placard) + " " + m.unit, manifest: fmtNum(m.manifest) + " " + m.unit,
      total: m.totalText, pstatus: m.pstatus + (m.pnote ? " (" + m.pnote + ")" : ""), mstatus: m.mstatus + (m.mnote ? " (" + m.mnote + ")" : ""), products: m.productsText,
    };
  }
  function itemsMatrix(model, layout, opts) {
    const L = layout || LAYOUT;
    const list = opts && opts.onlyStock ? model.filter((m) => m.hasStock) : model;
    return { head: L.items.map((c) => c.label), body: list.map((m) => { const c = itemCells(m); return L.items.map((col) => c[col.key]); }) };
  }

  const PLACE_TYPE_TEXT = { workshop: "Workshop or depot", vehicle: "Vehicle", site: "Site" };
  const placeTitle = (p) => clean(p.name) + " (" + (PLACE_TYPE_TEXT[p.place_type] || clean(p.place_type)) + (p.registration ? ", " + clean(p.registration) : "") + ")";

  // Over / near lines across all counting places, naming the place: for the top of the manifest.
  function summaryLines(manifest) {
    const over = [], near = [];
    for (const sec of manifest.places || []) {
      const model = itemsModel(sec.totals);
      const at = (t) => t.replace(":", " at " + sec.place.name + ":");
      overBanners(model).forEach((b) => over.push({ kind: b.kind, place_id: sec.place.id, place: sec.place.name, text: at(b.text) }));
      nearBanners(model).forEach((b) => near.push({ kind: b.kind, place_id: sec.place.id, place: sec.place.name, text: at(b.text) }));
    }
    return { over, near };
  }

  // CSV: facts, the over/near summary, then per counting place: items (all 43), issues, rows; then the places that do not count.
  function csvRows(manifest, company, ref, layout) {
    const L = layout || LAYOUT;
    const out = [[L.title]];
    for (const f of headerFacts(company, manifest.generated_at || "", L)) out.push([f.label, f.value]);
    out.push([]);
    const sm = summaryLines(manifest);
    sm.over.forEach((b) => out.push([b.text.toUpperCase()]));
    sm.near.forEach((b) => out.push([b.text]));
    if (sm.over.length || sm.near.length) out.push([]);
    for (const sec of manifest.places || []) {
      out.push(["PLACE: " + placeTitle(sec.place)]);
      const im = itemsMatrix(itemsModel(sec.totals), L);
      out.push(im.head); im.body.forEach((r) => out.push(r));
      out.push([]);
      const groups = groupIssues(sec.totals);
      if (groups.length) { out.push(["Things to check"]); groups.forEach((g) => g.entries.forEach((e) => out.push([g.title, e.message]))); out.push([]); }
      const rm = rowsMatrix(sec.rows, L);
      out.push(rm.head); rm.body.forEach((r) => out.push(r));
      out.push([]);
    }
    if ((manifest.not_counted || []).length) {
      out.push(["Places that are not counted"]);
      manifest.not_counted.forEach((n) => out.push([placeTitle(n.place), n.note, n.caveat || ""]));
      out.push([]);
    }
    out.push([ref ? ref.ADG_COLUMN_NOTE : ""]);
    out.push([SOURCE_LINE]);
    return out;
  }

  // The choices made where the source documents are not clear, in plain words (the rules themselves live in ghs-ref.mjs; see docs/REFERENCE.md).
  const DECISIONS = [
    "A product that falls under more than one item has its whole quantity counted in each of them, and a notice names the items. This can overstate a place's position; it never understates it.",
    "Gases count under item 2 (acute toxicity), item 3 (skin corrosion) or item 1 (flammable gas), and only under item 4 if none of those apply. A category 4 acutely toxic gas is counted and flagged: check the LC50.",
    "Kilograms and litres are not converted (no density is held). A quantity in a unit the item does not use is not counted and is listed under the issues. Items given as \"kg or L\" add kilograms and litres as plain numbers.",
    "\"Over\" means strictly more than the quantity in the table.",
    "Mixing items apply only where none of the items they cover is over on its own. This is checked separately for the placard column and the manifest column. If one is already over, that item is the flag and the mixing item shows \"not applied\".",
    "Totals are worked out for each place on its own, never across the whole business. Each link can carry a spill compound name: links with the same name in one place are one compound; if blank, the place is the compound.",
    "Only liquids with a flash point up to 93 C are flammable liquids. Flash points are not held here; the classification is relied on.",
    "Explosives of Divisions 1.1 to 1.6, desensitised explosives, oxidising gases on their own and acute toxicity category 4 for liquids and solids have no item in the table. They are listed as issues, not counted.",
    "Where a category could not be told from the SDS text, it is marked \"category not confirmed\" and the item is flagged.",
  ];

  return {
    LAYOUT, SOURCE_LINE, ISSUE_GROUPS, DECISIONS, fmtNum, itemsText, itemTitle, itemPhrase, itemsModel, overBanners, nearBanners, groupIssues, summaryLines, placeTitle, PLACE_TYPE_TEXT,
    entriesFromExport, placeResults, rowsForPlace, sectionsFromExport, headerFacts, rowsMatrix, itemsMatrix, itemCells, csvRows, parseClass, totalText, qtyText, unitText,
  };
});
