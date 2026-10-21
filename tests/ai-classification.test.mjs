import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeEnv } from "./fixtures/d1shim.mjs";
import { handleUpload } from "../src/upload.js";
import { handlePutAiSettings, buildPrompt } from "../src/ai.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const solvent = fx("sds-solvent.txt"), plaster = fx("sds-plaster-multi.txt"), paint = fx("sds-paint-nonhaz.txt");
const user = { id: 1, name: "Una User", role: "user" };
let counter = 0;

function newEnv() {
  const env = makeEnv();
  env.DB.raw.exec("INSERT INTO users (id, name, email, password_hash, role) VALUES (1, 'Una User', 'una@example.com', 'x', 'user')");
  return env;
}
function uploadReq({ text = solvent, answers = {}, replace } = {}) {
  const fd = new FormData();
  fd.append("file", new File([new TextEncoder().encode(`%PDF-1.4\n% cls test ${++counter}\n%%EOF\n`)], "sheet.pdf", { type: "application/pdf" }));
  fd.append("text", text);
  fd.append("answers", JSON.stringify(answers));
  if (replace) fd.append("replace_sds_id", String(replace));
  return new Request("http://x/api/uploads", { method: "POST", body: fd });
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
async function enableOpenAi(env) {
  env.OPENAI_API_KEY = "sk-upload-test-key-123456";
  await handlePutAiSettings(new Request("http://x", { method: "PUT", body: JSON.stringify({ provider: "openai" }) }), env);
}
async function upload(env, produce, opts = {}) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({ choices: [{ message: { content: JSON.stringify(produce()) }, finish_reason: "stop" }] });
  try { const res = await handleUpload(uploadReq(opts), env, user); return { status: res.status, body: await res.json() }; } finally { globalThis.fetch = orig; }
}
const q = (env, sql, ...p) => env.DB.raw.prepare(sql).all(...p);
const q1 = (env, sql, ...p) => env.DB.raw.prepare(sql).get(...p);
const chemOf = (env, id) => q1(env, "SELECT * FROM chemicals WHERE id = ?", id);

const solventAi = (over = {}) => ({
  sds: { title: "KARRA CLEAN Solvent Wash", supplier: "Brightwell Coatings Pty Ltd", issue_date: "2023-03-14", signal_word: "Danger",
    un_number: "1993", dg_class: "3", packing_group: "II", cas_numbers: ["64-17-5"] },
  products: [{ product_name: "KARRA CLEAN Solvent Wash 5L", physical_form: "liquid" }],
  classification: [{ class: "flam_liq", category: "2" }, { class: "eye_dmg", category: "2A" }, { class: "stot_se", category: 3 }],
  assessment: { risk_level: "significant_controlled" }, ...over,
});
const answers = { use_where_how: "x", exposure: "15_to_60_min", ventilation: "good" };

test("prompt asks for section 2 classification with the poster ids, and no pictograms or decision", () => {
  const { system } = buildPrompt({ text: "x", answers: {}, optionLabels: [] });
  assert.match(system, /classification/);
  assert.match(system, /SDS section 2/);
  assert.match(system, /flam_liq \(Flammable liquids\)/i);
  assert.match(system, /never infer/i);
  assert.ok(!/- pictograms: only these codes/.test(system));
  assert.ok(!/toxic\|health\|flame/.test(system));
  assert.ok(!/- decision:/.test(system));
});

test("a: supported classification is stored; d: pictograms, signal word and decision are DERIVED, not what the AI said", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const { body } = await upload(env, () => solventAi({
    sds: { ...solventAi().sds, signal_word: "Warning", pictograms: ["GHS06", "GHS09"] },
    pictograms: ["GHS06"], decision: "not_hazardous", signal_word: "Warning",
  }), { answers });
  assert.equal(body.mode, "ai", JSON.stringify(body));
  const chem = chemOf(env, body.chemical_ids[0]);
  assert.deepEqual(JSON.parse(chem.ghs_classification), [
    { c: "flam_liq", k: "2", src: "ai" }, { c: "eye_dmg", k: "2A", src: "ai" }, { c: "stot_se", k: "3", src: "ai" }]);
  assert.equal(chem.classification_flags, null);
  assert.equal(chem.pictograms, "GHS02,GHS07", "from the poster table, not the AI's GHS06/GHS09");
  assert.equal(chem.signal_word, "Danger", "flammable liquid 2 is Danger even though the AI said Warning");
  assert.equal(chem.decision, "hazardous", "derived, although the AI said not_hazardous");
  assert.equal(chem.decision_by, "Prepared from the SDS (AI draft)");
  assert.equal(chem.decision_override, null);
  assert.equal(chem.pictograms_override, null);
  assert.ok(!body.unverified.includes("classification"));
});

