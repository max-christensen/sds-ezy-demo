import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeCaches, FakeStorage, makeFetch, world } from './offline-fakes.mjs';

const require = createRequire(import.meta.url);
const { createOffline, META_KEY } = require('../public/lib/offline.js');

async function savedPhone() {
  const w = world();
  const caches = new FakeCaches(), localStorage = new FakeStorage();
  const fetch = makeFetch(w.routes);
  const msgs = [];
  const offline = createOffline({ caches, localStorage, fetch, origin: 'http://localhost', getVersion: () => 'v1', notifyWorker: (m) => msgs.push(m) });
  await offline.savePlace(7);
  // Other caches that must survive: the app shell, and a data cache from an older version that must go too.
  await (await caches.open('sdsezy-shell-v1')).put(new Request('http://localhost/app.js'), new Response('x'));
  await (await caches.open('sdsezy-data-old')).put(new Request('http://localhost/api/me'), new Response('{}'));
  await (await caches.open('someone-elses-cache')).put(new Request('http://localhost/z'), new Response('z'));
  return { offline, caches, localStorage, fetch, msgs };
}

test('clearAll (sign-out) empties every sdsezy-data cache and the metadata, and tells the worker', async () => {
  const t = await savedPhone();
  assert.ok(t.localStorage.getItem(META_KEY));
  const r = await t.offline.clearAll();
  assert.equal(r.caches_removed, 2);
  const keys = await t.caches.keys();
  assert.deepEqual(keys.sort(), ['someone-elses-cache', 'sdsezy-shell-v1'].sort());
  assert.equal(t.localStorage.getItem(META_KEY), null);
  assert.equal(t.offline.isSaved(7), false);
  assert.deepEqual(t.offline.list(), []);
  assert.deepEqual(t.msgs, [{ type: 'clear-data' }]);
});

test('clearAll works with the network down and without a service worker', async () => {
  const t = await savedPhone();
  t.fetch.down = true;
  const calls = t.fetch.calls.length;
  const offline = createOffline({ caches: t.caches, localStorage: t.localStorage, fetch: t.fetch, getVersion: () => 'v1' }); // no notifyWorker
  await offline.clearAll();
  assert.equal(t.fetch.calls.length, calls, 'no request is made');
  assert.equal((await t.caches.keys()).some((k) => k.startsWith('sdsezy-data-')), false);
  assert.equal(t.localStorage.getItem(META_KEY), null);
});

test('clearAll never throws, even if Cache Storage or the worker is broken', async () => {
  const bad = { keys: async () => { throw new Error('nope'); } };
  const ls = new FakeStorage(); ls.setItem(META_KEY, '{}');
  const offline = createOffline({ caches: bad, localStorage: ls, fetch: makeFetch({}), notifyWorker: () => { throw new Error('no sw'); } });
  await offline.clearAll();
  assert.equal(ls.getItem(META_KEY), null);
});

test('the page registers a logout hook that runs clearAll (and still does when the logout request fails)', async () => {
  const t = await savedPhone();
  const hooks = [];
  const App = { addLogoutHook: (fn) => hooks.push(fn), me: null };
  const timers = [];
  const win = {
    document: {}, caches: t.caches, localStorage: t.localStorage, App, APP_VERSION: 'v1',
    fetch: t.fetch, navigator: {}, location: { origin: 'http://localhost' },
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, console
  };
  win.self = win;
  vm.createContext(win);
  vm.runInContext(readFileSync(new URL('../public/lib/offline.js', import.meta.url), 'utf8'), win);
  assert.ok(win.App.offline && typeof win.App.offline.savePlace === 'function', 'App.offline is defined');
  assert.equal(hooks.length, 1, 'exactly one logout hook registered');
  // Sign out with no signal: the hook still clears everything.
  t.fetch.down = true;
  await hooks[0]();
  assert.equal(t.localStorage.getItem(META_KEY), null);
  assert.equal((await t.caches.keys()).some((k) => k.startsWith('sdsezy-data-')), false);
});

test('the hook is registered even if App.addLogoutHook appears after the script loads', async () => {
  const t = await savedPhone();
  const hooks = [];
  const App = {};
  const timers = [];
  const win = { document: {}, caches: t.caches, localStorage: t.localStorage, App, APP_VERSION: 'v1', fetch: t.fetch, navigator: {}, location: { origin: 'http://localhost' },
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; } };
  win.self = win;
  vm.createContext(win);
  vm.runInContext(readFileSync(new URL('../public/lib/offline.js', import.meta.url), 'utf8'), win);
  assert.equal(hooks.length, 0);
  App.addLogoutHook = (fn) => hooks.push(fn);
  timers.shift()(); // the next poll
  assert.equal(hooks.length, 1);
});

test('another person signing in on a phone that holds someone else\'s saved data clears it', async () => {
  const t = await savedPhone();
  const App = { addLogoutHook() {}, me: { id: 999 } };
  const timers = [];
  const win = { document: {}, caches: t.caches, localStorage: t.localStorage, App, APP_VERSION: 'v1', fetch: t.fetch, navigator: {}, location: { origin: 'http://localhost' },
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; } };
  win.self = win;
  vm.createContext(win);
  vm.runInContext(readFileSync(new URL('../public/lib/offline.js', import.meta.url), 'utf8'), win);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.localStorage.getItem(META_KEY), null);
});
