// Chemical audits: run an audit at a place, found items, disposals, findings (what changes the register), photos.
// Spec: docs/AUDIT-CHANGE.md. Ownership: a user acts only on audits they started and only while in_progress (an exact replay of an
// already-applied request is still 200); an admin on any audit. Everything a phone creates is idempotent by client_id.
//
// EXPORTS OTHER MODULES RELY ON: auditExportData(env, user) (used by GET /api/export/all), the handlers routed in index.js.

import { json, todayIso } from "./lib.js";
import {
  ApiError, bad, readJson, cleanStr, cleanId, cleanEnum, reviewStatus, parseJson, chemicalCreateStatements,
} from "./register.js";
import { validatePlaceLink, linkChemicalToPlaceStatements } from "./places.js";
import { handleReadLabel } from "./label.js";

const FINISHED_MSG = "This audit has been finished, so it cannot be changed.";
const RESULTS = ["present", "not_found", "changed"];
const REASONS = ["expired", "unlabelled", "damaged", "unknown", "no_sds"];
const OWNER_TYPES = ["item", "found", "disposal", "disposal_close", "audit"];
const MAX_IN_PROGRESS = 5;
const MAX_PER_OWNER = 3;
const DEFAULTS = { audit_photo_max_mb: 2, audit_max_photos: 50, audit_max_total_mb: 40 };

const isAdmin = (u) => u.role === "admin";
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- small helpers

// Device times: parseable, not more than 1 day ahead, not more than 30 days back; otherwise the server's time is used.
export function deviceTime(v) {
  const now = Date.now();
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (!Number.isNaN(t) && t <= now + 86400000 && t >= now - 30 * 86400000) return new Date(t).toISOString();
  }
  return new Date(now).toISOString();
}

function cleanClientId(v) {
  if (typeof v !== "string" || !/^[A-Za-z0-9_.:-]{6,100}$/.test(v)) throw bad("client_id is required (a UUID made by the phone)");
  return v;
}

function isUnique(e) { return /UNIQUE|constraint/i.test(String(e && e.message)); }

function auditOut(a) {
  return {
    id: a.id, client_id: a.client_id, place_id: a.place_id, place_name: a.place_name, place_type: a.place_type,
    place_registration: a.place_registration, started_by: a.started_by, started_by_name: a.started_by_name, started_at: a.started_at,
    finished_at: a.finished_at, finished_by_name: a.finished_by_name, status: a.status, notes: a.notes,
    summary: parseJson(a.summary, null), received_at: a.received_at,
  };
}

const ITEM_COLS = `id, audit_id, chemical_id, link_id, product_name, supplier, expected_quantity, expected_unit, expected_container_note,
  review_due, review_status, has_sds, has_assessment, risk_level, result, note, new_quantity, new_unit, new_container_note, marked_at`;

function sortItems(items) {
  const rank = (i) => i.review_status === "overdue" ? 0 : i.review_status === "due_soon" ? 1 : i.review_status === "no_sds" ? 2 : !i.has_assessment ? 3 : i.review_status === "unknown" ? 4 : 5;
  return items.sort((a, b) => rank(a) - rank(b) || String(a.product_name).toLowerCase().localeCompare(String(b.product_name).toLowerCase()) || a.id - b.id);
}

async function loadAudit(c, id, { needWrite = false } = {}) {
  const a = await c.env.DB.prepare("SELECT * FROM audits WHERE id = ?").bind(id).first();
  if (!a || !(isAdmin(c.user) || a.started_by === c.user.id)) throw new ApiError(404, "Audit not found");
  if (needWrite && a.status !== "in_progress") throw new ApiError(409, FINISHED_MSG);
  return a;
}

