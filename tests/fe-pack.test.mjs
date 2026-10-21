import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const PDFLib = require("pdf-lib");
const fflate = require("fflate");
const PM = require("../public/lib/pack-model.js");
const PB = require("../public/lib/pdf-bundle.js");
const ZB = require("../public/lib/zip-build.js");
const ref = await import("../public/lib/ghs-ref.mjs");

const D = { short: "Short disclaimer line for the pack tests.", full: "Full disclaimer for the pack tests.", points: ["Point one.", "Point two."] };
async function fakeSds(title, n) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) doc.addPage([595, 842]).drawText(title + " SDS page " + i, { x: 50, y: 780, size: 14, font });
  return doc.save();
}

// Fictional pack reply: A has everything, B shares A's SDS but has no assessment, C has neither, D has an SDS record with no PDF file.
const pack = {
  generated_at: "2026-10-20T00:00:00Z",
  chemicals: [
    { chemical: { id: 1, product_name: "Alpha Thinner", supplier: "FictoCo", decision: "hazardous", pictograms: "GHS02,GHS07", classification: [{ c: "flam_liq", k: "2" }], sds_id: 10, risk_level: "significant_controlled" },
      sds: { id: 10, file_name: "alpha.pdf", has_file: 1, issue_date: "2023-03-12", review_due: "2028-03-12", un_number: "1263", dg_class: "3" },
      assessment: { id: 5, assessed_date: "2026-10-01", assessed_by: "A. Person", risk_level: "significant_controlled", controls: [{ id: 1, kind: "ppe", label: "Safety glasses" }], fire_response: "Use foam." },
      places: [{ place_id: 1, name: "Ute", place_type: "vehicle", registration: "ABC123", quantity: 20, unit: "L" }] },
    { chemical: { id: 2, product_name: "Beta Thinner Pack", supplier: "FictoCo", decision: "hazardous", pictograms: "GHS02", classification: [{ c: "flam_liq", k: "2" }], sds_id: 10 },
      sds: { id: 10, file_name: "alpha.pdf", has_file: 1, issue_date: "2023-03-12", review_due: "2028-03-12" }, assessment: null, places: [] },
    { chemical: { id: 3, product_name: "Gamma Soap", supplier: "CleanCo", decision: "not_hazardous", pictograms: "", classification: [] }, sds: null, assessment: null, places: [] },
    { chemical: { id: 4, product_name: "Delta Solvent", supplier: "FictoCo", decision: "hazardous", pictograms: "GHS07", classification: null, sds_id: 12 },
      sds: { id: 12, file_name: "delta.pdf", has_file: 0, issue_date: null, review_due: null }, assessment: { id: 6, risk_level: "uncertain", controls: [] }, places: [] },
  ],
};
const job = { client: "Smith / Plumbing: Site 4", jobRef: "J-104", date: "2026-10-20", place: { name: "Ute", place_type: "vehicle", registration: "ABC123" }, preparedBy: "Test Admin", company: { company_name: "Acme Workshop", company_address: "1 Test St", company_phone: "0400 000 000" } };

test("pack model: what is missing for each chemical", () => {
  const items = pack.chemicals.map((e) => PM.toBundleChem(e, "2026-10-20"));
  assert.deepEqual(items.map((c) => PM.missingParts(c)), [[], ["No assessment on file"], ["No SDS on file", "No assessment on file"], ["No SDS PDF on file"]]);
  assert.deepEqual(items[0].pictogramList, ["GHS02", "GHS07"]);
  assert.equal(items[0].status, "ok");
  assert.equal(items[0].assessment.grouped.ppe[0], "Safety glasses");
  assert.equal(items[0].links[0].place.registration, "ABC123");
});

test("cover lines, file names, ids", () => {
  const items = pack.chemicals.map((e) => PM.toBundleChem(e));
  const cover = PM.coverModel(items, job);
  assert.equal(cover.missingCount, 3);
  assert.deepEqual(cover.company, ["Acme Workshop", "1 Test St", "0400 000 000"]);
  const facts = Object.fromEntries(cover.facts);
  assert.equal(facts["Client or site"], "Smith / Plumbing: Site 4");
  assert.equal(facts["Place"], "Ute (Vehicle, ABC123)");
  assert.equal(facts["Prepared by"], "Test Admin");
  assert.deepEqual(cover.items[2].notes, ["No SDS on file", "No assessment on file"]);
  assert.equal(PM.fileBase(job), "Job pack - Smith Plumbing Site 4 - J-104 - 2026-10-20");
  assert.equal(PM.fileBase({}), "Job pack");
  assert.deepEqual(PM.parseIds("3, 2,x,2,-1,0,7.5,9"), [3, 2, 9]);
  assert.equal(PM.parseIds(Array.from({ length: 150 }, (_, i) => i + 1).join(",")).length, 100);
});

