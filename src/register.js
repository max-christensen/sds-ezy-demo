// The register: review list, chemicals (list/search/get/create/update/delete), history, storage locations,
// manifest, export bundle, control/PPE options, plus the shared validation helpers and summary-column upkeep.
//
// EXPORTS OTHER MODULES RELY ON (signatures are stable):
//   ApiError(status, message)           throw it anywhere; index.js turns it into {error} with that status
//   bad(message)                        shorthand for new ApiError(400, message)
//   readJson(request)                   parsed JSON object body, or throws 400
//   cleanStr(v, max, label, {required}) trimmed string or null, throws 400 when too long / missing
//   cleanEnum(v, list, label)           value or null, throws 400 when not in list
//   cleanDate(v, label)                 YYYY-MM-DD or null, throws 400 when invalid
//   cleanId(v, label)                   positive integer, throws 400
//   isValidDate(s)
//   PICTOGRAMS, RISK_LEVELS, PHYSICAL_FORMS, DECISIONS, OPTION_KINDS, SOURCES   (vocabulary arrays)
//   reviewStatus(review_due, sdsId, today)  -> 'overdue' | 'due_soon' | 'ok' | 'no_sds' | 'unknown'
//   buildSearchText(chemical, sds)          -> lower-cased search string (same format the SQL upkeep produces)
//   summaryStatements(env, {chemicalId} | {sdsId})  -> array of prepared statements (for db.batch)
//   refreshChemicalSummary(env, {chemicalId} | {sdsId})  copies sds_id-derived fields + current risk_level onto
//        chemicals and rebuilds search_text. {sdsId} updates every chemical pointing at that SDS in ONE UPDATE...FROM.
//   classificationStatements(env, chemicalId | "last", classification, {flags, overrides:{decision, pictograms}, decisionBy})
//        -> array of prepared statements (put them in a db.batch). Stores ghs_classification (JSON or NULL = not classified,
//        [] = classified, carries none), classification_flags, decision_override, pictograms_override and the EFFECTIVE decision,
//        signal_word and pictograms (computed with effective() from public/lib/ghs-ref.mjs). decision_by/decision_at change only
//        when the effective decision changes. Omitted flags -> NULL; omitted overrides -> cleared.
//   applyClassification(env, chemicalId, classification, {flags, decisionBy, overrides})
//        reads the chemical's current values for anything you leave undefined, then runs classificationStatements.
//   cleanOverrides(b), cleanClassificationInput(v, {strict})   validation helpers for request bodies
//   createChemical(env, fields, userId) -> id   (fields.place = {place_id, quantity, unit, container_note, spill_compound} also links it to a place)
//        fields: product_name (required), supplier, synonyms, product_codes, use_description, physical_form, decision,
//        decision_note, decision_by, sds_id (must be a current SDS), source ('upload'|'manual'|'import'|'demo'),
//        ghs_classification (array or null), classification_flags (array), decision_override, pictograms_override.
//        A plain `decision` is ignored: decision, signal_word and pictograms are DERIVED from the classification.
//        Refreshes the summary columns itself.
//   createAssessment(env, chemicalId, fields, controlOptionIds, userId) -> id
//        fields: assessed_date, sds_date, form, use_description, route_inhalation/ingestion/absorption, fire_response,
//        spill_response, controls_notes, ppe_notes, risk_level, monitoring_needed, monitoring_note, surveillance_needed,
//        surveillance_note, assessed_by, source ('manual'|'ai'|'import'|'demo'|'blank'), answers (object or JSON string),
//        unverified (array of field names), sds_id (defaults to the chemical's current SDS).
//        Makes the new assessment current (previous current -> is_current 0), stores controls, refreshes the summary.
//   cleanAssessment(fields, {create, allowMeta})  validation used by createAssessment and assessments.js

import { json, loadSettings, todayIso, daysBetweenIso } from "./lib.js";
import { linkChemicalToPlaceStatements, validatePlaceLink } from "./places.js";
import { auditExportData } from "./audits.js";
import {
  effective, normaliseClassification, parsePictogramList, PICTOGRAM_CODES, computePlaceTotals,
} from "../public/lib/ghs-ref.mjs";
import { deleteSdsDocument } from "./sds.js";
import { deleteLabelPhotos } from "./label-photo.js";

// ---------------------------------------------------------------- vocabulary

export const PICTOGRAMS = PICTOGRAM_CODES; // GHS01..GHS09
export const RISK_LEVELS = ["not_significant", "significant_controlled", "significant_not_controlled", "uncertain"];
export const PHYSICAL_FORMS = ["liquid", "solid", "powder", "gas", "aerosol", "paste", "other"];
export const DECISIONS = ["hazardous", "not_hazardous"];
export const OPTION_KINDS = ["isolation", "ventilation", "other", "ppe", "additional_ppe"];
export const SOURCES = ["upload", "manual", "import", "demo", "audit"];
export const ASSESSMENT_SOURCES = ["ai", "manual", "import", "demo", "blank"];
export const UNITS = ["L", "kg"];

// ---------------------------------------------------------------- errors and validation

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (message) => new ApiError(400, message);

export async function readJson(request, maxBytes = 2_000_000) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > maxBytes) throw new ApiError(413, "Request is too large");
  let text;
  try { text = await request.text(); } catch { throw bad("Could not read the request"); }
  if (text.length > maxBytes) throw new ApiError(413, "Request is too large");
  let body;
  try { body = JSON.parse(text || "{}"); } catch { throw bad("The request was not valid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Expected a JSON object");
  return body;
}

