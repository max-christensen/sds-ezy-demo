// Validates the generated fictional demo: loads demo.sql into an in-memory SQLite after schema.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync } from 'node:crypto';
import { build } from '../scripts/make-demo.mjs';
import { effective, derive, normaliseClassification, verifyClassification, computePlaceTotals, PICTOGRAM_CODES } from '../public/lib/ghs-ref.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-10-19';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* handled below */ }
const skip = DatabaseSync ? false : 'node:sqlite is not available in this Node version; demo SQL tests skipped (use Node 22.5+)';

const out = mkdtempSync(join(tmpdir(), 'sdsezy-demo-'));
const summary = await build({ today: TODAY, outDir: out });
process.on('exit', () => { try { rmSync(out, { recursive: true, force: true }); } catch { /* ignore */ } });

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(join(out, 'demo.sql'), 'utf8'));
  return db;
}
const all = (db, sql, ...p) => db.prepare(sql).all(...p);
const one = (db, sql, ...p) => db.prepare(sql).get(...p);

test('demo.sql loads and is idempotent (clears then reloads)', { skip }, () => {
  const db = openDb();
  db.exec(readFileSync(join(out, 'demo.sql'), 'utf8'));
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemicals').n, summary.chemicals);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
});

test('about 60 chemicals, hazardous and non-hazardous, two without SDS (one is the audit placeholder), two without a decision', { skip }, () => {
  const db = openDb();
  const n = one(db, 'SELECT COUNT(*) n FROM chemicals').n;
  assert.ok(n >= 55 && n <= 70, 'chemical count ' + n);
  assert.ok(one(db, "SELECT COUNT(*) n FROM chemicals WHERE decision='hazardous'").n >= 20);
  assert.ok(one(db, "SELECT COUNT(*) n FROM chemicals WHERE decision='not_hazardous'").n >= 10);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemicals WHERE sds_id IS NULL').n, 2);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemicals WHERE decision IS NULL').n, 2);
  assert.equal(one(db, "SELECT COUNT(*) n FROM chemicals WHERE source = 'audit'").n, 1);
});

test('shared SDS: ten-product plaster sheet and four-pack-size adhesive sheet', { skip }, () => {
  const db = openDb();
  const shared = all(db, 'SELECT sds_id, COUNT(*) n FROM chemicals WHERE sds_id IS NOT NULL GROUP BY sds_id HAVING n > 1');
  const counts = shared.map(r => r.n).sort((a, b) => a - b);
  assert.ok(counts.includes(10) && counts.includes(4), 'shared counts ' + counts);
  assert.ok(counts.length >= 3);
});

test('review statuses: overdue, due soon, ok, unknown, no_sds', { skip }, () => {
  const db = openDb();
  const soon = '2027-01-17'; // today + 90 days
  const overdue = one(db, 'SELECT COUNT(*) n FROM chemicals WHERE review_due < ?', TODAY).n;
  const dueSoon = one(db, 'SELECT COUNT(*) n FROM chemicals WHERE review_due >= ? AND review_due <= ?', TODAY, soon).n;
  assert.ok(overdue >= 4, 'overdue ' + overdue);
  assert.ok(dueSoon >= 3, 'due soon ' + dueSoon);
  assert.equal(overdue, summary.review.overdue);
  assert.equal(dueSoon, summary.review.due_soon);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemicals WHERE sds_id IS NOT NULL AND review_due IS NULL').n, 1);
});

test('review_due is exactly five years after issue_date; SDS issue dates vary', { skip }, () => {
  const db = openDb();
  for (const r of all(db, 'SELECT id, issue_date, review_due FROM sds WHERE issue_date IS NOT NULL')) {
    assert.equal(r.review_due, String(Number(r.issue_date.slice(0, 4)) + 5) + r.issue_date.slice(4), 'sds ' + r.id);
  }
  const years = new Set(all(db, 'SELECT substr(issue_date,1,4) y FROM sds WHERE issue_date IS NOT NULL').map(r => r.y));
  assert.ok(years.size >= 5);
});

test('each risk level is represented several times', { skip }, () => {
  const db = openDb();
  for (const lvl of ['not_significant', 'significant_controlled', 'significant_not_controlled', 'uncertain']) {
    const n = one(db, 'SELECT COUNT(*) n FROM chemicals WHERE risk_level = ?', lvl).n;
    assert.ok(n >= 3, `${lvl}: ${n}`);
  }
});

