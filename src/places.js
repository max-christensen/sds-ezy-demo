// Places (workshop or depot, vehicle, site), the links between chemicals and places, per-place totals and manifest,
// and the job pack read endpoint.
//
// EXPORTS OTHER MODULES RELY ON:
//   linkChemicalToPlaceStatements(env, {chemicalId | "last", placeId, quantity, unit, containerNote, spillCompound})
//        -> [INSERT chemical_places, UPDATE places.chemical_count + 1] for a db.batch. "last" = the chemical inserted by the
//        statement just before in the same batch (only ONE link can use "last", and it must come before any other INSERT).
//        quantity/unit are both set or both omitted; throws ApiError 400 when invalid.
//   validatePlaceLink(env, placeId) -> the place row; throws ApiError 400 when it does not exist or is archived.

import { json, todayIso } from "./lib.js";
import {
  ApiError, bad, readJson, cleanStr, cleanId, cleanEnum, reviewStatus, parseJson, overrideTextToValue,
  decorateChemical, CHEM_PUBLIC_COLS, SDS_PUBLIC,
} from "./register.js";
import {
  PLACE_TYPES, defaultCountsTowardTotals, computePlaceTotals,
} from "../public/lib/ghs-ref.mjs";
import { effective } from "../public/lib/ghs-ref.mjs";

const PLACE_TYPE_IDS = PLACE_TYPES.map(t => t.id);
const PLACE_COLS = "id, name, place_type, registration, counts_toward_totals, archived, notes, chemical_count";

// ---------------------------------------------------------------- validation

function cleanQuantityUnit(b, existing) {
  const hasQ = b.quantity !== undefined, hasU = b.unit !== undefined;
  if (!hasQ && !hasU) return {};
  let q = hasQ ? b.quantity : existing && existing.quantity;
  let u = hasU ? b.unit : existing && existing.unit;
  if (q === "" ) q = null;
  if (u === "") u = null;
  if (q === null || q === undefined) {
    if (hasQ || (hasU && (u === null || u === undefined))) return { quantity: null, unit: null };
    throw bad("Enter a quantity as well as the unit, or leave both blank");
  }
  const n = Number(q);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw bad("Quantity must be a number from 0 up");
  if (u !== "L" && u !== "kg") throw bad("Quantity needs a unit, L or kg");
  return { quantity: Math.round(n * 1000) / 1000, unit: u };
}

function cleanLinkExtras(b) {
  const out = {};
  if (b.container_note !== undefined) out.container_note = cleanStr(b.container_note, 300, "Container note");
  if (b.spill_compound !== undefined) out.spill_compound = cleanStr(b.spill_compound, 200, "Spill compound");
  return out;
}

function cleanBool(v, label) {
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  throw bad(`${label} must be true or false`);
}

function cleanPlace(b, { create }) {
  const out = {};
  if (b.name !== undefined || create) out.name = cleanStr(b.name, 120, "Name", { required: true });
  if (b.place_type !== undefined || create) {
    out.place_type = cleanEnum(b.place_type === undefined || b.place_type === null || b.place_type === "" ? "workshop" : b.place_type, PLACE_TYPE_IDS, "Place type");
  }
  if (b.registration !== undefined) {
    const r = cleanStr(b.registration, 40, "Registration");
    out.registration = r ? r.toUpperCase() : null;
    if (out.registration && out.registration.length > 20) throw bad("Registration is too long (max 20 characters)");
  }
  if (b.counts_toward_totals !== undefined) out.counts_toward_totals = cleanBool(b.counts_toward_totals, "Counts toward totals");
  if (b.notes !== undefined) out.notes = cleanStr(b.notes, 1000, "Notes");
  if (b.archived !== undefined && !create) out.archived = cleanBool(b.archived, "Archived");
  return out;
}

async function assertNameFree(env, name, type, exceptId) {
  const dup = await env.DB.prepare(
    "SELECT id FROM places WHERE archived = 0 AND place_type = ? AND name = ? COLLATE NOCASE AND id != ? LIMIT 1"
  ).bind(type, name, exceptId || 0).first();
  if (dup) throw bad(`There is already an active ${PLACE_TYPES.find(t => t.id === type).label.toLowerCase()} called "${name}"`);
}

