import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { rig, photoBlob } from './offline-audit-helpers.mjs';
import { FakeCaches, FakeStorage, makeFetch, world } from './offline-fakes.mjs';

async function withUnsent(opts) {
  const env = rig(opts);
  env.offline();
  const { audit } = await env.api.start({ placeId: 3 });
  await env.api.markItem(audit.id, 11, { result: 'present' });
  await env.api.addPhoto(audit.id, { blob: photoBlob(), ownerType: 'item', ownerKey: 11 });
  return { env, audit };
}

test('sign-out guard: nothing unsent means no question', async () => {
  const env = rig({ choose: async () => { throw new Error('should not ask'); } });
  assert.equal(await env.api.signOutGuard(), true);
});

test('sign-out guard offline with unsent work: Cancel returns false and keeps everything', async () => {
  const asked = [];
  const { env } = await withUnsent({ choose: async (i) => { asked.push(i); return 'cancel'; } });
  assert.equal(await env.api.signOutGuard(), false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].pending.answers, 1); assert.equal(asked[0].pending.photos, 1);
  assert.equal(env.api.pending().total, 3);
  assert.equal((await env.store.listPhotos(5)).length, 1);
});

test('sign-out guard: Discard clears this person\'s outbox (ops, photos, audits) and lets sign-out go ahead', async () => {
  const { env } = await withUnsent({ choose: async () => 'discard' });
  assert.equal(await env.api.signOutGuard(), true);
  assert.equal(env.api.pending().total, 0);
  assert.deepEqual(await env.store.listOps(null), []);
  assert.deepEqual(await env.store.listPhotos(null), []);
  assert.deepEqual(await env.store.listAudits(null), []);
});

test('sign-out guard: discard leaves ANOTHER person\'s unsent data alone', async () => {
  const { env } = await withUnsent({ user: { id: 9, name: 'Other' } });
  const mine = rig({ idb: env.idb, server: env.server, user: { id: 5, name: 'Sam' }, choose: async () => 'discard' });
  mine.offline();
  const { audit } = await mine.api.start({ placeId: 3 });
  await mine.api.markItem(audit.id, 11, { result: 'present' });
  assert.equal(await mine.api.signOutGuard(), true);
  const left = await env.store.listOps(null);
  assert.ok(left.length > 0 && left.every((o) => String(o.user_id) === '9'));
  assert.equal((await env.store.listPhotos(9)).length, 1);
});

test('sign-out guard online: it sends first, and signs out without asking when everything went', async () => {
  const { env } = await withUnsent({ choose: async () => { throw new Error('should not ask'); } });
  env.goOnline();
  assert.equal(await env.api.signOutGuard(), true);
  assert.equal(env.server.audits.length, 1);
  assert.equal(env.server.photos.length, 1);
  assert.equal(env.api.pending().total, 0);
});

test('sign-out guard online but the server is down: asks; Send now that fails asks again; then Cancel', async () => {
  const answers = ['send', 'cancel']; const asked = [];
  const { env } = await withUnsent({ choose: async (i) => { asked.push(i); return answers.shift(); } });
  env.online = true; env.server.down = true;
  assert.equal(await env.api.signOutGuard(), false);
  assert.equal(asked.length, 2);
  assert.ok(env.notes.some((n) => /Not everything could be sent/.test(n)));
  assert.equal(env.api.pending().total, 3);
});

test('sign-out guard: a failed (rejected) op counts as unsent work, so it is never lost silently', async () => {
  const env = rig({ choose: async () => 'cancel' });
  await env.api.start({ placeId: 3 });
  env.server.rejectWhen((m, p) => p.includes('/items/'), 409, 'Finished already');
  await env.api.markItem(100, 11, { result: 'present' }).catch(() => {});
  // online direct send is rejected and shown to the screen: nothing is kept. Now force a kept failure.
  env.offline();
  await env.api.markItem(100, 12, { result: 'present' });
  env.goOnline();
  await env.api.sendNow();
  assert.equal(env.api.pending().failed, 1);
  assert.equal(await env.api.signOutGuard(), false);
});

// The page wiring: the offline.js logout hook must not clear saved data when the audit guard says no.
test('offline.js logout hook: guard false keeps the saved-for-offline data; guard true clears it', async () => {
  const w = world();
  const caches = new FakeCaches(), localStorage = new FakeStorage();
  const fetch = makeFetch(w.routes);
  const hooks = [];
  const win = { Request, Response, URL, Blob, document: {}, caches, localStorage, App: { addLogoutHook: (fn) => hooks.push(fn) }, APP_VERSION: 'v1', fetch, navigator: {}, location: { origin: 'http://localhost' }, setTimeout: () => ({ unref() {} }),
    SDSLib: { auditOutbox: { signOutGuard: async () => win.verdict } } };
  win.self = win; vm.createContext(win);
  vm.runInContext(readFileSync(new URL('../public/lib/offline.js', import.meta.url), 'utf8'), win);
  await win.App.offline.savePlace(7);
  assert.equal(win.App.offline.isSaved(7), true);
  win.verdict = false;
  assert.equal(await hooks[0](), false);
  assert.equal(win.App.offline.isSaved(7), true, 'cancelled sign-out keeps the saved place');
  win.verdict = true;
  await hooks[0]();
  assert.equal(win.App.offline.isSaved(7), false);
});

test('the real audit-outbox.js loads as a page script and registers its sign-out hook once its dependencies exist', async () => {
  const require = createRequire(import.meta.url);
  const hooks = [], timers = [];
  const { FakeIndexedDB } = await import('./offline-fakes.mjs');
  const el = () => ({ appendChild() {}, addEventListener() {}, setAttribute() {}, style: { setProperty() {} }, getElementById() { return null; }, querySelector() { return null; }, innerHTML: '', hidden: true, remove() {}, defaultView: null });
  const doc = Object.assign(el(), { head: el(), body: el(), documentElement: el(), createElement: () => el(), getElementById: () => null, querySelector: () => null, addEventListener() {}, removeEventListener() {} });
  const listeners = {};
  const win = { document: doc, indexedDB: new FakeIndexedDB(), App: { me: { id: 5, name: 'Sam' }, isOnline: () => true, addLogoutHook: (f) => hooks.push(f), toast() {} },
    Response, Request, URL, Blob, SDSLib: {}, navigator: { onLine: true, storage: {} }, location: { hash: '' }, fetch: async () => new Response('{}'), addEventListener: (t, f) => { listeners[t] = f; },
    setTimeout: (f) => { timers.push(f); return { unref() {} }; }, setInterval: () => ({ unref() {} }), clearTimeout() {}, clearInterval() {}, getComputedStyle: () => ({ display: 'none' }) };
  doc.defaultView = win; win.self = win;
  vm.createContext(win);
  vm.runInContext(readFileSync(new URL('../public/lib/audit-client.js', import.meta.url), 'utf8'), win);
  win.SDSLib.auditClientFactory = win.SDSLib.auditClientFactory; // loaded by the page
  assert.equal(typeof win.SDSLib.auditClient.markItem, 'function');
  vm.runInContext(readFileSync(new URL('../public/lib/audit-outbox.js', import.meta.url), 'utf8'), win);
  assert.equal(hooks.length, 0, 'waits for the store');
  vm.runInContext(readFileSync(new URL('../public/lib/audit-store.js', import.meta.url), 'utf8'), win);
  timers.shift()();
  assert.equal(hooks.length, 1);
  assert.ok(win.SDSLib.auditClient.__outbox);
  assert.equal(typeof win.SDSLib.auditClient.sendNow, 'function');
  assert.equal(win.SDSLib.auditClient.pending().total, 0);
});
