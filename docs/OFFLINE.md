# Installable, and offline for read

Spec: `docs/PLACES-CHANGE.md` ("Installable, and offline for read"). Offline is **read-only**: saved places, chemical pages, assessments and SDS PDFs open with no signal. Every write needs a signal.

## Parts

| File | What it does |
|---|---|
| `public/manifest.webmanifest` | Name, `start_url` `/`, scope `/`, standalone, theme colours from `app.css` (`--bg`, `--main`), icons 192, 512, maskable 512 |
| `public/icons/*`, `public/favicon.ico` | Icons made by `scripts/make-icons.mjs` from the real logo `Brand/SDS-EZY.png` (resampled only, never redrawn): plain 192/512 and 128/256 (transparent corners), 16/32 favicons, an opaque 180 px apple-touch-icon, and an opaque full-bleed 512 maskable icon on the logo's own charcoal (#282828) with all lettering inside the centre safe circle. Committed; deterministic |
| `public/sw.js` | The service worker |
| `public/app-version.js` | `self.APP_VERSION` (content hash) and `self.APP_SHELL` (the files to precache). Written by `scripts/bump-version.mjs`. Never edit by hand |
| `public/lib/offline.js` | `window.App.offline`: save, list, remove and clear saved places. Logic is in `createOffline({caches, localStorage, fetch})` so node tests can use fakes |
| `public/_headers` | `Cache-Control: no-cache` for `/sw.js`, `/app-version.js`, `/manifest.webmanifest` (Workers static assets syntax) |

## Versioning

`node scripts/bump-version.mjs` hashes every file under `public/` except `app-version.js` (sorted paths; line endings and OS noise such as `.DS_Store` ignored) and writes `app-version.js`. `--check` exits 1 if the file is out of date. It must run before every deploy:
the lead adds a `predeploy` script (`node scripts/bump-version.mjs`) to `package.json`. A new version changes `sw.js`'s imported script, so the browser installs a new worker.

Caches are named `sdsezy-shell-<APP_VERSION>` and `sdsezy-data-<APP_VERSION>`. On activate the worker deletes every `sdsezy-*` cache of another version and claims the page. The new worker waits until the page sends `{type:'skipWaiting'}`
(`App.offline.applyUpdate()` does this) or all tabs close, so a running page never mixes two versions. `/app-version.js` is answered from the shell cache, so the page and the active worker always agree on the version.
Saved places from an older version are reported `stale: true` ("Updated app: save this place again"); the old data cache is dropped.

## What the worker does

* **Shell** (`APP_SHELL`: index (as `/`), CSS, JS, views, lib, pictograms, icons, help): cached at install, served cache-first (versioned, so safe). A missing optional file does not fail the install; `/`, `app.css`, `app.js` are required.
  Redirected responses (Cloudflare turns `/help.html` into `/help`) are rebuilt clean, since a redirected response cannot answer a navigation.
* **Navigations**: cached page, else the network, else the cached `/` (the app does its own routing).
* **`/vendor/*` and other same-origin static GETs**: stale-while-revalidate into the shell cache (so a library works offline only after it was used once online; the PDF pack builder needs `pdf-lib` and `pdf.js` cached that way).
* **`GET /api/*`**: network first. Only if the network *fails* (not on a 4xx/5xx), answer from the DATA cache of this version (`X-From-Saved-Copy: 1`); if it is not there: `503 {"error":"offline","message":"You're offline. This isn't saved on this phone."}`.
  Range requests on saved PDFs get a proper `206` slice; `Content-Type: application/pdf` is kept. Opening `/api/sds/:id/file` in a tab is a navigation but is still routed as an API read.
* **The worker never writes API responses into any cache.** **Non-GET** requests go straight to the network: no queueing, no replay.
* Messages: `{type:'skipWaiting'}`, `{type:'clear-data'}` (deletes every `sdsezy-data-*` cache).

## What "Save this place" stores

