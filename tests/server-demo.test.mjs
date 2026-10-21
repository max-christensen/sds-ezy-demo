// Demo-mode tests: run against a dev server started with DEMO_MODE=1 (default http://127.0.0.1:8802):
//   (copy a seeded database, e.g. xcopy .wrangler\agent-server .wrangler\agent-server-demo /E /I)
//   npx wrangler dev --local --port 8802 --persist-to .wrangler/agent-server-demo --var DEMO_MODE:1 --var DEMO_ADMIN_EMAIL:admin@test.example --var DEMO_USER_EMAIL:user@test.example
// The users are the ones server-main.test.mjs creates. The suite skips itself when nothing is listening there.
import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.SDS_DEMO_BASE || "http://127.0.0.1:8802";
let alive = false;

async function session(email, password) {
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return { status: r.status, cookie };
}
const call = (cookie, method, path, body) => fetch(BASE + path, {
  method, headers: { ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }), Cookie: cookie },
  body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
});

before(async () => {
  try { alive = (await fetch(BASE + "/api/public-settings")).ok; } catch { alive = false; }
  if (!alive) console.log(`SKIPPED: no demo server at ${BASE}. See the top of this file.`);
});
const T = (name, fn) => test(name, async (t) => { if (!alive) return t.skip(`no demo server at ${BASE}`); await fn(t); });

T("demo flag and demo logins are public", async () => {
  const d = await (await fetch(BASE + "/api/public-settings")).json();
  assert.equal(d.demo, true);
  assert.deepEqual(d.demo_logins.map(x => x.role).sort(), ["admin", "user"]);
});

T("demo mode blocks every write for admin and user, reads still work", async () => {
  for (const [email, password] of [["admin@test.example", "correct-horse-1"], ["user@test.example", "battery-staple-2"]]) {
    const s = await session(email, password);
    assert.equal(s.status, 200, `${email} login`);
    for (const p of ["/api/review", "/api/chemicals", "/api/manifest", "/api/options", "/api/places", "/api/pack?ids=1", "/api/audits"]) {
      assert.equal((await call(s.cookie, "GET", p)).status, 200, p);
    }
    const fd = new FormData();
    fd.append("file", new Blob(["%PDF-1.4 x"], { type: "application/pdf" }), "a.pdf");
    const writes = [
      ["POST", "/api/chemicals", { product_name: "x" }], ["PUT", "/api/chemicals/1", { product_name: "x" }], ["DELETE", "/api/chemicals/1"],
      ["PUT", "/api/settings", { company_name: "x" }], ["POST", "/api/users", { name: "x", email: "x@x.co", password: "12345678" }],
      ["POST", "/api/import", { rows: [] }], ["POST", "/api/options", { kind: "other", label: "x" }],
      ["POST", "/api/uploads/precheck", {}], ["POST", "/api/uploads", fd], ["POST", "/api/sds", {}], ["POST", "/api/setup", {}],
      ["PUT", "/api/settings/ai", {}],
      ["POST", "/api/audits", { place_id: 1, client_id: "demo-client-0001" }], ["PUT", "/api/audits/1/items/1", { result: "present" }],
      ["POST", "/api/audits/1/finish", {}], ["POST", "/api/audits/1/found", { client_id: "demo-client-0002", product_name: "x", action: "record" }],
      ["POST", "/api/audits/1/disposals", { client_id: "demo-client-0003", description: "x", reason: "unknown" }], ["POST", "/api/audits/1/photos", {}],
      ["POST", "/api/findings/1/accept"], ["PUT", "/api/disposals/1/close", { close_note: "x" }],
      ["POST", "/api/places", { name: "x" }], ["PUT", "/api/places/1", { name: "y" }], ["POST", "/api/places/1/chemicals", { chemical_id: 1 }],
      ["POST", "/api/chemicals/1/places", { place_id: 1 }], ["PUT", "/api/chemical-places/1", { quantity: 1, unit: "L" }], ["DELETE", "/api/chemical-places/1"],
    ];
    for (const [m, p, b] of writes) {
      const r = await call(s.cookie, m, p, b);
      assert.equal(r.status, 403, `${email} ${m} ${p}`);
      const j = await r.json();
      assert.match(j.error, /read-only demo/i);
    }
    assert.equal((await call(s.cookie, "POST", "/api/logout", {})).status, 200);
  }
  // logged-out writes are also refused with the demo message (not 401)
  const r = await call("", "POST", "/api/chemicals", { product_name: "x" });
  assert.equal(r.status, 403);
});
