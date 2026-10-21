// Server-core tests. They talk to a running local dev server (default http://127.0.0.1:8801):
//   npx wrangler d1 execute DB --local --persist-to .wrangler/agent-server --file=./schema.sql
//   npx wrangler dev --local --port 8801 --persist-to .wrangler/agent-server
// The suite skips itself with a clear message when nothing is listening. It is safe to re-run on the same database.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { addYearsIso, daysBetweenIso, encryptSecret, decryptSecret } from "../src/lib.js";

const BASE = process.env.SDS_BASE || "http://127.0.0.1:8801";
const RUN = Date.now().toString(36);
const ADMIN = { name: "Test Admin", email: "admin@test.example", password: "correct-horse-1" };
const USER = { name: "Test User", email: "user@test.example", password: "battery-staple-2" };
let alive = false;

function setupKey() {
  try {
    const m = fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^SETUP_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  } catch { return undefined; }
}

class Client {
  constructor() { this.cookie = ""; }
  async req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) { payload = JSON.stringify(body); h["Content-Type"] = "application/json"; }
    const res = await fetch(BASE + path, { method, headers: h, body: payload });
    const sc = res.headers.get("set-cookie");
    if (sc) { const v = sc.split(";")[0]; this.cookie = v.endsWith("=") ? "" : v; }
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req("GET", p); }
  post(p, b) { return this.req("POST", p, b ?? {}); }
  put(p, b) { return this.req("PUT", p, b ?? {}); }
  del(p) { return this.req("DELETE", p); }
}

function pdfForm(data, tag = RUN) {
  const fd = new FormData();
  const body = `%PDF-1.4\n% test ${tag} ${Math.random()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`;
  fd.append("file", new Blob([body], { type: "application/pdf" }), `test-${tag}.pdf`);
  if (data) fd.append("data", JSON.stringify(data));
  return fd;
}

const admin = new Client();
const user = new Client();
let userId;

before(async () => {
  try { alive = (await fetch(BASE + "/api/public-settings")).ok; } catch { alive = false; }
  if (!alive) console.log(`SKIPPED: no server at ${BASE}. Start wrangler dev (see top of this file).`);
});
const T = (name, fn) => test(name, async (t) => { if (!alive) return t.skip(`no server at ${BASE}`); await fn(t); });

test("date helpers and secret encryption (no server needed)", async () => {
  assert.equal(addYearsIso("2026-10-19", 5), "2031-10-19");
  assert.equal(addYearsIso("2024-02-29", 5), "2029-02-28");
  assert.equal(addYearsIso("2024-02-29", 4), "2028-02-29");
  assert.equal(daysBetweenIso("2026-01-01", "2026-04-01"), 90);
  const env = { SESSION_SECRET: "unit-test-secret" };
  const blob = await encryptSecret(env, "sk-test-123");
  assert.ok(!blob.includes("sk-test"));
  assert.equal(await decryptSecret(env, blob), "sk-test-123");
  assert.equal(await decryptSecret({ SESSION_SECRET: "other" }, blob), null);
});

