// Places, per-place totals, manifest and job-pack read tests. Same setup as server-main.test.mjs (a running local dev server,
// default http://127.0.0.1:8801, override with SDS_BASE). Skips itself with a message when nothing is listening.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const BASE = process.env.SDS_BASE || "http://127.0.0.1:8801";
const RUN = Date.now().toString(36);
const ADMIN = { name: "Test Admin", email: "admin@test.example", password: "correct-horse-1" };
const USER = { name: "Test User", email: "user@test.example", password: "battery-staple-2" };
const NOTE = "Products in transit fall under the transport rules and are not counted here.";
let alive = false;

function setupKey() {
  try {
    const m = fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^SETUP_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  } catch { return undefined; }
}

class Client {
  constructor() { this.cookie = ""; }
  async req(method, path, body) {
    const h = {};
    if (this.cookie) h.Cookie = this.cookie;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) { payload = JSON.stringify(body); h["Content-Type"] = "application/json"; }
    const res = await fetch(BASE + path, { method, headers: h, body: payload });
    const sc = res.headers.get("set-cookie");
    if (sc) { const v = sc.split(";")[0]; this.cookie = v.endsWith("=") ? "" : v; }
    const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req("GET", p); }
  post(p, b) { return this.req("POST", p, b ?? {}); }
  put(p, b) { return this.req("PUT", p, b ?? {}); }
  del(p) { return this.req("DELETE", p); }
}

function pdfForm(data, tag) {
  const fd = new FormData();
  fd.append("file", new Blob([`%PDF-1.4\n% places ${tag} ${Math.random()}\n%%EOF\n`], { type: "application/pdf" }), `p-${tag}.pdf`);
  fd.append("data", JSON.stringify(data));
  return fd;
}

const admin = new Client();
const user = new Client();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The main suite may be setting the database up at the same moment (files run in parallel), so retry the sign-in.
async function signIn(client, who) {
  for (let i = 0; i < 25; i++) {
    const ps = (await client.get("/api/public-settings")).data;
    if (ps.needs_setup && who === ADMIN) await client.post("/api/setup", { ...ADMIN, setup_key: setupKey() });
    const r = await client.post("/api/login", { email: who.email, password: who.password });
    if (r.status === 200) return;
    if (who === USER && i === 5) await admin.post("/api/users", { ...USER, role: "user" });
    await sleep(400);
  }
  throw new Error(`could not sign in ${who.email}`);
}

before(async () => {
  try { alive = (await fetch(BASE + "/api/public-settings")).ok; } catch { alive = false; }
  if (!alive) { console.log(`SKIPPED: no server at ${BASE}. See server-main.test.mjs for how to start one.`); return; }
  await signIn(admin, ADMIN);
  await signIn(user, USER);
});
const T = (name, fn) => test(name, async (t) => { if (!alive) return t.skip(`no server at ${BASE}`); await fn(t); });

