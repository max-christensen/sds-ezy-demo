import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FakeCaches, FakeStorage, makeFetch, world, json } from './offline-fakes.mjs';

const { createOffline, META_KEY } = createRequire(import.meta.url)('../public/lib/offline.js');

function setup(version = 'v1', routes) {
  const w = world();
  const caches = new FakeCaches(), localStorage = new FakeStorage();
  const fetch = makeFetch(routes || w.routes);
  const msgs = [];
  const state = { ver: version, persisted: 0 };
  const offline = createOffline({
    caches, localStorage, fetch, origin: 'http://localhost', getVersion: () => state.ver,
    notifyWorker: (m) => msgs.push(m),
    storage: { persist: async () => { state.persisted++; return true; }, estimate: async () => ({ usage: 10e6, quota: 1e9 }) },
    now: () => '2026-10-20T00:00:00.000Z'
  });
  return { offline, caches, localStorage, fetch, msgs, w, state };
}

const EXPECTED = ['/api/chemicals/11', '/api/chemicals/12', '/api/chemicals/13', '/api/me', '/api/options', '/api/places', '/api/places/7', '/api/places?archived=0',
  '/api/public-settings', '/api/sds/21', '/api/sds/21/file', '/api/sds/22', '/api/sds/22/file', '/api/settings'];

test('savePlace stores the expected URLs in a versioned data cache, with metadata', async () => {
  const t = setup('abc123');
  const info = await t.offline.savePlace(7);
  assert.deepEqual([...(await t.caches.keys())], ['sdsezy-data-abc123']);
  assert.deepEqual((await t.caches.open('sdsezy-data-abc123')).urls(), EXPECTED);
  assert.equal(info.chemicals, 3);
  assert.equal(info.sds_files, 2);
  assert.equal(info.bytes > 8000, true);
  assert.deepEqual(info.problems, []);
  assert.equal(info.stale, false);
  assert.equal(info.saved_at, '2026-10-20T00:00:00.000Z');
  const meta = JSON.parse(t.localStorage.getItem(META_KEY));
  assert.equal(meta.app_version, 'abc123');
  assert.equal(meta.user_id, 5);
  assert.deepEqual(meta.places['7'].urls.slice().sort(), EXPECTED);
  assert.equal(t.offline.isSaved(7), true);
  assert.equal(t.offline.isSaved(8), false);
  assert.equal(t.offline.list().length, 1);
  assert.equal(t.state.persisted, 1, 'asks the browser to keep the data when the first place is saved');
});

test('a logo that does not exist is not a problem; a saved logo is stored', async () => {
  const t = setup();
  await t.offline.savePlace(7);
  assert.equal(t.offline.info(7).problems.length, 0);
  const w = world();
  w.routes['/api/logo'] = () => new Response('PNG', { status: 200, headers: { 'Content-Type': 'image/png' } });
  const t2 = setup('v1', w.routes);
  await t2.offline.savePlace(7);
  assert.ok((await t2.caches.open('sdsezy-data-v1')).urls().includes('/api/logo'));
});

test('progress is reported item by item with a total, three requests at a time at most', async () => {
  const w = world();
  let inflight = 0, peak = 0;
  for (const k of Object.keys(w.routes)) {
    const h = w.routes[k];
    w.routes[k] = async () => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return h(); };
  }
  const t = setup('v1', w.routes);
  const events = [];
  await t.offline.savePlace(7, { onProgress: (e) => events.push(e) });
  assert.ok(events.length >= 14);
  const last = events[events.length - 1];
  assert.equal(last.done, last.total);
  assert.ok(events.every((e, i) => i === 0 || e.done >= events[i - 1].done));
  assert.ok(peak <= 3 && peak >= 2, 'concurrency ' + peak);
});

test('one failed file is recorded and the place is saved with a problem', async () => {
  const w = world();
  w.routes['/api/sds/22/file'] = () => new Response('boom', { status: 500 });
  const t = setup('v1', w.routes);
  const info = await t.offline.savePlace(7);
  assert.equal(info.problems.length, 1);
  assert.equal(info.problems[0].url, '/api/sds/22/file');
  assert.equal(info.sds_files, 1);
  assert.equal((await t.caches.open('sdsezy-data-v1')).urls().includes('/api/sds/22/file'), false);
  assert.equal(info.chemicals, 3);
});

test('an SDS with no PDF (404) is not a problem', async () => {
  const w = world();
  w.routes['/api/sds/21/file'] = () => new Response('{}', { status: 404 });
  const t = setup('v1', w.routes);
  const info = await t.offline.savePlace(7);
  assert.equal(info.problems.length, 0);
  assert.equal(info.sds_files, 1);
});

