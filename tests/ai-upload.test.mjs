import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeEnv } from "./fixtures/d1shim.mjs";
import { handlePrecheck, handleUpload, cleanAnswers, guessProductName, candidateNames } from "../src/upload.js";
import { handlePutAiSettings } from "../src/ai.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const solvent = fx("sds-solvent.txt"), plaster = fx("sds-plaster-multi.txt"), paint = fx("sds-paint-nonhaz.txt");
const user = { id: 1, name: "Una User", role: "user" };
let counter = 0;

function newEnv(extra = {}) {
  const env = makeEnv(extra);
  env.DB.raw.exec("INSERT INTO users (id, name, email, password_hash, role) VALUES (1, 'Una User', 'una@example.com', 'x', 'user'), (2, 'Other', 'o@example.com', 'x', 'user')");
  env.DB.raw.exec("INSERT INTO places (id, name, place_type) VALUES (1, 'Main workshop', 'workshop'); INSERT INTO places (id, name, place_type, archived) VALUES (2, 'Old yard', 'workshop', 1)");
  return env;
}
function pdfBytes(tag = "") { return new TextEncoder().encode(`%PDF-1.4\n% fake test pdf ${tag} ${++counter}\n%%EOF\n`); }
function uploadReq({ bytes = pdfBytes(), name = "sheet.pdf", type = "application/pdf", text = solvent, answers = {}, replace, place } = {}) {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type }));
  fd.append("text", text);
  fd.append("answers", JSON.stringify(answers));
  if (replace) fd.append("replace_sds_id", String(replace));
  if (place !== undefined) fd.append("place_id", String(place));
  return new Request("http://x/api/uploads", { method: "POST", body: fd });
}
const sha = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
function withAi(env, producer) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return jsonRes({ choices: [{ message: { content: JSON.stringify(producer(calls.length)) }, finish_reason: "stop" }] }); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
async function enableOpenAi(env) {
  env.OPENAI_API_KEY = "sk-upload-test-key-123456";
  await handlePutAiSettings(new Request("http://x", { method: "PUT", body: JSON.stringify({ provider: "openai" }) }), env);
}
const q = (env, sql, ...p) => env.DB.raw.prepare(sql).all(...p);
const q1 = (env, sql, ...p) => env.DB.raw.prepare(sql).get(...p);

const solventAi = (over = {}) => ({
  sds: { title: "KARRA CLEAN Solvent Wash", supplier: "Brightwell Coatings Pty Ltd", issue_date: "2023-03-14", emergency_phone: "1800 555 0142", signal_word: "Danger",
    un_number: "1993", dg_class: "3", packing_group: "II", hazchem_code: "3YE", proper_shipping_name: "FLAMMABLE LIQUID, N.O.S.", pictograms: ["flame", "exclamation"],
    cas_numbers: ["64-17-5", "67-63-0"], h_statements: "H225 Highly flammable liquid and vapour", p_statements: "P210 Keep away from heat" },
  products: [{ product_name: "KARRA CLEAN Solvent Wash 5L", physical_form: "liquid", product_codes: "KC-5" }],
  classification: [{ class: "flam_liq", category: "2" }, { class: "eye_dmg", category: "2A" }, { class: "stot_se", category: 3 }],
  decision: "hazardous", decision_note: "Section 2: flammable liquid category 2.",
  assessment: { form: "liquid", use_description: "cleaning", route_inhalation: true, isolation: ["Lids kept on containers when not in use", "Bunded drip tray"], ventilation: ["local exhaust ventilation"],
    ppe: ["Safety glasses"], additional_ppe: ["Half-face respirator with suitable filter"], risk_level: "significant_controlled", monitoring_needed: false, surveillance_needed: null }, ...over,
});
const plasterAi = () => ({
  sds: { title: "FinishCoat Plaster range", supplier: "Karrawong Building Products", issue_date: "2021-08-09", emergency_phone: "+61 2 5550 0199", signal_word: "Danger",
    un_number: null, pictograms: ["corrosive"], cas_numbers: ["26499-65-0", "1305-62-0"], h_statements: "H315 Causes skin irritation; H318 Causes serious eye damage" },
  products: ["Light", "Standard", "Quick", "Base"].map((n, i) => ({ product_name: `FinishCoat Plaster ${n}`, product_codes: `KP-10${i + 1}`, physical_form: "powder" })),
  classification: [{ class: "skin_corr", category: "2" }, { class: "eye_dmg", category: "1" }],
  decision: "hazardous", decision_note: "Eye damage category 1.",
  assessment: { form: "powder", route_inhalation: true, ppe: ["safety glasses"], additional_ppe: ["P2 dust mask"], risk_level: "significant_controlled" },
});