`App.offline.savePlace(placeId, {onProgress, signal})` writes into `sdsezy-data-<APP_VERSION>`, three requests at a time:
`/api/places/:id`, `/api/places` and `/api/places?archived=0`, each chemical's `/api/chemicals/:id`, each current SDS's `/api/sds/:id` and `/api/sds/:id/file`, plus `/api/me`, `/api/settings`, `/api/public-settings`, `/api/options` and `/api/logo` (only if one exists).
One failed file is recorded in `problems` and the place is "saved with N problems"; a cancel (AbortSignal) removes what that run stored. Metadata is in `localStorage['sdsezy.offline.v1']`:
`{app_version, user_id, places:{[id]:{app_version, saved_at, chemicals, sds_files, bytes, urls[], problems[]}}}`. Saving again updates the place and removes URLs no other saved place still uses; `remove(id)` does the same.
The browser is asked to keep the data (`navigator.storage.persist()`) when the first place is saved. `estimate()` gives a plain "Enough room" or "Low on space" (below 100 MB free or over 80% used).

Not saved (they say "You're offline" if opened): version history (`/api/chemicals/:id/history`, `/api/sds/:id/chemicals`), other places' pages, registers and review lists, anything that is a write.

## Privacy: what is cleared when

* **Signing out** (the `App.addLogoutHook` hook, run before the logout request and still run if that request fails or there is no signal): every `sdsezy-data-*` cache, the metadata, and the worker's copies (`clear-data`). It needs no network and works with no controlling worker.
* **Another person signs in** on a phone that holds someone else's saved data: it is cleared (checked at sign-in and when saving).
* **A session that merely expires** does not clear anything (people lose signal and sessions on site).
* The shell cache holds only public app files, no company data. "My place" (`sdsezy.place.<userId>`) is a frontend-core key and is not cleared by this module.

## How to test

* `npm test` runs `tests/offline-*.test.mjs` (fake Cache Storage, localStorage, fetch; the real `sw.js` and `offline.js` run in node and in a `vm` context).
* By hand: run a local Worker with `wrangler.local.toml` on a fresh `--persist-to` directory and the demo data, sign in, open a place, press Save, then **stop the Worker** (DevTools "Offline" and CDP network emulation do not apply to the worker's own fetches in Chrome, so
  they can still reach the server; stopping the server is the honest test). Reload: place, chemical, assessment and SDS PDF open; an upload says "You're offline". Sign out and check `caches.keys()` and `localStorage['sdsezy.offline.v1']`.
* Bump test: change any file under `public/`, run `node scripts/bump-version.mjs`, reload twice (the second reload after `skipWaiting`); only the new `sdsezy-shell-<hash>` remains.

## Browser differences and limits

* **iOS Safari**: install is Share, then Add to Home Screen (no install prompt event). iOS can evict site data after about 7 days of not using the site if it is not installed to the home screen, and its quota is smaller than Chrome's; `persist()` may be refused. Saved data may disappear: save again.
* Android Chrome: installable once the manifest, icons and a worker with a fetch handler are present; the prompt is up to the browser.
* A private window may refuse Cache Storage or localStorage: saving then says it could not store, nothing breaks.
* Large places (hundreds of PDFs) take a while and storage; watch `estimate()`.
* Offline sign-in is not possible: the person must already be signed in; the saved `/api/me` only lets the app open.

## Offline audits (the outbox)

Audits keep working with no signal. Files: `public/lib/audit-store.js` (IndexedDB `sdsezy-audit-v1`), `public/lib/audit-outbox.js` (wraps `SDSLib.auditClient`, the banner, the sign-out guard). Script order in `index.html`: `audit-store.js`, `audit-outbox.js`, then `offline.js`. Audit calls still go through `SDSLib.auditClient`; the outbox replaces its methods (same names and result shapes) once the client has loaded.

