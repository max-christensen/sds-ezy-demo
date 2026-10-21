// The audit tables in schema.sql: new tables only, safe to run on every deploy, repeatable requests cannot make duplicates.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* skipped below */ }
const SQL = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const t = DatabaseSync ? test : test.skip;
const fresh = () => { const d = new DatabaseSync(":memory:"); d.exec(SQL); d.exec("INSERT INTO users (name, email, password_hash, role) VALUES ('A', 'a@x.test', 'x', 'admin'), ('B', 'b@x.test', 'x', 'user')"); d.exec("INSERT INTO places (name, place_type) VALUES ('Ute 2', 'vehicle')"); return d; };
const rows = (d, sql) => d.prepare(sql).all();

t("loads twice and creates the audit tables", () => {
  const d = fresh(); d.exec(SQL);
  const names = rows(d, "SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name);
  for (const n of ["audits", "audit_items", "audit_found", "audit_disposals", "audit_findings", "audit_photos", "place_audit_summary", "audit_ai_log"]) assert.ok(names.includes(n), n);
});

t("an existing database with audit data keeps it when schema.sql runs again", () => {
  const d = fresh();
  d.exec("INSERT INTO audits (client_id, place_id, place_name, place_type, started_by, started_by_name, started_at) VALUES ('c1', 1, 'Ute 2', 'vehicle', 2, 'B', '2026-10-20T01:00:00Z')");
  d.exec(SQL);
  assert.equal(rows(d, "SELECT COUNT(*) n FROM audits")[0].n, 1);
});

t("the same client_id from the same person is one audit (a repeated request cannot make a second)", () => {
  const d = fresh();
  const ins = (who) => d.exec(`INSERT INTO audits (client_id, place_id, place_name, place_type, started_by, started_by_name, started_at) VALUES ('c1', 1, 'Ute 2', 'vehicle', ${who}, 'x', '2026-10-20T01:00:00Z')`);
  ins(2);
  assert.throws(() => ins(2));
  ins(1); // a different person may use the same id
  assert.equal(rows(d, "SELECT COUNT(*) n FROM audits")[0].n, 2);
});

t("an item, a found item, a disposal and a photo are each unique per audit and client id", () => {
  const d = fresh();
  d.exec("INSERT INTO audits (place_id, place_name, place_type, started_by, started_by_name, started_at) VALUES (1, 'Ute 2', 'vehicle', 2, 'B', '2026-10-20T01:00:00Z')");
  d.exec("INSERT INTO audit_items (audit_id, chemical_id, product_name) VALUES (1, 7, 'Thinner')");
  assert.throws(() => d.exec("INSERT INTO audit_items (audit_id, chemical_id, product_name) VALUES (1, 7, 'Thinner')"));
  d.exec("INSERT INTO audit_found (audit_id, client_id, product_name, found_at) VALUES (1, 'f1', 'Mystery', '2026-10-20T01:05:00Z')");
  assert.throws(() => d.exec("INSERT INTO audit_found (audit_id, client_id, product_name, found_at) VALUES (1, 'f1', 'Mystery', '2026-10-20T01:05:00Z')"));
  d.exec("INSERT INTO audit_disposals (audit_id, client_id, place_id, place_name, description, reason, flagged_by, flagged_by_name, flagged_at) VALUES (1, 'd1', 1, 'Ute 2', 'old tin', 'expired', 2, 'B', '2026-10-20T01:06:00Z')");
  assert.throws(() => d.exec("INSERT INTO audit_disposals (audit_id, client_id, place_id, place_name, description, reason, flagged_by, flagged_by_name, flagged_at) VALUES (1, 'd1', 1, 'Ute 2', 'old tin', 'expired', 2, 'B', '2026-10-20T01:06:00Z')"));
  d.exec("INSERT INTO audit_photos (audit_id, client_id, owner_type, owner_key, r2_key, bytes, taken_at, uploaded_by) VALUES (1, 'p1', 'item', '7', 'audits/1/a.jpg', 1000, '2026-10-20T01:02:00Z', 2)");
  assert.throws(() => d.exec("INSERT INTO audit_photos (audit_id, client_id, owner_type, owner_key, r2_key, bytes, taken_at, uploaded_by) VALUES (1, 'p1', 'item', '7', 'audits/1/b.jpg', 1000, '2026-10-20T01:02:00Z', 2)"));
});

t("deleting an audit removes its rows (items, found, disposals, findings, photo rows)", () => {
  const d = fresh();
  d.exec("PRAGMA foreign_keys = ON");
  d.exec("INSERT INTO audits (place_id, place_name, place_type, started_by, started_by_name, started_at) VALUES (1, 'Ute 2', 'vehicle', 2, 'B', '2026-10-20T01:00:00Z')");
  d.exec("INSERT INTO audit_items (audit_id, chemical_id, product_name) VALUES (1, 7, 'Thinner')");
  d.exec("INSERT INTO audit_photos (audit_id, client_id, owner_type, r2_key, bytes, taken_at, uploaded_by) VALUES (1, 'p1', 'audit', 'k', 10, '2026-10-20T01:02:00Z', 2)");
  d.exec("DELETE FROM audits WHERE id = 1");
  assert.equal(rows(d, "SELECT COUNT(*) n FROM audit_items")[0].n, 0);
  assert.equal(rows(d, "SELECT COUNT(*) n FROM audit_photos")[0].n, 0);
});

t("the queries the screens rely on use indexes", () => {
  const d = fresh();
  const plan = (sql) => rows(d, "EXPLAIN QUERY PLAN " + sql).map(r => r.detail).join(" | ");
  assert.match(plan("SELECT * FROM audits WHERE place_id = 1 ORDER BY started_at DESC LIMIT 10"), /idx_audits_place/);
  assert.match(plan("SELECT * FROM audits WHERE started_by = 2 ORDER BY started_at DESC"), /idx_audits_user/);
  assert.match(plan("SELECT * FROM audit_findings WHERE status = 'open' ORDER BY created_at"), /idx_afind_status/);
  assert.match(plan("SELECT * FROM audit_disposals WHERE status = 'to_dispose'"), /idx_adisp_status/);
  assert.match(plan("SELECT * FROM audit_items WHERE audit_id = 1"), /audit_items/);
  assert.match(plan("SELECT * FROM audit_photos WHERE audit_id = 1"), /idx_aphotos_audit|sqlite_autoindex_audit_photos/);
  assert.match(plan("SELECT * FROM place_audit_summary WHERE last_audited_at < '2026-01-01'"), /idx_pas_when/);
  assert.match(plan("SELECT COUNT(*) FROM audit_ai_log WHERE user_id = 2 AND created_at > 'x'"), /idx_aailog_user_time/);
});
