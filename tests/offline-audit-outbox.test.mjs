import test from 'node:test';
import assert from 'node:assert/strict';
import { rig, photoBlob, createOutbox } from './offline-audit-helpers.mjs';

const SAVE_FIRST = 'Save this place for offline first (on the place page).';

async function offlineAudit(env) {
  env.offline();
  const r = await env.api.start({ placeId: 3 });
  return r;
}

test('start offline makes a LOCAL audit from the saved place (items, route id) and queues a start op', async () => {
  const env = rig();
  const r = await offlineAudit(env);
  assert.match(r.audit.id, /^local-/);
  assert.equal(r.audit.place_name, 'Ute 1');
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].expected_quantity, 5);
  assert.equal(r.items[0].has_sds, 1);
  assert.equal(env.api.isLocalId(r.audit.id), true);
  assert.equal(env.api.serverId(r.audit.id), null);
  assert.deepEqual(env.api.queue().map((q) => [q.kind, q.status]), [['start', 'queued']]);
  assert.equal(env.server.audits.length, 0, 'nothing reached the server');
});

test('start offline for a place that is not saved says so plainly and leaves no op behind', async () => {
  const env = rig();
  env.cachedPlace = null;
  env.offline();
  await assert.rejects(() => env.api.start({ placeId: 3 }), (e) => e.offline === true && e.message === SAVE_FIRST);
  assert.deepEqual(env.api.queue(), []);
});

test('ops are queued in order; the overlay shows queued answers, found items, disposals, photos and finish in get()', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  const id = audit.id;
  await env.api.markItem(id, 11, { result: 'present' });
  await env.api.markItem(id, 12, { result: 'changed', newQuantity: 2, newUnit: 'L', note: 'half used' });
  await env.api.addFound(id, { clientId: 'f1', productName: 'Mystery', supplier: 'X', action: 'create', matchedChemicalId: 99, source: 'ai' });
  await env.api.addDisposal(id, { clientId: 'd1', description: 'Old tin', reason: 'expired', chemicalId: 11 });
  const ph = await env.api.addPhoto(id, { blob: photoBlob(3000), ownerType: 'item', ownerKey: 11, clientId: 'p1' });
  assert.equal(ph.id, 'local-photo-p1');
  assert.equal(env.api.photoUrl(ph.id), 'blob:test');
  assert.deepEqual(env.api.queue().map((q) => q.kind), ['start', 'answer', 'answer', 'found', 'disposal', 'photo']);
  const seqs = env.ob.memOps().map((o) => o.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

  const d = await env.api.get(id);
  assert.equal(d.items.find((i) => i.chemical_id === 11).result, 'present');
  const ch = d.items.find((i) => i.chemical_id === 12);
  assert.equal(ch.result, 'changed'); assert.equal(ch.new_quantity, 2); assert.equal(ch.new_unit, 'L');
  assert.equal(d.found.length, 1); assert.equal(d.disposals.length, 1);
  assert.equal(d.photos[0].owner_key, '11'); assert.equal(d.photos[0].unsent, true);

  await env.api.finish(id, { notes: 'done' });
  const d2 = await env.api.get(id);
  assert.equal(d2.audit.status, 'finished');
  assert.equal(d2.audit.summary.present, 1);
  assert.equal(d2.audit.summary.changed, 1);
  assert.equal(d2.audit.summary.photos, 1);
});

test('pending() counts what is really unsent, with bytes; re-marking an item replaces the waiting answer', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  await env.api.markItem(audit.id, 11, { result: 'present' });
  await env.api.markItem(audit.id, 11, { result: 'not_found' });
  await env.api.markItem(audit.id, 12, { result: 'present' });
  await env.api.addPhoto(audit.id, { blob: photoBlob(1500), ownerType: 'item', ownerKey: 11 });
  await env.api.addPhoto(audit.id, { blob: photoBlob(2500), ownerType: 'item', ownerKey: 12 });
  await env.api.addDisposal(audit.id, { description: 'x', reason: 'unknown' });
  assert.deepEqual(env.api.pending(), { answers: 2, photos: 2, other: 2, failed: 0, total: 6, bytes: 4000 });
  const d = await env.api.get(audit.id);
  assert.equal(d.items.find((i) => i.chemical_id === 11).result, 'not_found');
});