test('summary columns match the current SDS, the current assessment and the GHS derivation', { skip }, () => {
  const db = openDb();
  const bad = all(db, `SELECT c.id FROM chemicals c JOIN sds s ON s.id = c.sds_id
    WHERE s.is_current != 1 OR c.sds_issue_date IS NOT s.issue_date OR c.review_due IS NOT s.review_due OR c.dg_class IS NOT s.dg_class`);
  assert.deepEqual(bad, []);
  // decision, signal word and pictograms are exactly what the Worker would compute from the classification and the overrides
  for (const c of all(db, 'SELECT * FROM chemicals')) {
    const cl = c.ghs_classification === null ? null : JSON.parse(c.ghs_classification);
    const e = effective(cl, { decision: c.decision_override, pictograms: c.pictograms_override });
    assert.equal(c.decision, e.decision, c.product_name + ' decision');
    assert.equal(c.signal_word, e.signal_word, c.product_name + ' signal word');
    assert.equal(c.pictograms, e.pictograms.length ? e.pictograms.join(',') : null, c.product_name + ' pictograms');
    if (c.pictograms) for (const p of c.pictograms.split(',')) assert.ok(PICTOGRAM_CODES.includes(p));
    if (cl) assert.deepEqual(normaliseClassification(cl).dropped, [], c.product_name);
  }
  assert.deepEqual(all(db, "SELECT id FROM sds WHERE signal_word IS NOT NULL AND signal_word NOT IN ('Danger','Warning')"), []);
  const cols = all(db, 'PRAGMA table_info(sds)').map(r => r.name);
  assert.ok(!cols.includes('pictograms') && !cols.includes('hazardous'));
  const badRisk = all(db, `SELECT c.id FROM chemicals c LEFT JOIN assessments a ON a.chemical_id = c.id AND a.is_current = 1
    WHERE c.risk_level IS NOT a.risk_level`);
  assert.deepEqual(badRisk, []);
  assert.deepEqual(all(db, 'SELECT chemical_id FROM assessments WHERE is_current = 1 GROUP BY chemical_id HAVING COUNT(*) > 1'), []);
  // exactly one chemical (the soldering flux) has no assessment at all, so the job pack can show "no assessment on file"
  const noCurrent = all(db, 'SELECT product_name FROM chemicals WHERE id NOT IN (SELECT chemical_id FROM assessments WHERE is_current = 1)');
  assert.deepEqual(noCurrent.map(r => r.product_name).sort(), ['Rapidset Tile Adhesive (found on Ute 2, needs an SDS)', 'Wattlebird Soldering Flux Paste']);
});

test('classification: two unclassified (two-stroke mix, audit placeholder), one decision override, one pictogram override (GHS09 only by override), one flagged', { skip }, () => {
  const db = openDb();
  const rows = all(db, 'SELECT * FROM chemicals');
  const unclassified = rows.filter(r => r.ghs_classification === null);
  assert.equal(unclassified.length, 2);
  for (const u of unclassified) assert.equal(u.decision, null);
  assert.ok(rows.filter(r => r.ghs_classification === '[]').every(r => r.decision === 'not_hazardous' || r.decision_override === 'hazardous'));
  const dOv = rows.filter(r => r.decision_override);
  assert.equal(dOv.length, 1);
  assert.equal(effective(JSON.parse(dOv[0].ghs_classification), { decision: dOv[0].decision_override }).decision_overridden, true);
  const pOv = rows.filter(r => r.pictograms_override);
  assert.equal(pOv.length, 1);
  assert.equal(effective(JSON.parse(pOv[0].ghs_classification), { pictograms: pOv[0].pictograms_override }).pictograms_overridden, true);
  assert.ok(pOv[0].pictograms.includes('GHS09'));
  for (const r of rows) if (r.pictograms && r.pictograms.includes('GHS09')) assert.ok(r.pictograms_override, 'GHS09 is never derived: ' + r.product_name);
  const flagged = rows.filter(r => r.classification_flags);
  assert.equal(flagged.length, 1);
  assert.ok(JSON.parse(flagged[0].ghs_classification).some(e => e.check === true));
  assert.equal(one(db, 'SELECT unverified u FROM sds WHERE id = ?', flagged[0].sds_id).u, '["classification"]');
  const noSds = rows.filter(r => r.sds_id === null && r.source !== 'audit');
  assert.equal(noSds.length, 1);
  assert.equal(JSON.parse(noSds[0].ghs_classification)[0].src, 'admin');
  const ph = rows.filter(r => r.source === 'audit');
  assert.equal(ph.length, 1); assert.equal(ph[0].sds_id, null); assert.equal(ph[0].ghs_classification, null);
});

