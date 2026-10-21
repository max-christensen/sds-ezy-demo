import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  verifyUn, verifyPackingGroup, verifyHazchem, verifyDgClass, verifySubsidiary, verifyPoisonSchedule, verifyPhone,
  verifyCasList, verifyDate, findDates, parseDateValue, verifyExtraction, validateExtraction, trimForAi, matchControlOptions,
  extractJson, stripInjection,
} from "../src/ai.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const solvent = fx("sds-solvent.txt");

test("UN number: label forms and the real sheet", () => {
  assert.equal(verifyUn("1993", solvent), "1993");
  assert.equal(verifyUn("UN 1993", "Transport: UN1993 FLAMMABLE LIQUID"), "1993");
  assert.equal(verifyUn("UN1993", "UN 1993"), "1993");
  assert.equal(verifyUn("1993", "14.1 UN number (ADG): 1993"), "1993");
  assert.equal(verifyUn("1993", "UN No. 1993"), "1993");
  assert.equal(verifyUn("1993", "UN number\n1993"), "1993");
});
test("UN number: hallucinated or wrong context is rejected", () => {
  assert.equal(verifyUn("1203", solvent), null, "1203 only appears as a catalogue reference number");
  assert.equal(verifyUn("1993", "Reference number 1993 in lab notebook. UN 1203"), null);
  assert.equal(verifyUn("1993", "Date 1993"), null);
  assert.equal(verifyUn("19930", "UN 19930"), null);
  assert.equal(verifyUn("abc", solvent), null);
  assert.equal(verifyUn("1993", "UN number: not applicable. Year 1993."), null);
});

test("packing group: roman, PG, digits; wrong or absent rejected", () => {
  assert.equal(verifyPackingGroup("II", solvent), "II");
  assert.equal(verifyPackingGroup("PG II", "Packing group: II"), "II");
  assert.equal(verifyPackingGroup("2", "Packing Group II"), "II");
  assert.equal(verifyPackingGroup("III", "PG III"), "III");
  assert.equal(verifyPackingGroup("I", "Packing group: III"), null);
  assert.equal(verifyPackingGroup("II", "Packing group: I"), null);
  assert.equal(verifyPackingGroup("II", "Packing group: not applicable"), null);
  assert.equal(verifyPackingGroup("I", "packing group is determined by the carrier"), null);
  assert.equal(verifyPackingGroup("II", "The II in the title"), null);
});

test("hazchem: bullet, spacing, brackets; must sit next to the label", () => {
  assert.equal(verifyHazchem("3YE", solvent), "3YE");
  assert.equal(verifyHazchem("•3YE", "Hazchem code: 3 YE"), "3YE");
  assert.equal(verifyHazchem("3 YE", "Emergency action code: •3YE"), "3YE");
  assert.equal(verifyHazchem("2WE", "Hazchem 3[Y]E"), null);
  assert.equal(verifyHazchem("3[Y]E", "Hazchem 3[Y]E"), "3YE");
  assert.equal(verifyHazchem("2WE", solvent), null);
  assert.equal(verifyHazchem("3YE", "Product 3YE in stock. Hazchem code: none"), null);
  assert.equal(verifyHazchem("3Y", "Hazchem: 3YE"), null);
  assert.equal(verifyHazchem("nonsense", solvent), null);
});

test("dg class: only after a class label, not bare digits", () => {
  assert.equal(verifyDgClass("3", solvent), "3");
  assert.equal(verifyDgClass("Class 3", "DG Class: 3 flammable"), "3");
  assert.equal(verifyDgClass("2.1", "Class 2.1 Flammable gas"), "2.1");
  assert.equal(verifyDgClass("8", solvent), null);
  assert.equal(verifyDgClass("3", "Packing 3 litres. UN 1993"), null);
  assert.equal(verifyDgClass("6.1", "Class 6.1"), "6.1");
  assert.equal(verifyDgClass("6", "Class 6.1"), null);
  assert.equal(verifyDgClass("3", "Subsidiary risk: 3. Class 8"), null, "subsidiary risk is not the main class");
  assert.equal(verifyDgClass("3", "Class: not applicable. Item 3"), null);
});

test("subsidiary class", () => {
  assert.equal(verifySubsidiary("8", "Subsidiary risk: 8"), "8");
  assert.equal(verifySubsidiary("6.1, 8", "Subsidiary risk(s): 6.1, 8"), "6.1, 8");
  assert.equal(verifySubsidiary("8", "Subsidiary risk: None allocated. Class 8"), null);
  assert.equal(verifySubsidiary("3", solvent), null);
});