test("b: a class whose H-code is not in the text is dropped and flagged; unverified has classification", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const { body } = await upload(env, () => solventAi({ classification: [
    { class: "flam_liq", category: "2" }, { class: "eye_dmg", category: "2A" }, { class: "stot_se", category: "3" },
    { class: "skin_sens", category: "1" }, { class: "carcinogen", category: "1A" }, { class: "made_up", category: "9" }] }), { answers });
  assert.equal(body.mode, "ai");
  assert.ok(body.unverified.includes("classification"));
  const chem = chemOf(env, body.chemical_ids[0]);
  const list = JSON.parse(chem.ghs_classification);
  assert.ok(!list.some(e => e.c === "skin_sens" || e.c === "carcinogen" || e.c === "made_up"));
  const flags = JSON.parse(chem.classification_flags);
  assert.equal(flags.length, 3);
  assert.ok(flags.some(f => /H317/.test(f)));
  assert.ok(flags.some(f => /not on the poster/.test(f)));
  assert.ok(JSON.parse(q1(env, "SELECT unverified FROM sds").unverified).includes("classification"));
  assert.ok(JSON.parse(q1(env, "SELECT unverified FROM assessments").unverified).includes("classification"));
  assert.ok(body.warnings.some(w => /H317/.test(w)));
  assert.equal(chem.pictograms, "GHS02,GHS07");
});

test("c: an H-code in section 2 that the AI missed is added and flagged", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const { body } = await upload(env, () => solventAi({ classification: [{ class: "flam_liq", category: "2" }] }), { answers });
  const chem = chemOf(env, body.chemical_ids[0]);
  const list = JSON.parse(chem.ghs_classification);
  assert.ok(list.some(e => e.c === "stot_se" && e.k === "3" && e.src === "h_code"), JSON.stringify(list));
  const eye = list.find(e => e.c === "eye_dmg");
  assert.ok(eye && eye.k === "2" && eye.src === "h_code" && !eye.check, "H319 matches a single poster row: category 2, no check flag");
  assert.ok(JSON.parse(chem.classification_flags).some(f => /H336/.test(f) && /did not report/.test(f)));
  assert.ok(body.unverified.includes("classification"));
  assert.equal(chem.decision, "hazardous");
  assert.equal(chem.pictograms, "GHS02,GHS07");
});

test("empty list on a sheet without H-codes is classified-none (non-hazardous); missing or malformed means unclassified", async () => {
  const paintAi = (cls) => { const o = { sds: { title: "Wallbright", supplier: "Wallbright Paints Pty Ltd" }, products: [{ product_name: "Wallbright Matt White" }], assessment: {} }; if (cls !== undefined) o.classification = cls; return o; };
  let env = newEnv(); await enableOpenAi(env);
  const a = await upload(env, () => paintAi([]), { text: paint, answers });
  const c1 = chemOf(env, a.body.chemical_ids[0]);
  assert.equal(c1.ghs_classification, "[]");
  assert.equal(c1.decision, "not_hazardous");
  assert.equal(c1.pictograms, null);
  assert.equal(c1.signal_word, null);

  env = newEnv(); await enableOpenAi(env);
  const b = await upload(env, () => paintAi(undefined), { text: paint, answers });
  const c2 = chemOf(env, b.body.chemical_ids[0]);
  assert.equal(c2.ghs_classification, null);
  assert.equal(c2.decision, null);
  assert.ok(b.body.warnings.some(w => /No GHS classification/.test(w)));

  env = newEnv(); await enableOpenAi(env);
  const c = await upload(env, () => paintAi("flammable"), { text: paint, answers });
  assert.equal(chemOf(env, c.body.chemical_ids[0]).ghs_classification, null);
});

test("e: AI failure leaves a NULL classification and no decision", async () => {
  const env = newEnv();
  const body = await (await handleUpload(uploadReq(), env, user)).json();
  assert.equal(body.mode, "draft_only");
  const chem = chemOf(env, body.chemical_ids[0]);
  for (const f of ["ghs_classification", "classification_flags", "decision", "pictograms", "signal_word", "decision_by"]) assert.equal(chem[f], null, f);
});