export function cleanStr(v, max, label, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${label} is required`);
    return null;
  }
  if (typeof v !== "string" && typeof v !== "number") throw bad(`${label} must be text`);
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!s) {
    if (required) throw bad(`${label} is required`);
    return null;
  }
  if (s.length > max) throw bad(`${label} is too long (max ${max} characters)`);
  return s;
}

export function cleanEnum(v, list, label) {
  if (v === undefined || v === null || v === "") return null;
  if (!list.includes(v)) throw bad(`${label} must be one of: ${list.join(", ")}`);
  return v;
}

export function isValidDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function cleanDate(v, label) {
  if (v === undefined || v === null || v === "") return null;
  if (!isValidDate(v)) throw bad(`${label} must be a date like 2026-10-19`);
  const y = Number(v.slice(0, 4));
  if (y < 1950 || y > 2200) throw bad(`${label} is out of range`);
  return v;
}

export function cleanId(v, label) {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw bad(`${label} is not valid`);
  return n;
}

function cleanBool01(v, label, { nullable = false } = {}) {
  if (v === undefined) return undefined;
  if (v === null || v === "") {
    if (nullable) return null;
    return 0;
  }
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  throw bad(`${label} must be yes or no`);
}

function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------- review status, search text

export function reviewStatus(reviewDue, sdsId, today) {
  if (!sdsId) return "no_sds";
  if (!reviewDue) return "unknown";
  if (reviewDue < today) return "overdue";
  if (daysBetweenIso(today, reviewDue) <= 90) return "due_soon";
  return "ok";
}

export function buildSearchText(chemical, sds) {
  return [chemical && chemical.product_name, chemical && chemical.supplier, chemical && chemical.synonyms,
    chemical && chemical.product_codes, sds && sds.cas_numbers]
    .filter(Boolean).join(" ").toLowerCase();
}

// ---------------------------------------------------------------- summary columns upkeep

const RISK_SUB = `(SELECT a.risk_level FROM assessments a WHERE a.chemical_id = chemicals.id AND a.is_current = 1 ORDER BY a.id DESC LIMIT 1)`;
const searchExpr = (cas) =>
  `lower(trim(coalesce(chemicals.product_name,'') || ' ' || coalesce(chemicals.supplier,'') || ' ' || coalesce(chemicals.synonyms,'') || ' ' || coalesce(chemicals.product_codes,'') || ' ' || coalesce(${cas},'')))`;

// Statements that bring the summary columns in step. Run them in a db.batch together with the change that needs them.
// scope: {chemicalId} (a number, or the string "last" for the row just inserted in the same batch) or {sdsId}.
export function summaryStatements(env, scope) {
  const db = env.DB;
  if (scope.sdsId !== undefined) {
    return [db.prepare(
      `UPDATE chemicals SET sds_issue_date = s.issue_date, review_due = s.review_due, dg_class = s.dg_class,
         risk_level = ${RISK_SUB},
         search_text = ${searchExpr("s.cas_numbers")}, updated_at = datetime('now')
       FROM sds s WHERE s.id = ? AND chemicals.sds_id = s.id`
    ).bind(scope.sdsId)];
  }
  const where = scope.chemicalId === "last" ? "chemicals.id = last_insert_rowid()" : "chemicals.id = ?";
  const args = scope.chemicalId === "last" ? [] : [scope.chemicalId];
  return [
    // has an SDS
    db.prepare(
      `UPDATE chemicals SET sds_issue_date = s.issue_date, review_due = s.review_due, dg_class = s.dg_class,
         risk_level = ${RISK_SUB},
         search_text = ${searchExpr("s.cas_numbers")}, updated_at = datetime('now')
       FROM sds s WHERE ${where} AND s.id = chemicals.sds_id`
    ).bind(...args),
    // no SDS
    db.prepare(
      `UPDATE chemicals SET sds_issue_date = NULL, review_due = NULL, dg_class = NULL,
         risk_level = ${RISK_SUB}, search_text = ${searchExpr("NULL")}, updated_at = datetime('now')
       WHERE ${where} AND sds_id IS NULL`
    ).bind(...args),
  ];
}

export async function refreshChemicalSummary(env, scope) {
  if (!scope || (scope.chemicalId === undefined && scope.sdsId === undefined)) throw new Error("refreshChemicalSummary needs chemicalId or sdsId");
  await env.DB.batch(summaryStatements(env, scope));
}

// ---------------------------------------------------------------- chemical field validation

const CHEM_TEXT = {
  product_name: [200, "Product name"],
  supplier: [200, "Supplier"],
  synonyms: [1000, "Other names"],
  product_codes: [500, "Product codes"],
  use_description: [2000, "Use description"],
  decision_note: [1000, "Decision note"],
};

export function cleanChemical(b, { create = false } = {}) {
  const out = {};
  for (const [k, [max, label]] of Object.entries(CHEM_TEXT)) {
    if (b[k] !== undefined) out[k] = cleanStr(b[k], max, label, { required: k === "product_name" });
    else if (create && k === "product_name") throw bad("Product name is required");
  }
  if (b.physical_form !== undefined) out.physical_form = cleanEnum(b.physical_form, PHYSICAL_FORMS, "Physical form");
  return out;
}

// ---------------------------------------------------------------- GHS classification, overrides, effective columns

// Pictogram override input -> stored text: null (no override) | "none" | "GHS02,GHS07".
export function cleanPictogramOverride(v) {
  if (v === undefined || v === null || v === "") return null;
  const arr = Array.isArray(v) ? v : String(v).split(",").map(x => x.trim()).filter(Boolean);
  if (arr.length === 0) return "none";
  if (arr.length === 1 && String(arr[0]).toLowerCase() === "none") return "none";
  for (const x of arr) if (!PICTOGRAM_CODES.includes(String(x).toUpperCase())) throw bad(`"${x}" is not a GHS pictogram code (GHS01 to GHS09)`);
  const list = parsePictogramList(arr);
  return list.join(",");
}

// Reads decision_override / pictograms_override (and the classification) out of a request body or helper fields.
// Returns only the keys that were present: {ghs_classification?, decision_override?, pictograms_override?}.
export function cleanOverrides(b) {
  const out = {};
  if (b.decision_override !== undefined) out.decision_override = cleanEnum(b.decision_override, DECISIONS, "Decision override");
  if (b.pictograms_override !== undefined) out.pictograms_override = cleanPictogramOverride(b.pictograms_override);
  return out;
}

// v: array | null. strict (HTTP): invalid entries are a 400. Not strict (upload pipeline): dropped.
export function cleanClassificationInput(v, { strict = true } = {}) {
  if (v === null) return null;
  if (!Array.isArray(v)) throw bad("ghs_classification must be a list, or null for not classified");
  const { list, dropped } = normaliseClassification(v);
  if (strict && dropped.length) throw bad(`Not a valid GHS class and category: ${dropped.slice(0, 3).join(", ")}`);
  return list;
}

export function parseJson(text, dflt) {
  if (!text) return dflt;
  try { return JSON.parse(text); } catch { return dflt; }
}

export function overrideTextToValue(t) { return t === "none" ? [] : t ? t.split(",") : null; }

function chemWhere(id) { return id === "last" ? ["id = last_insert_rowid()", []] : ["id = ?", [id]]; }

export function classificationStatements(env, chemicalId, classification, opts = {}) {
  const ov = opts.overrides || {};
  const decOv = ov.decision === "hazardous" || ov.decision === "not_hazardous" ? ov.decision : null;
  const picOv = typeof ov.pictograms === "string" || ov.pictograms == null ? ov.pictograms ?? null : cleanPictogramOverride(ov.pictograms);
  const cls = classification == null ? null : classification;
  const eff = effective(cls, { decision: decOv, pictograms: overrideTextToValue(picOv) });
  const flags = Array.isArray(opts.flags) && opts.flags.length ? JSON.stringify(opts.flags.slice(0, 40).map(x => String(x).slice(0, 400))) : null;
  const [where, args] = chemWhere(chemicalId);
  const by = eff.decision ? (opts.decisionBy ?? null) : null;
  const at = eff.decision ? new Date().toISOString() : null;
  return [env.DB.prepare(
    `UPDATE chemicals SET ghs_classification = ?, classification_flags = ?, decision_override = ?, pictograms_override = ?,
       signal_word = ?, pictograms = ?,
       decision_by = CASE WHEN decision IS ? THEN decision_by ELSE ? END,
       decision_at = CASE WHEN decision IS ? THEN decision_at ELSE ? END,
       decision = ?, updated_at = datetime('now')
     WHERE ${where}`
  ).bind(cls === null ? null : JSON.stringify(cls), flags, decOv, picOv, eff.signal_word, eff.pictograms.length ? eff.pictograms.join(",") : null,
    eff.decision, by, eff.decision, at, eff.decision, ...args)];
}

export async function applyClassification(env, chemicalId, classification, opts = {}) {
  const row = await env.DB.prepare(
    "SELECT ghs_classification, classification_flags, decision_override, pictograms_override FROM chemicals WHERE id = ?"
  ).bind(chemicalId).first();
  if (!row) throw new ApiError(404, "Chemical not found");
  const cls = classification === undefined ? parseJson(row.ghs_classification, null) : classification;
  const flags = opts.flags !== undefined ? opts.flags : (classification === undefined ? parseJson(row.classification_flags, []) : []);
  const overrides = opts.overrides || {
    decision: row.decision_override, pictograms: row.pictograms_override,
  };
  await env.DB.batch(classificationStatements(env, chemicalId, cls, { flags, overrides, decisionBy: opts.decisionBy }));
}

async function userNameById(env, userId) {
  if (!userId) return null;
  const u = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first();
  return u ? u.name : null;
}

// The statements createChemical runs, for callers that need to add their own statements to the same batch.
// The chemical INSERT is statement 0 (its id is res[0].meta.last_row_id); later statements may use (SELECT MAX(id) FROM chemicals).
export async function chemicalCreateStatements(env, fields, userId) {
  const f = cleanChemical(fields || {}, { create: true });
  let sdsId = null;
  if (fields.sds_id !== undefined && fields.sds_id !== null && fields.sds_id !== "") {
    sdsId = cleanId(fields.sds_id, "SDS");
    const s = await env.DB.prepare("SELECT id, is_current FROM sds WHERE id = ?").bind(sdsId).first();
    if (!s) throw bad("That SDS does not exist");
    if (!s.is_current) throw bad("That SDS version is no longer the current one");
  }
  const source = SOURCES.includes(fields.source) ? fields.source : "manual";
  const ov = cleanOverrides(fields);
  const cls = fields.ghs_classification === undefined ? null : cleanClassificationInput(fields.ghs_classification, { strict: false });
  const decisionBy = fields.decision_by ? cleanStr(fields.decision_by, 200, "Decision by") : await userNameById(env, userId);
  const stmts = [env.DB.prepare(
    `INSERT INTO chemicals (product_name, supplier, synonyms, product_codes, use_description, physical_form,
       decision_note, sds_id, source, search_text, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(f.product_name, f.supplier ?? null, f.synonyms ?? null, f.product_codes ?? null, f.use_description ?? null,
    f.physical_form ?? null, f.decision_note ?? null, sdsId, source, buildSearchText(f, null), userId || null)];
  stmts.push(...classificationStatements(env, "last", cls, {
    flags: Array.isArray(fields.classification_flags) ? fields.classification_flags : [],
    overrides: { decision: ov.decision_override ?? null, pictograms: ov.pictograms_override ?? null }, decisionBy,
  }));
  if (sdsId) stmts.push(...summaryStatements(env, { chemicalId: "last" }));
  // Optional first place: fields.place = {place_id, quantity, unit, container_note, spill_compound} (must come last: uses last_insert_rowid).
  if (fields.place && fields.place.place_id) {
    await validatePlaceLink(env, fields.place.place_id);
    stmts.push(...linkChemicalToPlaceStatements(env, {
      chemicalId: "last", placeId: fields.place.place_id, quantity: fields.place.quantity, unit: fields.place.unit,
      containerNote: fields.place.container_note, spillCompound: fields.place.spill_compound,
    }));
  }
  return stmts;
}

