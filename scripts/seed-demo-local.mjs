#!/usr/bin/env node
// Loads the generated demo (demo-out/demo.sql + PDFs) into the LOCAL D1 database and LOCAL R2 bucket only.
//   node scripts/seed-demo-local.mjs [--persist-to <dir>] [--today YYYY-MM-DD] [--skip-build] [--dry-run]
// It refuses to run with --remote, never reads wrangler.toml itself (wrangler resolves the DB binding),
// and passes --local to every wrangler call.
import { spawnSync } from 'node:child_process';
import { pickConfig } from './dev.mjs';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './make-demo.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };

if (args.some(a => /^--remote(=|$)/.test(a))) {
  console.error('Refusing to run: this script only loads the LOCAL database and bucket. See docs/DEMO.md for the separate demo Worker.');
  process.exit(2);
}

const BUCKET = 'sds-ezy-files';
const DB_BINDING = 'DB';
const persist = resolve(val('--persist-to', join(ROOT, '.wrangler', 'state')));
const dry = has('--dry-run');
const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const outDir = join(ROOT, 'demo-out');

// The same config `npm run dev` uses (your wrangler.local.toml, else a copy of wrangler.toml without the [ai] block), so the demo
// goes into the same local database the dev server opens (local D1 state is keyed by the config's database_id).
const config = pickConfig().path;

function wr(argv) {
  const full = [...argv, '--local', '--persist-to', persist, '-c', config];
  if (full.includes('--remote')) throw new Error('internal error: remote flag');
  if (dry) { console.log('[dry-run] wrangler ' + full.join(' ')); return; }
  const r = spawnSync(process.execPath, [wrangler, ...full], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('wrangler failed: ' + argv.slice(0, 3).join(' ')); process.exit(r.status || 1); }
}

if (!has('--skip-build') || !existsSync(join(outDir, 'demo.sql'))) {
  const today = val('--today', new Date().toISOString().slice(0, 10));
  await build({ today, outDir, log: () => {} });
  console.log(`Built demo for ${today}.`);
}

console.log('1/4 applying schema.sql to the local database');
wr(['d1', 'execute', DB_BINDING, '--yes', '--file', join(ROOT, 'schema.sql')]);
console.log('2/4 loading demo.sql (clears the register tables first)');
wr(['d1', 'execute', DB_BINDING, '--yes', '--file', join(outDir, 'demo.sql')]);
console.log('3/4 uploading SDS PDFs to the local R2 bucket');
const dir = join(outDir, 'pdfs', 'sds');
for (const f of readdirSync(dir).sort()) {
  wr(['r2', 'object', 'put', `${BUCKET}/sds/${f}`, '--file', join(dir, f), '--content-type', 'application/pdf']);
}
console.log('4/4 uploading audit photos to the local R2 bucket');
const photoRoot = join(outDir, 'photos');
const photoFiles = [];
if (existsSync(photoRoot)) for (const a of readdirSync(join(photoRoot, 'audits'))) for (const f of readdirSync(join(photoRoot, 'audits', a))) if (statSync(join(photoRoot, 'audits', a, f)).isFile()) photoFiles.push(`audits/${a}/${f}`);
for (const key of photoFiles.sort()) wr(['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', join(photoRoot, key), '--content-type', 'image/jpeg']);
console.log(`Done. Start the Worker with the same state: npx wrangler dev --persist-to "${persist}"`);
console.log('Demo logins: demo-admin@example.invalid and demo-user@example.invalid (password in docs/DEMO.md).');
