// Smoke test of a FRESH DEPLOY from the committed files only, without deploying anything.
//
//   node scripts/smoke-fresh-clone.mjs [--keep] [--ref <git ref>]
//
// It clones this repository (committed files only, so no ignored file can help) into a new temporary folder and, from there:
//   1. installs (npm ci), checks the placeholder wrangler.toml, the cache version and the deploy-related tests;
//   2. bundles the Worker with `wrangler deploy --dry-run` (nothing is uploaded);
//   3. runs the deploy script's schema step against a LOCAL database, twice;
//   4. starts the Worker locally the way a fresh checkout does (`npm run dev`) and walks the first-run path with NO secrets
//      configured: setup, sign-in, the generated signing key, uploads without AI, a place, an audit.
// Exit code 1 if anything fails. --keep leaves the temporary folder in place; otherwise it is always removed.
//
// Safety: only `--local` Wrangler commands and `--dry-run` are used. It never deploys, never uses --remote, never pushes, never reads or
// touches wrangler.local.toml, .dev.vars or any other ignored file of the original checkout, and starts the local Worker WITHOUT the [ai]
// binding (so no real AI service is called). Network use is limited to `npm ci` and whatever Wrangler itself needs.
//
// What it cannot prove: the real button flow, real D1/R2 provisioning, `wrangler d1 execute --remote` inside Workers Builds,
// Workers AI, workers.dev HTTPS / the service worker / Add to Home Screen, and Resend. See docs/DEPLOY.md.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const REF = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "HEAD";
if (!REF) { console.error("--ref needs a value"); process.exit(1); }

// ---------------------------------------------------------------- reporting
const rows = [];
let current = "";
function record(name, ok, detail = "") {
  rows.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  return ok;
}
function info(name, detail) { rows.push({ name, ok: null, detail }); console.log(`  INFO  ${name}  (${detail})`); }
const section = (t) => { current = t; console.log(`\n== ${t}`); };
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1) + "s";

// ---------------------------------------------------------------- process helpers
// Note: the clone uses core.autocrlf=false so it has the same LF line endings as the Linux builder behind the button.
// Runs a command line synchronously; stdout and stderr are returned together. Commands are fixed strings built here, never user input.
function sh(cmd, cwd, extraEnv = {}, timeout = 600000) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, env: cleanEnv(extraEnv) });
  return { code: r.status === null ? -1 : r.status, out: (r.stdout || "") + (r.stderr || ""), err: r.error };
}
function cleanEnv(extra = {}) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...extra };
  // Nothing from the owner's environment may configure the Worker or reach a real service.
  for (const k of ["SETUP_KEY", "SESSION_SECRET", "RESEND_API_KEY", "DEMO_MODE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "WRANGLER_CONFIG",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) delete env[k];
  return env;
}
function tail(s, n = 25) { return s.trim().split(/\r?\n/).slice(-n).join("\n"); }
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (IS_WIN) spawnSync(`taskkill /PID ${child.pid} /T /F`, { shell: true, stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  } catch { /* already gone */ }
}
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function rmDir(dir) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(dir, { recursive: true, force: true }); if (!existsSync(dir)) return true; } catch { /* locked: retry */ }
    spawnSync(IS_WIN ? "ping -n 2 127.0.0.1 >nul" : "sleep 1", { shell: true, stdio: "ignore" });
  }
  return !existsSync(dir);
}

// ---------------------------------------------------------------- HTTP helpers
class Client {
  constructor(base) { this.base = base; this.cookie = ""; }
  async req(method, path, { json, form, raw } = {}) {
    const headers = {};
    let body;
    if (json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    if (form) body = form;
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(this.base + path, { method, headers, body, redirect: "manual" });
    const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of set) { const kv = c.split(";")[0]; if (kv.startsWith("session=")) this.cookie = kv.slice("session=".length) ? kv : ""; }
    const buf = Buffer.from(await res.arrayBuffer());
    let data = null;
    if (!raw && /json/i.test(res.headers.get("content-type") || "")) { try { data = JSON.parse(buf.toString("utf8")); } catch { /* leave null */ } }
    return { status: res.status, headers: res.headers, buf, data, text: raw ? "" : buf.toString("utf8"), setCookie: set };
  }
}

