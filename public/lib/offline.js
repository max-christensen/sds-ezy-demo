/* SDS EZY: save a place for offline use. Classic script; defines window.App.offline.
 *
 * All of the logic lives in createOffline({caches, localStorage, fetch, ...}) so it can be tested in node with fakes.
 * What is stored, and when it is removed, is described in docs/OFFLINE.md. Short version:
 *  - Only when the user presses "Save this place" do signed-in responses go into Cache Storage, in the cache
 *    `sdsezy-data-<APP_VERSION>`. The service worker never writes API responses by itself.
 *  - Signing out (the logout hook below) deletes every `sdsezy-data-*` cache and the metadata. Session expiry does not.
 */
(function (root) {
  'use strict';

  var META_KEY = 'sdsezy.offline.v1';
  var DATA_PREFIX = 'sdsezy-data-';
  var CONCURRENCY = 3;
  var LOW_FREE_BYTES = 100 * 1024 * 1024;

  function dataCacheName(version) { return DATA_PREFIX + version; }

  function createOffline(deps) {
    var cachesApi = deps.caches;
    var ls = deps.localStorage;
    var doFetch = deps.fetch;
    var getVersion = deps.getVersion || function () { return root && root.APP_VERSION ? String(root.APP_VERSION) : 'dev'; };
    var notifyWorker = deps.notifyWorker || function () {};
    var storage = deps.storage || null; // navigator.storage
    var now = deps.now || function () { return new Date().toISOString(); };

    // ---------- metadata (localStorage) ----------
    function emptyMeta() { return { app_version: getVersion(), user_id: null, places: {} }; }
    function readMeta() {
      try {
        var raw = ls.getItem(META_KEY);
        if (!raw) return emptyMeta();
        var m = JSON.parse(raw);
        if (!m || typeof m !== 'object' || typeof m.places !== 'object' || !m.places) return emptyMeta();
        return m;
      } catch (e) { return emptyMeta(); }
    }
    function writeMeta(m) { try { ls.setItem(META_KEY, JSON.stringify(m)); } catch (e) { /* full or blocked: the cache still works */ } }
    function removeMeta() { try { ls.removeItem(META_KEY); } catch (e) { /* ignore */ } }

    function isStalePlace(p) { return !!p && p.app_version !== getVersion(); }

    // URLs still needed by saved places (not stale ones: their cache is gone) other than `exceptId`.
    function urlsInUse(meta, exceptId) {
      var used = {};
      Object.keys(meta.places).forEach(function (id) {
        if (String(id) === String(exceptId)) return;
        var p = meta.places[id];
        if (isStalePlace(p)) return;
        (p.urls || []).forEach(function (u) { used[u] = true; });
      });
      return used;
    }

    async function openData() { return cachesApi.open(dataCacheName(getVersion())); }

    async function deleteOldDataCaches() {
      var keys = await cachesApi.keys();
      var keep = dataCacheName(getVersion());
      var gone = 0;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(DATA_PREFIX) === 0 && keys[i] !== keep) { await cachesApi.delete(keys[i]); gone++; }
      }
      return gone;
    }

    // ---------- save ----------
    function abortError() { var e = new Error('Save cancelled.'); e.name = 'AbortError'; return e; }

    async function runPool(items, limit, worker, signal) {
      var next = 0;
      async function lane() {
        while (next < items.length) {
          if (signal && signal.aborted) return;
          var item = items[next++];
          await worker(item);
        }
      }
      var lanes = [];
      for (var i = 0; i < Math.min(limit, items.length); i++) lanes.push(lane());
      await Promise.all(lanes);
    }

    async function savePlace(placeId, opts) {
      opts = opts || {};
      var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
      var signal = opts.signal || null;
      var id = String(placeId);
      var version = getVersion();
      var meta = readMeta();
      var firstEver = Object.keys(meta.places).length === 0;

      var cache;
      var added = [];       // URLs written by this run
      var bytes = 0;
      var problems = [];
      var urls = [];
      var done = 0;
      var total = 1;
      var chemicalIds = [];
      var sdsIds = [];
      var sdsFiles = 0;

      function check() { if (signal && signal.aborted) throw abortError(); }
      function progress(label, ok) {
        onProgress({ done: done, total: total, label: label, ok: ok !== false, bytes: bytes, problems: problems.length });
      }

      async function fetchAndStore(url, label, o) {
        o = o || {};
        check();
        var res;
        try {
          res = await doFetch(url, { signal: signal || undefined, credentials: 'same-origin', headers: { Accept: o.accept || 'application/json' } });
        } catch (e) {
          if (signal && signal.aborted) throw abortError();
          if (!o.optional) problems.push({ url: url, label: label, reason: 'No connection' });
          done++; progress(label, false); return null;
        }
        if (!res.ok) {
          if (!(o.optional && res.status === 404)) problems.push({ url: url, label: label, reason: res.status === 401 ? 'Signed out' : 'Server said ' + res.status });
          done++; progress(label, false); return null;
        }
        try {
          var blob = await res.blob();
          var stored = new Response(blob, { status: 200, headers: res.headers });
          await cache.put(new Request(new URL(url, base()).href), stored);
          bytes += blob.size;
          added.push(url);
          if (urls.indexOf(url) < 0) urls.push(url);
          done++; progress(label, true);
          return o.json ? JSON.parse(await blob.text()) : true;
        } catch (e) {
          if (signal && signal.aborted) throw abortError();
          var quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message)));
          problems.push({ url: url, label: label, reason: quota ? 'Phone is out of space' : 'Could not be stored' });
          done++; progress(label, false); return null;
        }
      }

      cache = await openData();
      await deleteOldDataCaches().catch(function () {});

      async function rollback() {
        var others = urlsInUse(meta, id);
        var mine = meta.places[id] && !isStalePlace(meta.places[id]) ? (meta.places[id].urls || []) : [];
        for (var k = 0; k < added.length; k++) {
          if (!others[added[k]] && mine.indexOf(added[k]) < 0) { try { await cache.delete(new Request(new URL(added[k], base()).href), { ignoreVary: true }); } catch (e) { /* ignore */ } }
        }
      }

      try {
        // A different person on this phone: what the last person saved goes first.
        if (meta.user_id != null) {
          try {
            var who = await doFetch('/api/me', { signal: signal || undefined, credentials: 'same-origin' });
            if (who.ok) {
              var w = await who.json();
              if (w && w.id != null && String(w.id) !== String(meta.user_id)) {
                await clearAll();
                cache = await openData();
                meta = emptyMeta();
                firstEver = true;
              }
            }
          } catch (e) { /* offline: the place fetch below says so */ }
        }

        // 1. The place itself. Nothing else can be saved without it.
        var place = await fetchAndStore('/api/places/' + encodeURIComponent(id), 'The place', { json: true });
        if (!place) {
          var err = new Error(problems.length && problems[problems.length - 1].reason === 'No connection'
            ? 'You need a signal to save a place.' : 'This place could not be saved.');
          err.problems = problems;
          throw err;
        }
        var chems = Array.isArray(place.chemicals) ? place.chemicals : [];
        chems.forEach(function (c) {
          if (c.chemical_id != null && chemicalIds.indexOf(c.chemical_id) < 0) chemicalIds.push(c.chemical_id);
          if (c.sds_id != null && sdsIds.indexOf(c.sds_id) < 0) sdsIds.push(c.sds_id);
        });

        // 2. Everything else, three at a time.
        var jobs = [
          { url: '/api/me', label: 'Your sign-in', json: true },
          { url: '/api/places', label: 'Place list' },
          { url: '/api/places?archived=0', label: 'Place list' },
          { url: '/api/settings', label: 'Company settings' },
          { url: '/api/public-settings', label: 'Company name' },
          { url: '/api/options', label: 'Lists' },
          { url: '/api/logo', label: 'Logo', optional: true, accept: 'image/*' }
        ];
        chemicalIds.forEach(function (cid) { jobs.push({ url: '/api/chemicals/' + cid, label: chemName(chems, cid) }); });
        sdsIds.forEach(function (sid) {
          jobs.push({ url: '/api/sds/' + sid, label: 'SDS details' });
          jobs.push({ url: '/api/sds/' + sid + '/file', label: 'SDS PDF', accept: 'application/pdf', optional: true, pdf: true });
        });
        total = done + jobs.length;
        progress('Starting', true);

        var me = null;
        await runPool(jobs, CONCURRENCY, async function (j) {
          var r = await fetchAndStore(j.url, j.label, { optional: j.optional, accept: j.accept, json: j.json });
          if (j.json && r && typeof r === 'object') me = r;
          if (j.pdf && r === true) sdsFiles++;
        }, signal);
        check();

        // 3. Commit: metadata, then drop URLs this place no longer needs and nobody else uses.
        var prev = meta.places[id];
        var inUse = urlsInUse(meta, id);
        var dropped = (prev && !isStalePlace(prev) ? (prev.urls || []) : []).filter(function (u) { return urls.indexOf(u) < 0 && !inUse[u]; });
        for (var i = 0; i < dropped.length; i++) { try { await cache.delete(new Request(new URL(dropped[i], base()).href), { ignoreVary: true }); } catch (e) { /* ignore */ } }

        meta.app_version = version;
        if (me && me.id != null) meta.user_id = me.id;
        meta.places[id] = { app_version: version, saved_at: now(), chemicals: chemicalIds.length, sds_files: sdsFiles, bytes: bytes, urls: urls, problems: problems };
        writeMeta(meta);
      } catch (e) {
        try { await rollback(); } catch (x) { /* ignore */ }
        throw e;
      }

      if (firstEver && storage && typeof storage.persist === 'function') { try { storage.persist(); } catch (e) { /* ignore */ } }
      return info(id);
    }

    function chemName(chems, cid) {
      for (var i = 0; i < chems.length; i++) if (chems[i].chemical_id === cid) return chems[i].product_name || 'Chemical';
      return 'Chemical';
    }

    // Origin the cache keys are made with. In a page: location.origin. In tests: deps.origin.
    function base() { return deps.origin || (root && root.location && root.location.origin) || 'http://localhost'; }

    // ---------- read ----------
    function info(placeId) {
      var p = readMeta().places[String(placeId)];
      if (!p) return null;
      return { saved_at: p.saved_at, chemicals: p.chemicals, sds_files: p.sds_files, bytes: p.bytes, problems: p.problems || [], stale: isStalePlace(p) };
    }
    function isSaved(placeId) { return !!readMeta().places[String(placeId)]; }
    function list() {
      var m = readMeta();
      return Object.keys(m.places).map(function (id) { var i = info(id); i.place_id = isNaN(Number(id)) ? id : Number(id); return i; });
    }

    async function remove(placeId) {
      var id = String(placeId);
      var meta = readMeta();
      var p = meta.places[id];
      if (!p) return false;
      var inUse = urlsInUse(meta, id);
      if (!isStalePlace(p)) {
        try {
          var cache = await openData();
          var urls = p.urls || [];
          for (var i = 0; i < urls.length; i++) {
            if (!inUse[urls[i]]) { try { await cache.delete(new Request(new URL(urls[i], base()).href), { ignoreVary: true }); } catch (e) { /* ignore */ } }
          }
        } catch (e) { /* cache unavailable: forget the record anyway */ }
      }
      delete meta.places[id];
      writeMeta(meta);
      return true;
    }

    // Sign-out. Never throws, never needs the network, works with no service worker.
    async function clearAll() {
      var removed = 0;
      try {
        var keys = await cachesApi.keys();
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf(DATA_PREFIX) === 0) { try { await cachesApi.delete(keys[i]); removed++; } catch (e) { /* keep going */ } }
        }
      } catch (e) { /* Cache Storage unavailable */ }
      removeMeta();
      try { notifyWorker({ type: 'clear-data' }); } catch (e) { /* no service worker */ }
      return { caches_removed: removed };
    }

    async function estimate() {
      if (!storage || typeof storage.estimate !== 'function') return { ok: true, known: false, level: 'unknown', message: 'This browser does not say how much room is left.' };
      try {
        var e = await storage.estimate();
        var quota = e.quota || 0, usage = e.usage || 0, free = Math.max(0, quota - usage);
        var low = quota > 0 && (free < LOW_FREE_BYTES || usage / quota > 0.8);
        return { ok: !low, known: true, usage: usage, quota: quota, free: free, level: low ? 'low' : 'ok', message: low ? 'Low on space on this phone.' : 'Enough room on this phone.' };
      } catch (e) { return { ok: true, known: false, level: 'unknown', message: 'This browser does not say how much room is left.' }; }
    }

    return {
      META_KEY: META_KEY,
      dataCacheName: dataCacheName,
      savePlace: savePlace,
      info: info, isSaved: isSaved, list: list, remove: remove, clearAll: clearAll, estimate: estimate,
      deleteOldDataCaches: deleteOldDataCaches
    };
  }

  var api = { createOffline: createOffline, META_KEY: META_KEY, DATA_PREFIX: DATA_PREFIX, dataCacheName: dataCacheName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ---------- browser wiring ----------
  if (root && root.document && root.caches) {
    var offline = createOffline({
      caches: root.caches,
      localStorage: root.localStorage,
      fetch: function (u, o) { return root.fetch(u, o); },
      storage: root.navigator && root.navigator.storage,
      notifyWorker: function (msg) {
        var sw = root.navigator && root.navigator.serviceWorker;
        if (!sw) return;
        if (sw.controller) sw.controller.postMessage(msg);
        if (sw.getRegistration) sw.getRegistration().then(function (r) { if (r && r.active && r.active !== sw.controller) r.active.postMessage(msg); }).catch(function () {});
      }
    });
    // Tell the page when a newer copy of the app is waiting.
    offline.applyUpdate = function () {
      var sw = root.navigator && root.navigator.serviceWorker;
      if (!sw) return Promise.resolve(false);
      // Not while audit work is waiting to be sent: an update drops the saved-for-offline sign-in, and the person must be able to open the app.
      var ob = root.SDSLib && root.SDSLib.auditClient;
      try { if (ob && typeof ob.pending === 'function' && ob.pending().total > 0) return Promise.resolve(false); } catch (e) { /* ignore */ }
      return sw.getRegistration().then(function (r) {
        if (r && r.waiting) { r.waiting.postMessage({ type: 'skipWaiting' }); return true; }
        return false;
      });
    };
    root.SdsOffline = offline;

    var hooked = false, tries = 0;
    (function attach() {
      var App = root.App = root.App || {};
      if (App.offline !== offline) App.offline = offline;
      if (!hooked && typeof App.addLogoutHook === 'function') {
        App.addLogoutHook(async function () {
          // Unsent audit work comes first: the outbox's own hook asks the person; this check keeps the saved data safe if it said no.
          var oc = root.SDSLib && root.SDSLib.auditOutbox;
          if (oc && typeof oc.signOutGuard === 'function') { var ok = await oc.signOutGuard(); if (ok === false) return false; }
          return offline.clearAll();
        });
        hooked = true;
      }
      // Housekeeping once the app knows who is signed in: another person's saved data goes.
      if (App.me && offline._checkedFor !== App.me.id) {
        offline._checkedFor = App.me.id;
        try {
          var m = JSON.parse(root.localStorage.getItem(META_KEY) || 'null');
          if (m && m.user_id != null && String(m.user_id) !== String(App.me.id)) offline.clearAll();
        } catch (e) { /* ignore */ }
        offline.deleteOldDataCaches().catch(function () {});
      }
      if (tries++ < 400) { var timer = setTimeout(attach, tries < 40 ? 50 : 500); if (timer && timer.unref) timer.unref(); }
    })();
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