test("guards: magic bytes, extension, declared type, size cap", async () => {
  const env = newEnv();
  let res = await handleUpload(uploadReq({ bytes: new TextEncoder().encode("<html>not a pdf at all</html>") }), env, user);
  assert.equal(res.status, 400);
  res = await handleUpload(uploadReq({ name: "sheet.exe" }), env, user);
  assert.equal(res.status, 400);
  res = await handleUpload(uploadReq({ type: "image/png" }), env, user);
  assert.equal(res.status, 400);
  assert.equal(env.FILES.store.size, 0, "rejected files are never stored");
  assert.equal(q1(env, "SELECT COUNT(*) n FROM sds").n, 0);

  env.DB.raw.exec("INSERT INTO settings (key, value) VALUES ('upload_max_mb', '1')");
  const big = new Uint8Array(1.5 * 1024 * 1024); big.set(new TextEncoder().encode("%PDF-1.4\n"));
  res = await handleUpload(uploadReq({ bytes: big }), env, user);
  assert.equal(res.status, 413);
  // hard max is 25 MB even if the setting says more
  env.DB.raw.exec("UPDATE settings SET value = '500' WHERE key = 'upload_max_mb'");
  const pre = await (await handlePrecheck(new Request("http://x", { method: "POST", body: JSON.stringify({ file_hash: "a".repeat(64) }) }), env, user)).json();
  assert.equal(pre.limits.max_mb, 25);
});

test("rate limit counts every attempt (even rejected ones) and is per login", async () => {
  const env = newEnv();
  env.DB.raw.exec("INSERT INTO settings (key, value) VALUES ('upload_rate_per_hour', '3')");
  for (let i = 0; i < 3; i++) assert.equal((await handleUpload(uploadReq({ name: "bad.txt" }), env, user)).status, 400);
  const res = await handleUpload(uploadReq(), env, user);
  assert.equal(res.status, 429);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM sds").n, 0);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM upload_log WHERE user_id = 1").n, 4);
  // another login is unaffected
  assert.equal((await handleUpload(uploadReq(), env, { id: 2, name: "Other", role: "user" })).status, 200);
});

test("no AI configured: draft_only with the PDF stored, one chemical, blank assessment, friendly ai_error", async () => {
  const env = newEnv();
  const bytes = pdfBytes("a");
  const res = await handleUpload(uploadReq({ bytes, name: "Karra Clean Solvent SDS v3.pdf", answers: { use_where_how: "wiping", quantity_amount: 5, quantity_unit: "L" }, place: 1 }), env, user);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.mode, "draft_only");
  assert.ok(body.ai_error && !/stack|undefined/i.test(body.ai_error));
  assert.equal(body.chemical_ids.length, 1);
  assert.equal(body.assessment_ids.length, 1);
  const sds = q1(env, "SELECT * FROM sds WHERE id = ?", body.sds_id);
  assert.equal(sds.source, "upload");
  assert.equal(sds.ai_provider, null);
  assert.equal(sds.is_current, 1);
  assert.equal(sds.file_hash, await sha(bytes), "server computed hash");
  assert.ok(sds.r2_key.startsWith("sds/") && env.FILES.store.has(sds.r2_key));
  const chem = q1(env, "SELECT * FROM chemicals WHERE id = ?", body.chemical_ids[0]);
  assert.equal(chem.decision, null);
  assert.equal(chem.sds_id, body.sds_id);
  assert.match(chem.product_name, /Karra Clean Solvent/i);
  const a = q1(env, "SELECT * FROM assessments WHERE id = ?", body.assessment_ids[0]);
  assert.equal(a.source, "blank");
  assert.equal(a.risk_level, "uncertain");
  assert.equal(chem.risk_level, "uncertain");
  const loc = q1(env, "SELECT * FROM chemical_places WHERE chemical_id = ?", chem.id);
  assert.equal(loc.place_id, 1, "draft-only uploads still link to the chosen place");
  assert.equal(loc.quantity, 5);
  assert.equal(loc.unit, "L");
  assert.equal(q1(env, "SELECT chemical_count n FROM places WHERE id = 1").n, 1);
});