test("poison schedule", () => {
  assert.equal(verifyPoisonSchedule("S6", "Poisons Standard: Schedule 6"), "S6");
  assert.equal(verifyPoisonSchedule("Schedule 5", "SUSMP classification S5"), "S5");
  assert.equal(verifyPoisonSchedule("S5", "Poisons Standard 2024 Schedule 6"), null);
  assert.equal(verifyPoisonSchedule("S7", solvent), null);
  assert.equal(verifyPoisonSchedule("blue", "Schedule 6"), null);
});

test("emergency phone: digits compared, hallucinations rejected", () => {
  assert.equal(verifyPhone("1800 555 0142", solvent), "1800 555 0142");
  assert.equal(verifyPhone("1800555 0142", solvent), "1800555 0142");
  assert.equal(verifyPhone("02 5550 0199", "Emergency telephone: +61 2 5550 0199"), "02 5550 0199");
  assert.equal(verifyPhone("1800 000 000", solvent), null);
  assert.equal(verifyPhone("call us", solvent), null);
  assert.equal(verifyPhone("1800 555 0142 or 1800 123 456", solvent), null);
});

test("CAS numbers: dashes, checksum, presence", () => {
  const r = verifyCasList(["64-17-5", "67–63–0", "64-17-6", "7732-18-5", "relish"], solvent);
  assert.deepEqual(r.ok, ["64-17-5", "67-63-0"]);
  assert.equal(r.bad.length, 3);
  assert.deepEqual(verifyCasList(["64 - 17 - 5"], "Ethanol 64-17-5").ok, ["64-17-5"]);
  assert.deepEqual(verifyCasList(["64-17-5"], "Ethanol 64‑17‑5").ok, ["64-17-5"]);
  assert.equal(verifyCasList(["50-00-0"], "Formaldehyde sold in 150-00-0 packs").ok.length, 0);
});

test("dates: many formats", () => {
  const f = (v, t, o) => (verifyDate(v, t, o) || {}).iso || null;
  assert.equal(f("2023-03-14", "Issue date: 14/03/2023"), "2023-03-14");
  assert.equal(f("2023-03-14", "Issue date: 14 March 2023"), "2023-03-14");
  assert.equal(f("2023-03-14", "Issue date: 14th Mar. 2023"), "2023-03-14");
  assert.equal(f("2023-03-14", "Issue date: March 14, 2023"), "2023-03-14");
  assert.equal(f("2023-03-14", "Issue date: 2023-03-14"), "2023-03-14");
  assert.equal(f("2023-03-14", "Issue date: 14.03.2023"), "2023-03-14");
  assert.equal(f("2023-03-14", "Revision date 14-3-23"), "2023-03-14");
  assert.equal(f("14/03/2023", "Issue date: 14 March 2023"), "2023-03-14", "value in dd/mm/yyyy is parsed too");
  assert.equal(f("2022-03", "Revision date: March 2022"), "2022-03-01");
  assert.equal(verifyDate("2022-03", "Revision date: March 2022").approx, true);
  assert.equal(f("2022-03-01", "Revision date: March 2022"), "2022-03-01");
});
test("dates: unsupported values rejected", () => {
  const f = (v, t, o) => (verifyDate(v, t, o) || {}).iso || null;
  assert.equal(f("2023-03-15", "Issue date: 14 March 2023"), null);
  assert.equal(f("2023-04-03", "Issue date: 04/03/2023"), null, "day-first reading only: 4 March is not 3 April");
  assert.equal(f("2022-03-05", "Revision date: March 2022"), null, "month-only text cannot support a specific day");
  assert.equal(f("2022-03", "Revision date: 12 March 2022"), null);
  assert.equal(f("2023-02-30", "30/02/2023"), null);
  assert.equal(f("garbage", solvent), null);
  assert.equal(f("2019-01-01", solvent), null);
});
test("dates: need a date-ish label nearby (requireLabel)", () => {
  const t = "Manufactured at the plant opened on 5 May 2015.";
  assert.equal((verifyDate("2015-05-05", t, { requireLabel: true }) || {}).iso || null, null);
  assert.equal((verifyDate("2015-05-05", t) || {}).iso, "2015-05-05");
  assert.equal(findDates("12 March 2022").filter(d => d.precision === "month").length, 0, "no month-only entry from a full date");
  assert.equal(parseDateValue("not a date"), null);
});

function goodData(over = {}) {
  const v = validateExtraction({
    sds: { title: "KARRA CLEAN", supplier: "Brightwell Coatings Pty Ltd", issue_date: "2023-03-14", emergency_phone: "1800 555 0142", signal_word: "Danger",
      h_statements: "H225 Highly flammable liquid and vapour; H319 Causes serious eye irritation; H999 Invented hazard",
      p_statements: "P210 Keep away from heat; P305+P351+P338 IF IN EYES: rinse; P999 Invented",
      poison_schedule: "S5", un_number: "UN 1993", dg_class: "3", subsidiary_class: null, packing_group: "PG II", hazchem_code: "•3YE",
      proper_shipping_name: "FLAMMABLE LIQUID, N.O.S.", cas_numbers: ["64-17-5", "67-63-0", "71-43-2"], ...over },
    products: [{ product_name: "KARRA CLEAN Solvent Wash 5L" }], assessment: { risk_level: "significant_controlled" },
  });
  assert.ok(v.ok, JSON.stringify(v.errors));
  return v.data;
}

