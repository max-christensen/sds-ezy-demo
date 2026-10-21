// Tests for the GHS reference module: the poster table, derivation, H-code checking, and the placard / manifest totals.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PICTOGRAMS, HAZARD_ROWS, PLACARD_ITEMS, H_STATEMENTS, derive, effective, extractHCodes, section2Text, verifyClassification,
  normaliseClassification, itemsForClassification, computeSiteTotals, placardItem, rowsForHCodes, parsePictogramList, categoryAppearsInText, } from "../public/lib/ghs-ref.mjs";

const c = (cls, k, extra = {}) => ({ c: cls, k, ...extra });
const ent = (id, name, classification, quantity, unit = "L", location = "Store", extra = {}) => ({ id, chemical_id: id, name, classification, quantity, unit, location, ...extra });

// ---------------------------------------------------------------- the tables

test("nine pictograms, GHS01 to GHS09, each with an image file", () => {
  assert.deepEqual(PICTOGRAMS.map(p => p.code), ["GHS01", "GHS02", "GHS03", "GHS04", "GHS05", "GHS06", "GHS07", "GHS08", "GHS09"]);
  for (const p of PICTOGRAMS) assert.match(p.file, /^\/pictograms\/[\w-]+\.(gif|jpg)$/);
});

test("every H-code on every poster row has statement text, and every row uses known pictograms", () => {
  for (const r of HAZARD_ROWS) {
    for (const h of r.hCodes) assert.ok(H_STATEMENTS[h], `${r.class} ${r.categories} ${h}`);
    for (const p of r.pictograms) assert.ok(PICTOGRAMS.some(x => x.code === p));
  }
});

test("Schedule 11 table: Items 1 to 43, spot-checked against the Safe Work Australia PDF", () => {
  assert.equal(PLACARD_ITEMS.length, 43);
  assert.deepEqual(PLACARD_ITEMS.map(i => i.item), Array.from({ length: 43 }, (_, i) => i + 1));
  const q = (n) => [placardItem(n).placard, placardItem(n).manifest];
  assert.deepEqual(q(1), [200, 5000]);
  assert.deepEqual(q(2), [50, 500]);
  assert.deepEqual(q(4), [1000, 10000]);
  assert.deepEqual(q(5), [5000, 10000]);
  assert.deepEqual(q(6), [50, 500]);
  assert.deepEqual(q(7), [250, 2500]);
  assert.deepEqual(q(8), [1000, 10000]);
  assert.deepEqual(q(9), [1000, 10000]);
  assert.deepEqual(q(10), [10000, 100000]);
  assert.deepEqual(q(11), [5, 50]);
  assert.deepEqual(q(14), [250, 2500]);
  assert.deepEqual(q(32), [250, 2500]);
  assert.deepEqual(q(40), [1000, 10000]);
  assert.deepEqual(q(42), [5, 50]);
  assert.deepEqual(q(43), [5, 50]);
  assert.equal(placardItem(14).unit, "kg");
  assert.equal(placardItem(15).unit, "kg");
  assert.equal(placardItem(8).unit, "L");
  assert.equal(placardItem(33).unit, "kg or L");
  assert.deepEqual(placardItem(9).mixOf, [6, 7, 8]);
  assert.deepEqual(placardItem(16).mixOf, [12, 13, 14, 15]);
  assert.deepEqual(placardItem(32).mixOf, [30, 31]);
  assert.deepEqual(placardItem(43).mixOf, [11, 29, 42]);
  for (const i of PLACARD_ITEMS) if (i.mixOf) for (const n of i.mixOf) assert.ok(placardItem(n), `mix item ${i.item} refers to ${n}`);
});

// ---------------------------------------------------------------- derivation

test("flammable liquid category 2 -> GHS02, Danger, hazardous", () => {
  const d = derive([c("flam_liq", "2")]);
  assert.deepEqual(d.pictograms, ["GHS02"]);
  assert.equal(d.signal_word, "Danger");
  assert.equal(d.decision, "hazardous");
  assert.deepEqual(d.hCodes, ["H225"]);
});

test("flammable liquid category 3 is Warning; category 4 has no pictogram but is still classified hazardous", () => {
  assert.equal(derive([c("flam_liq", "3")]).signal_word, "Warning");
  const d4 = derive([c("flam_liq", "4")]);
  assert.deepEqual(d4.pictograms, []);
  assert.equal(d4.signal_word, "Warning");
  assert.equal(d4.decision, "hazardous");
});

