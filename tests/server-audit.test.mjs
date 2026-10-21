// Chemical audit API tests. Same setup as server-places.test.mjs: a running local dev server (default http://127.0.0.1:8801,
// override with SDS_BASE), skipped with a message when nothing is listening. Creates its own admin/users defensively.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const BASE = process.env.SDS_BASE || "http://127.0.0.1:8801";
const RUN = Date.now().toString(36);
const ADMIN = { name: "Test Admin", email: "admin@test.example", password: "correct-horse-1" };
const USER_A = { name: "Audit User A", email: "audit-a@test.example", password: "battery-staple-2" };
const USER_B = { name: "Audit User B", email: "audit-b@test.example", password: "battery-staple-3" };
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
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req("GET", p); }
  post(p, b) { return this.req("POST", p, b ?? {}); }
  put(p, b) { return this.req("PUT", p, b ?? {}); }
}

const admin = new Client(), a = new Client(), b = new Client(), anon = new Client();
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function jpeg(n = 2000) {
  const u = new Uint8Array(n);
  u.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
  crypto.randomFillSync(u, 16);
  return u;
}
function photoForm(clientId, ownerType, ownerKey, bytes = jpeg(), type = "image/jpeg") {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type }), "p.jpg");
  fd.append("client_id", clientId);
  fd.append("owner_type", ownerType);
  if (ownerKey !== null && ownerKey !== undefined) fd.append("owner_key", String(ownerKey));
  fd.append("taken_at", now());
  fd.append("width", "800"); fd.append("height", "600");
  return fd;
}

async function signIn(client, who, makeAs) {
  for (let i = 0; i < 25; i++) {
    const ps = (await client.get("/api/public-settings")).data;
    if (ps.needs_setup && who === ADMIN) await client.post("/api/setup", { ...ADMIN, setup_key: setupKey() });
    if (who !== ADMIN && i === 1) await makeAs.post("/api/users", { ...who, role: "user" });
    const r = await client.post("/api/login", { email: who.email, password: who.password });
    if (r.status === 200) return;
    await new Promise(r2 => setTimeout(r2, 300));
  }
  throw new Error(`could not sign in ${who.email}`);
}

before(async () => {
  try { alive = (await fetch(BASE + "/api/public-settings")).ok; } catch { alive = false; }
  if (!alive) { console.log(`SKIPPED: no server at ${BASE}. See server-main.test.mjs for how to start one.`); return; }
  await signIn(admin, ADMIN);
  await signIn(a, USER_A, admin);
  await signIn(b, USER_B, admin);
  // Re-runs on the same database: close audits left in progress by earlier runs (5 in progress is the per-person limit).
  const left = (await admin.get("/api/audits?status=in_progress&limit=200")).data;
  for (const au of left) await admin.post(`/api/audits/${au.id}/finish`, { finished_at: new Date().toISOString() });
});
const T = (name, fn) => test(name, async (t) => { if (!alive) return t.skip(`no server at ${BASE}`); await fn(t); });

