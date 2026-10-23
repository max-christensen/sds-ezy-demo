// The "Deploy to Cloudflare" setup: the committed wrangler.toml is a placeholder, the deploy script loads the schema, the secrets
// prompt is empty, the README has the button, and nothing from the ignore list is tracked. Runs from a clean clone too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPlaceholder, PLACEHOLDER_DB_ID } from "../scripts/check-deploy-config.mjs";
import { withoutAiBlock, pickConfig } from "../scripts/dev.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const git = (...args) => { try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const inGit = git("rev-parse", "--is-inside-work-tree") !== null;
// The version of wrangler.toml that is (or is about to be) committed, never a developer's private working copy.
// (Line endings are normalised: git on Windows may hand back CRLF.)
const committedToml = () => (git("show", "HEAD:wrangler.toml") ?? git("show", ":wrangler.toml") ?? read("wrangler.toml")).replace(/\r\n/g, "\n");

test("the committed wrangler.toml is a placeholder: names only, no real IDs, no secrets", () => {
  assert.deepEqual(checkPlaceholder(committedToml()), []);
});

test("the committed wrangler.toml has exactly the resources the button must create", () => {
  const t = committedToml();
  assert.match(t, /^name = "sds-ezy"$/m);
  assert.match(t, /binding = "DB"\s*\ndatabase_name = "sds-ezy-db"\s*\ndatabase_id = "REPLACE_WITH_YOUR_DATABASE_ID"/);
  assert.match(t, /binding = "FILES"\s*\nbucket_name = "sds-ezy-files"/);
  assert.match(t, /\[ai\]\s*\nbinding = "AI"/);
  assert.match(t, /\[assets\][\s\S]*directory = "\.\/public"[\s\S]*binding = "ASSETS"[\s\S]*run_worker_first = \["\/api\/\*"\]/);
  assert.equal(PLACEHOLDER_DB_ID, "REPLACE_WITH_YOUR_DATABASE_ID");
});

test("the checker rejects a file that carries a real ID, an account, a secret, an environment or extra variables", () => {
  const good = committedToml();
  // (The placeholder text also appears in a comment, so replace the database_id LINE, not the first occurrence.)
  assert.ok(checkPlaceholder(good.replace(`database_id = "${PLACEHOLDER_DB_ID}"`, 'database_id = "0b8c6a52-1d0e-4c52-9a58-3f2f7d3d0a11"')).length > 0);
  assert.ok(checkPlaceholder(good.replace(`database_id = "${PLACEHOLDER_DB_ID}"`, 'database_id = "fedcba9876543210fedcba9876543210"')).length > 0);
  assert.ok(checkPlaceholder(good.replace(`database_id = "${PLACEHOLDER_DB_ID}"`, 'database_id = "some-other-text"')).length > 0);
  assert.ok(checkPlaceholder('account_id = "0123456789abcdef0123456789abcdef"\n' + good).length > 0);
  assert.ok(checkPlaceholder(good.replace('[vars]\n', '[vars]\nSESSION_SECRET = "abc"\n')).length > 0);
  assert.ok(checkPlaceholder(good + '\n[env.staging]\nname = "x"\n').length > 0);
  assert.ok(checkPlaceholder(good.replace('"sds-ezy-files"', '"someone-elses-bucket"')).length > 0);
  assert.ok(checkPlaceholder(good.replace("[ai]\nbinding = \"AI\"\n", "")).length > 0, "removing the AI binding breaks the no-setup default");
});

test("the bindings the code needs are all in wrangler.toml, and it uses no old one", () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
  walk("src");
  const used = new Set();
  for (const f of files) for (const m of read(f).matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) used.add(m[1]);
  // ASSETS is not used by the code: static files are served before the Worker runs (run_worker_first only sends /api/* to it).
  for (const b of ["DB", "FILES", "AI"]) assert.ok(used.has(b), `the code never uses ${b}`);
  assert.ok(!used.has("ATTACHMENTS"), "the old ATTACHMENTS binding is still referenced");
});

