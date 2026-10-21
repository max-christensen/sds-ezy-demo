import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeEnv } from "./fixtures/d1shim.mjs";
import { handleUpload } from "../src/upload.js";
import { handlePutAiSettings } from "../src/ai.js";

const solvent = readFileSync(new URL("./fixtures/sds-solvent.txt", import.meta.url), "utf8");
const plaster = readFileSync(new URL("./fixtures/sds-plaster-multi.txt", import.meta.url), "utf8");
const user = { id: 1, name: "Una User", role: "user" };
let counter = 0;

function newEnv() {
  const env = makeEnv();
  env.DB.raw.exec("INSERT INTO users (id, name, email, password_hash, role) VALUES (1, 'Una User', 'una@example.com', 'x', 'user')");
  env.DB.raw.exec("INSERT INTO places (id, name, place_type) VALUES (1, 'Main workshop', 'workshop'), (3, 'Ute', 'vehicle')");
  env.DB.raw.exec("INSERT INTO places (id, name, place_type, archived) VALUES (2, 'Old yard', 'workshop', 1)");
  return env;
}
function req({ text = solvent, answers = {}, replace, place } = {}) {
  const fd = new FormData();
  fd.append("file", new File([new TextEncoder().encode(`%PDF-1.4\n% places test ${++counter}\n%%EOF\n`)], "sheet.pdf", { type: "application/pdf" }));
  fd.append("text", text);
  fd.append("answers", JSON.stringify(answers));
  if (replace) fd.append("replace_sds_id", String(replace));
  if (place !== undefined) fd.append("place_id", String(place));
  return new Request("http://x/api/uploads", { method: "POST", body: fd });
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
async function enableOpenAi(env) {
  env.OPENAI_API_KEY = "sk-upload-test-key-123456";
  await handlePutAiSettings(new Request("http://x", { method: "PUT", body: JSON.stringify({ provider: "openai" }) }), env);
}
async function go(env, opts, produce) {
  const orig = globalThis.fetch;
  if (produce) globalThis.fetch = async () => jsonRes({ choices: [{ message: { content: JSON.stringify(produce()) }, finish_reason: "stop" }] });
  try { const res = await handleUpload(req(opts), env, user); return { status: res.status, body: await res.json() }; } finally { globalThis.fetch = orig; }
}
const q = (env, sql, ...p) => env.DB.raw.prepare(sql).all(...p);
const q1 = (env, sql, ...p) => env.DB.raw.prepare(sql).get(...p);
const answers = { use_where_how: "x", exposure: "15_to_60_min", ventilation: "good" };

const solventAi = () => ({
  sds: { title: "KARRA CLEAN Solvent Wash", supplier: "Brightwell Coatings Pty Ltd", issue_date: "2023-03-14" },
  products: [{ product_name: "KARRA CLEAN Solvent Wash 5L" }],
  classification: [{ class: "flam_liq", category: "2" }, { class: "eye_dmg", category: "2A" }, { class: "stot_se", category: "3" }],
  assessment: { risk_level: "significant_controlled" },
});
const plasterAi = () => ({
  sds: { title: "FinishCoat", supplier: "Karrawong Building Products" },
  products: ["Light", "Standard", "Quick", "Base"].map(n => ({ product_name: `FinishCoat Plaster ${n}` })),
  classification: [{ class: "skin_corr", category: "2" }, { class: "eye_dmg", category: "1" }], assessment: {},
});

test("place link is created with the quantity and unit, and the place count is kept right", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const { status, body } = await go(env, { answers: { ...answers, quantity_amount: 20, quantity_unit: "kg", quantity_note: "4 x 5 kg" }, place: 3 }, solventAi);
  assert.equal(status, 200, JSON.stringify(body));
  const links = q(env, "SELECT * FROM chemical_places");
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].chemical_id, links[0].place_id, links[0].quantity, links[0].unit, links[0].container_note], [body.chemical_ids[0], 3, 20, "kg", "4 x 5 kg"]);
  assert.equal(q1(env, "SELECT chemical_count n FROM places WHERE id = 3").n, 1);
  assert.equal(q1(env, "SELECT chemical_count n FROM places WHERE id = 1").n, 0);
  assert.ok(!body.warnings.some(w => /No place was chosen/.test(w)));
});

test("a link without a quantity is fine: quantity and unit are both null", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const { body } = await go(env, { answers, place: 1 }, solventAi);
  const l = q1(env, "SELECT * FROM chemical_places");
  assert.equal(l.place_id, 1);
  assert.equal(l.quantity, null);
  assert.equal(l.unit, null);
  assert.equal(body.warnings.filter(w => /quantity/.test(w)).length, 0);
});