export async function createChemical(env, fields, userId) {
  const res = await env.DB.batch(await chemicalCreateStatements(env, fields, userId));
  return res[0].meta.last_row_id;
}

// ---------------------------------------------------------------- assessments (shared by assessments.js and the upload pipeline)

const ASSESS_TEXT = {
  use_description: [2000, "Use description"],
  fire_response: [2000, "Fire response"],
  spill_response: [2000, "Spill response"],
  controls_notes: [2000, "Controls notes"],
  ppe_notes: [2000, "PPE notes"],
  monitoring_note: [1000, "Monitoring note"],
  surveillance_note: [1000, "Surveillance note"],
  assessed_by: [200, "Assessed by"],
};

// allowMeta: lets the upload pipeline set source/answers/unverified/sds_id (never accepted from HTTP bodies).
export function cleanAssessment(b, { create = false, allowMeta = false } = {}) {
  const out = {};
  for (const [k, [max, label]] of Object.entries(ASSESS_TEXT)) {
    if (b[k] !== undefined) out[k] = cleanStr(b[k], max, label);
  }
  if (b.assessed_date !== undefined) out.assessed_date = cleanDate(b.assessed_date, "Assessment date");
  if (b.sds_date !== undefined) out.sds_date = cleanDate(b.sds_date, "SDS date");
  if (b.form !== undefined) out.form = cleanEnum(b.form, PHYSICAL_FORMS, "Form");
  for (const k of ["route_inhalation", "route_ingestion", "route_absorption"]) {
    if (b[k] !== undefined) out[k] = cleanBool01(b[k], k);
  }
  if (b.risk_level !== undefined) out.risk_level = cleanEnum(b.risk_level, RISK_LEVELS, "Risk level") || "uncertain";
  else if (create) out.risk_level = "uncertain";
  for (const k of ["monitoring_needed", "surveillance_needed"]) {
    if (b[k] !== undefined) out[k] = cleanBool01(b[k], k, { nullable: true });
  }
  if (allowMeta) {
    if (b.source !== undefined) out.source = ASSESSMENT_SOURCES.includes(b.source) ? b.source : "manual";
    if (b.answers !== undefined && b.answers !== null) {
      const s = typeof b.answers === "string" ? b.answers : JSON.stringify(b.answers);
      out.answers = s.slice(0, 8000);
    }
    if (b.unverified !== undefined && b.unverified !== null) {
      const arr = Array.isArray(b.unverified) ? b.unverified.filter(x => typeof x === "string").slice(0, 60) : [];
      out.unverified = JSON.stringify(arr);
    }
    if (b.sds_id !== undefined && b.sds_id !== null) out.sds_id = cleanId(b.sds_id, "SDS");
  }
  return out;
}

