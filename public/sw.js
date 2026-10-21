/* SDS EZY service worker.
 *
 *  - Shell cache  `sdsezy-shell-<APP_VERSION>`: the app files, filled at install, plus the /vendor libraries as they are used.
 *  - Data cache   `sdsezy-data-<APP_VERSION>`: written ONLY by the page (lib/offline.js) when the user saves a place.
 *    This worker reads it when the network fails and never writes to it. Nothing signed-in is cached by this worker.
 *  - Offline is read-only: anything that is not a GET goes straight to the network.
 *
 * The routing is in plain functions (decide, createWorker) so tests can run them in node.
 */
'use strict';

if (typeof importScripts === 'function') importScripts('/app-version.js');

var SHELL_PREFIX = 'sdsezy-shell-';
var DATA_PREFIX = 'sdsezy-data-';
var OFFLINE_MESSAGE = "You're offline. This isn't saved on this phone.";

// Used only if app-version.js has no list (it normally does: scripts/bump-version.mjs writes APP_SHELL).
var FALLBACK_SHELL = ['/', '/app-version.js', '/app.css', '/app.js', '/disclaimer.js', '/favicon.svg', '/logo-mark.svg', '/manifest.webmanifest', '/lib/offline.js', '/lib/ghs-ref.mjs'];
var REQUIRED_SHELL = ['/', '/app.css', '/app.js'];

// What kind of request is this? Pure: no network, no caches.
//   req: {method, url, mode}   origin: the worker's own origin
function decide(req, origin) {
  var url = new URL(req.url);
  if (url.origin !== origin) return { kind: 'passthrough' };
  if (req.method !== 'GET') return { kind: 'passthrough' };
  var path = url.pathname;
  if (path === '/api' || path.indexOf('/api/') === 0) return { kind: 'api' };
  if (path === '/sw.js') return { kind: 'passthrough' };
  // app-version.js is served from the shell cache so the page always sees the same version as the active worker.
  if (path === '/manifest.webmanifest') return { kind: 'fresh' };
  if (req.mode === 'navigate') return { kind: 'navigate' };
  return { kind: 'static' };
}

function offlineResponse() {
  return new Response(JSON.stringify({ error: 'offline', message: OFFLINE_MESSAGE }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Offline': '1' }
  });
}

// A response that was redirected cannot be handed to a navigation. Rebuild it clean.
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

