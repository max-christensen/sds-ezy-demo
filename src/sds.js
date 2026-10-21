// Safety data sheets: metadata, PDF streaming, create / replace-as-new-version / delete, link / unlink.
//
// EXPORTS OTHER MODULES RELY ON:
//   cleanSds(fields, {partial})                  validated sds columns (throws ApiError 400)
//   createSds(env, fields, {bytes, fileName, userId, chemicalIds, source}) -> id
//        fields: any sds columns (title, supplier, issue_date, revision, emergency_phone, review_due, signal_word,
//        hazard_classification, h_statements, p_statements, poison_schedule, un_number, dg_class, subsidiary_class,
//        packing_group, hazchem_code, proper_shipping_name, cas_numbers, unverified[], ai_provider). Pictograms and the
//        hazardous decision are NOT SDS fields any more: they come from the chemical's GHS classification (a stray
//        `pictograms` / `hazardous` key is ignored).
//        review_due defaults to issue_date + 5 years. bytes (Uint8Array/ArrayBuffer) is stored in R2 as sds/<id>-<random>.pdf.
//        chemicalIds are pointed at the new SDS and their summary columns refreshed.
//   replaceSds(env, oldSdsId, fields, {bytes, fileName, userId, source}) -> new id
//        next version of the same doc_key; old row is_current 0; every chemical on the old row is re-pointed; summary refreshed.
//   deleteSdsDocument(env, sdsId)                deletes every version of that SDS (rows + PDFs). Caller checks nothing uses it.
//   validatePdfBytes(bytes)                      true when the bytes start with %PDF-
//   sha256Hex(bytes)

import { json, loadSettings, addYearsIso } from "./lib.js";
import {
  ApiError, bad, readJson, cleanStr, cleanEnum, cleanDate, cleanId, SOURCES,
  summaryStatements, SDS_PUBLIC,
} from "./register.js";

const HARD_MAX_MB = 25;

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function validatePdfBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8) return false;
  // %PDF- may be preceded by a few junk bytes in the wild, but we only accept it at the very start.
  return u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2d;
}

export async function uploadLimitBytes(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'upload_max_mb'").first();
  let mb = row ? Number(row.value) : 15;
  if (!Number.isFinite(mb) || mb < 1) mb = 15;
  return Math.min(mb, HARD_MAX_MB) * 1024 * 1024;
}

// ---------------------------------------------------------------- validation

const DG_RE = /^\d(\.\d)?$/;

export function cleanSds(b, { partial = false } = {}) {
  const out = {};
  const text = {
    title: [300, "Title"], supplier: [200, "Supplier"], revision: [100, "Revision"], emergency_phone: [100, "Emergency phone"],
    hazard_classification: [3000, "Hazard classification"], h_statements: [6000, "H statements"], p_statements: [6000, "P statements"],
    poison_schedule: [50, "Poison schedule"], hazchem_code: [10, "Hazchem code"], proper_shipping_name: [300, "Proper shipping name"],
    subsidiary_class: [40, "Subsidiary class"], ai_provider: [60, "AI provider"],
  };
  for (const [k, [max, label]] of Object.entries(text)) if (b[k] !== undefined) out[k] = cleanStr(b[k], max, label);
  if (b.issue_date !== undefined) out.issue_date = cleanDate(b.issue_date, "Issue date");
  if (b.review_due !== undefined) out.review_due = cleanDate(b.review_due, "Review due date");
  if (b.signal_word !== undefined) {
    const w = cleanStr(b.signal_word, 20, "Signal word");
    const norm = w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : null;
    out.signal_word = cleanEnum(norm, ["Danger", "Warning"], "Signal word");
  }
  if (b.un_number !== undefined) {
    const u = cleanStr(b.un_number, 10, "UN number");
    const digits = u ? u.replace(/^UN\s*/i, "") : null;
    if (digits && !/^\d{1,5}$/.test(digits)) throw bad("UN number must be digits only, like 1993");
    out.un_number = digits;
  }
  if (b.dg_class !== undefined) {
    const d = cleanStr(b.dg_class, 10, "Dangerous goods class");
    if (d && !DG_RE.test(d)) throw bad("Dangerous goods class must look like 3, 8 or 2.1");
    out.dg_class = d;
  }
  if (b.packing_group !== undefined) out.packing_group = cleanEnum(b.packing_group, ["I", "II", "III"], "Packing group");
  if (b.cas_numbers !== undefined) {
    const raw = Array.isArray(b.cas_numbers) ? b.cas_numbers : String(b.cas_numbers || "").split(/[,;\s]+/);
    const list = [...new Set(raw.map(x => String(x).trim()).filter(Boolean))];
    if (list.length > 100) throw bad("Too many CAS numbers");
    for (const cas of list) if (!/^\d{2,7}-\d{2}-\d$/.test(cas)) throw bad(`"${cas}" is not a CAS number`);
    out.cas_numbers = list.length ? list.join(",") : null;
  }
  if (b.unverified !== undefined) {
    const arr = Array.isArray(b.unverified) ? b.unverified.filter(x => typeof x === "string").slice(0, 60) : [];
    out.unverified = arr.length ? JSON.stringify(arr) : null;
  }
  if (!partial && Object.keys(out).length === 0 && !b.title) { /* an SDS with no fields is allowed (file only) */ }
  return out;
}