async function getSettingsNumbers(env, keys) {
  const marks = keys.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${marks})`).bind(...keys).all();
  const out = {};
  for (const k of keys) out[k] = DEFAULTS[k];
  for (const r of results) { const n = Number(r.value); if (Number.isFinite(n) && n > 0) out[r.key] = n; }
  return out;
}

// ---------------------------------------------------------------- start / list / get

async function auditWithItems(env, a) {
  const { results } = await env.DB.prepare(`SELECT ${ITEM_COLS} FROM audit_items WHERE audit_id = ?`).bind(a.id).all();
  return { audit: auditOut(a), items: sortItems(results) };
}

export async function handleStartAudit(c) {
  const { env, user } = c;
  const b = await readJson(c.request);
  const clientId = cleanClientId(b.client_id);
  const placeId = cleanId(b.place_id, "Place");
  const startedAt = deviceTime(b.started_at);
  const replay = await env.DB.prepare("SELECT * FROM audits WHERE started_by = ? AND client_id = ?").bind(user.id, clientId).first();
  if (replay) return json(await auditWithItems(env, replay));
  const place = await validatePlaceLink(env, placeId);
  const open = (await env.DB.prepare("SELECT * FROM audits INDEXED BY idx_audits_status WHERE status = 'in_progress' AND started_by = ? ORDER BY started_at").bind(user.id).all()).results;
  const same = open.find(a => a.place_id === placeId);
  if (same) return json({ ...(await auditWithItems(env, same)), existing: true });
  if (open.length >= MAX_IN_PROGRESS) throw bad(`You already have ${MAX_IN_PROGRESS} audits in progress. Finish one first.`);
  const links = (await env.DB.prepare(
    `SELECT cp.id AS link_id, cp.chemical_id, cp.quantity, cp.unit, cp.container_note, c.product_name, c.supplier, c.review_due, c.sds_id, c.risk_level
     FROM chemical_places cp JOIN chemicals c ON c.id = cp.chemical_id WHERE cp.place_id = ?`
  ).bind(placeId).all()).results;
  let auditId;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO audits (client_id, place_id, place_name, place_type, place_registration, started_by, started_by_name, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(clientId, placeId, place.name, place.place_type, place.registration ?? null, user.id, user.name, startedAt).run();
    auditId = r.meta.last_row_id;
  } catch (e) {
    if (isUnique(e)) {
      const again = await env.DB.prepare("SELECT * FROM audits WHERE started_by = ? AND client_id = ?").bind(user.id, clientId).first();
      if (again) return json(await auditWithItems(env, again));
    }
    throw e;
  }
  const today = todayIso();
  try {
    for (let i = 0; i < links.length; i += 90) {
      await env.DB.batch(links.slice(i, i + 90).map(l => env.DB.prepare(
        `INSERT INTO audit_items (audit_id, chemical_id, link_id, product_name, supplier, expected_quantity, expected_unit, expected_container_note,
           review_due, review_status, has_sds, has_assessment, risk_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(auditId, l.chemical_id, l.link_id, l.product_name, l.supplier ?? null, l.quantity ?? null, l.unit ?? null, l.container_note ?? null,
        l.review_due ?? null, reviewStatus(l.review_due, l.sds_id, today), l.sds_id ? 1 : 0, l.risk_level ? 1 : 0, l.risk_level ?? null)));
    }
  } catch (e) {
    await env.DB.batch([env.DB.prepare("DELETE FROM audit_items WHERE audit_id = ?").bind(auditId), env.DB.prepare("DELETE FROM audits WHERE id = ?").bind(auditId)]).catch(() => {});
    throw e;
  }
  const a = await env.DB.prepare("SELECT * FROM audits WHERE id = ?").bind(auditId).first();
  return json(await auditWithItems(env, a), 201);
}

