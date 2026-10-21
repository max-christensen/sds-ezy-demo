import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { create } = require("../public/lib/audit-client.js");

const FIXED = Date.parse("2026-10-21T01:02:03.000Z");
function res(status, body, ct = "application/json") {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => ct }, json: async () => body, text: async () => JSON.stringify(body) };
}
function mk(script) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(n++, script.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(url, init) : step;
  };
  let ids = 0;
  const sleeps = [];
  const client = create({ fetch, now: () => FIXED, uuid: () => `uuid-${++ids}`, sleep: async (ms) => { sleeps.push(ms); } });
  return { client, calls, sleeps };
}
const body = (c) => JSON.parse(c.init.body);
const net = () => Object.assign(new TypeError("fetch failed"), {});

test("start sends place_id, client_id and the device time", async () => {
  const { client, calls } = mk([res(200, { audit: { id: 7 }, items: [] })]);
  const r = await client.start({ placeId: 3 });
  assert.equal(calls[0].url, "/api/audits");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(body(calls[0]), { place_id: 3, client_id: "uuid-1", started_at: "2026-10-21T01:02:03.000Z" });
  assert.equal(r.client_id, "uuid-1");
  assert.equal(r.audit.id, 7);
});

test("a failed network call is repeated twice with the SAME client_id and time, then succeeds", async () => {
  const { client, calls, sleeps } = mk([net(), net(), res(200, { found: { id: 1 } })]);
  const r = await client.addFound(5, { productName: "Mystery", action: "record" });
  assert.equal(calls.length, 3);
  const bodies = calls.map(body);
  assert.equal(new Set(bodies.map((b) => b.client_id)).size, 1);
  assert.equal(new Set(bodies.map((b) => b.found_at)).size, 1);
  assert.equal(r.client_id, "uuid-1");
  assert.equal(sleeps.length, 2, "short backoff between tries");
});

test("after two repeats the error has .offline = true and nothing else is sent", async () => {
  const { client, calls } = mk([net()]);
  await assert.rejects(client.finish(5, {}), (e) => e.offline === true && e.status === 0 && /No signal/.test(e.message));
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((c) => body(c).finished_at)).size, 1);
});

test("a server error carries the server's plain message, is not repeated, and is not offline", async () => {
  const { client, calls } = mk([res(400, { error: "Say what changed." })]);
  await assert.rejects(client.markItem(1, 2, { result: "changed" }), (e) => e.message === "Say what changed." && e.status === 400 && !e.offline);
  assert.equal(calls.length, 1);
});

test("a 401 is flagged as an auth problem; a 503 gateway error is repeated", async () => {
  let m = mk([res(401, {})]);
  await assert.rejects(m.client.get(1), (e) => e.auth === true && /log in/.test(e.message));
  m = mk([res(503, { error: "busy" }), res(200, { audit: {} })]);
  await m.client.get(1);
  assert.equal(m.calls.length, 2);
});

test("markItem is addressed by audit and chemical and stamps marked_at; only 'changed' carries new_* fields", async () => {
  const { client, calls } = mk([res(200, { ok: true })]);
  await client.markItem(4, 9, { result: "present", note: "ok", newQuantity: 5 });
  assert.equal(calls[0].url, "/api/audits/4/items/9");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(body(calls[0]), { result: "present", note: "ok", marked_at: "2026-10-21T01:02:03.000Z" });
  await client.markItem(4, 9, { result: "changed", newQuantity: "12.5", newUnit: "L", newContainerNote: "2 drums", note: "" });
  assert.deepEqual(body(calls[1]), { result: "changed", note: "", new_quantity: 12.5, new_unit: "L", new_container_note: "2 drums", marked_at: "2026-10-21T01:02:03.000Z" });
});

test("repeating addDisposal with the same clientId sends the same id (idempotent for the server)", async () => {
  const { client, calls } = mk([res(200, { disposal: { id: 1 } })]);
  await client.addDisposal(2, { description: "Old drum", reason: "expired", clientId: "fixed-id" });
  await client.addDisposal(2, { description: "Old drum", reason: "expired", clientId: "fixed-id" });
  assert.equal(body(calls[0]).client_id, "fixed-id");
  assert.equal(body(calls[1]).client_id, "fixed-id");
  assert.equal(body(calls[0]).flagged_at, "2026-10-21T01:02:03.000Z");
});

test("addPhoto sends multipart fields and a retry reuses the same client_id", async () => {
  const { client, calls } = mk([net(), res(200, { photo: { id: 11 } })]);
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
  const r = await client.addPhoto(3, { blob, ownerType: "item", ownerKey: 9, takenAt: "2026-10-21T00:00:00.000Z", width: 1600, height: 1200 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body, calls[1].init.body, "same FormData");
  const fd = calls[1].init.body;
  assert.equal(fd.get("client_id"), "uuid-1");
  assert.equal(fd.get("owner_type"), "item");
  assert.equal(fd.get("owner_key"), "9");
  assert.equal(fd.get("taken_at"), "2026-10-21T00:00:00.000Z");
  assert.equal(fd.get("width"), "1600");
  assert.ok(fd.get("file") instanceof Blob);
  assert.equal(r.client_id, "uuid-1");
  assert.equal(calls[1].url, "/api/audits/3/photos");
});

test("list builds the query, get/match/photoUrl use the right paths", async () => {
  const { client, calls } = mk([res(200, [])]);
  await client.list({ place_id: 3, status: "in_progress", limit: "" });
  assert.equal(calls[0].url, "/api/audits?place_id=3&status=in_progress");
  await client.matchFound(3, { productName: "A", supplier: "B" });
  assert.equal(calls[1].url, "/api/audits/3/found/match");
  assert.deepEqual(body(calls[1]), { product_name: "A", supplier: "B" });
  assert.equal(client.photoUrl(12), "/api/audit-photos/12");
});

test("pending() is zero while online only, and onChange reports sending / sent / failed", async () => {
  const { client } = mk([res(200, { ok: true }), res(400, { error: "no" })]);
  assert.deepEqual(client.pending(), { answers: 0, photos: 0, other: 0, failed: 0, total: 0, bytes: 0 });
  const seen = [];
  const off = client.onChange((e) => seen.push(e.type + ":" + e.op.kind));
  await client.markItem(1, 1, { result: "present" });
  await assert.rejects(client.markItem(1, 1, { result: "present" }));
  off();
  await client.markItem(1, 1, { result: "present" }).catch(() => {});
  assert.deepEqual(seen, ["sending:answer", "sent:answer", "sending:answer", "failed:answer"]);
});

test("addFound passes unchecked only when set; online stubs of the outbox contract", async () => {
  const { client, calls } = mk([res(200, { found: { id: 1 } })]);
  await client.addFound(5, { productName: "X", action: "record", unchecked: true });
  assert.equal(body(calls[0]).unchecked, true);
  await client.addFound(5, { productName: "Y", action: "record" });
  assert.equal("unchecked" in body(calls[1]), false);
  assert.equal(client.isLocalId("local-abc"), true);
  assert.equal(client.isLocalId(4), false);
  assert.equal(client.serverId(4), 4);
  assert.equal(client.serverId("local-abc"), null);
  assert.deepEqual(client.queue(), []);
  await client.sendNow(); await client.discardAll();
});