test("verifyExtraction on the solvent fixture: good values kept, invented values blanked and flagged", () => {
  const out = verifyExtraction(goodData(), solvent);
  const s = out.sds;
  assert.equal(s.un_number, "1993");
  assert.equal(s.packing_group, "II");
  assert.equal(s.hazchem_code, "3YE");
  assert.equal(s.dg_class, "3");
  assert.equal(s.issue_date, "2023-03-14");
  assert.equal(s.review_due, "2028-03-14");
  assert.equal(s.emergency_phone, "1800 555 0142");
  assert.equal(s.proper_shipping_name, "FLAMMABLE LIQUID, N.O.S.");
  assert.deepEqual(s.cas_numbers, ["64-17-5", "67-63-0"]);
  assert.equal(s.poison_schedule, null, "S5 is not in the text (sheet says not scheduled)");
  assert.ok(!/H999/.test(s.h_statements) && /H225/.test(s.h_statements));
  assert.ok(!/P999/.test(s.p_statements) && /P305\+P351\+P338/.test(s.p_statements));
  assert.deepEqual([...out.unverified].sort(), ["cas_numbers", "h_statements", "p_statements", "poison_schedule"]);
});

test("verifyExtraction: hallucinated everything on a non-DG sheet", () => {
  const out = verifyExtraction(goodData({ issue_date: "2024-01-01", emergency_phone: "1800 999 999", signal_word: "Warning" }), fx("sds-paint-nonhaz.txt"));
  const s = out.sds;
  for (const f of ["un_number", "packing_group", "hazchem_code", "dg_class", "issue_date", "emergency_phone", "poison_schedule", "proper_shipping_name"]) assert.equal(s[f], null, f);
  assert.equal(s.review_due, null, "no review date without a verified issue date");
  for (const f of ["un_number", "packing_group", "hazchem_code", "dg_class", "issue_date", "emergency_phone", "signal_word"]) assert.ok(out.unverified.includes(f), f);
  assert.deepEqual(s.cas_numbers, []);
});

test("verifyExtraction: a value the model did not give is not flagged", () => {
  const out = verifyExtraction(goodData({ un_number: null, packing_group: null, hazchem_code: null }), solvent);
  assert.ok(!out.unverified.includes("un_number"));
});

test("prompt injection inside the SDS cannot make invented values verifiable", () => {
  const t = fx("sds-injection.txt");
  const out = verifyExtraction(goodData({
    issue_date: "2020-06-01", emergency_phone: "1800 000 000", cas_numbers: [], un_number: "1993", packing_group: "I", dg_class: "3", hazchem_code: "2WE",
  }), t);
  assert.equal(out.sds.issue_date, "2020-06-01", "the real issue date outside the injected paragraph is still accepted");
  assert.equal(out.sds.emergency_phone, null);
  assert.equal(out.sds.un_number, null);
  assert.equal(out.sds.packing_group, null);
  assert.equal(out.sds.dg_class, null);
  assert.equal(out.sds.hazchem_code, null);
  assert.ok(out.warnings.some(w => /ignored/.test(w)));
  assert.equal(stripInjection("plain text").found, false);
});