test("several classes: union of pictograms in GHS order, most severe signal word wins", () => {
  const d = derive([c("flam_liq", "3"), c("skin_corr", "1B"), c("stot_se", "3"), c("aspiration", "1")]);
  assert.deepEqual(d.pictograms, ["GHS02", "GHS05", "GHS07", "GHS08"]);
  assert.equal(d.signal_word, "Danger");
});

test("self-reactive Type B shows two pictograms (GHS01 + GHS02); Type G is not a hazard", () => {
  assert.deepEqual(derive([c("self_reactive", "Type B")]).pictograms, ["GHS01", "GHS02"]);
  const g = derive([c("self_reactive", "Type G")]);
  assert.equal(g.decision, "not_hazardous");
  assert.deepEqual(g.pictograms, []);
  assert.equal(g.signal_word, null);
});

test("acute toxicity: categories 1-3 GHS06, category 4 GHS07", () => {
  assert.deepEqual(derive([c("acute_tox", "2")]).pictograms, ["GHS06"]);
  assert.deepEqual(derive([c("acute_tox", "4")]).pictograms, ["GHS07"]);
  assert.equal(derive([c("acute_tox", "4")]).signal_word, "Warning");
});

test("no classification recorded (null) is 'unknown'; classified with none is non-hazardous", () => {
  assert.equal(derive(null).decision, null);
  assert.equal(derive(null).known, false);
  const none = derive([]);
  assert.equal(none.decision, "not_hazardous");
  assert.equal(none.known, true);
  assert.deepEqual(none.pictograms, []);
  assert.equal(none.signal_word, null);
});

test("GHS09 is never derived (the poster has no environmental classes)", () => {
  for (const r of HAZARD_ROWS) assert.ok(!r.pictograms.includes("GHS09"));
});

test("category unknown (k null): every row of the class, most severe signal word", () => {
  const d = derive([{ c: "flam_solid", k: null }]);
  assert.equal(d.signal_word, "Danger");
  assert.deepEqual(d.pictograms, ["GHS02"]);
});

test("overrides: shown as overridden only when they differ from the derived value", () => {
  const cl = [c("flam_liq", "2")];
  const same = effective(cl, { decision: "hazardous", pictograms: "GHS02" });
  assert.equal(same.decision_overridden, false);
  assert.equal(same.pictograms_overridden, false);
  const ov = effective(cl, { decision: "not_hazardous", pictograms: "GHS02,GHS09" });
  assert.equal(ov.decision, "not_hazardous");
  assert.equal(ov.decision_overridden, true);
  assert.equal(ov.derived.decision, "hazardous");
  assert.deepEqual(ov.pictograms, ["GHS02", "GHS09"]);
  assert.equal(ov.pictograms_overridden, true);
  assert.deepEqual(ov.derived.pictograms, ["GHS02"]);
  const none = effective(cl, {});
  assert.equal(none.decision_overridden, false);
  assert.deepEqual(none.pictograms, ["GHS02"]);
  assert.deepEqual(effective(cl, { pictograms: [] }).pictograms, []);
  assert.deepEqual(effective(cl, { pictograms: "none" }).pictograms, []);
});

test("parsePictogramList ignores unknown codes and sorts", () => {
  assert.deepEqual(parsePictogramList("GHS07, ghs02, XYZ"), ["GHS02", "GHS07"]);
  assert.equal(parsePictogramList(null), null);
});

test("normaliseClassification drops invalid class/category pairs and duplicates", () => {
  const r = normaliseClassification([c("flam_liq", "2"), c("flam_liq", "2"), c("flam_liq", "9"), c("nonsense", "1"), "x", { c: "acute_tox" }]);
  assert.deepEqual(r.list, [{ c: "flam_liq", k: "2" }, { c: "acute_tox", k: null }]);
  assert.equal(r.dropped.length, 3);
});

// ---------------------------------------------------------------- reading H-codes

test("extractHCodes: spacing, plus signs, case-sensitive reproductive codes, ignores unknown codes", () => {
  assert.deepEqual(extractHCodes("H225 Highly flammable. H 319; H302+H312, H360Fd H361f EUH066 H400 P210").sort(), ["H225", "H302", "H312", "H319", "H360Fd", "H361f"].sort());
  assert.deepEqual(extractHCodes("Product H2O contains H2SO4 only"), []);
  assert.deepEqual(extractHCodes("H360FD"), ["H360FD"]);
});

