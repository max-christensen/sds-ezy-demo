import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const PDFLib = require("pdf-lib");
const AR = require("../public/lib/audit-report.js");

const D = { short: "Short disclaimer line for the audit tests.", full: "Full disclaimer.", points: ["Audit point one.", "Audit point two."] };
const JPG = new Uint8Array(fs.readFileSync("public/pictograms/ghs-flame-pictogram.jpg")); // a real, small JPEG used as the photo fixture
const T = (h, m = 0) => "2026-10-20T" + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":00Z";

const data = {
  audit: { id: 7, place_id: 2, place_name: "Ute 1", place_type: "vehicle", place_registration: "ABC123", started_by_name: "Test User", started_at: T(12, 0), finished_at: T(12, 40), finished_by_name: "Test User", status: "finished", notes: "Rear locker was locked." },
  items: [
    { chemical_id: 1, product_name: "Zeta Cleaner", supplier: "CleanCo", expected_quantity: 5, expected_unit: "L", review_status: "ok", has_sds: 1, has_assessment: 1, result: "present", marked_at: T(12, 5) },
    { chemical_id: 2, product_name: "Alpha Thinner", supplier: "FictoCo", expected_quantity: 20, expected_unit: "L", expected_container_note: "4 x 5 L", review_status: "overdue", review_due: "2025-01-01", has_sds: 1, has_assessment: 1, result: "changed", new_quantity: 10, new_unit: "L", new_container_note: "2 x 5 L", note: "Used on site", marked_at: T(12, 10) },
    { chemical_id: 3, product_name: "Beta Solvent", supplier: "FictoCo", review_status: "no_sds", has_sds: 0, has_assessment: 0, result: "not_found", note: "Not in the locker", marked_at: T(12, 12) },
    { chemical_id: 4, product_name: "Gamma Paint", supplier: "PaintCo", review_status: "ok", has_sds: 1, has_assessment: 0, result: null },
    { chemical_id: 5, product_name: "Delta Gas", supplier: "GasCo", review_status: "due_soon", review_due: "2026-12-01", has_sds: 1, has_assessment: 1, result: "present", marked_at: T(12, 15) },
  ],
  found: [
    { id: 1, client_id: "f-1", product_name: "Mystery Spray", supplier: "Unknown Co", source: "ai", outcome: "created", found_at: T(12, 20), note: "Behind the seat" },
    { id: 2, client_id: "f-2", product_name: "Alpha Thinner 5 L", supplier: "FictoCo", source: "typed", outcome: "link_suggested", found_at: T(12, 25) },
  ],
  disposals: [
    { id: 1, client_id: "d-1", description: "Old rusty can", reason: "damaged", note: "Leaking", status: "to_dispose", flagged_by_name: "Test User", flagged_at: T(12, 30) },
    { id: 2, client_id: "d-2", description: "Unlabelled bottle", reason: "unlabelled", status: "disposed", flagged_by_name: "Test User", flagged_at: T(12, 31), closed_by_name: "Test Admin", closed_at: T(15, 0), close_note: "Taken to the depot" },
  ],
  findings: [{ id: 1, kind: "not_found", product_name: "Beta Solvent", status: "open" }],
  photos: [
    { id: 11, owner_type: "found", owner_key: "f-1", taken_at: T(12, 21), bytes: JPG.length, width: 220, height: 220 },
    { id: 10, owner_type: "item", owner_key: "2", taken_at: T(12, 9), bytes: JPG.length, width: 220, height: 220 },
    { id: 12, owner_type: "disposal", owner_key: "d-1", taken_at: T(12, 30), bytes: JPG.length, width: 220, height: 220 },
  ],
};

