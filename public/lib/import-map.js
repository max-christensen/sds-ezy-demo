// Spreadsheet import helpers: find the header row, guess which column is which, turn rows into the objects
// POST /api/import expects, and list the problems. Pure functions (no DOM) so they can be tested in node.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.SDSLib = root.SDSLib || {}).importMap = m;
})(typeof self !== "undefined" ? self : this, function () {
  // The fields we can fill, with the words people use for them in their spreadsheets (lower case, no punctuation).
  const FIELDS = [
    { key: "product_name", label: "Product name", required: true, aliases: ["product name", "product", "chemical name", "chemical", "name", "product description", "material", "item", "substance", "trade name"] },
    { key: "supplier", label: "Supplier", aliases: ["supplier", "manufacturer", "vendor", "brand", "company", "made by", "supplier name"] },
    { key: "location", label: "Place (where it is kept)", aliases: ["location", "storage location", "place", "stored", "stored at", "where stored", "where kept", "storage", "area", "cabinet", "store", "vehicle", "site", "depot"] },
    { key: "place_type", label: "Place type (workshop, vehicle or site)", aliases: ["place type", "type of place", "location type", "storage type", "kind of place"] },
    { key: "quantity", label: "Quantity", aliases: ["quantity", "qty", "amount", "volume", "max quantity", "quantity held", "total quantity", "stock", "capacity", "size"] },
    { key: "unit", label: "Unit (L or kg)", aliases: ["unit", "units", "uom", "unit of measure", "l kg", "litres kg"] },
    { key: "un_number", label: "UN number", aliases: ["un number", "un no", "un", "un id", "un code", "unno"] },
    { key: "dg_class", label: "ADG class (illustration only)", aliases: ["dg class", "class", "dangerous goods class", "hazard class", "dg", "adg class", "primary class"] },
    { key: "packing_group", label: "Packing group", aliases: ["packing group", "pg", "packing grp", "pack group"] },
    { key: "hazchem_code", label: "Hazchem code", aliases: ["hazchem", "hazchem code", "emergency action code", "eac"] },
    { key: "sds_date", label: "SDS date", aliases: ["sds date", "sds issue date", "issue date", "date of issue", "sds revision date", "revision date", "date", "sds issued", "sds dated", "issued"] },
    { key: "use_description", label: "Use", aliases: ["use", "uses", "used for", "application", "purpose", "description of use", "usage", "use description"] },
    { key: "decision", label: "Hazardous decision", aliases: ["decision", "hazardous", "hazardous y n", "hazardous or not", "hazardous chemical", "classification", "hazardous status", "haz", "hazardous non hazardous", "dangerous"] },
    { key: "notes", label: "Notes", aliases: ["notes", "note", "comments", "comment", "remarks", "decision note", "reason"] },
  ];
  const FIELD_KEYS = FIELDS.map((f) => f.key);

  const text = (v) => (v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());
  const norm = (v) => text(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function isEmptyRow(row) {
    return !row || row.every((c) => text(c) === "");
  }

  // How well does one header cell fit one field? 0 = not at all, 100 = exact alias.
  function headerScore(cell, field) {
    const h = norm(cell);
    if (!h) return 0;
    let best = 0;
    for (const a of field.aliases) {
      if (h === a) best = Math.max(best, 100);
      else if (h.startsWith(a + " ") || h.endsWith(" " + a)) best = Math.max(best, 70 - Math.min(20, h.length - a.length));
      else if (a.length >= 4 && h.includes(a)) best = Math.max(best, 50);
      else if (a.split(" ").length === 1 && a.length >= 3 && h.split(" ").includes(a)) best = Math.max(best, 55);
    }
    return best;
  }

  // Pick the header row from the first 20 rows: the one whose cells best match known field names.
  function detectHeaderRow(rows) {
    let bestRow = -1, bestScore = 0;
    const limit = Math.min(rows.length, 20);
    for (let i = 0; i < limit; i++) {
      const row = rows[i] || [];
      let score = 0;
      for (const cell of row) {
        if (typeof cell === "number") continue;
        let m = 0;
        for (const f of FIELDS) m = Math.max(m, headerScore(cell, f));
        if (m >= 50) score += m;
      }
      if (score > bestScore) { bestScore = score; bestRow = i; }
    }
    if (bestRow >= 0 && bestScore >= 100) return bestRow;
    // fallback: the first row with at least two non-empty cells
    for (let i = 0; i < limit; i++) if ((rows[i] || []).filter((c) => text(c) !== "").length >= 2) return i;
    return 0;
  }

  // Guess a mapping {fieldKey: columnIndex | -1} from the header cells. Each column is used at most once.
  function guessMapping(headers) {
    const pairs = [];
    FIELDS.forEach((f) => headers.forEach((h, ci) => { const s = headerScore(h, f); if (s >= 50) pairs.push({ f: f.key, ci, s }); }));
    pairs.sort((a, b) => b.s - a.s);
    const mapping = {};
    FIELD_KEYS.forEach((k) => (mapping[k] = -1));
    const usedCols = new Set();
    for (const p of pairs) {
      if (mapping[p.f] !== -1 || usedCols.has(p.ci)) continue;
      mapping[p.f] = p.ci;
      usedCols.add(p.ci);
    }
    return mapping;
  }

  // ---- value cleaners --------------------------------------------------------------------------------

  const UNIT_WORDS = [
    [/^(l|lt|ltr|ltrs|litre|litres|liter|liters)$/i, "L", 1],
    [/^(ml|millilitre|millilitres|milliliter|milliliters)$/i, "L", 0.001],
    [/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/i, "kg", 1],
    [/^(g|gm|gms|gram|grams)$/i, "kg", 0.001],
  ];
  function unitInfo(word) {
    const w = text(word).replace(/\./g, "");
    for (const [re, unit, factor] of UNIT_WORDS) if (re.test(w)) return { unit, factor };
    return null;
  }

  // "20", "20 L", "4 x 5 L", "500ml", "2.5kg" -> {amount, unit|null, note}. amount null = could not read.
  function parseQuantity(v) {
    if (typeof v === "number") return isFinite(v) ? { amount: v, unit: null, note: "" } : { amount: null, unit: null, note: "" };
    const s = text(v).replace(/,(?=\d{3}\b)/g, "");
    if (!s) return { amount: null, unit: null, note: "" };
    let m = s.match(/^(\d+(?:\.\d+)?)\s*[x*]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z.]*)$/);
    if (m) {
      const u = m[3] ? unitInfo(m[3]) : null;
      if (m[3] && !u) return { amount: null, unit: null, note: s };
      const total = Number(m[1]) * Number(m[2]) * (u ? u.factor : 1);
      return { amount: round(total), unit: u ? u.unit : null, note: s };
    }
    m = s.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z.]*)\b/);
    if (m) {
      const rest = s.slice(m[0].length).trim();
      if (!m[2]) return { amount: Number(m[1]), unit: null, note: rest };
      const u = unitInfo(m[2]);
      if (u) return { amount: round(Number(m[1]) * u.factor), unit: u.unit, note: rest };
      return { amount: Number(m[1]), unit: null, note: s, unknownUnit: m[2] };
    }
    return { amount: null, unit: null, note: s };
  }
  function round(n) { return Math.round(n * 1000) / 1000; }

  // "Van", "Vehicle", "Ute" -> vehicle; "Site" -> site; "Workshop", "Depot", "Shed" -> workshop; anything else -> "".
  function parsePlaceType(v) {
    const t = norm(v);
    if (!t) return "";
    if (/(vehicle|van|ute|truck|car|trailer|vehicles)/.test(t)) return "vehicle";
    if (/site/.test(t)) return "site";
    if (/(workshop|depot|shed|store|yard|warehouse|shop|office)/.test(t)) return "workshop";
    return "";
  }

  function parseUnit(v) {
    const u = unitInfo(v);
    return u ? u.unit : null;
  }

  // "UN1993", "UN 1993", 1993, "1993 " -> "1993"
  function parseUn(v) {
    const m = text(v).match(/(\d{4})/);
    return m ? m[1] : "";
  }
  // Class: "3", "2.1", "Class 8", "3 (8)" -> {dg_class, subsidiary}
  function parseClass(v) {
    const s = text(v);
    const all = s.match(/\d(?:\.\d)?/g) || [];
    return { dg_class: all[0] || "", subsidiary: all[1] || "" };
  }
  function parsePg(v) {
    const s = text(v).toUpperCase().replace(/PG|PACKING GROUP|GROUP/g, "").trim();
    if (s === "1" || s === "I") return "I";
    if (s === "2" || s === "II") return "II";
    if (s === "3" || s === "III") return "III";
    return "";
  }
  function parseDecision(v) {
    const s = norm(v);
    if (!s) return null;
    if (/\b(non|not|no|nil|n a|na|none|false|n)\b/.test(s) && !/\bnot (a )?non\b/.test(s)) return "not_hazardous";
    if (/\b(haz|hazardous|yes|y|true|dg|dangerous|poison|flammable|corrosive)\b/.test(s)) return "hazardous";
    return null;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function iso(y, m, d) {
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    if (y < 1980 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return "";
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return "";
    return dt.toISOString().slice(0, 10);
  }
  // Dates: Date objects, 2021-03-12, 12/03/2021 (day first, as in Australia), 12 Mar 2021, 12 March 2021, Excel serial numbers.
  function parseDate(v) {
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    const s = text(v);
    if (!s) return "";
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (m) return iso(+m[3], +m[2], +m[1]);
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})$/);
    if (m && MONTHS[m[2].slice(0, 4).toLowerCase()] || (m && MONTHS[m[2].slice(0, 3).toLowerCase()])) {
      return iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()] || MONTHS[m[2].slice(0, 4).toLowerCase()], +m[1]);
    }
    return "";
  }

  // ---- building the import rows ----------------------------------------------------------------------

  // rows: the sheet as arrays (header row included). Returns {items:[{rowNumber, row, problems:[{level,text}]}], ...}.
  // mapping: {fieldKey: columnIndex | -1}. headerIndex: index of the header row in `rows`.
  function buildRows(rows, mapping, headerIndex, opts) {
    const o = opts || {};
    const defaultUnit = o.defaultUnit || "L";
    const items = [];
    const seen = new Map();
    const get = (r, k) => (mapping[k] >= 0 ? r[mapping[k]] : undefined);
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (isEmptyRow(r)) continue;
      const rowNumber = i + 1; // as shown in Excel
      const problems = [];
      const out = {};
      out.product_name = text(get(r, "product_name"));
      out.supplier = text(get(r, "supplier"));
      out.location = text(get(r, "location"));
      out.place = out.location; // the importer treats this as a PLACE (a workshop, vehicle or site)
      const ptRaw = text(get(r, "place_type"));
      out.place_type = parsePlaceType(ptRaw);
      if (ptRaw && !out.place_type) problems.push({ level: "warn", text: "Place type \"" + ptRaw + "\" was not understood (use workshop, vehicle or site). It was left for the importer to decide." });
      out.use_description = text(get(r, "use_description"));
      const notes = [];
      if (text(get(r, "notes"))) notes.push(text(get(r, "notes")));

      const qv = get(r, "quantity");
      const q = parseQuantity(qv);
      const unitInf = mapping.unit >= 0 ? unitInfo(get(r, "unit")) : null;
      const unitCell = unitInf ? unitInf.unit : null;
      if (unitInf && !q.unit && q.amount != null && unitInf.factor !== 1) q.amount = round(q.amount * unitInf.factor);
      if (mapping.unit >= 0 && text(get(r, "unit")) && !unitCell) problems.push({ level: "warn", text: 'Unit "' + text(get(r, "unit")) + '" is not L or kg, so L was used.' });
      if (text(qv) !== "" && q.amount == null) problems.push({ level: "warn", text: 'Could not read the quantity "' + text(qv) + '". It was left blank.' });
      if (q.unknownUnit) problems.push({ level: "warn", text: 'Unit "' + q.unknownUnit + '" is not L or kg, so L was used.' });
      if (q.amount != null) {
        out.quantity = q.amount;
        out.unit = unitCell && !q.unit ? unitCell : q.unit || unitCell || defaultUnit;
        if (q.unit && unitCell && q.unit !== unitCell) out.unit = q.unit;
        if (q.note) out.container_note = q.note;
      }

      const un = text(get(r, "un_number"));
      out.un_number = parseUn(un);
      if (un && !out.un_number) problems.push({ level: "warn", text: 'UN number "' + un + '" does not look like four digits. It was left blank.' });
      const cls = text(get(r, "dg_class"));
      const c = parseClass(cls);
      out.dg_class = c.dg_class;
      if (c.subsidiary) out.subsidiary_class = c.subsidiary;
      if (cls && !c.dg_class) problems.push({ level: "warn", text: 'Class "' + cls + '" was not understood. It was left blank.' });
      const pg = text(get(r, "packing_group"));
      out.packing_group = parsePg(pg);
      if (pg && !out.packing_group) problems.push({ level: "warn", text: 'Packing group "' + pg + '" was not understood. It was left blank.' });
      out.hazchem_code = text(get(r, "hazchem_code")).toUpperCase().replace(/\s+/g, "");
      const dv = get(r, "sds_date");
      out.sds_date = parseDate(dv);
      if (text(dv) && !out.sds_date) problems.push({ level: "warn", text: 'SDS date "' + text(dv) + '" was not understood. It was left blank.' });
      const dec = text(get(r, "decision"));
      out.decision = parseDecision(dec);
      if (dec && !out.decision) {
        problems.push({ level: "warn", text: 'Decision "' + dec + '" was not understood (use hazardous or not hazardous). It was left undecided.' });
        notes.push(dec);
      }
      if (!dec && (out.un_number || out.dg_class)) {
        // A UN number or DG class means it is a dangerous good; leave the decision for the admin unless stated.
      }
      if (notes.length) out.decision_note = notes.join("; ");

      if (!out.product_name) problems.push({ level: "error", text: "No product name, so this row is skipped." });
      else {
        const key = out.product_name.toLowerCase() + "|" + out.supplier.toLowerCase();
        if (seen.has(key)) problems.push({ level: "warn", text: "Same product and supplier as row " + seen.get(key) + ". It is combined with that product: this row adds another storage location." });
        else seen.set(key, rowNumber);
      }
      // drop empty strings so the server sees only real values
      const clean = {};
      for (const [k, v] of Object.entries(out)) if (v !== "" && v != null) clean[k] = v;
      items.push({ rowNumber, row: clean, problems, skip: problems.some((p) => p.level === "error") });
    }
    return items;
  }

  function summarise(items) {
    const ok = items.filter((i) => !i.skip);
    return {
      total: items.length,
      importable: ok.length,
      skipped: items.length - ok.length,
      withWarnings: ok.filter((i) => i.problems.length).length,
    };
  }

  // Batches for the API so one request never gets too big.
  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  return {
    FIELDS, FIELD_KEYS, detectHeaderRow, guessMapping, headerScore, buildRows, summarise, chunk,
    parseQuantity, parseUnit, parsePlaceType, parseUn, parseClass, parsePg, parseDecision, parseDate,
  };
});
