// Placard and manifest totals PER PLACE: a vehicle does not count, places are never added together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlaceTotals, PLACE_TYPES, defaultCountsTowardTotals, VEHICLE_TRANSPORT_NOTE, NEAR_FRACTION } from "../public/lib/ghs-ref.mjs";

const c = (cls, k, extra = {}) => ({ c: cls, k, ...extra });
const place = (id, name, type = "workshop", counts = type !== "vehicle", extra = {}) => ({ id, name, place_type: type, counts_toward_totals: counts ? 1 : 0, archived: 0, ...extra });
const link = (id, placeId, name, classification, quantity, unit = "L", extra = {}) => ({ id, place_id: placeId, chemical_id: id, name, classification, quantity, unit, ...extra });
const byId = (res, id) => res.find(r => r.place.id === id);
const item = (totals, n) => totals.items.find(i => i.item === n);

test("place types: workshop/depot and site count by default, vehicle does not", () => {
  assert.deepEqual(PLACE_TYPES.map(p => p.id), ["workshop", "vehicle", "site"]);
  assert.equal(defaultCountsTowardTotals("workshop"), true);
  assert.equal(defaultCountsTowardTotals("site"), true);
  assert.equal(defaultCountsTowardTotals("vehicle"), false);
});

test("totals are per place, never across the business: 200 L in each of two workshops is not 400 L", () => {
  const places = [place(1, "Workshop A"), place(2, "Workshop B")];
  const entries = [link(1, 1, "Thinner", [c("flam_liq", "2")], 200), link(2, 2, "Thinner", [c("flam_liq", "2")], 200)];
  const r = computePlaceTotals(places, entries);
  assert.equal(item(byId(r, 1).totals, 7).total, 200);
  assert.equal(item(byId(r, 2).totals, 7).total, 200);
  assert.deepEqual(byId(r, 1).over.placard, []);
  assert.deepEqual(byId(r, 2).over.placard, []);
});

test("the same chemicals in ONE place do add up and go over the placard quantity", () => {
  const r = computePlaceTotals([place(1, "Workshop A")], [link(1, 1, "T1", [c("flam_liq", "2")], 200), link(2, 1, "T2", [c("flam_liq", "2")], 100)]);
  assert.equal(item(r[0].totals, 7).total, 300);
  assert.deepEqual(r[0].over.placard, [7]);
});

test("a vehicle does not count: no totals, the transport note, even with a lot of flammable liquid in it", () => {
  const r = computePlaceTotals([place(3, "Ute 2", "vehicle")], [link(1, 3, "Thinner", [c("flam_liq", "1")], 500)]);
  assert.equal(r[0].counts, false);
  assert.equal(r[0].totals, null);
  assert.deepEqual(r[0].over, { placard: [], manifest: [] });
  assert.equal(r[0].note, VEHICLE_TRANSPORT_NOTE);
  assert.match(r[0].note, /transport rules/);
  assert.match(r[0].caveat, /not been confirmed/);
});

test("the vehicle's chemicals do not leak into a workshop's totals", () => {
  const places = [place(1, "Workshop"), place(3, "Ute 2", "vehicle")];
  const r = computePlaceTotals(places, [link(1, 1, "A", [c("flam_liq", "2")], 100), link(2, 3, "A", [c("flam_liq", "2")], 100)]);
  assert.equal(item(byId(r, 1).totals, 7).total, 100);
});

test("a vehicle can be switched on to count, and a workshop can be switched off", () => {
  const places = [place(3, "Ute 2", "vehicle", true), place(1, "Old depot", "workshop", false)];
  const r = computePlaceTotals(places, [link(1, 3, "A", [c("flam_liq", "2")], 260), link(2, 1, "B", [c("flam_liq", "2")], 900)]);
  assert.equal(byId(r, 3).counts, true);
  assert.deepEqual(byId(r, 3).over.placard, [7]);
  assert.equal(byId(r, 1).counts, false);
  assert.equal(byId(r, 1).note, "This place is set not to count towards the placard and manifest totals.");
});

test("an archived place is not totalled", () => {
  const r = computePlaceTotals([place(1, "Gone", "workshop", true, { archived: 1 })], [link(1, 1, "A", [c("flam_liq", "1")], 900)]);
  assert.equal(r[0].counts, false);
  assert.equal(r[0].totals, null);
});

test("the spill compound rule works inside one place and not across places", () => {
  const places = [place(1, "Workshop"), place(2, "Depot")];
  const entries = [
    link(1, 1, "Cat 3", [c("flam_liq", "3")], 100), link(2, 1, "Cat 4 oil", [c("flam_liq", "4")], 50),
    link(3, 2, "Cat 4 oil", [c("flam_liq", "4")], 70),
  ];
  const r = computePlaceTotals(places, entries);
  assert.equal(item(byId(r, 1).totals, 8).total, 150);
  assert.equal(item(byId(r, 1).totals, 10).total, 0);
  assert.equal(item(byId(r, 2).totals, 10).total, 70);   // a different place: no category 3 liquid there
});

test("two links in the same place with different spill compound names stay separate compounds", () => {
  const r = computePlaceTotals([place(1, "Workshop")], [
    link(1, 1, "Cat 3", [c("flam_liq", "3")], 100, "L", { spill_compound: "North bund" }),
    link(2, 1, "Cat 4 oil", [c("flam_liq", "4")], 50, "L", { spill_compound: "South bund" }),
  ]);
  assert.equal(item(r[0].totals, 8).total, 100);
  assert.equal(item(r[0].totals, 10).total, 50);
});

test("near the placard quantity: 80% or more but not over; exactly at the quantity is near, not over", () => {
  assert.equal(NEAR_FRACTION, 0.8);
  const near = computePlaceTotals([place(1, "W")], [link(1, 1, "A", [c("flam_liq", "2")], 230)]);
  assert.equal(item(near[0].totals, 7).placardNear, true);
  assert.equal(item(near[0].totals, 7).placardOver, false);
  assert.deepEqual(near[0].near.placard, [7]);
  const low = computePlaceTotals([place(1, "W")], [link(1, 1, "A", [c("flam_liq", "2")], 150)]);
  assert.equal(item(low[0].totals, 7).placardNear, false);
  const at = computePlaceTotals([place(1, "W")], [link(1, 1, "A", [c("flam_liq", "2")], 250)]);
  assert.equal(item(at[0].totals, 7).placardNear, true);
  assert.equal(item(at[0].totals, 7).placardOver, false);
  const over = computePlaceTotals([place(1, "W")], [link(1, 1, "A", [c("flam_liq", "2")], 251)]);
  assert.equal(item(over[0].totals, 7).placardNear, false);
  assert.equal(item(over[0].totals, 7).placardOver, true);
});

test("a hazardous chemical in a counting place with no quantity recorded is reported, not silently left out", () => {
  const r = computePlaceTotals([place(1, "W")], [link(1, 1, "Thinner", [c("flam_liq", "2")], null, null), link(2, 1, "Water-based paint", [], null, null)]);
  assert.ok(r[0].totals.issues.some(i => i.code === "no_quantity" && i.chemical_id === 1));
  assert.ok(!r[0].totals.issues.some(i => i.chemical_id === 2));   // nothing to count: no issue
});

test("a place with no chemicals has all 43 items at zero", () => {
  const r = computePlaceTotals([place(1, "Empty")], []);
  assert.equal(r[0].totals.items.length, 43);
  assert.deepEqual(r[0].over, { placard: [], manifest: [] });
});