export async function handleListAudits(c) {
  const { env, user, url } = c;
  const conds = [], args = [];
  if (!isAdmin(user)) { conds.push("started_by = ?"); args.push(user.id); }
  const placeId = url.searchParams.get("place_id");
  if (placeId) { conds.push("place_id = ?"); args.push(cleanId(placeId, "Place")); }
  const status = url.searchParams.get("status");
  if (status) { conds.push("status = ?"); args.push(cleanEnum(status, ["in_progress", "finished"], "Status")); }
  const before = url.searchParams.get("before");
  if (before) {
    if (/^\d+$/.test(before)) { conds.push("id < ?"); args.push(Number(before)); }
    else { conds.push("started_at < ?"); args.push(deviceTimeLoose(before)); }
  }
  let limit = 50;
  if (url.searchParams.get("limit")) { limit = Number(url.searchParams.get("limit")); if (!Number.isInteger(limit) || limit < 1) throw bad("limit is not valid"); limit = Math.min(limit, 200); }
  const sql = `SELECT id, place_id, place_name, place_type, started_by_name, started_at, finished_at, status, summary FROM audits ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return json(results.map(r => ({ ...r, summary: parseJson(r.summary, null) })));
}

function deviceTimeLoose(v) { const t = Date.parse(v); if (Number.isNaN(t)) throw bad("before is not valid"); return new Date(t).toISOString(); }

export async function handleGetAudit(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Audit");
  const a = await loadAudit(c, id);
  const res = await env.DB.batch([
    env.DB.prepare(`SELECT ${ITEM_COLS} FROM audit_items WHERE audit_id = ?`).bind(id),
    env.DB.prepare("SELECT id, audit_id, client_id, product_name, supplier, source, ai_provider, matched_chemical_id, chemical_id, outcome, note, found_at, created_at FROM audit_found WHERE audit_id = ? ORDER BY id").bind(id),
    env.DB.prepare("SELECT id, audit_id, client_id, place_id, place_name, chemical_id, description, reason, note, status, flagged_by_name, flagged_at, closed_by_name, closed_at, close_note FROM audit_disposals WHERE audit_id = ? ORDER BY id").bind(id),
    env.DB.prepare("SELECT id, audit_id, kind, chemical_id, place_id, place_name, product_name, link_id, audit_item_id, found_id, details, status, created_at, resolved_by_name, resolved_at, resolve_note FROM audit_findings WHERE audit_id = ? ORDER BY id").bind(id),
    env.DB.prepare("SELECT id, client_id, owner_type, owner_key, taken_at, bytes, width, height FROM audit_photos WHERE audit_id = ? ORDER BY id").bind(id),
  ]);
  return json({
    audit: auditOut(a), items: sortItems(res[0].results), found: res[1].results.map(foundOut), disposals: res[2].results,
    findings: res[3].results.map(f => ({ ...f, details: parseJson(f.details, null) })), photos: res[4].results,
  });
}

// ---------------------------------------------------------------- marking items

export async function handleMarkItem(c) {
  const { env } = c;
  const auditId = cleanId(c.p[0], "Audit");
  const chemId = cleanId(c.p[1], "Chemical");
  const a = await loadAudit(c, auditId);
  const b = await readJson(c.request);
  const item = await env.DB.prepare(`SELECT ${ITEM_COLS} FROM audit_items WHERE audit_id = ? AND chemical_id = ?`).bind(auditId, chemId).first();
  if (!item) throw new ApiError(404, "That chemical is not part of this audit");
  const result = cleanEnum(b.result, RESULTS, "Result");
  if (!result) throw bad("result is required: present, not_found or changed");
  const note = cleanStr(b.note, 1000, "Note");
  let nq = null, nu = null, nc = null;
  if (result === "changed") {
    if (b.new_quantity !== undefined && b.new_quantity !== null && b.new_quantity !== "") {
      const q = Number(b.new_quantity);
      if (!Number.isFinite(q) || q < 0 || q > 1e9) throw bad("The new quantity must be a number from 0 up");
      if (b.new_unit !== "L" && b.new_unit !== "kg") throw bad("The new quantity needs a unit, L or kg");
      nq = Math.round(q * 1000) / 1000; nu = b.new_unit;
    }
    nc = cleanStr(b.new_container_note, 300, "New container note");
    if (nq === null && !nc && !note) throw bad("For a changed item, enter the new quantity, the new container, or a note");
  }
  const same = item.result === result && (item.note ?? null) === note && (item.new_quantity ?? null) === nq && (item.new_unit ?? null) === nu && (item.new_container_note ?? null) === nc;
  if (a.status !== "in_progress") {
    if (same) return json({ item });
    throw new ApiError(409, FINISHED_MSG);
  }
  const markedAt = deviceTime(b.marked_at);
  await env.DB.prepare("UPDATE audit_items SET result = ?, note = ?, new_quantity = ?, new_unit = ?, new_container_note = ?, marked_at = ? WHERE id = ?")
    .bind(result, note, nq, nu, nc, same && item.marked_at ? item.marked_at : markedAt, item.id).run();
  const out = await env.DB.prepare(`SELECT ${ITEM_COLS} FROM audit_items WHERE id = ?`).bind(item.id).first();
  return json({ item: out });
}

// ---------------------------------------------------------------- finish

export async function handleFinishAudit(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Audit");
  const a = await loadAudit(c, id);
  const b = await readJson(c.request);
  if (a.status === "finished") return json({ audit: auditOut(a), summary: parseJson(a.summary, null) });
  const finishedAt = deviceTime(b.finished_at);
  const notes = cleanStr(b.notes, 2000, "Notes");
  const res = await env.DB.batch([
    env.DB.prepare(`SELECT ${ITEM_COLS} FROM audit_items WHERE audit_id = ?`).bind(id),
    env.DB.prepare("SELECT id, client_id, product_name, supplier, matched_chemical_id, chemical_id, outcome, note, found_at FROM audit_found WHERE audit_id = ?").bind(id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_disposals WHERE audit_id = ?").bind(id),
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM audit_photos WHERE audit_id = ?").bind(id),
    env.DB.prepare("SELECT id, owner_key FROM audit_photos WHERE audit_id = ? AND owner_type = 'found' ORDER BY id").bind(id),
  ]);
  const items = res[0].results, found = res[1].results;
  const count = (r) => items.filter(i => i.result === r).length;
  const summary = {
    listed: items.length, present: count("present"), not_found: count("not_found"), changed: count("changed"),
    not_marked: items.filter(i => !i.result).length, found: found.length, disposals: res[2].results[0].n,
    photos: res[3].results[0].n, photo_bytes: res[3].results[0].b,
  };
  const guard = "WHERE EXISTS (SELECT 1 FROM audits WHERE id = ? AND status = 'in_progress')";
  const ins = (kind, chemicalId, productName, linkId, itemId, foundId, details) => env.DB.prepare(
    `INSERT INTO audit_findings (audit_id, kind, chemical_id, place_id, place_name, product_name, link_id, audit_item_id, found_id, details)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${guard}`
  ).bind(id, kind, chemicalId ?? null, a.place_id, a.place_name, productName, linkId ?? null, itemId ?? null, foundId ?? null, JSON.stringify(details), id);
  const stmts = [];
  for (const i of items) {
    if (i.result !== "not_found" && i.result !== "changed") continue;
    stmts.push(ins(i.result, i.chemical_id, i.product_name, i.link_id, i.id, null, {
      expected_quantity: i.expected_quantity, expected_unit: i.expected_unit, expected_container_note: i.expected_container_note,
      new_quantity: i.new_quantity, new_unit: i.new_unit, new_container_note: i.new_container_note, note: i.note,
    }));
  }
  for (const f of found) {
    if (f.outcome === "recorded_unchecked") {
      stmts.push(ins("found_unchecked", null, f.product_name, null, null, f.id, {
        name: f.product_name, supplier: f.supplier, note: f.note, found_at: f.found_at,
        photo_ids: res[4].results.filter(p => p.owner_key === f.client_id).map(p => p.id),
      }));
      continue;
    }
    if (f.outcome !== "link_suggested") continue;
    stmts.push(ins("found_link", f.chemical_id ?? f.matched_chemical_id, f.product_name, null, null, f.id, { supplier: f.supplier, note: f.note }));
  }
  stmts.push(
    env.DB.prepare(
      `UPDATE audits SET status = 'finished', finished_at = ?, finished_by = ?, finished_by_name = ?, notes = COALESCE(?, notes), summary = ?
       WHERE id = ? AND status = 'in_progress'`
    ).bind(finishedAt, user.id, user.name, notes, JSON.stringify(summary), id),
    env.DB.prepare(
      `INSERT INTO place_audit_summary (place_id, last_audit_id, last_audited_at) VALUES (?, ?, ?)
       ON CONFLICT(place_id) DO UPDATE SET last_audit_id = excluded.last_audit_id, last_audited_at = excluded.last_audited_at
       WHERE excluded.last_audited_at >= place_audit_summary.last_audited_at`
    ).bind(a.place_id, id, finishedAt),
  );
  await env.DB.batch(stmts);
  const done = await env.DB.prepare("SELECT * FROM audits WHERE id = ?").bind(id).first();
  return json({ audit: auditOut(done), summary: parseJson(done.summary, summary) });
}

// ---------------------------------------------------------------- found items

const FOUND_COLS = "id, audit_id, client_id, product_name, supplier, source, ai_provider, matched_chemical_id, chemical_id, outcome, note, found_at, created_at";

export async function handleReadLabelRoute(c) {
  const id = cleanId(c.p[0], "Audit");
  const a = await loadAudit(c, id, { needWrite: true });
  return handleReadLabel(c.request, c.env, c.user, a);
}

function escapeLike(s) { return s.replace(/[\\%_]/g, m => "\\" + m); }

export async function handleFoundMatch(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Audit");
  const a = await loadAudit(c, id);
  const b = await readJson(c.request);
  const name = cleanStr(b.product_name, 200, "Product name", { required: true });
  const supplier = cleanStr(b.supplier, 200, "Supplier");
  const words = name.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const like = words.map(() => "search_text LIKE ? ESCAPE '\\'").join(" AND ");
  const res = await env.DB.batch([
    env.DB.prepare("SELECT id, product_name, supplier FROM chemicals WHERE product_name = ? COLLATE NOCASE LIMIT 10").bind(name),
    env.DB.prepare(`SELECT id, product_name, supplier FROM chemicals WHERE ${like} ORDER BY product_name COLLATE NOCASE LIMIT 10`).bind(...words.map(w => "%" + escapeLike(w) + "%")),
  ]);
  const byId = new Map();
  for (const r of [...res[0].results, ...res[1].results]) if (!byId.has(r.id)) byId.set(r.id, r);
  const rows = [...byId.values()].slice(0, 10);
  let linked = new Set();
  if (rows.length) {
    const l = await env.DB.prepare(`SELECT chemical_id FROM chemical_places WHERE place_id = ? AND chemical_id IN (${rows.map(() => "?").join(",")})`).bind(a.place_id, ...rows.map(r => r.id)).all();
    linked = new Set(l.results.map(x => x.chemical_id));
  }
  const lc = (s) => String(s || "").trim().toLowerCase();
  const candidates = rows.map(r => ({
    chemical_id: r.id, product_name: r.product_name, supplier: r.supplier,
    exact: lc(r.product_name) === lc(name) && (!supplier || lc(r.supplier) === lc(supplier)), linked_here: linked.has(r.id),
  })).sort((x, y) => Number(y.exact) - Number(x.exact));
  return json({ candidates });
}

// An unchecked item (sent while the phone was offline) is stored with outcome "recorded_unchecked" (no schema change) and shown as
// outcome "recorded" with unchecked: true. At finish it becomes a "found_unchecked" finding for the admin.
export function foundOut(f) { return f && f.outcome === "recorded_unchecked" ? { ...f, outcome: "recorded", unchecked: true } : f; }

function foundResponse(raw, placeId) {
  const f = foundOut(raw);
  const out = { found: f, chemical_id: f.chemical_id ?? null };
  if (f.outcome === "created") out.next = { upload_for_chemical: f.chemical_id, place_id: placeId };
  return out;
}

export async function handleAddFound(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Audit");
  const a = await loadAudit(c, id);
  const b = await readJson(c.request);
  const clientId = cleanClientId(b.client_id);
  const dup = await env.DB.prepare(`SELECT ${FOUND_COLS} FROM audit_found WHERE audit_id = ? AND client_id = ?`).bind(id, clientId).first();
  if (dup) return json(foundResponse(dup, a.place_id));
  const unchecked = b.unchecked === true;
  if (b.unchecked !== undefined && b.unchecked !== true && b.unchecked !== false) throw bad("unchecked must be true or false");
  if (unchecked && (b.action || "record") !== "record") throw bad("unchecked is only for action record");
  // A finished audit takes no new answers, except an unchecked item that was queued on the phone (it still needs the admin's look).
  if (a.status !== "in_progress" && !unchecked) throw new ApiError(409, FINISHED_MSG);
  const name = cleanStr(b.product_name, 200, "Product name", { required: true });
  const supplier = cleanStr(b.supplier, 200, "Supplier");
  const source = cleanEnum(b.source || "typed", ["ai", "typed"], "Source");
  const aiProvider = source === "ai" ? cleanStr(b.ai_provider, 60, "AI provider") : null;
  const note = cleanStr(b.note, 1000, "Note");
  const action = cleanEnum(b.action || "record", ["link", "create", "record"], "Action");
  const foundAt = deviceTime(b.found_at);
  const insertFound = (matched, chemicalExpr, outcome) => env.DB.prepare(
    `INSERT INTO audit_found (audit_id, client_id, product_name, supplier, source, ai_provider, matched_chemical_id, chemical_id, outcome, note, found_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${chemicalExpr}, ?, ?, ?)`
  ).bind(id, clientId, name, supplier, source, aiProvider, matched, ...(chemicalExpr === "?" ? [matched] : []), outcome, note, foundAt);
  const finish = async (stmts) => {
    try { await env.DB.batch(stmts); } catch (e) {
      if (isUnique(e)) {
        const again = await env.DB.prepare(`SELECT ${FOUND_COLS} FROM audit_found WHERE audit_id = ? AND client_id = ?`).bind(id, clientId).first();
        if (again) return again;
      }
      throw e;
    }
    return env.DB.prepare(`SELECT ${FOUND_COLS} FROM audit_found WHERE audit_id = ? AND client_id = ?`).bind(id, clientId).first();
  };
  if (action === "record") {
    if (!unchecked) return json(foundResponse(await finish([insertFound(null, "NULL", "recorded")]), a.place_id), 201);
    const stmts = [insertFound(null, "NULL", "recorded_unchecked")];
    if (a.status !== "in_progress") {
      // The audit is already finished: the finding is made now, in the same batch (a replay hits the client_id duplicate above).
      stmts.push(env.DB.prepare(
        `INSERT INTO audit_findings (audit_id, kind, place_id, place_name, product_name, found_id, details)
         SELECT ?, 'found_unchecked', ?, ?, ?, (SELECT id FROM audit_found WHERE audit_id = ? AND client_id = ?), ?
         WHERE EXISTS (SELECT 1 FROM audit_found WHERE audit_id = ? AND client_id = ?)`
      ).bind(id, a.place_id, a.place_name, name, id, clientId, JSON.stringify({ name, supplier, note, found_at: foundAt, photo_ids: [] }), id, clientId));
    }
    return json(foundResponse(await finish(stmts), a.place_id), 201);
  }
  if (action === "link") {
    const cid = cleanId(b.matched_chemical_id, "Matched chemical");
    const chem = await env.DB.prepare("SELECT id FROM chemicals WHERE id = ?").bind(cid).first();
    if (!chem) throw new ApiError(404, "The matched chemical was not found");
    const here = await env.DB.prepare("SELECT id FROM chemical_places WHERE chemical_id = ? AND place_id = ?").bind(cid, a.place_id).first();
    if (here) throw bad("That chemical is already recorded at this place");
    if (isAdmin(user)) {
      await validatePlaceLink(env, a.place_id);
      const row = await finish([insertFound(cid, "?", "linked"), ...linkChemicalToPlaceStatements(env, { chemicalId: cid, placeId: a.place_id })]);
      return json(foundResponse(row, a.place_id), 201);
    }
    return json(foundResponse(await finish([insertFound(cid, "?", "link_suggested")]), a.place_id), 201);
  }
  // create: the "needs an SDS" chemical, linked to this place, and the found row, in one batch
  await validatePlaceLink(env, a.place_id);
  const stmts = await chemicalCreateStatements(env, {
    product_name: name, supplier, source: "audit", place: { place_id: a.place_id }, decision_by: user.name,
  }, user.id);
  stmts.push(insertFound(null, "(SELECT MAX(id) FROM chemicals)", "created"));
  const row = await finish(stmts);
  return json(foundResponse(row, a.place_id), 201);
}

// ---------------------------------------------------------------- disposals

const DISPOSAL_COLS = "id, audit_id, client_id, place_id, place_name, chemical_id, description, reason, note, status, flagged_by_name, flagged_at, closed_by_name, closed_at, close_note";

export async function handleAddDisposal(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Audit");
  const a = await loadAudit(c, id);
  const b = await readJson(c.request);
  const clientId = cleanClientId(b.client_id);
  const dup = await env.DB.prepare(`SELECT ${DISPOSAL_COLS} FROM audit_disposals WHERE audit_id = ? AND client_id = ?`).bind(id, clientId).first();
  if (dup) return json({ disposal: dup });
  if (a.status !== "in_progress") throw new ApiError(409, FINISHED_MSG);
  const description = cleanStr(b.description, 300, "Description", { required: true });
  const reason = cleanEnum(b.reason, REASONS, "Reason");
  if (!reason) throw bad("A reason is required");
  const note = cleanStr(b.note, 1000, "Note");
  let chemId = null;
  if (b.chemical_id !== undefined && b.chemical_id !== null && b.chemical_id !== "") chemId = cleanId(b.chemical_id, "Chemical");
  try {
    await env.DB.prepare(
      `INSERT INTO audit_disposals (audit_id, client_id, place_id, place_name, chemical_id, description, reason, note, flagged_by, flagged_by_name, flagged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, clientId, a.place_id, a.place_name, chemId, description, reason, note, user.id, user.name, deviceTime(b.flagged_at)).run();
  } catch (e) { if (!isUnique(e)) throw e; }
  const row = await env.DB.prepare(`SELECT ${DISPOSAL_COLS} FROM audit_disposals WHERE audit_id = ? AND client_id = ?`).bind(id, clientId).first();
  return json({ disposal: row }, 201);
}