export function cleanOptionIds(ids) {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids)) throw bad("control_option_ids must be a list");
  if (ids.length > 80) throw bad("Too many controls selected");
  return [...new Set(ids.map(x => cleanId(x, "Control option")))];
}

export async function assertOptionsExist(env, ids) {
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT id FROM control_options WHERE id IN (${marks})`).bind(...ids).all();
  if (results.length !== ids.length) throw bad("One of the selected controls does not exist");
}

const ASSESS_COLS = ["assessed_date", "sds_date", "form", "use_description", "route_inhalation", "route_ingestion",
  "route_absorption", "fire_response", "spill_response", "controls_notes", "ppe_notes", "risk_level", "monitoring_needed",
  "monitoring_note", "surveillance_needed", "surveillance_note", "assessed_by", "source", "answers", "unverified", "sds_id"];

export async function createAssessment(env, chemicalId, fields, controlOptionIds, userId) {
  const f = cleanAssessment(fields || {}, { create: true, allowMeta: true });
  const ids = cleanOptionIds(controlOptionIds) || [];
  const chem = await env.DB.prepare(
    "SELECT c.id, c.sds_id, s.issue_date FROM chemicals c LEFT JOIN sds s ON s.id = c.sds_id WHERE c.id = ?"
  ).bind(chemicalId).first();
  if (!chem) throw new ApiError(404, "Chemical not found");
  await assertOptionsExist(env, ids);
  if (f.assessed_date === undefined || f.assessed_date === null) f.assessed_date = todayIso();
  if (f.sds_date === undefined) f.sds_date = chem.issue_date || null;
  if (f.sds_id === undefined) f.sds_id = chem.sds_id || null;
  if (f.assessed_by === undefined || f.assessed_by === null) f.assessed_by = await userNameById(env, userId);
  if (f.source === undefined) f.source = "manual";
  const defaults = { route_inhalation: 0, route_ingestion: 0, route_absorption: 0 };
  const vals = ASSESS_COLS.map(c => (f[c] !== undefined ? f[c] : (defaults[c] ?? null)));
  const stmts = [
    env.DB.prepare("UPDATE assessments SET is_current = 0 WHERE chemical_id = ? AND is_current = 1").bind(chemicalId),
    env.DB.prepare(
      `INSERT INTO assessments (chemical_id, is_current, ${ASSESS_COLS.join(", ")}, created_by) VALUES (?, 1, ${ASSESS_COLS.map(() => "?").join(", ")}, ?)`
    ).bind(chemicalId, ...vals, userId || null),
  ];
  if (ids.length) {
    // The new row is the newest assessment of this chemical; the batch runs as one transaction.
    stmts.push(env.DB.prepare(
      `INSERT INTO assessment_controls (assessment_id, option_id)
       SELECT (SELECT MAX(id) FROM assessments WHERE chemical_id = ?), id FROM control_options WHERE id IN (${ids.map(() => "?").join(",")})`
    ).bind(chemicalId, ...ids));
  }
  stmts.push(...summaryStatements(env, { chemicalId }));
  const res = await env.DB.batch(stmts);
  return res[1].meta.last_row_id;
}

// ---------------------------------------------------------------- handlers: review

export const CHEM_PUBLIC_COLS = `id, product_name, supplier, synonyms, product_codes, use_description, physical_form, decision, decision_note,
  decision_by, decision_at, ghs_classification, classification_flags, decision_override, pictograms_override,
  sds_id, sds_issue_date, review_due, risk_level, dg_class, signal_word, pictograms, source,
  created_by, created_at, updated_at`;

export async function handleReview(c) {
  const { env } = c;
  const today = todayIso();
  const soonLimit = addDaysIso(today, 90);
  const cols = "id, product_name, supplier, sds_id, review_due";
  const CAP = 200;
  const res = await env.DB.batch([
    env.DB.prepare(`SELECT ${cols} FROM chemicals WHERE review_due < ? ORDER BY review_due LIMIT ${CAP}`).bind(today),
    env.DB.prepare(`SELECT ${cols} FROM chemicals WHERE review_due >= ? AND review_due <= ? ORDER BY review_due LIMIT ${CAP}`).bind(today, soonLimit),
    env.DB.prepare(`SELECT ${cols} FROM chemicals WHERE sds_id IS NULL LIMIT ${CAP}`),
    env.DB.prepare(`SELECT ${cols} FROM chemicals WHERE decision IS NULL LIMIT ${CAP}`),
    // Active places that hold chemicals and were never audited, or not within audit_reminder_days (default 90).
    env.DB.prepare(
      `SELECT p.id AS place_id, p.name, p.place_type, p.registration, a.last_audited_at
       FROM places p LEFT JOIN place_audit_summary a ON a.place_id = p.id
       WHERE p.archived = 0 AND p.chemical_count > 0 AND (a.last_audited_at IS NULL OR substr(a.last_audited_at, 1, 10) < date('now', '-' || coalesce((SELECT value FROM settings WHERE key = 'audit_reminder_days'), '90') || ' days'))
       ORDER BY a.last_audited_at IS NOT NULL, a.last_audited_at, p.name COLLATE NOCASE LIMIT ${CAP}`
    ),
    ...(c.user && c.user.role === "admin" ? [
      env.DB.prepare("SELECT COUNT(*) AS n FROM audit_findings WHERE status = 'open'"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM audit_disposals WHERE status = 'to_dispose'"),
    ] : []),
  ]);
  const names = ["overdue", "due_soon", "no_sds", "no_decision"];
  const lists = res.slice(0, 4).map(r => r.results);
  const notAudited = res[4].results;
  // A count is only a separate query when a list hit its cap.
  const countSql = [
    ["SELECT COUNT(*) AS n FROM chemicals WHERE review_due < ?", [today]],
    ["SELECT COUNT(*) AS n FROM chemicals WHERE review_due >= ? AND review_due <= ?", [today, soonLimit]],
    ["SELECT COUNT(*) AS n FROM chemicals WHERE sds_id IS NULL", []],
    ["SELECT COUNT(*) AS n FROM chemicals WHERE decision IS NULL", []],
  ];
  const counts = {};
  const need = [];
  names.forEach((n, i) => { if (lists[i].length < CAP) counts[n] = lists[i].length; else need.push(i); });
  if (need.length) {
    const cr = await env.DB.batch(need.map(i => env.DB.prepare(countSql[i][0]).bind(...countSql[i][1])));
    need.forEach((i, k) => { counts[names[i]] = cr[k].results[0].n; });
  }
  counts.not_audited = notAudited.length;
  if (notAudited.length >= CAP) {
    const cr = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM places p LEFT JOIN place_audit_summary a ON a.place_id = p.id
       WHERE p.archived = 0 AND p.chemical_count > 0 AND (a.last_audited_at IS NULL OR substr(a.last_audited_at, 1, 10) < date('now', '-' || coalesce((SELECT value FROM settings WHERE key = 'audit_reminder_days'), '90') || ' days'))`
    ).first();
    counts.not_audited = cr.n;
  }
  if (res.length > 5) { counts.findings_open = res[5].results[0].n; counts.disposals_open = res[6].results[0].n; }
  const out = { as_of: today, counts };
  out.not_audited = notAudited.map(r => ({
    place_id: r.place_id, name: r.name, place_type: r.place_type, registration: r.registration, last_audited_at: r.last_audited_at,
    days: r.last_audited_at ? daysBetweenIso(r.last_audited_at.slice(0, 10), today) : null,
  }));
  const byName = (a, b) => String(a.product_name).toLowerCase().localeCompare(String(b.product_name).toLowerCase());
  names.forEach((n, i) => {
    const rows = lists[i].map(r => ({ ...r, review_status: reviewStatus(r.review_due, r.sds_id, today) }));
    if (n === "no_sds" || n === "no_decision") rows.sort(byName);
    out[n] = rows;
  });
  return json(out);
}