T("setup then login", async () => {
  const ps = await admin.get("/api/public-settings");
  assert.equal(ps.status, 200);
  if (ps.data.needs_setup) {
    const bad = await admin.post("/api/setup", { ...ADMIN, setup_key: "wrong" });
    assert.equal(bad.status, 403);
    const r = await admin.post("/api/setup", { ...ADMIN, setup_key: setupKey() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  assert.equal((await admin.get("/api/me")).status, 401);
  assert.equal((await admin.post("/api/login", { email: ADMIN.email, password: "nope-nope-1" })).status, 401);
  const l = await admin.post("/api/login", { email: ADMIN.email, password: ADMIN.password });
  assert.equal(l.status, 200, JSON.stringify(l.data));
  assert.equal(l.data.role, "admin");
  assert.equal((await admin.get("/api/me")).data.email, ADMIN.email);
  const again = await new Client().post("/api/setup", { ...ADMIN, setup_key: setupKey() });
  assert.equal(again.status, 403);
});

T("create user and login as user", async () => {
  const c = await admin.post("/api/users", { ...USER, role: "user" });
  if (c.status === 400) {
    const list = await admin.get("/api/users");
    userId = list.data.find(u => u.email === USER.email).id;
    await admin.put(`/api/users/${userId}`, { password: USER.password, active: true, role: "user" });
  } else { assert.equal(c.status, 201); userId = c.data.id; }
  const l = await user.post("/api/login", { email: USER.email, password: USER.password });
  assert.equal(l.status, 200);
  assert.equal(l.data.role, "user");
});

T("last active admin cannot be demoted or deactivated", async () => {
  const list = await admin.get("/api/users");
  const admins = list.data.filter(u => u.role === "admin" && u.active);
  if (admins.length === 1) {
    assert.equal((await admin.put(`/api/users/${admins[0].id}`, { role: "user" })).status, 409);
    assert.equal((await admin.put(`/api/users/${admins[0].id}`, { active: false })).status, 409);
  }
  assert.equal((await admin.put(`/api/users/999999`, { name: "x" })).status, 404);
});

let chemA, sdsA, assessA;
T("create SDS + chemical, review_due = issue + 5 years, summary in sync", async () => {
  const s = await admin.req("POST", "/api/sds", pdfForm({
    title: `Acetone ${RUN}`, supplier: "ChemCo", issue_date: "2024-02-29", dg_class: "3", signal_word: "danger",
    un_number: "UN1090", packing_group: "II", cas_numbers: "67-64-1",
  }));
  assert.equal(s.status, 201, JSON.stringify(s.data));
  sdsA = s.data.id;
  const meta = await user.get(`/api/sds/${sdsA}`);
  assert.equal(meta.data.review_due, "2029-02-28");
  assert.equal(meta.data.un_number, "1090");
  assert.equal(meta.data.signal_word, "Danger");
  assert.equal(meta.data.has_file, 1);
  const c = await admin.post("/api/chemicals", { product_name: `Acetone ${RUN}`, supplier: "ChemCo", decision: "hazardous", ghs_classification: [{ c: "flam_liq", k: "2" }, { c: "eye_dmg", k: "2A" }], physical_form: "liquid", sds_id: sdsA });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  chemA = c.data.id;
  const g = await user.get(`/api/chemicals/${chemA}`);
  assert.equal(g.status, 200);
  assert.equal(g.data.chemical.review_due, "2029-02-28");
  assert.equal(g.data.chemical.dg_class, "3");
  assert.equal(g.data.chemical.pictograms, "GHS02,GHS07");
  assert.equal(g.data.chemical.signal_word, "Danger");
  assert.equal(g.data.chemical.decision, "hazardous");
  assert.equal(g.data.chemical.decision_by, ADMIN.name);
  assert.equal(g.data.sds.pictograms, undefined);
  assert.equal(g.data.sds.hazardous, undefined);
  assert.equal(g.data.chemical.search_text, undefined);
  assert.equal(g.data.sds.id, sdsA);
  assert.equal(g.data.assessment, null);
  const pdf = await user.get(`/api/sds/${sdsA}/file`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(pdf.headers.get("x-content-type-options"), "nosniff");
  const u = await admin.put(`/api/sds/${sdsA}`, { issue_date: "2025-06-01" });
  assert.equal(u.status, 200);
  const g2 = await user.get(`/api/chemicals/${chemA}`);
  assert.equal(g2.data.chemical.review_due, "2030-06-01");
  assert.equal(g2.data.chemical.sds_issue_date, "2025-06-01");
});

T("assessment create/update/delete keeps chemicals.risk_level in sync", async () => {
  const opts = (await user.get("/api/options")).data;
  const ids = [opts.ppe[0].id, opts.ventilation[0].id];
  const a = await admin.post(`/api/chemicals/${chemA}/assessments`, { risk_level: "significant_controlled", route_inhalation: true, control_option_ids: ids });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assessA = a.data.id;
  let g = await user.get(`/api/chemicals/${chemA}`);
  assert.equal(g.data.chemical.risk_level, "significant_controlled");
  assert.equal(g.data.assessment.controls.length, 2);
  assert.equal(g.data.assessment.assessed_by, ADMIN.name);
  const a2 = await admin.post(`/api/chemicals/${chemA}/assessments`, { risk_level: "not_significant", control_option_ids: [ids[0]] });
  assert.equal(a2.status, 201);
  g = await user.get(`/api/chemicals/${chemA}`);
  assert.equal(g.data.chemical.risk_level, "not_significant");
  const h = await user.get(`/api/chemicals/${chemA}/history`);
  assert.equal(h.data.assessments.length, 1);
  assert.equal(h.data.assessments[0].id, assessA);
  const up = await admin.put(`/api/assessments/${a2.data.id}`, { risk_level: "significant_not_controlled", control_option_ids: [] });
  assert.equal(up.status, 200);
  assert.equal((await user.get(`/api/chemicals/${chemA}`)).data.chemical.risk_level, "significant_not_controlled");
  assert.equal((await admin.post(`/api/chemicals/${chemA}/assessments`, { risk_level: "bogus" })).status, 400);
  assert.equal((await admin.post(`/api/chemicals/${chemA}/assessments`, { control_option_ids: [999999] })).status, 400);
  assert.equal((await admin.del(`/api/assessments/${a2.data.id}`)).status, 200);
  const g3 = await user.get(`/api/chemicals/${chemA}`);
  assert.equal(g3.data.chemical.risk_level, "significant_controlled");
  assert.equal((await user.get(`/api/assessments/${assessA}`)).data.controls.length, 2);
});

T("new SDS version re-points chemicals and keeps history", async () => {
  const c2 = await admin.post("/api/chemicals", { product_name: `Acetone 2 ${RUN}`, supplier: "ChemCo", sds_id: sdsA });
  const r = await admin.req("POST", `/api/sds/${sdsA}/replace`, pdfForm({ issue_date: "2026-01-15", dg_class: "3", cas_numbers: "67-64-1" }, RUN + "v2"));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const newId = r.data.id;
  const g = await user.get(`/api/chemicals/${chemA}`);
  assert.equal(g.data.sds.id, newId);
  assert.equal(g.data.sds.version_no, 2);
  assert.equal(g.data.chemical.review_due, "2031-01-15");
  assert.equal((await user.get(`/api/chemicals/${c2.data.id}`)).data.sds.id, newId);
  const h = await user.get(`/api/chemicals/${chemA}/history`);
  assert.deepEqual(h.data.sds_versions.map(v => v.version_no), [2, 1]);
  assert.equal(h.data.sds_versions[1].is_current, 0);
  assert.equal((await user.get(`/api/sds/${sdsA}/file`)).status, 200);
  assert.equal((await admin.del(`/api/sds/${newId}`)).status, 409);
  assert.equal((await admin.req("POST", `/api/sds/${sdsA}/replace`, pdfForm({}, RUN + "v3"))).status, 400);
  const pc = await user.get(`/api/sds/${newId}/chemicals`);
  assert.equal(pc.data.items.length, 2);
  sdsA = newId;
  await admin.del(`/api/chemicals/${c2.data.id}`);
});

T("link / unlink SDS", async () => {
  const c = await admin.post("/api/chemicals", { product_name: `Linkme ${RUN}` });
  assert.equal((await admin.post(`/api/chemicals/${c.data.id}/link-sds`, { sds_id: sdsA })).status, 200);
  assert.equal((await user.get(`/api/chemicals/${c.data.id}`)).data.chemical.dg_class, "3");
  assert.equal((await admin.post(`/api/chemicals/${c.data.id}/unlink-sds`)).status, 200);
  const g = await user.get(`/api/chemicals/${c.data.id}`);
  assert.equal(g.data.sds, null);
  assert.equal(g.data.chemical.dg_class, null);
  assert.equal(g.data.chemical.review_status, "no_sds");
  await admin.del(`/api/chemicals/${c.data.id}`);
  assert.equal((await user.get(`/api/sds/${sdsA}`)).status, 200);
});

T("classification: derives pictograms, signal word and decision; overrides; [] vs null", async () => {
  const c = await admin.post("/api/chemicals", { product_name: `Cls ${RUN}`, ghs_classification: [{ c: "flam_liq", k: "2" }, { c: "skin_corr", k: "1A" }] });
  const id = c.data.id;
  let g = (await user.get(`/api/chemicals/${id}`)).data.chemical;
  assert.equal(g.decision, "hazardous");
  assert.equal(g.signal_word, "Danger");
  assert.equal(g.pictograms, "GHS02,GHS05");
  assert.ok(g.classification.every(e => e.src === "admin"));
  assert.equal(g.decision_overridden, false);
  assert.equal(g.derived.decision, "hazardous");
  assert.equal((await admin.put(`/api/chemicals/${id}`, { decision_override: "not_hazardous", pictograms_override: ["ghs09"] })).status, 200);
  g = (await user.get(`/api/chemicals/${id}`)).data.chemical;
  assert.equal(g.decision, "not_hazardous");
  assert.equal(g.pictograms, "GHS09");
  assert.equal(g.decision_overridden, true);
  assert.equal(g.pictograms_overridden, true);
  assert.equal(g.decision_override, "not_hazardous");
  assert.equal(g.derived.decision, "hazardous");
  assert.equal(g.derived.pictograms, "GHS02,GHS05");
  const row = (await user.get(`/api/chemicals?q=${encodeURIComponent("cls " + RUN)}`)).data.items[0];
  assert.equal(row.decision_overridden, true);
  assert.equal(row.pictograms_overridden, true);
  assert.equal(row.ghs_classification, undefined);
  assert.equal((await admin.put(`/api/chemicals/${id}`, { pictograms_override: "none" })).status, 200);
  assert.equal((await user.get(`/api/chemicals/${id}`)).data.chemical.pictograms, null);
  assert.equal((await admin.put(`/api/chemicals/${id}`, { decision_override: null, pictograms_override: null })).status, 200);
  g = (await user.get(`/api/chemicals/${id}`)).data.chemical;
  assert.equal(g.decision, "hazardous");
  assert.equal(g.pictograms, "GHS02,GHS05");
  assert.equal(g.decision_overridden, false);
  assert.equal(g.pictograms_overridden, false);
  await admin.put(`/api/chemicals/${id}`, { decision: "not_hazardous", product_name: `Cls ${RUN}` });
  assert.equal((await user.get(`/api/chemicals/${id}`)).data.chemical.decision, "hazardous");
  assert.equal((await admin.put(`/api/chemicals/${id}`, { ghs_classification: [] })).status, 200);
  g = (await user.get(`/api/chemicals/${id}`)).data.chemical;
  assert.deepEqual(g.classification, []);
  assert.equal(g.decision, "not_hazardous");
  assert.equal(g.signal_word, null);
  assert.equal(g.pictograms, null);
  assert.equal((await admin.put(`/api/chemicals/${id}`, { ghs_classification: null })).status, 200);
  g = (await user.get(`/api/chemicals/${id}`)).data.chemical;
  assert.equal(g.classification, null);
  assert.equal(g.decision, null);
  assert.ok((await user.get("/api/review")).data.no_decision.some(r => r.id === id));
  assert.equal((await admin.put(`/api/chemicals/${id}`, { ghs_classification: [{ c: "flam_liq", k: "7" }] })).status, 400);
  assert.equal((await admin.put(`/api/chemicals/${id}`, { ghs_classification: [{ c: "nope", k: "1" }] })).status, 400);
  assert.equal((await admin.put(`/api/chemicals/${id}`, { pictograms_override: "GHS99" })).status, 400);
  assert.equal((await user.put(`/api/chemicals/${id}`, { ghs_classification: [] })).status, 403);
  assert.equal((await user.put(`/api/chemicals/${id}`, { decision_override: "hazardous" })).status, 403);
  assert.equal((await user.post("/api/chemicals", { product_name: "x", ghs_classification: [] })).status, 403);
  await admin.put(`/api/chemicals/${id}`, { ghs_classification: [{ c: "acute_tox", k: "3" }] });
  const e = (await user.get("/api/export/all")).data;
  const ex = e.chemicals.find(x => x.id === id);
  assert.deepEqual(ex.classification, [{ c: "acute_tox", k: "3", src: "admin" }]);
  assert.equal(ex.pictograms, "GHS06");
  assert.ok(Array.isArray(e.places) && Array.isArray(e.links) && Array.isArray(e.place_totals));
  assert.equal(e.locations, undefined);
  assert.equal(e.manifest_totals, undefined);
  await admin.del(`/api/chemicals/${id}`);
});

T("options in use cannot be hard-deleted", async () => {
  const lab = `Test option ${RUN}`;
  const o = await admin.post("/api/options", { kind: "other", label: lab });
  assert.equal(o.status, 201);
  assert.equal((await admin.post("/api/options", { kind: "other", label: lab })).status, 400);
  assert.equal((await admin.post("/api/options", { kind: "nope", label: "x" })).status, 400);
  const a = await admin.post(`/api/chemicals/${chemA}/assessments`, { control_option_ids: [o.data.id] });
  assert.equal(a.status, 201);
  const d = await admin.del(`/api/options/${o.data.id}`);
  assert.equal(d.data.deactivated, true);
  assert.ok(!(await user.get("/api/options")).data.other.some(x => x.id === o.data.id));
  const adm = (await admin.get("/api/options")).data.other.find(x => x.id === o.data.id);
  assert.equal(adm.active, 0);
  const o2 = await admin.post("/api/options", { kind: "other", label: lab + " unused" });
  const d2 = await admin.del(`/api/options/${o2.data.id}`);
  assert.equal(d2.data.deleted, true);
  assert.equal((await admin.put(`/api/options/${o.data.id}`, { active: true })).status, 200);
});

T("import dry run, real import, skip duplicates", async () => {
  const rows = [
    { product_name: `Imp A ${RUN}`, supplier: "S1", location: "Shed", quantity: 5, unit: "litres" },
    { product_name: `Imp A ${RUN}`, supplier: "S1", location: "Yard", quantity: 2, unit: "kg" },
    { product_name: `Imp B ${RUN}`, supplier: "S1" },
    { product_name: "", supplier: "S1" },
    { product_name: `Imp C ${RUN}`, location: "x", quantity: "abc" },
  ];
  const dry = await admin.post("/api/import", { rows, dry_run: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.created, 2);
  assert.equal(dry.data.links_created, 2);
  assert.equal(typeof dry.data.places_created, "number");
  assert.equal(dry.data.errors.length, 2);
  assert.equal((await user.get(`/api/chemicals?q=${encodeURIComponent("imp a " + RUN)}`)).data.items.length, 0);
  const real = await admin.post("/api/import", { rows });
  assert.equal(real.data.created, 2);
  const q = await user.get(`/api/chemicals?q=${encodeURIComponent("imp a " + RUN)}`);
  assert.equal(q.data.items.length, 1);
  const g = await user.get(`/api/chemicals/${q.data.items[0].id}`);
  assert.equal(g.data.places.length, 2);
  assert.equal(g.data.locations, undefined);
  assert.equal(g.data.chemical.source, "import");
  const withDec = await admin.post("/api/import", { rows: [{ product_name: `Imp D ${RUN}`, decision: "hazardous", un_number: "1090", dg_class: "3", location: "L", quantity: 3, spill_compound: "SC" }] });
  assert.equal(withDec.data.created, 1, JSON.stringify(withDec.data));
  const d = (await user.get(`/api/chemicals?q=${encodeURIComponent("imp d " + RUN)}`)).data.items[0];
  const dg = (await user.get(`/api/chemicals/${d.id}`)).data;
  assert.equal(dg.chemical.classification, null);
  assert.equal(dg.chemical.decision, "hazardous");
  assert.equal(dg.chemical.decision_override, "hazardous");
  assert.equal(dg.chemical.decision_overridden, true);
  assert.equal(dg.sds.un_number, "1090");
  assert.equal(dg.places[0].spill_compound, "SC");
  assert.equal(dg.places[0].place_type, "workshop");
  assert.equal(dg.chemical.pictograms, null);
  const again = await admin.post("/api/import", { rows: rows.slice(0, 3) });
  assert.equal(again.data.created, 0);
  assert.equal(again.data.skipped, 3);
});

T("search escapes LIKE wildcards; list filters", async () => {
  assert.equal((await user.get("/api/chemicals?q=%25")).data.items.length, 0);
  assert.equal((await user.get("/api/chemicals?q=_")).data.items.length, 0);
  const all = await user.get("/api/chemicals");
  assert.ok(all.data.total >= 1);
  const haz = await user.get("/api/chemicals?filter=hazardous");
  assert.ok(haz.data.items.every(i => i.decision === "hazardous"));
  assert.equal((await user.get("/api/chemicals?filter=bogus")).status, 400);
  assert.equal((await user.get("/api/chemicals?limit=abc")).status, 400);
  const s = await user.get(`/api/chemicals?q=${encodeURIComponent("67-64-1")}`);
  assert.ok(s.data.items.some(i => i.id === chemA));
});

T("review list and export bundle", async () => {
  const r = await user.get("/api/review");
  assert.equal(r.status, 200);
  for (const k of ["overdue", "due_soon", "no_sds", "no_decision"]) assert.ok(Array.isArray(r.data[k]) && typeof r.data.counts[k] === "number");
  const s = await admin.req("POST", "/api/sds", pdfForm({ title: `Old ${RUN}`, issue_date: "2018-01-01" }, RUN + "old"));
  const c = await admin.post("/api/chemicals", { product_name: `Old chem ${RUN}`, sds_id: s.data.id });
  const r2 = await user.get("/api/review");
  const hit = r2.data.overdue.find(x => x.id === c.data.id);
  assert.equal(hit.review_status, "overdue");
  assert.equal(hit.review_due, "2023-01-01");
  const e = await user.get("/api/export/all");
  assert.equal(e.status, 200);
  for (const k of ["chemicals", "places", "links", "place_totals", "assessments", "sds_files", "company"]) assert.ok(e.data[k] !== undefined);
  assert.ok(e.data.assessments.every(a => Array.isArray(a.controls)));
});

T("a user gets 403 on every admin write and can read everything", async () => {
  const writes = [
    ["PUT", "/api/settings", {}], ["POST", "/api/settings/logo"], ["DELETE", "/api/settings/logo"],
    ["PUT", "/api/settings/ai", {}], ["POST", "/api/settings/ai/test"],
    ["POST", "/api/users", { name: "x", email: "x@x.co", password: "12345678", role: "admin" }], ["PUT", `/api/users/${userId}`, { role: "admin" }],
    ["POST", "/api/chemicals", { product_name: "x" }], ["PUT", `/api/chemicals/${chemA}`, { product_name: "x" }], ["DELETE", `/api/chemicals/${chemA}`],
    ["POST", "/api/places", { name: "x" }], ["PUT", "/api/places/1", { name: "y" }], ["POST", "/api/places/1/chemicals", { chemical_id: 1 }],
    ["POST", `/api/chemicals/${chemA}/places`, { place_id: 1 }], ["PUT", "/api/chemical-places/1", { quantity: 1, unit: "L" }], ["DELETE", "/api/chemical-places/1"], ["DELETE", "/api/places/1"],
    ["POST", `/api/chemicals/${chemA}/link-sds`, { sds_id: sdsA }], ["POST", `/api/chemicals/${chemA}/unlink-sds`],
    ["POST", `/api/chemicals/${chemA}/assessments`, {}], ["PUT", `/api/assessments/${assessA}`, { risk_level: "uncertain" }], ["DELETE", `/api/assessments/${assessA}`],
    ["POST", "/api/sds", {}], ["PUT", `/api/sds/${sdsA}`, { title: "x" }], ["POST", `/api/sds/${sdsA}/replace`, {}], ["DELETE", `/api/sds/${sdsA}`],
    ["POST", "/api/options", { kind: "other", label: "x" }], ["PUT", "/api/options/1", { label: "x" }], ["DELETE", "/api/options/1"],
    ["POST", "/api/import", { rows: [] }], ["POST", "/api/unknown-write", {}],
  ];
  for (const [m, p, b] of writes) {
    const r = await user.req(m, p, b);
    assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
  }
  for (const p of ["/api/settings/ai", "/api/users"]) assert.equal((await user.get(p)).status, 403, p);
  for (const p of ["/api/me", "/api/settings", "/api/review", "/api/chemicals", `/api/chemicals/${chemA}`, `/api/chemicals/${chemA}/history`, "/api/manifest",
    "/api/export/all", "/api/options", `/api/sds/${sdsA}`, `/api/sds/${sdsA}/file`, `/api/sds/${sdsA}/chemicals`, `/api/assessments/${assessA}`]) {
    assert.equal((await user.get(p)).status, 200, p);
  }
  for (const p of ["/api/uploads/precheck", "/api/uploads"]) {
    const r = await user.req("POST", p, {});
    assert.notEqual(r.status, 403, p);
    assert.notEqual(r.status, 401, p);
  }
  const anon = new Client();
  for (const p of ["/api/review", "/api/chemicals", `/api/sds/${sdsA}/file`, "/api/options"]) assert.equal((await anon.get(p)).status, 401, p);
  assert.equal((await anon.post("/api/chemicals", { product_name: "x" })).status, 401);
});

T("validation: bad input is a 400, never a 500", async () => {
  for (const b of [{ product_name: "" }, { product_name: "x".repeat(300) },
    { product_name: "x", physical_form: "jelly" }, { product_name: "x", decision_override: "maybe" },
    { product_name: "x", ghs_classification: [{ c: "flam_liq", k: "9" }] }, { product_name: "x", ghs_classification: "flam_liq" },
    { product_name: "x", pictograms_override: ["toxic"] }, { product_name: "x", sds_id: 99999999 }]) {
    const r = await admin.post("/api/chemicals", b);
    assert.equal(r.status, 400, `${JSON.stringify(b).slice(0, 40)} -> ${r.status}`);
    assert.ok(r.data.error);
  }
  const raw = await fetch(BASE + "/api/chemicals", { method: "POST", headers: { "Content-Type": "application/json", Cookie: admin.cookie }, body: "{nope" });
  assert.equal(raw.status, 400);
  assert.equal((await admin.get("/api/chemicals/abc")).status, 404);
  assert.equal((await admin.get("/api/chemicals/999999")).status, 404);
  const fd = new FormData();
  fd.append("file", new Blob(["not a pdf at all"], { type: "application/pdf" }), "x.pdf");
  assert.equal((await admin.req("POST", "/api/sds", fd)).status, 400);
  assert.equal((await admin.req("POST", "/api/sds", pdfForm({ dg_class: "abc" }))).status, 400);
  const cross = await fetch(BASE + "/api/chemicals", { method: "POST", headers: { "Content-Type": "application/json", Cookie: admin.cookie, Origin: "https://evil.example" }, body: "{}" });
  assert.equal(cross.status, 403);
});

T("settings, logo and delete chemical cascade", async () => {
  const u = await admin.put("/api/settings", { company_name: "Test Co", main_color: "#112233", accent_color: "#336699", upload_max_mb: 20 });
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal((await admin.put("/api/settings", { accent_color: "#EEEEEE" })).status, 400);
  assert.equal((await admin.put("/api/settings", { upload_max_mb: 99 })).status, 400);
  const s = await user.get("/api/settings");
  assert.equal(s.data.company_name, "Test Co");
  assert.equal(s.data.upload_max_mb, 20);
  const fd = new FormData();
  fd.append("file", new Blob(["<svg xmlns='http://www.w3.org/2000/svg'/>"], { type: "image/svg+xml" }), "l.svg");
  assert.equal((await admin.req("POST", "/api/settings/logo", fd)).status, 200);
  assert.equal((await new Client().get("/api/logo")).status, 200);
  assert.equal((await admin.del("/api/settings/logo")).status, 200);
  assert.equal((await new Client().get("/api/logo")).status, 404);
  assert.equal((await admin.put("/api/settings", { upload_max_mb: 15 })).status, 200);
  assert.equal((await admin.del(`/api/chemicals/${chemA}`)).status, 200);
  assert.equal((await admin.get(`/api/chemicals/${chemA}`)).status, 404);
  assert.equal((await admin.get(`/api/assessments/${assessA}`)).status, 404);
});