test("AI success: SDS, chemical, drafted assessment, decision, control links, verified fields", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const f = withAi(env, () => solventAi({ sds: { ...solventAi().sds, poison_schedule: "S7", hazchem_code: "2WE" } }));
  let body;
  try {
    const res = await handleUpload(uploadReq({ answers: { use_where_how: "Wiping tools", exposure: "15_to_60_min", ventilation: "good", aerosolised: "no" } }), env, user);
    body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
  } finally { f.restore(); }
  assert.equal(body.mode, "ai");
  assert.ok(!body.ai_error);
  assert.deepEqual([...body.unverified].sort(), ["hazchem_code", "poison_schedule"]);
  const sds = q1(env, "SELECT * FROM sds WHERE id = ?", body.sds_id);
  assert.equal(sds.ai_provider, "openai");
  assert.equal(sds.un_number, "1993");
  assert.equal(sds.hazchem_code, null);
  assert.equal(sds.poison_schedule, null);
  assert.equal(sds.issue_date, "2023-03-14");
  assert.equal(sds.review_due, "2028-03-14");
  assert.equal("pictograms" in sds || "hazardous" in sds, false, "columns are gone");
  assert.equal(sds.cas_numbers, "64-17-5, 67-63-0");
  assert.deepEqual(JSON.parse(sds.unverified).sort(), ["hazchem_code", "poison_schedule"]);
  const chem = q1(env, "SELECT * FROM chemicals WHERE id = ?", body.chemical_ids[0]);
  assert.equal(chem.decision, "hazardous");
  assert.equal(chem.decision_by, "Prepared from the SDS (AI draft)");
  assert.equal(chem.review_due, "2028-03-14");
  assert.equal(chem.risk_level, "significant_controlled");
  assert.equal(chem.dg_class, "3");
  assert.match(chem.search_text, /karra clean/);
  assert.match(chem.search_text, /64-17-5/);
  const a = q1(env, "SELECT * FROM assessments WHERE id = ?", body.assessment_ids[0]);
  assert.equal(a.source, "ai");
  assert.equal(a.assessed_by, "Prepared from the SDS (AI draft)");
  assert.equal(a.risk_level, "significant_controlled");
  assert.equal(a.route_inhalation, 1);
  assert.equal(a.monitoring_needed, 0);
  assert.equal(a.surveillance_needed, null);
  assert.equal(a.sds_date, "2023-03-14");
  assert.equal(a.use_description, "Wiping tools");
  assert.match(a.controls_notes, /Bunded drip tray/);
  assert.equal(a.ppe_notes, null);
  assert.equal(JSON.parse(a.answers).exposure, "15_to_60_min");
  const labels = q(env, "SELECT o.label FROM assessment_controls c JOIN control_options o ON o.id = c.option_id WHERE c.assessment_id = ?", a.id).map(r => r.label).sort();
  assert.deepEqual(labels, ["Half-face respirator with suitable filter", "Lids kept on containers when not in use", "Local exhaust ventilation", "Safety glasses"]);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM control_options").n, 24, "no option rows invented");
  assert.equal(q1(env, "SELECT COUNT(*) n FROM chemical_places").n, 0, "no place chosen, no link");
  assert.ok(f.calls[0].body.messages[1].content.includes("Wiping tools"), "answers sent to the AI");
});