test("section2Text finds section 2 when present", () => {
  const t = "SECTION 1 Identification H999\nSECTION 2 Hazards identification\nFlam. Liq. 2 H225\nSECTION 3 Composition H314";
  const s = section2Text(t);
  assert.match(s, /H225/);
  assert.doesNotMatch(s, /H314/);
});

test("rowsForHCodes: H229 on its own is aerosol category 3; with H222 it is category 1 only", () => {
  assert.deepEqual(rowsForHCodes(["H229"]).map(r => r.categories[0]), ["3"]);
  assert.deepEqual(rowsForHCodes(["H222", "H229"]).map(r => r.categories[0]), ["1"]);
});

test("categoryAppearsInText finds the abbreviations SDS use", () => {
  assert.ok(categoryAppearsInText("skin_corr", "1B", "Classification: Skin Corr. 1B, Eye Dam. 1"));
  assert.ok(!categoryAppearsInText("skin_corr", "1A", "Classification: Skin Corr. 1B, Eye Dam. 1"));
  assert.ok(categoryAppearsInText("acute_tox", "3", "Acute Tox. 3 (Oral); Flam. Liq. 2"));
  assert.ok(categoryAppearsInText("flam_liq", "2", "Flammable liquids, Category 2"));
});

// ---------------------------------------------------------------- checking the AI's reading against the H-codes

const SDS_TEXT = "SECTION 2 Hazards identification\nClassification: Flam. Liq. 2 (H225); Eye Irrit. 2 (H319); STOT SE 3 (H336).\nHazard statements H225 H319 H336\nSECTION 3 Composition";

test("AI classification supported by the H-codes in the text is kept", () => {
  const v = verifyClassification([c("flam_liq", "2"), c("eye_dmg", "2"), c("stot_se", "3")], SDS_TEXT);
  assert.deepEqual(v.list.map(e => `${e.c}:${e.k}`), ["flam_liq:2", "eye_dmg:2", "stot_se:3"]);
  assert.deepEqual(v.flags, []);
  assert.deepEqual(v.removed, []);
});

test("AI class whose H-code is NOT in the text is removed and flagged", () => {
  const v = verifyClassification([c("flam_liq", "2"), c("carcinogen", "1B")], SDS_TEXT);
  assert.ok(!v.list.some(e => e.c === "carcinogen"));
  assert.equal(v.removed.length, 1);
  assert.ok(v.flags.some(f => /Carcinogenicity/.test(f) && /H350/.test(f)));
});

test("H-code in section 2 that the AI missed is added when it points at one row, and flagged", () => {
  const v = verifyClassification([c("flam_liq", "2")], SDS_TEXT);
  const eye = v.list.find(e => e.c === "eye_dmg");
  assert.ok(eye && eye.src === "h_code");
  assert.ok(v.flags.some(f => /H319/.test(f) && /did not report/.test(f)));
});

test("a missed H-code that identifies one poster row is added under that row (H319 -> eye 2, GHS07 only, not GHS05)", () => {
  const v = verifyClassification([], "SECTION 2 Hazards\nH319 Causes serious eye irritation\nSECTION 3");
  assert.deepEqual(v.list.map(e => [e.c, e.k, e.check]), [["eye_dmg", "2", undefined]]);
  assert.deepEqual(derive(v.list).pictograms, ["GHS07"]);
  const sc = verifyClassification([], "SECTION 2 Hazards\nH314 Causes severe skin burns\nSECTION 3");
  assert.deepEqual(sc.list.map(e => [e.c, e.k, e.check]), [["skin_corr", null, true]]);
});

test("a missed H-code that does not identify one category is added with the category marked for checking", () => {
  const v = verifyClassification([], "SECTION 2 Hazards\nH228 Flammable solid\nSECTION 3");
  assert.deepEqual(v.list.map(e => [e.c, e.k, e.check]), [["flam_solid", null, true]]);
});

test("wrong category for the same H-code: acute toxicity category read as 1 when the text says 2 stays but is marked to check", () => {
  const text = "SECTION 2 Hazards\nAcute Tox. 2 (Oral) H300\nSECTION 3";
  const ok = verifyClassification([c("acute_tox", "2")], text);
  assert.equal(ok.list[0].check, undefined);
  const wrong = verifyClassification([c("acute_tox", "1")], text);
  assert.equal(wrong.list[0].k, "1");
  assert.equal(wrong.list[0].check, true);
  assert.ok(wrong.flags.some(f => /category could not be confirmed/.test(f)));
});