export async function handleListDisposals(c) {
  const { env, url } = c;
  const status = cleanEnum(url.searchParams.get("status") || "to_dispose", ["to_dispose", "disposed", "all"], "Status");
  let limit = 200;
  if (url.searchParams.get("limit")) { limit = Number(url.searchParams.get("limit")); if (!Number.isInteger(limit) || limit < 1) throw bad("limit is not valid"); limit = Math.min(limit, 500); }
  const where = status === "all" ? "" : "WHERE status = ?";
  const stmt = env.DB.prepare(`SELECT ${DISPOSAL_COLS} FROM audit_disposals ${where} ORDER BY ${status === "all" ? "id DESC" : "flagged_at DESC, id DESC"} LIMIT ?`);
  const { results } = await (status === "all" ? stmt.bind(limit) : stmt.bind(status, limit)).all();
  const photos = await photosForAudits(env, [...new Set(results.map(r => r.audit_id))], ["disposal", "disposal_close"]);
  return json(results.map(r => {
    const mine = photos.filter(p => p.audit_id === r.audit_id && p.owner_key === r.client_id);
    return {
      ...r, photos: mine.map(photoRef), photo_ids: mine.map(p => p.id),
      flag_photo_ids: mine.filter(p => p.owner_type === "disposal").map(p => p.id), close_photo_ids: mine.filter(p => p.owner_type === "disposal_close").map(p => p.id),
    };
  }));
}