export function addDaysIso(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- handlers: chemicals

function escapeLike(s) { return s.replace(/[\\%_]/g, m => "\\" + m); }

export async function handleListChemicals(c) {
  const { env, url } = c;
  const filter = url.searchParams.get("filter") || "all";
  if (filter !== "all" && filter !== "hazardous") throw bad("filter must be all or hazardous");
  const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 100);
  const today = todayIso();
  const cols = "id, product_name, supplier, decision, sds_id, sds_issue_date, review_due, risk_level, dg_class, signal_word, pictograms, source, ghs_classification, decision_override, pictograms_override";
  const conds = [];
  const args = [];
  if (filter === "hazardous") conds.push("decision = 'hazardous'");
  let limit, offset = 0;
  if (q) {
    const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
    for (const w of words) { conds.push("search_text LIKE ? ESCAPE '\\'"); args.push("%" + escapeLike(w.slice(0, 60)) + "%"); }
    limit = Math.min(50, intParam(url, "limit", 50));
  } else {
    limit = Math.min(2000, intParam(url, "limit", 500));
    offset = intParam(url, "offset", 0, 0);
  }
  const where = conds.length ? " WHERE " + conds.join(" AND ") : "";
  const { results } = await env.DB.prepare(
    `SELECT ${cols} FROM chemicals${where} ORDER BY product_name COLLATE NOCASE, id LIMIT ? OFFSET ?`
  ).bind(...args, limit, offset).all();
  let total = results.length + offset;
  if (!q && (results.length >= limit || offset > 0) ) {
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM chemicals${where}`).bind(...args).first();
    total = cnt.n;
  } else if (q) {
    total = results.length;
  }
  const memo = new Map();
  const items = results.map(r => {
    const { ghs_classification, decision_override, pictograms_override, ...rest } = r;
    let flags = { decision_overridden: false, pictograms_overridden: false };
    if (decision_override || pictograms_override) {
      const key = `${ghs_classification}|${decision_override}|${pictograms_override}`;
      if (!memo.has(key)) {
        const e = effective(parseJson(ghs_classification, null), { decision: decision_override, pictograms: overrideTextToValue(pictograms_override) });
        memo.set(key, { decision_overridden: e.decision_overridden, pictograms_overridden: e.pictograms_overridden });
      }
      flags = memo.get(key);
    }
    return { ...rest, ...flags, review_status: reviewStatus(r.review_due, r.sds_id, today) };
  });
  return json({ items, total });
}

function intParam(url, name, dflt, min = 1) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw bad(`${name} is not valid`);
  return n;
}

const SDS_PUBLIC = `s.id, s.doc_key, s.version_no, s.is_current, s.title, s.supplier, s.file_name, s.file_size, s.file_hash, s.issue_date,
  s.revision, s.emergency_phone, s.review_due, s.signal_word, s.hazard_classification, s.h_statements, s.p_statements,
  s.poison_schedule, s.un_number, s.dg_class, s.subsidiary_class, s.packing_group, s.hazchem_code, s.proper_shipping_name,
  s.cas_numbers, s.unverified, s.source, s.ai_provider, s.uploaded_by, s.uploaded_at, s.replaced_at,
  (s.r2_key IS NOT NULL) AS has_file`;
export { SDS_PUBLIC };

// Replaces the raw JSON columns with the parsed classification and adds the derived / overridden information.
export function decorateChemical(chem) {
  const cls = parseJson(chem.ghs_classification, null);
  const eff = effective(cls, { decision: chem.decision_override, pictograms: overrideTextToValue(chem.pictograms_override) });
  delete chem.ghs_classification;
  chem.classification = cls;
  chem.classification_flags = parseJson(chem.classification_flags, []);
  chem.derived = { decision: eff.derived.decision, pictograms: eff.derived.pictograms.join(","), signal_word: eff.derived.signal_word };
  chem.decision_overridden = eff.decision_overridden;
  chem.pictograms_overridden = eff.pictograms_overridden;
  return chem;
}

export async function handleGetChemical(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Chemical");
  const today = todayIso();
  const chem = await env.DB.prepare(`SELECT ${CHEM_PUBLIC_COLS} FROM chemicals WHERE id = ?`).bind(id).first();
  if (!chem) throw new ApiError(404, "Chemical not found");
  const stmts = [
    env.DB.prepare("SELECT id, assessed_date, sds_date, form, use_description, route_inhalation, route_ingestion, route_absorption, fire_response, spill_response, controls_notes, ppe_notes, risk_level, monitoring_needed, monitoring_note, surveillance_needed, surveillance_note, assessed_by, source, unverified, sds_id, chemical_id, is_current, created_at, updated_at FROM assessments WHERE chemical_id = ? AND is_current = 1 ORDER BY id DESC LIMIT 1").bind(id),
    env.DB.prepare("SELECT cp.id AS link_id, cp.place_id, p.name, p.place_type, p.registration, p.archived, p.counts_toward_totals, cp.quantity, cp.unit, cp.container_note, cp.spill_compound FROM chemical_places cp JOIN places p ON p.id = cp.place_id WHERE cp.chemical_id = ? ORDER BY p.name COLLATE NOCASE, cp.id").bind(id),
  ];
  if (chem.sds_id) {
    stmts.push(env.DB.prepare(`SELECT ${SDS_PUBLIC} FROM sds s WHERE s.id = ?`).bind(chem.sds_id));
    stmts.push(env.DB.prepare("SELECT id, product_name FROM chemicals WHERE sds_id = ? AND id != ? ORDER BY id LIMIT 50").bind(chem.sds_id, id));
  }
  stmts.push(env.DB.prepare("SELECT 1 AS yes FROM chemical_label_photos WHERE chemical_id = ?").bind(id));
  const res = await env.DB.batch(stmts);
  const hasLabelPhoto = res[res.length - 1].results.length > 0;
  const assessment = res[0].results[0] || null;
  let sds = null, sdsProducts = [], sdsProductsTotal = 0;
  if (chem.sds_id) {
    sds = res[2].results[0] || null;
    sdsProducts = res[3].results;
    sdsProductsTotal = sdsProducts.length;
    if (sdsProducts.length >= 50) {
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM chemicals WHERE sds_id = ? AND id != ?").bind(chem.sds_id, id).first();
      sdsProductsTotal = cnt.n;
    }
  }
  if (assessment) {
    const ctl = await env.DB.prepare(
      "SELECT o.id, o.kind, o.label FROM assessment_controls ac JOIN control_options o ON o.id = ac.option_id WHERE ac.assessment_id = ? ORDER BY o.kind, o.sort_order, o.id"
    ).bind(assessment.id).all();
    assessment.controls = ctl.results;
  }
  chem.review_status = reviewStatus(chem.review_due, chem.sds_id, today);
  decorateChemical(chem);
  return json({ chemical: chem, sds, sds_products: sdsProducts, sds_products_total: sdsProductsTotal, assessment, places: res[1].results, has_label_photo: hasLabelPhoto });
}

export async function handleHistory(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Chemical");
  const chem = await env.DB.prepare("SELECT id, sds_id FROM chemicals WHERE id = ?").bind(id).first();
  if (!chem) throw new ApiError(404, "Chemical not found");
  const stmts = [env.DB.prepare(
    `SELECT id, chemical_id, sds_id, is_current, assessed_date, sds_date, risk_level, assessed_by, source, created_at, updated_at
     FROM assessments WHERE chemical_id = ? AND is_current = 0 ORDER BY id DESC LIMIT 200`
  ).bind(id)];
  if (chem.sds_id) {
    stmts.push(env.DB.prepare(
      `SELECT ${SDS_PUBLIC} FROM sds s WHERE s.doc_key = (SELECT doc_key FROM sds WHERE id = ?) ORDER BY s.version_no DESC LIMIT 100`
    ).bind(chem.sds_id));
  }
  const res = await env.DB.batch(stmts);
  return json({ sds_versions: chem.sds_id ? res[1].results : [], assessments: res[0].results });
}

export async function handleCreateChemical(c) {
  const body = await readJson(c.request);
  const f = { ...body, source: "manual" };
  delete f.decision; delete f.decision_by; delete f.classification_flags;
  const cls = body.ghs_classification === undefined ? undefined : cleanClassificationInput(body.ghs_classification, { strict: true });
  if (cls) f.ghs_classification = cls.map(e => ({ c: e.c, k: e.k, src: "admin" }));
  else if (cls === null) f.ghs_classification = null;
  f.decision_by = c.user.name;
  const id = await createChemical(c.env, f, c.user.id);
  return json({ id }, 201);
}

export async function handleUpdateChemical(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Chemical");
  const body = await readJson(c.request);
  const existing = await env.DB.prepare(
    "SELECT id, ghs_classification, classification_flags, decision_override, pictograms_override FROM chemicals WHERE id = ?"
  ).bind(id).first();
  if (!existing) throw new ApiError(404, "Chemical not found");
  const f = cleanChemical(body);
  const ov = cleanOverrides(body);
  const newCls = body.ghs_classification === undefined ? undefined : cleanClassificationInput(body.ghs_classification, { strict: true });
  const classChanged = newCls !== undefined || ov.decision_override !== undefined || ov.pictograms_override !== undefined;
  if (!Object.keys(f).length && !classChanged) throw bad("Nothing to update");
  const stmts = [];
  const sets = [], vals = [];
  for (const k of Object.keys(f)) { sets.push(`${k} = ?`); vals.push(f[k]); }
  if (sets.length) stmts.push(env.DB.prepare(`UPDATE chemicals SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...vals, id));
  if (classChanged) {
    const oldCls = parseJson(existing.ghs_classification, null);
    let cls = oldCls, flags = parseJson(existing.classification_flags, []);
    if (newCls !== undefined) {
      const key = (l) => l ? l.map(e => `${e.c}:${e.k ?? ""}`).sort().join("|") : null;
      if (key(newCls) === key(oldCls)) cls = oldCls; // unchanged: keep who/what produced it
      else { cls = newCls === null ? null : newCls.map(e => ({ c: e.c, k: e.k, src: "admin" })); flags = []; }
    }
    stmts.push(...classificationStatements(env, id, cls, {
      flags, decisionBy: c.user.name,
      overrides: {
        decision: ov.decision_override !== undefined ? ov.decision_override : existing.decision_override,
        pictograms: ov.pictograms_override !== undefined ? ov.pictograms_override : existing.pictograms_override,
      },
    }));
  }
  stmts.push(...summaryStatements(env, { chemicalId: id }));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

