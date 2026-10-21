// Validates the demo's chemical audits (scripts/demo/audits.mjs) against the real schema.sql using in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { build } from '../scripts/make-demo.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-10-19';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* handled below */ }
const skip = DatabaseSync ? false : 'node:sqlite is not available in this Node version; audit demo tests skipped (use Node 22.5+)';

const out = mkdtempSync(join(tmpdir(), 'sdsezy-audit-'));
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
const day = (n) => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('audit counts: 3 audits, 141 items, 2 found, 2 disposals, 5 findings, 11 photos', { skip }, () => {
  const db = openDb();
  const n = t => one(db, `SELECT COUNT(*) n FROM ${t}`).n;
  assert.deepEqual([n('audits'), n('audit_items'), n('audit_found'), n('audit_disposals'), n('audit_findings'), n('audit_photos'), n('place_audit_summary')], [3, 141, 2, 2, 5, 11, 2]);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
  assert.deepEqual(summary.audits.photos, 11);
  // idempotent reload (the SQL clears the audit tables first)
  db.exec(readFileSync(join(out, 'demo.sql'), 'utf8'));
  assert.equal(n('audits'), 3);
});

test('visibility: both new audits belong to demo-user, the old workshop audit to demo-admin', { skip }, () => {
  const db = openDb();
  const users = Object.fromEntries(all(db, 'SELECT id, email FROM users').map(u => [u.email, u.id]));
  const a = all(db, 'SELECT id, started_by, started_by_name, status, place_id FROM audits ORDER BY id');
  assert.deepEqual(a.map(x => [x.id, x.started_by, x.status, x.place_id]), [[1, users['demo-user@example.invalid'], 'finished', 4], [2, users['demo-user@example.invalid'], 'in_progress', 1], [3, users['demo-admin@example.invalid'], 'finished', 1]]);
  assert.equal(a[0].started_by_name, 'Demo User');
  // what demo-user can open: only the audits they ran (the admin sees all three)
  assert.deepEqual(all(db, 'SELECT id FROM audits WHERE started_by = ? ORDER BY id', users['demo-user@example.invalid']).map(r => r.id), [1, 2]);
  assert.equal(all(db, 'SELECT id FROM audits').length, 3);
});

