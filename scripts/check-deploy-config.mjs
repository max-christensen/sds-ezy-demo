// Checks that the committed wrangler.toml is the safe PLACEHOLDER the "Deploy to Cloudflare" button uses:
// names only, no real IDs, no account details, no secrets.
//
//   node scripts/check-deploy-config.mjs            check the committed version (git HEAD), or the working file if this is not a git checkout
//   node scripts/check-deploy-config.mjs --staged   check what is about to be committed (used by the pre-commit hook: node scripts/install-git-hook.mjs)
//   node scripts/check-deploy-config.mjs --file x   check a given file
//
// Exits 1 and says what is wrong if anything is not a placeholder.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PLACEHOLDER_DB_ID = "REPLACE_WITH_YOUR_DATABASE_ID";

/** Returns a list of problems (empty = it is a safe placeholder). */
export function checkPlaceholder(text) {
  const problems = [];
  // Drop comments (whole-line ones and trailing ones) so only real settings are checked.
  const lines = String(text).split(/\r?\n/).map(l => l.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, "").trimEnd());
  const code = lines.join("\n");
  const want = (re, msg) => { if (!re.test(code)) problems.push(msg); };

  want(/^name\s*=\s*"sds-ezy"\s*$/m, 'name must be "sds-ezy"');
  want(/^\[\[d1_databases\]\][\s\S]*?binding\s*=\s*"DB"/m, 'the D1 binding must be "DB"');
  want(/database_name\s*=\s*"sds-ezy-db"/, 'the D1 database name must be "sds-ezy-db"');
  want(new RegExp(`database_id\\s*=\\s*"${PLACEHOLDER_DB_ID}"`), `database_id must be exactly "${PLACEHOLDER_DB_ID}" (a real ID has been put in this file)`);
  want(/^\[\[r2_buckets\]\][\s\S]*?binding\s*=\s*"FILES"/m, 'the R2 binding must be "FILES"');
  want(/bucket_name\s*=\s*"sds-ezy-files"/, 'the R2 bucket name must be "sds-ezy-files"');
  want(/^\[ai\]\s*\n\s*binding\s*=\s*"AI"/m, 'the [ai] binding "AI" must be present');
  want(/^\[assets\][\s\S]*?directory\s*=\s*"\.\/public"/m, 'assets must serve ./public');

  // Nothing that identifies an account or carries a secret.
  for (const [re, msg] of [
    [/^\s*account_id\s*=/m, "account_id must not be in the committed file"],
    [/^\s*(zone_id|zone_name|route|routes|workers_dev|preview_id)\s*=/m, "routes / zone settings must not be in the committed file"],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a UUID (a real resource ID?) is in the file"],
    [/\b[0-9a-f]{32}\b/i, "a 32-character hex string (a real ID?) is in the file"],
    [/(api[_-]?key|secret|token|password)\s*=/i, "something that looks like a secret is in the file"],
    [/^\[env\./m, "environments are not used here; they would carry their own IDs"],
    [/^\[\[(kv_namespaces|queues|hyperdrive|vectorize|services)\]\]/m, "unexpected bindings in the committed file"],
  ]) if (re.test(code)) problems.push(msg);

  // [vars]: only MAIL_FROM.
  const vars = code.match(/^\[vars\]\s*\n((?:(?!\[).*\n?)*)/m);
  if (vars) for (const l of vars[1].split("\n").map(x => x.trim()).filter(Boolean)) if (!/^MAIL_FROM\s*=/.test(l)) problems.push(`[vars] may only hold MAIL_FROM (found: ${l.split("=")[0].trim()})`);
  return problems;
}

function gitShow(spec) {
  try { return execFileSync("git", ["show", spec], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}

function main(argv) {
  let text, from;
  const fi = argv.indexOf("--file");
  if (fi >= 0) { from = argv[fi + 1]; text = readFileSync(from, "utf8"); }
  else if (argv.includes("--staged")) { from = "the staged wrangler.toml"; text = gitShow(":wrangler.toml"); if (text === null) { console.log("wrangler.toml is not staged: nothing to check."); return 0; } }
  else { from = "the committed wrangler.toml (HEAD)"; text = gitShow("HEAD:wrangler.toml"); if (text === null) { const f = join(ROOT, "wrangler.toml"); if (!existsSync(f)) { console.error("No wrangler.toml found."); return 1; } from = "wrangler.toml (working file)"; text = readFileSync(f, "utf8"); } }
  const problems = checkPlaceholder(text);
  if (problems.length) {
    console.error(`NOT a safe placeholder: ${from}`);
    for (const p of problems) console.error("  - " + p);
    console.error("Do not commit real IDs. Keep your own values out of git: git update-index --skip-worktree wrangler.toml");
    return 1;
  }
  console.log(`OK: ${from} is a placeholder (names only, no real IDs or secrets).`);
  return 0;
}

if (process.argv[1] && /check-deploy-config.mjs$/.test(process.argv[1])) process.exitCode = main(process.argv.slice(2));
