// Creates or updates the database tables the first time the Worker runs after a deploy, so a brand-new one-click deploy
// needs no build-time database step. The statements come from schema.sql (see scripts/build-schema.mjs) and are all
// "IF NOT EXISTS" / "INSERT OR IGNORE", so running them twice, or from two requests at once, is harmless.
import { SCHEMA_HASH, SCHEMA_STATEMENTS } from "./schema.generated.js";

const CHUNK = 25;
let ready = null; // per isolate: the check runs once, then every request skips it

export async function applySchema(db, statements = SCHEMA_STATEMENTS, hash = SCHEMA_HASH) {
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK).map((s) => db.prepare(s)));
  }
  await db.prepare("INSERT INTO settings (key, value) VALUES ('schema_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(hash).run();
}

export async function schemaIsCurrent(db, hash = SCHEMA_HASH) {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'schema_hash'").first();
    return !!row && row.value === hash;
  } catch {
    return false; // no settings table yet: a fresh database
  }
}

export function ensureSchema(env) {
  if (!ready) {
    ready = (async () => {
      if (!(await schemaIsCurrent(env.DB))) await applySchema(env.DB);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export function resetSchemaMemo() { ready = null; }
