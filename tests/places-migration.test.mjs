// The places migration in schema.sql: storage_locations -> places / chemical_places, safe to run on every deploy.
// Uses Node's built-in SQLite (Node 22.13 or newer) with the real schema.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* skipped below */ }
const SQL = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const t = DatabaseSync ? test : test.skip;
const fresh = () => { const d = new DatabaseSync(":memory:"); d.exec(SQL); return d; };
const all = (d, sql) => d.prepare(sql).all();

t("a fresh database loads schema.sql twice with no places", () => {
  const d = fresh();
  d.exec(SQL);
  assert.equal(all(d, "SELECT COUNT(*) n FROM places")[0].n, 0);
  assert.equal(all(d, "SELECT COUNT(*) n FROM chemical_places")[0].n, 0);
});

function withLegacy() {
  const d = fresh();
  d.exec("INSERT INTO chemicals (product_name) VALUES ('Thinner'), ('Cement')");
  d.exec(`INSERT INTO storage_locations (chemical_id, location, quantity, unit, container_note, spill_compound) VALUES
    (1, 'Paint store', 10, 'L', '2 tins', 'Bund 1'),
    (1, 'paint store ', 5, 'L', '1 tin', NULL),
    (1, 'Yard shed', 3, 'kg', NULL, NULL),
    (2, 'Paint store', 7, 'L', NULL, NULL),
    (2, 'Plaster store', 40, 'kg', '2 bags', NULL)`);
  d.exec(SQL); // the deploy
  return d;
}

t("existing storage locations become places and links", () => {
  const d = withLegacy();
  const places = all(d, "SELECT name, place_type, counts_toward_totals AS counts, archived, chemical_count AS n FROM places ORDER BY id");
  assert.deepEqual(places.map(p => p.name), ["Paint store", "Plaster store", "Yard shed"]);
  for (const p of places) { assert.equal(p.place_type, "workshop"); assert.equal(p.counts, 1); assert.equal(p.archived, 0); }
  assert.deepEqual(places.map(p => p.n), [2, 1, 1]);
  const links = all(d, "SELECT c.product_name AS chem, p.name AS place, l.quantity, l.unit, l.container_note, l.spill_compound FROM chemical_places l JOIN chemicals c ON c.id = l.chemical_id JOIN places p ON p.id = l.place_id ORDER BY l.id");
  const paint = links.find(l => l.chem === "Thinner" && l.place === "Paint store");
  assert.equal(paint.quantity, 15);          // the two spellings of the same location are one place, quantities added
  assert.equal(paint.unit, "L");
  assert.equal(paint.spill_compound, "Bund 1");
  assert.match(paint.container_note, /2 tins/);
  assert.match(paint.container_note, /1 tin/);
  assert.equal(links.find(l => l.chem === "Thinner" && l.place === "Yard shed").unit, "kg");
  assert.equal(links.length, 4);
});

t("the legacy rows are emptied once copied", () => {
  const d = withLegacy();
  assert.equal(all(d, "SELECT COUNT(*) n FROM storage_locations")[0].n, 0);
});

t("running schema.sql again changes nothing (every deploy)", () => {
  const d = withLegacy();
  const snap = () => JSON.stringify([all(d, "SELECT * FROM places ORDER BY id"), all(d, "SELECT * FROM chemical_places ORDER BY id")]);
  const before = snap();
  d.exec(SQL); d.exec(SQL);
  assert.equal(snap(), before);
});

t("a link someone deleted after the migration is not brought back by the next deploy", () => {
  const d = withLegacy();
  d.exec("DELETE FROM chemical_places WHERE chemical_id = 2");
  d.exec(SQL);
  assert.equal(all(d, "SELECT COUNT(*) n FROM chemical_places WHERE chemical_id = 2")[0].n, 0);
});

t("an archived place is not recreated or un-archived by a deploy", () => {
  const d = withLegacy();
  d.exec("UPDATE places SET archived = 1 WHERE name = 'Yard shed'");
  d.exec(SQL);
  assert.equal(all(d, "SELECT archived FROM places WHERE name = 'Yard shed'")[0].archived, 1);
  assert.equal(all(d, "SELECT COUNT(*) n FROM places")[0].n, 3);
});

t("a blank legacy location cannot be turned into a place and is left alone", () => {
  const d = fresh();
  d.exec("INSERT INTO chemicals (product_name) VALUES ('X')");
  d.exec("INSERT INTO storage_locations (chemical_id, location, quantity, unit) VALUES (1, '  ', 5, 'L')");
  d.exec(SQL);
  assert.equal(all(d, "SELECT COUNT(*) n FROM places")[0].n, 0);
  assert.equal(all(d, "SELECT COUNT(*) n FROM storage_locations")[0].n, 1);
});

t("a place and a link are unique per chemical and place", () => {
  const d = fresh();
  d.exec("INSERT INTO chemicals (product_name) VALUES ('X')");
  d.exec("INSERT INTO places (name, place_type) VALUES ('Ute 2', 'vehicle')");
  d.exec("INSERT INTO chemical_places (chemical_id, place_id, quantity, unit) VALUES (1, 1, 5, 'L')");
  assert.throws(() => d.exec("INSERT INTO chemical_places (chemical_id, place_id, quantity, unit) VALUES (1, 1, 2, 'L')"));
});

t("the indexes the place screens rely on exist", () => {
  const d = fresh();
  const idx = all(d, "SELECT name FROM sqlite_master WHERE type = 'index'").map(r => r.name);
  assert.ok(idx.includes("idx_cp_place"));
  assert.ok(idx.includes("idx_places_list"));
  const plan = all(d, "EXPLAIN QUERY PLAN SELECT * FROM chemical_places WHERE place_id = 1").map(r => r.detail).join(" ");
  assert.match(plan, /idx_cp_place/);
});