test('classification examples match what the product really is', { skip }, () => {
  const db = openDb();
  const cl = name => JSON.parse(one(db, 'SELECT ghs_classification g FROM chemicals WHERE product_name LIKE ?', name).g).map(e => e.c + ':' + e.k);
  for (const k of ['flam_liq:2', 'eye_dmg:2A', 'stot_se:3']) assert.ok(cl('%Lacquer Thinners%').includes(k));
  assert.ok(cl('%Spray Enamel%').includes('aerosol:1'));
  for (const k of ['skin_corr:1A', 'corr_metal:1']) assert.ok(cl('%Battery Acid%').includes(k));
  for (const k of ['eye_dmg:1', 'skin_sens:1', 'stot_se:3']) assert.ok(cl('%General Purpose Cement%').includes(k));
  assert.deepEqual(cl('%PVA Wood Glue%'), []);
  assert.equal(one(db, "SELECT decision d FROM chemicals WHERE product_name LIKE '%PVA Wood Glue%'").d, 'not_hazardous');
});

test('search_text is lower-case and holds name, supplier, codes and CAS', { skip }, () => {
  const db = openDb();
  for (const r of all(db, 'SELECT product_name, supplier, product_codes, search_text, sds_id FROM chemicals')) {
    assert.equal(r.search_text, r.search_text.toLowerCase());
    assert.ok(r.search_text.includes(r.product_name.toLowerCase()));
    if (r.supplier) assert.ok(r.search_text.includes(r.supplier.toLowerCase()));
    if (r.product_codes) assert.ok(r.search_text.includes(r.product_codes.toLowerCase()));
  }
  const acetone = one(db, "SELECT search_text FROM chemicals WHERE product_name LIKE '%Acetone%'");
  assert.ok(acetone.search_text.includes('67-64-1'));
});

test('SDS version history: v1 replaced by v2, chemical points at v2', { skip }, () => {
  const db = openDb();
  const docs = all(db, 'SELECT doc_key, COUNT(*) n FROM sds GROUP BY doc_key HAVING n > 1');
  assert.ok(docs.length >= 1);
  const v = all(db, 'SELECT * FROM sds WHERE doc_key = ? ORDER BY version_no', docs[0].doc_key);
  assert.equal(v[0].is_current, 0); assert.ok(v[0].replaced_at);
  assert.equal(v[1].is_current, 1);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemicals WHERE sds_id = ?', v[1].id).n, 1);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemicals WHERE sds_id = ?', v[0].id).n, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM assessments WHERE sds_id = ? AND is_current = 0', v[0].id).n, 1);
});

test('places: counts, chemical_count matches the links, nothing in the legacy table', { skip }, () => {
  const db = openDb();
  const places = all(db, 'SELECT * FROM places ORDER BY id');
  assert.deepEqual(places.map(p => [p.id, p.name, p.place_type, p.registration, p.counts_toward_totals, p.archived]), [
    [1, 'Tallowood workshop', 'workshop', null, 1, 0], [2, 'Harbour Road job site', 'site', null, 1, 0],
    [3, 'Ute 1', 'vehicle', 'TWD 001', 0, 0], [4, 'Ute 2', 'vehicle', 'TWD 002', 0, 0], [5, 'Ute 3 (sold)', 'vehicle', 'TWD 003', 0, 1]]);
  assert.ok(places[4].archived_at);
  for (const p of places) assert.equal(p.chemical_count, one(db, 'SELECT COUNT(*) n FROM chemical_places WHERE place_id = ?', p.id).n, p.name);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM storage_locations').n, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemical_places').n, summary.links);
  assert.equal(summary.places, 5);
  // a link has both quantity and unit or neither
  assert.deepEqual(all(db, 'SELECT id FROM chemical_places WHERE (quantity IS NULL) != (unit IS NULL)'), []);
  assert.ok(one(db, 'SELECT COUNT(*) n FROM chemical_places WHERE quantity IS NULL').n >= 3, 'some links have no quantity');
  assert.ok(one(db, "SELECT COUNT(*) n FROM chemical_places WHERE spill_compound IS NOT NULL").n >= 10);
  assert.deepEqual(all(db, 'SELECT chemical_id, place_id FROM chemical_places GROUP BY chemical_id, place_id HAVING COUNT(*) > 1'), []);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
});