test("multi-product SDS: every chemical gets the classification and the derived values", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const { body } = await upload(env, () => ({
    sds: { title: "FinishCoat", supplier: "Karrawong Building Products", issue_date: "2021-08-09" },
    products: ["Light", "Standard", "Quick", "Base"].map(n => ({ product_name: `FinishCoat Plaster ${n}` })),
    classification: [{ class: "skin_corr", category: "2" }, { class: "eye_dmg", category: "1" }], assessment: {},
  }), { text: plaster, answers });
  const rows = q(env, "SELECT ghs_classification, pictograms, decision, signal_word FROM chemicals");
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.pictograms, "GHS05,GHS07");
    assert.equal(r.decision, "hazardous");
    assert.equal(r.signal_word, "Danger");
    assert.deepEqual(JSON.parse(r.ghs_classification).map(e => e.c).sort(), ["eye_dmg", "skin_corr"]);
  }
  assert.equal(body.chemical_ids.length, 4);
});

test("f: a new version replaces the classification unless an admin edited or overrode it", async () => {
  const v2text = solvent.replace("H225 Highly flammable", "H226 Flammable");
  const v2ai = () => solventAi({ classification: [{ class: "flam_liq", category: "3" }, { class: "eye_dmg", category: "2A" }, { class: "stot_se", category: "3" }] });
  const setup = async () => { const env = newEnv(); await enableOpenAi(env); const first = (await upload(env, () => solventAi(), { answers })).body; return { env, first }; };

  let { env, first } = await setup();
  const v2 = (await upload(env, v2ai, { text: v2text, answers })).body;
  assert.equal(v2.mode, "new_version", JSON.stringify(v2));
  let chem = chemOf(env, first.chemical_ids[0]);
  assert.ok(JSON.parse(chem.ghs_classification).some(e => e.c === "flam_liq" && e.k === "3"), "replaced when nothing was edited");
  assert.equal(chem.signal_word, "Warning");
  assert.equal(q1(env, "SELECT COUNT(*) n FROM chemicals").n, 1);

  ({ env, first } = await setup());
  const adminList = JSON.stringify([{ c: "flam_liq", k: "1", src: "admin" }]);
  env.DB.raw.prepare("UPDATE chemicals SET ghs_classification = ?, pictograms = 'GHS02', signal_word = 'Danger' WHERE id = ?").run(adminList, first.chemical_ids[0]);
  const w = (await upload(env, v2ai, { text: v2text, answers })).body;
  assert.equal(w.mode, "new_version");
  chem = chemOf(env, first.chemical_ids[0]);
  assert.equal(chem.ghs_classification, adminList, "admin classification untouched");
  assert.equal(chem.sds_id, w.sds_id, "still re-pointed at the new sheet");
  assert.ok(w.warnings.some(x => /not changed because an admin/.test(x)));

  ({ env, first } = await setup());
  const before = chemOf(env, first.chemical_ids[0]).ghs_classification;
  env.DB.raw.prepare("UPDATE chemicals SET decision_override = 'not_hazardous', decision = 'not_hazardous' WHERE id = ?").run(first.chemical_ids[0]);
  const x = (await upload(env, v2ai, { text: v2text, answers })).body;
  chem = chemOf(env, first.chemical_ids[0]);
  assert.equal(chem.ghs_classification, before);
  assert.equal(chem.decision, "not_hazardous");
  assert.ok(x.warnings.some(m => /not changed because an admin/.test(m)));

  ({ env, first } = await setup());
  env.DB.raw.prepare("UPDATE chemicals SET pictograms_override = 'none' WHERE id = ?").run(first.chemical_ids[0]);
  const y = (await upload(env, v2ai, { text: v2text, answers })).body;
  assert.ok(y.warnings.some(m => /not changed because an admin/.test(m)));
});

test("new version when the AI fails keeps the existing classification", async () => {
  const { env, first } = await (async () => { const env = newEnv(); await enableOpenAi(env); const first = (await upload(env, () => solventAi(), { answers })).body; return { env, first }; })();
  const before = chemOf(env, first.chemical_ids[0]);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({}, 500);
  let body;
  try { body = await (await handleUpload(uploadReq({ replace: first.sds_id }), env, user)).json(); } finally { globalThis.fetch = orig; }
  assert.equal(body.mode, "new_version");
  const after = chemOf(env, first.chemical_ids[0]);
  assert.equal(after.ghs_classification, before.ghs_classification);
  assert.equal(after.decision, "hazardous");
});