test('nothing is lost if the page dies: a new outbox over the same store resumes and sends everything', async () => {
  const first = rig();
  const { audit } = await offlineAudit(first);
  await first.api.markItem(audit.id, 11, { result: 'present' });
  await first.api.addPhoto(audit.id, { blob: photoBlob(), ownerType: 'item', ownerKey: 11, clientId: 'p1' });
  // the page dies; the phone reopens the app later with signal
  const second = rig({ idb: first.idb, server: first.server });
  await second.ob.init();
  assert.equal(second.api.pending().total, 3);
  assert.equal((await second.api.get(audit.id)).items[0].result, 'present');
  second.server.down = false;
  await second.api.sendNow();
  assert.equal(second.server.audits.length, 1);
  assert.equal(second.server.audits[0].items.find((i) => i.chemical_id === 11).result, 'present');
  assert.equal(second.server.photos.length, 1);
  assert.equal(second.api.pending().total, 0);
});

test('an op that was "sending" when the page died is sent again, and the server still has one row (idempotent replay)', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  await env.api.markItem(audit.id, 11, { result: 'present' });
  env.goOnline();
  env.server.loseNextResponse(3);                 // the server gets the start, the phone never hears back
  await env.api.sendNow();                        // start fails with a network error: kept
  assert.equal(env.server.audits.length, 1);
  assert.equal(env.api.queue()[0].kind, 'start');
  await env.api.sendNow();                        // replay with the same client_id
  assert.equal(env.server.audits.length, 1, 'one audit, not two');
  assert.equal(env.api.pending().total, 0);
  await env.api.sendNow();                        // a third flush sends nothing and creates nothing
  assert.equal(env.server.audits.length, 1);
});

test('reconnecting: start first, local id mapped to the server id, answers and photos follow in order, photo owner key kept', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  const localId = audit.id;
  await env.api.markItem(localId, 11, { result: 'present' });
  await env.api.addFound(localId, { clientId: 'f1', productName: 'Mystery', action: 'record' });
  await env.api.addPhoto(localId, { blob: photoBlob(), ownerType: 'found', ownerKey: 'f1', clientId: 'p1' });
  await env.api.finish(localId, {});
  const events = []; env.api.onChange((e) => events.push(e.type));
  env.goOnline();
  env.server.calls.length = 0;
  await env.api.sendNow();
  assert.deepEqual(env.server.calls.filter((c) => !c.startsWith('GET')), ['POST /api/audits', 'PUT /api/audits/100/items/11', 'POST /api/audits/100/found', 'POST /api/audits/100/photos', 'POST /api/audits/100/finish']);
  assert.equal(env.api.serverId(localId), '100');
  assert.equal(env.server.photos[0].owner_key, 'f1');
  assert.equal(env.server.audits[0].audit.status, 'finished');
  assert.ok(events.includes('synced'));
  assert.equal(env.api.pending().total, 0);
  // the open screen still resolves the local id
  const d = await env.api.get(localId);
  assert.equal(String(d.audit.id), '100');
  assert.equal(d.items.find((i) => i.chemical_id === 11).result, 'present');
  // a second flush is a no-op
  const n = env.server.calls.length;
  await env.api.sendNow();
  assert.equal(env.server.calls.filter((c) => !c.startsWith('GET')).length, 5);
  assert.equal(env.server.audits.length, 1); assert.equal(env.server.found.length, 1); assert.equal(env.server.photos.length, 1);
  assert.ok(env.server.calls.length >= n);
});

test('a network failure keeps the op queued (and schedules a retry); nothing is marked failed', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  await env.api.markItem(audit.id, 11, { result: 'present' });
  env.online = true; env.server.down = true;      // signal bars but the server is unreachable
  await env.api.sendNow();
  assert.deepEqual(env.api.queue().map((q) => q.status), ['queued', 'queued']);
  assert.equal(env.api.pending().failed, 0);
  assert.equal(env.ob.memOps()[0].attempts, 1);
});