test("package.json: the deploy script is wrangler deploy with a retry (no build-time database step); the Worker sets up its own tables", () => {
  const p = JSON.parse(read("package.json"));
  assert.equal(p.scripts.deploy, "node scripts/deploy.mjs", "wrangler deploy with a retry for the D1-not-found upload error; no build-time D1 step (error 7404)");
  assert.ok(!/db:init|d1 execute/.test(p.scripts.deploy + p.scripts.predeploy), "deploy and predeploy must not touch the remote database");
  assert.equal(p.scripts["db:init"], "wrangler d1 execute DB --remote --yes --file=./schema.sql");
  assert.ok(!/sds-ezy-db/.test(p.scripts["db:init"]), "reference the DB binding, not the database name (the button renames resources)");
  assert.equal(p.scripts.predeploy, "node scripts/bump-version.mjs && node scripts/build-schema.mjs");
  // The local schema step goes through dev.mjs so it uses the SAME config (and so the same local database) as `npm run dev`.
  assert.match(p.scripts["db:init:local"], /^node scripts\/dev\.mjs --wrangler d1 execute DB --local .*schema\.sql/);
  assert.equal(p.scripts.dev, "node scripts/dev.mjs");
  assert.equal(p.engines.node, ">=20");
  assert.ok(p.devDependencies.wrangler, "the build installs wrangler from package.json");
  assert.ok(fs.existsSync(path.join(ROOT, "package-lock.json")));
});

test("package.json describes the bindings for the button's setup page", () => {
  const b = JSON.parse(read("package.json")).cloudflare.bindings;
  for (const k of ["DB", "FILES", "AI"]) assert.ok(b[k] && b[k].description.length > 30, k);
});

test("the schema the deploy loads is safe to run on every deploy", () => {
  const sql = read("schema.sql");
  const creates = [...sql.matchAll(/^\s*CREATE\s+(TABLE|INDEX|TRIGGER|UNIQUE INDEX)\s+(?!IF NOT EXISTS)/gim)];
  assert.equal(creates.length, 0, "every CREATE must be IF NOT EXISTS");
  assert.ok(!/\bDROP\s+TABLE\b/i.test(sql), "schema.sql must never drop a table");
  assert.ok(!/^\s*ALTER\s+TABLE\b/im.test(sql), "schema.sql must not alter tables (it runs on every deploy)");
});

test(".dev.vars.example has no active settings, so the button asks for nothing and a fresh deploy needs no secrets", () => {
  const active = read(".dev.vars.example").split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#"));
  assert.deepEqual(active, []);
});

test("README has the Deploy to Cloudflare button pointing at this repo, and no stale template step", () => {
  const r = read("README.md");
  assert.ok(r.includes("[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/max-christensen/SDS-EZY)"));
  assert.ok(!/wrangler\.template\.toml/.test(r));
  assert.ok(!fs.existsSync(path.join(ROOT, "wrangler.template.toml")));
});

test(".gitignore keeps private files out but does NOT ignore the committed wrangler.toml", () => {
  const lines = read(".gitignore").split(/\r?\n/).map(l => l.trim());
  for (const must of [".dev.vars", ".env", ".wrangler/", "seed-local/", "CLAUDE.md", ".claude/", ".mcp.json", "info/", "BRIEF.md", "wrangler.local.toml", "wrangler.generated.toml", "node_modules/"]) assert.ok(lines.includes(must), must);
  assert.ok(!lines.includes("wrangler.toml"));
});