test("archived, missing or malformed place is rejected with 400 before anything is stored", async () => {
  const env = newEnv(); await enableOpenAi(env);
  for (const place of [2, 99, "abc", 0, -1]) {
    const { status, body } = await go(env, { answers, place }, solventAi);
    assert.equal(status, 400, String(place));
    assert.ok(body.error && !/sqlite|constraint/i.test(body.error));
  }
  assert.equal(q1(env, "SELECT COUNT(*) n FROM sds").n, 0);
  assert.equal(env.FILES.store.size, 0);
  // an empty place_id field is treated as not given
  assert.equal((await go(env, { answers, place: "" }, solventAi)).status, 200);
});

test("no place + a quantity warns; no place and no quantity does not; nothing is linked", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const a = await go(env, { answers: { ...answers, quantity_amount: 5, quantity_unit: "L" } }, solventAi);
  assert.ok(a.body.warnings.includes("No place was chosen, so the quantity was not recorded."));
  const env2 = newEnv(); await enableOpenAi(env2);
  const b = await go(env2, { answers }, solventAi);
  assert.ok(!b.body.warnings.some(w => /No place was chosen/.test(w)));
  for (const e of [env, env2]) assert.equal(q1(e, "SELECT COUNT(*) n FROM chemical_places").n, 0);
});

test("draft-only upload (no AI) still links to the chosen place", async () => {
  const env = newEnv();
  const { body } = await go(env, { answers: { quantity_amount: 12, quantity_unit: "L" }, place: 1 });
  assert.equal(body.mode, "draft_only");
  const l = q1(env, "SELECT * FROM chemical_places");
  assert.equal(l.chemical_id, body.chemical_ids[0]);
  assert.equal(l.quantity, 12);
  assert.equal(l.unit, "L");
});

test("several products from one sheet: only the first is linked, with the quantity, and a warning says so", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const { body } = await go(env, { text: plaster, answers: { ...answers, quantity_amount: 40, quantity_unit: "kg" }, place: 1 }, plasterAi);
  assert.equal(body.chemical_ids.length, 4);
  const links = q(env, "SELECT * FROM chemical_places");
  assert.equal(links.length, 1);
  assert.equal(links[0].chemical_id, body.chemical_ids[0]);
  assert.equal(links[0].quantity, 40);
  assert.ok(body.warnings.some(w => /first product only/.test(w)));
});

test("a new version does not duplicate a link and links chemicals that were not linked there", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const first = (await go(env, { answers: { ...answers, quantity_amount: 5, quantity_unit: "L" }, place: 1 }, solventAi)).body;
  assert.equal(q1(env, "SELECT COUNT(*) n FROM chemical_places").n, 1);
  // same place again: no duplicate (UNIQUE would otherwise fail the whole batch)
  const v2 = (await go(env, { answers, place: 1 }, solventAi)).body;
  assert.equal(v2.mode, "new_version", JSON.stringify(v2));
  assert.equal(q(env, "SELECT * FROM chemical_places WHERE place_id = 1").length, 1);
  assert.equal(q1(env, "SELECT quantity FROM chemical_places").quantity, 5, "existing link untouched");
  assert.equal(q1(env, "SELECT chemical_count n FROM places WHERE id = 1").n, 1);
  // a different place: the existing chemical gets linked there too, without a quantity
  const v3 = (await go(env, { answers, place: 3 }, solventAi)).body;
  assert.equal(v3.mode, "new_version");
  const links = q(env, "SELECT chemical_id, place_id, quantity FROM chemical_places ORDER BY place_id");
  assert.deepEqual(links.map(l => [l.chemical_id, l.place_id, l.quantity]), [[first.chemical_ids[0], 1, 5], [first.chemical_ids[0], 3, null]]);
  assert.equal(q1(env, "SELECT chemical_count n FROM places WHERE id = 3").n, 1);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM chemicals").n, 1);
});

test("a failed batch leaves no link and no count change", async () => {
  const env = newEnv(); await enableOpenAi(env);
  const real = env.DB.batch.bind(env.DB);
  env.DB.batch = async (stmts) => { if (stmts.length > 3) stmts.push(env.DB.prepare("INSERT INTO nonexistent_table VALUES (1)")); return real(stmts); };
  const { status } = await go(env, { answers, place: 1 }, solventAi);
  assert.equal(status, 500);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM chemical_places").n, 0);
  assert.equal(q1(env, "SELECT chemical_count n FROM places WHERE id = 1").n, 0);
  assert.equal(env.FILES.store.size, 0);
});