test('a 401 pauses the queue, keeps everything, and resumes after the person signs in again', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  await env.api.markItem(audit.id, 11, { result: 'present' });
  env.goOnline(); env.server.authFail = true;
  await assert.rejects(() => env.api.sendNow(), (e) => e.auth === true);
  assert.equal(env.ob.paused, true);
  assert.equal(env.api.pending().total, 2);
  assert.equal(env.api.pending().failed, 0);
  assert.equal(env.server.audits.length, 0);
  env.server.authFail = false;                      // signed in again
  await env.api.sendNow();
  assert.equal(env.ob.paused, false);
  assert.equal(env.server.audits.length, 1);
  assert.equal(env.api.pending().total, 0);
});

test('a server rejection (400/403/404/409) marks THAT op failed with the plain message and carries on', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  await env.api.markItem(audit.id, 11, { result: 'present' });
  await env.api.markItem(audit.id, 12, { result: 'present' });
  await env.api.addDisposal(audit.id, { clientId: 'd1', description: 'x', reason: 'unknown' });
  env.goOnline();
  env.server.rejectWhen((m, p) => p.endsWith('/items/11'), 409, 'That chemical changed on the server');
  await env.api.sendNow();
  const q = env.api.queue();
  assert.deepEqual(q.map((x) => [x.kind, x.status]), [['answer', 'failed']]);
  assert.equal(q[0].message, 'That chemical changed on the server');
  assert.equal(env.server.disposals.length, 1, 'later ops were still sent');
  assert.equal(env.server.audits[0].items.find((i) => i.chemical_id === 12).result, 'present');
  assert.deepEqual(env.api.pending(), { answers: 0, photos: 0, other: 0, failed: 1, total: 1, bytes: 0 });
  // a failed answer is not shown as the person's answer any more
  const d = await env.api.get(audit.id);
  assert.equal(d.items.find((i) => i.chemical_id === 11).result, null);
  // dismiss removes it
  assert.equal(await env.api.dismissFailed(q[0].id), true);
  assert.equal(env.api.pending().total, 0);
});

test('if the start is rejected, the rest of that audit is marked failed with the reason, never silently dropped', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  await env.api.markItem(audit.id, 11, { result: 'present' });
  env.goOnline();
  env.server.rejectWhen((m, p) => m === 'POST' && p === '/api/audits', 400, 'You already have 5 audits in progress');
  await env.api.sendNow();
  const q = env.api.queue();
  assert.deepEqual(q.map((x) => x.status), ['failed', 'failed']);
  assert.match(q[0].message, /5 audits in progress/);
  assert.match(q[1].message, /could not be started/);
});

test('found offline becomes record + unchecked, and the server hears it was not checked', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  const r = await env.api.addFound(audit.id, { clientId: 'f1', productName: 'Mystery', supplier: 'X', note: 'behind the rack', action: 'link', matchedChemicalId: 11, source: 'ai' });
  assert.equal(r.found.outcome, 'recorded');
  assert.equal(r.found.unchecked, true);
  const op = env.ob.memOps().find((o) => o.kind === 'found');
  assert.equal(op.payload.action, 'record'); assert.equal(op.payload.unchecked, true); assert.equal(op.payload.source, 'typed'); assert.equal(op.payload.matchedChemicalId, undefined);
  env.goOnline();
  await env.api.sendNow();
  assert.equal(env.server.found[0].action, 'record');
  assert.match(env.server.found[0].note, /behind the rack/);
  assert.match(env.server.found[0].note, /not checked against the register/);
});

test('readLabel and matchFound offline reject with .offline = true', async () => {
  const env = rig();
  const { audit } = await offlineAudit(env);
  await assert.rejects(() => env.api.readLabel(audit.id, photoBlob()), (e) => e.offline === true);
  await assert.rejects(() => env.api.matchFound(audit.id, { productName: 'x' }), (e) => e.offline === true);
});

test('online with an empty queue: the call goes straight through and returns the real server answer (link stays link)', async () => {
  const env = rig();
  const r = await env.api.start({ placeId: 3 });
  assert.equal(r.audit.id, 100);
  const f = await env.api.addFound(100, { clientId: 'f1', productName: 'Thing', action: 'link', matchedChemicalId: 11 });
  assert.equal(f.found.outcome, 'link_suggested');
  assert.equal(env.server.found[0].action, 'link');
  const m = await env.api.markItem(100, 11, { result: 'present' });
  assert.equal(m.item.result, 'present');
  assert.equal(env.api.pending().total, 0);
});