test("multi-product SDS: four chemicals share one SDS, each gets an assessment, quantity on the first only", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const f = withAi(env, plasterAi);
  let body;
  try { body = await (await handleUpload(uploadReq({ text: plaster, answers: { quantity_amount: 40, quantity_unit: "kg", quantity_note: "8 x 5 kg bags", exposure: "1_to_4_hours", ventilation: "poor" }, place: 1 }), env, user)).json(); } finally { f.restore(); }
  assert.equal(body.mode, "ai", JSON.stringify(body));
  assert.equal(body.chemical_ids.length, 4);
  assert.equal(body.assessment_ids.length, 4);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM sds").n, 1);
  assert.equal(q1(env, "SELECT COUNT(DISTINCT sds_id) n FROM chemicals").n, 1);
  assert.equal(q1(env, "SELECT COUNT(DISTINCT chemical_id) n FROM assessments WHERE source = 'ai'").n, 4);
  const locs = q(env, "SELECT * FROM chemical_places");
  assert.equal(locs.length, 1);
  assert.equal(locs[0].unit, "kg");
  assert.equal(locs[0].container_note, "8 x 5 kg bags");
  assert.equal(locs[0].chemical_id, body.chemical_ids[0]);
  assert.ok(body.warnings.some(w => /first product/.test(w)));
  const sds = q1(env, "SELECT * FROM sds");
  assert.equal(sds.un_number, null);
  assert.equal(sds.emergency_phone, "+61 2 5550 0199");
  assert.equal(sds.issue_date, "2021-08-09");
  const kinds = q(env, "SELECT DISTINCT o.label FROM assessment_controls c JOIN control_options o ON o.id = c.option_id").map(r => r.label).sort();
  assert.deepEqual(kinds, ["P2 dust mask", "Safety glasses"]);
});

test("not hazardous sheet records decision not_hazardous", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const f = withAi(env, () => ({
    sds: { title: "Wallbright Interior Matt White", supplier: "Wallbright Paints Pty Ltd", issue_date: "2022-03", emergency_phone: "1800 555 0177", un_number: "1263", signal_word: "Warning" },
    products: [{ product_name: "Wallbright Interior Matt White 10L", physical_form: "liquid" }],
    classification: [], decision: "hazardous", pictograms: ["GHS06"], assessment: { risk_level: "not_significant" },
  }));
  let body;
  try { body = await (await handleUpload(uploadReq({ text: paint, answers: { use_where_how: "painting walls", exposure: "over_4_hours", ventilation: "good" } }), env, user)).json(); } finally { f.restore(); }
  assert.equal(body.mode, "ai", JSON.stringify(body));
  const chem = q1(env, "SELECT * FROM chemicals WHERE id = ?", body.chemical_ids[0]);
  assert.equal(chem.decision, "not_hazardous");
  const sds = q1(env, "SELECT * FROM sds");
  assert.equal(sds.issue_date, "2022-03-01", "month-only issue date uses the 1st");
  assert.equal(sds.review_due, "2027-03-01");
  assert.equal(sds.un_number, null);
  assert.equal(sds.signal_word, null, "no signal word in the text");
  assert.ok(body.unverified.includes("un_number") && body.unverified.includes("signal_word"));
  assert.ok(body.warnings.some(w => /month and year/.test(w)));
});

test("AI failure after the file is stored is fail-soft (draft_only + ai_error), including bad JSON", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({ choices: [{ message: { content: "Sorry, I can't." }, finish_reason: "stop" }] });
  let body;
  try { body = await (await handleUpload(uploadReq(), env, user)).json(); } finally { globalThis.fetch = orig; }
  assert.equal(body.mode, "draft_only");
  assert.match(body.ai_error, /filed without a draft/);
  assert.equal(q1(env, "SELECT source FROM assessments").source, "blank");
});