test("model: summary counts, ordering and captions", () => {
  const m = AR.buildModel(data);
  assert.deepEqual(m.summary, { listed: 5, present: 2, not_found: 1, changed: 1, not_marked: 1, found: 2, disposals: 2, photos: 3, photo_bytes: JPG.length * 3 });
  // out-of-date first: overdue, due soon, no SDS, no assessment, then the rest
  assert.deepEqual(m.itemRows.map((r) => r.product_name), ["Alpha Thinner", "Delta Gas", "Beta Solvent", "Gamma Paint", "Zeta Cleaner"]);
  const alpha = m.itemRows[0];
  assert.equal(alpha.resultLabel, "Changed");
  assert.match(alpha.changed, /now 10 L; container: 2 x 5 L/);
  assert.match(alpha.reviewText, /^Overdue \(due /);
  assert.equal(m.itemRows[3].assessment, "No assessment on file");
  assert.equal(m.itemRows.find((r) => r.product_name === "Gamma Paint").resultLabel, "Not marked");
  // photos: chemicals first, then found, then disposals; captions name the owner and the capture time
  assert.deepEqual(m.photos.map((p) => p.id), [10, 11, 12]);
  assert.match(m.photos[0].caption, /^Chemical: Alpha Thinner\. Taken 20 Oct 2026, /);
  assert.match(m.photos[1].caption, /^Found item: Mystery Spray\. Taken /);
  assert.match(m.photos[2].caption, /^Flagged for disposal: Old rusty can\. Taken /);
  assert.equal(m.foundRows[0].outcomeLabel, AR.OUTCOME_LABEL.created);
  assert.equal(m.foundRows[1].outcomeLabel, AR.OUTCOME_LABEL.link_suggested);
  assert.equal(m.disposalRows[1].closeNote, "Taken to the depot");
  assert.equal(m.statusText, "Finished");
  assert.equal(m.title, "Ute 1 (Vehicle, ABC123)");
  assert.equal(AR.reportFileBase(data), "Ute 1 2026-10-20");
});

test("model: an in-progress audit is marked, an empty audit still works", () => {
  const m = AR.buildModel({ audit: { place_name: "Shed", started_at: T(12), status: "in_progress" }, items: [], found: [], disposals: [], findings: [], photos: [] });
  assert.equal(m.statusText, "In progress, not finished");
  assert.equal(m.finishedText, "Not finished yet");
  assert.equal(m.summary.listed, 0);
});

test("photo fetching: 3 at a time, a bad or failed photo is left out and reported, never silently", async () => {
  const plan = AR.photoPlan({ items: data.items, found: data.found, disposals: data.disposals, photos: data.photos });
  let active = 0, peak = 0;
  const got = await AR.fetchPhotos(plan, async (id) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (id === 11) return null;                       // fails
    if (id === 12) return new Uint8Array([1, 2, 3, 4]); // not a JPEG
    return JPG;
  });
  assert.ok(peak <= 3);
  assert.deepEqual([...got.keys()], [10]);
});

test("a real audit report PDF: sections, disclaimer on the cover and every page, JPEG bytes embedded unchanged, missing photo listed", async () => {
  const progress = [];
  const res = await AR.buildPdf(PDFLib, data, {
    D, company: { company_name: "Acme Workshop", company_address: "1 Test St", company_phone: "0400 000 000" },
    fetchPhoto: async (id) => (id === 12 ? null : JPG), onProgress: (l) => progress.push(l),
  });
  assert.deepEqual(res.notes.unavailable.length, 1);
  assert.match(res.notes.unavailable[0], /^Flagged for disposal: Old rusty can/);
  const out = await PDFLib.PDFDocument.load(res.bytes);
  assert.equal(out.getPageCount(), res.pageCount);
  // cover + chemicals/found/disposals/findings (landscape, 1 page) + 2 photo pages + 1 "could not be included" page
  assert.equal(res.pageCount, 5);

  const pdfjs = await import(pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(res.bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(" "));
  const all = pages.join("\n");
  assert.ok(pages[0].includes("Chemical audit report") && pages[0].includes("Ute 1 (Vehicle, ABC123)") && pages[0].includes("Test User"));
  assert.ok(pages[0].includes("Audit point one.") && pages[0].includes("Audit point two."), "disclaimer on the cover");
  assert.ok(pages[0].includes("Rear locker was locked."));
  for (const t of ["Chemicals on the register for this place (5)", "Found items (2)", "Flagged for disposal (2)", "Photos (3)", "Photos that could not be included (1)", "Findings for an admin (1)"]) assert.ok(all.includes(t), t);
  for (const n of ["Zeta Cleaner", "Alpha Thinner", "Beta Solvent", "Gamma Paint", "Delta Gas", "Mystery Spray", "Old rusty can", "Unlabelled bottle", "Taken to the depot"]) assert.ok(all.includes(n), n);
  assert.ok(all.includes("Photo not available"));
  assert.ok(all.includes("Taken 20 Oct 2026"), "capture timestamp in the captions");
  pages.forEach((t, i) => assert.ok(t.includes("Short disclaimer line for the audit tests."), "footer on page " + (i + 1)));
  // the photo JPEG is embedded as-is (no re-encode): its exact bytes are in the PDF
  const buf = Buffer.from(res.bytes);
  assert.ok(buf.indexOf(Buffer.from(JPG)) >= 0, "JPEG bytes unchanged in the PDF");
  fs.mkdirSync(".wrangler/agent-tools4", { recursive: true });
  fs.writeFileSync(".wrangler/agent-tools4/test-audit.pdf", res.bytes);
});

test("an in-progress audit says so on the cover", async () => {
  const d = JSON.parse(JSON.stringify(data));
  d.audit.status = "in_progress"; d.audit.finished_at = null; d.photos = [];
  const res = await AR.buildPdf(PDFLib, d, { D, company: { company_name: "Acme" } });
  const pdfjs = await import(pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(res.bytes), verbosity: 0 }).promise;
  const t = (await (await doc.getPage(1)).getTextContent()).items.map((x) => x.str).join(" ");
  assert.ok(t.includes("IN PROGRESS, NOT FINISHED"));
  assert.ok(t.includes("Not finished yet"));
});
