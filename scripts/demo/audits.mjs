// The demo's chemical audits, built the way the Worker would write them (docs/AUDIT-CHANGE.md).
//   id 1  Ute 2, FINISHED 3 days ago by demo-user: 17 items (14 present, 1 not found, 1 changed + notes), 2 found items (one became a
//         "needs an SDS" chemical, one matched an existing chemical and became a found_link finding), 2 disposals (one open, one closed by demo-admin), 10 photos.
//   id 2  Tallowood workshop, IN PROGRESS today by demo-user: about a third of the 62 items marked, 1 photo.
//   id 3  Tallowood workshop, FINISHED 130 days ago by demo-admin: its findings are one accepted and one dismissed (so all three states show).
// Photos are generated JPEGs written to <out>/photos/audits/<audit id>/<uuid>.jpg.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPhoto, W, H } from './photos.mjs';

export const AUDIT_IDS = { ute2: 1, workshop_in_progress: 2, workshop_old: 3 };

const sha = s => createHash('sha256').update(s).digest('hex');
const uuid = s => { const h = sha(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

export function buildAudits(ctx) {
  const { T, today, iso, addDays, parse, chemRows, linkRows, assessRows, placeRows, outDir } = ctx;
  const byFrag = frag => { const h = chemRows.filter(c => c.product_name.includes(frag)); if (h.length !== 1) throw new Error('audit fragment ' + frag + ' matches ' + h.length); return h[0]; };
  const pad = n => String(n).padStart(2, '0');
  const at = (dayIso, hh, mm, plus = 0) => { const t = hh * 60 + mm + plus; return `${dayIso}T${pad(Math.floor(t / 60))}:${pad(t % 60)}:00.000Z`; };
  const sqlTime = isoStr => isoStr.slice(0, 10) + ' ' + isoStr.slice(11, 19);
  const soon = iso(addDays(T, 90));
  const statusOf = c => !c.sds_id ? 'no_sds' : !c.review_due ? 'unknown' : c.review_due < today ? 'overdue' : c.review_due <= soon ? 'due_soon' : 'ok';
  const RANK = { overdue: 0, due_soon: 1, no_sds: 2, unknown: 3, ok: 4 };
  const hasAssessment = id => assessRows.some(a => a.chemical_id === id && a.is_current === 1);
  const place = id => placeRows.find(p => p.id === id);
  const users = { admin: { id: 1, name: 'Demo Admin' }, user: { id: 2, name: 'Demo User' } };

  const audits = [], items = [], found = [], disposals = [], findings = [], photos = [], photoFiles = [];
  let itemId = 1, foundId = 1, dispId = 1, findId = 1, photoId = 1;

  const snapshotItems = (auditId, placeId, order) => {
    const links = linkRows.filter(l => l.place_id === placeId && chemRows[l.chemical_id - 1].source !== 'audit');   // the placeholder was found during the audit, so it was not listed at the start
    const rows = links.map(l => { const c = chemRows[l.chemical_id - 1]; return { l, c, st: statusOf(c) }; })
      .sort((a, b) => RANK[a.st] - RANK[b.st] || a.c.product_name.localeCompare(b.c.product_name));
    return rows.map(({ l, c, st }) => ({
      id: itemId++, audit_id: auditId, chemical_id: c.id, link_id: l.id, product_name: c.product_name, supplier: c.supplier,
      expected_quantity: l.quantity, expected_unit: l.unit, expected_container_note: l.container_note, review_due: c.review_due, review_status: st,
      has_sds: c.sds_id ? 1 : 0, has_assessment: hasAssessment(c.id) ? 1 : 0, risk_level: c.risk_level,
      result: null, note: null, new_quantity: null, new_unit: null, new_container_note: null, marked_at: null,
    }));
  };
  const summaryOf = (auditId, finishedAt) => {
    const its = items.filter(i => i.audit_id === auditId);
    const ph = photos.filter(p => p.audit_id === auditId && p.taken_at <= finishedAt);
    return { listed: its.length, present: its.filter(i => i.result === 'present').length, not_found: its.filter(i => i.result === 'not_found').length,
      changed: its.filter(i => i.result === 'changed').length, not_marked: its.filter(i => !i.result).length,
      found: found.filter(f => f.audit_id === auditId).length, disposals: disposals.filter(d => d.audit_id === auditId).length,
      photos: ph.length, photo_bytes: ph.reduce((s, p) => s + p.bytes, 0) };
  };
  const addPhoto = (auditId, ownerType, ownerKey, takenAt, scene, uploadedBy) => {
    const id = photoId++;
    const clientId = uuid(`photo-client:${id}`), fileId = uuid(`photo-file:${id}`);
    const img = renderPhoto({ seed: id, color: id, ...scene });
    const r2 = `audits/${auditId}/${fileId}.jpg`;
    mkdirSync(join(outDir, 'photos', 'audits', String(auditId)), { recursive: true });
    writeFileSync(join(outDir, 'photos', r2), img.data);
    photos.push({ id, audit_id: auditId, client_id: clientId, owner_type: ownerType, owner_key: ownerKey, r2_key: r2, content_type: 'image/jpeg', bytes: img.data.length, width: W, height: H,
      taken_at: takenAt, uploaded_by: uploadedBy, created_at: sqlTime(takenAt) });
    photoFiles.push({ r2_key: r2, bytes: img.data.length });
    return clientId;
  };
  const auditRow = (a) => ({ ...a });

  // ================================================================== audit 1: Ute 2, finished, demo-user
  const dayA = iso(addDays(T, -3));
  const startA = at(dayA, 9, 10), finishA = at(dayA, 10, 5);
  const ute2 = place(4);
  audits.push(auditRow({ id: 1, client_id: uuid('audit:1'), place_id: 4, place_name: ute2.name, place_type: ute2.place_type, place_registration: ute2.registration,
    started_by: 2, started_by_name: users.user.name, started_at: startA, finished_at: finishA, finished_by: 2, finished_by_name: users.user.name, status: 'finished',
    notes: 'Quick check before the Smith Street job.', summary: null, received_at: sqlTime(finishA) }));
  const itemsA = snapshotItems(1, 4);
  items.push(...itemsA);
  const mark = (frag, result, extra = {}) => { const c = byFrag(frag); const it = itemsA.find(i => i.chemical_id === c.id); if (!it) throw new Error('not an item: ' + frag); Object.assign(it, { result, ...extra }); return it; };
  itemsA.forEach((it, i) => { it.result = 'present'; it.marked_at = at(dayA, 9, 10, 3 + 2 * i); });
  const petrol = mark('Unleaded Petrol', 'changed', { note: 'Used on the mower. Topped up with two-stroke by mistake? Check.', new_quantity: 5, new_unit: 'L', new_container_note: 'Half-used 10 L jerry can' });
  mark('Liquid Chlorine', 'not_found', { note: 'Not in the tray. Maybe left at the school job.' });
  mark('Soldering Flux', 'present', { note: 'Lid cracked, taped up for now.' });
  mark('Concrete Sealer', 'present', { note: 'Still no label and no SDS.' });
  const minOf = frag => 3 + 2 * itemsA.findIndex(i => i.chemical_id === byFrag(frag).id);
  const phA = (type, key, min, scene) => addPhoto(1, type, key, at(dayA, 9, 10, min), scene, 2);
  phA('item', String(petrol.chemical_id), minOf('Unleaded Petrol') + 1, { kind: 'jerry', lines: ['UNLEADED', 'PETROL'] });
  phA('item', String(byFrag('Soldering Flux').id), minOf('Soldering Flux') + 1, { kind: 'tin', lines: ['SOLDERING', 'FLUX'] });
  phA('item', String(byFrag('Concrete Sealer').id), minOf('Concrete Sealer') + 1, { kind: 'tin', lines: ['NO LABEL', 'SEALER?'] });
  // found items
  const placeholder = chemRows.find(c => c.source === 'audit');
  const dish = byFrag('Dishwashing Detergent');
  const f1Client = uuid('found:1'), f2Client = uuid('found:2');
  found.push({ id: foundId++, audit_id: 1, client_id: f1Client, product_name: placeholder.product_name.replace(/ \(.*\)$/, ''), supplier: placeholder.supplier, source: 'ai', ai_provider: 'demo label reader',
    matched_chemical_id: null, chemical_id: placeholder.id, outcome: 'created', note: 'Tub under the passenger seat. Label read from the photo.', found_at: at(dayA, 9, 10, 38), created_at: sqlTime(at(dayA, 9, 10, 38)) });
  found.push({ id: foundId++, audit_id: 1, client_id: f2Client, product_name: dish.product_name, supplier: dish.supplier, source: 'typed', ai_provider: null,
    matched_chemical_id: dish.id, chemical_id: dish.id, outcome: 'link_suggested', note: 'A bottle in the door pocket.', found_at: at(dayA, 9, 10, 42), created_at: sqlTime(at(dayA, 9, 10, 42)) });
  phA('found', f1Client, 37, { kind: 'tub', lines: ['RAPIDSET', 'TILE ADHESIVE'] });
  phA('found', f1Client, 38, { kind: 'tub', lines: ['RAPIDSET', '5 KG'] });
  phA('found', f2Client, 42, { kind: 'bottle', lines: ['DISHWASHING', 'DETERGENT'] });
  // disposals
  const brake = byFrag('Brake and Parts Cleaner'), drain = byFrag('Drain Unblocker');
  const d1Client = uuid('disposal:1'), d2Client = uuid('disposal:2');
  disposals.push({ id: dispId++, audit_id: 1, client_id: d1Client, place_id: 4, place_name: ute2.name, chemical_id: brake.id, description: 'Brake cleaner aerosol, past its expiry date and the SDS is overdue', reason: 'expired',
    note: 'Two cans, one dented.', status: 'to_dispose', flagged_by: 2, flagged_by_name: users.user.name, flagged_at: at(dayA, 9, 10, 45), closed_by: null, closed_by_name: null, closed_at: null, close_note: null });
  const dayClose = iso(addDays(T, -2));
  disposals.push({ id: dispId++, audit_id: 1, client_id: d2Client, place_id: 4, place_name: ute2.name, chemical_id: drain.id, description: 'Cracked 1 L bottle of drain unblocker gel', reason: 'damaged',
    note: 'Leaking into the tray. Bagged it.', status: 'disposed', flagged_by: 2, flagged_by_name: users.user.name, flagged_at: at(dayA, 9, 10, 48),
    closed_by: 1, closed_by_name: users.admin.name, closed_at: at(dayClose, 10, 15), close_note: 'Taken to the council chemical drop-off. Receipt on file.' });
  phA('disposal', d1Client, 45, { kind: 'aerosol', lines: ['BRAKE', 'CLEANER'], tag: 'EXPIRED' });
  phA('disposal', d2Client, 48, { kind: 'bottle', lines: ['DRAIN', 'UNBLOCKER'], tag: 'CRACKED' });
  addPhoto(1, 'disposal_close', d2Client, at(dayClose, 10, 14), { kind: 'empty', lines: ['DISPOSED', 'DROP-OFF OK'] }, 1);
  phA('audit', null, 50, { kind: 'shelf', lines: ['UTE 2', 'KIT'] });
  // findings written when the audit finished
  const detail = it => JSON.stringify({ expected_quantity: it.expected_quantity, expected_unit: it.expected_unit, expected_container_note: it.expected_container_note, new_quantity: it.new_quantity, new_unit: it.new_unit, new_container_note: it.new_container_note, note: it.note });
  for (const it of itemsA.filter(i => i.result === 'not_found' || i.result === 'changed')) {
    findings.push({ id: findId++, audit_id: 1, kind: it.result, chemical_id: it.chemical_id, place_id: 4, place_name: ute2.name, product_name: it.product_name, link_id: it.link_id, audit_item_id: it.id, found_id: null,
      details: detail(it), status: 'open', created_at: sqlTime(finishA), resolved_by: null, resolved_by_name: null, resolved_at: null, resolve_note: null });
  }
  findings.push({ id: findId++, audit_id: 1, kind: 'found_link', chemical_id: dish.id, place_id: 4, place_name: ute2.name, product_name: dish.product_name, link_id: null, audit_item_id: null, found_id: found[1].id,
    details: JSON.stringify({ note: found[1].note, matched_chemical_id: dish.id }), status: 'open', created_at: sqlTime(finishA), resolved_by: null, resolved_by_name: null, resolved_at: null, resolve_note: null });
  audits[0].summary = JSON.stringify(summaryOf(1, finishA));

  // ================================================================== audit 2: workshop, in progress, demo-user
  const dayP = iso(T);
  const ws = place(1);
  audits.push(auditRow({ id: 2, client_id: uuid('audit:2'), place_id: 1, place_name: ws.name, place_type: ws.place_type, place_registration: null,
    started_by: 2, started_by_name: users.user.name, started_at: at(dayP, 8, 30), finished_at: null, finished_by: null, finished_by_name: null, status: 'in_progress',
    notes: null, summary: null, received_at: sqlTime(at(dayP, 8, 30)) }));
  const itemsP = snapshotItems(2, 1);
  items.push(...itemsP);
  const nP = Math.round(itemsP.length / 3);
  itemsP.slice(0, nP).forEach((it, i) => { it.result = 'present'; it.marked_at = at(dayP, 8, 30, 2 + i); });
  Object.assign(itemsP[3], { result: 'changed', note: 'One tin has been used up since the last check.', new_quantity: Math.max(0, (itemsP[3].expected_quantity || 1) - 1), new_unit: itemsP[3].expected_unit || 'L' });
  addPhoto(2, 'item', String(itemsP[0].chemical_id), at(dayP, 8, 30, 3), { kind: 'tin', lines: itemsP[0].product_name.toUpperCase().replace(/^[A-Z]+ /, '').split(' ').slice(0, 2) }, 2);

  // ================================================================== audit 3: workshop, finished 130 days ago, demo-admin
  const dayE = iso(addDays(T, -130)), dayR = iso(addDays(T, -129));
  const startE = at(dayE, 14, 0), finishE = at(dayE, 15, 10);
  audits.push(auditRow({ id: 3, client_id: uuid('audit:3'), place_id: 1, place_name: ws.name, place_type: ws.place_type, place_registration: null,
    started_by: 1, started_by_name: users.admin.name, started_at: startE, finished_at: finishE, finished_by: 1, finished_by_name: users.admin.name, status: 'finished',
    notes: 'Annual walk round.', summary: null, received_at: sqlTime(finishE) }));
  const itemsE = snapshotItems(3, 1);
  items.push(...itemsE);
  itemsE.forEach((it, i) => { it.result = 'present'; it.marked_at = at(dayE, 14, 0, 2 + i); });
  const turps = itemsE.find(i => i.chemical_id === byFrag('Mineral Turpentine').id);
  Object.assign(turps, { result: 'changed', expected_quantity: 28, new_quantity: turps.expected_quantity, new_unit: 'L', new_container_note: turps.expected_container_note, note: 'Two cans used on the Harbour Road job.' });
  const hand = itemsE.find(i => i.chemical_id === byFrag('Hand Cleaner Gel').id);
  Object.assign(hand, { result: 'not_found', note: 'Could not see the pump pack on the bench.' });
  findings.push({ id: findId++, audit_id: 3, kind: 'changed', chemical_id: turps.chemical_id, place_id: 1, place_name: ws.name, product_name: turps.product_name, link_id: turps.link_id, audit_item_id: turps.id, found_id: null,
    details: detail(turps), status: 'accepted', created_at: sqlTime(finishE), resolved_by: 1, resolved_by_name: users.admin.name, resolved_at: sqlTime(at(dayR, 9, 0)), resolve_note: null });
  findings.push({ id: findId++, audit_id: 3, kind: 'not_found', chemical_id: hand.chemical_id, place_id: 1, place_name: ws.name, product_name: hand.product_name, link_id: hand.link_id, audit_item_id: hand.id, found_id: null,
    details: detail(hand), status: 'dismissed', created_at: sqlTime(finishE), resolved_by: 1, resolved_by_name: users.admin.name, resolved_at: sqlTime(at(dayR, 9, 5)), resolve_note: 'It is in the wash-room dispenser, still on the register.' });
  audits[2].summary = JSON.stringify(summaryOf(3, finishE));

  const placeAudit = [
    { place_id: 4, last_audit_id: 1, last_audited_at: finishA },
    { place_id: 1, last_audit_id: 3, last_audited_at: finishE },
  ];
  return { audits, items, found, disposals, findings, photos, photoFiles, placeAudit };
}
