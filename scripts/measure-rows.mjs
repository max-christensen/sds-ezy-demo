// Measures D1 rows read per request against a running LOCAL dev server started with DEBUG_ROWS=1:
//   npx wrangler dev --local --port 8801 --persist-to .wrangler/agent-server --var DEBUG_ROWS:1
//   node scripts/measure-rows.mjs [--base http://127.0.0.1:8801] [--sizes 60,600]
// It creates five places (workshop, ute, site, depot, van; the first holds 20 chemicals) and tops the register up with synthetic "Measure NNNN" products (each with an SDS record, a place link, and an
// assessment on every second one) until the register holds each size, and prints the X-Rows-Read header for the key requests.
// Admin login comes from MEASURE_EMAIL / MEASURE_PASSWORD (default: the test admin the server tests create).
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg("base", "http://127.0.0.1:8801");
const SIZES = arg("sizes", "66,600").split(",").map(Number);
const EMAIL = process.env.MEASURE_EMAIL || "admin@test.example";
const PASSWORD = process.env.MEASURE_PASSWORD || "correct-horse-1";
let cookie = "";

async function call(method, path, body) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}) };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const rows = res.headers.get("x-rows-read");
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  return { status: res.status, data, rows: rows === null ? null : Number(rows) };
}

const login = await call("POST", "/api/login", { email: EMAIL, password: PASSWORD });
if (login.status !== 200) { console.error("Login failed:", login.status, login.data); process.exit(1); }
if (login.rows === null) { console.error("No X-Rows-Read header: start the server with --var DEBUG_ROWS:1"); process.exit(1); }
console.log(`login                     rows_read=${login.rows}`);
// A second login, to show the steady-state number (the first can include one-off settings writes).
const login2 = await call("POST", "/api/login", { email: EMAIL, password: PASSWORD });
console.log(`login (again)             rows_read=${login2.rows}`);

function pdfForm(i, data) {
  const fd = new FormData();
  fd.append("file", new Blob([`%PDF-1.4\n% measure ${i} ${Math.random()}\n%%EOF\n`], { type: "application/pdf" }), `m${i}.pdf`);
  fd.append("data", JSON.stringify(data));
  return fd;
}

const placeIds = [];
async function ensurePlaces() {
  const have = (await call("GET", "/api/places")).data;
  for (const [name, type] of [["Measure Workshop", "workshop"], ["Measure Ute", "vehicle"], ["Measure Site", "site"], ["Measure Depot", "workshop"], ["Measure Van", "vehicle"]]) {
    const f = have.find(p => p.name === name && p.place_type === type);
    placeIds.push(f ? f.id : (await call("POST", "/api/places", { name, place_type: type })).data.id);
  }
}
async function topUp(target) {
  if (!placeIds.length) await ensurePlaces();
  const all = (await call("GET", "/api/chemicals?limit=2000")).data.items.filter(c => c.product_name.startsWith("Measure item"));
  let n = all.length;
  const classes = ["3", "8", "2.1", "6.1", "", "9"];
  while (n < target) {
    n++;
    const year = 2019 + (n % 8);
    const hasSds = n % 10 !== 0;
    let sdsId;
    if (hasSds) {
      const s = await call("POST", "/api/sds", pdfForm(n, {
        title: `Measure item ${n}`, supplier: `Supplier ${n % 17}`, issue_date: `${year}-0${1 + (n % 9)}-15`,
        dg_class: classes[n % classes.length] || undefined, signal_word: "Warning", cas_numbers: "67-64-1",
      }));
      sdsId = s.data.id;
    }
    const c = await call("POST", "/api/chemicals", {
      product_name: `Measure item ${n}`, supplier: `Supplier ${n % 17}`, ghs_classification: n % 7 === 0 ? null : (n % 2 ? [{ c: "flam_liq", k: String(1 + (n % 4)) }, { c: "eye_dmg", k: "2A" }] : []),
      synonyms: "synonym alpha, synonym beta", product_codes: `P-${n}`, sds_id: sdsId,
    });
    await call("POST", `/api/places/${placeIds[n <= 20 ? 0 : 1 + (n % 2)]}/chemicals`, { chemical_id: c.data.id, spill_compound: n % 5 === 0 ? "Bund A" : undefined, quantity: 5 + (n % 20), unit: n % 3 ? "L" : "kg" });
    if (n % 2 === 0) await call("POST", `/api/chemicals/${c.data.id}/assessments`, { risk_level: "significant_controlled", control_option_ids: [1, 6] });
  }
}

