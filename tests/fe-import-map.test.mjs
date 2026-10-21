import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const IM = require("../public/lib/import-map.js");

// Made-up sheet in the style of a small workshop register, with title rows above the header.
const sheet = [
  ["ACME Workshop chemical register", null, null],
  [],
  ["Product Name", "Supplier", "Location", "Qty", "Unit", "UN No.", "Class", "PG", "Hazchem", "SDS Date", "Use", "Hazardous?", "Comments"],
  ["Thinner 2000", "Paintco", "Flam cabinet 1", 20, "L", "UN1263", "3", "II", "3YE", "12/03/2021", "Cleaning guns", "Hazardous", ""],
  ["Hand soap", "CleanCo", "Wash bay", "5 L", "", "", "", "", "", new Date("2022-05-01T00:00:00Z"), "", "Non-hazardous", "Pump pack"],
  ["Welding gas", "GasCo", "Gas store", "4 x 9 kg", "", 1956, "2.2", "", "2T", "3 Jun 2020", "", "yes", ""],
  [null, "Nobody", "Shed", 1],
  ["Thinner 2000", "Paintco", "Shed", 5, "ml", "", "", "", "", "garbage", "", "maybe", ""],
  [],
];

test("header row is found below title rows", () => {
  assert.equal(IM.detectHeaderRow(sheet), 2);
});

test("columns are guessed", () => {
  const m = IM.guessMapping(sheet[2]);
  assert.equal(m.product_name, 0);
  assert.equal(m.supplier, 1);
  assert.equal(m.location, 2);
  assert.equal(m.quantity, 3);
  assert.equal(m.unit, 4);
  assert.equal(m.un_number, 5);
  assert.equal(m.dg_class, 6);
  assert.equal(m.packing_group, 7);
  assert.equal(m.hazchem_code, 8);
  assert.equal(m.sds_date, 9);
  assert.equal(m.use_description, 10);
  assert.equal(m.decision, 11);
  assert.equal(m.notes, 12);
});

test("alternative header wording", () => {
  const m = IM.guessMapping(["Chemical", "Manufacturer", "Stored at", "Amount (L)", "Dangerous Goods Class", "Packing Group", "Date of Issue"]);
  assert.equal(m.product_name, 0);
  assert.equal(m.supplier, 1);
  assert.equal(m.location, 2);
  assert.equal(m.quantity, 3);
  assert.equal(m.dg_class, 4);
  assert.equal(m.packing_group, 5);
  assert.equal(m.sds_date, 6);
});

test("rows are cleaned and problems listed", () => {
  const map = IM.guessMapping(sheet[2]);
  const items = IM.buildRows(sheet, map, 2);
  assert.equal(items.length, 5);
  const [a, b, c, d, e] = items;
  assert.deepEqual(
    { n: a.row.product_name, q: a.row.quantity, u: a.row.unit, un: a.row.un_number, cl: a.row.dg_class, pg: a.row.packing_group, d: a.row.sds_date, dec: a.row.decision },
    { n: "Thinner 2000", q: 20, u: "L", un: "1263", cl: "3", pg: "II", d: "2021-03-12", dec: "hazardous" }
  );
  assert.equal(b.row.decision, "not_hazardous");
  assert.equal(b.row.sds_date, "2022-05-01");
  assert.equal(b.row.quantity, 5);
  assert.equal(b.row.decision_note, "Pump pack");
  assert.equal(c.row.quantity, 36);
  assert.equal(c.row.unit, "kg");
  assert.equal(c.row.container_note, "4 x 9 kg");
  assert.equal(c.row.sds_date, "2020-06-03");
  assert.equal(c.row.un_number, "1956");
  assert.equal(c.row.dg_class, "2.2");
  assert.ok(d.skip, "no product name is skipped");
  assert.equal(d.rowNumber, 7);
  assert.ok(e.problems.some((p) => /Same product/.test(p.text)));
  assert.ok(e.problems.some((p) => /SDS date/.test(p.text)));
  assert.ok(e.problems.some((p) => /Decision/.test(p.text)));
  assert.equal(e.row.quantity, 0.005);
  const s = IM.summarise(items);
  assert.equal(s.total, 5);
  assert.equal(s.skipped, 1);
});

test("value parsers", () => {
  assert.deepEqual(IM.parseQuantity("500ml"), { amount: 0.5, unit: "L", note: "" });
  assert.equal(IM.parseQuantity("2.5 kg").amount, 2.5);
  assert.equal(IM.parseQuantity("lots").amount, null);
  assert.equal(IM.parseDate("31/02/2021"), "");
  assert.equal(IM.parseDate("1/7/21"), "2021-07-01");
  assert.equal(IM.parseDate("15 September 2019"), "2019-09-15");
  assert.equal(IM.parseDecision("Not hazardous"), "not_hazardous");
  assert.equal(IM.parseDecision("N/A"), "not_hazardous");
  assert.equal(IM.parseDecision("Y"), "hazardous");
  assert.equal(IM.parseClass("Class 3 (8)").subsidiary, "8");
  assert.equal(IM.parsePg("PG II"), "II");
  assert.equal(IM.parseUn("UN 1993"), "1993");
});