test('saving with no signal fails plainly and leaves nothing behind', async () => {
  const t = setup();
  t.fetch.down = true;
  await assert.rejects(() => t.offline.savePlace(7), /need a signal/);
  assert.equal(t.offline.isSaved(7), false);
  assert.deepEqual((await t.caches.open('sdsezy-data-v1')).urls(), []);
});

test('cancelling stops the save and removes what it had stored', async () => {
  const t = setup();
  const ctl = new AbortController();
  let n = 0;
  await assert.rejects(() => t.offline.savePlace(7, { signal: ctl.signal, onProgress: () => { if (++n === 4) ctl.abort(); } }), (e) => e.name === 'AbortError');
  assert.equal(t.offline.isSaved(7), false);
  assert.deepEqual((await t.caches.open('sdsezy-data-v1')).urls(), []);
});

test('re-saving updates and drops URLs that no other saved place uses', async () => {
  const w = world();
  const t = setup('v1', w.routes);
  await t.offline.savePlace(7);
  await t.offline.savePlace(8); // shares chemical 12 and SDS 22 with place 7
  const cache = await t.caches.open('sdsezy-data-v1');
  assert.ok(cache.urls().includes('/api/chemicals/11'));
  // Place 7 loses Acetone and Water, keeps Bleach.
  w.place.chemicals = [{ link_id: 2, chemical_id: 12, product_name: 'Bleach', sds_id: 22 }];
  const info = await t.offline.savePlace(7);
  assert.equal(info.chemicals, 1);
  const urls = cache.urls();
  assert.equal(urls.includes('/api/chemicals/11'), false);
  assert.equal(urls.includes('/api/sds/21/file'), false);
  assert.ok(urls.includes('/api/chemicals/12'));
  assert.ok(urls.includes('/api/sds/22/file'));
  // Removing place 7 keeps what place 8 uses, drops the rest.
  await t.offline.remove(7);
  assert.equal(t.offline.isSaved(7), false);
  const after = cache.urls();
  assert.ok(after.includes('/api/places/8') && after.includes('/api/chemicals/12') && after.includes('/api/me'));
  assert.equal(after.includes('/api/places/7'), false);
  await t.offline.remove(8);
  assert.deepEqual(cache.urls(), []);
});

test('a data cache from an older app version is reported stale and deleted', async () => {
  const t = setup('v1');
  await t.offline.savePlace(7);
  t.state.ver = 'v2'; // new deploy: the service worker has already dropped the v1 caches
  assert.equal(t.offline.info(7).stale, true);
  assert.equal(t.offline.list()[0].stale, true);
  assert.deepEqual([...(await t.caches.keys())], ['sdsezy-data-v1']);
  assert.equal(await t.offline.deleteOldDataCaches(), 1);
  assert.deepEqual([...(await t.caches.keys())], []);
  const info = await t.offline.savePlace(7);
  assert.equal(info.stale, false);
  assert.deepEqual([...(await t.caches.keys())], ['sdsezy-data-v2']);
});

test('saving under a new version drops the older cache by itself and leaves other places stale', async () => {
  const t = setup('v1');
  await t.offline.savePlace(7);
  t.state.ver = 'v2';
  await t.offline.savePlace(8);
  assert.deepEqual([...(await t.caches.keys())], ['sdsezy-data-v2']);
  assert.equal(t.offline.info(7).stale, true, 'place 7 still needs saving again');
  assert.equal(t.offline.info(8).stale, false);
});

test('a different person on this phone: the first person\'s saved data goes', async () => {
  const w = world();
  const t = setup('v1', w.routes);
  await t.offline.savePlace(7);
  w.routes['/api/me'] = () => json({ id: 99, name: 'Other', role: 'user' });
  await t.offline.savePlace(8);
  assert.equal(t.offline.isSaved(7), false);
  assert.equal(t.offline.isSaved(8), true);
  assert.equal(JSON.parse(t.localStorage.getItem(META_KEY)).user_id, 99);
  assert.equal((await t.caches.open('sdsezy-data-v1')).urls().includes('/api/chemicals/11'), false);
});

test('estimate gives a plain answer', async () => {
  const t = setup();
  assert.equal((await t.offline.estimate()).level, 'ok');
  const low = createOffline({ caches: new FakeCaches(), localStorage: new FakeStorage(), fetch: makeFetch({}), storage: { estimate: async () => ({ usage: 950, quota: 1000 }) } });
  const e = await low.estimate();
  assert.equal(e.level, 'low');
  assert.match(e.message, /Low on space/);
});
