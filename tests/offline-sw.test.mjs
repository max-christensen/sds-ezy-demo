import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeCaches, makeFetch, json, pdf } from './offline-fakes.mjs';

const require = createRequire(import.meta.url);
const sw = require('../public/sw.js');
const ORIGIN = 'http://localhost';
const req = (path, init = {}) => new Request(ORIGIN + path, init);

async function setup(version = 'v1') {
  const caches = new FakeCaches();
  const net = { '/app.js': () => new Response('console.log(1)', { headers: { 'Content-Type': 'text/javascript' } }) };
  const fetch = makeFetch(net);
  const worker = sw.createWorker({ caches, fetch, origin: ORIGIN, version, shell: ['/', '/app-version.js', '/app.css', '/app.js', '/lib/x.js'] });
  const shell = await caches.open('sdsezy-shell-' + version);
  const data = await caches.open('sdsezy-data-' + version);
  return { caches, fetch, net, worker, shell, data };
}

test('decide: classification', () => {
  const d = (method, path, mode = 'cors', origin = ORIGIN) => sw.decide({ method, url: origin + path, mode }, ORIGIN).kind;
  assert.equal(d('GET', '/api/chemicals/1'), 'api');
  assert.equal(d('GET', '/api/sds/3/file', 'navigate'), 'api', 'opening a PDF in a tab is still an API read');
  assert.equal(d('POST', '/api/sds'), 'passthrough');
  assert.equal(d('PUT', '/api/chemicals/1'), 'passthrough');
  assert.equal(d('DELETE', '/api/chemical-places/1'), 'passthrough');
  assert.equal(d('POST', '/', 'navigate'), 'passthrough');
  assert.equal(d('GET', '/', 'navigate'), 'navigate');
  assert.equal(d('GET', '/app.js'), 'static');
  assert.equal(d('GET', '/vendor/pdf.min.mjs'), 'static');
  assert.equal(d('GET', '/x', 'cors', 'https://elsewhere.example'), 'passthrough');
  assert.equal(d('GET', '/sw.js'), 'passthrough');
  assert.equal(d('GET', '/app-version.js'), 'static', 'version file comes from the shell cache, matching the active worker');
  assert.equal(d('GET', '/manifest.webmanifest'), 'fresh');
});

test('API GET online goes to the network and is NOT cached by the worker', async () => {
  const t = await setup();
  t.net['/api/chemicals/1'] = () => json({ id: 1 });
  const res = await t.worker.handle(req('/api/chemicals/1'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 1 });
  for (const name of await t.caches.keys()) assert.deepEqual((await t.caches.open(name)).urls().filter((u) => u.startsWith('/api')), []);
});

test('API GET offline: answered from the data cache', async () => {
  const t = await setup();
  await t.data.put(req('/api/chemicals/1'), json({ id: 1, saved: true }));
  t.fetch.down = true;
  const res = await t.worker.handle(req('/api/chemicals/1'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 1, saved: true });
  assert.equal(res.headers.get('X-From-Saved-Copy'), '1');
});

test('API GET offline and not saved: 503 with the plain offline JSON', async () => {
  const t = await setup();
  t.fetch.down = true;
  const res = await t.worker.handle(req('/api/chemicals/2'));
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { error: 'offline', message: "You're offline. This isn't saved on this phone." });
});

test('API GET offline answers ONLY from the data cache, never from the shell cache', async () => {
  const t = await setup();
  await t.shell.put(req('/api/chemicals/9'), json({ leaked: true }));
  t.fetch.down = true;
  const res = await t.worker.handle(req('/api/chemicals/9'));
  assert.equal(res.status, 503);
});

test('a data cache from another app version is not used', async () => {
  const t = await setup('v2');
  await (await t.caches.open('sdsezy-data-v1')).put(req('/api/me'), json({ id: 1 }));
  t.fetch.down = true;
  assert.equal((await t.worker.handle(req('/api/me'))).status, 503);
});