const results = [];
for (const size of SIZES) {
  await topUp(size);
  const total = (await call("GET", "/api/chemicals?limit=1")).data.total;
  const list = await call("GET", "/api/chemicals");
  const review = await call("GET", "/api/review");
  const hazardous = await call("GET", "/api/chemicals?filter=hazardous");
  const sample = list.data.items.find(c => c.sds_id && c.product_name.startsWith("Measure item"));
  const one = await call("GET", `/api/chemicals/${sample.id}`);
  const search = await call("GET", "/api/chemicals?q=measure%20item%2012");
  const search2 = await call("GET", "/api/chemicals?q=acetone");
  const manifest = await call("GET", "/api/manifest");
  const exp = await call("GET", "/api/export/all");
  const picker = await call("GET", "/api/places");
  const page = await call("GET", `/api/places/${placeIds[0]}`);
  const synth = list.data.items.filter(c => c.product_name.startsWith("Measure item")).slice(0, 30).map(c => c.id);
  const pack10 = await call("GET", `/api/pack?ids=${synth.slice(0, 10).join(",")}`);
  const pack30 = await call("GET", `/api/pack?ids=${synth.join(",")}`);
  console.log(`\n--- register holds ${total} chemicals (${size} synthetic target) ---`);
  const row = (k, r) => console.log(`${k.padEnd(26)}rows_read=${r.rows}  (status ${r.status})`);
  row("GET /api/review", review);
  row("GET /api/chemicals", list);
  row("GET /api/chemicals hazardous", hazardous);
  row("GET /api/chemicals/:id", one);
  row("search ?q= (few hits)", search);
  row("search ?q= (many hits)", search2);
  row("GET /api/manifest", manifest);
  row("GET /api/export/all", exp);
  row("GET /api/places (picker)", picker);
  row("GET /api/places/:id (20 chem)", page);
  row("GET /api/pack (10 chem)", pack10);
  row("GET /api/pack (30 chem)", pack30);
  results.push({ size, total });
}

// ---------------------------------------------------------------- audits (run once, after the sizes above)
console.log("--- audits ---");
const synth = (await call("GET", "/api/chemicals?limit=2000")).data.items.filter(c => c.product_name.startsWith("Measure item")).map(c => c.id);
const uid = () => crypto.randomUUID();
const have2 = (await call("GET", "/api/places")).data;
async function auditPlace(name, n) {
  let p = have2.find(x => x.name === name);
  if (!p) {
    const id = (await call("POST", "/api/places", { name, place_type: "workshop" })).data.id;
    for (const cid of synth.slice(0, n)) await call("POST", `/api/places/${id}/chemicals`, { chemical_id: cid, quantity: 5, unit: "L" });
    p = { id };
  }
  return p.id;
}
const p17 = await auditPlace("Measure Audit17", 17);
const p62 = await auditPlace("Measure Audit62", 62);
const row = (k, r) => console.log(`${k.padEnd(34)}rows_read=${r.rows}  (status ${r.status})`);
const s17 = await call("POST", "/api/audits", { place_id: p17, client_id: uid(), started_at: new Date().toISOString() });
row("start audit (17 chemicals)", s17);
const s62 = await call("POST", "/api/audits", { place_id: p62, client_id: uid(), started_at: new Date().toISOString() });
row("start audit (62 chemicals)", s62);
const a17 = s17.data.audit.id, a62 = s62.data.audit.id;
let ms = null;
for (const it of s17.data.items) ms = await call("PUT", `/api/audits/${a17}/items/${it.chemical_id}`, { result: "not_found", marked_at: new Date().toISOString() });
row("mark one item", ms);
for (const it of s62.data.items.slice(0, 3)) await call("PUT", `/api/audits/${a62}/items/${it.chemical_id}`, { result: "not_found", marked_at: new Date().toISOString() });
for (let i = 0; i < 3; i++) await call("POST", `/api/audits/${a17}/found`, { client_id: uid(), product_name: `Measure found ${i}`, action: "record", found_at: new Date().toISOString() });
const dids = [uid(), uid()];
for (const d of dids) await call("POST", `/api/audits/${a17}/disposals`, { client_id: d, description: "Old drum", reason: "expired", flagged_at: new Date().toISOString() });
const jpeg = new Uint8Array(150000); jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
for (let i = 0; i < 12; i++) {
  const fd = new FormData();
  fd.append("file", new Blob([jpeg], { type: "image/jpeg" }), "p.jpg"); fd.append("client_id", uid());
  fd.append("owner_type", i < 3 ? "disposal" : "item"); fd.append("owner_key", i < 3 ? dids[0] : String(s17.data.items[i % 17].chemical_id));
  fd.append("taken_at", new Date().toISOString());
  const r = await call("POST", `/api/audits/${a17}/photos`, fd);
  if (i === 0) row("upload one photo", r);
}
row("finish audit (17 items)", await call("POST", `/api/audits/${a17}/finish`, { finished_at: new Date().toISOString() }));
await call("POST", `/api/audits/${a62}/finish`, { finished_at: new Date().toISOString() });
row("GET /api/audits/:id (report)", await call("GET", `/api/audits/${a17}`));
row("GET /api/findings (open)", await call("GET", "/api/findings"));
row("GET /api/disposals", await call("GET", "/api/disposals"));
row("GET /api/review (with new group)", await call("GET", "/api/review"));
row("GET /api/places/:id (history)", await call("GET", `/api/places/${p17}`));
row("GET /api/audits (list)", await call("GET", "/api/audits"));
const rep = (await call("GET", `/api/audits/${a17}`)).data;
console.log(`open findings: ${(await call("GET", "/api/findings?limit=500")).data.length}; photos on report: ${rep.photos.length}; ` +
  `R2 storage for that audit = SUM(bytes) = ${rep.photos.reduce((n, p) => n + p.bytes, 0)} bytes (summary.photo_bytes = ${rep.audit.summary && rep.audit.summary.photo_bytes})`);