test("a classification the poster does not have is ignored and flagged", () => {
  const v = verifyClassification([c("flam_liq", "9")], SDS_TEXT);
  assert.ok(v.flags.some(f => /not on the poster/.test(f)));
});

test("H-codes only in section 16 (ingredients) do not create classes", () => {
  const text = "SECTION 2 Hazards identification\nNot a hazardous substance.\nSECTION 3 Composition\nSECTION 16 Other\nIngredient H314 H350";
  const v = verifyClassification([], text);
  assert.deepEqual(v.list, []);
});

// ---------------------------------------------------------------- which items a chemical counts towards

const itemsOf = (cl) => itemsForClassification(cl).items.map(i => i.item).sort((a, b) => a - b);

test("items for a single hazard class", () => {
  assert.deepEqual(itemsOf([c("flam_liq", "1")]), [6]);
  assert.deepEqual(itemsOf([c("flam_liq", "2")]), [7]);
  assert.deepEqual(itemsOf([c("flam_liq", "3")]), [8]);
  assert.deepEqual(itemsOf([c("flam_liq", "4")]), [10]);
  assert.deepEqual(itemsOf([c("aerosol", "1")]), [5]);
  assert.deepEqual(itemsOf([c("aerosol", "3")]), [5]);
  assert.deepEqual(itemsOf([c("flam_solid", "1")]), [14]);
  assert.deepEqual(itemsOf([c("ox_liquid", "2")]), [26]);
  assert.deepEqual(itemsOf([c("ox_solid", "3")]), [27]);
  assert.deepEqual(itemsOf([c("corr_metal", "1")]), [40]);
  assert.deepEqual(itemsOf([c("skin_corr", "1A")]), [37]);
  assert.deepEqual(itemsOf([c("skin_corr", "1C")]), [39]);
  assert.deepEqual(itemsOf([c("acute_tox", "1")]), [33]);
  assert.deepEqual(itemsOf([c("water_reactive", "3")]), [23]);
  assert.deepEqual(itemsOf([c("self_heating", "2")]), [19]);
  assert.deepEqual(itemsOf([c("pyro_liquid", "1")]), [17]);
  assert.deepEqual(itemsOf([c("self_reactive", "Type A")]), [11]);
  assert.deepEqual(itemsOf([c("self_reactive", "Type E and F")]), [13]);
  assert.deepEqual(itemsOf([c("org_peroxide", "Type B")]), [30]);
  assert.deepEqual(itemsOf([c("explosives", "Unstable explosive")]), [42]);
});

test("health-only hazards have no placard item and raise no issue", () => {
  const r = itemsForClassification([c("skin_sens", "1"), c("carcinogen", "2"), c("eye_dmg", "2")]);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.issues, []);
});

test("gases: flammable gas -> 1; acute toxic gas -> 2 (not 33-36); corrosive gas -> 3; other gas under pressure -> 4", () => {
  assert.deepEqual(itemsOf([c("gas_pressure", "Compressed gas"), c("flam_gas", "1A")]), [1]);
  assert.deepEqual(itemsOf([c("gas_pressure", "Compressed gas"), c("acute_tox", "2")]), [2]);
  assert.deepEqual(itemsOf([c("gas_pressure", "Liquefied gas"), c("skin_corr", "1A")]), [3]);
  assert.deepEqual(itemsOf([c("gas_pressure", "Compressed gas")]), [4]);
  assert.deepEqual(itemsOf([c("gas_pressure", "Compressed gas"), c("flam_gas", "1B"), c("acute_tox", "3")]), [1, 2]);
  assert.deepEqual(itemsOf([c("gas_pressure", "Compressed gas"), c("ox_gas", "1")]), [4]);
});

test("gas with acute toxicity category 4 asks for the LC50 check (not held here)", () => {
  const r = itemsForClassification([c("gas_pressure", "Compressed gas"), c("acute_tox", "4")]);
  assert.deepEqual(r.items.map(i => i.item), [2]);
  assert.ok(r.issues.some(i => i.code === "gas_lc50"));
});

test("things the table gives no item for are reported, not guessed", () => {
  assert.ok(itemsForClassification([c("explosives", "Division 1.4")]).issues.some(i => i.code === "explosives_not_in_table"));
  assert.ok(itemsForClassification([c("desens_explosive", "2")]).issues.some(i => i.code === "desens_not_in_table"));
  assert.ok(itemsForClassification([c("ox_gas", "1")]).issues.some(i => i.code === "ox_gas_alone"));
  assert.ok(itemsForClassification([c("acute_tox", "4")]).issues.some(i => i.code === "acute4_not_in_table"));
  assert.ok(itemsForClassification([{ c: "acute_tox", k: null }]).issues.some(i => i.code === "category_unknown"));
  assert.ok(itemsForClassification(null).issues.some(i => i.code === "no_classification"));
});