const mkPlace = async (name, type = "workshop", extra = {}) => {
  const r = await admin.post("/api/places", { name: `${name} ${RUN}`, place_type: type, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
};
const mkChem = async (name, cls, extra = {}) => {
  const r = await admin.post("/api/chemicals", { product_name: `${name} ${RUN}`, ghs_classification: cls, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
};
const link = async (placeId, chemId, quantity, unit, extra = {}) => {
  const r = await admin.post(`/api/places/${placeId}/chemicals`, { chemical_id: chemId, quantity, unit, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
};
const count = async (placeId) => (await user.get("/api/places?archived=all")).data.find(p => p.id === placeId).chemical_count;

T("place create / edit / archive, type defaults, validation", async () => {
  const w = await mkPlace("Workshop A");
  const v = await mkPlace("Ute", "vehicle", { registration: " abc-123 " });
  const s = await mkPlace("Site A", "site");
  const list = (await user.get("/api/places")).data;
  const byId = Object.fromEntries(list.map(p => [p.id, p]));
  assert.equal(byId[w].counts_toward_totals, 1);
  assert.equal(byId[v].counts_toward_totals, 0);
  assert.equal(byId[s].counts_toward_totals, 1);
  assert.equal(byId[v].registration, "ABC-123");
  assert.equal(byId[w].chemical_count, 0);
  for (const k of ["id", "name", "place_type", "registration", "counts_toward_totals", "archived", "notes", "chemical_count"]) assert.ok(k in byId[w], k);
  // validation
  assert.equal((await admin.post("/api/places", { name: `workshop a ${RUN}`, place_type: "workshop" })).status, 400); // same type, case-insensitive
  assert.equal((await admin.post("/api/places", { name: `Workshop A ${RUN}`, place_type: "site" })).status, 201);   // other type is fine
  assert.equal((await admin.post("/api/places", { name: "", place_type: "workshop" })).status, 400);
  assert.equal((await admin.post("/api/places", { name: "x".repeat(121) })).status, 400);
  assert.equal((await admin.post("/api/places", { name: "T", place_type: "shed" })).status, 400);
  assert.equal((await admin.post("/api/places", { name: `Reg ${RUN}`, place_type: "workshop", registration: "ABC" })).status, 400);
  assert.equal((await admin.post("/api/places", { name: `Reg2 ${RUN}`, place_type: "vehicle", registration: "X".repeat(21) })).status, 400);
  // edit
  assert.equal((await admin.put(`/api/places/${v}`, { counts_toward_totals: true, notes: "Hilux" })).status, 200);
  assert.equal((await user.get("/api/places")).data.find(p => p.id === v).counts_toward_totals, 1);
  assert.equal((await admin.put(`/api/places/${v}`, { counts_toward_totals: false })).status, 200);
  assert.equal((await admin.put(`/api/places/${w}`, { name: `Workshop B ${RUN}` })).status, 200);
  assert.equal((await admin.put(`/api/places/${w}`, { registration: "NOPE" })).status, 400);
  assert.equal((await admin.put(`/api/places/999999`, { name: "z" })).status, 404);
  assert.equal((await admin.put(`/api/places/${w}`, {})).status, 400);
  // archive: hidden from the default list, present with archived=1 / all, name freed, unarchive re-checks the name
  assert.equal((await admin.put(`/api/places/${w}`, { archived: true })).status, 200);
  assert.ok(!(await user.get("/api/places")).data.some(p => p.id === w));
  assert.ok((await user.get("/api/places?archived=1")).data.some(p => p.id === w));
  assert.ok((await user.get("/api/places?archived=all")).data.some(p => p.id === w));
  assert.equal((await user.get("/api/places?archived=7")).status, 400);
  const w2 = await mkPlace("Workshop B");
  assert.equal((await admin.put(`/api/places/${w}`, { archived: false })).status, 400);
  assert.equal((await admin.put(`/api/places/${w2}`, { archived: true })).status, 200);
  assert.equal((await admin.put(`/api/places/${w}`, { archived: false })).status, 200);
  assert.equal((await admin.del(`/api/places/${w}`)).status, 404);
});

T("a user can read places and a place page but gets 403 on every place write", async () => {
  const p = await mkPlace("ReadOnly");
  const c = await mkChem("ROChem", [{ c: "flam_liq", k: "3" }]);
  const l = await link(p, c, 5, "L");
  for (const [m, path, b] of [
    ["POST", "/api/places", { name: "n" }], ["PUT", `/api/places/${p}`, { name: "n" }], ["POST", `/api/places/${p}/chemicals`, { chemical_id: c }],
    ["POST", `/api/chemicals/${c}/places`, { place_id: p }], ["PUT", `/api/chemical-places/${l}`, { quantity: 1, unit: "L" }],
    ["DELETE", `/api/chemical-places/${l}`], ["DELETE", `/api/places/${p}`],
  ]) assert.equal((await user.req(m, path, b)).status, 403, `${m} ${path}`);
  assert.equal((await user.get("/api/places")).status, 200);
  const page = await user.get(`/api/places/${p}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.place.id, p);
  assert.equal(page.data.chemicals.length, 1);
  const row = page.data.chemicals[0];
  for (const k of ["link_id", "chemical_id", "product_name", "supplier", "decision", "decision_overridden", "pictograms", "signal_word", "risk_level",
    "sds_id", "sds_issue_date", "review_due", "review_status", "has_assessment", "classification", "quantity", "unit", "container_note", "spill_compound"]) assert.ok(k in row, k);
  assert.equal(row.has_assessment, false);
  assert.equal(row.review_status, "no_sds");
  assert.equal(page.data.result.counts, true);
  assert.equal((await user.get("/api/pack?ids=" + c)).status, 200);
  assert.equal((await new Client().get("/api/places")).status, 401);
  assert.equal((await new Client().get("/api/pack?ids=1")).status, 401);
  assert.equal((await user.get("/api/places/999999")).status, 404);
});

T("links: create / update / delete keep chemical_count right; archived places refuse links", async () => {
  const p1 = await mkPlace("Count1");
  const p2 = await mkPlace("Count2", "site");
  const c1 = await mkChem("CountChem1", []);
  const c2 = await mkChem("CountChem2", []);
  const l1 = await link(p1, c1, 10, "L", { container_note: "2 x 5 L", spill_compound: "Bund 1" });
  await link(p1, c2);
  const l3 = (await admin.post(`/api/chemicals/${c1}/places`, { place_id: p2, quantity: 3, unit: "kg" }));
  assert.equal(l3.status, 201);
  assert.equal(await count(p1), 2);
  assert.equal(await count(p2), 1);
  assert.equal((await admin.post(`/api/places/${p1}/chemicals`, { chemical_id: c1, quantity: 1, unit: "L" })).status, 400); // duplicate
  assert.equal((await admin.post(`/api/places/${p1}/chemicals`, { chemical_id: 99999999 })).status, 404);
  assert.equal((await admin.post(`/api/places/${p2}/chemicals`, { chemical_id: c2, quantity: 5 })).status, 400);      // no unit
  assert.equal((await admin.post(`/api/places/${p2}/chemicals`, { chemical_id: c2, quantity: -5, unit: "L" })).status, 400);
  assert.equal((await admin.post(`/api/places/${p2}/chemicals`, { chemical_id: c2, quantity: 5, unit: "gal" })).status, 400);
  assert.equal(await count(p2), 1);
  // the chemical page lists its places
  const g = (await user.get(`/api/chemicals/${c1}`)).data;
  assert.equal(g.locations, undefined);
  assert.deepEqual(g.places.map(x => x.name).sort(), [`Count1 ${RUN}`, `Count2 ${RUN}`]);
  const own = g.places.find(x => x.place_id === p1);
  for (const k of ["link_id", "place_id", "name", "place_type", "registration", "archived", "counts_toward_totals", "quantity", "unit", "container_note", "spill_compound"]) assert.ok(k in own, k);
  assert.equal(own.spill_compound, "Bund 1");
  // update
  assert.equal((await admin.put(`/api/chemical-places/${l1}`, { quantity: 12, unit: "L", container_note: "3 x 4 L" })).status, 200);
  assert.equal((await admin.put(`/api/chemical-places/${l1}`, { quantity: null })).status, 200);
  const cleared = (await user.get(`/api/chemicals/${c1}`)).data.places.find(x => x.place_id === p1);
  assert.equal(cleared.quantity, null);
  assert.equal(cleared.unit, null);
  assert.equal((await admin.put(`/api/chemical-places/${l1}`, { quantity: 5 })).status, 400);
  assert.equal((await admin.put(`/api/chemical-places/${l1}`, {})).status, 400);
  assert.equal((await admin.put(`/api/chemical-places/999999`, { quantity: 1, unit: "L" })).status, 404);
  // archived place: keeps links, refuses new ones
  assert.equal((await admin.put(`/api/places/${p2}`, { archived: true })).status, 200);
  assert.equal((await admin.post(`/api/places/${p2}/chemicals`, { chemical_id: c2 })).status, 400);
  assert.equal(await count(p2), 1);
  // delete a link, then delete a chemical
  assert.equal((await admin.del(`/api/chemical-places/${l1}`)).status, 200);
  assert.equal(await count(p1), 1);
  assert.equal((await admin.del(`/api/chemical-places/${l1}`)).status, 404);
  assert.equal((await admin.put(`/api/places/${p2}`, { archived: false })).status, 200);
  await link(p1, c1, 1, "L");
  await link(p2, c2, 1, "L");
  assert.equal(await count(p1), 2);
  assert.equal(await count(p2), 2);
  assert.equal((await admin.del(`/api/chemicals/${c1}`)).status, 200);
  assert.equal(await count(p1), 1);
  assert.equal(await count(p2), 1);
  assert.equal((await admin.del(`/api/chemicals/${c2}`)).status, 200);
  assert.equal(await count(p1), 0);
  assert.equal(await count(p2), 0);
});

T("totals are per place; a vehicle is not counted; archived places are not totalled", async () => {
  const w1 = await mkPlace("TotW1");
  const w2 = await mkPlace("TotW2");
  const veh = await mkPlace("TotVan", "vehicle", { registration: "TOT1" });
  const f = [{ c: "flam_liq", k: "2" }];
  const a = await mkChem("TotA", f), b = await mkChem("TotB", f), c = await mkChem("TotC", f), d = await mkChem("TotD", f);
  // 200 L in each of two workshops: not over the 250 L placard quantity anywhere
  await link(w1, a, 200, "L");
  await link(w2, b, 200, "L");
  let m = (await user.get("/api/manifest")).data;
  const pl = (id) => m.places.find(x => x.place.id === id);
  assert.equal(pl(w1).totals.items.find(i => i.item === 7).total, 200);
  assert.equal(pl(w2).totals.items.find(i => i.item === 7).total, 200);
  assert.deepEqual(pl(w1).over.placard, []);
  assert.deepEqual(pl(w2).over.placard, []);
  assert.ok(pl(w1).near.placard.includes(7)); // 200 of 250 is 80 %
  assert.ok(m.summary.near_placard.some(x => x.place_id === w1));
  assert.ok(!m.summary.over_placard.some(x => x.place_id === w1 || x.place_id === w2));
  // 300 L in ONE workshop is over
  await link(w1, c, 100, "L");
  m = (await user.get("/api/manifest")).data;
  assert.equal(pl(w1).totals.items.find(i => i.item === 7).total, 300);
  assert.ok(pl(w1).over.placard.includes(7));
  assert.ok(m.summary.over_placard.some(x => x.place_id === w1 && x.place_name === `TotW1 ${RUN}` && x.items.includes(7)));
  assert.ok(!m.summary.over_placard.some(x => x.place_id === w2));
  assert.equal(pl(w1).rows.length, 2);
  assert.deepEqual(pl(w1).rows[0].items, [7]);
  assert.equal(pl(w1).rows[0].pictograms, "GHS02");
  // the place page gives the same check
  const page = (await user.get(`/api/places/${w1}`)).data;
  assert.ok(page.result.over.placard.includes(7));
  // a vehicle with a lot of flammable liquid: no totals, the transport note, listed under not_counted
  await link(veh, d, 900, "L");
  m = (await user.get("/api/manifest")).data;
  assert.ok(!pl(veh));
  const nc = m.not_counted.find(x => x.place.id === veh);
  assert.equal(nc.note, NOTE);
  assert.ok(nc.caveat && /not been confirmed/i.test(nc.caveat));
  assert.ok(!m.summary.over_placard.some(x => x.place_id === veh));
  const vp = (await user.get(`/api/places/${veh}`)).data;
  assert.equal(vp.result.counts, false);
  assert.equal(vp.result.totals, null);
  assert.equal(vp.result.note, NOTE);
  // ...while a workshop with the same product and quantity goes over
  const w3 = await mkPlace("TotW3");
  await link(w3, d, 900, "L");
  m = (await user.get("/api/manifest")).data;
  assert.ok(pl(w3).over.placard.includes(7));
  // switching the vehicle on makes it count
  assert.equal((await admin.put(`/api/places/${veh}`, { counts_toward_totals: true })).status, 200);
  m = (await user.get("/api/manifest")).data;
  assert.ok(pl(veh).over.placard.includes(7));
  assert.equal((await admin.put(`/api/places/${veh}`, { counts_toward_totals: false })).status, 200);
  // archived: dropped from the manifest (both lists), still readable, not totalled
  assert.equal((await admin.put(`/api/places/${w3}`, { archived: true })).status, 200);
  m = (await user.get("/api/manifest")).data;
  assert.ok(!pl(w3));
  assert.ok(!m.not_counted.some(x => x.place.id === w3));
  assert.ok(!m.summary.over_placard.some(x => x.place_id === w3));
  const arch = (await user.get(`/api/places/${w3}`)).data;
  assert.equal(arch.result.counts, false);
  assert.equal(arch.chemicals.length, 1);
  // export/all carries places, links and place_totals for the active counting places only
  const e = (await user.get("/api/export/all")).data;
  assert.ok(e.places.some(p => p.id === w3 && p.archived === 1));
  assert.ok(e.links.some(l => l.place_id === w1));
  assert.ok(e.place_totals.some(r => r.place.id === w1 && r.counts));
  assert.ok(!e.place_totals.some(r => r.place.id === w3));
  // non-hazardous-by-override chemical in a counting place is still totalled (classification decides)
  const w4 = await mkPlace("TotW4");
  const o = await mkChem("TotOvr", f, { decision_override: "not_hazardous" });
  await link(w4, o, 260, "L");
  m = (await user.get("/api/manifest")).data;
  assert.ok(pl(w4).over.placard.includes(7));
  assert.equal(pl(w4).rows.length, 0);
});

T("job pack: chemicals with sds, assessment and places; works with no SDS or no assessment", async () => {
  const p = await mkPlace("PackPlace");
  const sds = await admin.req("POST", "/api/sds", pdfForm({ title: `Pack SDS ${RUN}`, issue_date: "2025-03-01", un_number: "1090" }, RUN + "a"));
  const sds2 = await admin.req("POST", "/api/sds", pdfForm({ title: `Pack SDS2 ${RUN}`, issue_date: "2025-03-02" }, RUN + "b"));
  const full = await mkChem("PackFull", [{ c: "flam_liq", k: "3" }], { sds_id: sds.data.id });
  const noAssess = await mkChem("PackNoAssess", [], { sds_id: sds2.data.id });
  const noSds = await mkChem("PackNoSds", [{ c: "acute_tox", k: "3" }]);
  const opts = (await user.get("/api/options")).data;
  const a = await admin.post(`/api/chemicals/${full}/assessments`, { risk_level: "significant_controlled", control_option_ids: [opts.ppe[0].id, opts.ventilation[0].id] });
  assert.equal(a.status, 201);
  await admin.post(`/api/chemicals/${noSds}/assessments`, { risk_level: "uncertain" });
  await link(p, full, 5, "L");
  await link(p, noAssess);
  const r = await user.get(`/api/pack?ids=${full},${noAssess},${noSds},${full},999999`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.generated_at);
  assert.deepEqual(r.data.chemicals.map(x => x.chemical.id), [full, noAssess, noSds]);
  const [f, n, s] = r.data.chemicals;
  assert.equal(f.sds.id, sds.data.id);
  assert.equal(f.sds.has_file, 1);
  assert.equal(f.sds.un_number, "1090");
  assert.equal(f.assessment.controls.length, 2);
  assert.equal(f.assessment.risk_level, "significant_controlled");
  assert.equal(f.chemical.classification[0].c, "flam_liq");
  assert.equal(f.chemical.search_text, undefined);
  assert.equal(f.places.length, 1);
  assert.equal(f.places[0].name, `PackPlace ${RUN}`);
  assert.equal(f.places[0].quantity, 5);
  assert.ok(n.sds && n.assessment === null);
  assert.equal(n.places.length, 1);
  assert.equal(s.sds, null);
  assert.ok(s.assessment);
  assert.deepEqual(s.places, []);
  // limits and bad input
  assert.equal((await user.get("/api/pack")).status, 400);
  assert.equal((await user.get("/api/pack?ids=abc")).status, 400);
  assert.equal((await user.get("/api/pack?ids=" + Array.from({ length: 101 }, (_, i) => i + 1).join(","))).status, 400);
  assert.equal((await user.get("/api/pack?ids=" + Array.from({ length: 100 }, (_, i) => i + 1).join(","))).status, 200);
});

T("import creates or finds a place by name and links with the quantity", async () => {
  const name = `Imp Place ${RUN}`;
  const rows = [
    { product_name: `PImp1 ${RUN}`, place: name, place_type: "vehicle", quantity: 4, unit: "L" },
    { product_name: `PImp2 ${RUN}`, place: name.toLowerCase(), place_type: "vehicle", quantity: 2, unit: "kg", spill_compound: "S" },
    { product_name: `PImp3 ${RUN}`, location: `Alias ${RUN}` },
  ];
  const r = await admin.post("/api/import", { rows });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, 3);
  assert.equal(r.data.places_created, 2);
  const places = (await user.get("/api/places")).data;
  const veh = places.filter(p => p.name.toLowerCase() === name.toLowerCase());
  assert.equal(veh.length, 1);
  assert.equal(veh[0].place_type, "vehicle");
  assert.equal(veh[0].counts_toward_totals, 0);
  assert.equal(veh[0].chemical_count, 2);
  const alias = places.find(p => p.name === `Alias ${RUN}`);
  assert.equal(alias.place_type, "workshop");
  assert.equal(alias.counts_toward_totals, 1);
  assert.equal(alias.chemical_count, 1);
  const again = await admin.post("/api/import", { rows: [{ product_name: `PImp9 ${RUN}`, place: name, place_type: "vehicle", quantity: 1, unit: "L" }] });
  assert.equal(again.data.places_created, 0);
  assert.equal((await user.get("/api/places")).data.find(p => p.id === veh[0].id).chemical_count, 3);
});
