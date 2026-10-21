// SDSLib.auditClient: the ONE module every audit API call goes through (so the offline stage can wrap it without touching the screens).
// Every call that creates something makes its own client_id (a UUID) and stamps the DEVICE time. A failed network call is repeated up to
// twice with a short wait and the SAME client_id and times, so a repeat can never make a second row (the server answers 200 with the row it has).
// Errors: `err.offline = true` when no response came back at all; otherwise the server's plain message with `err.status`.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else {
    const L = (root.SDSLib = root.SDSLib || {});
    L.auditClientFactory = m;
    L.auditClient = m.create({});
  }
})(typeof self !== "undefined" ? self : this, function () {
  const OFFLINE_MESSAGE = "No signal, or the server could not be reached.";
  const RETRY_STATUSES = [502, 503, 504];

  function defaultUuid() {
    const c = typeof crypto !== "undefined" ? crypto : null;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // deps (all optional, for tests): fetch, now() -> ms, uuid(), sleep(ms), backoff [ms, ms]
  function create(deps) {
    deps = deps || {};
    const doFetch = (...a) => (deps.fetch || globalThis.fetch).apply(globalThis, a);
    const nowIso = () => new Date(deps.now ? deps.now() : Date.now()).toISOString();
    const uuid = deps.uuid || defaultUuid;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const backoff = deps.backoff || [400, 1500];
    const listeners = new Set();

    function emit(ev) { listeners.forEach((fn) => { try { fn(ev); } catch (e) { /* a listener must never break a request */ } }); }
    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    function offlineError(cause) {
      const e = new Error(OFFLINE_MESSAGE);
      e.offline = true; e.status = 0; e.cause = cause;
      return e;
    }

    // One request with up to two repeats on a network failure (or a gateway error). `init.body` is reused as is, which is safe because
    // it is a string or a FormData holding the same client_id each time.
    async function request(path, init, op) {
      let lastErr = null;
      for (let attempt = 0; attempt <= backoff.length; attempt++) {
        if (attempt > 0) await sleep(backoff[attempt - 1]);
        let res;
        try {
          res = await doFetch(path, Object.assign({ credentials: "same-origin" }, init));
        } catch (e) {
          lastErr = offlineError(e);
          continue;
        }
        const ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
        let data = null;
        try { data = ct.includes("json") ? await res.json() : await res.text(); } catch (e) { data = null; }
        if (res.ok) return data;
        if (RETRY_STATUSES.includes(res.status)) {
          if (res.status === 503 && data && data.error === "offline") lastErr = offlineError(null);
          else { lastErr = new Error((data && data.error) || "The server is busy. Try again in a moment."); lastErr.status = res.status; }
          continue;
        }
        const msg = (data && data.error) || (res.status === 401 ? "Your session ended. Please log in again."
          : res.status === 403 ? "You are not allowed to do that." : res.status === 404 ? "That could not be found."
            : res.status === 413 ? "That file is too big." : "Something went wrong.");
        const err = new Error(msg);
        err.status = res.status; err.data = data;
        if (res.status === 401) err.auth = true;
        throw err;
      }
      throw lastErr || offlineError(null);
    }

    // A call that changes something: announce it, run it, announce the outcome.
    async function mutate(kind, ctx, path, init) {
      const op = Object.assign({ kind }, ctx);
      emit({ type: "sending", op });
      try {
        const data = await request(path, init, op);
        emit({ type: "sent", op });
        return data;
      } catch (e) {
        emit({ type: "failed", op, error: e });
        throw e;
      }
    }

    const jsonInit = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const enc = encodeURIComponent;
    const clean = (o) => { const r = {}; Object.keys(o).forEach((k) => { if (o[k] !== undefined) r[k] = o[k]; }); return r; };
    const str = (v) => (v == null ? undefined : String(v));
    const num = (v) => (v === "" || v == null ? null : Number(v));

    // ------------------------------------------------------------------ audits
    // opts.clientId lets a screen keep one id across repeated taps of "Start audit". Returns {audit, items, existing?, client_id}.
    async function start({ placeId, clientId, startedAt }) {
      const client_id = clientId || uuid();
      const data = await mutate("start", { clientId: client_id, placeId }, "/api/audits",
        jsonInit("POST", { place_id: Number(placeId), client_id, started_at: startedAt || nowIso() }));
      return Object.assign({}, data, { client_id });
    }
    function list(params) {
      const q = new URLSearchParams();
      Object.keys(params || {}).forEach((k) => { if (params[k] != null && params[k] !== "") q.set(k, params[k]); });
      const s = q.toString();
      return request("/api/audits" + (s ? "?" + s : ""), { method: "GET" });
    }
    function get(id) { return request("/api/audits/" + enc(id), { method: "GET" }); }

    // PUT is naturally repeatable (addressed by audit and chemical), so the repeat is safe. marked_at is fixed before the first try.
    function markItem(auditId, chemicalId, f) {
      f = f || {};
      const body = clean({
        result: f.result, note: f.note == null ? undefined : String(f.note),
        new_quantity: f.result === "changed" && f.newQuantity !== undefined ? num(f.newQuantity) : undefined,
        new_unit: f.result === "changed" ? (f.newUnit || null) : undefined,
        new_container_note: f.result === "changed" ? str(f.newContainerNote) : undefined,
        marked_at: f.markedAt || nowIso(),
      });
      return mutate("answer", { auditId, chemicalId, result: f.result }, `/api/audits/${enc(auditId)}/items/${enc(chemicalId)}`, jsonInit("PUT", body));
    }

    function readLabel(auditId, blob) {
      const fd = new FormData();
      fd.append("image", blob, "label.jpg");
      return request(`/api/audits/${enc(auditId)}/found/read-label`, { method: "POST", body: fd });
    }
    function matchFound(auditId, { productName, supplier }) {
      return request(`/api/audits/${enc(auditId)}/found/match`, jsonInit("POST", { product_name: productName || "", supplier: supplier || "" }));
    }
    // Returns {found, chemical_id?, finding_id?, next?, client_id}. Pass clientId to keep one id across repeats (and to attach a photo to it).
    async function addFound(auditId, f) {
      const client_id = f.clientId || uuid();
      const body = clean({
        client_id, product_name: f.productName, supplier: f.supplier ? String(f.supplier) : undefined, source: f.source || "typed",
        found_at: f.foundAt || nowIso(), note: f.note ? String(f.note) : undefined, action: f.action || "record",
        matched_chemical_id: f.matchedChemicalId != null ? Number(f.matchedChemicalId) : undefined,
        unchecked: f.unchecked ? true : undefined,
      });
      const data = await mutate("found", { auditId, clientId: client_id }, `/api/audits/${enc(auditId)}/found`, jsonInit("POST", body));
      return Object.assign({}, data, { client_id });
    }
    async function addDisposal(auditId, f) {
      const client_id = f.clientId || uuid();
      const body = clean({
        client_id, description: f.description, reason: f.reason, note: f.note ? String(f.note) : undefined,
        chemical_id: f.chemicalId != null ? Number(f.chemicalId) : undefined, flagged_at: f.flaggedAt || nowIso(),
      });
      const data = await mutate("disposal", { auditId, clientId: client_id }, `/api/audits/${enc(auditId)}/disposals`, jsonInit("POST", body));
      return Object.assign({}, data, { client_id });
    }
    // {blob, ownerType, ownerKey, takenAt, width, height, clientId?}. Returns the server's photo row plus client_id.
    async function addPhoto(auditId, f) {
      const client_id = f.clientId || uuid();
      const fd = new FormData();
      fd.append("file", f.blob, "photo.jpg");
      fd.append("client_id", client_id);
      fd.append("owner_type", f.ownerType);
      if (f.ownerKey != null) fd.append("owner_key", String(f.ownerKey));
      fd.append("taken_at", f.takenAt || nowIso());
      if (f.width) fd.append("width", String(f.width));
      if (f.height) fd.append("height", String(f.height));
      const data = await mutate("photo", { auditId, clientId: client_id, ownerType: f.ownerType, ownerKey: f.ownerKey }, `/api/audits/${enc(auditId)}/photos`, { method: "POST", body: fd });
      return Object.assign({}, data, { client_id });
    }
    function finish(auditId, f) {
      f = f || {};
      return mutate("finish", { auditId }, `/api/audits/${enc(auditId)}/finish`,
        jsonInit("POST", clean({ finished_at: f.finishedAt || nowIso(), notes: f.notes ? String(f.notes) : undefined })));
    }

    function photoUrl(photoId) { return "/api/audit-photos/" + enc(photoId); }
    // Work not yet sent. Online-only: every call is sent (or fails visibly) before the screen moves on, so this is always zero.
    function pending() { return { answers: 0, photos: 0, other: 0, failed: 0, total: 0, bytes: 0 }; }
    // Offline outbox contract (replaced by the offline wrapper). Online-only: nothing is ever local or queued.
    const isLocalId = (id) => /^local-/.test(String(id == null ? "" : id));
    const serverId = (id) => (isLocalId(id) ? null : id);
    const queue = () => [];
    const sendNow = async () => {};
    const discardAll = async () => {};

    return { start, list, get, markItem, readLabel, matchFound, addFound, addDisposal, addPhoto, finish, photoUrl, pending, isLocalId, serverId, queue, sendNow, discardAll, onChange, OFFLINE_MESSAGE };
  }

  return { create, defaultUuid, OFFLINE_MESSAGE };
});