test('a server error is passed through (only a network failure falls back to saved copies)', async () => {
  const t = await setup();
  t.net['/api/me'] = () => json({ error: 'x' }, 401);
  await t.data.put(req('/api/me'), json({ id: 1 }));
  assert.equal((await t.worker.handle(req('/api/me'))).status, 401);
});

test('non-GET passes straight to the network: no cache, no queue, and offline it fails', async () => {
  const t = await setup();
  t.net['/api/sds'] = () => json({ id: 5 }, 201);
  const ok = await t.worker.handle(req('/api/sds', { method: 'POST', body: 'x' }));
  assert.equal(ok.status, 201);
  t.fetch.down = true;
  await assert.rejects(() => t.worker.handle(req('/api/sds', { method: 'POST', body: 'x' })), TypeError);
  for (const name of await t.caches.keys()) assert.deepEqual((await t.caches.open(name)).urls(), []);
  assert.equal(sw.decide({ method: 'POST', url: ORIGIN + '/api/sds', mode: 'cors' }, ORIGIN).kind, 'passthrough');
});

test('SDS PDF is served from the data cache offline with its content type, and ranges work', async () => {
  const t = await setup();
  await t.data.put(req('/api/sds/21/file'), pdf(1000));
  t.fetch.down = true;
  const whole = await t.worker.handle(req('/api/sds/21/file'));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'application/pdf');
  assert.equal((await whole.arrayBuffer()).byteLength, 1000);
  const part = await t.worker.handle(req('/api/sds/21/file', { headers: { Range: 'bytes=0-99' } }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-type'), 'application/pdf');
  assert.equal(part.headers.get('content-range'), 'bytes 0-99/1000');
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  const tail = await t.worker.handle(req('/api/sds/21/file', { headers: { Range: 'bytes=900-' } }));
  assert.equal(tail.headers.get('content-range'), 'bytes 900-999/1000');
  const bad = await t.worker.handle(req('/api/sds/21/file', { headers: { Range: 'bytes=5000-' } }));
  assert.equal(bad.status, 416);
  // opening it in a new tab is a navigation request: still the PDF, not the app
  const nav = await t.worker.handle(new Request(ORIGIN + '/api/sds/21/file', { headers: { Accept: 'text/html' } }));
  assert.equal(nav.headers.get('content-type'), 'application/pdf');
});

test('shell asset is served from the shell cache with no network', async () => {
  const t = await setup();
  await t.shell.put(req('/app.js'), new Response('cached app', { headers: { 'Content-Type': 'text/javascript' } }));
  t.fetch.down = true;
  const res = await t.worker.handle(req('/app.js'));
  assert.equal(await res.text(), 'cached app');
  assert.equal(t.fetch.calls.length, 0, 'a versioned shell file does not touch the network');
});

test('navigation falls back to the cached index.html (any path), also offline', async () => {
  const t = await setup();
  await t.shell.put(req('/'), new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } }));
  t.fetch.down = true;
  const home = await t.worker.handle(new Request(ORIGIN + '/', { }));
  assert.equal(home.status, 200);
  const nav = { method: 'GET', url: ORIGIN + '/place/3', mode: 'navigate', headers: new Headers() };
  assert.equal(sw.decide(nav, ORIGIN).kind, 'navigate');
  const res = await t.worker.handle(Object.assign(req('/place/3'), {}));
  assert.ok(res);
});

test('vendor libraries are cached when first used and then served stale-while-revalidate', async () => {
  const t = await setup();
  t.net['/vendor/lib.js'] = () => new Response('lib v1', { headers: { 'Content-Type': 'text/javascript' } });
  assert.equal(await (await t.worker.handle(req('/vendor/lib.js'))).text(), 'lib v1');
  assert.ok(t.shell.urls().includes('/vendor/lib.js'));
  t.net['/vendor/lib.js'] = () => new Response('lib v2');
  assert.equal(await (await t.worker.handle(req('/vendor/lib.js'))).text(), 'lib v1', 'answers from the cache');
  await new Promise((r) => setTimeout(r, 10));
  t.fetch.down = true;
  assert.equal(await (await t.worker.handle(req('/vendor/lib.js'))).text(), 'lib v2', 'and refreshed it for next time');
});

