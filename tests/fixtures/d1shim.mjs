// Tiny D1 stand-in over node:sqlite for tests (real SQL, real schema.sql). Not a test file.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("../../schema.sql", import.meta.url));

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p.map(v => (v === undefined ? null : v))); }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }
  async first() { const r = this.db.prepare(this.sql).get(...this.params); return r ? { ...r } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params).map(r => ({ ...r })), meta: {} }; }
  _sync() {
    const st = this.db.prepare(this.sql);
    if (/^\s*(select|with)/i.test(this.sql)) return { results: st.all(...this.params).map(r => ({ ...r })), meta: {} };
    const r = st.run(...this.params);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(readFileSync(schemaPath, "utf8"));
  return {
    raw,
    prepare: (sql) => new Stmt(raw, sql),
    async batch(stmts) {
      raw.exec("BEGIN");
      try { const out = stmts.map(s => s._sync()); raw.exec("COMMIT"); return out; }
      catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
}

export function makeR2() {
  const store = new Map();
  return {
    store,
    async put(key, body) { store.set(key, body); },
    async get(key) { return store.has(key) ? { body: store.get(key) } : null; },
    async delete(key) { for (const k of Array.isArray(key) ? key : [key]) store.delete(k); }, // real R2 accepts one key or an array
  };
}

export function makeEnv(extra = {}) {
  return { DB: makeDb(), FILES: makeR2(), SESSION_SECRET: "test-session-secret-value-1234567890", AI_RETRY_DELAY_MS: 1, ...extra };
}