// Answer a Range request from a stored full response (pdf viewers ask for ranges).
async function rangeFrom(res, rangeHeader) {
  var m = /^bytes=(\d*)-(\d*)$/.exec((rangeHeader || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return res;
  var blob = await res.blob();
  var size = blob.size, start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  var headers = new Headers(res.headers);
  if (start >= size || start > end) {
    headers.set('Content-Range', 'bytes */' + size);
    return new Response(null, { status: 416, headers: headers });
  }
  headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(blob.slice(start, end + 1), { status: 206, headers: headers });
}

function createWorker(deps) {
  var caches = deps.caches;
  var doFetch = deps.fetch;
  var origin = deps.origin;
  var version = deps.version;
  var shellList = (deps.shell && deps.shell.length ? deps.shell : FALLBACK_SHELL).filter(Boolean);
  var shellName = SHELL_PREFIX + version;
  var dataName = DATA_PREFIX + version;

  async function install() {
    var cache = await caches.open(shellName);
    var failed = [];
    await Promise.all(shellList.map(async function (u) {
      try {
        var res = await doFetch(new Request(new URL(u, origin).href, { cache: 'reload' }));
        if (!res.ok) throw new Error(String(res.status));
        await cache.put(new Request(new URL(u, origin).href), await clean(res));
      } catch (e) { failed.push(u); }
    }));
    var missing = REQUIRED_SHELL.filter(function (u) { return failed.indexOf(u) >= 0; });
    if (missing.length) throw new Error('Could not cache ' + missing.join(', '));
    return failed;
  }

  async function activate() {
    var keys = await caches.keys();
    var keep = [shellName, dataName];
    var deleted = [];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('sdsezy-') === 0 && keep.indexOf(keys[i]) < 0) { await caches.delete(keys[i]); deleted.push(keys[i]); }
    }
    return deleted;
  }

  async function clearData() {
    var keys = await caches.keys();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(DATA_PREFIX) === 0) await caches.delete(keys[i]);
    }
  }

  async function fromData(request) {
    var hit = await caches.match(request, { cacheName: dataName, ignoreVary: true });
    if (!hit) return null;
    var headers = new Headers(hit.headers);
    headers.set('X-From-Saved-Copy', '1');
    var res = new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: headers });
    var range = request.headers && request.headers.get('Range');
    return range ? rangeFrom(res, range) : res;
  }

  async function handleApi(request) {
    try {
      return await doFetch(request);
    } catch (e) {
      // The network failed. Only what the user saved can answer.
      var saved = await fromData(request);
      return saved || offlineResponse();
    }
  }

  async function handleNavigate(request) {
    var url = new URL(request.url);
    var cache = await caches.open(shellName);
    var hit = await cache.match(new Request(url.origin + url.pathname));
    if (!hit && !/\.[a-z0-9]+$/i.test(url.pathname) && url.pathname !== '/') hit = await cache.match(new Request(url.origin + url.pathname + '.html'));
    if (hit) return hit;
    try {
      var net = await doFetch(request);
      if (net && (net.ok || net.status !== 404)) return net;
    } catch (e) { /* offline */ }
    // Any other page opens the app, which does its own routing.
    return (await cache.match(new Request(origin + '/'))) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }

  async function handleStatic(request) {
    var cache = await caches.open(shellName);
    var key = new Request(request.url);
    var hit = await cache.match(key);
    var isShell = shellList.indexOf(new URL(request.url).pathname) >= 0;
    if (hit && isShell) return hit; // versioned: a new version has new caches
    // Libraries and anything else same-origin: answer from the cache and refresh it in the background.
    var refresh = doFetch(request).then(async function (res) {
      if (res && res.status === 200 && res.type !== 'opaque') {
        try { await cache.put(key, (await clean(res)).clone()); } catch (e) { /* storage full: carry on */ }
      }
      return res;
    });
    if (hit) { refresh.catch(function () {}); return hit; }
    try { return await refresh; } catch (e) {
      return new Response('', { status: 503, statusText: 'Offline', headers: { 'X-Offline': '1' } });
    }
  }

  // The manifest: always ask the network first (they are served no-cache), keep the last copy for offline.
  async function handleFresh(request) {
    var cache = await caches.open(shellName);
    var key = new Request(request.url);
    try {
      var res = await doFetch(request);
      if (res && res.status === 200) { try { await cache.put(key, res.clone()); } catch (e) { /* ignore */ } }
      return res;
    } catch (e) {
      return (await cache.match(key)) || new Response('', { status: 503, headers: { 'X-Offline': '1' } });
    }
  }

  // Answer one fetch event.
  async function handle(request) {
    var d = decide({ method: request.method, url: request.url, mode: request.mode }, origin);
    if (d.kind === 'api') return handleApi(request);
    if (d.kind === 'navigate') return handleNavigate(request);
    if (d.kind === 'fresh') return handleFresh(request);
    if (d.kind === 'static') {
      // Range requests for static files go to the network (or the cache, whole) like any other.
      return handleStatic(request);
    }
    return doFetch(request);
  }

  return { decide: decide, handle: handle, install: install, activate: activate, clearData: clearData, shellName: shellName, dataName: dataName };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decide: decide, createWorker: createWorker, rangeFrom: rangeFrom, offlineResponse: offlineResponse, OFFLINE_MESSAGE: OFFLINE_MESSAGE };
}

// ---- service worker wiring (not run under node) ----
if (typeof importScripts === 'function' && typeof self !== 'undefined' && self.addEventListener) {
  var worker = createWorker({
    caches: self.caches,
    fetch: function (r) { return self.fetch(r); },
    origin: self.location.origin,
    version: String(self.APP_VERSION || 'dev'),
    shell: self.APP_SHELL
  });

  self.addEventListener('install', function (event) { event.waitUntil(worker.install()); });

  self.addEventListener('activate', function (event) {
    event.waitUntil(worker.activate().then(function () { return self.clients.claim(); }));
  });

  self.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type === 'skipWaiting') self.skipWaiting();
    else if (data.type === 'clear-data') event.waitUntil(worker.clearData());
  });

  self.addEventListener('fetch', function (event) {
    var d = decide({ method: event.request.method, url: event.request.url, mode: event.request.mode }, self.location.origin);
    if (d.kind === 'passthrough') return; // the browser handles it as if there were no worker
    event.respondWith(worker.handle(event.request));
  });
}
