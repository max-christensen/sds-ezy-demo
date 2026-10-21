// Writes public/app-version.js: the app's version (a hash of every file under public/ except app-version.js itself)
// and the list of files the service worker caches up front. Run it before every deploy (npm run predeploy).
//   node scripts/bump-version.mjs           write it
//   node scripts/bump-version.mjs --check   exit 1 if the file on disk is out of date
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(root, 'public');
const SELF = 'app-version.js';
const NOISE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
// Text files (line endings are normalised before hashing). Includes extensionless ones such as _headers and LICENSE, which a Windows
// checkout with core.autocrlf would otherwise hash as CRLF.
const TEXT = /(\.(js|mjs|css|html|svg|json|webmanifest|txt|md)|(^|\/)(_headers|LICENSE[^/]*))$/i;

export function listFiles(dir = PUBLIC) {
  const out = [];
  (function walk(d) {
    for (const name of readdirSync(d).sort()) {
      if (NOISE.has(name) || name.startsWith('~$') || name.endsWith('.tmp')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  })(dir);
  return out.sort().filter((f) => f !== SELF);
}

function bytesOf(file, dir) {
  const buf = readFileSync(join(dir, file));
  // Line endings must not change the version (Windows checkout versus Linux).
  return TEXT.test(file) ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n')) : buf;
}

export function computeVersion(dir = PUBLIC) {
  const h = createHash('sha256');
  for (const f of listFiles(dir)) {
    h.update(f); h.update('\0'); h.update(bytesOf(f, dir)); h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

// Files the service worker caches at install. The vendor libraries are cached as they are used.
export function shellFiles(dir = PUBLIC) {
  const skip = (f) => f === 'sw.js' || f === '_headers' || f === SELF || f.startsWith('vendor/') || f === 'index.html' || /\.map$/.test(f) || /^LICENSE/i.test(f);
  const files = listFiles(dir).filter((f) => !skip(f)).map((f) => '/' + f);
  return ['/', '/app-version.js', ...files];
}

export function render(dir = PUBLIC) {
  return `self.APP_VERSION = ${JSON.stringify(computeVersion(dir))};\n`
    + `self.APP_SHELL = ${JSON.stringify(shellFiles(dir), null, 0).replace(/","/g, '",\n  "').replace('["', '[\n  "').replace('"]', '"\n]')};\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = join(PUBLIC, SELF);
  const text = render();
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (current !== text) { console.error('public/app-version.js is out of date. Run: node scripts/bump-version.mjs'); process.exit(1); }
    console.log('public/app-version.js is current.');
  } else {
    if (current !== text) writeFileSync(target, text);
    console.log(`${current === text ? 'Unchanged' : 'Wrote'} public/app-version.js: ${/APP_VERSION = "([^"]+)"/.exec(text)[1]}`);
  }
}
