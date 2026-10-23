// `npm run deploy`: wrangler deploy, with a retry and a plain-language diagnosis for one failure seen on the Deploy to Cloudflare button:
//   "D1 binding 'DB' references database '<id>' which was not found [code: 10181]" (and "could not be found [code: 7404]").
// The button writes the new database's ID into wrangler.toml, but the Worker upload can fail to resolve it. A database that was
// only just created may not be visible to the upload yet, so this waits and retries (only for that error; any other failure
// stops at once). If it still fails it says which of the possible causes it saw, so the build log is enough to tell them apart.
//   node scripts/deploy.mjs [extra wrangler deploy arguments]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RETRY_DELAYS_S = [20, 40, 60, 60, 60, 60]; // about 4 minutes in all; Workers Builds allows 20 minutes

export function isD1NotFound(out) {
  return /\[code: (10181|7404)\]/.test(out) || /D1 (binding|database)[^\n]*(was not found|could not be found)/i.test(out);
}

/** The DB binding's database_name and database_id from a wrangler.toml text (null when there is none). */
export function d1Settings(toml) {
  const blocks = String(toml).split(/^\s*\[\[d1_databases\]\]\s*$/m).slice(1);
  for (const b of blocks) {
    const body = b.split(/^\s*\[/m)[0];
    const get = (k) => (new RegExp(String.raw`^\s*${k}\s*=\s*"([^"]*)"`, 'm').exec(body) || [])[1] || null;
    if (get('binding') === 'DB') return { name: get('database_name'), id: get('database_id') };
  }
  return null;
}

/** Says what the account's D1 list shows about the database the config points at. */
export function diagnose(cfg, listResult) {
  if (!cfg) return 'The config has no D1 binding named DB.';
  const where = `the config says database "${cfg.name}" with id ${cfg.id}`;
  if (!listResult.ok) return `${where}. Could not list this account's databases (${listResult.why}), so it is not known whether it exists.`;
  const dbs = listResult.databases;
  const byId = dbs.find((d) => d.uuid === cfg.id);
  if (byId) return `${where}. The account DOES have that database (name "${byId.name}"), so the Worker upload could not see a database that exists. That is on Cloudflare's side; retrying.`;
  const byName = dbs.find((d) => d.name === cfg.name);
  if (byName) return `${where}, but the account has a database of that name with a DIFFERENT id (${byName.uuid}). The id in the config is wrong for this account.`;
  return `${where}. The account has NO such database (it has ${dbs.length} other${dbs.length === 1 ? '' : 's'}). The button wrote an id for a database that was never created, or that was removed again.`;
}

export const GUIDANCE = `
The database the deploy form said it would create could not be found, so the deploy cannot continue.
To get past this without waiting for a fix:
  1. In the Cloudflare dashboard go to Storage & databases > D1 and create a database (any name).
  2. Start the Deploy to Cloudflare button again. On the setup page, for the D1 database choose "Use existing" and pick the database you just made
     (do the same for the R2 bucket if it asks).
Nothing else needs doing: the app creates its own tables the first time it runs.`;

function wranglerCommand() {
  const bin = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return existsSync(bin) ? [process.execPath, [bin]] : ['npx', ['wrangler']];
}

export function realExec(args) {
  const [cmd, pre] = wranglerCommand();
  const r = spawnSync(cmd, [...pre, ...args], { cwd: ROOT, encoding: 'utf8', shell: cmd === 'npx' && process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function listDatabases(exec) {
  const r = exec(['d1', 'list', '--json']);
  if (r.code !== 0) return { ok: false, why: (r.out.split('\n').find((l) => /error|permission|auth/i.test(l)) || 'wrangler d1 list failed').trim() };
  try { return { ok: true, databases: JSON.parse(r.out.slice(r.out.indexOf('['))) }; } catch { return { ok: false, why: 'unreadable output' }; }
}

export async function run({ exec = realExec, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), log = console.log, delays = RETRY_DELAYS_S, args = [], tomlText } = {}) {
  const toml = tomlText ?? (existsSync(join(ROOT, 'wrangler.toml')) ? readFileSync(join(ROOT, 'wrangler.toml'), 'utf8') : '');
  const cfg = d1Settings(toml);
  let diagnosed = false;
  for (let attempt = 0; ; attempt++) {
    const r = exec(['deploy', ...args]);
    log(r.out.trimEnd());
    if (r.code === 0) return 0;
    if (!isD1NotFound(r.out)) return r.code;
    if (!diagnosed) { diagnosed = true; log(`\n[deploy] D1 database not found. ${diagnose(cfg, listDatabases(exec))}`); }
    if (attempt >= delays.length) { log(`[deploy] Still not found after ${attempt} retries.${GUIDANCE}`); return r.code; }
    log(`[deploy] Waiting ${delays[attempt]} s, then trying again (${attempt + 1} of ${delays.length}).`);
    await sleep(delays[attempt]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run({ args: process.argv.slice(2) });
}
