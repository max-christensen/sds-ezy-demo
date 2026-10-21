// Proves scripts/answer-key.mjs parses .docx / .xlsx / .pdf correctly using invented stand-in files, never echoes
// personal data, degrades gracefully when the real files are absent, and that the demo seed script refuses --remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { run, docxRows, parseAssessments, scrub } from '../scripts/answer-key.mjs';
import { makeFixtures, makeDocx, FIXTURE_EXPECTED } from '../scripts/demo/answer-key-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('docx parser finds all fields on every page, in table, plain and content-control styles', () => {
  const recs = parseAssessments(docxRows(Buffer.from(makeDocx())));
  assert.equal(recs.length, 6);
  assert.equal(recs[0].product, 'Fakefix Heavy Grip 375 mL');
  assert.deepEqual(recs[0].routes, { inhalation: true, ingestion: false, absorption: true });
  assert.equal(recs[0].risk_level, 'significant_controlled');
  assert.equal(recs[1].risk_level, 'significant_not_controlled');   // content-control checkboxes
  assert.deepEqual(recs[0].controls.sort(), ['Lids kept on containers when not in use', 'No ignition sources nearby', 'Natural / general ventilation'].sort());
  assert.deepEqual(recs[0].ppe.sort(), ['Chemical-resistant gloves', 'Safety glasses']);
  assert.equal(recs[0].un_number, '1133'); assert.equal(recs[0].dg_class, '3'); assert.equal(recs[0].packing_group, 'III'); assert.equal(recs[0].hazchem_code, '3Y');
  assert.equal(recs[2].risk_level, 'not_significant');              // [x] plain style
  assert.deepEqual(recs[2].ppe.sort(), ['Chemical-resistant gloves', 'P2 dust mask', 'Safety glasses']);
  assert.equal(recs[2].un_number, null); assert.ok(recs[2].present.has('un'));
  assert.equal(recs[5].risk_level, 'uncertain');
  for (const r of recs) assert.ok(!JSON.stringify(r).includes('Fictional Person'));
});

test('full self-test run reports the expected per-field counts and leaks no personal data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdsezy-aktest-'));
  const lines = [];
  try {
    const fx = await makeFixtures(dir);
    const r = await run({ dir, extractorFn: fx.extractorFn, noCache: true, detail: true, log: s => lines.push(s) });
    for (const [f, e] of Object.entries(FIXTURE_EXPECTED.fields)) {
      assert.equal(r.report.fields[f].compared, e.compared, f + ' compared');
      assert.equal(r.report.fields[f].matched, e.matched, f + ' matched');
    }
    assert.equal(r.report.counts.assessments, FIXTURE_EXPECTED.counts.assessments);
    assert.equal(r.report.counts.register_rows, FIXTURE_EXPECTED.counts.register_rows);
    assert.equal(r.report.counts.sds_pdfs, FIXTURE_EXPECTED.counts.sds_pdfs);
    assert.equal(r.report.counts.assessments_without_sds, FIXTURE_EXPECTED.counts.assessments_without_sds);
    assert.equal(r.report.register.matched_to_sds, 4);
    const everything = lines.join('\n') + readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.ok(!/Fictional Person|0400 000 000/.test(everything), 'personal data leaked');
    assert.match(lines.join('\n'), /Routes of entry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('degrades gracefully (exit 0, clear message) when the files are absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdsezy-akempty-'));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'answer-key.mjs'), '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to compare yet/i);
    assert.match(r.stdout, /\.docx/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scrub redacts phone numbers and e-mail addresses', () => {
  assert.equal(scrub('call 0400 000 000 or a.b@example.com'), 'call [number] or [email]');
});

test('seed-demo-local refuses --remote', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'seed-demo-local.mjs'), '--remote'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Refusing/);
});

test('seed-demo-local dry run only ever passes --local and never --remote', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'seed-demo-local.mjs'), '--dry-run', '--persist-to', join(tmpdir(), 'sdsezy-dry')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const cmds = r.stdout.split('\n').filter(l => l.startsWith('[dry-run]'));
  assert.ok(cmds.length > 50);
  assert.ok(cmds.every(c => c.includes('--local') && !c.includes('--remote')));
  assert.ok(cmds.some(c => c.includes('r2 object put sds-ezy-files/sds/')));
});