// ---------------------------------------------------------------- links (used by the upload pipeline too)

export async function validatePlaceLink(env, placeId) {
  const id = cleanId(placeId, "Place");
  const p = await env.DB.prepare(`SELECT ${PLACE_COLS} FROM places WHERE id = ?`).bind(id).first();
  if (!p) throw bad("That place does not exist");
  if (p.archived) throw bad("That place is archived, so nothing can be added to it");
  return p;
}

export function linkChemicalToPlaceStatements(env, { chemicalId, placeId, quantity, unit, containerNote, spillCompound }) {
  const qu = cleanQuantityUnit({ quantity: quantity === undefined ? null : quantity, unit: unit === undefined ? null : unit }, null);
  const pid = cleanId(placeId, "Place");
  const last = chemicalId === "last";
  const cid = last ? null : cleanId(chemicalId, "Chemical");
  const note = containerNote ? cleanStr(containerNote, 300, "Container note") : null;
  const spill = spillCompound ? cleanStr(spillCompound, 200, "Spill compound") : null;
  return [
    env.DB.prepare(
      `INSERT INTO chemical_places (chemical_id, place_id, quantity, unit, container_note, spill_compound)
       VALUES (${last ? "last_insert_rowid()" : "?"}, ?, ?, ?, ?, ?)`
    ).bind(...(last ? [] : [cid]), pid, qu.quantity ?? null, qu.unit ?? null, note, spill),
    env.DB.prepare("UPDATE places SET chemical_count = chemical_count + 1, updated_at = datetime('now') WHERE id = ?").bind(pid),
  ];
}

async function addLink(env, chemicalId, placeId, body) {
  const chem = await env.DB.prepare("SELECT id FROM chemicals WHERE id = ?").bind(chemicalId).first();
  if (!chem) throw new ApiError(404, "Chemical not found");
  await validatePlaceLink(env, placeId);
  const dup = await env.DB.prepare("SELECT id FROM chemical_places WHERE chemical_id = ? AND place_id = ?").bind(chemicalId, placeId).first();
  if (dup) throw bad("That chemical is already recorded at this place. Edit the existing entry instead.");
  const qu = cleanQuantityUnit(body, null);
  const extras = cleanLinkExtras(body);
  const res = await env.DB.batch(linkChemicalToPlaceStatements(env, {
    chemicalId, placeId, quantity: qu.quantity, unit: qu.unit, containerNote: extras.container_note, spillCompound: extras.spill_compound,
  }));
  return res[0].meta.last_row_id;
}

export async function handleAddChemicalToPlace(c) {
  const placeId = cleanId(c.p[0], "Place");
  const body = await readJson(c.request);
  const id = await addLink(c.env, cleanId(body.chemical_id, "Chemical"), placeId, body);
  return json({ id }, 201);
}

export async function handleAddPlaceToChemical(c) {
  const chemId = cleanId(c.p[0], "Chemical");
  const body = await readJson(c.request);
  const id = await addLink(c.env, chemId, cleanId(body.place_id, "Place"), body);
  return json({ id }, 201);
}