**Stores** (every record has `user_id`, the signed-in person; another person never sees or sends it): `audits` (last server copy per audit, plus audits that exist only on the phone), `ops` (the queue, ordered by an auto `seq`: `start|answer|found|disposal|photo|finish`, payload, `client_id`, device time, audit ref, `status` queued|sending|failed, attempts, last error), `photos` (compressed JPEG Blob by `client_id`), `meta` (the local id to server id map).

**A write** is stored in `ops` (and the photo Blob in `photos`) first, so nothing is lost if the page dies. Then the local copy of the audit is an overlay: the last server copy with every queued answer, found item, disposal, photo and finish applied on top, which is what `get()` returns. With a signal and nothing waiting ahead of it the call is sent straight away and the real server answer is returned (so "link" and "create" on a found item still work online, and a rejection reaches the screen as before). Otherwise the screen gets an optimistic result and the op is sent later.

**Sending** is in queue order, one at a time, with the same `client_id` and device times every time, so repeats never make a second row. A network failure keeps the op queued and retries with backoff (2, 5, 15, 30, 60 s); a **401** pauses the whole queue (everything kept; the banner says to sign in again; it resumes after sign-in); a **400/403/404/409** (any other 4xx) marks that one op *failed* with the server's plain message and carries on. A failed start marks the rest of that audit failed with the reason. Failed ops are listed in the banner with Try again / Dismiss; they are never dropped silently. Triggers: the `online` event, app start and sign-in, after each new op, `sendNow()`, and every 60 s while ops are queued.

**Start offline**: a local audit `local-<uuid>` (route `#/audit/local-<uuid>`) built from the saved `GET /api/places/:id`. If the place is not saved: "Save this place for offline first (on the place page)." When the start is sent, local id is mapped to the server id (`serverId(id)`), `get('local-...')` resolves to the server audit. **Found offline** is queued as `action: "record"`, `unchecked: true`, `source: "typed"` (the note sent to the server ends with "(Typed with no signal; not checked against the register.)"); `readLabel` and `matchFound` reject with `.offline = true`.

**Added to `SDSLib.auditClient`**: `pending()` (`{answers, photos, other, failed, total, bytes}` for the signed-in person), `queue()`, `sendNow()`, `isLocalId(id)`, `serverId(id)`, `discardAll()`, `retryFailed(id)`, `dismissFailed(id)`, `signOutGuard()`; events through `onChange`: `queued`, `sending`, `sent`, `failed` (with `retrying: true` for a network failure), `paused`, `resumed`, `change` and `synced` (queue empty).

**Banner**: `#auditOutbox`, mounted in `document.body` (no edit to `app.js`), fixed above the bottom tab bar and above the audit's own `.au-bar`; it measures both and sets `--ob-tab-h` and `--au-bar-h`. It shows "Audit data not yet sent: 9 answers, 3 photos (2.4 MB)" with Send now, an "Offline" state, "1 item needs attention: ..." lines, the sign-in message after a 401, and disappears when everything is sent.

**Sign-out guard**: a logout hook (registered before `offline.js`'s own, which also calls `signOutGuard()` and returns `false` if it said no, so saved data is never cleared on a cancel). With unsent work it tries to send first (not when the server has just failed), then asks "You have audit work that has not been sent": Send now / Discard and sign out / Cancel. Only Discard clears this person's records; Cancel returns `false`. Another person's unsent data on the phone is left untouched, never sent, and mentioned once.

**Storage care**: photos are Blobs; `navigator.storage.persist()` is requested when the first place is saved; a photo is refused with a plain message if the phone has less than the photo plus 10 MB free; the banner shows the bytes waiting.

**Known limits**: a new app version drops the saved-for-offline data (including the saved sign-in), so a phone that updates while offline shows the login screen until it has signal; the queue is in IndexedDB and survives, and `offline.applyUpdate()` refuses to activate an update while audit work is waiting. Unsent ops after discarding or a different person signing in cannot be recovered. Saved audits (the on-phone copies) are only refreshed when opened online. Admin lists are not available offline. iOS Safari may evict IndexedDB for sites not installed to the home screen after a period of non-use: send audit work promptly.