test('online: a server rejection reaches the screen as an error and the op is not kept', async () => {
  const env = rig();
  await env.api.start({ placeId: 3 });
  await assert.rejects(() => env.api.markItem(100, 999, { result: 'present' }), /not part of this audit/);
  assert.equal(env.api.pending().total, 0);
});

test('get() and list() offline answer from the phone; online get() refreshes the copy', async () => {
  const env = rig();
  await env.api.start({ placeId: 3 });
  await env.api.markItem(100, 11, { result: 'present' });
  const online = await env.api.get(100);
  assert.equal(online.items[0].result, 'present');
  env.offline();
  const off = await env.api.get(100);
  assert.equal(off.audit.place_name, 'Ute 1');
  const l = await env.api.list({ place_id: 3 });
  assert.equal(l.length, 1);
  await assert.rejects(() => env.api.get(555), (e) => e.offline === true);
});

test('a photo that would not fit on the phone is refused with a plain message and nothing is queued', async () => {
  const env = rig({ estimate: async () => ({ quota: 50e6, usage: 45e6 }) });
  const { audit } = await offlineAudit(env);
  await assert.rejects(() => env.api.addPhoto(audit.id, { blob: photoBlob(2e6), ownerType: 'item', ownerKey: 11 }), (e) => e.storage === true && /too full/.test(e.message));
  assert.equal(env.api.pending().photos, 0);
  assert.equal((await env.store.listPhotos(5)).length, 0);
});

test('every record carries the user id; another person sees none of it and nothing of it is sent for them', async () => {
  const a = rig();
  const { audit } = await offlineAudit(a);
  await a.api.markItem(audit.id, 11, { result: 'present' });
  assert.ok((await a.store.listOps(null)).every((o) => String(o.user_id) === '5'));
  assert.ok((await a.store.listAudits(null)).every((r) => String(r.user_id) === '5'));
  const b = rig({ idb: a.idb, server: a.server, user: { id: 9, name: 'Other' } });
  await b.ob.init();
  assert.deepEqual(b.api.queue(), []);
  assert.equal(b.api.pending().total, 0);
  await assert.rejects(() => b.api.get(audit.id));
  b.goOnline();
  await b.api.sendNow();
  assert.equal(a.server.audits.length, 0, "the other person's work is never flushed");
  await b.ob.onUserMaybeChanged();
  assert.equal(b.notes.length, 1);
  assert.match(b.notes[0], /Another person's unsent audit data is on this phone/);
});

test('with nobody signed in, unsent data is reported as waiting for sign-in (not as "another person\'s")', async () => {
  const a = rig();
  const { audit } = await offlineAudit(a);
  await a.api.markItem(audit.id, 11, { result: 'present' });
  const out = rig({ idb: a.idb, server: a.server, user: null });
  await out.ob.init();
  const st = out.ob.state();
  assert.equal(st.signedOutWaiting, true);
  assert.deepEqual(st.foreign, []);
  assert.equal(out.api.pending().total, 0);
  await out.ob.flush();
  assert.equal(a.server.audits.length, 0, 'nothing is sent with nobody signed in');
});

test('a 60 second tick is armed while ops are queued and stopped when the queue is empty; a failed send arms a backoff retry', async () => {
  const log = [];
  const timers = { setTimeout: (f, ms) => { log.push(['timeout', ms]); return 1; }, clearTimeout() {}, setInterval: (f, ms) => { log.push(['interval', ms]); return 7; }, clearInterval: (t) => log.push(['clear', t]) };
  const env = rig({ timers });
  env.offline();
  await env.api.start({ placeId: 3 });
  assert.deepEqual(log.filter((l) => l[0] === 'interval'), [['interval', 60000]]);
  env.online = true; env.server.down = true;
  await env.api.sendNow();
  assert.ok(log.some((l) => l[0] === 'timeout' && l[1] === 2000), 'first retry after 2 s');
  env.goOnline();
  await env.api.sendNow();
  assert.ok(log.some((l) => l[0] === 'clear' && l[1] === 7));
});