test("a chemical that qualifies under several items counts towards each, and says so", () => {
  const cl = [c("flam_liq", "2"), c("acute_tox", "3")];
  assert.deepEqual(itemsOf(cl), [7, 35]);
  const t = computeSiteTotals([ent(1, "Mixed hazard", cl, 100)]);
  assert.equal(t.items.find(i => i.item === 7).total, 100);
  assert.equal(t.items.find(i => i.item === 35).total, 100);
  assert.ok(t.issues.some(i => i.code === "multiple_items"));
});

// ---------------------------------------------------------------- totals against the placard and manifest quantities

const item = (t, n) => t.items.find(i => i.item === n);

test("totals add up stored quantities across locations for an item", () => {
  const t = computeSiteTotals([
    ent(1, "Thinner A", [c("flam_liq", "2")], 100, "L", "Shed"),
    ent(2, "Thinner A", [c("flam_liq", "2")], 120, "L", "Van"),
    ent(3, "Thinner B", [c("flam_liq", "2")], 20, "L", "Shed"),
  ]);
  assert.equal(item(t, 7).total, 240);
  assert.equal(item(t, 7).totalL, 240);
  assert.equal(item(t, 7).contributors.length, 3);
});

test("over is strictly more than the quantity: exactly 250 L of category 2 is not over the placard quantity, 250.5 L is", () => {
  const at = computeSiteTotals([ent(1, "X", [c("flam_liq", "2")], 250)]);
  assert.equal(item(at, 7).placardOver, false);
  const over = computeSiteTotals([ent(1, "X", [c("flam_liq", "2")], 250.5)]);
  assert.equal(item(over, 7).placardOver, true);
  assert.equal(item(over, 7).manifestOver, false);
  assert.deepEqual(over.over.placard, [7]);
});

test("placard and manifest flags are independent: 3000 L of category 2 is over both", () => {
  const t = computeSiteTotals([ent(1, "X", [c("flam_liq", "2")], 3000)]);
  assert.equal(item(t, 7).placardOver, true);
  assert.equal(item(t, 7).manifestOver, true);
  assert.deepEqual(t.over.manifest, [7]);
});

test("mixing item 9 applies when no single item is over on its own, and the combined total is", () => {
  // 40 L cat 1 (<=50), 200 L cat 2 (<=250), 900 L cat 3 (<=1000): none over alone, combined 1140 L > 1000 L
  const t = computeSiteTotals([
    ent(1, "A", [c("flam_liq", "1")], 40), ent(2, "B", [c("flam_liq", "2")], 200), ent(3, "C", [c("flam_liq", "3")], 900),
  ]);
  assert.equal(item(t, 6).placardOver, false);
  assert.equal(item(t, 7).placardOver, false);
  assert.equal(item(t, 8).placardOver, false);
  assert.equal(item(t, 9).total, 1140);
  assert.equal(item(t, 9).mixApplies.placard, true);
  assert.equal(item(t, 9).placardOver, true);
  assert.equal(item(t, 9).manifestOver, false);
});

test("mixing item 9 does not apply when one item is already over on its own (that item is the flag)", () => {
  const t = computeSiteTotals([ent(1, "A", [c("flam_liq", "1")], 60), ent(2, "C", [c("flam_liq", "3")], 990)]);
  assert.equal(item(t, 6).placardOver, true);
  assert.equal(item(t, 9).mixApplies.placard, false);
  assert.equal(item(t, 9).placardOver, false);
});

test("mix columns are checked separately: placard-mix can apply while manifest-mix does not", () => {
  // cat 1 = 600 L is over the manifest quantity (500) on its own; combined with cat 3 = 450 L it is also > placard 1000... but item 6 is over its placard (50) too
  const t = computeSiteTotals([ent(1, "A", [c("flam_liq", "1")], 600)]);
  assert.equal(item(t, 6).placardOver, true);
  assert.equal(item(t, 6).manifestOver, true);
  assert.equal(item(t, 9).mixApplies.placard, false);
  assert.equal(item(t, 9).mixApplies.manifest, false);
});

