// Migration through the real wrangler path: build a local D1 from the OLD schema (frozen in tests/fixtures/schema-before-places.sql, which still has only
// storage_locations), add chemicals and storage locations, run the NEW schema.sql twice, and check places / links.
// Needs no running server. Slow (several wrangler calls); skips itself if git or wrangler cannot be run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const shell = process.platform === "win32";

function wr(args, dir) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", dir, "--json", ...args], { cwd: ROOT, encoding: "utf8", shell, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  return JSON.parse(out.slice(out.indexOf("[")));
}
let seq = 0;
function sql(text, dir) {
  const f = path.join(os.tmpdir(), `sdsezy-mig-${process.pid}-${seq++}.sql`);
  fs.writeFileSync(f, text);
  try { return wr(["--file", f], dir); } finally { fs.rmSync(f, { force: true }); }
}
const rows = (res) => res[res.length - 1].results;

test("old database migrates to places and the migration is repeatable", { timeout: 600000 }, (t) => {
  // The schema as it was before places existed, frozen from the commit that preceded them (so this test does not depend on git history).
  const oldSchema = fs.readFileSync(path.join(ROOT, "tests", "fixtures", "schema-before-places.sql"), "utf8");
  assert.ok(/storage_locations/.test(oldSchema) && !/CREATE TABLE IF NOT EXISTS places/.test(oldSchema), "the fixture must be the pre-places schema");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdsezy-mig-"));
  const oldFile = path.join(tmp, "old.sql");
  fs.writeFileSync(oldFile, oldSchema);
  const dir = path.join(ROOT, ".wrangler", "migration-test");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    wr(["--file", oldFile], dir);
    sql(`INSERT INTO chemicals (id, product_name) VALUES (1, 'Acetone'), (2, 'Paint'), (3, 'Bleach');
      INSERT INTO storage_locations (chemical_id, location, quantity, unit, container_note, spill_compound) VALUES
        (1, 'Workshop', 20, 'L', '4 x 5 L', 'Bund A'), (1, ' workshop ', 5, 'L', '1 x 5 L', NULL), (1, 'Yard', 10, 'L', NULL, NULL),
        (2, 'Workshop', 3, 'kg', NULL, NULL), (3, 'Yard', 2, 'L', NULL, NULL);`, dir);
    const newSchema = path.join(ROOT, "schema.sql");
    wr(["--file", newSchema], dir);
    const check = () => ({
      places: rows(sql("SELECT name, place_type, counts_toward_totals, archived, chemical_count FROM places ORDER BY name", dir)),
      links: rows(sql("SELECT cp.chemical_id, p.name, cp.quantity, cp.unit, cp.container_note, cp.spill_compound FROM chemical_places cp JOIN places p ON p.id = cp.place_id ORDER BY cp.chemical_id, p.name", dir)),
      legacy: rows(sql("SELECT COUNT(*) AS n FROM storage_locations", dir))[0].n,
    });
    const first = check();
    assert.deepEqual(first.places.map(p => [p.name, p.place_type, p.counts_toward_totals, p.chemical_count]), [["Workshop", "workshop", 1, 2], ["Yard", "workshop", 1, 2]]);
    assert.equal(first.links.length, 4);
    const acetone = first.links.find(l => l.chemical_id === 1 && l.name === "Workshop");
    assert.equal(acetone.quantity, 25);
    assert.equal(acetone.unit, "L");
    assert.equal(acetone.spill_compound, "Bund A");
    assert.equal(first.legacy, 0);
    wr(["--file", newSchema], dir); // second run: nothing changes
    assert.deepEqual(check(), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