// ---------------------------------------------------------------- main
const t0 = Date.now();
const tmp = mkdtempSync(join(tmpdir(), "sds-ezy-smoke-"));
const clone = join(tmp, "clone");
const state = join(tmp, "state");
const dist = join(tmp, "dist");
let devChild = null;
let devLog = "";
const bodiesSeen = []; // every API response body, checked for the signing key at the end

async function run() {
  console.log(`SDS EZY fresh-clone smoke test\n  source : ${ORIGIN}\n  ref    : ${REF}\n  temp   : ${tmp}${KEEP ? "  (kept)" : ""}`);

  // ---- 1. clone
  section("1. Clone the committed files");
  let t = Date.now();
  let r = sh(`git clone --quiet --no-hardlinks -c core.autocrlf=false "${ORIGIN}" "${clone}"`, tmp);
  if (!record("git clone of the committed repository", r.code === 0, r.code ? tail(r.out, 5) : secs(t))) return;
  if (REF !== "HEAD") {
    r = sh(`git checkout --quiet "${REF}"`, clone);
    if (!record(`checkout ${REF}`, r.code === 0, r.code ? tail(r.out, 5) : "")) return;
  }
  const head = sh("git rev-parse --short HEAD", clone).out.trim();
  info("commit under test", head);
  const mustBeAbsent = ["node_modules", ".wrangler", ".dev.vars", "wrangler.local.toml", "wrangler.generated.toml", "seed-local", "info", "CLAUDE.md", ".claude", ".env"];
  const present = mustBeAbsent.filter((p) => existsSync(join(clone, p)));
  record("no ignored or private files in the clone", present.length === 0, present.length ? "found: " + present.join(", ") : mustBeAbsent.length + " paths checked");
  const demoOut = existsSync(join(clone, "demo-out")) ? readdirSync(join(clone, "demo-out"), { recursive: true }).filter((f) => /\.(pdf|jpe?g|png)$/i.test(String(f))) : [];
  record("no demo-out photos or PDFs in the clone", demoOut.length === 0, demoOut.length ? demoOut.slice(0, 3).join(", ") : "");
  const tomlBefore = sha(readFileSync(join(clone, "wrangler.toml")));

  // ---- 2. npm ci
  section("2. npm ci (committed package-lock.json)");
  t = Date.now();
  r = sh("npm ci --no-audit --no-fund", clone);
  if (!record("npm ci", r.code === 0, r.code ? tail(r.out, 12) : secs(t))) return;
  const wr = sh("npx wrangler --version", clone);
  info("wrangler version", wr.out.trim().split(/\r?\n/).pop());

  // ---- 3. config, version, tests
  section("3. Placeholder, cache version, deploy tests");
  r = sh("node scripts/check-deploy-config.mjs", clone);
  record("check-deploy-config (committed wrangler.toml is a placeholder)", r.code === 0, r.code ? tail(r.out, 6) : "");
  r = sh("npm run check:version", clone);
  record("check:version (public/app-version.js is current in the clone)", r.code === 0, r.code ? tail(r.out, 6) : "");
  t = Date.now();
  r = sh("node --test tests/deploy-config.test.mjs tests/audit-schema.test.mjs tests/places-migration.test.mjs tests/ghs-ref.test.mjs", clone);
  const pass = (r.out.match(/^\W*(?:# )?pass (\d+)/m) || [])[1], fail = (r.out.match(/^\W*(?:# )?fail (\d+)/m) || [])[1];
  record("deploy-related tests", r.code === 0, `pass ${pass}, fail ${fail}, ${secs(t)}${r.code ? "\n" + tail(r.out, 15) : ""}`);

  // ---- 4. dry-run
  section("4. wrangler deploy --dry-run (bundle only, nothing uploaded)");
  t = Date.now();
  r = sh(`npx wrangler deploy --dry-run --outdir "${dist}"`, clone);
  const bindingLines = r.out.split(/\r?\n/).filter((l) => /^\s*env\.\w+|Total Upload|Your Worker has access|--dry-run|Binding/i.test(l) && l.trim());
  const dryOk = record("wrangler deploy --dry-run", r.code === 0, r.code ? tail(r.out, 15) : secs(t));
  if (dryOk) {
    console.log(bindingLines.map((l) => "        " + l.trim()).join("\n"));
    for (const b of ["DB", "FILES", "AI", "ASSETS"]) record(`dry-run lists binding ${b}`, new RegExp(`env\\.${b}\\b`).test(r.out));
    const bundle = existsSync(dist) ? readdirSync(dist).filter((f) => /\.m?js$/.test(f)) : [];
    record("bundle written to --outdir", bundle.length > 0, bundle.join(", "));
    const js = bundle.length ? readFileSync(join(dist, bundle[0]), "utf8") : "";
    record("bundle includes public/lib/ghs-ref.mjs", /ghs|GHS/.test(js) && js.length > 50000, `${Math.round(js.length / 1024)} KB`);
    info("dry-run bindings", bindingLines.filter((l) => /env\./.test(l)).map((l) => l.trim().replace(/\s+/g, " ")).join(" | "));
  }
  record("dry-run did not modify wrangler.toml", sha(readFileSync(join(clone, "wrangler.toml"))) === tomlBefore);

  // ---- 5. schema step, twice, local
  section("5. Schema step against a local database (twice) and predeploy");
  const query = `npx wrangler d1 execute DB --local --persist-to "${state}" --json --command "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name"`;
  const lists = [];
  for (const n of [1, 2]) {
    t = Date.now();
    r = sh(`npx wrangler d1 execute DB --local --persist-to "${state}" --yes --file=./schema.sql`, clone);
    if (!record(`db:init (local) run ${n}`, r.code === 0, r.code ? tail(r.out, 15) : secs(t))) return;
    const q = sh(query, clone);
    let names = null;
    try { const j = JSON.parse(q.out.slice(q.out.indexOf("["))); names = j[0].results.map((x) => x.type + ":" + x.name); } catch { /* reported below */ }
    if (!record(`table list readable after run ${n}`, !!names && names.length > 0, names ? names.length + " objects" : tail(q.out, 6))) return;
    lists.push(names);
  }
  record("table list unchanged between the two runs", JSON.stringify(lists[0]) === JSON.stringify(lists[1]));
  const wantTables = ["users", "settings", "chemicals", "sds", "places", "audits", "chemical_places"];
  const missing = wantTables.filter((x) => !lists[1].includes("table:" + x));
  record("core tables exist", missing.length === 0, missing.length ? "missing " + missing.join(", ") : wantTables.join(", "));
  r = sh("npm run predeploy", clone);
  record("predeploy (bump-version) runs", r.code === 0, r.code ? tail(r.out, 6) : "");
  const changed = sh("git status --porcelain", clone).out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
  record("predeploy touched only public/app-version.js", changed.every((f) => f === "public/app-version.js"), changed.length ? changed.join(", ") : "no change (already current)");

  // ---- 6. dev server
  section("6. Start the Worker locally (npm run dev, fresh-clone path)");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const devCmd = `npm run dev -- --port ${port} --ip 127.0.0.1 --persist-to "${state}"`;
  devChild = spawn(devCmd, { cwd: clone, shell: true, detached: !IS_WIN, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  devChild.stdout.on("data", (d) => { devLog += d; });
  devChild.stderr.on("data", (d) => { devLog += d; });
  let ready = false;
  t = Date.now();
  for (let i = 0; i < 240 && devChild.exitCode === null; i++) {
    try { const x = await fetch(base + "/api/public-settings"); if (x.status === 200) { ready = true; break; } } catch { /* not up yet */ }
    await sleep(500);
  }
  if (!record("Worker answers /api/public-settings", ready, ready ? secs(t) : tail(devLog, 25))) return;
  const genPath = join(clone, "wrangler.generated.toml");
  const gen = existsSync(genPath) ? readFileSync(genPath, "utf8") : "";
  record("wrangler.generated.toml was generated", !!gen);
  record("generated config has no [ai] table", !!gen && !/^\s*\[ai\]/m.test(gen) && !/binding\s*=\s*"AI"/.test(gen));
  record("generated config keeps DB, FILES and assets", /binding\s*=\s*"DB"/.test(gen) && /binding\s*=\s*"FILES"/.test(gen) && /\[assets\]/.test(gen));
  record("committed wrangler.toml byte-identical after dev start", sha(readFileSync(join(clone, "wrangler.toml"))) === tomlBefore);
  record("dev log says [ai] was left out", /without the \[ai\] block/.test(devLog));
  record("dev log shows no AI binding", !/env\.AI\b/.test(devLog));

  // ---- 7. first run
  section("7. First-run path with no secrets configured");
  const anon = new Client(base);
  const keep = (res) => { bodiesSeen.push({ path: "", text: res.text }); return res; };

  let x = keep(await anon.req("GET", "/api/public-settings"));
  record("public-settings: needs_setup true, setup_key_required false", x.data && x.data.needs_setup === true && x.data.setup_key_required === false, JSON.stringify(x.data));
  record("public-settings: no demo flag", x.data && !x.data.demo);

  const assets = [
    ["/", /text\/html/], ["/manifest.webmanifest", /json|manifest/], ["/sw.js", /javascript/], ["/app-version.js", /javascript/],
    ["/lib/ghs-ref.mjs", /javascript/], ["/pictograms/ghs-flame-pictogram.jpg", /image\/jpeg/],
  ];
  const noCacheWanted = new Set(["/sw.js", "/app-version.js", "/manifest.webmanifest"]);
  const headerNotes = [];
  for (const [p, ct] of assets) {
    x = await anon.req("GET", p, { raw: true });
    const type = x.headers.get("content-type") || "";
    record(`GET ${p} -> 200 ${type.split(";")[0]}`, x.status === 200 && ct.test(type) && x.buf.length > 0, `${x.buf.length} bytes`);
    if (noCacheWanted.has(p)) headerNotes.push(`${p}: ${x.headers.get("cache-control") || "(none)"}`);
  }
  const served = headerNotes.every((n) => /no-cache/.test(n));
  info("Cache-Control from public/_headers under wrangler dev", served ? "served: " + headerNotes.join("; ") : "NOT served locally (" + headerNotes.join("; ") + "); the file itself is checked below");
  const hdrFile = readFileSync(join(clone, "public/_headers"), "utf8");
  record("public/_headers sets no-cache for /sw.js, /app-version.js, /manifest.webmanifest",
    [...noCacheWanted].every((p) => new RegExp(`${p.replace(/\./g, "\\.")}\\s*\\n\\s*Cache-Control:\\s*no-cache`).test(hdrFile)));

  const admin = { name: "Smoke Admin", email: "admin@smoke.example", password: "smoke-test-pass-1" };
  x = keep(await anon.req("GET", "/api/me"));
  record("GET /api/me without a session -> 401", x.status === 401);
  x = keep(await anon.req("POST", "/api/setup", { json: admin }));
  record("POST /api/setup creates the first admin (201)", x.status === 201, x.status + " " + x.text.slice(0, 120));
  x = keep(await anon.req("POST", "/api/setup", { json: { ...admin, email: "second@smoke.example" } }));
  record("a second setup is refused (403)", x.status === 403, x.status + "");
  x = keep(await anon.req("GET", "/api/public-settings"));
  record("public-settings now needs_setup false", x.data && x.data.needs_setup === false);

  const adm = new Client(base);
  x = keep(await adm.req("POST", "/api/login", { json: { email: admin.email, password: admin.password } }));
  record("admin login -> 200 with a session cookie", x.status === 200 && /^session=./.test(adm.cookie) && x.setCookie.some((c) => /HttpOnly/i.test(c)), `${x.status}; ${(x.setCookie[0] || "").replace(/=[^;]+/, "=<token>")}`);
  x = keep(await adm.req("POST", "/api/login", { json: { email: admin.email, password: "wrong-password" } }));
  record("wrong password -> 401", x.status === 401);
  x = keep(await adm.req("GET", "/api/me"));
  record("GET /api/me as admin", x.status === 200 && x.data && x.data.role === "admin" && x.data.email === admin.email);
  for (const p of ["/api/settings", "/api/users", "/api/settings/ai", "/api/chemicals", "/api/places"]) { keep(await adm.req("GET", p)); }

  x = keep(await adm.req("POST", "/api/places", { json: { name: "Smoke Workshop", place_type: "workshop" } }));
  const placeId = x.data && x.data.id;
  record("admin creates a place (201)", x.status === 201 && !!placeId, x.status + " " + x.text.slice(0, 100));
  x = keep(await adm.req("POST", "/api/chemicals", { json: { product_name: "Fictional Smoke Solvent", supplier: "Example Supplies" } }));
  const chemId = x.data && x.data.id;
  record("admin creates a chemical (201)", x.status === 201 && !!chemId, x.status + " " + x.text.slice(0, 100));
  x = keep(await adm.req("POST", `/api/places/${placeId}/chemicals`, { json: { chemical_id: chemId, quantity: 5, unit: "L" } }));
  record("admin records the chemical at the place (201)", x.status === 201, x.status + " " + x.text.slice(0, 100));

  // logo (R2 FILES binding)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  let form = new FormData(); form.append("file", new Blob([png], { type: "image/png" }), "logo.png");
  x = keep(await adm.req("POST", "/api/settings/logo", { form }));
  record("logo upload stores in R2 (200)", x.status === 200, x.status + " " + x.text.slice(0, 100));
  x = await anon.req("GET", "/api/logo", { raw: true });
  record("GET /api/logo returns the same image", x.status === 200 && /image\/png/.test(x.headers.get("content-type") || "") && x.buf.equals(png), x.status + "");

  // user
  const user = { name: "Smoke User", email: "user@smoke.example", password: "smoke-user-pass-1" };
  x = keep(await adm.req("POST", "/api/users", { json: { ...user, role: "user" } }));
  record("admin creates a plain user (201)", x.status === 201, x.status + " " + x.text.slice(0, 100));
  const usr = new Client(base);
  x = keep(await usr.req("POST", "/api/login", { json: { email: user.email, password: user.password } }));
  record("plain user can sign in", x.status === 200 && /^session=./.test(usr.cookie), x.status + "");
  x = keep(await usr.req("GET", "/api/chemicals"));
  record("plain user can read the register", x.status === 200);
  for (const [m, p, body] of [["POST", "/api/chemicals", { product_name: "Nope" }], ["POST", "/api/places", { name: "Nope" }], ["PUT", `/api/chemicals/${chemId}`, { product_name: "Nope" }], ["POST", "/api/users", { ...user, email: "x@smoke.example", role: "admin" }]]) {
    x = keep(await usr.req(m, p, { json: body }));
    record(`plain user cannot ${m} ${p} (403)`, x.status === 403, x.status + "");
  }

  // upload with no AI
  const pdfBytes = await makePdf(clone);
  form = new FormData(); form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "Fictional Smoke Solvent SDS.pdf");
  form.append("place_id", String(placeId));
  x = keep(await usr.req("POST", "/api/uploads", { form }));
  const sdsId = x.data && x.data.sds_id;
  record("PDF upload with no AI -> 200 mode draft_only", x.status === 200 && x.data && x.data.mode === "draft_only", x.status + " " + x.text.slice(0, 200));
  record("upload reports that no AI draft was made", !!(x.data && x.data.ai_error), x.data && x.data.ai_error ? x.data.ai_error.slice(0, 90) : "no ai_error");
  x = await usr.req("GET", `/api/sds/${sdsId}/file`, { raw: true });
  record("GET /api/sds/:id/file returns the stored PDF from R2", x.status === 200 && /pdf/.test(x.headers.get("content-type") || "") && x.buf.equals(Buffer.from(pdfBytes)), `${x.status}, ${x.buf.length} bytes`);
  x = keep(await usr.req("POST", "/api/uploads", { form: (() => { const f = new FormData(); f.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "again.pdf"); return f; })() }));
  record("the same PDF again is refused as an exact duplicate (409)", x.status === 409, x.status + "");

  // audit by the user
  x = keep(await usr.req("POST", "/api/audits", { json: { client_id: "smoke-audit-0001", place_id: placeId } }));
  const auditId = x.data && x.data.audit && x.data.audit.id;
  record("user starts an audit (201)", (x.status === 200 || x.status === 201) && !!auditId, x.status + " " + x.text.slice(0, 100));
  const item = x.data && x.data.items && x.data.items[0];
  record("the audit lists the place's chemical", !!item, item ? "chemical_id " + item.chemical_id : "no items");
  if (item) {
    x = keep(await usr.req("PUT", `/api/audits/${auditId}/items/${item.chemical_id}`, { json: { result: "present" } }));
    record("user marks the item present", x.status === 200, x.status + " " + x.text.slice(0, 100));
  }
  x = keep(await usr.req("POST", `/api/audits/${auditId}/finish`, { json: {} }));
  record("user finishes the audit", x.status === 200 && x.data && x.data.audit && x.data.audit.status === "finished", x.status + " " + x.text.slice(0, 120));
  x = keep(await usr.req("GET", `/api/audits/${auditId}`));
  record("finished audit can be read back", x.status === 200);
  x = keep(await usr.req("GET", "/api/review"));
  record("GET /api/review works", x.status === 200 && x.data && typeof x.data === "object");
  x = keep(await adm.req("POST", "/api/chemicals", { json: { product_name: "x".repeat(300) } }));
  info("over-long name handled", x.status + " (no 500 expected)");
  record("no request in this walk caused a 500", !bodiesSeen.some((b) => /Something went wrong on the server/.test(b.text)));
  record("dev log shows no unhandled errors", !/(\[ERROR\]|Uncaught|TypeError|ReferenceError)/.test(devLog), (devLog.match(/.*(\[ERROR\]|Uncaught|TypeError|ReferenceError).*/) || [""])[0].slice(0, 160));

  // ---- stop the server, then inspect the database
  killTree(devChild); devChild = null;
  await sleep(2500);
  r = sh(`npx wrangler d1 execute DB --local --persist-to "${state}" --json --command "SELECT key, length(value) AS n, substr(value,1,200) AS v FROM settings"`, clone);
  let settings = null;
  try { settings = JSON.parse(r.out.slice(r.out.indexOf("[")))[0].results; } catch { /* reported below */ }
  const sec = settings && settings.find((s) => s.key === "session_secret");
  record("generated signing key exists in the settings table", !!sec && sec.n >= 32, sec ? `${sec.n} characters` : tail(r.out, 6));
  if (sec) {
    const leaked = bodiesSeen.some((b) => b.text.includes(sec.v));
    record("signing key is not returned by any API response seen", !leaked, bodiesSeen.length + " responses checked");
    const cookieHasIt = [adm.cookie, usr.cookie].some((c) => c.includes(sec.v));
    record("signing key is not in the session cookie", !cookieHasIt);
  }
  r = sh(`npx wrangler d1 execute DB --local --persist-to "${state}" --json --command "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sds) AS sds, (SELECT COUNT(*) FROM audits WHERE status='finished') AS audits"`, clone);
  info("database after the walk", r.out.replace(/\s+/g, " ").slice(r.out.indexOf("results"), r.out.indexOf("results") + 90));
  record("committed wrangler.toml still byte-identical at the end", sha(readFileSync(join(clone, "wrangler.toml"))) === tomlBefore);
}

async function makePdf(cloneDir) {
  const require = createRequire(join(cloneDir, "package.json"));
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Fictional Smoke Solvent - Safety Data Sheet (test file)", { x: 20, y: 250, size: 12, font });
  page.drawText("Made by scripts/smoke-fresh-clone.mjs. Not a real product.", { x: 20, y: 230, size: 10, font });
  return await doc.save();
}

let crashed = null;
try { await run(); } catch (e) { crashed = e; record("script ran to the end", false, String(e && e.stack ? e.stack : e).split("\n").slice(0, 4).join(" | ")); }
finally {
  killTree(devChild);
  if (!KEEP) {
    await sleep(2000);
    const gone = rmDir(tmp);
    if (!gone) console.log(`\n(could not remove ${tmp}; remove it by hand)`);
  } else console.log(`\nKept: ${tmp}`);
}

console.log("\n==================== RESULT ====================");
const fails = rows.filter((r) => r.ok === false);
for (const r of rows) if (r.ok !== null) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : r.detail ? "  <- " + r.detail.split("\n")[0] : ""}`);
console.log(`\n${rows.filter((r) => r.ok === true).length} passed, ${fails.length} failed, ${secs(t0)} total${crashed ? " (script crashed)" : ""}`);
if (fails.length && !KEEP) console.log("Re-run with --keep to inspect the temporary clone.");
process.exit(fails.length || crashed ? 1 : 0);