test("zip entries: a shared SDS is one file named by its products; the README lists everything", async () => {
  const items = pack.chemicals.map((e) => PM.toBundleChem(e));
  const entries = PM.zipEntries(items);
  assert.equal(entries.length, 1, "D has no PDF, C no SDS, A and B share one");
  assert.equal(entries[0].name, "Alpha Thinner + Beta Thinner Pack.pdf");
  const cover = PM.coverModel(items, job);
  const txt = PM.zipReadme(cover, job, D, ["Alpha Thinner"], 0);
  for (const n of ["Alpha Thinner", "Beta Thinner Pack", "Gamma Soap", "Delta Solvent", "No SDS on file", "J-104", "Smith / Plumbing", "The SDS PDF could not be fetched", D.full]) assert.ok(txt.includes(n), n);
  const z = new ZB.ZipBuilder(fflate);
  z.addPdf(entries[0].name.replace(/\.pdf$/, ""), new Uint8Array([1, 2, 3]));
  z.addText("README.txt", txt);
  const files = fflate.unzipSync(new Uint8Array(await z.finish().arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ["Alpha Thinner + Beta Thinner Pack.pdf", "README.txt"]);
});

test("a real pack PDF: every chemical appears, missing parts are placeholders, the disclaimer is on the cover and in footers", async () => {
  const items = pack.chemicals.map((e) => PM.toBundleChem(e)).sort((a, b) => a.product_name.localeCompare(b.product_name));
  const cover = PM.coverModel(items, job);
  const fetched = [];
  const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const res = await PB.buildPackPdf(PDFLib, { cover, chemicals: items }, {
    D, ref,
    fetchSds: async (id) => { fetched.push(id); return id === 10 ? new Uint8Array(await fakeSds("Alpha", 3)) : null; },
    pictoDeps: { fetchBytes: async (u) => new Uint8Array(fs.readFileSync("public" + u)), toPng: async () => new Uint8Array(Buffer.from(PNG1, "base64")) },
  });
  assert.deepEqual(fetched, [10], "the shared SDS is fetched once; the one with no PDF is not requested");
  const out = await PDFLib.PDFDocument.load(res.bytes);
  assert.equal(out.getPageCount(), res.pageCount);
  // cover + register + 4 assessment pages + 3 SDS pages + placeholders for Gamma (no SDS) and Delta (no PDF) = 11
  assert.equal(res.pageCount, 11);

  const pdfjs = await import(pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(res.bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(" "));
  const all = pages.join("\n");
  for (const n of ["Alpha Thinner", "Beta Thinner Pack", "Gamma Soap", "Delta Solvent"]) assert.ok(pages[0].includes(n), n + " is on the cover");
  assert.ok(pages[0].includes("No SDS on file") && pages[0].includes("No assessment on file") && pages[0].includes("No SDS PDF on file"));
  assert.ok(pages[0].includes("Point one."), "disclaimer on the cover");
  assert.ok(pages[0].includes("J-104") && pages[0].includes("Test Admin"));
  assert.ok(all.includes("No assessment has been prepared for this chemical yet"));
  assert.ok(all.includes("No safety data sheet is on file for this chemical. Ask the supplier"));
  assert.ok(all.includes("no PDF file is attached"));
  assert.ok(all.includes("Alpha SDS page 3"), "SDS pages copied in");
  // the disclaimer line is in the footer of every GENERATED page (not the copied SDS pages)
  const generated = pages.filter((t) => !t.includes("SDS page"));
  assert.equal(generated.length, 8);
  generated.forEach((t) => assert.ok(t.includes("Short disclaimer line for the pack tests."), "footer: " + t.slice(0, 40)));
  fs.mkdirSync(".wrangler/agent-tools2", { recursive: true });
  fs.writeFileSync(".wrangler/agent-tools2/test-pack.pdf", res.bytes);
});

// ---- register pagination and pictogram images -------------------------------------------------------------
const PNG1x = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const fakeDeps = { fetchBytes: async (u) => new Uint8Array(fs.readFileSync("public" + u)), toPng: async () => new Uint8Array(Buffer.from(PNG1x, "base64")) };

function manyEntries(n) {
  return Array.from({ length: n }, (_, i) => ({
    chemical: { id: i + 1, product_name: "Chem " + String(i + 1).padStart(2, "0"), supplier: "FictoCo", decision: "hazardous", pictograms: "GHS02,GHS07,GHS08", classification: [{ c: "flam_liq", k: "2" }], sds_id: null },
    sds: null, assessment: null, places: [],
  }));
}

test("table pagination: 17 and 40 rows flow onto continuation pages, never fewer than 3 rows on a page unless it is the only page", async () => {
  for (const n of [1, 2, 3, 5, 16, 17, 18, 19, 40]) {
    const doc = await PDFLib.PDFDocument.create();
    const fonts = { reg: await doc.embedFont(PDFLib.StandardFonts.Helvetica), bold: await doc.embedFont(PDFLib.StandardFonts.HelveticaBold) };
    const img = await doc.embedPng(new Uint8Array(Buffer.from(PNG1x, "base64")));
    const w = new PB.Writer(PDFLib, doc, fonts);
    w.newPage([841.89, 595.28]);
    w.heading("Register", 15);
    const sizes = [];
    const chunks = w.table(["Product", "Supplier", "Pictograms"], Array.from({ length: n }, (_, i) => ["Chem " + i, "FictoCo", "GHS02, GHS07, GHS08"]), [30, 30, 30], null, {
      cellImages: (ri, ci) => (ci === 2 ? [img, img, img] : null),
    }).slice();
    void sizes;
    assert.equal(chunks.reduce((a, b) => a + b, 0), n, n + " rows all drawn");
    assert.equal(doc.getPageCount(), chunks.length, n + " rows: one page per chunk");
    if (chunks.length > 1) chunks.forEach((c) => assert.ok(c >= 3, n + " rows: page with " + c + " rows (" + chunks.join("+") + ")"));
  }
});

test("pack register with 17 and 40 chemicals: images in the pictogram column, balanced continuation pages, header repeated", async () => {
  const pdfjs = await import(pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href);
  for (const n of [17, 40]) {
    const items = manyEntries(n).map((e) => PM.toBundleChem(e));
    const cover = PM.coverModel(items, job);
    const res = await PB.buildPackPdf(PDFLib, { cover, chemicals: items }, { D, ref, fetchSds: async () => null, pictoDeps: fakeDeps });
    const doc = await pdfjs.getDocument({ data: new Uint8Array(res.bytes), verbosity: 0 }).promise;
    const reg = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const [, , wd, ht] = pg.view;
      if (wd <= ht) continue; // portrait: cover and assessment pages
      const text = (await pg.getTextContent()).items.map((x) => x.str).join(" ");
      reg.push({ text, rows: (text.match(/Chem \d\d/g) || []).length });
    }
    assert.ok(reg.length >= 1);
    assert.equal(reg.reduce((a, r) => a + r.rows, 0), n, n + " rows on the register pages");
    if (reg.length > 1) reg.forEach((r) => assert.ok(r.rows >= 3, n + " chemicals: a register page has only " + r.rows + " rows (" + reg.map((x) => x.rows).join("+") + ")"));
    reg.forEach((r) => assert.ok(/Pictograms \(GHS\)/.test(r.text), "header repeated on every register page"));
    reg.forEach((r) => assert.ok(!/GHS02, GHS07, GHS08/.test(r.text), "images, not text codes, when every image is available"));
    // the images are really drawn: the register page's resources hold image XObjects
    const out = await PDFLib.PDFDocument.load(res.bytes);
    const landscape = out.getPages().filter((p) => p.getWidth() > p.getHeight());
    landscape.forEach((p) => { const x = p.node.Resources().lookup(PDFLib.PDFName.of("XObject")); assert.ok(x && x.keys().length >= 2, "image XObjects on the register page"); });
  }
});

test("pictogram text codes stay as the fallback when an image is missing", async () => {
  const items = manyEntries(4).map((e) => PM.toBundleChem(e));
  const cover = PM.coverModel(items, job);
  const res = await PB.buildPackPdf(PDFLib, { cover, chemicals: items }, { D, ref, fetchSds: async () => null, pictoDeps: { fetchBytes: async () => null, toPng: async () => null } });
  const pdfjs = await import(pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(res.bytes), verbosity: 0 }).promise;
  const t = (await (await doc.getPage(2)).getTextContent()).items.map((x) => x.str).join(" ");
  assert.ok(/GHS02, GHS07, GHS08/.test(t));
});
