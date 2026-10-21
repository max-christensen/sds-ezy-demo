/* SDS EZY: the offline outbox for audits.
 *
 * Wraps SDSLib.auditClient (replaces its methods, same names and result shapes) so audit work is kept on the phone and sent when there
 * is a signal. Every change is written to the on-phone store (lib/audit-store.js) FIRST, then applied to the local copy of the audit
 * (an overlay on the last server copy), then sent. Sending is strictly in queue order, one at a time, with the same client_id and device
 * times each time, so sending twice never makes a second row (the server answers 200 with the row it already has).
 *
 * Load order in index.html: audit-store.js, audit-outbox.js, then offline.js (so the sign-out guard runs before the saved data is cleared).
 * createOutbox(deps) holds the logic and is tested in node; boot() wires it to the page. See docs/OFFLINE.md.
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else {
    const L = (root.SDSLib = root.SDSLib || {});
    L.auditOutboxFactory = m;
    m.boot(root);
  }
})(typeof self !== "undefined" ? self : this, function () {
  const SAVE_PLACE_FIRST = "Save this place for offline first (on the place page).";
  const NO_SIGNAL = "No signal, or the server could not be reached.";
  const SIGN_IN_AGAIN = "Please sign in again to send your audit work. It is kept on this phone.";
  const OFFLINE_NOTE = " (Typed with no signal; not checked against the register.)";
  const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
  const TICK_MS = 60000;
  const NET_DOWN_MS = 20000;
  const PHOTO_MARGIN = 10 * 1024 * 1024; // keep this much free after queueing a photo
  const RESULTS = ["present", "not_found", "changed"];

  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const isLocalId = (id) => /^local-/.test(String(id == null ? "" : id));
  const mkErr = (msg, extra) => Object.assign(new Error(msg), extra || {});
  const offlineErr = (msg) => mkErr(msg || NO_SIGNAL, { offline: true, status: 0 });

  function createOutbox(deps) {
    const orig = deps.client;                    // the real client: every network call goes through it
    const store = deps.store;
    const now = deps.now || (() => Date.now());
    const nowIso = () => new Date(now()).toISOString();
    const uuid = deps.uuid || (() => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : String(Math.random()).slice(2) + String(now())));
    const getUser = deps.getUser || (() => null);
    const isOnline = deps.isOnline || (() => true);
    const T = deps.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
    const objectUrl = deps.objectUrl || ((blob) => (typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(blob) : ""));

    let memOps = [];                // every op in the store (all people), ordered by seq: the screens read these synchronously
    let memMap = {};                // local audit id -> server audit id
    let paused = false;             // a 401: keep everything, resume after sign-in
    let netDownUntil = 0;
    let flushing = null;
    let ticker = null;
    let retryTimer = null;
    let ready = null;
    const listeners = new Set();
    const urls = new Map();         // photo client_id -> object URL of the local blob
    const touched = new Set();

    const uid = () => { const u = getUser(); return u && u.id != null ? String(u.id) : null; };
    const mine = (o) => String(o.user_id) === uid();
    const live = (o) => o.status === "queued" || o.status === "sending";
    const emit = (ev) => { listeners.forEach((fn) => { try { fn(ev); } catch (e) { /* a listener must never break a send */ } }); };
    const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
    const resolveId = (id) => (memMap[String(id)] != null ? String(memMap[String(id)]) : String(id));
    const serverId = (id) => (memMap[String(id)] != null ? memMap[String(id)] : isLocalId(id) ? null : id);
    const sameAudit = (a, b) => resolveId(a) === resolveId(b);
    const netOk = () => isOnline() && now() >= netDownUntil;

    async function init() {
      if (ready) return ready;
      ready = (async () => {
        memMap = (await store.getMeta("idmap")) || {};
        const ops = await store.listOps(null);
        for (const o of ops) if (o.status === "sending") { o.status = "queued"; await store.putOp(o); }
        memOps = ops.filter((o) => o.status !== "done");
        emit({ type: "change" });
        ensureTicker();
      })();
      return ready;
    }

    // ------------------------------------------------------------------ the queue
    function setOps(op) {
      const i = memOps.findIndex((o) => o.seq === op.seq);
      if (i >= 0) memOps[i] = op; else { memOps.push(op); memOps.sort((a, b) => a.seq - b.seq); }
    }
    async function saveOp(op) { await store.putOp(op); setOps(op); }
    async function dropOp(op) {
      await store.deleteOp(op.seq);
      memOps = memOps.filter((o) => o.seq !== op.seq);
      if (op.kind === "photo") { await store.deletePhoto(op.client_id).catch(() => {}); }
    }
    async function enqueue(kind, auditRef, fields) {
      await init();
      const user = uid();
      if (!user) throw mkErr("Please log in first.", { auth: true, status: 401 });
      const op = Object.assign({ kind, audit_ref: String(auditRef), client_id: null, device_time: nowIso(), user_id: user, status: "queued", attempts: 0, last_error: "", created: nowIso() }, fields);
      op.seq = await store.addOp(op);
      setOps(op);
      touched.add(String(auditRef));
      emit({ type: "queued", op: publicOp(op) });
      ensureTicker();
      return op;
    }
    function publicOp(o) {
      return { id: o.seq, kind: o.kind, status: o.status, auditId: o.audit_ref, serverAuditId: serverId(o.audit_ref), chemicalId: o.chemical_id, ownerType: o.owner_type, ownerKey: o.owner_key, clientId: o.client_id, message: o.status === "failed" ? o.last_error : undefined };
    }
    const unsentOps = () => memOps.filter((o) => mine(o) && o.status !== "done");

    function queue() { return unsentOps().map(publicOp); }
    function pending() {
      const r = { answers: 0, photos: 0, other: 0, failed: 0, total: 0, bytes: 0 };
      for (const o of unsentOps()) {
        if (o.status === "failed") r.failed++;
        else if (o.kind === "answer") r.answers++;
        else if (o.kind === "photo") r.photos++;
        else r.other++;
        if (o.kind === "photo") r.bytes += o.bytes || 0;
      }
      r.total = r.answers + r.photos + r.other + r.failed;
      return r;
    }
    const failures = () => unsentOps().filter((o) => o.status === "failed").map(publicOp);
    const state = () => ({ online: isOnline(), paused, pending: pending(), failures: failures(), foreign: foreignUsers(), signedOutWaiting: !uid() && memOps.some((o) => o.status !== "done") });
    function foreignUsers() { const u = uid(); if (!u) return []; return Array.from(new Set(memOps.filter((o) => o.status !== "done" && String(o.user_id) !== u).map((o) => String(o.user_id)))); }

    // ------------------------------------------------------------------ audits kept on the phone
    async function readRec(id) {
      const rec = await store.getAudit(resolveId(id));
      if (!rec) return null;
      if (String(rec.user_id) !== uid()) return null; // never show one person's audit to another
      return rec;
    }
    async function writeBase(id, data, extra) {
      const rid = resolveId(id);
      await store.putAudit(Object.assign({ id: rid, user_id: uid(), local: isLocalId(rid), fetched_at: nowIso() }, extra || {}, { data }));
    }

    // Apply one op on top of an audit's data (idempotent: found, disposals and photos are matched by client_id, answers replace).
    function apply(d, op, user) {
      const p = op.payload || {};
      if (op.kind === "answer") {
        const it = (d.items || []).find((i) => String(i.chemical_id) === String(op.chemical_id));
        if (it) {
          it.result = p.result; it.note = p.note == null ? null : p.note; it.marked_at = p.markedAt || op.device_time;
          if (p.result === "changed") { it.new_quantity = p.newQuantity == null || p.newQuantity === "" ? null : Number(p.newQuantity); it.new_unit = p.newUnit || null; it.new_container_note = p.newContainerNote == null ? null : p.newContainerNote; }
          else { it.new_quantity = null; it.new_unit = null; it.new_container_note = null; }
          it.unsent = live(op) || undefined;
        }
      } else if (op.kind === "found") {
        d.found = d.found || [];
        if (!d.found.some((f) => f.client_id === op.client_id)) {
          d.found.push({ id: "local-found-" + op.client_id, client_id: op.client_id, product_name: p.productName, supplier: p.supplier || null, source: p.source || "typed", matched_chemical_id: p.matchedChemicalId == null ? null : p.matchedChemicalId, chemical_id: null, outcome: "recorded", note: p.note || null, found_at: p.foundAt || op.device_time, unchecked: !!p.unchecked, unsent: live(op) || undefined });
        }
      } else if (op.kind === "disposal") {
        d.disposals = d.disposals || [];
        if (!d.disposals.some((x) => x.client_id === op.client_id)) {
          d.disposals.push({ id: "local-disp-" + op.client_id, client_id: op.client_id, place_id: d.audit && d.audit.place_id, place_name: d.audit && d.audit.place_name, chemical_id: p.chemicalId == null ? null : p.chemicalId, description: p.description, reason: p.reason, note: p.note || null, status: "to_dispose", flagged_by_name: user && user.name, flagged_at: p.flaggedAt || op.device_time, unsent: live(op) || undefined });
        }
      } else if (op.kind === "photo") {
        d.photos = d.photos || [];
        if (!d.photos.some((x) => x.client_id === op.client_id)) {
          d.photos.push({ id: "local-photo-" + op.client_id, client_id: op.client_id, owner_type: op.owner_type, owner_key: op.owner_key == null ? "" : String(op.owner_key), taken_at: p.takenAt || op.device_time, bytes: op.bytes || 0, width: p.width || null, height: p.height || null, unsent: live(op) || undefined, local_url: urls.get(op.client_id) });
        }
      } else if (op.kind === "finish") {
        d.audit.status = "finished"; d.audit.finished_at = p.finishedAt || op.device_time; if (p.notes) d.audit.notes = p.notes;
        d.audit.finished_by_name = user && user.name; d.audit.unsent = live(op) || undefined;
      }
      return d;
    }
    function summarise(d) {
      const items = d.items || [], photos = d.photos || [];
      const n = (r) => items.filter((i) => i.result === r).length;
      return { listed: items.length, present: n("present"), not_found: n("not_found"), changed: n("changed"), not_marked: items.filter((i) => !RESULTS.includes(i.result)).length, found: (d.found || []).length, disposals: (d.disposals || []).length, photos: photos.length, photo_bytes: photos.reduce((a, p) => a + (Number(p.bytes) || 0), 0) };
    }
    async function localUrlFor(op) {
      if (op.kind !== "photo" || urls.has(op.client_id)) return;
      const ph = await store.getPhoto(op.client_id);
      if (ph && ph.blob) urls.set(op.client_id, objectUrl(ph.blob));
    }
    // The audit as the person should see it: the last server copy with everything still unsent applied on top.
    async function overlay(rec) {
      const d = clone(rec.data);
      const rid = rec.id;
      const mineOps = memOps.filter((o) => mine(o) && live(o) && resolveId(o.audit_ref) === rid && o.kind !== "start");
      for (const o of mineOps) await localUrlFor(o);
      const user = getUser();
      mineOps.forEach((o) => apply(d, o, user));
      if (mineOps.some((o) => o.kind === "finish")) d.audit.summary = summarise(d);
      if (isLocalId(rid) || memOps.some((o) => mine(o) && live(o) && o.kind === "start" && (o.audit_ref === rid))) d.audit.unsent = true;
      return d;
    }

    // ------------------------------------------------------------------ reads
    async function get(id) {
      await init();
      let rid = resolveId(id);
      let rec = await readRec(rid);
      if (!isLocalId(rid) && netOk()) {
        try {
          const data = await orig.get(rid);
          await writeBase(rid, data, { local: false });
          rec = await readRec(rid);
        } catch (e) {
          if (e.auth || e.status === 404 || e.status === 403) throw e;   // a real answer from the server
          if (e.offline) netDownUntil = now() + NET_DOWN_MS;              // otherwise fall back to the copy on this phone
        }
      }
      if (!rec) throw mkErr(isLocalId(rid) ? "This audit is not on this phone." : "This audit is not saved on this phone, and there is no signal.", isLocalId(rid) ? { status: 404 } : { offline: true, status: 0 });
      return overlay(rec);
    }

    async function list(params) {
      await init();
      params = params || {};
      const okRow = (a) => (params.place_id == null || params.place_id === "" || String(a.place_id) === String(params.place_id)) && (!params.status || a.status === params.status);
      const row = (d) => ({ id: d.audit.id, place_id: d.audit.place_id, place_name: d.audit.place_name, place_type: d.audit.place_type, started_by_name: d.audit.started_by_name, started_at: d.audit.started_at, finished_at: d.audit.finished_at || null, status: d.audit.status, summary: d.audit.summary || null, unsent: d.audit.unsent });
      const localRows = async (onlyUnstarted) => {
        const out = [];
        for (const rec of await store.listAudits(uid())) {
          if (onlyUnstarted && !(rec.local && memMap[rec.id] == null)) continue;
          const d = await overlay(rec);
          if (okRow(d.audit)) out.push(row(d));
        }
        return out.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      };
      if (netOk()) {
        try {
          const r = await orig.list(params);
          const arr = Array.isArray(r) ? r : (r && r.audits) || [];
          const extra = (await localRows(true)).filter((x) => !arr.some((y) => String(y.id) === String(x.id)));
          return Array.isArray(r) ? arr.concat(extra) : Object.assign({}, r, { audits: arr.concat(extra) });
        } catch (e) { if (!e.offline && e.status && e.status < 500) throw e; if (e.offline) netDownUntil = now() + NET_DOWN_MS; }
      }
      return localRows(false);
    }

    function readLabel(auditId, blob) {
      if (!netOk() || isLocalId(resolveId(auditId))) return Promise.reject(offlineErr("No signal: the label can't be read now. Type the name; it is recorded and checked later."));
      return orig.readLabel(resolveId(auditId), blob);
    }
    function matchFound(auditId, f) {
      if (!netOk() || isLocalId(resolveId(auditId))) return Promise.reject(offlineErr("No signal: the register can't be checked now. It is recorded and checked later."));
      return orig.matchFound(resolveId(auditId), f);
    }

    // ------------------------------------------------------------------ sending
    async function sendOp(op) {
      const p = op.payload || {};
      const sid = resolveId(op.audit_ref);
      if (op.kind !== "start" && isLocalId(sid)) throw mkErr("This audit could not be started on the server, so this could not be sent.", { status: 409, dependent: true });
      switch (op.kind) {
        case "start": return orig.start({ placeId: p.placeId, clientId: op.client_id, startedAt: p.startedAt || op.device_time });
        case "answer": return orig.markItem(sid, op.chemical_id, p);
        case "found": {
          const body = Object.assign({}, p, { clientId: op.client_id });
          if (p.unchecked) body.note = String(p.note || "").trim() + OFFLINE_NOTE;
          return orig.addFound(sid, body);
        }
        case "disposal": return orig.addDisposal(sid, Object.assign({}, p, { clientId: op.client_id }));
        case "photo": {
          const ph = await store.getPhoto(op.client_id);
          if (!ph || !ph.blob) throw mkErr("The photo is no longer on this phone.", { status: 400 });
          return orig.addPhoto(sid, { blob: ph.blob, ownerType: op.owner_type, ownerKey: op.owner_key, takenAt: p.takenAt, width: p.width, height: p.height, clientId: op.client_id });
        }
        case "finish": return orig.finish(sid, p);
        default: throw mkErr("Unknown item.", { status: 400 });
      }
    }

    async function finalize(op, data) {
      if (op.kind === "start") {
        const sid = String(data.audit.id);
        memMap[op.audit_ref] = sid;
        await store.setMeta("idmap", memMap);
        await writeBase(sid, { audit: data.audit, items: data.items || [], found: [], disposals: [], findings: [], photos: [] }, { local: false });
        if (op.audit_ref !== sid) await store.deleteAudit(op.audit_ref);
        touched.add(sid);
      } else {
        const rec = await store.getAudit(resolveId(op.audit_ref));
        if (rec && String(rec.user_id) === String(op.user_id)) {
          const done = Object.assign({}, op, { status: "done" });
          apply(rec.data, done, getUser());
          if (op.kind === "finish") { rec.data.audit.summary = (data && data.summary) || summarise(rec.data); if (data && data.audit) Object.assign(rec.data.audit, data.audit); }
          await store.putAudit(rec);
        }
        touched.add(resolveId(op.audit_ref));
      }
      await dropOp(op);
    }

    const transient = (e) => e.offline || !e.status || e.status >= 500 || e.status === 408 || e.status === 429;

    async function runOp(op) {
      op.status = "sending"; op.attempts = (op.attempts || 0) + 1;
      await saveOp(op); emit({ type: "sending", op: publicOp(op) });
      try {
        const data = await sendOp(op);
        await finalize(op, data);
        emit({ type: "sent", op: publicOp(op) });
        return { r: "ok", data };
      } catch (e) {
        if (e.auth) {
          op.status = "queued"; op.last_error = SIGN_IN_AGAIN; await saveOp(op);
          paused = true; emit({ type: "paused", op: publicOp(op) });
          return { r: "auth", error: e };
        }
        if (transient(e) && !e.dependent) {
          op.status = "queued"; op.last_error = e.message; await saveOp(op);
          netDownUntil = now() + NET_DOWN_MS;
          scheduleRetry(op.attempts);
          emit({ type: "failed", op: publicOp(op), error: e, retrying: true });
          return { r: "network", error: e };
        }
        op.status = "failed"; op.last_error = e.message || "The server did not accept this."; await saveOp(op);
        if (op.kind === "start") {
          for (const o of memOps) if (live(o) && o.seq !== op.seq && String(o.user_id) === String(op.user_id) && o.audit_ref === op.audit_ref) { o.status = "failed"; o.last_error = "This audit could not be started: " + op.last_error; await saveOp(o); }
        }
        emit({ type: "failed", op: publicOp(op), error: e });
        return { r: "rejected", error: e };
      }
    }

    function scheduleRetry(attempts) {
      if (retryTimer) return;
      const wait = BACKOFF_MS[Math.min((attempts || 1) - 1, BACKOFF_MS.length - 1)];
      retryTimer = T.setTimeout(() => { retryTimer = null; netDownUntil = 0; flush(); }, wait);
      if (retryTimer && retryTimer.unref) retryTimer.unref();
    }
    function ensureTicker() {
      const need = memOps.some((o) => o.status !== "done");
      if (need && !ticker) { ticker = T.setInterval(() => { if (paused) probeSession().then((ok) => { if (ok) flush(); }); else { netDownUntil = 0; flush(); } }, TICK_MS); if (ticker && ticker.unref) ticker.unref(); }
      else if (!need && ticker) { T.clearInterval(ticker); ticker = null; }
    }

    // Is the session good again? (after a 401 the queue waits for the same person to sign in)
    async function probeSession() {
      if (!paused) return true;
      const u = getUser();
      if (!u) return false;
      try { await (deps.probe ? deps.probe() : orig.list({ limit: 1 })); } catch (e) { if (e.auth) return false; if (e.offline) return false; }
      paused = false; emit({ type: "resumed" });
      return true;
    }

    function flush() {
      if (flushing) return flushing;
      flushing = (async () => {
        await init();
        const user = uid();
        if (!user || paused || !isOnline()) return { sent: 0 };
        let sent = 0, stop = false;
        while (!stop) {
          const op = memOps.find((o) => String(o.user_id) === user && o.status === "queued");
          if (!op) break;
          const { r } = await runOp(op);
          if (r === "ok") sent++;
          else if (r === "network" || r === "auth") stop = true;
        }
        ensureTicker();
        if (!stop && !memOps.some((o) => mine(o) && live(o))) {
          if (sent) { emit({ type: "synced" }); refreshTouched(); }
        }
        emit({ type: "change" });
        return { sent };
      })().finally(() => { flushing = null; });
      return flushing;
    }
    // Once everything is sent, fetch the real server copies so what is kept on the phone matches the server.
    function refreshTouched() {
      const ids = Array.from(touched).map(resolveId).filter((x) => !isLocalId(x)); touched.clear();
      ids.forEach((id) => orig.get(id).then((data) => writeBase(id, data, { local: false })).catch(() => {}));
    }

    async function sendNow() {
      await init();
      if (!isOnline()) throw offlineErr("No signal yet. Your audit work is kept on this phone and will be sent when you have signal.");
      netDownUntil = 0;
      if (paused && !(await probeSession())) throw mkErr(SIGN_IN_AGAIN, { auth: true, status: 401 });
      const r = await flush();
      if (paused) throw mkErr(SIGN_IN_AGAIN, { auth: true, status: 401 });
      return Object.assign({ remaining: pending().total }, r);
    }

    // After the op is queued: send it now and return the server's answer if nothing is waiting ahead of it, else answer optimistically.
    async function settle(op, optimistic, onNetworkFail) {
      const canDirect = () => netOk() && !paused && (op.kind === "start" || !isLocalId(resolveId(op.audit_ref)));
      if (canDirect() && memOps.some((o) => mine(o) && o.status === "queued" && o.seq < op.seq)) await flush();
      const ahead = memOps.some((o) => mine(o) && live(o) && o.seq < op.seq);
      if (canDirect() && !ahead && !flushing) {
        const out = await runOp(op);
        if (out.r === "ok") { ensureTicker(); emit({ type: "change" }); if (!memOps.some((o) => mine(o) && live(o))) emit({ type: "synced" }); return { sent: true, data: out.data }; }
        if (out.r === "rejected") { await dropOp(op); emit({ type: "change" }); throw out.error; }
        if (onNetworkFail) await onNetworkFail(op);
        emit({ type: "change" });
        return { sent: false, data: optimistic(op) };
      }
      if (onNetworkFail) await onNetworkFail(op);
      emit({ type: "change" });
      flush();
      return { sent: false, data: optimistic(op) };
    }

    // ------------------------------------------------------------------ writes
    async function start({ placeId, clientId, startedAt }) {
      await init();
      const client_id = clientId || uuid();
      const localId = "local-" + client_id;
      // A second tap with the same client id gets the same audit back.
      if (memMap[localId] != null || memOps.some((o) => o.kind === "start" && o.client_id === client_id && mine(o))) {
        const rec = await readRec(localId);
        if (rec) { const d = await overlay(rec); return { audit: d.audit, items: d.items, client_id, existing: false }; }
      }
      const op = await enqueue("start", localId, { client_id, payload: { placeId: Number(placeId), startedAt: startedAt || nowIso() } });
      const makeLocal = async (o) => {
        if (memMap[localId] != null) return;
        let place;
        try { place = await deps.fetchPlace(placeId); } catch (e) { place = null; }
        if (!place || !place.place) { await dropOp(o); emit({ type: "change" }); throw offlineErr(SAVE_PLACE_FIRST); }
        if (place.place.archived) { await dropOp(o); throw mkErr("This place is archived, so it can't be audited.", { status: 400 }); }
        const u = getUser() || {};
        const audit = { id: localId, client_id, place_id: place.place.id, place_name: place.place.name, place_type: place.place.place_type, place_registration: place.place.registration || null, started_by: u.id, started_by_name: u.name || "", started_at: o.payload.startedAt, finished_at: null, status: "in_progress", summary: null, notes: null, local: true };
        const items = (place.chemicals || []).map((c) => ({ audit_id: localId, chemical_id: c.chemical_id, link_id: c.link_id || null, product_name: c.product_name, supplier: c.supplier || null, expected_quantity: c.quantity == null ? null : c.quantity, expected_unit: c.unit || null, expected_container_note: c.container_note || null, review_due: c.review_due || null, review_status: c.review_status || null, has_sds: c.sds_id ? 1 : 0, has_assessment: c.has_assessment ? 1 : 0, risk_level: c.risk_level || null, result: null, note: null, new_quantity: null, new_unit: null, new_container_note: null, marked_at: null }));
        await writeBase(localId, { audit, items, found: [], disposals: [], findings: [], photos: [] }, { local: true });
      };
      const r = await settle(op, () => null, makeLocal);
      if (r.sent) return Object.assign({}, r.data, { client_id });
      const rec = await readRec(localId);
      const d = await overlay(rec);
      return { audit: d.audit, items: d.items, client_id, queued: true };
    }

    async function markItem(auditId, chemicalId, f) {
      await init();
      f = f || {};
      const sid = resolveId(auditId);
      // Re-marking replaces an answer that is still waiting.
      for (const o of memOps.filter((x) => x.kind === "answer" && x.status === "queued" && mine(x) && sameAudit(x.audit_ref, sid) && String(x.chemical_id) === String(chemicalId))) await dropOp(o);
      const payload = { result: f.result, note: f.note == null ? undefined : String(f.note), newQuantity: f.newQuantity, newUnit: f.newUnit, newContainerNote: f.newContainerNote, markedAt: f.markedAt || nowIso() };
      const op = await enqueue("answer", sid, { chemical_id: Number(chemicalId), client_id: null, payload });
      const r = await settle(op, (o) => ({ ok: true, queued: true, chemical_id: o.chemical_id, result: payload.result }));
      return r.data;
    }

    // Offline (or unable to check): typed only, recorded only, flagged for the admin to check.
    async function coerceFound(op) {
      const p = op.payload;
      op.payload = Object.assign({}, p, { source: "typed", action: "record", matchedChemicalId: undefined, unchecked: true });
      await saveOp(op);
    }
    async function addFound(auditId, f) {
      await init();
      const client_id = f.clientId || uuid();
      const payload = { productName: f.productName, supplier: f.supplier ? String(f.supplier) : undefined, source: f.source || "typed", foundAt: f.foundAt || nowIso(), note: f.note ? String(f.note) : undefined, action: f.action || "record", matchedChemicalId: f.matchedChemicalId };
      const existing = memOps.find((o) => o.kind === "found" && o.client_id === client_id && mine(o));
      if (existing) return { found: { client_id, outcome: "recorded", product_name: payload.productName }, client_id, queued: true };
      const op = await enqueue("found", resolveId(auditId), { client_id, payload });
      if (!netOk() || isLocalId(resolveId(op.audit_ref)) || paused) await coerceFound(op);
      const r = await settle(op, (o) => ({ found: { client_id, product_name: o.payload.productName, supplier: o.payload.supplier || null, outcome: "recorded", unchecked: !!o.payload.unchecked, source: o.payload.source }, client_id, queued: true }), coerceFound);
      return r.sent ? Object.assign({}, r.data, { client_id }) : r.data;
    }
    async function addDisposal(auditId, f) {
      await init();
      const client_id = f.clientId || uuid();
      const payload = { description: f.description, reason: f.reason, note: f.note ? String(f.note) : undefined, chemicalId: f.chemicalId, flaggedAt: f.flaggedAt || nowIso() };
      const existing = memOps.find((o) => o.kind === "disposal" && o.client_id === client_id && mine(o));
      if (existing) return { disposal: { client_id, description: payload.description, status: "to_dispose" }, client_id, queued: true };
      const op = await enqueue("disposal", resolveId(auditId), { client_id, payload });
      const r = await settle(op, (o) => ({ disposal: { client_id, description: o.payload.description, reason: o.payload.reason, status: "to_dispose" }, client_id, queued: true }));
      return r.sent ? Object.assign({}, r.data, { client_id }) : r.data;
    }
    async function addPhoto(auditId, f) {
      await init();
      const client_id = f.clientId || uuid();
      const blob = f.blob;
      if (memOps.some((o) => o.kind === "photo" && o.client_id === client_id && mine(o))) return { photo: { id: "local-photo-" + client_id, client_id }, id: "local-photo-" + client_id, client_id, queued: true };
      if (deps.estimate) {
        const e = await deps.estimate().catch(() => null);
        if (e && e.quota && e.quota - e.usage < blob.size + PHOTO_MARGIN) throw mkErr("This phone is too full to keep another photo. Send what is waiting, or free some space, then try again.", { storage: true, status: 507 });
      }
      const user = uid();
      if (!user) throw mkErr("Please log in first.", { auth: true, status: 401 });
      await store.putPhoto({ client_id, user_id: user, blob, size: blob.size, created: nowIso() });
      urls.set(client_id, objectUrl(blob));
      const payload = { takenAt: f.takenAt || nowIso(), width: f.width, height: f.height };
      let op;
      try { op = await enqueue("photo", resolveId(auditId), { client_id, owner_type: f.ownerType, owner_key: f.ownerKey == null ? null : String(f.ownerKey), bytes: blob.size, payload }); }
      catch (e) { await store.deletePhoto(client_id).catch(() => {}); throw e; }
      const row = (o) => ({ id: "local-photo-" + client_id, client_id, owner_type: o.owner_type, owner_key: o.owner_key, taken_at: payload.takenAt, bytes: o.bytes, local_url: urls.get(client_id), unsent: true });
      const r = await settle(op, (o) => ({ photo: row(o), id: "local-photo-" + client_id, client_id, queued: true }));
      return r.sent ? Object.assign({}, r.data, { client_id }) : r.data;
    }
    async function finish(auditId, f) {
      await init();
      f = f || {};
      const sid = resolveId(auditId);
      const prior = memOps.find((o) => o.kind === "finish" && mine(o) && sameAudit(o.audit_ref, sid));
      const payload = { finishedAt: f.finishedAt || (prior && prior.payload.finishedAt) || nowIso(), notes: f.notes ? String(f.notes) : undefined };
      if (prior) { prior.payload = payload; await saveOp(prior); }
      const op = prior || await enqueue("finish", sid, { client_id: null, payload });
      const r = await settle(op, async () => null);
      if (r.sent) return r.data;
      const rec = await readRec(sid);
      const d = rec ? await overlay(rec) : null;
      return { audit: d && d.audit, summary: d ? summarise(d) : null, queued: true };
    }

    // ------------------------------------------------------------------ resolving failures
    async function retryFailed(id) {
      const o = memOps.find((x) => x.seq === id && mine(x) && x.status === "failed");
      if (!o) return false;
      o.status = "queued"; o.last_error = ""; await saveOp(o); emit({ type: "change" }); flush(); return true;
    }
    async function dismissFailed(id) {
      const o = memOps.find((x) => x.seq === id && mine(x) && x.status === "failed");
      if (!o) return false;
      await dropOp(o); emit({ type: "change" }); ensureTicker(); return true;
    }
    async function discardAll() {
      await init();
      const user = uid();
      if (!user) return;
      memOps.filter((o) => String(o.user_id) === user).forEach((o) => { if (o.kind === "photo" && urls.has(o.client_id)) { try { deps.revoke && deps.revoke(urls.get(o.client_id)); } catch (e) { /* ignore */ } urls.delete(o.client_id); } });
      await store.clearUser(user);
      memOps = memOps.filter((o) => String(o.user_id) !== user);
      Object.keys(memMap).forEach((k) => { /* the map holds only ids; kept so a late screen can still resolve */ });
      emit({ type: "change" });
      ensureTicker();
    }

    // ------------------------------------------------------------------ sign-out guard
    // Resolves true when it is fine to sign out (nothing unsent, or everything sent, or the person chose to discard); false to stay.
    async function signOutGuard() {
      await init();
      if (!uid() || !memOps.some((o) => mine(o) && o.status !== "done")) return true;
      if (netOk()) { try { await sendNow(); } catch (e) { /* offline or signed out: the choice below covers it */ } }   // not when the server just failed: no long wait
      if (!memOps.some((o) => mine(o) && o.status !== "done")) return true;
      for (;;) {
        const choice = deps.choose ? await deps.choose({ pending: pending(), failures: failures(), online: isOnline() }) : "cancel";
        if (choice === "discard") { await discardAll(); return true; }
        if (choice === "send") {
          try { await sendNow(); } catch (e) { if (deps.notify) deps.notify(e.message); }
          if (!memOps.some((o) => mine(o) && o.status !== "done")) return true;
          if (deps.notify) deps.notify("Not everything could be sent. It is still on this phone.");
          continue;
        }
        return false;
      }
    }

    // The person changed (signed in, or another person signed in): keep going, never touch another person's data.
    let lastUser = null, warned = new Set();
    async function onUserMaybeChanged() {
      await init();
      const u = uid();
      if (u === lastUser) return;
      lastUser = u;
      paused = false;
      if (!u) return;
      foreignUsers().forEach((f) => { if (!warned.has(f)) { warned.add(f); if (deps.notify) deps.notify("Another person's unsent audit data is on this phone. It stays here and is not sent while you are signed in."); } });
      emit({ type: "change" });
      if (isOnline()) flush();
    }

    const api = {
      start, list, get, markItem, readLabel, matchFound, addFound, addDisposal, addPhoto, finish,
      photoUrl: (id) => { const m = /^local-photo-(.+)$/.exec(String(id)); return m && urls.get(m[1]) ? urls.get(m[1]) : orig.photoUrl(id); },
      pending, onChange, queue, sendNow, isLocalId, serverId, discardAll, retryFailed, dismissFailed, signOutGuard,
      OFFLINE_MESSAGE: orig.OFFLINE_MESSAGE,
    };
    const internals = { init, flush, state, onUserMaybeChanged, probeSession, get paused() { return paused; }, set paused(v) { paused = v; }, memOps: () => memOps, resolveId };
    return { api, internals };
  }

  // ---------------------------------------------------------------------------------------------- the banner and the page wiring
  const BANNER_CSS = `
#auditOutbox{position:fixed;left:0;right:0;bottom:calc(var(--ob-tab-h,0px) + env(safe-area-inset-bottom,0px) + var(--au-bar-h,0px));z-index:45;background:#FFF2D6;color:#3a2a00;border-top:2px solid #C98A00;padding:8px 12px;font-size:14px;line-height:1.35;box-shadow:0 -2px 8px rgba(0,0,0,.12)}
#auditOutbox[hidden]{display:none}
#auditOutbox.ob-off{background:#E7EFEE;color:#1F2A24;border-top-color:#3B6E71}
#auditOutbox .ob-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#auditOutbox .ob-main{flex:1 1 220px;min-width:0}
#auditOutbox button{min-height:44px;padding:6px 14px;font:inherit;border-radius:8px;border:1px solid #7A4B00;background:#fff;color:#1F2A24;cursor:pointer}
#auditOutbox button.ob-go{background:#1F2A24;color:#fff;border-color:#1F2A24}
#auditOutbox button:disabled{opacity:.55;cursor:default}
#auditOutbox .ob-fail{margin-top:4px;color:#8F2F23;font-weight:600}
#auditOutbox .ob-fail button{min-height:36px;padding:2px 10px;font-weight:400;margin-left:6px}
#auditOutbox .ob-det{font-size:12.5px;opacity:.85}
@media print{#auditOutbox{display:none!important}}`;

  function bannerText(st) {
    const p = st.pending, parts = [];
    const n = (v, a, b) => v + " " + (v === 1 ? a : b);
    if (p.answers) parts.push(n(p.answers, "answer", "answers"));
    if (p.photos) parts.push(n(p.photos, "photo", "photos"));
    if (p.other) parts.push(n(p.other, "other item", "other items"));
    return parts.length ? "Audit data not yet sent: " + parts.join(", ") : "";
  }
  function mb(bytes) { const m = (Number(bytes) || 0) / 1048576; return (m < 0.1 ? "less than 0.1" : m.toFixed(1)) + " MB"; }

  function mountBanner(doc, ob, esc) {
    const style = doc.createElement("style"); style.textContent = BANNER_CSS; doc.head.appendChild(style);
    const el = doc.createElement("div");
    el.id = "auditOutbox"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite"); el.hidden = true;
    doc.body.appendChild(el);
    let timer = null;
    function measure() {
      const tab = doc.getElementById("tabbar");
      const tabH = tab && doc.defaultView.getComputedStyle(tab).display !== "none" ? tab.offsetHeight : 0;
      const bar = doc.querySelector(".au-bar:not([hidden])");
      const barVisible = bar && bar.offsetParent !== null;
      doc.documentElement.style.setProperty("--ob-tab-h", tabH + "px");
      doc.documentElement.style.setProperty("--au-bar-h", barVisible ? bar.offsetHeight + "px" : "0px");
      doc.body.style.paddingBottom = el.hidden ? "" : el.offsetHeight + "px";
    }
    function paint() {
      timer = null;
      const st = ob.internals.state();
      const text = bannerText(st);
      const online = st.online;
      const showOffline = !online && (st.pending.total > 0 || /^#\/audit/.test(doc.defaultView.location.hash || ""));
      const fails = st.failures;
      if (!text && !fails.length && !st.paused && !showOffline && !st.foreign.length && !st.signedOutWaiting) { el.hidden = true; el.innerHTML = ""; measure(); return; }
      el.className = text || fails.length || st.paused ? "" : "ob-off";
      const bits = [];
      if (!online) bits.push('<strong>Offline.</strong> ' + (text ? esc(text) + (st.pending.bytes ? ' <span class="ob-det">(' + mb(st.pending.bytes) + ' waiting)</span>' : "") + ". It is kept on this phone and sent when you have signal." : "Audit work is saved on this phone and sent when you have signal."));
      else if (text) bits.push("<strong>" + esc(text) + "</strong>" + (st.pending.bytes ? ' <span class="ob-det">(' + mb(st.pending.bytes) + ")</span>" : ""));
      if (st.paused) bits.push(esc(SIGN_IN_AGAIN));
      if (st.signedOutWaiting) bits.push("Unsent audit data is kept on this phone. Sign in to send it.");
      if (st.foreign.length && !text && !fails.length) bits.push("Another person's unsent audit data is on this phone. It stays here and is not sent while you are signed in.");
      const failHtml = fails.map((f) => '<div class="ob-fail">' + (fails.length === 1 ? "1 item needs attention: " : "Needs attention: ") + esc(f.message || "It could not be sent.") + ' <button type="button" data-ob="retry" data-id="' + f.id + '">Try again</button><button type="button" data-ob="dismiss" data-id="' + f.id + '">Dismiss</button></div>').join("");
      const canSend = st.pending.answers + st.pending.photos + st.pending.other > 0 || st.paused;
      el.innerHTML = '<div class="ob-row"><div class="ob-main">' + bits.join(" ") + "</div>" + (canSend ? '<button type="button" class="ob-go" data-ob="send"' + (online ? "" : " disabled") + ">Send now</button>" : "") + "</div>" + failHtml;
      el.hidden = false;
      measure();
    }
    const schedule = () => { if (!timer) timer = setTimeout(paint, 40); };
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-ob]"); if (!b) return;
      const a = b.dataset.ob;
      try {
        if (a === "send") { b.disabled = true; await ob.api.sendNow(); }
        else if (a === "retry") await ob.api.retryFailed(Number(b.dataset.id));
        else if (a === "dismiss") await ob.api.dismissFailed(Number(b.dataset.id));
      } catch (err) { /* the banner repaints with the state; a plain message is already shown there */ }
      paint();
    });
    ob.api.onChange(schedule);
    doc.defaultView.addEventListener("online", schedule); doc.defaultView.addEventListener("offline", schedule);
    doc.defaultView.addEventListener("hashchange", () => setTimeout(paint, 300)); doc.defaultView.addEventListener("resize", schedule);
    setInterval(() => { if (!el.hidden) measure(); }, 1500);
    paint();
    return { paint: schedule, el };
  }

  // A three-way choice, in our own small dialog (no dependency on other modules).
  function chooseDialog(doc, info, esc) {
    return new Promise((resolve) => {
      const prev = doc.activeElement;
      const ov = doc.createElement("div");
      ov.setAttribute("style", "position:fixed;inset:0;background:rgba(31,42,36,.55);z-index:90;display:flex;align-items:center;justify-content:center;padding:16px");
      const p = info.pending, bits = [];
      if (p.answers) bits.push(p.answers + (p.answers === 1 ? " answer" : " answers"));
      if (p.photos) bits.push(p.photos + (p.photos === 1 ? " photo" : " photos"));
      if (p.other) bits.push(p.other + " other");
      if (p.failed) bits.push(p.failed + " that needs attention");
      ov.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="obTitle" style="background:#fff;color:#1F2A24;border-radius:10px;max-width:420px;width:100%;padding:18px">'
        + '<h2 id="obTitle" style="margin:0 0 8px;font-size:18px">You have audit work that has not been sent</h2>'
        + "<p>" + esc(bits.join(", ")) + (info.online ? " could not be sent just now." : " is waiting for a signal.") + " If you sign out and discard, it is lost.</p>"
        + '<div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">'
        + '<button type="button" data-c="send" class="primary" style="min-height:44px">Send now</button>'
        + '<button type="button" data-c="discard" class="danger" style="min-height:44px">Discard and sign out</button>'
        + '<button type="button" data-c="cancel" style="min-height:44px">Cancel</button></div></div>';
      const done = (c) => { ov.remove(); doc.removeEventListener("keydown", key, true); if (prev && prev.focus) prev.focus(); resolve(c); };
      const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done("cancel"); } };
      ov.addEventListener("click", (e) => { const b = e.target.closest("button[data-c]"); if (b) done(b.dataset.c); });
      doc.addEventListener("keydown", key, true);
      doc.body.appendChild(ov);
      ov.querySelector('[data-c="send"]').focus();
    });
  }

  function boot(root) {
    if (!root.document || typeof root.indexedDB === "undefined") return;
    const L = root.SDSLib;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    let tries = 0, injected = false;
    (function wait() {
      const App = root.App, client = L.auditClient;
      if (client && client.__outbox) return;
      if (!L.auditStore && !injected && tries > 1) { injected = true; const sc = root.document.createElement("script"); sc.src = "/lib/audit-store.js"; root.document.head.appendChild(sc); }
      if (!(L.auditStore && client && App && typeof App.addLogoutHook === "function")) {
        if (tries++ < 600) { const t = setTimeout(wait, tries < 40 ? 50 : 500); if (t && t.unref) t.unref(); }
        return;
      }
      const store = L.auditStore.createStore({ indexedDB: root.indexedDB });
      const origCopy = Object.assign({}, client);
      const ob = createOutbox({
        client: origCopy, store,
        timers: { setTimeout: (f, ms) => root.setTimeout(f, ms), clearTimeout: (t) => root.clearTimeout(t), setInterval: (f, ms) => root.setInterval(f, ms), clearInterval: (t) => root.clearInterval(t) },
        getUser: () => App.me,
        isOnline: () => (App.isOnline ? App.isOnline() : root.navigator.onLine !== false),
        fetchPlace: async (id) => {
          const r = await root.fetch("/api/places/" + encodeURIComponent(id), { credentials: "same-origin" });
          if (!r.ok) return null;
          return r.json();
        },
        probe: () => origCopy.list({ limit: 1 }),
        estimate: async () => (root.navigator.storage && root.navigator.storage.estimate ? root.navigator.storage.estimate() : null),
        notify: (m) => { if (App.toast) App.toast(m, "info"); },
        choose: (info) => chooseDialog(root.document, info, esc),
        revoke: (u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } },
      });
      Object.assign(client, ob.api);
      client.__outbox = ob;
      root.SDSLib.auditOutbox = ob.api;
      App.addLogoutHook(() => ob.api.signOutGuard());
      mountBanner(root.document, ob, esc);
      root.addEventListener("online", () => { ob.internals.state(); ob.internals.flush(); });
      ob.internals.init().then(() => ob.internals.onUserMaybeChanged());
      // The person signing in (or a new session after a 401): notice it, resume, and never touch another person's data.
      let lastMe = null;
      setInterval(() => {
        const me = App.me ? String(App.me.id) : null;
        if (me !== lastMe) { lastMe = me; ob.internals.onUserMaybeChanged(); if (me && ob.internals.paused) ob.internals.probeSession().then((ok) => { if (ok) ob.internals.flush(); }); }
      }, 1000);
    })();
  }

  return { createOutbox, boot, SAVE_PLACE_FIRST, SIGN_IN_AGAIN, bannerText };
});