test("validateExtraction: good, wrong types, structure, coercion, clamping", () => {
  const ok = validateExtraction({ sds: { title: 123, signal_word: "danger" }, products: [{ product_name: "A" }, { product_name: "a" }],
    classification: [{ class: "flam_liq", category: 2 }, "junk"], assessment: { risk_level: "nonsense", route_inhalation: "yes", monitoring_needed: "no", physical_form: "x" } });
  assert.ok(ok.ok);
  assert.equal(ok.data.sds.title, "123");
  assert.equal(ok.data.sds.pictograms, undefined, "pictograms are not read from the AI");
  assert.equal(ok.data.sds.signal_word, "Danger");
  assert.deepEqual(ok.data.products.map(p => p.product_name), ["A", "a (2)"]);
  assert.equal(ok.data.decision, undefined, "decision is not read from the AI");
  assert.deepEqual(ok.data.classification, [{ class: "flam_liq", category: 2 }], "non-object entries removed; numbers tolerated until normalised");
  assert.equal(validateExtraction({ sds: {}, products: [{ product_name: "A" }] }).data.classification, null, "missing = none usable");
  assert.equal(validateExtraction({ sds: {}, products: [{ product_name: "A" }], classification: "flammable" }).data.classification, null);
  assert.deepEqual(validateExtraction({ sds: {}, products: [{ product_name: "A" }], classification: [] }).data.classification, []);
  assert.equal(ok.data.assessment.risk_level, "uncertain");
  assert.equal(ok.data.assessment.route_inhalation, true);
  assert.equal(ok.data.assessment.monitoring_needed, false);
  assert.equal(validateExtraction({ sds: {}, products: [{ product_name: "A" }] }).data.assessment.risk_level, "uncertain", "omitted risk level defaults to uncertain");
  assert.equal(validateExtraction({ sds: "x", products: [{ product_name: "A" }] }).ok, false);
  assert.equal(validateExtraction({ sds: {}, products: "A" }).ok, false);
  assert.equal(validateExtraction({ sds: {}, products: [] }).ok, false);
  assert.equal(validateExtraction({ sds: {}, products: [{ product_name: "" }] }).ok, false);
  assert.equal(validateExtraction({ sds: { title: { a: 1 } }, products: [{ product_name: "A" }] }).ok, false);
  assert.equal(validateExtraction({ sds: { cas_numbers: { a: 1 } }, products: [{ product_name: "A" }] }).ok, false);
  assert.equal(validateExtraction({ sds: {}, products: [{ product_name: "A" }], assessment: "no" }).ok, false);
  assert.equal(validateExtraction(null).ok, false);
  assert.equal(validateExtraction({ sds: { title: "x".repeat(5000) }, products: [{ product_name: "A" }] }).data.sds.title.length, 300);
  assert.equal(validateExtraction({ sds: { un_number: "N/A", dg_class: "none" }, products: [{ product_name: "A" }] }).data.sds.un_number, null);
});

test("extractJson: fenced, prose around, truncated, already an object", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":{"b":"}"}} hope that helps'), { a: { b: "}" } });
  assert.equal(extractJson('{"a":1, "b": "unfinish'), null);
  assert.equal(extractJson("no json at all"), null);
  assert.deepEqual(extractJson({ a: 1 }), { a: 1 });
  assert.equal(extractJson("[1,2]"), null);
});

test("trimForAi keeps priority sections when over budget", () => {
  const sec = (n, name, fill) => `\nSECTION ${n}: ${name}\n` + fill.repeat(400);
  const text = "SAFETY DATA SHEET Foo\n" + sec(1, "Identification", "id ") + sec(2, "Hazards identification", "hz ") + sec(3, "Composition", "cp ") + sec(4, "First aid", "fa ") +
    sec(5, "Fire fighting", "ff ") + sec(6, "Accidental release", "ar ") + sec(7, "Handling and storage", "hs ") + sec(8, "Exposure controls", "ex ") +
    sec(9, "Physical and chemical", "pc ") + sec(10, "Stability", "st ") + sec(11, "Toxicological", "tx ") + sec(12, "Ecological", "ec ") +
    sec(13, "Disposal", "dp ") + sec(14, "Transport", "tr ") + sec(15, "Regulatory", "rg ") + sec(16, "Other information", "ot ");
  const out = trimForAi(text, 6000);
  assert.ok(out.length <= 6000);
  for (const w of ["Identification", "Hazards identification", "Handling and storage", "Exposure controls", "Transport"]) assert.ok(out.includes(w), w);
  assert.ok(!out.includes("Stability") || out.length <= 6000);
  assert.equal(trimForAi("short", 6000), "short");
  assert.ok(trimForAi("x".repeat(20000), 5000).length <= 5200, "no headings: head and tail");
});

test("matchControlOptions: case-insensitive label match, unmatched goes to notes, nothing invented", () => {
  const options = [
    { id: 1, kind: "ppe", label: "Safety glasses" }, { id: 2, kind: "ppe", label: "Chemical-resistant gloves" },
    { id: 3, kind: "ventilation", label: "Local exhaust ventilation" }, { id: 4, kind: "isolation", label: "Lids kept on containers when not in use" },
  ];
  const r = matchControlOptions({
    isolation: ["lids kept on containers when not in use.", "Bunded tray"], ventilation: ["LOCAL EXHAUST VENTILATION"], other_controls: ["Spill kit available"],
    ppe: ["safety glasses", "Safety glasses", "Hard hat"], additional_ppe: ["Face shield"],
  }, options);
  assert.deepEqual(r.option_ids.sort(), [1, 3, 4]);
  assert.match(r.controls_notes, /Bunded tray/);
  assert.match(r.controls_notes, /Spill kit available/);
  assert.match(r.ppe_notes, /Hard hat/);
  assert.match(r.ppe_notes, /Face shield/);
  // a ppe label offered under the wrong list is not matched
  assert.deepEqual(matchControlOptions({ isolation: ["Safety glasses"] }, options).option_ids, []);
});