test('every chemical is kept in at least one place; some in two or more; no links to nothing', { skip }, () => {
  const db = openDb();
  assert.deepEqual(all(db, 'SELECT id, product_name FROM chemicals WHERE id NOT IN (SELECT chemical_id FROM chemical_places)'), []);
  assert.ok(one(db, 'SELECT COUNT(*) n FROM (SELECT chemical_id FROM chemical_places GROUP BY chemical_id HAVING COUNT(*) > 1)').n >= 15);
  const per = Object.fromEntries(all(db, 'SELECT place_id, COUNT(*) n FROM chemical_places GROUP BY place_id').map(r => [r.place_id, r.n]));
  assert.ok(per[1] > 50 && per[2] >= 8 && per[3] >= 10 && per[4] >= 10 && per[5] >= 1, JSON.stringify(per));
});

function placeResults(db) {
  const places = all(db, 'SELECT * FROM places ORDER BY id');
  const entries = all(db, `SELECT cp.id, cp.place_id, cp.chemical_id, c.product_name name, c.ghs_classification g, cp.quantity, cp.unit, cp.spill_compound
    FROM chemical_places cp JOIN chemicals c ON c.id = cp.chemical_id WHERE cp.quantity IS NOT NULL`)
    .map(r => ({ id: r.id, place_id: r.place_id, chemical_id: r.chemical_id, name: r.name, classification: r.g === null ? null : JSON.parse(r.g), quantity: r.quantity, unit: r.unit, spill_compound: r.spill_compound }));
  return { places, entries, results: computePlaceTotals(places, entries) };
}

test('per-place totals: workshop NEAR, job site OVER, vehicles and the archived place count nothing', { skip }, () => {
  const db = openDb();
  const { results, places, entries } = placeResults(db);
  const [w, s, u1, u2, arch] = results;
  // vehicles and the archived place are not totalled
  for (const r of [u1, u2, arch]) { assert.equal(r.counts, false); assert.equal(r.totals, null); }
  assert.match(u1.note, /transport rules/); assert.match(u2.caveat, /not been confirmed/);
  assert.equal(arch.note, 'This place is archived.');
  // the workshop: near the placard quantity for items 8 and 9, over nothing
  const item = (r, n) => r.totals.items.find(i => i.item === n);
  assert.deepEqual(w.over, { placard: [], manifest: [] });
  assert.deepEqual(w.near.placard, [8, 9]);
  assert.equal(item(w, 6).total, 30); assert.equal(item(w, 7).total, 59);
  assert.equal(item(w, 8).total, 854.6); assert.ok(item(w, 8).total >= 0.8 * 1000 && item(w, 8).total <= 1000);
  assert.equal(item(w, 9).total, 943.6); assert.equal(item(w, 9).mixApplies.placard, true);
  assert.equal(item(w, 1).total, 145); assert.equal(item(w, 10).total, 0, 'the workshop decking oil is counted with the category 3 liquids in its bund');
  assert.ok(item(w, 8).contributors.some(c => /Decking Oil/.test(c.name) && c.rule === 'spill_compound'));
  // the job site: over the placard quantity for item 1 (flammable gases), with a category 4 liquid in its own tray and a unit mismatch
  assert.deepEqual(s.over, { placard: [1], manifest: [] });
  assert.equal(item(s, 1).total, 210); assert.equal(item(s, 10).total, 10);
  const mism = s.totals.issues.filter(i => i.code === 'unit_mismatch');
  assert.equal(mism.length, 1); assert.match(mism[0].name, /Spray Enamel/);
  assert.equal(s.totals.issues.filter(i => i.code === 'no_classification').length, 0);
  assert.equal(w.totals.issues.filter(i => i.code === 'no_classification').length, 1, 'the unclassified two-stroke mix');
  // nowhere is over a manifest quantity
  for (const r of results) if (r.counts) assert.deepEqual(r.over.manifest, []);
  // the vehicles hold enough that adding their stock to the workshop would go over (so the vehicle rule matters)
  const vehicleEntries = entries.filter(e => [3, 4].includes(e.place_id)).map(e => ({ ...e, place_id: 1, spill_compound: e.spill_compound || 'vehicles' }));
  const merged = computePlaceTotals(places.filter(p => p.id === 1), entries.filter(e => e.place_id === 1).concat(vehicleEntries))[0];
  assert.ok(merged.over.placard.includes(8), 'item 8 would be over: ' + item(merged, 8).total);
  assert.ok(item(merged, 8).total > 1000 && item(merged, 8).total < 1100);
  // adding the archived ute as well changes nothing the other places already show
  assert.ok(entries.some(e => e.place_id === 5), 'the archived place keeps its links');
});