export async function handleUpdateLink(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Entry");
  const body = await readJson(c.request);
  const row = await env.DB.prepare("SELECT id, quantity, unit FROM chemical_places WHERE id = ?").bind(id).first();
  if (!row) throw new ApiError(404, "Entry not found");
  const f = { ...cleanQuantityUnit(body, row), ...cleanLinkExtras(body) };
  const keys = Object.keys(f);
  if (!keys.length) throw bad("Nothing to update");
  await env.DB.prepare(`UPDATE chemical_places SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map(k => f[k]), id).run();
  return json({ ok: true });
}

export async function handleDeleteLink(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Entry");
  const row = await env.DB.prepare("SELECT id, place_id FROM chemical_places WHERE id = ?").bind(id).first();
  if (!row) throw new ApiError(404, "Entry not found");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chemical_places WHERE id = ?").bind(id),
    env.DB.prepare("UPDATE places SET chemical_count = MAX(chemical_count - 1, 0), updated_at = datetime('now') WHERE id = ?").bind(row.place_id),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------- places CRUD

export async function handleListPlaces(c) {
  const a = c.url.searchParams.get("archived") || "0";
  if (!["0", "1", "all"].includes(a)) throw bad("archived must be 0, 1 or all");
  const where = a === "all" ? "" : "WHERE archived = ?";
  const sql = `SELECT ${PLACE_COLS} FROM places ${where} ORDER BY ${a === "all" ? "archived, " : ""}place_type, name COLLATE NOCASE`;
  const { results } = await (a === "all" ? c.env.DB.prepare(sql) : c.env.DB.prepare(sql).bind(Number(a))).all();
  return json(results);
}

export async function handleCreatePlace(c) {
  const { env } = c;
  const f = cleanPlace(await readJson(c.request), { create: true });
  if (f.registration && f.place_type !== "vehicle") throw bad("Only vehicles have a registration");
  await assertNameFree(env, f.name, f.place_type, 0);
  const counts = f.counts_toward_totals !== undefined ? f.counts_toward_totals : (defaultCountsTowardTotals(f.place_type) ? 1 : 0);
  const r = await env.DB.prepare(
    "INSERT INTO places (name, place_type, registration, counts_toward_totals, notes) VALUES (?, ?, ?, ?, ?)"
  ).bind(f.name, f.place_type, f.registration ?? null, counts, f.notes ?? null).run();
  return json({ id: r.meta.last_row_id }, 201);
}

export async function handleUpdatePlace(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Place");
  const body = await readJson(c.request);
  const old = await env.DB.prepare(`SELECT ${PLACE_COLS} FROM places WHERE id = ?`).bind(id).first();
  if (!old) throw new ApiError(404, "Place not found");
  const f = cleanPlace(body, { create: false });
  const next = { ...old, ...f };
  if (next.place_type !== "vehicle") {
    if (f.registration) throw bad("Only vehicles have a registration");
    if (old.registration) f.registration = null; // a place that stops being a vehicle loses its registration
  }
  if (!Object.keys(f).length) throw bad("Nothing to update");
  if (!next.archived && (f.name !== undefined || f.place_type !== undefined || (f.archived === 0 && old.archived))) {
    await assertNameFree(env, next.name, next.place_type, id);
  }
  const keys = Object.keys(f);
  const sets = keys.map(k => `${k} = ?`);
  const vals = keys.map(k => f[k]);
  if (f.archived !== undefined && f.archived !== old.archived) sets.push(f.archived ? "archived_at = datetime('now')" : "archived_at = NULL");
  await env.DB.prepare(`UPDATE places SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...vals, id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- one place, with its chemicals and totals

function entryOf(l, name) {
  return {
    place_id: l.place_id, id: l.link_id, chemical_id: l.chemical_id, name, classification: parseJson(l.ghs_classification, null),
    quantity: l.quantity, unit: l.unit, spill_compound: l.spill_compound,
  };
}

export async function handleGetPlace(c) {
  const { env } = c;
  const id = cleanId(c.p[0], "Place");
  const place = await env.DB.prepare(`SELECT ${PLACE_COLS} FROM places WHERE id = ?`).bind(id).first();
  if (!place) throw new ApiError(404, "Place not found");
  const admin = c.user && c.user.role === "admin";
  const auditsSql = `SELECT id, started_by_name, started_at, finished_at, status, summary FROM audits WHERE place_id = ? ${admin ? "" : "AND started_by = ? "}ORDER BY started_at DESC LIMIT 10`;
  const [linkRes, lastRes, auditRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT cp.id AS link_id, cp.place_id, cp.chemical_id, cp.quantity, cp.unit, cp.container_note, cp.spill_compound,
              c.product_name, c.supplier, c.decision, c.ghs_classification, c.decision_override, c.pictograms_override, c.pictograms,
              c.signal_word, c.risk_level, c.sds_id, c.sds_issue_date, c.review_due
       FROM chemical_places cp JOIN chemicals c ON c.id = cp.chemical_id WHERE cp.place_id = ?`
    ).bind(id),
    env.DB.prepare("SELECT last_audited_at FROM place_audit_summary WHERE place_id = ?").bind(id),
    env.DB.prepare(auditsSql).bind(...(admin ? [id] : [id, c.user.id])),
  ]);
  const results = linkRes.results;
  const today = todayIso();
  const chemicals = results.map(r => {
    const cls = parseJson(r.ghs_classification, null);
    const eff = effective(cls, { decision: r.decision_override, pictograms: overrideTextToValue(r.pictograms_override) });
    return {
      link_id: r.link_id, chemical_id: r.chemical_id, product_name: r.product_name, supplier: r.supplier, decision: r.decision,
      decision_overridden: eff.decision_overridden, pictograms: r.pictograms, signal_word: r.signal_word, risk_level: r.risk_level,
      sds_id: r.sds_id, sds_issue_date: r.sds_issue_date, review_due: r.review_due,
      review_status: reviewStatus(r.review_due, r.sds_id, today), has_assessment: r.risk_level !== null && r.risk_level !== undefined,
      classification: cls, quantity: r.quantity, unit: r.unit, container_note: r.container_note, spill_compound: r.spill_compound,
    };
  }).sort((a, b) => String(a.product_name).toLowerCase().localeCompare(String(b.product_name).toLowerCase()) || a.link_id - b.link_id);
  const entries = results.map(r => entryOf(r, r.product_name));
  const result = computePlaceTotals([place], entries)[0];
  const lastAudited = lastRes.results[0] ? lastRes.results[0].last_audited_at : null;
  const audits = auditRes.results.map(a => ({ ...a, summary: parseJson(a.summary, null) }));
  return json({ place: { ...place, last_audited_at: lastAudited }, chemicals, result, last_audited_at: lastAudited, audits });
}

// ---------------------------------------------------------------- manifest per place

export async function handleManifest(c) {
  const { env } = c;
  const placesRes = await env.DB.prepare(`SELECT ${PLACE_COLS} FROM places WHERE archived = 0 ORDER BY place_type, name COLLATE NOCASE`).all();
  const places = placesRes.results;
  const counting = places.filter(p => p.counts_toward_totals);
  let links = [];
  if (counting.length) {
    const r = await env.DB.prepare(
      `SELECT cp.id AS link_id, cp.place_id, cp.chemical_id, cp.quantity, cp.unit, cp.container_note, cp.spill_compound,
              c.product_name, c.supplier, c.decision, c.ghs_classification, c.signal_word, c.pictograms,
              s.un_number, s.dg_class, s.subsidiary_class, s.packing_group, s.hazchem_code, s.proper_shipping_name
       FROM places p JOIN chemical_places cp ON cp.place_id = p.id JOIN chemicals c ON c.id = cp.chemical_id LEFT JOIN sds s ON s.id = c.sds_id
       WHERE p.archived = 0 AND p.counts_toward_totals = 1`
    ).all();
    links = r.results;
  }
  const entries = links.map(l => entryOf(l, l.product_name));
  const results = computePlaceTotals(places, entries);
  const out = { places: [], not_counted: [] };
  const summary = { over_placard: [], over_manifest: [], near_placard: [] };
  for (const res of results) {
    const p = res.place;
    if (!res.counts) { out.not_counted.push({ place: p, note: res.note, caveat: res.caveat }); continue; }
    const itemsByLink = new Map();
    for (const t of res.totals.items) for (const k of t.contributors) {
      if (!k.counted || k.location_id == null) continue;
      const set = itemsByLink.get(k.location_id) || new Set();
      set.add(t.item); itemsByLink.set(k.location_id, set);
    }
    const rows = links.filter(l => l.place_id === p.id && l.decision === "hazardous").map(l => ({
      link_id: l.link_id, chemical_id: l.chemical_id, product_name: l.product_name, supplier: l.supplier, quantity: l.quantity, unit: l.unit,
      container_note: l.container_note, spill_compound: l.spill_compound, classification: parseJson(l.ghs_classification, null),
      items: [...(itemsByLink.get(l.link_id) || [])].sort((a, b) => a - b),
      un_number: l.un_number, dg_class: l.dg_class, subsidiary_class: l.subsidiary_class, packing_group: l.packing_group,
      hazchem_code: l.hazchem_code, proper_shipping_name: l.proper_shipping_name, signal_word: l.signal_word, pictograms: l.pictograms,
    })).sort((a, b) => String(a.product_name).toLowerCase().localeCompare(String(b.product_name).toLowerCase()) || a.link_id - b.link_id);
    out.places.push({ place: p, counts: true, totals: res.totals, over: res.over, near: res.near, rows });
    if (res.over.placard.length) summary.over_placard.push({ place_id: p.id, place_name: p.name, items: res.over.placard });
    if (res.over.manifest.length) summary.over_manifest.push({ place_id: p.id, place_name: p.name, items: res.over.manifest });
    if (res.near.placard.length) summary.near_placard.push({ place_id: p.id, place_name: p.name, items: res.near.placard });
  }
  return json({ generated_at: new Date().toISOString(), ...out, summary });
}

// ---------------------------------------------------------------- job pack data

export async function handlePack(c) {
  const { env } = c;
  const raw = (c.url.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!raw.length) throw bad("ids is required, like ?ids=1,2,3");
  if (raw.length > 100) throw bad("A pack can hold at most 100 chemicals");
  const ids = [...new Set(raw.map(x => cleanId(x, "Chemical id")))];
  const marks = ids.map(() => "?").join(",");
  const [chemRes, assessRes, placeRes] = await env.DB.batch([
    env.DB.prepare(`SELECT ${CHEM_PUBLIC_COLS} FROM chemicals WHERE id IN (${marks})`).bind(...ids),
    env.DB.prepare(
      `SELECT id, chemical_id, sds_id, is_current, assessed_date, sds_date, form, use_description, route_inhalation, route_ingestion,
         route_absorption, fire_response, spill_response, controls_notes, ppe_notes, risk_level, monitoring_needed, monitoring_note,
         surveillance_needed, surveillance_note, assessed_by, source, unverified, created_at, updated_at
       FROM assessments WHERE chemical_id IN (${marks}) AND is_current = 1`
    ).bind(...ids),
    env.DB.prepare(
      `SELECT cp.id AS link_id, cp.chemical_id, cp.place_id, p.name, p.place_type, p.registration, p.archived, p.counts_toward_totals,
              cp.quantity, cp.unit, cp.container_note, cp.spill_compound
       FROM chemical_places cp JOIN places p ON p.id = cp.place_id WHERE cp.chemical_id IN (${marks})`
    ).bind(...ids),
  ]);
  const chems = chemRes.results;
  const sdsIds = [...new Set(chems.map(x => x.sds_id).filter(Boolean))];
  const assessIds = assessRes.results.map(a => a.id);
  const second = [];
  if (sdsIds.length) second.push(env.DB.prepare(`SELECT ${SDS_PUBLIC} FROM sds s WHERE s.id IN (${sdsIds.map(() => "?").join(",")})`).bind(...sdsIds));
  if (assessIds.length) {
    second.push(env.DB.prepare(
      `SELECT ac.assessment_id, o.id, o.kind, o.label FROM assessment_controls ac JOIN control_options o ON o.id = ac.option_id
       WHERE ac.assessment_id IN (${assessIds.map(() => "?").join(",")}) ORDER BY o.kind, o.sort_order, o.id`
    ).bind(...assessIds));
  }
  const res2 = second.length ? await env.DB.batch(second) : [];
  let k = 0;
  const sdsById = new Map(sdsIds.length ? res2[k++].results.map(s => [s.id, s]) : []);
  const controls = new Map();
  if (assessIds.length) for (const r of res2[k++].results) {
    const a = controls.get(r.assessment_id) || []; a.push({ id: r.id, kind: r.kind, label: r.label }); controls.set(r.assessment_id, a);
  }
  const assessByChem = new Map(assessRes.results.map(a => [a.chemical_id, { ...a, controls: controls.get(a.id) || [] }]));
  const placesByChem = new Map();
  for (const p of placeRes.results) { const a = placesByChem.get(p.chemical_id) || []; const { chemical_id, ...rest } = p; a.push(rest); placesByChem.set(p.chemical_id, a); }
  const today = todayIso();
  const byId = new Map(chems.map(x => [x.id, x]));
  const out = [];
  for (const id of ids) {
    const chem = byId.get(id);
    if (!chem) continue;
    chem.review_status = reviewStatus(chem.review_due, chem.sds_id, today);
    decorateChemical(chem);
    out.push({ chemical: chem, sds: chem.sds_id ? sdsById.get(chem.sds_id) || null : null, assessment: assessByChem.get(id) || null, places: placesByChem.get(id) || [] });
  }
  return json({ generated_at: new Date().toISOString(), chemicals: out });
}
