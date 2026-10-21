import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeEnv } from "./fixtures/d1shim.mjs";
import { handleUpload } from "../src/upload.js";
import { handlePutAiSettings } from "../src/ai.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const solvent = fx("sds-solvent.txt"), plaster = fx("sds-plaster-multi.txt");
const user = { id: 1, name: "Una User", role: "user" };
const admin = { id: 2, name: "Ada Admin", role: "admin" };
let counter = 0;

function newEnv() {
  const env = makeEnv();
  env.DB.raw.exec("INSERT INTO users (id, name, email, password_hash, role) VALUES (1, 'Una User', 'una@example.com', 'x', 'user'), (2, 'Ada Admin', 'a@example.com', 'x', 'admin')");
  env.DB.raw.exec("INSERT INTO places (id, name, place_type) VALUES (1, 'Main workshop', 'workshop'), (2, 'Ute', 'vehicle')");
  return env;
}
// a placeholder like a found item creates: typed name, source audit, no SDS, linked to place 1
function placeholder(env, over = {}) {
  const r = env.DB.raw.prepare("INSERT INTO chemicals (product_name, source, sds_id) VALUES (?, ?, ?)").run(over.name ?? "weed killer", over.source ?? "audit", over.sds_id ?? null);
  const id = Number(r.lastInsertRowid);
  if (over.link !== false) {
    env.DB.raw.prepare("INSERT INTO chemical_places (chemical_id, place_id, quantity, unit, container_note) VALUES (?, 1, 5, 'L', '5 L drum')").run(id);
    env.DB.raw.exec("UPDATE places SET chemical_count = chemical_count + 1 WHERE id = 1");
  }
  return id;
}
function req({ text = solvent, answers = {}, forChem, place, replace } = {}) {
  const fd = new FormData();
  fd.append("file", new File([new TextEncoder().encode(`%PDF-1.4\n% attach test ${++counter}\n%%EOF\n`)], "sheet.pdf", { type: "application/pdf" }));
  fd.append("text", text);
  fd.append("answers", JSON.stringify(answers));
  if (forChem !== undefined) fd.append("for_chemical_id", String(forChem));
  if (place !== undefined) fd.append("place_id", String(place));
  if (replace) fd.append("replace_sds_id", String(replace));
  return new Request("http://x/api/uploads", { method: "POST", body: fd });
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
async function enableOpenAi(env) {
  env.OPENAI_API_KEY = "sk-upload-test-key-123456";
  await handlePutAiSettings(new Request("http://x", { method: "PUT", body: JSON.stringify({ provider: "openai" }) }), env);
}
async function go(env, who, opts, produce) {
  const orig = globalThis.fetch;
  if (produce) globalThis.fetch = async () => jsonRes({ choices: [{ message: { content: JSON.stringify(produce()) }, finish_reason: "stop" }] });
  try { const res = await handleUpload(req(opts), env, who); return { status: res.status, body: await res.json() }; } finally { globalThis.fetch = orig; }
}
const q = (env, sql, ...p) => env.DB.raw.prepare(sql).all(...p);
const q1 = (env, sql, ...p) => env.DB.raw.prepare(sql).get(...p);
const answers = { use_where_how: "x", exposure: "15_to_60_min", ventilation: "good" };

const solventAi = () => ({
  sds: { title: "KARRA CLEAN Solvent Wash", supplier: "Brightwell Coatings Pty Ltd", issue_date: "2023-03-14", un_number: "1993", dg_class: "3", packing_group: "II" },
  products: [{ product_name: "KARRA CLEAN Solvent Wash 5L", physical_form: "liquid", product_codes: "KC-5" }],
  classification: [{ class: "flam_liq", category: "2" }, { class: "eye_dmg", category: "2A" }, { class: "stot_se", category: "3" }],
  assessment: { risk_level: "significant_controlled", ppe: ["Safety glasses"] },
});
const plasterAi = () => ({
  sds: { title: "FinishCoat", supplier: "Karrawong Building Products", issue_date: "2021-08-09" },
  products: ["Light", "Standard", "Quick"].map(n => ({ product_name: `FinishCoat Plaster ${n}` })),
  classification: [{ class: "skin_corr", category: "2" }, { class: "eye_dmg", category: "1" }], assessment: {},
});

test("a user attaches an SDS to an audit placeholder: SDS, classification, assessment and decision as for a new chemical; name from the SDS; place link kept", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const id = placeholder(env);
  const { status, body } = await go(env, user, { answers, forChem: id }, solventAi);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.mode, "ai");
  assert.deepEqual(body.chemical_ids, [id], "no second chemical");
  assert.equal(body.attached_to, id);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM chemicals").n, 1);
  const c = q1(env, "SELECT * FROM chemicals WHERE id = ?", id);
  assert.equal(c.sds_id, body.sds_id);
  assert.equal(c.product_name, "KARRA CLEAN Solvent Wash 5L", "still the typed placeholder name: taken from the SDS");
  assert.equal(c.supplier, "Brightwell Coatings Pty Ltd");
  assert.equal(c.product_codes, "KC-5");
  assert.equal(c.source, "audit");
  assert.equal(c.decision, "hazardous");
  assert.equal(c.decision_by, "Prepared from the SDS (AI draft)");
  assert.equal(c.pictograms, "GHS02,GHS07");
  assert.equal(c.signal_word, "Danger");
  assert.equal(c.review_due, "2028-03-14");
  assert.equal(c.dg_class, "3");
  assert.equal(c.risk_level, "significant_controlled");
  assert.deepEqual(JSON.parse(c.ghs_classification).map(e => e.c).sort(), ["eye_dmg", "flam_liq", "stot_se"]);
  assert.match(c.search_text, /karra clean/);
  const a = q(env, "SELECT * FROM assessments WHERE chemical_id = ?", id);
  assert.equal(a.length, 1);
  assert.equal(a[0].source, "ai");
  assert.equal(a[0].is_current, 1);
  const link = q(env, "SELECT * FROM chemical_places WHERE chemical_id = ?", id);
  assert.equal(link.length, 1, "existing place link kept, none duplicated");
  assert.equal(link[0].quantity, 5);
  assert.ok(q1(env, "SELECT id FROM sds WHERE id = ? AND is_current = 1", body.sds_id));
});