test('the completed Ute 2 audit: 17 items, 15 present, 1 not found, 1 changed, notes, one day, summary matches rows', { skip }, () => {
  const db = openDb();
  const au = one(db, 'SELECT * FROM audits WHERE id = 1');
  assert.equal(au.place_name, 'Ute 2'); assert.equal(au.place_registration, 'TWD 002');
  assert.equal(au.started_at.slice(0, 10), day(-3)); assert.equal(au.finished_at.slice(0, 10), day(-3));
  assert.ok(au.started_at < au.finished_at);
  const items = all(db, 'SELECT * FROM audit_items WHERE audit_id = 1');
  assert.equal(items.length, 17);
  assert.equal(items.filter(i => i.result === 'present').length, 15);
  assert.equal(items.filter(i => i.result === 'not_found').length, 1);
  assert.equal(items.filter(i => i.result === 'changed').length, 1);
  assert.equal(items.filter(i => !i.result).length, 0);
  assert.ok(items.filter(i => i.note).length >= 3);
  const ch = items.find(i => i.result === 'changed');
  assert.ok(ch.new_quantity !== ch.expected_quantity && ch.new_container_note && ch.new_container_note !== ch.expected_container_note);
  for (const i of items) { assert.ok(i.marked_at >= au.started_at && i.marked_at <= au.finished_at, i.product_name); assert.ok(['overdue', 'due_soon', 'ok', 'no_sds', 'unknown'].includes(i.review_status)); }
  // the 17 items are the chemicals linked to Ute 2 when the audit started (everything but the placeholder found during the audit)
  const links = all(db, 'SELECT chemical_id FROM chemical_places WHERE place_id = 4').map(r => r.chemical_id).sort((a, b) => a - b);
  assert.equal(links.length, 18);
  assert.deepEqual(items.map(i => i.chemical_id).sort((a, b) => a - b), links.filter(id => id !== one(db, "SELECT id FROM chemicals WHERE source = 'audit'").id));
  // items with no SDS / no assessment are shown as such in the snapshot
  assert.equal(items.filter(i => !i.has_sds).length, 1); assert.equal(items.filter(i => !i.has_assessment).length, 1);
  // the items are ordered with the out-of-date ones first
  const rank = { overdue: 0, due_soon: 1, no_sds: 2, unknown: 3, ok: 4 };
  const ranks = items.sort((a, b) => a.id - b.id).map(i => rank[i.review_status]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  // summary JSON matches the rows
  const s = JSON.parse(au.summary);
  const photos = all(db, 'SELECT * FROM audit_photos WHERE audit_id = 1 AND taken_at <= ?', au.finished_at);
  assert.deepEqual(s, { listed: 17, present: 15, not_found: 1, changed: 1, not_marked: 0, found: 2, disposals: 2, photos: photos.length, photo_bytes: photos.reduce((x, p) => x + p.bytes, 0) });
  assert.equal(s.photos, 9, 'ten photos in all; the closing photo was added a day later');
});

test('found items: one became a "needs an SDS" chemical, one matched an existing chemical (link suggested)', { skip }, () => {
  const db = openDb();
  const f = all(db, 'SELECT * FROM audit_found WHERE audit_id = 1 ORDER BY id');
  assert.deepEqual(f.map(x => x.outcome), ['created', 'link_suggested']);
  const created = one(db, 'SELECT * FROM chemicals WHERE id = ?', f[0].chemical_id);
  assert.equal(created.source, 'audit'); assert.equal(created.sds_id, null); assert.equal(created.decision, null); assert.equal(created.ghs_classification, null);
  assert.ok(one(db, 'SELECT COUNT(*) n FROM chemical_places WHERE chemical_id = ? AND place_id = 4', created.id).n === 1, 'linked to Ute 2');
  assert.ok(created.search_text.includes('rapidset'));
  const matched = one(db, 'SELECT * FROM chemicals WHERE id = ?', f[1].matched_chemical_id);
  assert.match(matched.product_name, /Dishwashing/);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemical_places WHERE chemical_id = ? AND place_id = 4', matched.id).n, 0, 'a user does not link it; it is a finding');
  for (const x of f) assert.ok(x.found_at >= '' + day(-3) && x.found_at.slice(0, 10) === day(-3));
  // places.chemical_count matches the links, including the placeholder
  for (const p of all(db, 'SELECT id, chemical_count FROM places')) assert.equal(p.chemical_count, one(db, 'SELECT COUNT(*) n FROM chemical_places WHERE place_id = ?', p.id).n);
  assert.equal(one(db, 'SELECT chemical_count c FROM places WHERE id = 4').c, 18);
  assert.equal(one(db, "SELECT COUNT(*) n FROM chemicals WHERE sds_id IS NULL AND source = 'audit'").n, 1);
});

test('findings match items: open = not_found + changed + found_link of the completed audit; older audit has accepted and dismissed', { skip }, () => {
  const db = openDb();
  const open = all(db, "SELECT * FROM audit_findings WHERE status = 'open' ORDER BY id");
  assert.deepEqual(open.map(f => [f.audit_id, f.kind]).sort(), [[1, 'changed'], [1, 'found_link'], [1, 'not_found']]);
  const items = all(db, 'SELECT * FROM audit_items WHERE audit_id = 1');
  for (const f of open.filter(f => f.kind !== 'found_link')) {
    const it = items.find(i => i.id === f.audit_item_id);
    assert.equal(it.result, f.kind); assert.equal(it.chemical_id, f.chemical_id); assert.equal(it.link_id, f.link_id);
    assert.equal(JSON.parse(f.details).expected_quantity, it.expected_quantity);
  }
  const fl = open.find(f => f.kind === 'found_link');
  assert.equal(all(db, 'SELECT outcome FROM audit_found WHERE id = ?', fl.found_id)[0].outcome, 'link_suggested');
  assert.deepEqual(all(db, "SELECT status, COUNT(*) n FROM audit_findings GROUP BY status ORDER BY status").map(r => [r.status, r.n]), [['accepted', 1], ['dismissed', 1], ['open', 3]]);
  for (const f of all(db, "SELECT * FROM audit_findings WHERE status != 'open'")) { assert.equal(f.audit_id, 3); assert.equal(f.resolved_by_name, 'Demo Admin'); assert.ok(f.resolved_at > f.created_at); }
  // an item missing a finding would be a bug: every not_found / changed item of a finished audit has exactly one
  for (const a of [1, 3]) for (const it of all(db, "SELECT * FROM audit_items WHERE audit_id = ? AND result IN ('not_found','changed')", a))
    assert.equal(one(db, 'SELECT COUNT(*) n FROM audit_findings WHERE audit_item_id = ?', it.id).n, 1);
  // the accepted "changed" finding is already reflected on the register link
  const acc = one(db, "SELECT * FROM audit_findings WHERE status = 'accepted'");
  assert.equal(one(db, 'SELECT quantity q FROM chemical_places WHERE id = ?', acc.link_id).q, JSON.parse(acc.details).new_quantity);
  // the dismissed not-found chemical is still linked
  const dis = one(db, "SELECT * FROM audit_findings WHERE status = 'dismissed'");
  assert.equal(one(db, 'SELECT COUNT(*) n FROM chemical_places WHERE id = ?', dis.link_id).n, 1);
});

test('disposals: one expired and open with a photo, one closed by demo-admin with a note and a closing photo', { skip }, () => {
  const db = openDb();
  const d = all(db, 'SELECT * FROM audit_disposals ORDER BY id');
  assert.equal(d.length, 2);
  const open = d.find(x => x.status === 'to_dispose'), closed = d.find(x => x.status === 'disposed');
  assert.equal(open.reason, 'expired'); assert.equal(open.closed_by, null);
  assert.equal(closed.closed_by_name, 'Demo Admin'); assert.ok(closed.close_note && closed.closed_at > closed.flagged_at);
  assert.equal(one(db, "SELECT COUNT(*) n FROM audit_photos WHERE owner_type = 'disposal' AND owner_key = ?", open.client_id).n, 1);
  const closing = all(db, "SELECT * FROM audit_photos WHERE owner_type = 'disposal_close' AND owner_key = ?", closed.client_id);
  assert.equal(closing.length, 1);
  assert.ok(closing[0].taken_at > one(db, 'SELECT finished_at f FROM audits WHERE id = 1').f, 'the closing photo is added after the audit was finished');
  assert.ok(closing[0].taken_at <= closed.closed_at);
});

test('in-progress workshop audit: about a third marked, not finished, no summary', { skip }, () => {
  const db = openDb();
  const au = one(db, 'SELECT * FROM audits WHERE id = 2');
  assert.equal(au.status, 'in_progress'); assert.equal(au.finished_at, null); assert.equal(au.summary, null);
  const items = all(db, 'SELECT * FROM audit_items WHERE audit_id = 2');
  const marked = items.filter(i => i.result).length;
  assert.equal(items.length, one(db, 'SELECT chemical_count c FROM places WHERE id = 1').c);
  assert.ok(marked >= items.length * 0.25 && marked <= items.length * 0.4, `${marked} of ${items.length}`);
  assert.ok(items.some(i => i.result === null));
  assert.equal(au.started_at.slice(0, 10), TODAY);
  assert.deepEqual(summary.audits.photo_bytes_by_audit['2'] > 0, true);
});

test('reminder: not_audited (90 days) lists the workshop (last audit 130 days ago), the job site and Ute 1; not Ute 2 or the archived ute', { skip }, () => {
  const db = openDb();
  const cutoff = day(-90) + 'T00:00:00.000Z';
  const rows = all(db, `SELECT p.id, p.name, s.last_audited_at FROM places p LEFT JOIN place_audit_summary s ON s.place_id = p.id
    WHERE p.archived = 0 AND p.chemical_count > 0 AND (s.last_audited_at IS NULL OR s.last_audited_at < ?) ORDER BY p.id`, cutoff);
  assert.deepEqual(rows.map(r => r.name), ['Tallowood workshop', 'Harbour Road job site', 'Ute 1']);
  assert.ok(rows[0].last_audited_at.slice(0, 10) === day(-130));
  assert.equal(rows[1].last_audited_at, null); assert.equal(rows[2].last_audited_at, null);
  // the place's last-audited date is the latest FINISHED audit (the in-progress one does not count)
  assert.equal(one(db, 'SELECT last_audit_id a FROM place_audit_summary WHERE place_id = 1').a, 3);
  assert.equal(one(db, 'SELECT last_audit_id a FROM place_audit_summary WHERE place_id = 4').a, 1);
  assert.equal(one(db, 'SELECT last_audited_at t FROM place_audit_summary WHERE place_id = 4').t, one(db, 'SELECT finished_at f FROM audits WHERE id = 1').f);
});

test('photos: every row has a JPEG file that decodes, small, inside the audit window, deterministic keys', { skip }, () => {
  const db = openDb();
  const rows = all(db, 'SELECT p.*, a.started_at, a.finished_at FROM audit_photos p JOIN audits a ON a.id = p.audit_id ORDER BY p.id');
  assert.equal(rows.length, 11);
  const seen = new Set();
  for (const p of rows) {
    assert.match(p.r2_key, new RegExp(`^audits/${p.audit_id}/[0-9a-f-]{36}\\.jpg$`));
    const file = join(out, 'photos', p.r2_key);
    assert.ok(existsSync(file), p.r2_key);
    const buf = readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.equal(buf.length, p.bytes); assert.equal(statSync(file).size, p.bytes);
    assert.ok(p.bytes >= 8000 && p.bytes <= 70000, p.r2_key + ' ' + p.bytes);
    const img = jpeg.decode(buf, { useTArray: true });
    assert.equal(img.width, 640); assert.equal(img.height, 480); assert.equal(p.width, 640); assert.equal(p.height, 480);
    assert.equal(p.content_type, 'image/jpeg'); assert.equal(p.uploaded_by, p.owner_type === 'disposal_close' ? 1 : 2);
    assert.ok(p.taken_at >= p.started_at, 'taken after the audit started');
    if (p.owner_type !== 'disposal_close') assert.ok(!p.finished_at || p.taken_at <= p.finished_at, 'taken inside the audit window');
    assert.ok(!seen.has(p.client_id)); seen.add(p.client_id);
    // owner exists
    if (p.owner_type === 'item') assert.ok(one(db, 'SELECT 1 x FROM audit_items WHERE audit_id = ? AND chemical_id = ?', p.audit_id, Number(p.owner_key)));
    if (p.owner_type === 'found') assert.ok(one(db, 'SELECT 1 x FROM audit_found WHERE audit_id = ? AND client_id = ?', p.audit_id, p.owner_key));
    if (p.owner_type.startsWith('disposal')) assert.ok(one(db, 'SELECT 1 x FROM audit_disposals WHERE audit_id = ? AND client_id = ?', p.audit_id, p.owner_key));
    if (p.owner_type === 'audit') assert.equal(p.owner_key, null);
  }
  // photos are in the generated folder only (git-ignored) and the fictional marker is baked into the picture: a decoded top-left strip is dark
  const first = jpeg.decode(readFileSync(join(out, 'photos', rows[0].r2_key)), { useTArray: true });
  const px = (x, y) => first.data[(y * first.width + x) * 4];
  assert.ok(px(2, 2) < 80, 'dark caption strip in the corner');
});

test('R2 bytes per audit are reported and add up', { skip }, () => {
  const db = openDb();
  const per = all(db, 'SELECT audit_id, SUM(bytes) b, COUNT(*) n FROM audit_photos GROUP BY audit_id ORDER BY audit_id');
  assert.deepEqual(per.map(p => p.n), [10, 1]);
  assert.deepEqual(Object.fromEntries(per.map(p => [p.audit_id, p.b])), Object.fromEntries(Object.entries(summary.audits.photo_bytes_by_audit).map(([k, v]) => [Number(k), v])));
  assert.ok(per[0].b < 2 * 1024 * 1024 && per[0].b > 100000, 'well under the 40 MB per-audit cap: ' + per[0].b);
  console.log('audit photo storage (bytes):', JSON.stringify(summary.audits.photo_bytes_by_audit));
});

test('no real brand names in the audit data or photo labels', { skip }, () => {
  const db = openDb();
  const text = JSON.stringify(['audits', 'audit_items', 'audit_found', 'audit_disposals', 'audit_findings'].flatMap(t => all(db, `SELECT * FROM ${t}`))).toLowerCase();
  for (const w of ['dulux', 'wattyl', 'selleys', 'gyprock', 'liquid nails', 'chemset', 'wd-40', 'bostik', 'sika', 'castrol', 'shell', 'bunnings', 'loctite']) assert.ok(!new RegExp('(^|[^a-z0-9])' + w.replace(/[-.]/g, '\\$&') + '([^a-z0-9]|$)').test(text), w);
  assert.ok(!/@(?![a-z0-9.-]*example\.invalid)/.test(text));
});

test('audit data is deterministic for a given --today', async () => {
  const { createHash } = await import('node:crypto');
  const out2 = mkdtempSync(join(tmpdir(), 'sdsezy-audit2-'));
  try {
    await build({ today: TODAY, outDir: out2 });
    const h = p => createHash('sha256').update(readFileSync(p)).digest('hex');
    assert.equal(h(join(out, 'demo.sql')), h(join(out2, 'demo.sql')));
    const db = skip ? null : openDb();
    if (db) for (const p of all(db, 'SELECT r2_key FROM audit_photos')) assert.equal(h(join(out, 'photos', p.r2_key)), h(join(out2, 'photos', p.r2_key)));
  } finally { rmSync(out2, { recursive: true, force: true }); }
});