const mkPlace = async (name, type = "workshop") => { const r = await admin.post("/api/places", { name: `${name} ${RUN}`, place_type: type }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
const mkChem = async (name, extra = {}) => { const r = await admin.post("/api/chemicals", { product_name: `${name} ${RUN}`, ghs_classification: [], ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
const link = async (p, c, q, u, extra = {}) => { const r = await admin.post(`/api/places/${p}/chemicals`, { chemical_id: c, quantity: q, unit: u, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
const count = async (p) => (await a.get("/api/places?archived=all")).data.find(x => x.id === p).chemical_count;
const start = async (client, placeId, clientId = uuid()) => { const r = await client.post("/api/audits", { place_id: placeId, client_id: clientId, started_at: now() }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.data)); return r; };
const mark = (client, auditId, chemId, body) => client.put(`/api/audits/${auditId}/items/${chemId}`, { marked_at: now(), ...body });
const finish = (client, auditId) => client.post(`/api/audits/${auditId}/finish`, { finished_at: now() });
const findingsFor = async (auditId, status = "all") => (await admin.get(`/api/findings?status=${status}&limit=500`)).data.filter(f => f.audit_id === auditId);
const setAuditSettings = async (o) => assert.equal((await admin.put("/api/settings", o)).status, 200);

T("a user can run their own audit; others cannot see or touch it; a user cannot do admin things", async () => {
  const p = await mkPlace("AuditA");
  const c1 = await mkChem("A1"), c2 = await mkChem("A2");
  await link(p, c1, 10, "L", { container_note: "2 x 5 L" });
  await link(p, c2);
  const cid = uuid();
  const r = await start(a, p, cid);
  assert.equal(r.status, 201);
  const audit = r.data.audit;
  assert.equal(audit.status, "in_progress");
  assert.equal(audit.started_by_name, USER_A.name);
  assert.equal(r.data.items.length, 2);
  const it = r.data.items.find(i => i.chemical_id === c1);
  assert.equal(it.expected_quantity, 10);
  assert.equal(it.expected_unit, "L");
  assert.equal(it.expected_container_note, "2 x 5 L");
  assert.equal(it.has_sds, 0);
  assert.equal(it.review_status, "no_sds");
  // replays and the one-per-place rule
  const again = await start(a, p, cid);
  assert.equal(again.status, 200);
  assert.equal(again.data.audit.id, audit.id);
  const other = await start(a, p, uuid());
  assert.equal(other.data.audit.id, audit.id);
  assert.equal(other.data.existing, true);
  // device time sanity: a time far in the future is ignored
  const odd = await a.post("/api/audits", { place_id: await mkPlace("AuditTime"), client_id: uuid(), started_at: "2099-01-01T00:00:00Z" });
  assert.ok(Date.parse(odd.data.audit.started_at) < Date.now() + 86400000);
  // answers
  assert.equal((await mark(a, audit.id, c1, { result: "present" })).status, 200);
  assert.equal((await mark(a, audit.id, c1, { result: "bogus" })).status, 400);
  assert.equal((await mark(a, audit.id, c1, { result: "changed" })).status, 400);
  assert.equal((await mark(a, audit.id, c1, { result: "changed", new_quantity: 5 })).status, 400); // no unit
  assert.equal((await mark(a, audit.id, 999999, { result: "present" })).status, 404);
  // another user: 404 on everything of this audit
  assert.equal((await b.get(`/api/audits/${audit.id}`)).status, 404);
  assert.equal((await mark(b, audit.id, c1, { result: "present" })).status, 404);
  assert.equal((await finish(b, audit.id)).status, 404);
  assert.equal((await b.post(`/api/audits/${audit.id}/found`, { client_id: uuid(), product_name: "x", action: "record" })).status, 404);
  assert.equal((await b.post(`/api/audits/${audit.id}/disposals`, { client_id: uuid(), description: "x", reason: "unknown" })).status, 404);
  assert.equal((await b.req("POST", `/api/audits/${audit.id}/photos`, photoForm(uuid(), "audit", null))).status, 404);
  assert.equal((await b.post(`/api/audits/${audit.id}/found/match`, { product_name: "x" })).status, 404);
  assert.equal((await anon.get(`/api/audits/${audit.id}`)).status, 401);
  // lists: own only for a user, everything for an admin
  assert.ok((await a.get("/api/audits")).data.some(x => x.id === audit.id));
  assert.ok(!(await b.get("/api/audits")).data.some(x => x.id === audit.id));
  assert.ok((await admin.get("/api/audits")).data.some(x => x.id === audit.id));
  assert.ok((await admin.get(`/api/audits?place_id=${p}&status=in_progress`)).data.some(x => x.id === audit.id));
  assert.equal((await a.get("/api/audits?status=nope")).status, 400);
  // the full report
  const full = (await a.get(`/api/audits/${audit.id}`)).data;
  for (const k of ["audit", "items", "found", "disposals", "findings", "photos"]) assert.ok(k in full, k);
  assert.equal(full.items.find(i => i.chemical_id === c1).result, "present");
  // an admin may act on someone else's audit
  assert.equal((await mark(admin, audit.id, c2, { result: "present" })).status, 200);
  // what a user may not do
  for (const [m, path, body] of [
    ["GET", "/api/findings"], ["GET", "/api/disposals"], ["POST", "/api/findings/1/accept"], ["POST", "/api/findings/1/dismiss", {}],
    ["PUT", "/api/disposals/1/close", { close_note: "x" }], ["POST", "/api/places", { name: "x" }], ["PUT", `/api/places/${p}`, { name: "y" }],
    ["PUT", `/api/chemicals/${c1}`, { product_name: "y" }], ["POST", "/api/chemicals", { product_name: "y" }], ["PUT", "/api/chemical-places/1", { quantity: 1, unit: "L" }],
  ]) assert.equal((await a.req(m, path, body)).status, 403, `${m} ${path}`);
  assert.equal((await a.get("/api/review")).data.counts.findings_open, undefined);
  assert.equal(typeof (await admin.get("/api/review")).data.counts.findings_open, "number");
  assert.equal(typeof (await admin.get("/api/review")).data.counts.disposals_open, "number");
  // the label read route authorises the audit first
  assert.equal((await b.req("POST", `/api/audits/${audit.id}/found/read-label`, photoForm(uuid(), "audit", null))).status, 404);
  const lab = await a.req("POST", `/api/audits/${audit.id}/found/read-label`, (() => { const fd = new FormData(); fd.append("image", new Blob([jpeg()], { type: "image/jpeg" }), "l.jpg"); return fd; })());
  assert.ok(![401, 403, 404].includes(lab.status), `read-label ${lab.status}`);
});

T("findings: only after finish, the audit alone never changes the register, accept / dismiss, replay-safe finish", async () => {
  const p = await mkPlace("AuditF");
  const [present, gone, changed, unmarked] = [await mkChem("FPresent"), await mkChem("FGone"), await mkChem("FChanged"), await mkChem("FUnmarked")];
  await link(p, present, 1, "L"); await link(p, gone, 2, "L"); const lc = await link(p, changed, 3, "L"); await link(p, unmarked);
  const x = (await mkChem("FExtra"));
  const audit = (await start(a, p)).data.audit;
  await mark(a, audit.id, present, { result: "present" });
  await mark(a, audit.id, gone, { result: "not_found", note: "gone from the shelf" });
  await mark(a, audit.id, changed, { result: "changed", new_quantity: 7, new_unit: "kg", new_container_note: "1 x 7 kg bag" });
  // a user finds a register match: a suggestion only
  const fcid = uuid();
  const fu = await a.post(`/api/audits/${audit.id}/found`, { client_id: fcid, product_name: `FExtra ${RUN}`, source: "typed", found_at: now(), action: "link", matched_chemical_id: x });
  assert.equal(fu.status, 201, JSON.stringify(fu.data));
  assert.equal(fu.data.found.outcome, "link_suggested");
  const itemPhoto = await a.req("POST", `/api/audits/${audit.id}/photos`, photoForm(uuid(), "item", gone));
  const foundPhoto = await a.req("POST", `/api/audits/${audit.id}/photos`, photoForm(uuid(), "found", fcid));
  assert.equal(itemPhoto.status, 201); assert.equal(foundPhoto.status, 201);
  assert.equal(await count(p), 4);
  assert.equal((await findingsFor(audit.id)).length, 0);           // none before finish
  assert.equal(await count(p), 4);                                  // and the register is untouched
  const fin = await finish(a, audit.id);
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  assert.equal(fin.data.audit.status, "finished");
  assert.deepEqual(
    { l: fin.data.summary.listed, p: fin.data.summary.present, n: fin.data.summary.not_found, c: fin.data.summary.changed, m: fin.data.summary.not_marked, f: fin.data.summary.found },
    { l: 4, p: 1, n: 1, c: 1, m: 1, f: 1 });
  const fs1 = await findingsFor(audit.id);
  assert.deepEqual(fs1.map(f => f.kind).sort(), ["changed", "found_link", "not_found"]);
  assert.equal(await count(p), 4);                                  // still untouched
  // re-sending finish makes no second set and returns the same body
  const fin2 = await finish(a, audit.id);
  assert.equal(fin2.status, 200);
  assert.deepEqual(fin2.data.summary, fin.data.summary);
  assert.equal((await findingsFor(audit.id)).length, 3);
  // finished: new answers rejected, an exact replay accepted
  assert.equal((await mark(a, audit.id, present, { result: "not_found" })).status, 409);
  assert.equal((await mark(a, audit.id, gone, { result: "not_found", note: "gone from the shelf" })).status, 200);
  assert.equal((await a.post(`/api/audits/${audit.id}/found`, { client_id: uuid(), product_name: "late", action: "record" })).status, 409);
  assert.equal((await a.post(`/api/audits/${audit.id}/disposals`, { client_id: uuid(), description: "late", reason: "unknown" })).status, 409);
  assert.equal((await a.req("POST", `/api/audits/${audit.id}/photos`, photoForm(uuid(), "audit", null))).status, 409);
  // users cannot resolve findings
  const f = Object.fromEntries(fs1.map(x2 => [x2.kind, x2]));
  assert.deepEqual(f.not_found.photo_ids, [itemPhoto.data.photo.id]);
  assert.deepEqual(f.not_found.photos.map(x2 => x2.owner_type), ["item"]);
  assert.deepEqual(f.found_link.photo_ids, [foundPhoto.data.photo.id]);
  assert.deepEqual(f.changed.photo_ids, []);
  assert.equal((await a.post(`/api/findings/${f.not_found.id}/accept`)).status, 403);
  assert.equal((await a.post(`/api/findings/${f.not_found.id}/dismiss`, {})).status, 403);
  assert.equal((await a.get("/api/findings")).status, 403);
  // accept not_found: unlinks and fixes the count
  const acc = await admin.post(`/api/findings/${f.not_found.id}/accept`);
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal(acc.data.result, "applied");
  assert.equal(await count(p), 3);
  assert.ok(!(await a.get(`/api/chemicals/${gone}`)).data.places.some(pl => pl.place_id === p));
  const again = await admin.post(`/api/findings/${f.not_found.id}/accept`);
  assert.equal(again.data.result, "already_resolved");
  assert.equal(await count(p), 3);
  // accept changed: quantity, unit and container follow the audit
  assert.equal((await admin.post(`/api/findings/${f.changed.id}/accept`)).data.result, "applied");
  const cp = (await a.get(`/api/chemicals/${changed}`)).data.places.find(pl => pl.link_id === lc);
  assert.equal(cp.quantity, 7); assert.equal(cp.unit, "kg"); assert.equal(cp.container_note, "1 x 7 kg bag");
  // dismiss found_link: nothing changes
  const dis = await admin.post(`/api/findings/${f.found_link.id}/dismiss`, { note: "not ours" });
  assert.equal(dis.status, 200);
  assert.equal(dis.data.finding.status, "dismissed");
  assert.equal(dis.data.finding.resolve_note, "not ours");
  assert.equal(dis.data.finding.resolved_by_name, ADMIN.name);
  assert.equal(await count(p), 3);
  assert.ok(!(await a.get(`/api/chemicals/${x}`)).data.places.some(pl => pl.place_id === p));
  assert.ok((await admin.get("/api/findings?status=dismissed")).data.some(z => z.id === f.found_link.id));
  assert.ok(!(await admin.get("/api/findings?status=open")).data.some(z => z.audit_id === audit.id));
  assert.equal((await admin.get("/api/findings?status=nope")).status, 400);
  // accepting a not_found whose link already went just closes it
  const p2 = await mkPlace("AuditF2");
  const g2 = await mkChem("FGone2"); const l2 = await link(p2, g2, 1, "L");
  const au2 = (await start(a, p2)).data.audit;
  await mark(a, au2.id, g2, { result: "not_found" });
  await finish(a, au2.id);
  await admin.req("DELETE", `/api/chemical-places/${l2}`);
  const f2 = (await findingsFor(au2.id))[0];
  const acc2 = await admin.post(`/api/findings/${f2.id}/accept`);
  assert.equal(acc2.data.result, "already_done");
  assert.equal(acc2.data.finding.status, "accepted");
  // found_link accept on an archived place is refused; on an active place it links
  const p3 = await mkPlace("AuditF3"); const y = await mkChem("FY"); await link(p3, await mkChem("FZ"), 1, "L");
  const au3 = (await start(a, p3)).data.audit;
  await a.post(`/api/audits/${au3.id}/found`, { client_id: uuid(), product_name: `FY ${RUN}`, action: "link", matched_chemical_id: y, found_at: now() });
  await finish(a, au3.id);
  const fl = (await findingsFor(au3.id))[0];
  await admin.put(`/api/places/${p3}`, { archived: true });
  assert.equal((await admin.post(`/api/findings/${fl.id}/accept`)).status, 400);
  await admin.put(`/api/places/${p3}`, { archived: false });
  assert.equal((await admin.post(`/api/findings/${fl.id}/accept`)).data.result, "applied");
  assert.equal(await count(p3), 2);
});

T("found items: admin links at once, user match is a suggestion, create makes a needs-an-SDS chemical, replays are safe", async () => {
  const p = await mkPlace("AuditFound");
  await link(p, await mkChem("FoundBase"), 1, "L");
  const target = await mkChem(`Target`, { supplier: "Acme" });
  const audit = (await start(admin, p)).data.audit;
  const m = await admin.post(`/api/audits/${audit.id}/found/match`, { product_name: `Target ${RUN}`, supplier: "Acme" });
  assert.equal(m.status, 200);
  const cand = m.data.candidates.find(x => x.chemical_id === target);
  assert.ok(cand && cand.exact === true && cand.linked_here === false);
  // admin link: immediately
  const cid = uuid();
  const l1 = await admin.post(`/api/audits/${audit.id}/found`, { client_id: cid, product_name: `Target ${RUN}`, source: "ai", found_at: now(), action: "link", matched_chemical_id: target });
  assert.equal(l1.status, 201, JSON.stringify(l1.data));
  assert.equal(l1.data.found.outcome, "linked");
  assert.equal(await count(p), 2);
  const rep = await admin.post(`/api/audits/${audit.id}/found`, { client_id: cid, product_name: `Target ${RUN}`, action: "link", matched_chemical_id: target });
  assert.equal(rep.status, 200);
  assert.equal(rep.data.found.id, l1.data.found.id);
  assert.equal(await count(p), 2);
  assert.equal((await admin.post(`/api/audits/${audit.id}/found`, { client_id: uuid(), product_name: "x", action: "link", matched_chemical_id: target })).status, 400); // already here
  assert.equal((await admin.post(`/api/audits/${audit.id}/found`, { client_id: uuid(), product_name: "x", action: "link" })).status, 400);
  assert.equal((await admin.post(`/api/audits/${audit.id}/found`, { client_id: uuid(), product_name: "", action: "record" })).status, 400);
  assert.equal((await admin.post(`/api/audits/${audit.id}/found`, { client_id: "x", product_name: "a", action: "record" })).status, 400);
  assert.equal((await admin.post(`/api/audits/${audit.id}/found/match`, { product_name: `Target ${RUN}` })).data.candidates.find(x => x.chemical_id === target).linked_here, true);
  // record
  const rc = await admin.post(`/api/audits/${audit.id}/found`, { client_id: uuid(), product_name: "Mystery tin", action: "record", found_at: now() });
  assert.equal(rc.data.found.outcome, "recorded");
  // create (by a user, on their own audit): the chemical needs an SDS, is linked here, and the response points at the upload flow
  const ua = (await start(a, p)).data.audit;
  const ccid = uuid();
  const cr = await a.post(`/api/audits/${ua.id}/found`, { client_id: ccid, product_name: `Brand New ${RUN}`, supplier: "NewCo", source: "typed", found_at: now(), action: "create" });
  assert.equal(cr.status, 201, JSON.stringify(cr.data));
  assert.equal(cr.data.found.outcome, "created");
  assert.equal(cr.data.next.upload_for_chemical, cr.data.chemical_id);
  assert.equal(cr.data.next.place_id, p);
  const chem = (await a.get(`/api/chemicals/${cr.data.chemical_id}`)).data;
  assert.equal(chem.chemical.source, "audit");
  assert.equal(chem.sds, null);
  assert.equal(chem.chemical.decision, null);
  assert.equal(chem.chemical.review_status, "no_sds");
  assert.ok(chem.places.some(pl => pl.place_id === p));
  assert.equal(await count(p), 3);
  const cr2 = await a.post(`/api/audits/${ua.id}/found`, { client_id: ccid, product_name: `Brand New ${RUN}`, action: "create" });
  assert.equal(cr2.status, 200);
  assert.equal(cr2.data.chemical_id, cr.data.chemical_id);
  assert.equal(cr2.data.next.upload_for_chemical, cr.data.chemical_id);
  assert.equal((await a.get(`/api/chemicals?q=${encodeURIComponent("brand new " + RUN)}`)).data.items.length, 1);
  assert.equal(await count(p), 3);
  assert.ok((await a.get("/api/review")).data.no_sds.some(r => r.id === cr.data.chemical_id) || (await a.get("/api/review")).data.counts.no_sds > 200);
  // a user cannot create on someone else's audit
  assert.equal((await b.post(`/api/audits/${ua.id}/found`, { client_id: uuid(), product_name: "z", action: "create" })).status, 404);
  // archived place: no link, no create
  const pa = await mkPlace("AuditArch"); await link(pa, await mkChem("ArchBase"), 1, "L");
  const aa = (await start(admin, pa)).data.audit;
  await admin.put(`/api/places/${pa}`, { archived: true });
  assert.equal((await admin.post(`/api/audits/${aa.id}/found`, { client_id: uuid(), product_name: "q", action: "create" })).status, 400);
  assert.equal((await admin.post(`/api/audits/${aa.id}/found`, { client_id: uuid(), product_name: "q", action: "link", matched_chemical_id: target })).status, 400);
});

T("disposals: flag, replay, only an admin closes, closing photo after finish, list filters", async () => {
  const p = await mkPlace("AuditD");
  const c = await mkChem("DispChem"); await link(p, c, 1, "L");
  const audit = (await start(a, p)).data.audit;
  const did = uuid();
  const d1 = await a.post(`/api/audits/${audit.id}/disposals`, { client_id: did, description: "Old drum of solvent", reason: "expired", chemical_id: c, flagged_at: now(), note: "rusty" });
  assert.equal(d1.status, 201, JSON.stringify(d1.data));
  assert.equal(d1.data.disposal.status, "to_dispose");
  assert.equal(d1.data.disposal.flagged_by_name, USER_A.name);
  const d1b = await a.post(`/api/audits/${audit.id}/disposals`, { client_id: did, description: "Old drum of solvent", reason: "expired" });
  assert.equal(d1b.status, 200);
  assert.equal(d1b.data.disposal.id, d1.data.disposal.id);
  assert.equal((await a.post(`/api/audits/${audit.id}/disposals`, { client_id: uuid(), description: "x", reason: "because" })).status, 400);
  assert.equal((await a.post(`/api/audits/${audit.id}/disposals`, { client_id: uuid(), description: "", reason: "damaged" })).status, 400);
  assert.equal(await count(p), 1); // the register is untouched
  // a flag photo, then finish
  const ph = await a.req("POST", `/api/audits/${audit.id}/photos`, photoForm(uuid(), "disposal", did));
  assert.equal(ph.status, 201, JSON.stringify(ph.data));
  assert.equal((await finish(a, audit.id)).status, 200);
  const open = (await admin.get("/api/disposals")).data;
  const row = open.find(x => x.id === d1.data.disposal.id);
  assert.ok(row);
  assert.deepEqual(row.photo_ids, [ph.data.photo.id]);
  assert.deepEqual(row.photos.map(x => x.owner_type), ["disposal"]);
  assert.ok(row.photos[0].taken_at);
  assert.equal(row.place_name, `AuditD ${RUN}`);
  assert.equal((await a.get("/api/disposals")).status, 403);
  assert.equal((await a.put(`/api/disposals/${row.id}/close`, { close_note: "done", closed_at: now() })).status, 403);
  assert.equal((await admin.put(`/api/disposals/${row.id}/close`, { closed_at: now() })).status, 400); // a note is needed
  const closed = await admin.put(`/api/disposals/${row.id}/close`, { close_note: "Taken to the depot", closed_at: now() });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.disposal.status, "disposed");
  assert.equal(closed.data.disposal.closed_by_name, ADMIN.name);
  assert.equal(closed.data.disposal.close_note, "Taken to the depot");
  assert.ok(closed.data.disposal.closed_at);
  // closing photo: admin only, allowed after the audit is finished
  const cl = await admin.req("POST", `/api/audits/${audit.id}/photos`, photoForm(uuid(), "disposal_close", did));
  assert.equal(cl.status, 201, JSON.stringify(cl.data));
  assert.equal((await a.req("POST", `/api/audits/${audit.id}/photos`, photoForm(uuid(), "disposal_close", did))).status, 403);
  // filters
  assert.ok(!(await admin.get("/api/disposals?status=to_dispose")).data.some(x => x.id === row.id));
  const dis = (await admin.get("/api/disposals?status=disposed")).data.find(x => x.id === row.id);
  assert.ok(dis);
  assert.deepEqual(dis.close_photo_ids, [cl.data.photo.id]);
  assert.deepEqual(dis.photo_ids, [ph.data.photo.id, cl.data.photo.id]);
  assert.deepEqual(dis.photos.map(x => x.owner_type), ["disposal", "disposal_close"]);
  assert.ok((await admin.get("/api/disposals?status=all")).data.some(x => x.id === row.id));
  assert.equal((await admin.get("/api/disposals?status=nope")).status, 400);
  // closing twice is a no-op
  assert.equal((await admin.put(`/api/disposals/${row.id}/close`, { close_note: "again", closed_at: now() })).data.disposal.close_note, "Taken to the depot");
  // a finished audit still accepts a replay of the same flag
  assert.equal((await a.post(`/api/audits/${audit.id}/disposals`, { client_id: did, description: "Old drum of solvent", reason: "expired" })).status, 200);
});

T("photos: type, size, counts, totals, per-owner limit, replay, access", async () => {
  const p = await mkPlace("AuditP");
  const chems = [];
  for (let i = 0; i < 6; i++) { const c = await mkChem(`Ph${i}`); await link(p, c, 1, "L"); chems.push(c); }
  try {
    await setAuditSettings({ audit_photo_max_mb: 0.2, audit_max_photos: 4, audit_max_total_mb: 5 });
    const audit = (await start(a, p)).data.audit;
    const up = (client, owner, key, bytes, type, cid = uuid()) => client.req("POST", `/api/audits/${audit.id}/photos`, photoForm(cid, owner, key, bytes, type));
    // wrong type / not a JPEG / too big
    assert.equal((await up(a, "item", chems[0], new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]), "image/png")).status, 400);
    assert.equal((await up(a, "item", chems[0], new TextEncoder().encode("not an image at all"), "image/jpeg")).status, 400);
    assert.equal((await up(a, "item", chems[0], jpeg(300000))).status, 413);
    assert.equal((await up(a, "item", 999999, jpeg())).status, 400);   // owner not in this audit
    assert.equal((await up(a, "found", uuid(), jpeg())).status, 400);
    assert.equal((await up(a, "bogus", chems[0], jpeg())).status, 400);
    assert.equal((await up(a, "item", null, jpeg())).status, 400);
    assert.equal((await a.get(`/api/audits/${audit.id}`)).data.photos.length, 0);
    // a good one, its replay (same client_id), and access to it
    const cid = uuid();
    const good = await up(a, "item", chems[0], jpeg(5000), "image/jpeg", cid);
    assert.equal(good.status, 201, JSON.stringify(good.data));
    const pid = good.data.photo.id;
    assert.equal(good.data.photo.bytes, 5000);
    const replay = await up(a, "item", chems[0], jpeg(5000), "image/jpeg", cid);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.photo.id, pid);
    assert.equal((await a.get(`/api/audits/${audit.id}`)).data.photos.length, 1);   // not counted twice
    const got = await a.get(`/api/audit-photos/${pid}`);
    assert.equal(got.status, 200);                                                   // the object really is in R2
    assert.equal(got.data.length, 5000);
    assert.equal(got.headers.get("content-type"), "image/jpeg");
    assert.equal(got.headers.get("cache-control"), "private, no-store");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await admin.get(`/api/audit-photos/${pid}`)).status, 200);
    assert.equal((await b.get(`/api/audit-photos/${pid}`)).status, 404);
    assert.equal((await anon.get(`/api/audit-photos/${pid}`)).status, 401);
    assert.equal((await a.get(`/api/audit-photos/999999`)).status, 404);
    // at most 3 per owner
    assert.equal((await up(a, "item", chems[0], jpeg())).status, 201);
    assert.equal((await up(a, "item", chems[0], jpeg())).status, 201);
    assert.equal((await up(a, "item", chems[0], jpeg())).status, 400);
    // the per-audit count (4): three used, one more, then refused
    assert.equal((await up(a, "item", chems[1], jpeg())).status, 201);
    const over = await up(a, "item", chems[2], jpeg());
    assert.equal(over.status, 400);
    assert.match(over.data.error, /maximum/i);
    assert.equal((await a.get(`/api/audits/${audit.id}`)).data.photos.length, 4);
    // the per-audit total
    await setAuditSettings({ audit_photo_max_mb: 2, audit_max_photos: 50, audit_max_total_mb: 5 });
    const audit2 = (await start(a, await (async () => { const p2 = await mkPlace("AuditP2"); for (const c of chems.slice(0, 3)) await link(p2, c, 1, "L"); return p2; })())).data.audit;
    const big = (key) => a.req("POST", `/api/audits/${audit2.id}/photos`, photoForm(uuid(), "item", key, jpeg(1950000)));
    assert.equal((await big(chems[0])).status, 201);
    assert.equal((await big(chems[1])).status, 201);
    const tot = await big(chems[2]);
    assert.equal(tot.status, 413);
    assert.match(tot.data.error, /storage limit/i);
    assert.equal((await a.get(`/api/audits/${audit2.id}`)).data.photos.length, 2);
    // storage per audit is reported in the summary
    const f2 = await finish(a, audit2.id);
    assert.equal(f2.data.summary.photos, 2);
    assert.equal(f2.data.summary.photo_bytes, 3900000);
  } finally {
    await setAuditSettings({ audit_photo_max_mb: 2, audit_max_photos: 50, audit_max_total_mb: 40 });
  }
});

T("reminders: not_audited honours the setting, recent audits and empty places are absent", async () => {
  const stale = await mkPlace("RemStale"); await link(stale, await mkChem("RS"), 1, "L");
  const fresh = await mkPlace("RemFresh"); const fc = await mkChem("RF"); await link(fresh, fc, 1, "L");
  const empty = await mkPlace("RemEmpty");
  const old = await mkPlace("RemOld"); const oc = await mkChem("RO"); await link(old, oc, 1, "L");
  try {
    let r = (await a.get("/api/review")).data;
    assert.ok(Array.isArray(r.not_audited));
    assert.equal(typeof r.counts.not_audited, "number");
    assert.ok(r.not_audited.some(x => x.place_id === stale && x.last_audited_at === null && x.days === null));
    assert.ok(!r.not_audited.some(x => x.place_id === empty));
    // audited just now: absent
    const au = (await start(a, fresh)).data.audit;
    await mark(a, au.id, fc, { result: "present" });
    await finish(a, au.id);
    // audited 20 days ago (device time): absent with 90 days, present with 7
    const ao = (await start(admin, old)).data.audit;
    await mark(admin, ao.id, oc, { result: "present" });
    assert.equal((await admin.post(`/api/audits/${ao.id}/finish`, { finished_at: daysAgo(20) })).status, 200);
    await setAuditSettings({ audit_reminder_days: 90 });
    r = (await admin.get("/api/review")).data;
    assert.ok(!r.not_audited.some(x => x.place_id === fresh));
    assert.ok(!r.not_audited.some(x => x.place_id === old));
    assert.ok(r.not_audited.some(x => x.place_id === stale));
    await setAuditSettings({ audit_reminder_days: 7 });
    r = (await admin.get("/api/review")).data;
    const o = r.not_audited.find(x => x.place_id === old);
    assert.ok(o, "a place audited 20 days ago is due with a 7 day reminder");
    assert.equal(o.days, 20);
    assert.ok(!r.not_audited.some(x => x.place_id === fresh));
    // the place page shows the history, limited to what the viewer can open
    const pa = (await a.get(`/api/places/${fresh}`)).data;
    assert.ok(pa.last_audited_at);
    assert.equal(pa.audits.length, 1);
    assert.equal(pa.audits[0].id, au.id);
    assert.equal(pa.audits[0].status, "finished");
    assert.equal(pa.audits[0].summary.present, 1);
    const pb = (await b.get(`/api/places/${fresh}`)).data;
    assert.ok(pb.last_audited_at);               // the date is visible to every signed-in user
    assert.equal(pb.audits.length, 0);           // the history is not
    assert.equal((await admin.get(`/api/places/${fresh}`)).data.audits.length, 1);
    assert.equal((await a.get(`/api/places/${stale}`)).data.last_audited_at, null);
  } finally {
    await setAuditSettings({ audit_reminder_days: 90 });
  }
});

T("settings: five audit settings, validated; a user cannot change them", async () => {
  const g = (await a.get("/api/settings")).data;
  for (const k of ["audit_reminder_days", "audit_photo_max_mb", "audit_max_photos", "audit_max_total_mb", "label_read_rate_per_hour"]) assert.equal(typeof g[k], "number", k);
  for (const bad of [{ audit_reminder_days: 0 }, { audit_reminder_days: 731 }, { audit_reminder_days: 1.5 }, { audit_photo_max_mb: 0.1 }, { audit_photo_max_mb: 9 },
    { audit_max_photos: 0 }, { audit_max_photos: 201 }, { audit_max_total_mb: 4 }, { audit_max_total_mb: 201 }, { label_read_rate_per_hour: 0 }, { label_read_rate_per_hour: 201 }, { audit_max_photos: "abc" }]) {
    assert.equal((await admin.put("/api/settings", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin.put("/api/settings", { audit_reminder_days: 30, audit_photo_max_mb: 1.5, audit_max_photos: 20, audit_max_total_mb: 10, label_read_rate_per_hour: 12 })).status, 200);
  const s = (await a.get("/api/settings")).data;
  assert.deepEqual([s.audit_reminder_days, s.audit_photo_max_mb, s.audit_max_photos, s.audit_max_total_mb, s.label_read_rate_per_hour], [30, 1.5, 20, 10, 12]);
  assert.equal((await a.put("/api/settings", { audit_reminder_days: 5 })).status, 403);
  assert.equal((await admin.put("/api/settings", { audit_reminder_days: 90, audit_photo_max_mb: 2, audit_max_photos: 50, audit_max_total_mb: 40, label_read_rate_per_hour: 30 })).status, 200);
});

T("export bundle carries the audit data; a user gets only their own audits", async () => {
  const p = await mkPlace("AuditX"); const c = await mkChem("XChem"); await link(p, c, 1, "L");
  const au = (await start(a, p)).data.audit;
  await mark(a, au.id, c, { result: "not_found" });
  await finish(a, au.id);
  const pb = await mkPlace("AuditXB"); const cb = await mkChem("XChemB"); await link(pb, cb, 1, "L");
  const bu = (await start(b, pb)).data.audit;
  const ea = (await a.get("/api/export/all")).data;
  for (const k of ["audits", "audit_items", "audit_found", "audit_disposals", "audit_findings", "audit_photos"]) assert.ok(Array.isArray(ea[k]), k);
  assert.ok(ea.audits.some(x => x.id === au.id));
  assert.ok(!ea.audits.some(x => x.id === bu.id));
  assert.ok(ea.audit_items.every(i => ea.audits.some(x => x.id === i.audit_id)));
  assert.ok(ea.audit_findings.some(f => f.audit_id === au.id));
  assert.ok(ea.audit_photos.every(ph => !("r2_key" in ph)));
  const ad = (await admin.get("/api/export/all")).data;
  assert.ok(ad.audits.some(x => x.id === au.id) && ad.audits.some(x => x.id === bu.id));
});

T("audit validation and limits", async () => {
  assert.equal((await a.post("/api/audits", { place_id: 999999, client_id: uuid() })).status, 400);
  assert.equal((await a.post("/api/audits", { client_id: uuid() })).status, 400);
  assert.equal((await a.post("/api/audits", { place_id: 1 })).status, 400);
  const arch = await mkPlace("AuditNoStart"); await admin.put(`/api/places/${arch}`, { archived: true });
  assert.equal((await a.post("/api/audits", { place_id: arch, client_id: uuid() })).status, 400);
  assert.equal((await anon.post("/api/audits", { place_id: 1, client_id: uuid() })).status, 401);
  // at most 5 audits in progress per person
  const u = new Client();
  const who = { name: "Limit User", email: `limit-${RUN}@test.example`, password: "limit-pass-9" };
  assert.equal((await admin.post("/api/users", { ...who, role: "user" })).status, 201);
  assert.equal((await u.post("/api/login", { email: who.email, password: who.password })).status, 200);
  for (let i = 0; i < 5; i++) { const pl = await mkPlace(`Lim${i}`); assert.equal((await u.post("/api/audits", { place_id: pl, client_id: uuid(), started_at: now() })).status, 201); }
  const sixth = await mkPlace("Lim6");
  assert.equal((await u.post("/api/audits", { place_id: sixth, client_id: uuid(), started_at: now() })).status, 400);
});

T("AI vision test and label read routes exist and are protected", async () => {
  const r = await admin.post("/api/settings/ai/test-vision");
  assert.notEqual(r.status, 404, "test-vision is routed");
  assert.equal((await a.post("/api/settings/ai/test-vision")).status, 403);
  assert.equal((await anon.post("/api/settings/ai/test-vision")).status, 401);
});

T("unchecked found items (sent offline) become found_unchecked findings; accept changes nothing", async () => {
  const p = await mkPlace("AuditU");
  const c = await mkChem("UBase"); await link(p, c, 1, "L");
  const au = (await start(a, p)).data.audit;
  const fid = uuid();
  const body = { client_id: fid, product_name: "Offline tin", supplier: "Acme", action: "record", unchecked: true, found_at: now(), note: "behind the door" };
  const f1 = await a.post(`/api/audits/${au.id}/found`, body);
  assert.equal(f1.status, 201, JSON.stringify(f1.data));
  assert.equal(f1.data.found.outcome, "recorded");
  assert.equal(f1.data.found.unchecked, true);
  assert.equal((await a.post(`/api/audits/${au.id}/found`, { ...body, client_id: uuid(), action: "create" })).status, 400); // only with record
  const ph = await a.req("POST", `/api/audits/${au.id}/photos`, photoForm(uuid(), "found", fid));
  assert.equal(ph.status, 201);
  assert.equal((await findingsFor(au.id)).length, 0);                       // none before finish
  const fin = await finish(a, au.id);
  assert.equal(fin.status, 200);
  assert.equal((await finish(a, au.id)).status, 200);                       // replayed finish
  assert.equal((await a.post(`/api/audits/${au.id}/found`, body)).status, 200); // replayed found request
  const fs1 = await findingsFor(au.id);
  assert.equal(fs1.length, 1);
  const f = fs1[0];
  assert.equal(f.kind, "found_unchecked");
  assert.equal(f.details.name, "Offline tin");
  assert.equal(f.details.supplier, "Acme");
  assert.equal(f.details.note, "behind the door");
  assert.deepEqual(f.details.photo_ids, [ph.data.photo.id]);
  assert.deepEqual(f.photo_ids, [ph.data.photo.id]);
  assert.ok((await admin.get("/api/review")).data.counts.findings_open >= 1);
  // a user cannot accept; an admin accepting changes nothing on the register
  assert.equal((await a.post(`/api/findings/${f.id}/accept`)).status, 403);
  const before = await count(p);
  const acc = await admin.post(`/api/findings/${f.id}/accept`);
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal(acc.data.result, "noted");
  assert.equal(acc.data.message, "Noted. Nothing on the register was changed. Add or link the chemical from the register if needed.");
  assert.equal(acc.data.finding.status, "accepted");
  assert.equal(await count(p), before);
  assert.equal((await a.get(`/api/chemicals?q=${encodeURIComponent("offline tin")}`)).data.items.length, 0);
  // arriving after the audit was finished: the finding is made at once, once
  const late = { client_id: uuid(), product_name: "Late tin", action: "record", unchecked: true, found_at: now() };
  const l1 = await a.post(`/api/audits/${au.id}/found`, late);
  assert.equal(l1.status, 201, JSON.stringify(l1.data));
  assert.equal((await a.post(`/api/audits/${au.id}/found`, late)).status, 200);
  assert.equal((await a.post(`/api/audits/${au.id}/found`, { client_id: uuid(), product_name: "Not allowed", action: "record" })).status, 409);
  const fs2 = (await findingsFor(au.id)).filter(x => x.kind === "found_unchecked");
  assert.equal(fs2.length, 2);
  assert.equal(fs2.filter(x => x.status === "open").length, 1);
  const dis = await admin.post(`/api/findings/${fs2.find(x => x.status === "open").id}/dismiss`, {});
  assert.equal(dis.data.finding.status, "dismissed");
  assert.equal(await count(p), before);
});