test('install caches the shell (redirects rebuilt clean) and fails if a required file is missing', async () => {
  const t = await setup();
  t.net['/'] = () => new Response('<html></html>');
  t.net['/app.css'] = () => new Response('css');
  t.net['/app-version.js'] = () => new Response('v');
  const failed = await t.worker.install();
  assert.deepEqual(failed, ['/lib/x.js'], 'an optional file that 404s is skipped');
  assert.deepEqual(t.shell.urls(), ['/', '/app-version.js', '/app.css', '/app.js']);
  delete t.net['/app.css'];
  const t2 = await setup();
  t2.net['/'] = () => new Response('<html></html>');
  t2.net['/app-version.js'] = () => new Response('v');
  await assert.rejects(() => t2.worker.install(), /Could not cache \/app.css/);
});

test('activate deletes every sdsezy-* cache that is not this version, takes nothing else', async () => {
  const t = await setup('v2');
  for (const n of ['sdsezy-shell-v1', 'sdsezy-data-v1', 'sdsezy-shell-v0', 'other-app']) await t.caches.open(n);
  const deleted = await t.worker.activate();
  assert.deepEqual(deleted.sort(), ['sdsezy-data-v1', 'sdsezy-shell-v0', 'sdsezy-shell-v1']);
  assert.deepEqual((await t.caches.keys()).sort(), ['other-app', 'sdsezy-data-v2', 'sdsezy-shell-v2']);
});

test('the clear-data message deletes every data cache and keeps the shell', async () => {
  const t = await setup('v2');
  await (await t.caches.open('sdsezy-data-v1')).put(req('/api/me'), json({}));
  await t.data.put(req('/api/me'), json({}));
  await t.worker.clearData();
  assert.deepEqual((await t.caches.keys()).sort(), ['sdsezy-shell-v2']);
});

test('the real script, run as a worker: names its caches from APP_VERSION and handles messages', async () => {
  const listeners = {};
  const caches = new FakeCaches();
  const ctx = {
    importScripts: (u) => { assert.equal(u, '/app-version.js'); ctx.self.APP_VERSION = 'abc'; ctx.self.APP_SHELL = ['/', '/app.css', '/app.js']; },
    location: { origin: ORIGIN }, caches, fetch: makeFetch({ '/': () => new Response('h'), '/app.css': () => new Response('c'), '/app.js': () => new Response('j') }),
    Request, Response, Headers, URL, Promise, console,
    clients: { claim: async () => { ctx.claimed = true; } },
    skipWaiting: () => { ctx.skipped = true; },
    addEventListener: (type, fn) => { listeners[type] = fn; }
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), ctx);
  let wait;
  listeners.install({ waitUntil: (p) => { wait = p; } }); await wait;
  assert.ok(await caches.has('sdsezy-shell-abc'));
  await (await caches.open('sdsezy-data-abc')).put(req('/api/me'), json({}));
  await caches.open('sdsezy-data-old');
  listeners.activate({ waitUntil: (p) => { wait = p; } }); await wait;
  assert.equal(ctx.claimed, true);
  assert.equal(await caches.has('sdsezy-data-old'), false);
  listeners.message({ data: { type: 'skipWaiting' }, waitUntil() {} });
  assert.equal(ctx.skipped, true);
  listeners.message({ data: { type: 'clear-data' }, waitUntil: (p) => { wait = p; } }); await wait;
  assert.equal(await caches.has('sdsezy-data-abc'), false);
  assert.equal(await caches.has('sdsezy-shell-abc'), true);
  // a non-GET is left to the browser (the worker does not call respondWith)
  let responded = false;
  listeners.fetch({ request: new Request(ORIGIN + '/api/sds', { method: 'POST', body: 'x' }), respondWith: () => { responded = true; } });
  assert.equal(responded, false);
});