test("item 43 mixes items 11, 29 and 42 at 5 kg/L placard", () => {
  const t = computeSiteTotals([
    ent(1, "SR-A", [c("self_reactive", "Type A")], 2, "kg"), ent(2, "OP-A", [c("org_peroxide", "Type A")], 2, "kg"), ent(3, "Unst", [c("explosives", "Unstable explosive")], 2, "kg"),
  ]);
  assert.equal(item(t, 11).placardOver, false);
  assert.equal(item(t, 43).total, 6);
  assert.equal(item(t, 43).placardOver, true);
});

test("kg in an item the table gives in litres is NOT converted or counted, and is reported", () => {
  const t = computeSiteTotals([ent(1, "Solvent", [c("flam_liq", "2")], 500, "kg")]);
  assert.equal(item(t, 7).total, 0);
  assert.equal(item(t, 7).placardOver, false);
  assert.ok(t.issues.some(i => i.code === "unit_mismatch"));
  assert.equal(item(t, 7).contributors[0].counted, false);
});

test("litres in a kg-only item (flammable solids) are not counted either", () => {
  const t = computeSiteTotals([ent(1, "Solid", [c("flam_solid", "1")], 300, "L")]);
  assert.equal(item(t, 14).total, 0);
  assert.ok(t.issues.some(i => i.code === "unit_mismatch"));
});

test("'kg or L' items take both units numerically", () => {
  const t = computeSiteTotals([ent(1, "A", [c("ox_liquid", "2")], 200, "L"), ent(2, "B", [c("ox_solid", "2")], 100, "kg")]);
  assert.equal(item(t, 26).total, 300);
  assert.equal(item(t, 26).totalL, 200);
  assert.equal(item(t, 26).totalKg, 100);
  assert.equal(item(t, 26).placardOver, true);
});

test("flammable liquid category 4 in the same spill compound as category 1 counts as category 1 (the PDF's own example)", () => {
  const t = computeSiteTotals([
    ent(1, "Cat 1 solvent", [c("flam_liq", "1")], 1000, "L", "Bund 1"),
    ent(2, "Cat 4 oil", [c("flam_liq", "4")], 1000, "L", "Bund 1"),
  ]);
  assert.equal(item(t, 6).total, 2000);
  assert.equal(item(t, 10).total, 0);
});

test("category 4 uses the lowest category present in the compound; separate compounds are separate", () => {
  const t = computeSiteTotals([
    ent(1, "Cat 2", [c("flam_liq", "2")], 100, "L", "Bund 1"),
    ent(2, "Cat 3", [c("flam_liq", "3")], 100, "L", "Bund 1"),
    ent(3, "Cat 4 oil", [c("flam_liq", "4")], 50, "L", "Bund 1"),
    ent(4, "Cat 4 oil", [c("flam_liq", "4")], 70, "L", "Bund 2"),
  ]);
  assert.equal(item(t, 7).total, 150);
  assert.equal(item(t, 8).total, 100);
  assert.equal(item(t, 10).total, 70);
});

test("an explicit spill_compound groups locations that have different names", () => {
  const t = computeSiteTotals([
    ent(1, "Cat 3", [c("flam_liq", "3")], 100, "L", "Rack A", { spill_compound: "North bund" }),
    ent(2, "Cat 4 oil", [c("flam_liq", "4")], 50, "L", "Rack B", { spill_compound: "North bund" }),
  ]);
  assert.equal(item(t, 8).total, 150);
  assert.equal(item(t, 10).total, 0);
});

test("zero and negative quantities are ignored; unclassified chemicals are reported, not counted", () => {
  const t = computeSiteTotals([ent(1, "Empty", [c("flam_liq", "2")], 0), ent(2, "Unknown", null, 500)]);
  assert.equal(item(t, 7).total, 0);
  assert.ok(t.issues.some(i => i.code === "no_classification" && i.chemical_id === 2));
});

test("a category that is not confirmed is counted but marked, so the manifest can warn", () => {
  const t = computeSiteTotals([ent(1, "Toxic", [c("acute_tox", "2", { check: true })], 100)]);
  assert.equal(item(t, 34).total, 100);
  assert.equal(item(t, 34).contributors[0].check, true);
});

test("all 43 items are always returned, with the table's quantities", () => {
  const t = computeSiteTotals([]);
  assert.equal(t.items.length, 43);
  assert.deepEqual(t.over, { placard: [], manifest: [] });
  assert.equal(item(t, 1).def.placard, 200);
});
