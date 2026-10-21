#!/usr/bin/env node
// Builds the fictional SDS EZY demo: demo-out/demo.sql plus demo-out/pdfs/<r2 key>.
//   node scripts/make-demo.mjs [--today YYYY-MM-DD] [--out demo-out] [--quiet]
// Deterministic for a given --today. Needs no network and touches nothing outside --out.
import { createHash, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANY, SUPPLIERS } from './demo/text.mjs';
import { SDS, CHEMICALS, USERS, DEMO_PASSWORD } from './demo/data.mjs';
import { buildSdsPdf, hList, pList, classificationText, derivedFor } from './demo/pdf.mjs';
import { UNCONFIRMED_CATEGORY } from './demo/classes.mjs';
import { buildAudits } from './demo/audits.mjs';
import { PLACES, SAMPLE_PACK, resolveLinks } from './demo/places.mjs';
import { effective, derive, parsePictogramList, classificationLabel, computePlaceTotals } from '../public/lib/ghs-ref.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = s => createHash('sha256').update(s).digest('hex');
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- dates ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
function addMonths(d, n) { // same day, clamped to the end of a shorter month
  const day = d.getUTCDate();
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
export const reviewDue = issue => iso(addMonths(parse(issue), 60)); // 29 Feb + 5 years clamps to 28 Feb

// ---------- SQL ----------
const q = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const row = (table, obj) => `INSERT INTO ${table} (${Object.keys(obj).join(', ')}) VALUES (${Object.values(obj).map(q).join(', ')});`;

// ---------- assessment content by hazard tag ----------
const OPT = {
  cabinet: ['isolation', 'Stored in a flammable liquids cabinet'], lids: ['isolation', 'Lids kept on containers when not in use'],
  bund: ['isolation', 'Stored in a bunded or spill-contained area'], seg: ['isolation', 'Segregated from incompatible chemicals'],
  locked: ['isolation', 'Locked or access restricted storage'],
  natvent: ['ventilation', 'Natural / general ventilation'], lev: ['ventilation', 'Local exhaust ventilation'], outdoors: ['ventilation', 'Use outdoors or in an open area'],
  small: ['other', 'Small quantities only'], short: ['other', 'Keep exposure time short'], readsds: ['other', 'Read the SDS before use'],
  noign: ['other', 'No ignition sources nearby'], spill: ['other', 'Spill kit available'], wash: ['other', 'Wash hands after use; no eating or drinking'],
  glasses: ['ppe', 'Safety glasses'], gloves: ['ppe', 'Chemical-resistant gloves'], overalls: ['ppe', 'Overalls or long sleeves'], boots: ['ppe', 'Safety footwear'],
  goggles: ['additional_ppe', 'Chemical goggles'], shield: ['additional_ppe', 'Face shield'], p2: ['additional_ppe', 'P2 dust mask'],
  resp: ['additional_ppe', 'Half-face respirator with suitable filter'], apron: ['additional_ppe', 'Chemical-resistant apron'],
};
const CONTROLS = {
  flam: ['cabinet', 'lids', 'seg', 'natvent', 'noign', 'spill', 'readsds', 'glasses', 'gloves', 'overalls'],
  aer: ['seg', 'natvent', 'noign', 'short', 'glasses', 'gloves'],
  corr: ['bund', 'seg', 'locked', 'natvent', 'spill', 'readsds', 'wash', 'glasses', 'gloves', 'overalls', 'boots', 'goggles', 'apron'],
  gas: ['seg', 'locked', 'outdoors', 'noign', 'readsds', 'glasses', 'boots', 'overalls'],
  ox: ['seg', 'bund', 'natvent', 'spill', 'readsds', 'glasses', 'gloves', 'goggles', 'apron'],
  dust: ['natvent', 'short', 'wash', 'glasses', 'gloves', 'overalls', 'p2'],
  irrit: ['lids', 'natvent', 'wash', 'glasses', 'gloves'],
  sens: ['lev', 'readsds', 'short', 'glasses', 'gloves', 'overalls', 'goggles', 'resp'],
  env: ['bund', 'spill'],
  none: ['lids', 'wash'],
};
const FIRE_R = {
  flam: 'Foam, dry chemical or CO2 extinguisher. Do not use a water jet. Evacuate and call 000 if the fire is not small.',
  aer: 'Cool containers if safe, use foam, dry chemical or CO2. Evacuate: cans can burst and rocket.',
  corr: 'Not flammable. Use an extinguisher suitable for the surrounding fire. Avoid breathing fumes.',
  gas: 'Shut the valve only if safe. Cool cylinders with water from a distance and evacuate. Call 000.',
  ox: 'Flood with water. Keep away from combustibles. Evacuate and call 000 if the fire is not small.',
  dust: 'Not combustible. Use an extinguisher suitable for the surrounding fire.',
  irrit: 'Not combustible. Use an extinguisher suitable for the surrounding fire.',
  sens: 'Use an extinguisher suitable for the fire. Cans may burst. Avoid breathing fumes.',
  env: 'Use an extinguisher suitable for the surrounding fire.',
  none: 'Not combustible. Use an extinguisher suitable for the surrounding fire.',
};
const SPILL_R = {
  flam: 'Remove ignition sources, ventilate, absorb with spill pads or sand, bag and label as waste. Keep out of drains.',
  aer: 'Ventilate. Move damaged cans outdoors. Wipe up residue.',
  corr: 'Wear goggles, gloves and apron. Contain and absorb, neutralise small spills, label as waste. Keep out of drains. Flush skin and eyes at once.',
  gas: 'Leave the area, ventilate, close the valve only if safe and tell the supervisor.',
  ox: 'Dilute with plenty of water, keep away from combustibles, do not return spilt product to the container.',
  dust: 'Sweep up damp or vacuum with a suitable filter. Avoid raising dust.',
  irrit: 'Absorb with a cloth or pad and wash the area with water.',
  sens: 'Ventilate, wear gloves and respirator, absorb and bag the waste.',
  env: 'Keep out of drains and waterways.',
  none: 'Wipe up and wash the area with water.',
};

function primaryTag(tags) { return ['corr', 'ox', 'flam', 'aer', 'gas', 'sens', 'dust', 'irrit', 'env', 'none'].find(t => tags.includes(t)); }

function assessmentFor(c, spec, ctx) {
  const tags = spec ? spec.tags : ['flam'];
  const t = primaryTag(tags);
  const hz = spec ? !!spec.hz : true;
  const form = c.form || spec?.form || 'other';
  let labels = [];
  const add = list => list.forEach(k => { if (!labels.includes(k)) labels.push(k); });
  add(CONTROLS[t]);
  if (tags.includes('flam') && t !== 'flam') add(['noign']);
  if (tags.includes('corr') && t !== 'corr') add(['goggles', 'gloves']);
  if (tags.includes('sens') && t !== 'sens') add(['gloves']);
  let risk = { n: 'not_significant', c: 'significant_controlled', x: 'significant_not_controlled', u: 'uncertain' }[c.risk];
  if (c.risk === 'n') labels = hz ? labels.filter(k => ['lids', 'seg', 'natvent', 'wash', 'glasses', 'gloves', 'readsds'].includes(k)) : labels;
  if (c.risk === 'x') labels = labels.filter(k => !['gloves', 'goggles', 'shield', 'apron', 'lev', 'bund', 'locked'].includes(k)).slice(0, 5);
  if (c.risk === 'u') labels = [];
  const routes = {
    route_inhalation: ['flam', 'aer', 'gas', 'dust', 'sens', 'ox'].some(x => tags.includes(x)) || (tags.includes('corr') && form !== 'solid') ? 1 : 0,
    route_ingestion: 0,
    route_absorption: ['flam', 'corr', 'irrit', 'sens', 'dust'].some(x => tags.includes(x)) || form === 'paste' ? 1 : 0,
  };
  if (c.risk === 'u' && !spec) Object.assign(routes, { route_inhalation: 1, route_absorption: 1 });
  const a = {
    form,
    use_description: c.use + '. Typical use: weekly, up to 1 hour per task.',
    ...routes,
    fire_response: hz ? FIRE_R[t] : FIRE_R.none,
    spill_response: SPILL_R[t],
    controls_notes: c.risk === 'x' ? c.gap : c.risk === 'u' ? '' : hz ? 'Controls as ticked. Kept in the listed storage location and returned after use.' : 'No special controls beyond good housekeeping.',
    ppe_notes: c.risk === 'u' ? '' : tags.includes('gas') ? 'Gloves for handling cylinders and hot work as per the welding procedure.' : hz ? 'PPE as ticked and as required by section 8 of the SDS.' : '',
    risk_level: risk,
    monitoring_needed: c.risk === 'u' ? null : (c.n.includes('Lacquer Thinners') ? 1 : 0),
    monitoring_note: c.risk === 'u' ? '' : (c.n.includes('Lacquer Thinners') ? 'Toluene is used at the spray bench. Consider atmospheric monitoring once extraction is fixed.' : 'Not needed at these quantities and exposure times.'),
    surveillance_needed: c.risk === 'u' ? null : (c.surv ? 1 : 0),
    surveillance_note: c.risk === 'u' ? '' : (c.surv || 'Not required.'),
    controls: labels.map(k => OPT[k]),
  };
  return a;
}

// ---------- build ----------
export async function build({ today, outDir, log = () => {} }) {
  const T = parse(today);
  const out = resolve(outDir);
  rmSync(join(out, 'pdfs'), { recursive: true, force: true });
  rmSync(join(out, 'photos'), { recursive: true, force: true });
  mkdirSync(join(out, 'pdfs', 'sds'), { recursive: true });

  // chemicals per sds key (for the product list and codes on each sheet)
  const bySds = {};
  for (const c of CHEMICALS) if (c.sds) (bySds[c.sds] ||= []).push(c);

  // ---- sds rows
  const sdsRows = [];
  const sdsByKey = {};
  let nextId = 1;
  const files = [];
  for (const s of SDS) {
    const id = nextId++;
    const issue = s.noDate ? null : iso(addDays(addMonths(T, -s.ago), -(s.agoD || 0)));
    const docKey = 'demo-' + sha('doc:' + (s.doc || s.k)).slice(0, 16);
    const isCurrent = s.current === false ? 0 : 1;
    const rand = sha('r2:' + s.k).slice(0, 12);
    const r2 = `sds/${id}-${rand}.pdf`;
    const chems = bySds[s.k] || bySds[s.doc] || [];
    const replacesIssue = s.replaces ? iso(addDays(addMonths(T, -SDS.find(x => x.k === s.replaces).ago), 0)) : null;
    const pdf = await buildSdsPdf(s, { issue, codes: chems.map(c => c.codes), products: chems.length > 1 ? chems.map(c => c.n) : [], replacesIssue, versionNo: s.version || 1 });
    const pdfPath = join(out, 'pdfs', r2);
    writeFileSync(pdfPath, pdf);
    const [un, cls, sub, pg, hc, psn] = s.dg || [null, null, null, null, null, null];
    const uploaded = issue ? iso(addDays(parse(issue), 3)) + ' 09:00:00' : iso(addDays(T, -300)) + ' 09:00:00';
    const row_ = {
      id, doc_key: docKey, version_no: s.version || 1, is_current: isCurrent,
      title: s.t, supplier: SUPPLIERS[s.s].name, r2_key: r2,
      file_name: s.t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-sds.pdf',
      file_size: pdf.length, file_hash: createHash('sha256').update(pdf).digest('hex'),
      issue_date: issue, revision: s.rev, emergency_phone: SUPPLIERS[s.s].phone,
      review_due: issue ? reviewDue(issue) : null,
      signal_word: s.hz ? derivedFor(s).signal_word : null,
      hazard_classification: s.hz ? classificationText(s) : 'Not classified as hazardous',
      h_statements: s.hz ? hList(s).join('; ') : null,
      p_statements: s.hz ? pList(s).join('; ') : null,
      poison_schedule: s.ps || null,
      un_number: un, dg_class: cls, subsidiary_class: sub || null, packing_group: pg || null, hazchem_code: hc, proper_shipping_name: psn,
      cas_numbers: s.cas.join(','), unverified: UNCONFIRMED_CATEGORY[s.k] ? JSON.stringify(['classification']) : null, source: 'demo', ai_provider: null,
      uploaded_by: 1, uploaded_at: uploaded,
      replaced_at: null,
    };
    sdsRows.push(row_); sdsByKey[s.k] = row_;
    files.push({ id, r2_key: r2, bytes: pdf.length });
  }
  // the replaced version records when the newer one took over
  for (const s of SDS) if (s.replaces) sdsByKey[s.replaces].replaced_at = sdsByKey[s.k].uploaded_at;

  // ---- chemicals, locations, assessments
  const chemRows = [], assessRows = [], controlRows = [];
  let aId = 1;
  CHEMICALS.forEach((c, i) => {
    const id = i + 1;
    const spec = c.sds ? SDS.find(x => x.k === c.sds) : null;
    const sdsRow = c.sds ? sdsByKey[c.sds] : null;
    // GHS classification (null = not classified yet), then the effective decision / signal word / pictograms exactly as the Worker computes them
    let cl;
    if (c.unclassified) cl = null;
    else if (c.classification === 'admin') cl = [{ c: 'flam_liq', k: '3', src: 'admin' }];
    else cl = spec.cls.map(([cc, k]) => {
      const e = { c: cc, k, src: 'ai' };
      if (UNCONFIRMED_CATEGORY[c.sds] && UNCONFIRMED_CATEGORY[c.sds].c === cc) e.check = true;
      return e;
    });
    const flags = cl && cl.some(e => e.check) ? cl.filter(e => e.check).map(e => classificationLabel(e) + ': the hazard statement is in the SDS but the category could not be confirmed from the text. Check it against SDS section 2.') : null;
    const dv0 = derive(cl);
    const pOverride = c.pictograms_add ? dv0.pictograms.concat(c.pictograms_add).filter((x, ix, arr) => arr.indexOf(x) === ix).sort().join(',') : null;
    const eff = effective(cl, { decision: c.decision_override || null, pictograms: pOverride });
    const decision = eff.decision;
    const a = c.risk && !c.blank && !c.noAssessment ? assessmentFor(c, spec, {}) : null;
    const form = c.form || spec?.form || 'other';
    const riskLevel = c.blank ? 'uncertain' : a ? a.risk_level : null;   // noAssessment: no assessment row at all
    const cas = sdsRow ? sdsRow.cas_numbers.split(',') : [];
    const search = [c.n, sdsRow ? sdsRow.supplier : (c.supplier || ''), c.syn, c.codes, ...cas].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
    const created = iso(addDays(T, c.created_days_ago ? -c.created_days_ago : -380 + i)) + (c.created_days_ago ? ' 09:38:00' : ' 08:00:00');
    chemRows.push({
      id, product_name: c.n, supplier: sdsRow ? sdsRow.supplier : (c.supplier || null), synonyms: c.syn || null, product_codes: c.codes || null,
      use_description: c.use, physical_form: form,
      ghs_classification: cl === null ? null : JSON.stringify(cl), classification_flags: flags ? JSON.stringify(flags) : null,
      decision_override: c.decision_override || null, pictograms_override: pOverride, decision,
      decision_note: c.note || (decision === 'hazardous' ? 'Derived from the GHS classification (SDS section 2)' : decision === 'not_hazardous' ? 'No GHS classification applies per SDS section 2' : null),
      decision_by: decision ? 'Demo Admin' : null, decision_at: decision ? created : null,
      sds_id: sdsRow ? sdsRow.id : null, sds_issue_date: sdsRow ? sdsRow.issue_date : null, review_due: sdsRow ? sdsRow.review_due : null,
      risk_level: riskLevel, dg_class: sdsRow ? sdsRow.dg_class : null, signal_word: eff.signal_word, pictograms: eff.pictograms.length ? eff.pictograms.join(',') : null,
      source: c.source || 'demo', search_text: search, created_by: 1, created_at: created, updated_at: created,
    });

    const issued = sdsRow && sdsRow.issue_date ? parse(sdsRow.issue_date) : addDays(T, -300);
    const assessed = iso(new Date(Math.min(addDays(issued, 21 + (i * 11) % 120).getTime(), addDays(T, -5).getTime())));
    const base = { chemical_id: id, sds_id: sdsRow ? sdsRow.id : null, sds_date: sdsRow ? sdsRow.issue_date : null, assessed_date: assessed, created_by: 1, created_at: assessed + ' 10:00:00', updated_at: assessed + ' 10:00:00' };
    if (c.history) { // an older assessment made against version 1 of the sheet
      const v1 = sdsByKey['metho_v1'];
      const old = assessmentFor({ ...c, risk: 'u' }, SDS.find(x => x.k === 'metho_v1'), {});
      const od = iso(addDays(parse(v1.issue_date), 30));
      assessRows.push({ id: aId++, ...base, sds_id: v1.id, sds_date: v1.issue_date, assessed_date: od, is_current: 0, ...strip(old), risk_level: 'uncertain', assessed_by: 'Demo Admin', source: 'demo', answers: null, unverified: null, created_at: od + ' 10:00:00', updated_at: od + ' 10:00:00' });
    }
    if (c.blank) {
      assessRows.push({ id: aId++, ...base, is_current: 1, form, use_description: null, route_inhalation: 0, route_ingestion: 0, route_absorption: 0, fire_response: null, spill_response: null, controls_notes: null, ppe_notes: null, risk_level: 'uncertain', monitoring_needed: null, monitoring_note: null, surveillance_needed: null, surveillance_note: null, assessed_by: null, source: 'blank', answers: null, unverified: null });
    } else if (a) {
      const aid = aId++;
      const ai = i % 5 === 0 && a.risk_level !== 'uncertain';
      assessRows.push({ id: aid, ...base, is_current: 1, ...strip(a), assessed_by: ai ? 'Prepared from the SDS (AI draft)' : 'Demo Admin', source: ai ? 'ai' : 'demo', answers: null, unverified: null });
      for (const [kind, label] of a.controls) controlRows.push({ aid, kind, label });
    }
  });

  // ---- places and the chemical links (storage_locations is legacy and is not written)
  const linkRows = resolveLinks(CHEMICALS).map((l, i) => ({ id: i + 1, chemical_id: l.chemical_id, place_id: l.place_id, quantity: l.quantity, unit: l.unit, container_note: l.container_note, spill_compound: l.spill_compound, created_at: iso(addDays(T, -300)) + ' 08:00:00', place_key: l.place_key }));
  const placeRows = PLACES.map(p => ({ id: p.id, name: p.name, place_type: p.place_type, registration: p.registration, counts_toward_totals: p.counts_toward_totals, archived: p.archived,
    archived_at: p.archived ? p.archived_at : null, notes: p.notes, chemical_count: linkRows.filter(l => l.place_id === p.id).length, created_at: iso(addDays(T, -400)) + ' 08:00:00', updated_at: iso(addDays(T, -400)) + ' 08:00:00' }));
  const audit = buildAudits({ T, today, iso, addDays, parse, chemRows, linkRows, assessRows, placeRows, outDir: out });
  // ---- users, settings
  const users = USERS.map((u, i) => {
    const salt = Buffer.from(sha('salt:' + u.email).slice(0, 32), 'hex').subarray(0, 16);
    const hash = pbkdf2Sync(DEMO_PASSWORD, salt, 100000, 32, 'sha256');
    return { id: i + 1, name: u.name, email: u.email, password_hash: `100000:${b64url(salt)}:${b64url(hash)}`, role: u.role, color: u.color, active: 1, created_at: iso(addDays(T, -400)) + ' 08:00:00' };
  });
  const settings = {
    company_name: COMPANY.name, company_address: COMPANY.address, company_phone: COMPANY.phone, company_email: COMPANY.email, company_reg: COMPANY.reg,
    main_color: COMPANY.main_color, accent_color: COMPANY.accent_color, setup_complete: '1', twofa_enabled: '0', upload_max_mb: '15', upload_rate_per_hour: '10',
    audit_photo_max_mb: '2', audit_max_photos: '50', audit_max_total_mb: '40', label_read_rate_per_hour: '30', audit_reminder_days: '90',
  };

  // ---- write SQL
  const L = [];
  L.push('-- SDS EZY demo data (FICTIONAL). Generated by scripts/make-demo.mjs for --today ' + today + '. Do not load into a real register.');
  L.push('-- It first clears the register tables, so it only ever belongs in a throwaway or demo database.');
  for (const t of ['audit_ai_log', 'place_audit_summary', 'audit_photos', 'audit_findings', 'audit_disposals', 'audit_found', 'audit_items', 'audits', 'upload_log', 'login_codes', 'assessment_controls', 'assessments', 'chemical_places', 'storage_locations', 'places', 'chemicals', 'sds', 'users']) L.push(`DELETE FROM ${t};`);
  users.forEach(u => L.push(row('users', u)));
  for (const [k, v] of Object.entries(settings)) L.push(`INSERT OR REPLACE INTO settings (key, value) VALUES (${q(k)}, ${q(v)});`);
  sdsRows.forEach(r => L.push(row('sds', r)));
  chemRows.forEach(r => L.push(row('chemicals', r)));
  placeRows.forEach(r => L.push(row('places', r)));
  linkRows.forEach(({ place_key, ...r }) => L.push(row('chemical_places', r)));
  audit.audits.forEach(r => L.push(row('audits', r)));
  audit.items.forEach(r => L.push(row('audit_items', r)));
  audit.found.forEach(r => L.push(row('audit_found', r)));
  audit.disposals.forEach(r => L.push(row('audit_disposals', r)));
  audit.findings.forEach(r => L.push(row('audit_findings', r)));
  audit.photos.forEach(r => L.push(row('audit_photos', r)));
  audit.placeAudit.forEach(r => L.push(row('place_audit_summary', r)));
  assessRows.forEach(r => L.push(row('assessments', r)));
  controlRows.forEach(r => L.push(`INSERT INTO assessment_controls (assessment_id, option_id) VALUES (${r.aid}, (SELECT id FROM control_options WHERE kind = ${q(r.kind)} AND label = ${q(r.label)}));`));
  writeFileSync(join(out, 'demo.sql'), L.join('\n') + '\n');

  const summary = {
    today, chemicals: chemRows.length, sds_rows: sdsRows.length, pdfs: files.length,
    shared_sds: Object.fromEntries(Object.entries(bySds).filter(([, v]) => v.length > 1).map(([k, v]) => [k, v.length])),
    review: { overdue: 0, due_soon: 0, ok: 0, unknown: 0, no_sds: 0 }, risk: {}, decisions: {}, places: placeRows.length, links: linkRows.length, assessments: assessRows.length,
  };
  const soon = iso(addDays(T, 90));
  for (const c of chemRows) {
    const st = !c.sds_id ? 'no_sds' : !c.review_due ? 'unknown' : c.review_due < today ? 'overdue' : c.review_due <= soon ? 'due_soon' : 'ok';
    summary.review[st]++;
    summary.risk[c.risk_level || 'none'] = (summary.risk[c.risk_level || 'none'] || 0) + 1;
    summary.decisions[c.decision || 'none'] = (summary.decisions[c.decision || 'none'] || 0) + 1;
  }
  const entries = linkRows.filter(l => l.quantity !== null).map(l => { const ch = chemRows[l.chemical_id - 1]; return { place_id: l.place_id, id: l.id, chemical_id: ch.id, name: ch.product_name, classification: ch.ghs_classification ? JSON.parse(ch.ghs_classification) : null, quantity: l.quantity, unit: l.unit, spill_compound: l.spill_compound }; });
  const results = computePlaceTotals(placeRows, entries);
  summary.overrides = { decision: chemRows.filter(c => c.decision_override).length, pictograms: chemRows.filter(c => c.pictograms_override).length };
  summary.flagged = chemRows.filter(c => c.classification_flags).length;
  summary.not_classified = chemRows.filter(c => c.ghs_classification === null).length;
  summary.no_assessment = chemRows.filter(c => !assessRows.some(x => x.chemical_id === c.id && x.is_current)).map(c => c.id);
  summary.no_sds = chemRows.filter(c => !c.sds_id).map(c => c.id);
  summary.places_detail = results.map(r => ({ id: r.place.id, name: r.place.name, type: r.place.place_type, chemicals: r.place.chemical_count, counts: r.counts,
    over_placard: r.counts ? r.over.placard : [], near_placard: r.counts ? r.near.placard : [],
    items: r.counts ? r.totals.items.filter(t => t.counted > 0).map(t => ({ item: t.item, total: t.total, placard: t.def.placard })) : [], issues: r.counts ? r.totals.issues.map(i => i.code) : [] }));
  summary.audits = { audits: audit.audits.length, items: audit.items.length, found: audit.found.length, disposals: audit.disposals.length, findings: audit.findings.length, photos: audit.photos.length,
    photo_bytes: audit.photos.reduce((s, x) => s + x.bytes, 0), photo_bytes_by_audit: audit.photos.reduce((o, x) => (o[x.audit_id] = (o[x.audit_id] || 0) + x.bytes, o), {}) };
  summary.sample_pack = '#/pack?place=' + PLACES.find(p => p.key === SAMPLE_PACK.place).id + '&client=' + encodeURIComponent(SAMPLE_PACK.client) + '&ref=' + SAMPLE_PACK.ref + '&date=' + today;
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (!existsSync(join(out, '.gitignore'))) writeFileSync(join(out, '.gitignore'), '*\n!.gitignore\n');
  log(JSON.stringify(summary, null, 2));
  return summary;
}

function strip(a) { const { controls, ...rest } = a; return rest; }

function argOf(name, dflt) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const today = argOf('--today', new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) { console.error('--today must be YYYY-MM-DD'); process.exit(1); }
  const outDir = argOf('--out', join(ROOT, 'demo-out'));
  const quiet = process.argv.includes('--quiet');
  build({ today, outDir, log: quiet ? () => {} : console.log }).then(s => {
    console.log(`Wrote ${join(outDir, 'demo.sql')} and ${s.pdfs} PDFs (${s.chemicals} chemicals, as of ${today}).`);
  }).catch(e => { console.error(e); process.exit(1); });
}