test("a user is refused on a normal chemical, on one that already has an SDS, and on a missing one; nothing is stored", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const manual = placeholder(env, { source: "manual", name: "Register item" });
  const first = (await go(env, admin, { answers }, solventAi)).body; // creates a chemical with an SDS
  const withSds = first.chemical_ids[0];
  const auditWithSds = placeholder(env, { name: "audit thing" });
  env.DB.raw.prepare("UPDATE chemicals SET sds_id = ? WHERE id = ?").run(first.sds_id, auditWithSds);
  const before = { sds: q1(env, "SELECT COUNT(*) n FROM sds").n, files: env.FILES.store.size };
  for (const forChem of [manual, withSds, auditWithSds]) {
    const r = await go(env, user, { answers, forChem }, solventAi);
    assert.equal(r.status, 403, String(forChem));
    assert.ok(r.body.error && !/sqlite|constraint/i.test(r.body.error));
  }
  assert.equal((await go(env, user, { answers, forChem: 9999 })).status, 404);
  assert.equal((await go(env, user, { answers, forChem: "abc" })).status, 400);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM sds").n, before.sds);
  assert.equal(env.FILES.store.size, before.files);
  assert.equal(q1(env, "SELECT sds_id FROM chemicals WHERE id = ?", manual).sds_id, null);
});

test("an admin may attach to any chemical without an SDS (a normal one keeps its name); refused when it has an SDS; not combinable with replace", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const manual = placeholder(env, { source: "manual", name: "Admin typed name", link: false });
  const { status, body } = await go(env, admin, { answers, forChem: manual }, solventAi);
  assert.equal(status, 200, JSON.stringify(body));
  const c = q1(env, "SELECT * FROM chemicals WHERE id = ?", manual);
  assert.equal(c.product_name, "Admin typed name", "only a typed audit placeholder is renamed");
  assert.equal(c.sds_id, body.sds_id);
  assert.equal(c.decision, "hazardous");
  const again = await go(env, admin, { answers, forChem: manual }, solventAi);
  assert.equal(again.status, 403);
  const other = placeholder(env, { name: "x" });
  assert.equal((await go(env, admin, { answers, forChem: other, replace: body.sds_id }, solventAi)).status, 400);
});

