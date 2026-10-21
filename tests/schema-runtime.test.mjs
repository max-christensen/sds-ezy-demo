// The Worker sets up its own database: schema.sql is split into statements at build time and applied on first run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { splitSql, schemaHash, render } from "../scripts/build-schema.mjs";
import { SCHEMA_STATEMENTS, SCHEMA_HASH } from "../src/schema.generated.js";
import { applySchema, schemaIsCurrent, ensureSchema, resetSchemaMemo } from "../src/schema.js";

const sql = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// A D1-shaped wrapper over node:sqlite.
function fakeD1(raw = new DatabaseSync(":memory:")) {
  const calls = { batches: 0 };
  const stmt = (s, args = []) => ({
    bind: (...a) => stmt(s, a),
    run: async () => { raw.prepare(s).run(...args); return {}; },
    first: async () => raw.prepare(s).get(...args) ?? null,
    _exec: () => raw.prepare(s).run(...args),
  });
  return { raw, calls, prepare: (s) => stmt(s), batch: async (list) => { calls.batches++; raw.exec("BEGIN"); try { list.forEach((x) => x._exec()); raw.exec("COMMIT"); } catch (e) { raw.exec("ROLLBACK"); throw e; } } };
}
const objects = (raw) => raw.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => r.type + ":" + r.name);

test("the splitter keeps semicolons and comment markers inside quoted strings", () => {
  const out = splitSql("-- c;\nINSERT INTO t VALUES ('a; b -- c', 'it''s;');\nSELECT 1; -- tail\n");
  assert.deepEqual(out, ["INSERT INTO t VALUES ('a; b -- c', 'it''s;')", "SELECT 1"]);
  assert.throws(() => splitSql("SELECT 'x"));
});

test("schema.sql has no triggers (the splitter does not handle BEGIN ... END)", () => {
  assert.ok(!/\bCREATE\s+TRIGGER\b/i.test(sql));
});

test("src/schema.generated.js is current (run: node scripts/build-schema.mjs)", () => {
  assert.equal(fs.readFileSync(new URL("../src/schema.generated.js", import.meta.url), "utf8").replace(/\r\n/g, "\n"), render(sql));
  assert.equal(SCHEMA_HASH, schemaHash(sql));
  execFileSync(process.execPath, ["scripts/build-schema.mjs", "--check"], { stdio: "pipe" });
});

test("the generated statements build the same database as the whole file", () => {
  const whole = new DatabaseSync(":memory:"); whole.exec(sql);
  const split = new DatabaseSync(":memory:"); for (const s of SCHEMA_STATEMENTS) split.exec(s);
  assert.deepEqual(objects(split), objects(whole));
  const rows = (d) => d.prepare("SELECT * FROM sqlite_master WHERE type='table'").all().map((r) => r.name).flatMap((n) => d.prepare(`SELECT * FROM "${n}"`).all().map((r) => n + JSON.stringify(r)));
  assert.deepEqual(rows(split), rows(whole), "seed rows match");
});

test("a fresh empty database is set up on first use, and a second run does nothing", async () => {
  resetSchemaMemo();
  const db = fakeD1();
  assert.equal(await schemaIsCurrent(db, SCHEMA_HASH), false);
  await ensureSchema({ DB: db });
  assert.equal(await schemaIsCurrent(db), true);
  assert.ok(objects(db.raw).includes("table:chemicals"));
  const after = db.calls.batches;
  resetSchemaMemo();
  await ensureSchema({ DB: db });
  assert.equal(db.calls.batches, after, "already current: no statements run");
});

test("a changed schema hash re-applies safely and keeps existing data", async () => {
  const db = fakeD1();
  await applySchema(db.raw && db);
  db.raw.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('A','a@x.invalid','h','admin')").run();
  assert.equal(await schemaIsCurrent(db, "different"), false);
  await applySchema(db, SCHEMA_STATEMENTS, "different");
  assert.equal(await schemaIsCurrent(db, "different"), true);
  assert.equal(db.raw.prepare("SELECT count(*) c FROM users").get().c, 1);
});

test("a failure is reported and retried on the next request", async () => {
  resetSchemaMemo();
  const bad = { prepare: () => { throw new Error("no such database"); } };
  await assert.rejects(ensureSchema({ DB: bad }));
  const db = fakeD1();
  await ensureSchema({ DB: db });
  assert.equal(await schemaIsCurrent(db), true);
});