const photoRef = (p) => ({ id: p.id, owner_type: p.owner_type, taken_at: p.taken_at });

// ONE indexed query (idx_aphotos_audit) per chunk of audits; found photos also carry the found row's id.
async function photosForAudits(env, auditIds, ownerTypes) {
  const out = [];
  for (let i = 0; i < auditIds.length; i += 80) {
    const slice = auditIds.slice(i, i + 80);
    const r = await env.DB.prepare(
      `SELECT ph.id, ph.audit_id, ph.owner_type, ph.owner_key, ph.taken_at, f.id AS found_id
       FROM audit_photos ph LEFT JOIN audit_found f ON ph.owner_type = 'found' AND f.audit_id = ph.audit_id AND f.client_id = ph.owner_key
       WHERE ph.audit_id IN (${slice.map(() => "?").join(",")}) AND ph.owner_type IN (${ownerTypes.map(() => "?").join(",")}) ORDER BY ph.id`
    ).bind(...slice, ...ownerTypes).all();
    out.push(...r.results);
  }
  return out;
}

export async function handleCloseDisposal(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Disposal");
  const b = await readJson(c.request);
  const d = await env.DB.prepare(`SELECT ${DISPOSAL_COLS} FROM audit_disposals WHERE id = ?`).bind(id).first();
  if (!d) throw new ApiError(404, "Disposal not found");
  if (d.status === "disposed") return json({ disposal: d });
  const note = cleanStr(b.close_note, 1000, "Closing note", { required: true });
  await env.DB.prepare(
    "UPDATE audit_disposals SET status = 'disposed', closed_by = ?, closed_by_name = ?, closed_at = ?, close_note = ? WHERE id = ? AND status = 'to_dispose'"
  ).bind(user.id, user.name, deviceTime(b.closed_at), note, id).run();
  return json({ disposal: await env.DB.prepare(`SELECT ${DISPOSAL_COLS} FROM audit_disposals WHERE id = ?`).bind(id).first() });
}

