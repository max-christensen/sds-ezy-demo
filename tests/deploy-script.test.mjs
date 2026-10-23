// scripts/deploy.mjs: wrangler deploy, retried only for the "D1 database not found" upload error, with a diagnosis in the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, isD1NotFound, d1Settings, diagnose } from "../scripts/deploy.mjs";

const NOT_FOUND = "✘ [ERROR] A request to the Cloudflare API failed.\n  D1 binding 'DB' references database '9ddb11c1-aaaa-bbbb-cccc-000000000001' which was not found. Verify the database exists [code: 10181]";
const TOML = `name = "x"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "my-db"\ndatabase_id = "9ddb11c1-aaaa-bbbb-cccc-000000000001"\n\n[[r2_buckets]]\nbinding = "FILES"\nbucket_name = "b"\n`;

function harness(results, list) {
  const calls = []; const out = []; const sleeps = [];
  const exec = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "d1") return list ?? { code: 1, out: "Error: no permission" };
    return results.shift() ?? { code: 0, out: "ok" };
  };
  return { calls, out, sleeps, opts: { exec, log: (m) => out.push(m), sleep: async (s) => { sleeps.push(s); }, tomlText: TOML, delays: [1, 2, 3] } };
}

test("recognises the two D1 not-found errors, and nothing else", () => {
  assert.ok(isD1NotFound(NOT_FOUND));
  assert.ok(isD1NotFound("The database ab4ef602-121d could not be found [code: 7404]"));
  assert.ok(!isD1NotFound("Error: Authentication error [code: 10000]"));
  assert.ok(!isD1NotFound("Build failed: syntax error"));
});

test("reads the DB binding's name and id from wrangler.toml", () => {
  assert.deepEqual(d1Settings(TOML), { name: "my-db", id: "9ddb11c1-aaaa-bbbb-cccc-000000000001" });
  assert.equal(d1Settings('name = "x"'), null);
});

test("a deploy that works runs once", async () => {
  const h = harness([{ code: 0, out: "deployed" }]);
  assert.equal(await run(h.opts), 0);
  assert.deepEqual(h.calls, ["deploy"]);
});

test("any other failure stops at once with wrangler's exit code and no retry", async () => {
  const h = harness([{ code: 3, out: "Error: Authentication error [code: 10000]" }]);
  assert.equal(await run(h.opts), 3);
  assert.deepEqual(h.calls, ["deploy"]);
  assert.deepEqual(h.sleeps, []);
});

test("a database that is not visible yet is retried and the deploy then succeeds", async () => {
  const h = harness([{ code: 1, out: NOT_FOUND }, { code: 1, out: NOT_FOUND }, { code: 0, out: "deployed" }],
    { code: 0, out: JSON.stringify([{ name: "my-db", uuid: "9ddb11c1-aaaa-bbbb-cccc-000000000001" }]) });
  assert.equal(await run(h.opts), 0);
  assert.deepEqual(h.sleeps, [1, 2]);
  assert.equal(h.calls.filter((c) => c === "deploy").length, 3);
  assert.equal(h.calls.filter((c) => c.startsWith("d1")).length, 1, "the account is listed once");
  assert.match(h.out.join("\n"), /DOES have that database/);
});

test("when the database never appears it gives up, says so, and tells the deployer what to do", async () => {
  const h = harness([1, 2, 3, 4, 5].map(() => ({ code: 1, out: NOT_FOUND })), { code: 0, out: JSON.stringify([{ name: "other", uuid: "u" }]) });
  assert.equal(await run(h.opts), 1);
  assert.equal(h.calls.filter((c) => c === "deploy").length, 4, "one try plus three retries");
  const text = h.out.join("\n");
  assert.match(text, /NO such database/);
  assert.match(text, /Use existing/);
});

test("the diagnosis tells a wrong id, a missing database and an unlistable account apart", () => {
  const cfg = { name: "my-db", id: "A" };
  assert.match(diagnose(cfg, { ok: true, databases: [{ name: "my-db", uuid: "B" }] }), /DIFFERENT id \(B\)/);
  assert.match(diagnose(cfg, { ok: true, databases: [] }), /NO such database/);
  assert.match(diagnose(cfg, { ok: false, why: "permission" }), /not known whether it exists/);
  assert.match(diagnose(null, { ok: true, databases: [] }), /no D1 binding/);
});