export async function handleDeleteChemical(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Chemical");
  const chem = await env.DB.prepare("SELECT id, sds_id FROM chemicals WHERE id = ?").bind(id).first();
  if (!chem) throw new ApiError(404, "Chemical not found");
  await deleteLabelPhotos(env, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM assessment_controls WHERE assessment_id IN (SELECT id FROM assessments WHERE chemical_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM assessments WHERE chemical_id = ?").bind(id),
    env.DB.prepare("UPDATE places SET chemical_count = MAX(chemical_count - 1, 0) WHERE id IN (SELECT place_id FROM chemical_places WHERE chemical_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM chemical_places WHERE chemical_id = ?").bind(id),
    env.DB.prepare("DELETE FROM chemicals WHERE id = ?").bind(id),
  ]);
  let sdsDeleted = false;
  if (chem.sds_id) {
    const other = await env.DB.prepare("SELECT id FROM chemicals WHERE sds_id = ? LIMIT 1").bind(chem.sds_id).first();
    if (!other) { await deleteSdsDocument(env, chem.sds_id); sdsDeleted = true; }
  }
  return json({ ok: true, sds_deleted: sdsDeleted });
}

// (places, links, the manifest and packs live in places.js)

export async function handleExportAll(c) {
  const { env } = c;
  const today = todayIso();
  const [chems, placesRes, linksRes, assess, ctl, sdsFiles, settings] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.product_name, c.supplier, c.synonyms, c.product_codes, c.use_description, c.physical_form, c.decision,
         c.decision_note, c.decision_by, c.decision_at, c.ghs_classification, c.classification_flags, c.decision_override,
         c.pictograms_override, c.signal_word, c.pictograms, c.sds_id, c.sds_issue_date, c.review_due, c.risk_level, c.source,
         c.created_at, c.updated_at,
         s.title AS sds_title, s.version_no AS sds_version_no, s.file_name AS sds_file_name, s.revision, s.emergency_phone,
         s.signal_word AS sds_signal_word, s.hazard_classification, s.h_statements, s.p_statements, s.poison_schedule, s.un_number, s.dg_class,
         s.subsidiary_class, s.packing_group, s.hazchem_code, s.proper_shipping_name, s.cas_numbers
       FROM chemicals c LEFT JOIN sds s ON s.id = c.sds_id ORDER BY c.product_name COLLATE NOCASE, c.id`
    ).all(),
    env.DB.prepare("SELECT id, name, place_type, registration, counts_toward_totals, archived, notes, chemical_count FROM places ORDER BY archived, place_type, name COLLATE NOCASE").all(),
    env.DB.prepare("SELECT id, chemical_id, place_id, quantity, unit, container_note, spill_compound FROM chemical_places ORDER BY place_id, id").all(),
    env.DB.prepare(
      `SELECT a.id, a.chemical_id, a.sds_id, a.assessed_date, a.sds_date, a.form, a.use_description, a.route_inhalation, a.route_ingestion,
         a.route_absorption, a.fire_response, a.spill_response, a.controls_notes, a.ppe_notes, a.risk_level, a.monitoring_needed,
         a.monitoring_note, a.surveillance_needed, a.surveillance_note, a.assessed_by, a.source, a.unverified
       FROM chemicals c JOIN assessments a ON a.chemical_id = c.id AND a.is_current = 1 ORDER BY c.id`
    ).all(),
    env.DB.prepare(
      `SELECT ac.assessment_id, o.kind, o.label
       FROM chemicals c JOIN assessments a ON a.chemical_id = c.id AND a.is_current = 1
       JOIN assessment_controls ac ON ac.assessment_id = a.id JOIN control_options o ON o.id = ac.option_id
       ORDER BY ac.assessment_id, o.kind, o.sort_order`
    ).all(),
    env.DB.prepare("SELECT id, title, file_name, (r2_key IS NOT NULL) AS has_file FROM sds WHERE is_current = 1 ORDER BY id").all(),
    loadSettings(env),
  ]);
  const names = new Map();
  const chemicals = chems.results.map(r => {
    if (r.sds_id) { const a = names.get(r.sds_id) || []; a.push(r.product_name); names.set(r.sds_id, a); }
    const cls = parseJson(r.ghs_classification, null);
    const eff = effective(cls, { decision: r.decision_override, pictograms: overrideTextToValue(r.pictograms_override) });
    const { ghs_classification, ...rest } = r;
    return {
      ...rest, classification: cls, classification_flags: parseJson(r.classification_flags, []),
      decision_overridden: eff.decision_overridden, pictograms_overridden: eff.pictograms_overridden,
      review_status: reviewStatus(r.review_due, r.sds_id, today),
    };
  });
  const chemById = new Map(chemicals.map(ch => [ch.id, ch]));
  const countingPlaces = placesRes.results.filter(p => !p.archived);
  const placeTotals = computePlaceTotals(countingPlaces, linksRes.results.map(l => {
    const ch = chemById.get(l.chemical_id);
    return { place_id: l.place_id, id: l.id, chemical_id: l.chemical_id, name: ch ? ch.product_name : "", classification: ch ? ch.classification : null, quantity: l.quantity, unit: l.unit, spill_compound: l.spill_compound };
  }));
  const byAssessment = new Map();
  for (const r of ctl.results) { const a = byAssessment.get(r.assessment_id) || []; a.push({ kind: r.kind, label: r.label }); byAssessment.set(r.assessment_id, a); }
  const assessments = assess.results.map(a => ({ ...a, controls: byAssessment.get(a.id) || [] }));
  return json({
    generated_at: nowIso(),
    company: {
      name: settings.company_name || "", address: settings.company_address || "", phone: settings.company_phone || "",
      email: settings.company_email || "", reg: settings.company_reg || "",
    },
    chemicals,
    places: placesRes.results,
    links: linksRes.results,
    place_totals: placeTotals,
    ...(await auditExportData(env, c.user)),
    assessments,
    sds_files: sdsFiles.results.map(s => ({ sds_id: s.id, file_name: s.file_name, product_names: names.get(s.id) || [], has_file: !!s.has_file })),
  });
}

// ---------------------------------------------------------------- handlers: options

export async function handleListOptions(c) {
  const { env, user } = c;
  const admin = user.role === "admin";
  const { results } = await env.DB.prepare(
    `SELECT id, kind, label, active, sort_order FROM control_options ${admin ? "" : "WHERE active = 1 "}ORDER BY kind, sort_order, id`
  ).all();
  const out = {};
  for (const k of OPTION_KINDS) out[k] = [];
  for (const r of results) if (out[r.kind]) out[r.kind].push({ id: r.id, label: r.label, active: r.active, ...(admin ? { sort_order: r.sort_order } : {}) });
  return json(out);
}

export async function handleCreateOption(c) {
  const { env } = c;
  const b = await readJson(c.request);
  const kind = cleanEnum(b.kind, OPTION_KINDS, "Kind");
  if (!kind) throw bad("Kind is required");
  const label = cleanStr(b.label, 120, "Label", { required: true });
  const existing = await env.DB.prepare("SELECT id, active FROM control_options WHERE kind = ? AND label = ?").bind(kind, label).first();
  if (existing) {
    if (existing.active) throw bad("That option already exists");
    await env.DB.prepare("UPDATE control_options SET active = 1 WHERE id = ?").bind(existing.id).run();
    return json({ id: existing.id, reactivated: true });
  }
  const r = await env.DB.prepare(
    "INSERT INTO control_options (kind, label, sort_order) VALUES (?, ?, COALESCE((SELECT MAX(sort_order) FROM control_options WHERE kind = ?), 0) + 10)"
  ).bind(kind, label, kind).run();
  return json({ id: r.meta.last_row_id }, 201);
}

export async function handleUpdateOption(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Option");
  const b = await readJson(c.request);
  const sets = [], vals = [];
  if (b.label !== undefined) { sets.push("label = ?"); vals.push(cleanStr(b.label, 120, "Label", { required: true })); }
  if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
  if (b.sort_order !== undefined) {
    const n = Number(b.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw bad("Sort order is not valid");
    sets.push("sort_order = ?"); vals.push(n);
  }
  if (!sets.length) throw bad("Nothing to update");
  try {
    const r = await env.DB.prepare(`UPDATE control_options SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
    if (!r.meta.changes) throw new ApiError(404, "Option not found");
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (/UNIQUE/i.test(String(e.message))) throw bad("Another option already has that label");
    throw e;
  }
  return json({ ok: true });
}

export async function handleDeleteOption(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Option");
  const opt = await env.DB.prepare("SELECT id FROM control_options WHERE id = ?").bind(id).first();
  if (!opt) throw new ApiError(404, "Option not found");
  const used = await env.DB.prepare("SELECT 1 AS x FROM assessment_controls WHERE option_id = ? LIMIT 1").bind(id).first();
  if (used) {
    await env.DB.prepare("UPDATE control_options SET active = 0 WHERE id = ?").bind(id).run();
    return json({ ok: true, deactivated: true });
  }
  await env.DB.prepare("DELETE FROM control_options WHERE id = ?").bind(id).run();
  return json({ ok: true, deleted: true });
}