test("multi-product sheet: the first product goes onto the placeholder, the others are created and the first new one is linked to the place", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const id = placeholder(env);
  const { body } = await go(env, user, { text: plaster, answers: { ...answers, quantity_amount: 30, quantity_unit: "kg" }, forChem: id, place: 1 }, plasterAi);
  assert.equal(body.mode, "ai", JSON.stringify(body));
  assert.equal(body.chemical_ids.length, 3);
  assert.ok(body.chemical_ids.includes(id));
  const names = q(env, "SELECT product_name FROM chemicals ORDER BY id").map(r => r.product_name);
  assert.deepEqual(names, ["FinishCoat Plaster Light", "FinishCoat Plaster Standard", "FinishCoat Plaster Quick"]);
  assert.equal(q1(env, "SELECT COUNT(DISTINCT sds_id) n FROM chemicals").n, 1);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM assessments WHERE source = 'ai'").n, 3);
  const links = q(env, "SELECT chemical_id, place_id, quantity FROM chemical_places ORDER BY id");
  assert.equal(links.length, 2);
  assert.deepEqual({ ...links[0] }, { chemical_id: id, place_id: 1, quantity: 5 }, "placeholder keeps its own link and quantity");
  assert.equal(links[1].place_id, 1);
  assert.notEqual(links[1].chemical_id, id);
  assert.equal(links[1].quantity, 30);
  assert.equal(q1(env, "SELECT chemical_count n FROM places WHERE id = 1").n, 2);
  assert.ok(body.warnings.some(w => /first product only/.test(w)));
});

test("draft-only attach (no AI): the PDF becomes the chemical's SDS, the typed name stays, a blank assessment is made, no decision", async () => {
  const env = newEnv();
  const id = placeholder(env, { name: "typed in the audit" });
  const { status, body } = await go(env, user, { answers: { use_where_how: "spraying weeds" }, forChem: id, place: 2 });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.mode, "draft_only");
  assert.ok(body.ai_error);
  assert.deepEqual(body.chemical_ids, [id]);
  const c = q1(env, "SELECT * FROM chemicals WHERE id = ?", id);
  assert.equal(c.sds_id, body.sds_id);
  assert.equal(c.product_name, "typed in the audit");
  assert.equal(c.decision, null);
  assert.equal(c.ghs_classification, null);
  const a = q(env, "SELECT * FROM assessments WHERE chemical_id = ?", id);
  assert.equal(a.length, 1);
  assert.equal(a[0].source, "blank");
  assert.equal(a[0].risk_level, "uncertain");
  assert.ok(q1(env, "SELECT r2_key FROM sds WHERE id = ?", body.sds_id).r2_key);
  assert.equal(env.FILES.store.size, 1);
  // the place link it had stays, and the chosen place is added because it was missing
  assert.deepEqual(q(env, "SELECT place_id FROM chemical_places WHERE chemical_id = ? ORDER BY place_id", id).map(r => r.place_id), [1, 2]);
  assert.equal(q1(env, "SELECT chemical_count n FROM places WHERE id = 2").n, 1);
});

test("an admin-edited classification or an override on the target is not overwritten", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const id = placeholder(env, { source: "manual", link: false });
  const adminList = JSON.stringify([{ c: "flam_liq", k: "1", src: "admin" }]);
  env.DB.raw.prepare("UPDATE chemicals SET ghs_classification = ?, pictograms = 'GHS02' WHERE id = ?").run(adminList, id);
  const { body } = await go(env, admin, { answers, forChem: id }, solventAi);
  assert.equal(body.mode, "ai");
  const c = q1(env, "SELECT * FROM chemicals WHERE id = ?", id);
  assert.equal(c.ghs_classification, adminList);
  assert.equal(c.sds_id, body.sds_id);
  assert.ok(body.warnings.some(w => /edited it/.test(w)));
  const id2 = placeholder(env, { source: "manual", link: false });
  env.DB.raw.prepare("UPDATE chemicals SET decision_override = 'not_hazardous', decision = 'not_hazardous' WHERE id = ?").run(id2);
  await go(env, admin, { answers, forChem: id2 }, solventAi);
  const c2 = q1(env, "SELECT * FROM chemicals WHERE id = ?", id2);
  assert.equal(c2.decision, "not_hazardous", "override respected");
  assert.equal(JSON.parse(c2.ghs_classification).length, 3, "classification still stored");
});