const SDS_COLS = ["title", "supplier", "issue_date", "revision", "emergency_phone", "review_due", "signal_word",
  "hazard_classification", "h_statements", "p_statements", "poison_schedule", "un_number", "dg_class", "subsidiary_class",
  "packing_group", "hazchem_code", "proper_shipping_name", "cas_numbers", "unverified", "ai_provider"];

function randomKey() { return crypto.randomUUID().replace(/-/g, ""); }

function toU8(bytes) { return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); }

function cleanFileName(name) {
  if (!name) return null;
  return String(name).replace(/[\\/\u0000-\u001F"]/g, "_").slice(0, 200);
}

async function insertSdsRow(env, f, meta) {
  const vals = SDS_COLS.map(c => (f[c] !== undefined ? f[c] : null));
  const r = await env.DB.prepare(
    `INSERT INTO sds (doc_key, version_no, is_current, ${SDS_COLS.join(", ")}, source, uploaded_by)
     VALUES (?, ?, ?, ${SDS_COLS.map(() => "?").join(", ")}, ?, ?)`
  ).bind(meta.docKey, meta.version, meta.current ? 1 : 0, ...vals, meta.source, meta.userId || null).run();
  return r.meta.last_row_id;
}

async function storePdf(env, id, bytes, fileName) {
  const u8 = toU8(bytes);
  const key = `sds/${id}-${randomKey().slice(0, 16)}.pdf`;
  await env.FILES.put(key, u8, { httpMetadata: { contentType: "application/pdf" } });
  const hash = await sha256Hex(u8);
  return { key, hash, size: u8.length, name: cleanFileName(fileName) || `sds-${id}.pdf` };
}

function normaliseDates(f) {
  if (f.issue_date && f.review_due === undefined) f.review_due = addYearsIso(f.issue_date, 5);
  return f;
}

export async function createSds(env, fields, opts = {}) {
  const f = normaliseDates(cleanSds(fields || {}));
  const source = SOURCES.includes(opts.source) ? opts.source : "manual";
  const chemIds = (opts.chemicalIds || []).map(x => cleanId(x, "Chemical"));
  const id = await insertSdsRow(env, f, { docKey: randomKey(), version: 1, current: true, source, userId: opts.userId });
  try {
    if (opts.bytes) {
      const p = await storePdf(env, id, opts.bytes, opts.fileName);
      await env.DB.prepare("UPDATE sds SET r2_key = ?, file_name = ?, file_size = ?, file_hash = ? WHERE id = ?")
        .bind(p.key, p.name, p.size, p.hash, id).run();
    }
    if (chemIds.length) await pointChemicalsAt(env, id, chemIds);
  } catch (e) {
    await env.DB.prepare("DELETE FROM sds WHERE id = ?").bind(id).run().catch(() => {});
    throw e;
  }
  return id;
}

async function pointChemicalsAt(env, sdsId, chemIds) {
  const stmts = [];
  for (let i = 0; i < chemIds.length; i += 80) {
    const chunk = chemIds.slice(i, i + 80);
    stmts.push(env.DB.prepare(`UPDATE chemicals SET sds_id = ? WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(sdsId, ...chunk));
  }
  stmts.push(...summaryStatements(env, { sdsId }));
  await env.DB.batch(stmts);
}

export async function replaceSds(env, oldId, fields, opts = {}) {
  const old = await env.DB.prepare("SELECT id, doc_key, version_no, is_current, title, supplier FROM sds WHERE id = ?").bind(oldId).first();
  if (!old) throw new ApiError(404, "SDS not found");
  if (!old.is_current) throw bad("Only the current version of an SDS can be replaced");
  if (!opts.bytes) throw bad("A PDF file is required for a new version");
  const f = normaliseDates(cleanSds(fields || {}));
  if (f.title === undefined) f.title = old.title;
  if (f.supplier === undefined) f.supplier = old.supplier;
  const source = SOURCES.includes(opts.source) ? opts.source : "manual";
  const newId = await insertSdsRow(env, f, { docKey: old.doc_key, version: old.version_no + 1, current: false, source, userId: opts.userId });
  try {
    const p = await storePdf(env, newId, opts.bytes, opts.fileName);
    await env.DB.batch([
      env.DB.prepare("UPDATE sds SET is_current = 0, replaced_at = datetime('now') WHERE id = ?").bind(oldId),
      env.DB.prepare("UPDATE sds SET is_current = 1, r2_key = ?, file_name = ?, file_size = ?, file_hash = ? WHERE id = ?")
        .bind(p.key, p.name, p.size, p.hash, newId),
      env.DB.prepare("UPDATE chemicals SET sds_id = ? WHERE sds_id = ?").bind(newId, oldId),
      ...summaryStatements(env, { sdsId: newId }),
    ]);
  } catch (e) {
    await env.DB.prepare("DELETE FROM sds WHERE id = ?").bind(newId).run().catch(() => {});
    throw e;
  }
  return newId;
}

export async function deleteSdsDocument(env, sdsId) {
  const { results } = await env.DB.prepare(
    "SELECT id, r2_key FROM sds WHERE doc_key = (SELECT doc_key FROM sds WHERE id = ?)"
  ).bind(sdsId).all();
  if (!results.length) return;
  const ids = results.map(r => r.id);
  const marks = ids.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare(`UPDATE assessments SET sds_id = NULL WHERE sds_id IN (${marks})`).bind(...ids),
    env.DB.prepare(`DELETE FROM sds WHERE id IN (${marks})`).bind(...ids),
  ]);
  const keys = results.map(r => r.r2_key).filter(Boolean);
  if (keys.length) await env.FILES.delete(keys).catch(() => {});
}

// ---------------------------------------------------------------- HTTP helpers

async function readMultipart(c, { fileRequired }) {
  const { request, env } = c;
  let form;
  try { form = await request.formData(); } catch { throw bad("Expected a multipart form"); }
  const file = form.get("file");
  let bytes = null, fileName = null;
  if (file && typeof file !== "string") {
    const limit = await uploadLimitBytes(env);
    if (file.size > limit) throw new ApiError(413, `The PDF is too large (max ${Math.round(limit / 1048576)} MB)`);
    if (file.type && file.type !== "application/pdf" && file.type !== "application/x-pdf" && file.type !== "application/octet-stream") throw bad("Only PDF files are accepted");
    if (!/\.pdf$/i.test(file.name || "")) throw bad("Only PDF files are accepted");
    bytes = new Uint8Array(await file.arrayBuffer());
    if (!validatePdfBytes(bytes)) throw bad("That file is not a PDF");
    fileName = file.name;
  } else if (fileRequired) {
    throw bad("A PDF file is required");
  }
  let data = {};
  const raw = form.get("data");
  if (typeof raw === "string" && raw.trim()) {
    try { data = JSON.parse(raw); } catch { throw bad("The data field was not valid JSON"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("The data field must be an object");
  }
  let chemicalIds = data.chemical_ids;
  const rawIds = form.get("chemical_ids");
  if (typeof rawIds === "string" && rawIds.trim()) {
    try { chemicalIds = JSON.parse(rawIds); } catch { throw bad("chemical_ids was not valid JSON"); }
  }
  if (chemicalIds !== undefined && !Array.isArray(chemicalIds)) throw bad("chemical_ids must be a list");
  if (chemicalIds && chemicalIds.length > 500) throw bad("Too many chemicals");
  return { bytes, fileName, data, chemicalIds: chemicalIds || [] };
}

// ---------------------------------------------------------------- handlers

export async function handleGetSds(c) {
  const id = cleanId(c.p[0], "SDS");
  const row = await c.env.DB.prepare(`SELECT ${SDS_PUBLIC} FROM sds s WHERE s.id = ?`).bind(id).first();
  if (!row) throw new ApiError(404, "SDS not found");
  return json(row);
}

export async function handleSdsFile(c) {
  const id = cleanId(c.p[0], "SDS");
  const row = await c.env.DB.prepare("SELECT r2_key, file_name FROM sds WHERE id = ?").bind(id).first();
  if (!row || !row.r2_key) throw new ApiError(404, "No file on record for this SDS");
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) throw new ApiError(404, "The file is missing from storage");
  const safe = (row.file_name || `sds-${id}.pdf`).replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safe}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
      ...(obj.size !== undefined ? { "Content-Length": String(obj.size) } : {}),
    },
  });
}

export async function handleSdsChemicals(c) {
  const id = cleanId(c.p[0], "SDS");
  const { results } = await c.env.DB.prepare(
    "SELECT id, product_name, supplier, decision FROM chemicals WHERE sds_id = ? ORDER BY id LIMIT 200"
  ).bind(id).all();
  return json({ items: results });
}

export async function handleCreateSds(c) {
  const { bytes, fileName, data, chemicalIds } = await readMultipart(c, { fileRequired: false });
  if (bytes) {
    const hash = await sha256Hex(bytes);
    const dup = await c.env.DB.prepare("SELECT id FROM sds WHERE file_hash = ? LIMIT 1").bind(hash).first();
    if (dup) throw new ApiError(409, `That exact file is already on record (SDS ${dup.id})`);
  }
  const id = await createSds(c.env, data, { bytes, fileName, userId: c.user.id, chemicalIds, source: "manual" });
  return json({ id }, 201);
}

export async function handleReplaceSds(c) {
  const oldId = cleanId(c.p[0], "SDS");
  const { bytes, fileName, data } = await readMultipart(c, { fileRequired: true });
  const hash = await sha256Hex(bytes);
  const dup = await c.env.DB.prepare("SELECT id FROM sds WHERE file_hash = ? LIMIT 1").bind(hash).first();
  if (dup) throw new ApiError(409, `That exact file is already on record (SDS ${dup.id})`);
  const id = await replaceSds(c.env, oldId, data, { bytes, fileName, userId: c.user.id, source: "manual" });
  return json({ id }, 201);
}

export async function handleUpdateSds(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "SDS");
  const body = await readJson(c.request);
  const row = await env.DB.prepare("SELECT id, is_current FROM sds WHERE id = ?").bind(id).first();
  if (!row) throw new ApiError(404, "SDS not found");
  const f = cleanSds(body, { partial: true });
  if (f.issue_date !== undefined && body.review_due === undefined) f.review_due = f.issue_date ? addYearsIso(f.issue_date, 5) : null;
  const keys = Object.keys(f);
  if (!keys.length) throw bad("Nothing to update");
  const stmts = [env.DB.prepare(`UPDATE sds SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map(k => f[k]), id)];
  if (row.is_current) stmts.push(...summaryStatements(env, { sdsId: id }));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

export async function handleDeleteSds(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "SDS");
  const row = await env.DB.prepare("SELECT id, doc_key, is_current, r2_key FROM sds WHERE id = ?").bind(id).first();
  if (!row) throw new ApiError(404, "SDS not found");
  const used = await env.DB.prepare("SELECT id FROM chemicals WHERE sds_id = ? LIMIT 1").bind(id).first();
  if (used) throw new ApiError(409, "This SDS is still used by a product. Unlink or delete the product first.");
  const stmts = [
    env.DB.prepare("UPDATE assessments SET sds_id = NULL WHERE sds_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sds WHERE id = ?").bind(id),
  ];
  if (row.is_current) {
    // Deleting the current version promotes the newest older version of the same document, if any.
    stmts.push(env.DB.prepare(
      "UPDATE sds SET is_current = 1 WHERE id = (SELECT id FROM sds WHERE doc_key = ? ORDER BY version_no DESC LIMIT 1)"
    ).bind(row.doc_key));
  }
  await env.DB.batch(stmts);
  if (row.r2_key) await env.FILES.delete(row.r2_key).catch(() => {});
  return json({ ok: true });
}

export async function handleLinkSds(c) {
  const { env } = c;
  const chemId = cleanId(c.p[0], "Chemical");
  const body = await readJson(c.request);
  const sdsId = cleanId(body.sds_id, "SDS");
  const chem = await env.DB.prepare("SELECT id FROM chemicals WHERE id = ?").bind(chemId).first();
  if (!chem) throw new ApiError(404, "Chemical not found");
  const sds = await env.DB.prepare("SELECT id, is_current FROM sds WHERE id = ?").bind(sdsId).first();
  if (!sds) throw new ApiError(404, "SDS not found");
  if (!sds.is_current) throw bad("Only the current version of an SDS can be linked");
  await env.DB.batch([
    env.DB.prepare("UPDATE chemicals SET sds_id = ? WHERE id = ?").bind(sdsId, chemId),
    ...summaryStatements(env, { chemicalId: chemId }),
  ]);
  return json({ ok: true });
}

export async function handleUnlinkSds(c) {
  const { env } = c;
  const chemId = cleanId(c.p[0], "Chemical");
  const chem = await env.DB.prepare("SELECT id FROM chemicals WHERE id = ?").bind(chemId).first();
  if (!chem) throw new ApiError(404, "Chemical not found");
  await env.DB.batch([
    env.DB.prepare("UPDATE chemicals SET sds_id = NULL WHERE id = ?").bind(chemId),
    ...summaryStatements(env, { chemicalId: chemId }),
  ]);
  return json({ ok: true });
}
