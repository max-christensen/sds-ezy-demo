import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const PDFLib = require("pdf-lib");
const PB = require("../public/lib/pdf-bundle.js");
const EM = require("../public/lib/export-model.js");
const XB = require("../public/lib/xlsx-build.js");
const PT = require("../public/lib/pdf-text.js");
const writeXlsx = require("../public/vendor/write-excel-file.min.js");
const readXlsx = require("../public/vendor/read-excel-file.min.js");

const ref = await import("../public/lib/ghs-ref.mjs");
const ML = require("../public/lib/manifest-layout.js");
const D = { short: "Short disclaimer line for tests.", full: "Full disclaimer.", points: ["Point one.", "Point two."] };

// A made-up SDS (fictional product) with `n` pages.
export async function fakeSds(title, n) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText("SAFETY DATA SHEET", { x: 50, y: 790, size: 16, font });
    p.drawText(title + " - page " + i, { x: 50, y: 760, size: 12, font });
    if (i === 1) {
      p.drawText("Product name: " + title, { x: 50, y: 730, size: 11, font });
      p.drawText("Supplier: Fictional Chemicals Pty Ltd", { x: 50, y: 712, size: 11, font });
      p.drawText("Issue date: 12 March 2023", { x: 50, y: 694, size: 11, font });
      p.drawText("UN number: 1263   Class: 3   Packing group: II", { x: 50, y: 676, size: 11, font });
      p.drawText("Signal word: DANGER. H225 Highly flammable liquid and vapour.", { x: 50, y: 658, size: 11, font });
    }
  }
  return doc.save();
}
globalThis.__fakeSds = fakeSds;

const data = {
  generated_at: "2026-10-19T01:00:00Z",
  company: { company_name: "Acme Workshop", company_address: "1 Test St", company_phone: "0400 000 000" },
  chemicals: [
    { id: 1, product_name: "Thinner “2000” – fast", supplier: "Paintco", decision: "hazardous", sds_id: 10, sds_issue_date: "2023-03-12", review_due: "2028-03-12", risk_level: "significant_controlled", dg_class: "3", un_number: "1263", packing_group: "II", hazchem_code: "3YE", proper_shipping_name: "PAINT RELATED MATERIAL", signal_word: "Danger", pictograms: "GHS02,GHS07", ghs_classification: JSON.stringify([{ c: "flam_liq", k: "2" }]), use_description: "Gun cleaning ≥ daily" },
    { id: 2, product_name: "Thinner Fast Pack", supplier: "Paintco", decision: "hazardous", sds_id: 10, sds_issue_date: "2023-03-12", review_due: "2020-01-01", risk_level: "uncertain", dg_class: "3", pictograms: "GHS02", ghs_classification: JSON.stringify([{ c: "flam_liq", k: "2" }]) },
    { id: 3, product_name: "Hand soap", supplier: "CleanCo", decision: "not_hazardous", sds_id: null },
    { id: 4, product_name: "Missing file product", supplier: "X", decision: "hazardous", sds_id: 11, review_due: "2030-01-01", dg_class: "8" },
  ],
  places: [
    { id: 1, name: "Main workshop", place_type: "workshop", counts_toward_totals: true, archived: false },
    { id: 2, name: "Ute", place_type: "vehicle", registration: "ABC123", counts_toward_totals: false, archived: false },
  ],
  links: [
    { id: 1, place_id: 1, chemical_id: 1, quantity: 300, unit: "L" },
    { id: 2, place_id: 1, chemical_id: 2, quantity: 5, unit: "L" },
    { id: 3, place_id: 1, chemical_id: 4, quantity: 3, unit: "kg" },
    { id: 4, place_id: 2, chemical_id: 1, quantity: 20, unit: "L" },
  ],
  assessments: [
    { chemical_id: 1, assessed_date: "2026-10-01", assessed_by: "Prepared from the SDS (AI draft)", risk_level: "significant_controlled", route_inhalation: 1, route_ingestion: 0, route_absorption: 1, controls: [{ kind: "ppe", label: "Safety glasses" }, { kind: "ventilation", label: "Fume cupboard" }], fire_response: "Use foam. ".repeat(60), unverified: '["hazchem_code"]' },
  ],
  sds_files: [],
  audits: [{ id: 7, place_id: 1, place_name: "Main workshop", place_type: "workshop", started_by_name: "Test User", started_at: "2026-10-20T12:00:00Z", finished_at: "2026-10-20T12:40:00Z", status: "finished", summary: JSON.stringify({ listed: 3, present: 1, not_found: 1, changed: 1, not_marked: 0, found: 1, disposals: 1, photos: 2, photo_bytes: 2097152 }) },
    { id: 8, place_id: 2, place_name: "Ute", place_type: "vehicle", place_registration: "ABC123", started_by_name: "Test Admin", started_at: "2026-10-21T01:00:00Z", status: "in_progress", summary: null }],
  audit_items: [{ audit_id: 7, chemical_id: 1, product_name: "Thinner", result: "changed", new_quantity: 10, new_unit: "L", expected_quantity: 20, expected_unit: "L", review_status: "overdue", has_sds: 1, has_assessment: 1 }, { audit_id: 8, chemical_id: 1, product_name: "Thinner", result: null }],
  audit_found: [{ audit_id: 7, client_id: "f1", product_name: "Mystery Spray", source: "ai", outcome: "created", found_at: "2026-10-20T12:20:00Z" }],
  audit_disposals: [{ audit_id: 7, client_id: "d1", place_name: "Main workshop", description: "Old can", reason: "damaged", status: "to_dispose", flagged_by_name: "Test User", flagged_at: "2026-10-20T12:30:00Z" }],
  audit_findings: [{ audit_id: 7, kind: "changed", place_name: "Main workshop", product_name: "Thinner", status: "open" }],
  audit_photos: [],
};