test('sample job pack: Ute 2 has chemicals with no SDS and no assessment, and a stable link', { skip }, () => {
  const db = openDb();
  const ute2 = one(db, "SELECT id FROM places WHERE name = 'Ute 2'").id;
  assert.equal(ute2, 4);
  assert.equal(summary.sample_pack, '#/pack?place=4&client=Smith%20Street%20Primary%20School&ref=JOB-1042&date=' + TODAY);
  const chems = all(db, `SELECT c.id, c.product_name, c.sds_id, (SELECT COUNT(*) FROM assessments a WHERE a.chemical_id = c.id AND a.is_current = 1) has_a
    FROM chemical_places cp JOIN chemicals c ON c.id = cp.chemical_id WHERE cp.place_id = ?`, ute2);
  assert.ok(chems.length >= 15);
  assert.deepEqual(chems.filter(c => c.sds_id === null).map(c => c.product_name), ['Concrete Sealer (solvent-based, unlabelled tin)', 'Rapidset Tile Adhesive (found on Ute 2, needs an SDS)']);
  assert.deepEqual(chems.filter(c => !c.has_a).map(c => c.product_name).sort(), ['Rapidset Tile Adhesive (found on Ute 2, needs an SDS)', 'Wattlebird Soldering Flux Paste']);
  assert.deepEqual(summary.no_sds, [66, 67]); assert.deepEqual(summary.no_assessment, [38, 67]);
  assert.ok(chems.some(c => c.sds_id !== null && c.has_a));
});

test('assessment controls resolve to seeded options', { skip }, () => {
  const db = openDb();
  const n = one(db, 'SELECT COUNT(*) n FROM assessment_controls').n;
  assert.ok(n > 150, 'controls ' + n);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM assessment_controls WHERE option_id IS NULL').n, 0);
});

test('demo logins use the app PBKDF2 format and verify', { skip }, async () => {
  const db = openDb();
  const users = all(db, 'SELECT email, role, password_hash FROM users ORDER BY id');
  assert.deepEqual(users.map(u => [u.email, u.role]), [['demo-admin@example.invalid', 'admin'], ['demo-user@example.invalid', 'user']]);
  const { DEMO_PASSWORD } = await import('../scripts/demo/data.mjs');
  for (const u of users) {
    const [it, salt, hash] = u.password_hash.split(':');
    assert.equal(it, '100000');
    const d = pbkdf2Sync(DEMO_PASSWORD, Buffer.from(salt, 'base64url'), 100000, 32, 'sha256');
    assert.equal(d.toString('base64url'), hash);
    assert.equal(Buffer.from(salt, 'base64url').length, 16);
  }
  const s = Object.fromEntries(all(db, 'SELECT key, value FROM settings').map(r => [r.key, r.value]));
  assert.equal(s.setup_complete, '1');
  assert.ok(s.company_name && s.main_color);
});

test('every PDF exists, starts with %PDF, is small and extractable text says FICTIONAL', async () => {
  const db = skip ? null : openDb();
  const { readdirSync, statSync } = await import('node:fs');
  const files = readdirSync(join(out, 'pdfs', 'sds'));
  assert.equal(files.length, summary.sds_rows);
  const keys = db ? all(db, 'SELECT r2_key FROM sds').map(r => r.r2_key) : files.map(f => 'sds/' + f);
  for (const k of keys) {
    const p = join(out, 'pdfs', k);
    assert.ok(existsSync(p), k);
    const buf = readFileSync(p);
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(statSync(p).size > 2000 && statSync(p).size < 60000, k + ' size ' + statSync(p).size);
  }
  // text extraction on one sheet
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(join(out, 'pdfs', keys[0])));
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map(t => t.str).join(' ') + '\n';
  assert.match(text, /FICTIONAL DEMONSTRATION DOCUMENT/);
  for (let n = 1; n <= 16; n++) assert.ok(text.includes(`SECTION ${n}:`), 'section ' + n);
  assert.match(text, /Hazchem code/);
});