test("exact duplicate by file hash: 409 with the existing SDS id, nothing new stored", async () => {
  const env = newEnv();
  const bytes = pdfBytes("dup");
  const first = await (await handleUpload(uploadReq({ bytes }), env, user)).json();
  const res = await handleUpload(uploadReq({ bytes, name: "renamed.pdf" }), env, user);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.sds_id, first.sds_id);
  assert.deepEqual(body.chemical_ids, first.chemical_ids);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM sds").n, 1);
  assert.equal(env.FILES.store.size, 1);
  const pre = await (await handlePrecheck(new Request("http://x", { method: "POST", body: JSON.stringify({ file_hash: await sha(bytes), file_name: "x.pdf", text_head: "" }) }), env, user)).json();
  assert.equal(pre.exact_duplicate.sds_id, first.sds_id);
  assert.equal(pre.ok, true);
});

test("same supplier + product name becomes a NEW VERSION, never a second copy", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const f = withAi(env, () => solventAi());
  let v1, v2;
  try {
    v1 = await (await handleUpload(uploadReq({ answers: { use_where_how: "x", exposure: "15_to_60_min" } }), env, user)).json();
    const edited = solventAi();
    edited.sds.issue_date = "2023-03-14";
    f.restore();
    const f2 = withAi(env, () => ({ ...edited, assessment: { ...edited.assessment, risk_level: "significant_not_controlled" } }));
    try { v2 = await (await handleUpload(uploadReq({ answers: { use_where_how: "x", exposure: "over_4_hours" } }), env, user)).json(); } finally { f2.restore(); }
  } finally { f.restore(); }
  assert.equal(v1.mode, "ai");
  assert.equal(v2.mode, "new_version", JSON.stringify(v2));
  assert.notEqual(v1.sds_id, v2.sds_id);
  const rows = q(env, "SELECT * FROM sds ORDER BY id");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].doc_key, rows[1].doc_key);
  assert.equal(rows[0].is_current, 0);
  assert.ok(rows[0].replaced_at);
  assert.equal(rows[1].is_current, 1);
  assert.equal(rows[1].version_no, 2);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM chemicals").n, 1, "no second copy of the chemical");
  assert.equal(q1(env, "SELECT sds_id FROM chemicals").sds_id, v2.sds_id);
  const as = q(env, "SELECT * FROM assessments ORDER BY id");
  assert.equal(as.length, 2);
  assert.equal(as[0].is_current, 0);
  assert.equal(as[1].is_current, 1);
  assert.equal(as[1].risk_level, "significant_not_controlled");
  assert.equal(q1(env, "SELECT risk_level FROM chemicals").risk_level, "significant_not_controlled");
  assert.equal(env.FILES.store.size, 2, "both PDFs kept");
});

test("replace_sds_id forces a new version even when the name differs; fail-soft keeps existing assessments", async () => {
  const env = newEnv();
  const first = await (await handleUpload(uploadReq({ text: solvent }), env, user)).json(); // draft_only
  const res = await handleUpload(uploadReq({ replace: first.sds_id }), env, user);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.mode, "new_version");
  assert.ok(body.ai_error);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM chemicals").n, 1);
  assert.equal(q1(env, "SELECT sds_id FROM chemicals").sds_id, body.sds_id);
  assert.equal(q1(env, "SELECT COUNT(*) n FROM assessments").n, 1, "no new blank assessment over the existing one");
  assert.equal((await handleUpload(uploadReq({ replace: 9999 }), env, user)).status, 400);
});