test("sanitise keeps text the standard fonts can draw", () => {
  assert.equal(PB.sanitise("“Quote” – dash… CO₂ 日本 é"), '"Quote" - dash... CO2  é');
});

test("bundle: cover, register, manifest, assessments, SDS once", async () => {
  const model = EM.normalise(data, "2026-10-19");
  const fetched = [];
  const sections = ML.sectionsFromExport(data, ref);
  const res = await PB.buildBundle(PDFLib, model, {
    D, ref, sections,
    pictoDeps: { fetchBytes: async (u) => new Uint8Array(fs.readFileSync("public" + u)), toPng: async () => new Uint8Array(Buffer.from(PNG1, "base64")) },
    fetchSds: async (id) => { fetched.push(id); return id === 10 ? new Uint8Array(await fakeSds("Thinner 2000", 3)) : null; },
  });
  assert.deepEqual(fetched, [11, 10]);
  assert.deepEqual(res.notes.missing, ["Missing file product"]);
  {
    const pdfjs0 = await import(pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href);
    const d0 = await pdfjs0.getDocument({ data: new Uint8Array(res.bytes), verbosity: 0 }).promise;
    let ah = "";
    for (let i = 1; i <= d0.numPages; i++) { const t = (await (await d0.getPage(i)).getTextContent()).items.map((x) => x.str).join(" "); if (t.includes("Audit history")) ah += t; }
    assert.ok(ah.includes("Main workshop") && ah.includes("Ute (ABC123)") && ah.includes("In progress"), "Audit history section");
  }
  const out = await PDFLib.PDFDocument.load(res.bytes);
  assert.equal(out.getPageCount(), res.pageCount);
  assert.ok(res.pageCount >= 1 + 1 + 1 + 4 + 3, "pages " + res.pageCount);
  fs.mkdirSync(".wrangler/agent-tools", { recursive: true });
  fs.writeFileSync(".wrangler/agent-tools/test-bundle.pdf", res.bytes);
});

test("xlsx sheets are built and round trip through the vendored writer/reader", async () => {
  const model = EM.normalise(data, "2026-10-19");
  const sections = ML.sectionsFromExport(data, ref);
  const sheets = XB.buildSheets(model, D, { ref, sections });
  assert.deepEqual(sheets.map((s) => s.sheet), ["Register", "Hazardous", "Places", "Place links", "Manifest", "Placard and manifest", "Issues", "Assessments", "Review due", "Audits", "Audit items", "Found items", "Disposals", "Findings"]);
  const blob = await writeXlsx(sheets).toBlob();
  const read = await readXlsx(blob);
  assert.equal(read.length, 14);
  for (const s of read) assert.ok(s.data.some((row) => row.includes(D.short)), s.sheet + " has the disclaimer");
  for (const sh of read) assert.ok(sh.data.some((row) => row.some((c) => /Safe Work Australia/.test(String(c)))), sh.sheet + " has the source line");
  const man = read.find((s) => s.sheet === "Manifest").data;
  assert.ok(man.some((r) => r[0] === "Business" && r[1] === "Acme Workshop"));
  const pm = read.find((s) => s.sheet === "Placard and manifest").data;
  const itemRows = pm.filter((r) => typeof r[0] === "number");
  assert.equal(itemRows.length, 43, "all 43 items for the one counting place");
  const i7 = itemRows.find((r) => r[0] === 7);
  assert.equal(i7[6], 305);
  assert.equal(i7[7], "OVER");
  assert.ok(pm.some((r) => /^Over the placard quantity at Main workshop: Item 7/.test(String(r[0]))));
  assert.ok(pm.some((r) => /^Places that are not counted/.test(String(r[0]))));
  assert.ok(pm.flat().some((c) => String(c) === ref.VEHICLE_TRANSPORT_NOTE), "the vehicle note is listed");
  const places = read.find((s) => s.sheet === "Places").data;
  assert.ok(places.some((r) => r[0] === "Ute" && r[1] === "Vehicle" && r[2] === "ABC123" && r[3] === "No"));
  const links = read.find((s) => s.sheet === "Place links").data;
  assert.ok(links.some((r) => r[0] === "Main workshop" && r[3] === "Thinner “2000” – fast" && r[4] === 300));
  assert.ok(read.find((s) => s.sheet === "Issues").data.flat().some((c) => /No GHS classification/.test(String(c))));
  const reg = read.find((s) => s.sheet === "Register").data;
  assert.ok(reg.flat().includes("GHS02 Flame; GHS07 Exclamation mark"));
  const au = read.find((s) => s.sheet === "Audits").data;
  assert.ok(au.some((r) => r[0] === 7 && r[1] === "Main workshop" && r[4] === "Finished" && r[8] === 3 && r[10] === 1 && r[16] === 2), "audit 7 counts come from the summary");
  assert.ok(au.some((r) => r[0] === 8 && r[4] === "In progress, not finished" && r[8] === 1), "audit 8 counts are worked out from its items");
  const ai = read.find((s) => s.sheet === "Audit items").data;
  assert.ok(ai.some((r) => r[0] === 7 && r[2] === "Thinner" && r[4] === "Changed" && r[8] === 10));
  assert.ok(read.find((s) => s.sheet === "Found items").data.flat().includes("Added to the register (needs an SDS)"));
  assert.ok(read.find((s) => s.sheet === "Disposals").data.flat().includes("Old can"));
  assert.ok(read.find((s) => s.sheet === "Findings").data.flat().includes("Changed: update quantity or container"));
  const rev = read.find((s) => s.sheet === "Review due").data;
  assert.ok(rev.flat().includes("Overdue"));
});