// ---------------------------------------------------------------- findings

const FINDING_COLS = "id, audit_id, kind, chemical_id, place_id, place_name, product_name, link_id, audit_item_id, found_id, details, status, created_at, resolved_by_name, resolved_at, resolve_note";

export async function handleListFindings(c) {
  const { env, url } = c;
  const status = cleanEnum(url.searchParams.get("status") || "open", ["open", "accepted", "dismissed", "all"], "Status");
  let limit = 200;
  if (url.searchParams.get("limit")) { limit = Number(url.searchParams.get("limit")); if (!Number.isInteger(limit) || limit < 1) throw bad("limit is not valid"); limit = Math.min(limit, 500); }
  const stmt = env.DB.prepare(`SELECT ${FINDING_COLS} FROM audit_findings ${status === "all" ? "" : "WHERE status = ?"} ORDER BY ${status === "all" ? "id DESC" : "created_at DESC, id DESC"} LIMIT ?`);
  const { results } = await (status === "all" ? stmt.bind(limit) : stmt.bind(status, limit)).all();
  const photos = await photosForAudits(env, [...new Set(results.map(f => f.audit_id))], ["item", "found"]);
  return json(results.map(f => {
    const mine = photos.filter(p => p.audit_id === f.audit_id && (f.kind === "found_link" || f.kind === "found_unchecked"
      ? p.owner_type === "found" && p.found_id === f.found_id
      : p.owner_type === "item" && p.owner_key === String(f.chemical_id)));
    return { ...f, details: parseJson(f.details, null), photos: mine.map(photoRef), photo_ids: mine.map(p => p.id) };
  }));
}

const resolveStmt = (env, user, id, status, note) => env.DB.prepare(
  "UPDATE audit_findings SET status = ?, resolved_by = ?, resolved_by_name = ?, resolved_at = ?, resolve_note = ? WHERE id = ? AND status = 'open'"
).bind(status, user.id, user.name, nowIso(), note, id);