test("a failed database write leaves nothing behind and removes the R2 object", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (stmts) => {
    if (stmts.length > 3) { // the upload batch, not a lookup batch
      stmts.push(env.DB.prepare("INSERT INTO chemicals (id, product_name) VALUES (1, 'x')"), env.DB.prepare("INSERT INTO chemicals (id, product_name) VALUES (1, 'duplicate id')"));
    }
    return realBatch(stmts);
  };
  const f = withAi(env, () => plasterAi());
  let res;
  try { res = await handleUpload(uploadReq({ text: plaster }), env, user); } finally { f.restore(); }
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(body.error && !/sqlite|UNIQUE|constraint/i.test(body.error));
  assert.equal(env.FILES.store.size, 0, "R2 object removed");
  for (const t of ["sds", "chemicals", "assessments", "assessment_controls", "chemical_places"]) assert.equal(q1(env, `SELECT COUNT(*) n FROM ${t}`).n, 0, t);
});

test("text is capped at 150,000 characters; AI input is trimmed to the provider budget", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const f = withAi(env, () => solventAi());
  const huge = solvent + "\nSECTION 16: Other information\n" + "filler words ".repeat(30000);
  try { await handleUpload(uploadReq({ text: huge }), env, user); } finally { f.restore(); }
  const sent = f.calls[0].body.messages[1].content;
  assert.ok(sent.length < 110000, `sent ${sent.length}`);
  assert.ok(sent.includes("Ethanol") && sent.includes("UN number: 1993"), "priority sections survive the trim");
});

test("precheck: candidates by registered product name, limits and AI info", async () => {
  const env = newEnv();
  await enableOpenAi(env);
  const f = withAi(env, () => solventAi());
  let first;
  try { first = await (await handleUpload(uploadReq({}), env, user)).json(); } finally { f.restore(); }
  const head = "SAFETY DATA SHEET\nKARRA CLEAN Solvent Wash 5L\nIssue date 2024";
  const res = await handlePrecheck(new Request("http://x", { method: "POST", body: JSON.stringify({ file_hash: "b".repeat(64), file_name: "new.pdf", file_size: 1000, text_head: head }) }), env, user);
  const pre = await res.json();
  assert.equal(pre.exact_duplicate, null);
  assert.equal(pre.candidates.length, 1);
  assert.equal(pre.candidates[0].sds_id, first.sds_id);
  assert.deepEqual(pre.candidates[0].chemical_ids, first.chemical_ids);
  assert.equal(pre.limits.max_mb, 15);
  assert.equal(pre.limits.remaining_this_hour, 9);
  assert.deepEqual(pre.ai, { configured: true, provider: "openai" });
  const none = await (await handlePrecheck(new Request("http://x", { method: "POST", body: JSON.stringify({ file_hash: "c".repeat(64), text_head: "Something unrelated entirely" }) }), env, user)).json();
  assert.equal(none.candidates.length, 0);
  assert.equal((await handlePrecheck(new Request("http://x", { method: "POST", body: JSON.stringify({ file_hash: "zz" }) }), env, user)).status, 400);
});

test("helpers: answers cleaning, name guessing, candidate names", () => {
  const a = cleanAnswers(JSON.stringify({ use_where_how: " x ".repeat(2000), aerosolised: "maybe", quantity_amount: "12.5", quantity_unit: "gal", exposure: "over_4_hours", ventilation: "<script>" }));
  assert.equal(a.use_where_how.length, 1000);
  assert.equal(a.aerosolised, null);
  assert.equal(a.quantity_amount, 12.5);
  assert.equal(a.quantity_unit, "L");
  assert.equal(a.exposure, "over_4_hours");
  assert.equal(a.ventilation, null);
  assert.deepEqual(cleanAnswers("not json"), cleanAnswers({}));
  assert.equal(cleanAnswers({ quantity_amount: -4 }).quantity_amount, null);
  assert.equal(guessProductName("whatever.pdf", "Product name: Acme Degreaser 20L\nfoo"), "Acme Degreaser 20L");
  assert.equal(guessProductName("Acme_Degreaser_SDS_v2.pdf", "nothing useful"), "Acme Degreaser");
  assert.ok(candidateNames("SAFETY DATA SHEET\nAcme Degreaser 20L\n").includes("Acme Degreaser 20L"));
});
