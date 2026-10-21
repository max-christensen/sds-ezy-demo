// Turns schema.sql into src/schema.generated.js: the statements the Worker applies to its own database the first time it runs
// (and again whenever schema.sql changes), so a fresh deploy never depends on a build-time `wrangler d1 execute --remote`.
//   node scripts/build-schema.mjs           write it (npm run predeploy does this)
//   node scripts/build-schema.mjs --check   exit 1 if the file on disk is out of date
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(root, 'src', 'schema.generated.js');

// Splits SQL into statements at ';' outside single-quoted strings ('' is an escaped quote), dropping '--' comments.
// schema.sql has no triggers (no BEGIN ... END), which this splitter does not handle; a test enforces that.
export function splitSql(sql) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) {
      cur += c;
      if (c === "'") { if (sql[i + 1] === "'") { cur += "'"; i++; } else q = false; }
    } else if (c === "'") { q = true; cur += c; }
    else if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; cur += '\n'; }
    else if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (q) throw new Error('schema.sql: unterminated string');
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function schemaHash(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

export function render(sql = readFileSync(join(root, 'schema.sql'), 'utf8')) {
  return `// GENERATED from schema.sql by scripts/build-schema.mjs (npm run predeploy). Do not edit by hand.\n`
    + `export const SCHEMA_HASH = ${JSON.stringify(schemaHash(sql))};\n`
    + `export const SCHEMA_STATEMENTS = ${JSON.stringify(splitSql(sql), null, 1)};\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render();
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (current !== text) { console.error('src/schema.generated.js is out of date. Run: node scripts/build-schema.mjs'); process.exit(1); }
    console.log('src/schema.generated.js is current.');
  } else {
    if (current !== text) writeFileSync(TARGET, text);
    console.log(`${current === text ? 'Unchanged' : 'Wrote'} src/schema.generated.js`);
  }
}