test("nothing from the ignore list is tracked by git", { skip: !inGit }, () => {
  const tracked = git("ls-files").split("\n").filter(Boolean);
  const bad = tracked.filter(f => /(^|\/)(wrangler\.local\.toml|wrangler\.generated\.toml|\.dev\.vars|CLAUDE\.md|\.mcp\.json|BRIEF\.md)$/.test(f) || /^(\.wrangler|seed-local|\.claude|\.claude-flow|info)\//.test(f) || /^demo-out\/(demo\.sql|pdfs|photos|summary\.json)/.test(f));
  assert.deepEqual(bad, []);
  assert.ok(tracked.includes("wrangler.toml"));
});

test("npm run dev: the AI block is removed for local work and wrangler.toml is never modified", () => {
  const base = committedToml();
  const out = withoutAiBlock(base);
  assert.ok(!/^\[ai\]/m.test(out));
  assert.ok(!/binding = "AI"/.test(out));
  for (const keep of ['name = "sds-ezy"', 'binding = "DB"', 'binding = "FILES"', 'binding = "ASSETS"', "MAIL_FROM"]) assert.ok(out.includes(keep), keep);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdsezy-dev-"));
  fs.writeFileSync(path.join(dir, "wrangler.toml"), base);
  const before = fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8");
  const gen = pickConfig({}, dir);
  assert.equal(gen.path, "wrangler.generated.toml");
  assert.ok(!/^\[ai\]/m.test(fs.readFileSync(path.join(dir, "wrangler.generated.toml"), "utf8")));
  assert.equal(fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8"), before, "wrangler.toml was modified");
  fs.writeFileSync(path.join(dir, "wrangler.local.toml"), "# mine\n");
  assert.equal(pickConfig({}, dir).path, "wrangler.local.toml", "your own local config wins");
  assert.equal(pickConfig({ WRANGLER_CONFIG: "x.toml" }, dir).path, "x.toml");
  assert.equal(fs.readFileSync(path.join(dir, "wrangler.local.toml"), "utf8"), "# mine\n", "your local config was modified");
});

test("dev.mjs: warns when your own config still has the [ai] block, and runs wrangler without a shell", async () => {
  const { hasAiBlock, wranglerCommand } = await import("../scripts/dev.mjs");
  assert.equal(hasAiBlock('[ai]\nbinding = "AI"\n'), true);
  assert.equal(hasAiBlock('# the [ai] block is removed\nname = "x"\n'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdsezy-dev2-"));
  fs.writeFileSync(path.join(dir, "wrangler.toml"), committedToml());
  fs.writeFileSync(path.join(dir, "wrangler.local.toml"), committedToml()); // a local config that still has [ai]
  assert.equal(pickConfig({}, dir).warnAi, true);
  fs.writeFileSync(path.join(dir, "wrangler.local.toml"), withoutAiBlock(committedToml()));
  assert.equal(pickConfig({}, dir).warnAi, false);
  assert.equal(pickConfig({}, dir).path, "wrangler.local.toml");
  // With wrangler installed (as in this repo) it runs through node directly: no shell, so arguments with spaces survive and kill() stops it.
  const w = wranglerCommand(ROOT);
  if (fs.existsSync(path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"))) { assert.equal(w.shell, false); assert.equal(w.cmd, process.execPath); }
});

test("the demo seed script and the local schema step use the same config as `npm run dev`", () => {
  assert.match(read("scripts/seed-demo-local.mjs"), /pickConfig\(\)\.path/);
  assert.match(read("scripts/seed-demo-local.mjs"), /'-c', config/);
});

test("the hook installer asks git where hooks live (worktrees, core.hooksPath) and the hook runs the staged check", () => {
  const s = read("scripts/install-git-hook.mjs");
  assert.match(s, /rev-parse", "--git-path", "hooks"/);
  assert.match(s, /check-deploy-config\.mjs --staged/);
});

test("docs/DEPLOY.md does not overstate the schema, and says how to deploy with your own local config", () => {
  const d = read("docs/DEPLOY.md");
  assert.match(d, /7404/);
  assert.match(d, /clears that legacy table/, "the doc must mention that one migration copies and then clears the legacy table");
  assert.match(d, /wrangler deploy -c wrangler\.local\.toml/);
  assert.match(d, /d1 execute DB --remote --yes --file=\.\/schema\.sql -c wrangler\.local\.toml/);
  assert.match(d, /skip-worktree[\s\S]*fragile/i);
});