test('no real manufacturer or brand names', { skip }, () => {
  const sql = readFileSync(join(out, 'demo.sql'), 'utf8').toLowerCase();
  const deny = ['dulux', 'wattyl', 'selleys', 'cabot', 'gyprock', 'liquid nails', 'chemset', 'wd-40', 'wd40', 'bostik', 'sika', 'berger', 'taubmans', 'resene', 'british paints',
    'penrite', 'castrol', 'valvoline', 'caltex', 'shell', 'mobil', 'ampol', 'repsol', 'total energies', 'boc', 'air liquide', 'coregas', 'linde', 'bunnings', 'orica', 'nulon', 'aeroguard',
    'organoil', 'sikaflex', 'knauf', 'boral', 'csr', 'hilti', 'ramset', 'fosroc', 'parchem', 'ajax', 'domestos', 'jif', 'harpic', 'zoflora', 'clorox', 'diversey', 'ecolab',
    'rustoleum', 'rust-oleum', 'norglass', 'araldite', 'loctite', 'henkel', '3m', 'dow ', 'basf', 'bayer', 'exxon', 'chevron'];
  const hits = deny.filter(w => new RegExp('(^|[^a-z0-9])' + w.replace(/[-.]/g, '\\$&') + '([^a-z0-9]|$)').test(sql));
  assert.deepEqual(hits, []);
  const mails = sql.match(/[a-z0-9._-]+@[a-z0-9.-]+/g) || [];
  assert.ok(mails.length >= 2 && mails.every(m => m.endsWith('example.invalid')), 'only example.invalid addresses: ' + mails);
});

test('same --today gives the same output (deterministic)', async () => {
  const { createHash } = await import('node:crypto');
  const out2 = mkdtempSync(join(tmpdir(), 'sdsezy-demo2-'));
  try {
    await build({ today: TODAY, outDir: out2 });
    const h = p => createHash('sha256').update(readFileSync(p)).digest('hex');
    assert.equal(h(join(out, 'demo.sql')), h(join(out2, 'demo.sql')));
  } finally { rmSync(out2, { recursive: true, force: true }); }
});

test('dates move with --today so the status counts stay stable', async () => {
  const out3 = mkdtempSync(join(tmpdir(), 'sdsezy-demo3-'));
  try {
    const s = await build({ today: '2027-03-05', outDir: out3 });
    assert.equal(s.review.overdue, summary.review.overdue);
    assert.equal(s.review.due_soon, summary.review.due_soon);
  } finally { rmSync(out3, { recursive: true, force: true }); }
});

test('every demo SDS text agrees with its stored classification (verifyClassification)', { skip }, async () => {
  const db = openDb();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const textOf = async path => {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true, verbosity: 0 }).promise;
    let text = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      let lastY = null;
      for (const it of (await (await pdf.getPage(p)).getTextContent()).items) {
        const y = Math.round(it.transform[5]);
        text += (lastY !== null && y !== lastY ? '\n' : (text && !text.endsWith('\n') ? ' ' : '')) + it.str; lastY = y;
      }
      text += '\n';
    }
    return text;
  };
  const rows = all(db, 'SELECT c.product_name, c.ghs_classification g, c.classification_flags f, s.id sid, s.r2_key FROM chemicals c JOIN sds s ON s.id = c.sds_id WHERE c.ghs_classification IS NOT NULL');
  const done = new Set();
  let flaggedSeen = 0;
  for (const r of rows) {
    if (done.has(r.sid)) continue;
    done.add(r.sid);
    const text = await textOf(join(out, 'pdfs', r.r2_key));
    const stored = JSON.parse(r.g);
    const v = verifyClassification(stored, text);
    assert.deepEqual(v.removed, [], r.product_name);
    if (r.f) {
      flaggedSeen++;
      assert.deepEqual(v.flags, JSON.parse(r.f), 'stored flags equal what verification finds');
      assert.ok(v.list.some(e => e.check));
    } else {
      assert.deepEqual(v.flags, [], r.product_name + ' ' + v.flags.join(' | '));
      assert.deepEqual(v.list.map(e => e.c + ':' + e.k).sort(), stored.map(e => e.c + ':' + e.k).sort(), r.product_name);
      assert.ok(!v.list.some(e => e.check));
    }
    const d = derive(stored);
    assert.match(text, new RegExp('Signal word:\\s+' + (d.signal_word || 'None')));
    for (const p of d.pictograms) assert.ok(text.includes(p + ' '), r.product_name + ' prints ' + p);
    if (stored.length) assert.match(text, /\(H\d{3}[A-Za-z]?(, H\d{3}[A-Za-z]?)*\)/);
  }
  assert.equal(flaggedSeen, 1);
  assert.ok(done.size >= 40);
});