test("pdf.js text extraction on a made-up SDS", async () => {
  let pdfjs;
  try { pdfjs = await import(pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href); } catch (e) { return; }
  const bytes = new Uint8Array(await fakeSds("Zinc Spray 500", 2));
  const r = await PT.extractText(pdfjs, bytes);
  assert.equal(r.pages, 2);
  assert.match(r.text, /Product name: Zinc Spray 500/);
  assert.match(r.text, /UN number: 1263/);
  assert.equal(r.scanned, false);
  const blank = await PDFLib.PDFDocument.create(); blank.addPage();
  const r2 = await PT.extractText(pdfjs, new Uint8Array(await blank.save()));
  assert.equal(r2.scanned, true);
});

const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
test("pictograms: GIF goes through toPng, the JPEG is embedded as is", async () => {
  const doc = await PDFLib.PDFDocument.create();
  const calls = [];
  const m = await PB.embedPictograms(PDFLib, doc, ref, {
    fetchBytes: async (u) => new Uint8Array(fs.readFileSync("public" + u)),
    toPng: async (b, mime) => { calls.push(mime); return new Uint8Array(Buffer.from(PNG1, "base64")); },
  });
  assert.equal(m.size, 9);
  assert.equal(calls.length, 8, "eight GIFs decoded, the flame JPEG not");
  const flame = fs.readFileSync("public/pictograms/ghs-flame-pictogram.jpg");
  assert.equal(m.get("GHS02").width, 220);
  assert.equal(flame[0], 0xff);
  const only = await PB.embedPictograms(PDFLib, doc, ref, { fetchBytes: async () => null, toPng: async () => null }, ["GHS02"]);
  assert.equal(only.size, 0, "a missing file is skipped, not fatal");
});

test("take-away bundle register: 17 chemicals paginate without a lone row, with pictogram images", async () => {
  const many = {
    generated_at: "2026-10-19T01:00:00Z", company: { company_name: "Acme" },
    chemicals: Array.from({ length: 17 }, (_, i) => ({ id: i + 1, product_name: "Reg " + String(i + 1).padStart(2, "0"), supplier: "X", decision: "hazardous", pictograms: "GHS02,GHS07,GHS08", classification: [{ c: "flam_liq", k: "2" }] })),
    places: [], links: [], assessments: [], sds_files: [],
  };
  const model = EM.normalise(many, "2026-10-19");
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const res = await PB.buildBundle(PDFLib, model, { D, ref, sections: { places: [], not_counted: [] }, pictoDeps: { fetchBytes: async (u) => new Uint8Array(fs.readFileSync("public" + u)), toPng: async () => new Uint8Array(Buffer.from(PNG, "base64")) } });
  const pdfjs = await import(pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(res.bytes), verbosity: 0 }).promise;
  const counts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const t = (await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(" ");
    const n = (t.match(/Reg \d\d/g) || []).length;
    if (n && /Pictograms \(GHS\)/.test(t)) { counts.push(n); assert.ok(!/GHS02, GHS07, GHS08/.test(t)); }
  }
  assert.equal(counts.reduce((a, b) => a + b, 0), 17);
  if (counts.length > 1) counts.forEach((c) => assert.ok(c >= 3, counts.join("+")));
});
