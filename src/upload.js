// SDS EZY: the upload pipeline. POST /api/uploads/precheck and POST /api/uploads. See docs/AI.md.
// Guards are enforced here (PDF magic bytes, size cap, per-login rate limit, duplicate check).
// The multi-row write is ONE db.batch so a failure leaves nothing half-created; the R2 object is deleted if it fails.

import { json, loadSettings, todayIso } from "./lib.js";
import { getAiConfig, runExtraction, matchControlOptions, AI_DRAFT_LABEL } from "./ai.js";
import { refreshChemicalSummary } from "./register.js";
import { validatePlaceLink, linkChemicalToPlaceStatements } from "./places.js";
import { derive } from "../public/lib/ghs-ref.mjs";

function parseJsonList(v) { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }

const MAX_TEXT_CHARS = 150000;
const DEFAULT_MAX_MB = 15, HARD_MAX_MB = 25, DEFAULT_RATE = 10;
const MAX_FORM_EXTRA = 1024 * 1024; // text + answers allowance on top of the PDF in a request body
const HOUR_MS = 3600 * 1000;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function limitsFrom(settings) {
  return {
    max_mb: clamp(num(settings.upload_max_mb, DEFAULT_MAX_MB) || DEFAULT_MAX_MB, 1, HARD_MAX_MB),
    rate: clamp(Math.floor(num(settings.upload_rate_per_hour, DEFAULT_RATE)) || DEFAULT_RATE, 1, 1000),
  };
}
async function countRecent(env, userId) {
  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_log WHERE user_id = ? AND created_at > ?").bind(userId, since).first();
  return row ? row.n : 0;
}
async function sha256Hex(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
const err = (message, status, extra = {}) => json({ error: message, ...extra }, status);

// ---------------------------------------------------------------------------------------------
// Precheck

const GENERIC_LINE = /^(safety data sheet|sds|msds|material safety|section|page|revision|version|date|issued?|supplier|company|emergency)/i;

// Names that might be a registered product, read from the head of the document. Indexed equality lookups only.
export function candidateNames(head) {
  const text = String(head || "").slice(0, 4000);
  const out = [];
  const add = (s) => {
    s = String(s || "").replace(/\s+/g, " ").replace(/^[\s:\-\u2013.]+|[\s:\-\u2013.]+$/g, "");
    if (s.length >= 4 && s.length <= 100 && !out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  for (const m of text.matchAll(/product\s*(?:name|identifier|identification)\s*[:\-]?\s*([^\n\r]{3,100})/gi)) add(m[1]);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length >= 4);
  for (const l of lines.slice(0, 12)) {
    if (GENERIC_LINE.test(l)) continue;
    add(l);
    const words = l.split(/\s+/).slice(0, 12);
    for (let n = 2; n <= 5; n++) for (let i = 0; i + n <= words.length && out.length < 40; i++) add(words.slice(i, i + n).join(" "));
  }
  if (lines.length < 2) { // text without line breaks: windows over the first words
    const words = text.split(/\s+/).slice(0, 30);
    for (let n = 2; n <= 5; n++) for (let i = 0; i + n <= words.length && out.length < 40; i++) add(words.slice(i, i + n).join(" "));
  }
  return out.slice(0, 40);
}

export async function handlePrecheck(request, env, user) {
  let b;
  try { b = await request.json(); } catch { return err("Send the file details as JSON.", 400); }
  if (!b || typeof b !== "object") return err("Send the file details as JSON.", 400);
  const hash = String(b.file_hash || "").toLowerCase();
  if (hash && !/^[0-9a-f]{64}$/.test(hash)) return err("That file hash does not look right.", 400);
  const settings = await loadSettings(env);
  const lim = limitsFrom(settings);
  const used = await countRecent(env, user.id);
  const cfg = await getAiConfig(env, settings);

  let exact = null;
  if (hash) {
    const row = await env.DB.prepare("SELECT id, title, doc_key FROM sds WHERE file_hash = ? LIMIT 1").bind(hash).first();
    if (row) {
      const cur = await env.DB.prepare("SELECT id FROM sds WHERE doc_key = ? AND is_current = 1 LIMIT 1").bind(row.doc_key).first();
      const { results } = await env.DB.prepare("SELECT id FROM chemicals WHERE sds_id = ? LIMIT 200").bind(cur ? cur.id : row.id).all();
      exact = { sds_id: row.id, title: row.title, chemical_ids: results.map(r => r.id) };
    }
  }

  const candidates = [];
  if (!exact) {
    const names = candidateNames(b.text_head);
    if (names.length) {
      const batch = await env.DB.batch(names.map(n =>
        env.DB.prepare("SELECT id, product_name, sds_id FROM chemicals WHERE product_name = ? COLLATE NOCASE LIMIT 5").bind(n)));
      const bySds = new Map();
      batch.forEach((r, i) => { for (const c of r.results || []) if (c.sds_id) {
        const e = bySds.get(c.sds_id) || { chemical_ids: [], names: new Set() };
        if (!e.chemical_ids.includes(c.id)) e.chemical_ids.push(c.id);
        e.names.add(c.product_name); bySds.set(c.sds_id, e);
      } });
      for (const [sdsId, e] of [...bySds].slice(0, 10)) {
        const s = await env.DB.prepare("SELECT id, title, supplier, issue_date FROM sds WHERE id = ?").bind(sdsId).first();
        if (!s) continue;
        const { results } = await env.DB.prepare("SELECT id FROM chemicals WHERE sds_id = ? LIMIT 200").bind(sdsId).all();
        candidates.push({
          sds_id: s.id, title: s.title, supplier: s.supplier, issue_date: s.issue_date,
          chemical_ids: results.map(r => r.id),
          reason: `The name "${[...e.names][0]}" is on the first page and is already in the register.`,
        });
      }
    }
  }
  return json({
    ok: true, exact_duplicate: exact, candidates,
    limits: { max_mb: lim.max_mb, remaining_this_hour: Math.max(0, lim.rate - used) },
    ai: { configured: cfg.configured, provider: cfg.provider },
  });
}

// ---------------------------------------------------------------------------------------------
// Answers

const ENUMS = {
  aerosolised: ["no", "sometimes", "yes"],
  quantity_unit: ["L", "kg"],
  exposure: ["under_15_min", "15_to_60_min", "1_to_4_hours", "over_4_hours", "not_sure"],
  ventilation: ["outdoors", "good", "poor", "none_enclosed", "not_sure"],
};
export function cleanAnswers(raw) {
  let a = raw;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
  if (!a || typeof a !== "object" || Array.isArray(a)) a = {};
  const str = (v, max) => { const s = typeof v === "string" || typeof v === "number" ? String(v).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim() : ""; return s ? s.slice(0, max) : null; };
  const pick = (k) => (ENUMS[k].includes(a[k]) ? a[k] : null);
  let amount = Number(a.quantity_amount);
  amount = Number.isFinite(amount) && amount > 0 && amount < 1e9 ? amount : null;
  return {
    use_where_how: str(a.use_where_how, 1000), aerosolised: pick("aerosolised"),
    quantity_amount: amount, quantity_unit: amount ? (pick("quantity_unit") || "L") : null,
    quantity_note: str(a.quantity_note, 500), exposure: pick("exposure"), ventilation: pick("ventilation"),
  };
}

// ---------------------------------------------------------------------------------------------
// Name heuristics (used when there is no AI draft)

export function guessProductName(fileName, text) {
  const t = String(text || "").slice(0, 6000);
  const m = t.match(/product\s*(?:name|identifier|identification)\s*[:\-]?\s*([^\n\r]{3,100})/i);
  if (m) { const n = m[1].replace(/\s+/g, " ").trim(); if (n.length >= 3 && !/^(and|or|of|\d)/i.test(n)) return n.slice(0, 120); }
  const fromFile = String(fileName || "").replace(/\.pdf$/i, "").replace(/[_\-]+/g, " ")
    .replace(/\b(m?sds|safety data sheet|v\d+(\.\d+)?|rev\w*|final|copy)\b/gi, " ").replace(/\s+/g, " ").trim();
  if (fromFile.length >= 3) return fromFile.slice(0, 120);
  for (const l of t.split(/\r?\n/).map(x => x.trim())) if (l.length >= 4 && !GENERIC_LINE.test(l)) return l.slice(0, 120);
  return "Unnamed chemical (from upload)";
}

function cleanFileName(name) {
  const base = String(name || "document.pdf").split(/[\\/]/).pop().replace(/[\u0000-\u001f"<>|:*?]/g, "").trim();
  return (base || "document.pdf").slice(0, 200);
}

// ---------------------------------------------------------------------------------------------
// Upload

export async function handleUpload(request, env, user) {
  const settings = await loadSettings(env);
  const lim = limitsFrom(settings);
  const maxBytes = lim.max_mb * 1024 * 1024;

  // Rate limit: the log row goes in FIRST so failed and abusive attempts count too.
  const nowIso = new Date().toISOString();
  await env.DB.prepare("INSERT INTO upload_log (user_id, created_at) VALUES (?, ?)").bind(user.id, nowIso).run();
  const used = await countRecent(env, user.id);
  if (used > lim.rate) {
    return err(`You have reached the limit of ${lim.rate} uploads per hour. Try again later.`, 429);
  }
  env.DB.prepare("DELETE FROM upload_log WHERE user_id = ? AND created_at < ?").bind(user.id, new Date(Date.now() - 7 * 24 * HOUR_MS).toISOString()).run().catch(() => {});

  const cl = Number(request.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > maxBytes + MAX_FORM_EXTRA) return err(`That file is too large. The limit is ${lim.max_mb} MB.`, 413);

  let form;
  try { form = await request.formData(); } catch { return err("The upload could not be read. Send it as a form with a PDF file.", 400); }
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") return err("No PDF file was received.", 400);
  if (file.size > maxBytes) return err(`That file is too large. The limit is ${lim.max_mb} MB.`, 413);
  const fileName = cleanFileName(file.name);
  const declared = String(file.type || "").toLowerCase();
  if (!/\.pdf$/i.test(fileName) || (declared && !["application/pdf", "application/x-pdf", "application/octet-stream"].includes(declared))) {
    return err("Only PDF files can be uploaded.", 400);
  }
  const buf = await file.arrayBuffer();
  if (buf.byteLength > maxBytes) return err(`That file is too large. The limit is ${lim.max_mb} MB.`, 413);
  const u8 = new Uint8Array(buf);
  if (u8.length < 8 || u8[0] !== 0x25 || u8[1] !== 0x50 || u8[2] !== 0x44 || u8[3] !== 0x46 || u8[4] !== 0x2d) {
    return err("That file is not a PDF.", 400);
  }

  const hash = await sha256Hex(buf); // computed here; the client's hash is never trusted for storage
  const dup = await env.DB.prepare("SELECT id, title, doc_key FROM sds WHERE file_hash = ? LIMIT 1").bind(hash).first();
  if (dup) {
    const cur = await env.DB.prepare("SELECT id FROM sds WHERE doc_key = ? AND is_current = 1 LIMIT 1").bind(dup.doc_key).first();
    const { results } = await env.DB.prepare("SELECT id FROM chemicals WHERE sds_id = ? LIMIT 200").bind(cur ? cur.id : dup.id).all();
    return err("This exact file is already in the register.", 409, { exact_duplicate: true, sds_id: dup.id, title: dup.title, chemical_ids: results.map(r => r.id) });
  }

  let text = form.get("text");
  text = typeof text === "string" ? text.replace(/\u0000/g, "").slice(0, MAX_TEXT_CHARS) : "";
  const answers = cleanAnswers(form.get("answers"));
  let replaceId = null;
  const rawReplace = form.get("replace_sds_id");
  if (rawReplace !== null && rawReplace !== "") {
    replaceId = Number(rawReplace);
    if (!Number.isInteger(replaceId) || replaceId < 1) return err("replace_sds_id is not valid.", 400);
  }

  // Optional place the person is working from. Must exist and not be archived.
  let placeId = null;
  const rawPlace = form.get("place_id");
  if (rawPlace !== null && rawPlace !== "") {
    const n = Number(rawPlace);
    if (!Number.isInteger(n) || n < 1) return err("That place is not valid.", 400);
    try { placeId = (await validatePlaceLink(env, n)).id; }
    catch (e) { return err(e && e.status === 400 && e.message ? e.message : "That place cannot be used.", 400); }
  }

  // Optional: attach the sheet to an existing chemical without an SDS (the placeholder a found item in an audit creates).
  let forChem = null;
  const rawFor = form.get("for_chemical_id");
  if (rawFor !== null && rawFor !== "") {
    const n = Number(rawFor);
    if (!Number.isInteger(n) || n < 1) return err("for_chemical_id is not valid.", 400);
    if (replaceId) return err("Choose either a chemical to attach to or an SDS to replace, not both.", 400);
    forChem = await env.DB.prepare(
      "SELECT id, product_name, supplier, source, sds_id, ghs_classification, decision_override, pictograms_override FROM chemicals WHERE id = ?").bind(n).first();
    if (!forChem) return err("That chemical was not found.", 404);
    const allowed = forChem.sds_id == null && (user.role === "admin" || forChem.source === "audit");
    if (!allowed) {
      return err(user.role === "admin"
        ? "That chemical already has a safety data sheet. Use \"newer version\" instead."
        : "You can only add a sheet to an item found in an audit that has no sheet yet.", 403);
    }
  }

  // Store the PDF first; every later failure removes it again.
  const r2Key = `sds/${crypto.randomUUID()}.pdf`;
  await env.FILES.put(r2Key, buf, { httpMetadata: { contentType: "application/pdf" } });
  try {
    return await processUpload(env, user, { settings, buf, r2Key, hash, fileName, text, answers, replaceId, placeId, forChem });
  } catch (e) {
    try { await env.FILES.delete(r2Key); } catch { /* best effort */ }
    if (e && e.status && e.userMessage) return err(e.userMessage, e.status);
    return err("The upload could not be saved, and nothing was added. Please try again.", 500);
  }
}

class UserError extends Error { constructor(msg, status) { super(msg); this.userMessage = msg; this.status = status; } }

async function findTarget(env, replaceId, names, supplier) {
  const getCurrent = async (id) => {
    const row = await env.DB.prepare("SELECT id, doc_key, version_no, is_current FROM sds WHERE id = ?").bind(id).first();
    if (!row) return null;
    if (row.is_current) return row;
    return env.DB.prepare("SELECT id, doc_key, version_no, is_current FROM sds WHERE doc_key = ? AND is_current = 1 LIMIT 1").bind(row.doc_key).first();
  };
  if (replaceId) {
    const t = await getCurrent(replaceId);
    if (!t) throw new UserError("The sheet you chose to replace was not found.", 400);
    return t;
  }
  if (!names.length) return null;
  const rs = await env.DB.batch(names.map(n =>
    env.DB.prepare("SELECT sds_id, supplier FROM chemicals WHERE product_name = ? COLLATE NOCASE AND sds_id IS NOT NULL LIMIT 5").bind(n)));
  for (const r of rs) for (const c of r.results || []) {
    if (norm(c.supplier) === norm(supplier)) { const t = await getCurrent(c.sds_id); if (t) return t; }
  }
  return null;
}

async function processUpload(env, user, ctx) {
  const { settings, buf, r2Key, hash, fileName, text, answers, replaceId, placeId, forChem } = ctx;
  const db = env.DB;
  const today = todayIso();
  const { results: optRows } = await db.prepare("SELECT id, kind, label FROM control_options WHERE active = 1").all();
  const options = optRows || [];

  const ai = await runExtraction(env, { text, answers, optionLabels: options.map(o => o.label).slice(0, 60) });
  const cfg = await getAiConfig(env, settings);
  const warnings = [];
  let data = null, aiError = null, unverified = [];
  if (ai.ok) { data = ai.data; unverified = ai.unverified || []; warnings.push(...(ai.warnings || [])); }
  else aiError = ai.error;

  // Products: from the AI, or one guessed from the file name / text.
  const products = data ? data.products : [{ product_name: guessProductName(fileName, text), product_codes: null, synonyms: null, physical_form: null, use_description: null }];
  const sdsF = data ? data.sds : {};
  const supplier = sdsF.supplier || null;

  const target = forChem ? null : await findTarget(env, replaceId, products.map(p => p.product_name), supplier);
  let oldChems = [];
  if (target) {
    const { results } = await db.prepare("SELECT id, product_name, ghs_classification, decision_override, pictograms_override FROM chemicals WHERE sds_id = ? LIMIT 500").bind(target.id).all();
    oldChems = results || [];
  }
  const matched = new Map(); // product index -> existing chemical id
  products.forEach((p, i) => {
    const c = oldChems.find(c => norm(c.product_name) === norm(p.product_name) && ![...matched.values()].includes(c.id));
    if (c && data) matched.set(i, c.id);
  });
  if (forChem) matched.set(0, forChem.id); // product 0 is written onto the placeholder; no new chemical row for it

  let maxVersion = 0;
  if (target) {
    const row = await db.prepare("SELECT MAX(version_no) AS v FROM sds WHERE doc_key = ?").bind(target.doc_key).first();
    maxVersion = (row && row.v) || target.version_no || 1;
  }
  const docKey = target ? target.doc_key : crypto.randomUUID();
  const aiDraft = !!data;
  const sdsTitle = sdsF.title || products.map(p => p.product_name).join(", ").slice(0, 300);
  // The verified classification (null = none usable: the chemical stays unclassified and has no decision).
  const cls = data && data.classification ? data.classification : null;
  const der = cls ? derive(cls.list) : null;
  const eff = {
    classification: cls ? JSON.stringify(cls.list) : null,
    flags: cls && cls.flags.length ? JSON.stringify(cls.flags) : null,
    decision: der ? der.decision : null,
    signal_word: der ? der.signal_word : null,
    pictograms: der && der.pictograms.length ? der.pictograms.join(",") : null,
  };
  if (cls) warnings.push(...cls.flags);
  else if (data) warnings.push("No GHS classification could be read from the SDS, so the product has no hazardous decision yet.");
  const decisionAt = new Date().toISOString();
  const ref = { sql: "(SELECT id FROM sds WHERE r2_key = ?)", params: [r2Key] };
  const stm = [];
  const P = (sql, ...params) => stm.push(db.prepare(sql).bind(...params));

  if (target) P("UPDATE sds SET is_current = 0, replaced_at = ? WHERE doc_key = ? AND is_current = 1", decisionAt, docKey);
  P(`INSERT INTO sds (doc_key, version_no, is_current, title, supplier, r2_key, file_name, file_size, file_hash, issue_date, revision, emergency_phone,
       review_due, signal_word, hazard_classification, h_statements, p_statements, poison_schedule, un_number, dg_class, subsidiary_class, packing_group,
       hazchem_code, proper_shipping_name, cas_numbers, unverified, source, ai_provider, uploaded_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?)`,
    docKey, maxVersion + 1, sdsTitle || null, supplier, r2Key, fileName, buf.byteLength, hash,
    sdsF.issue_date || null, sdsF.revision || null, sdsF.emergency_phone || null, sdsF.review_due || null, sdsF.signal_word || null,
    sdsF.hazard_classification || null, sdsF.h_statements || null, sdsF.p_statements || null, sdsF.poison_schedule || null,
    sdsF.un_number || null, sdsF.dg_class || null, sdsF.subsidiary_class || null, sdsF.packing_group || null, sdsF.hazchem_code || null,
    sdsF.proper_shipping_name || null, (sdsF.cas_numbers || []).join(", ") || null,
    JSON.stringify(unverified), aiDraft ? cfg.provider : null, user.id);

  if (target) P(`UPDATE chemicals SET sds_id = ${ref.sql}, updated_at = datetime('now') WHERE sds_id = ?`, ...ref.params, target.id);

  // A new version replaces the classification of the chemicals that used the old sheet, unless an admin has edited a classification or
  // overridden the decision / pictograms on any of them. Then the existing values stay and a warning says so.
  if (target && eff.classification !== null) {
    const adminTouched = oldChems.some(c => c.decision_override || c.pictograms_override || parseJsonList(c.ghs_classification).some(e => e && e.src === "admin"));
    if (adminTouched) {
      warnings.push("The classification was not changed because an admin has edited it or overridden the decision or pictograms. Compare it with the new sheet.");
    } else {
      P(`UPDATE chemicals SET ghs_classification = ?, classification_flags = ?, decision = ?, decision_by = ?, decision_at = ?, signal_word = ?, pictograms = ?,
           updated_at = datetime('now') WHERE sds_id = ${ref.sql}`,
        eff.classification, eff.flags, eff.decision, eff.decision ? AI_DRAFT_LABEL : null, eff.decision ? decisionAt : null, eff.signal_word, eff.pictograms, ...ref.params);
    }
  }

  if (forChem) {
    const rename = !!data && forChem.source === "audit"; // still the typed placeholder name: take the name and supplier from the SDS
    const p0 = products[0];
    const adminClass = parseJsonList(forChem.ghs_classification).some(e => e && e.src === "admin");
    const setClass = eff.classification !== null && !adminClass;
    if (eff.classification !== null && adminClass) warnings.push("The classification was not changed because an admin has edited it. Compare it with the new sheet.");
    P(`UPDATE chemicals SET sds_id = ${ref.sql}, sds_issue_date = ?, review_due = ?, dg_class = ?, risk_level = ?,
         ${rename ? "product_name = ?, supplier = COALESCE(?, supplier), synonyms = COALESCE(synonyms, ?), product_codes = COALESCE(product_codes, ?)," : ""}
         use_description = COALESCE(use_description, ?), physical_form = COALESCE(physical_form, ?),
         ${setClass ? `ghs_classification = ?, classification_flags = ?, signal_word = ?,
           pictograms = CASE WHEN pictograms_override IS NULL THEN ? ELSE pictograms END,
           decision_by = CASE WHEN decision_override IS NULL THEN ? ELSE decision_by END,
           decision_at = CASE WHEN decision_override IS NULL THEN ? ELSE decision_at END,
           decision = CASE WHEN decision_override IS NULL THEN ? ELSE decision END,` : ""}
         updated_at = datetime('now') WHERE id = ?`,
      ...ref.params, sdsF.issue_date || null, sdsF.review_due || null, sdsF.dg_class || null, data ? data.assessment.risk_level : "uncertain",
      ...(rename ? [p0.product_name, supplier, p0.synonyms, p0.product_codes] : []),
      p0.use_description, p0.physical_form || (data && data.assessment.form) || null,
      ...(setClass ? [eff.classification, eff.flags, eff.signal_word, eff.pictograms, eff.decision ? AI_DRAFT_LABEL : null, eff.decision ? decisionAt : null, eff.decision] : []),
      forChem.id);
  }

  const chemRef = (i) => matched.has(i)
    ? { sql: "?", params: [matched.get(i)] }
    : { sql: `(SELECT id FROM chemicals WHERE sds_id = ${ref.sql} AND product_name = ? COLLATE NOCASE ORDER BY id LIMIT 1)`, params: [...ref.params, products[i].product_name] };

  const risk = data ? data.assessment.risk_level : "uncertain";
  const casText = (sdsF.cas_numbers || []).join(" ");
  const newIdx = [];
  products.forEach((p, i) => {
    if (matched.has(i)) return;
    if (target && !data) return; // replacing without a draft: existing chemicals are simply re-pointed
    newIdx.push(i);
    const search = [p.product_name, supplier, p.synonyms, p.product_codes, casText].filter(Boolean).join(" ").toLowerCase();
    // Effective decision / signal word / pictograms are DERIVED from the verified classification (never from what the AI said).
    P(`INSERT INTO chemicals (product_name, supplier, synonyms, product_codes, use_description, physical_form, ghs_classification, classification_flags,
         decision, decision_by, decision_at, sds_id, sds_issue_date, review_due, risk_level, dg_class, signal_word, pictograms, source, search_text, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${ref.sql}, ?, ?, ?, ?, ?, ?, 'upload', ?, ?)`,
      p.product_name, supplier, p.synonyms, p.product_codes, p.use_description, p.physical_form || (data && data.assessment.form) || null,
      eff.classification, eff.flags, eff.decision, eff.decision ? AI_DRAFT_LABEL : null, eff.decision ? decisionAt : null,
      ...ref.params, sdsF.issue_date || null, sdsF.review_due || null, risk, sdsF.dg_class || null, eff.signal_word, eff.pictograms, search, user.id);
    if (placeId && i === newIdx[0]) { // must directly follow the chemical INSERT ("last")
      const qty = answers.quantity_amount || undefined;
      stm.push(...linkChemicalToPlaceStatements(env, {
        chemicalId: "last", placeId, quantity: qty, unit: qty ? (answers.quantity_unit || "L") : undefined,
        containerNote: answers.quantity_note ? answers.quantity_note.slice(0, 300) : undefined,
      }));
    }
  });

  // Assessments: AI draft for every product; or one blank one for the new chemical when there is no draft.
  const answersJson = JSON.stringify(answers);
  const unverifiedJson = JSON.stringify(unverified);
  const useText = answers.use_where_how || (data && data.assessment.use_description) || null;
  if (data) {
    const matchedControls = matchControlOptions(data.assessment, options);
    const a = data.assessment;
    products.forEach((p, i) => {
      const c = chemRef(i);
      if (matched.has(i)) P("UPDATE assessments SET is_current = 0 WHERE chemical_id = ? AND is_current = 1", matched.get(i));
      P(`INSERT INTO assessments (chemical_id, sds_id, is_current, assessed_date, sds_date, form, use_description, route_inhalation, route_ingestion, route_absorption,
           fire_response, spill_response, controls_notes, ppe_notes, risk_level, monitoring_needed, monitoring_note, surveillance_needed, surveillance_note,
           assessed_by, source, answers, unverified, created_by)
         VALUES (${c.sql}, ${ref.sql}, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?)`,
        ...c.params, ...ref.params, today, sdsF.issue_date || null, p.physical_form || a.form, useText,
        a.route_inhalation ? 1 : 0, a.route_ingestion ? 1 : 0, a.route_absorption ? 1 : 0, a.fire_response, a.spill_response,
        matchedControls.controls_notes, matchedControls.ppe_notes, a.risk_level,
        a.monitoring_needed === null ? null : a.monitoring_needed ? 1 : 0, a.monitoring_note,
        a.surveillance_needed === null ? null : a.surveillance_needed ? 1 : 0, a.surveillance_note,
        AI_DRAFT_LABEL, answersJson, unverifiedJson, user.id);
      for (const oid of matchedControls.option_ids) {
        P(`INSERT OR IGNORE INTO assessment_controls (assessment_id, option_id)
           SELECT a.id, ? FROM assessments a WHERE a.chemical_id = ${c.sql} AND a.is_current = 1 ORDER BY a.id DESC LIMIT 1`, oid, ...c.params);
      }
    });
  } else if (!target && !(forChem && (await db.prepare("SELECT id FROM assessments WHERE chemical_id = ? AND is_current = 1 LIMIT 1").bind(forChem.id).first()))) {
    const c = chemRef(0);
    P(`INSERT INTO assessments (chemical_id, sds_id, is_current, assessed_date, risk_level, assessed_by, source, answers, unverified, use_description, created_by)
       VALUES (${c.sql}, ${ref.sql}, 1, ?, 'uncertain', ?, 'blank', ?, ?, ?, ?)`,
      ...c.params, ...ref.params, today, user.name || null, answersJson, unverifiedJson, answers.use_where_how, user.id);
  }

  // Place link (never storage_locations). The first NEW chemical was linked above, with the optional quantity (first product only, so it is not counted twice).
  // A new version also links the existing chemicals that are not linked to this place yet (never a duplicate).
  if (placeId) {
    if (forChem) {
      const have = await db.prepare("SELECT id FROM chemical_places WHERE chemical_id = ? AND place_id = ?").bind(forChem.id, placeId).first();
      if (!have) stm.push(...linkChemicalToPlaceStatements(env, { chemicalId: forChem.id, placeId }));
    }
    if (target && oldChems.length) {
      const { results: have } = await db.prepare("SELECT chemical_id FROM chemical_places WHERE place_id = ? LIMIT 5000").bind(placeId).all();
      const linked = new Set((have || []).map(r => r.chemical_id));
      for (const c of oldChems) if (!linked.has(c.id)) stm.push(...linkChemicalToPlaceStatements(env, { chemicalId: c.id, placeId }));
    }
    if (answers.quantity_amount && newIdx.length > 1) warnings.push("The quantity was recorded against the first product only. Adjust it on the place page if needed.");
    else if (answers.quantity_amount && !newIdx.length) warnings.push("The quantity was not recorded because no new product was created. Add it on the place page if needed.");
  } else if (answers.quantity_amount) {
    warnings.push("No place was chosen, so the quantity was not recorded.");
  }

  await db.batch(stm); // all or nothing

  const sdsRow = await db.prepare("SELECT id FROM sds WHERE r2_key = ?").bind(r2Key).first();
  const sdsId = sdsRow.id;
  try { await refreshChemicalSummary(env, { sdsId }); } catch { warnings.push("The register summary will update the next time the chemical is saved."); }

  const { results: chems } = await db.prepare("SELECT id FROM chemicals WHERE sds_id = ? ORDER BY id LIMIT 500").bind(sdsId).all();
  const { results: asses } = await db.prepare("SELECT id FROM assessments WHERE sds_id = ? AND is_current = 1 ORDER BY id LIMIT 500").bind(sdsId).all();
  if (target && !data) warnings.push("The earlier assessments were kept as they are. Review them against the new sheet.");

  const out = {
    ok: true, mode: target ? "new_version" : data ? "ai" : "draft_only",
    chemical_ids: chems.map(r => r.id), sds_id: sdsId, assessment_ids: asses.map(r => r.id), unverified, warnings,
  };
  if (aiError) out.ai_error = aiError;
  if (forChem) out.attached_to = forChem.id;
  return json(out);
}