export async function handleAcceptFinding(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Finding");
  const f = await env.DB.prepare(`SELECT ${FINDING_COLS} FROM audit_findings WHERE id = ?`).bind(id).first();
  if (!f) throw new ApiError(404, "Finding not found");
  const reload = async () => ({ ...(await env.DB.prepare(`SELECT ${FINDING_COLS} FROM audit_findings WHERE id = ?`).bind(id).first()) });
  const reply = async (result, message) => { const row = await reload(); return json({ ok: true, result, message, finding: { ...row, details: parseJson(row.details, null) } }); };
  if (f.status !== "open") return reply("already_resolved", `This finding was already ${f.status}.`);
  const d = parseJson(f.details, {}) || {};
  const link = f.chemical_id ? await env.DB.prepare("SELECT id FROM chemical_places WHERE chemical_id = ? AND place_id = ?").bind(f.chemical_id, f.place_id).first() : null;
  if (f.kind === "not_found") {
    if (!link) { await resolveStmt(env, user, id, "accepted", "The link had already gone.").run(); return reply("already_done", "The chemical was already not linked to this place, so the finding was just closed."); }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chemical_places WHERE id = ?").bind(link.id),
      env.DB.prepare("UPDATE places SET chemical_count = MAX(chemical_count - 1, 0), updated_at = datetime('now') WHERE id = ?").bind(f.place_id),
      resolveStmt(env, user, id, "accepted", null),
    ]);
    return reply("applied", "Removed from this place.");
  }
  if (f.kind === "changed") {
    if (!link) { await resolveStmt(env, user, id, "accepted", "The link had already gone.").run(); return reply("already_done", "The chemical is no longer linked to this place, so the finding was just closed."); }
    const sets = [], vals = [];
    if (d.new_quantity !== null && d.new_quantity !== undefined) { sets.push("quantity = ?", "unit = ?"); vals.push(d.new_quantity, d.new_unit); }
    if (d.new_container_note) { sets.push("container_note = ?"); vals.push(d.new_container_note); }
    const stmts = [];
    if (sets.length) stmts.push(env.DB.prepare(`UPDATE chemical_places SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, link.id));
    stmts.push(resolveStmt(env, user, id, "accepted", sets.length ? null : "Only a note was recorded, so there was nothing to update."));
    await env.DB.batch(stmts);
    return reply(sets.length ? "applied" : "already_done", sets.length ? "Quantity and container updated." : "Only a note was recorded, so the finding was just closed.");
  }
  if (f.kind === "found_link") {
    if (link) { await resolveStmt(env, user, id, "accepted", "Already linked.").run(); return reply("already_done", "It is already linked to this place, so the finding was just closed."); }
    const chem = f.chemical_id ? await env.DB.prepare("SELECT id FROM chemicals WHERE id = ?").bind(f.chemical_id).first() : null;
    if (!chem) { await resolveStmt(env, user, id, "accepted", "The chemical no longer exists.").run(); return reply("already_done", "That chemical no longer exists, so the finding was just closed."); }
    await validatePlaceLink(env, f.place_id); // 400 when the place is archived
    await env.DB.batch([...linkChemicalToPlaceStatements(env, { chemicalId: f.chemical_id, placeId: f.place_id }), resolveStmt(env, user, id, "accepted", null)]);
    return reply("applied", "Linked to this place.");
  }
  if (f.kind === "found_unchecked") {
    await resolveStmt(env, user, id, "accepted", null).run();
    return reply("noted", "Noted. Nothing on the register was changed. Add or link the chemical from the register if needed.");
  }
  throw bad("Unknown finding type");
}

export async function handleDismissFinding(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Finding");
  const b = await readJson(c.request);
  const note = cleanStr(b.note, 500, "Note");
  const f = await env.DB.prepare("SELECT id, status FROM audit_findings WHERE id = ?").bind(id).first();
  if (!f) throw new ApiError(404, "Finding not found");
  if (f.status === "open") await resolveStmt(env, user, id, "dismissed", note).run();
  const row = await env.DB.prepare(`SELECT ${FINDING_COLS} FROM audit_findings WHERE id = ?`).bind(id).first();
  return json({ ok: true, finding: { ...row, details: parseJson(row.details, null) } });
}

// ---------------------------------------------------------------- photos

const PHOTO_COLS = "id, audit_id, client_id, owner_type, owner_key, taken_at, bytes, width, height";

function dim(v, label) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 20000) throw bad(`${label} is not valid`);
  return n;
}

export async function handleUploadPhoto(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Audit");
  const a = await loadAudit(c, id);
  const cl = Number(c.request.headers.get("Content-Length") || 0);
  const cfg = await getSettingsNumbers(env, ["audit_photo_max_mb", "audit_max_photos", "audit_max_total_mb"]);
  const maxBytes = Math.floor(cfg.audit_photo_max_mb * 1048576);
  if (cl > maxBytes + 65536) throw new ApiError(413, `That photo is too large (max ${cfg.audit_photo_max_mb} MB)`);
  let form;
  try { form = await c.request.formData(); } catch { throw bad("Expected a multipart form"); }
  const clientId = cleanClientId(form.get("client_id"));
  const dup = await env.DB.prepare(`SELECT ${PHOTO_COLS} FROM audit_photos WHERE audit_id = ? AND client_id = ?`).bind(id, clientId).first();
  if (dup) return json({ photo: dup });
  const ownerType = cleanEnum(form.get("owner_type"), OWNER_TYPES, "Owner type");
  if (!ownerType) throw bad("owner_type is required");
  if (ownerType === "disposal_close") {
    if (!isAdmin(user)) throw new ApiError(403, "Only an administrator can add a closing photo.");
  }
  let ownerKey = form.get("owner_key");
  ownerKey = ownerKey === null || ownerKey === "" ? null : String(ownerKey).slice(0, 100);
  if (ownerType === "audit") ownerKey = null;
  else if (!ownerKey) throw bad("owner_key is required");
  // The owner must exist in this audit.
  let owner = true;
  if (ownerType === "item") owner = /^\d+$/.test(ownerKey) && await env.DB.prepare("SELECT id FROM audit_items WHERE audit_id = ? AND chemical_id = ?").bind(id, Number(ownerKey)).first();
  else if (ownerType === "found") owner = await env.DB.prepare("SELECT id, outcome FROM audit_found WHERE audit_id = ? AND client_id = ?").bind(id, ownerKey).first();
  else if (ownerType === "disposal" || ownerType === "disposal_close") owner = await env.DB.prepare("SELECT id FROM audit_disposals WHERE audit_id = ? AND client_id = ?").bind(id, ownerKey).first();
  if (!owner) throw bad("That photo belongs to something that is not in this audit");
  if (ownerType !== "disposal_close" && a.status !== "in_progress" && !(ownerType === "found" && owner.outcome === "recorded_unchecked")) throw new ApiError(409, FINISHED_MSG);
  const file = form.get("file");
  if (!file || typeof file === "string") throw bad("No photo received");
  if (file.size > maxBytes) throw new ApiError(413, `That photo is too large (max ${cfg.audit_photo_max_mb} MB)`);
  if (file.size < 4) throw bad("That photo is empty");
  if (file.type && file.type !== "image/jpeg") throw bad("Photos must be JPEG images");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw bad("That file is not a JPEG image");
  const [tot, own] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM audit_photos WHERE audit_id = ?").bind(id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_photos WHERE audit_id = ? AND owner_type = ? AND owner_key IS ?").bind(id, ownerType, ownerKey),
  ]);
  if (tot.results[0].n >= cfg.audit_max_photos) throw bad(`This audit already has the maximum of ${cfg.audit_max_photos} photos`);
  if (tot.results[0].b + bytes.length > cfg.audit_max_total_mb * 1048576) throw new ApiError(413, `This audit has reached its photo storage limit (${cfg.audit_max_total_mb} MB)`);
  if (own.results[0].n >= MAX_PER_OWNER) throw bad(`Only ${MAX_PER_OWNER} photos can be added to one item`);
  const key = `audits/${id}/${crypto.randomUUID()}.jpg`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  try {
    await env.DB.prepare(
      `INSERT INTO audit_photos (audit_id, client_id, owner_type, owner_key, r2_key, bytes, width, height, taken_at, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, clientId, ownerType, ownerKey, key, bytes.length, dim(form.get("width"), "Width"), dim(form.get("height"), "Height"), deviceTime(form.get("taken_at")), user.id).run();
  } catch (e) {
    await env.FILES.delete(key).catch(() => {});
    if (isUnique(e)) {
      const again = await env.DB.prepare(`SELECT ${PHOTO_COLS} FROM audit_photos WHERE audit_id = ? AND client_id = ?`).bind(id, clientId).first();
      if (again) return json({ photo: again });
    }
    throw e;
  }
  const row = await env.DB.prepare(`SELECT ${PHOTO_COLS} FROM audit_photos WHERE audit_id = ? AND client_id = ?`).bind(id, clientId).first();
  return json({ photo: row }, 201);
}

export async function handleGetPhoto(c) {
  const { env, user } = c;
  const id = cleanId(c.p[0], "Photo");
  const p = await env.DB.prepare("SELECT p.id, p.r2_key, p.audit_id, a.started_by FROM audit_photos p JOIN audits a ON a.id = p.audit_id WHERE p.id = ?").bind(id).first();
  if (!p || !(isAdmin(user) || p.started_by === user.id)) throw new ApiError(404, "Photo not found");
  const obj = await env.FILES.get(p.r2_key);
  if (!obj) throw new ApiError(404, "Photo not found");
  return new Response(obj.body, {
    headers: {
      "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      ...(obj.size !== undefined ? { "Content-Length": String(obj.size) } : {}),
    },
  });
}

// ---------------------------------------------------------------- export bundle

// Audit rows for GET /api/export/all. A user gets only the rows of audits they ran. Photos: metadata only.
export async function auditExportData(env, user) {
  const own = !isAdmin(user);
  const ids = "(SELECT id FROM audits WHERE started_by = ?)";
  const q = (sql, ownSql) => (own ? env.DB.prepare(ownSql).bind(user.id) : env.DB.prepare(sql)).all();
  const [audits, items, found, disposals, findings, photos] = await Promise.all([
    q("SELECT id, client_id, place_id, place_name, place_type, place_registration, started_by_name, started_at, finished_at, finished_by_name, status, notes, summary FROM audits ORDER BY id",
      "SELECT id, client_id, place_id, place_name, place_type, place_registration, started_by_name, started_at, finished_at, finished_by_name, status, notes, summary FROM audits WHERE started_by = ? ORDER BY id"),
    q(`SELECT ${ITEM_COLS} FROM audit_items ORDER BY id`, `SELECT ${ITEM_COLS} FROM audit_items WHERE audit_id IN ${ids} ORDER BY id`),
    q(`SELECT ${FOUND_COLS} FROM audit_found ORDER BY id`, `SELECT ${FOUND_COLS} FROM audit_found WHERE audit_id IN ${ids} ORDER BY id`),
    q(`SELECT ${DISPOSAL_COLS} FROM audit_disposals ORDER BY id`, `SELECT ${DISPOSAL_COLS} FROM audit_disposals WHERE audit_id IN ${ids} ORDER BY id`),
    q(`SELECT ${FINDING_COLS} FROM audit_findings ORDER BY id`, `SELECT ${FINDING_COLS} FROM audit_findings WHERE audit_id IN ${ids} ORDER BY id`),
    q(`SELECT ${PHOTO_COLS} FROM audit_photos ORDER BY id`, `SELECT ${PHOTO_COLS} FROM audit_photos WHERE audit_id IN ${ids} ORDER BY id`),
  ]);
  return {
    audits: audits.results.map(a => ({ ...a, summary: parseJson(a.summary, null) })),
    audit_items: items.results, audit_found: found.results.map(foundOut), audit_disposals: disposals.results,
    audit_findings: findings.results.map(f => ({ ...f, details: parseJson(f.details, null) })), audit_photos: photos.results,
  };
}
