/* SDS EZY: on-phone storage for offline audits (IndexedDB database `sdsezy-audit-v1`).
 *
 * Stores:  audits  last server copy of each audit (plus audits that only exist on this phone), keyed by id
 *          ops     the send queue, ordered by an auto sequence (`seq`)
 *          photos  the compressed JPEG Blob for a photo op, keyed by its client_id
 *          meta    small facts (the local -> server id map, one note per other person)
 * Every record carries `user_id`, the signed-in person it belongs to; nothing here is ever shown or sent for another person.
 *
 * The code uses only a small part of the IndexedDB API (open, createObjectStore, transaction, put/get/delete/getAll/clear on
 * objectStore) so a plain in-memory fake can stand in for tests: createStore({indexedDB}).
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else { const L = (root.SDSLib = root.SDSLib || {}); L.auditStore = m; }
})(typeof self !== "undefined" ? self : this, function () {
  const DB_NAME = "sdsezy-audit-v1";
  const STORES = { audits: { keyPath: "id" }, ops: { keyPath: "seq", autoIncrement: true }, photos: { keyPath: "client_id" }, meta: { keyPath: "key" } };

  function createStore(deps) {
    const idb = deps.indexedDB;
    const name = deps.name || DB_NAME;
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          Object.keys(STORES).forEach((s) => { if (!db.objectStoreNames || !db.objectStoreNames.contains(s)) db.createObjectStore(s, STORES[s]); });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error || new Error("Could not open the audit store.")); };
      });
      return dbPromise;
    }

    // Run fn(stores) inside one transaction; resolves with fn's value when the transaction has completed.
    async function tx(names, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(names, mode);
        const stores = {};
        names.forEach((n) => { stores[n] = t.objectStore(n); });
        let out;
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error || new Error("Audit store error."));
        t.onabort = () => reject(t.error || new Error("Audit store aborted."));
        try { Promise.resolve(fn(stores, (v) => { out = v; })).catch(reject); } catch (e) { reject(e); }
      });
    }
    const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

    const forUser = (rows, userId) => (userId == null ? rows : rows.filter((r) => String(r.user_id) === String(userId)));

    return {
      // ---- audits
      async getAudit(id) { let v; await tx(["audits"], "readonly", async (s, set) => { v = await wrap(s.audits.get(String(id))); set(v); }); return v || null; },
      async putAudit(rec) { await tx(["audits"], "readwrite", (s) => { s.audits.put(Object.assign({}, rec, { id: String(rec.id) })); }); },
      async deleteAudit(id) { await tx(["audits"], "readwrite", (s) => { s.audits.delete(String(id)); }); },
      async listAudits(userId) { let v; await tx(["audits"], "readonly", async (s, set) => { v = await wrap(s.audits.getAll()); set(v); }); return forUser(v || [], userId); },

      // ---- ops (the queue)
      async addOp(op) { let key; await tx(["ops"], "readwrite", async (s) => { key = await wrap(s.ops.put(Object.assign({}, op))); }); return key; },
      async putOp(op) { await tx(["ops"], "readwrite", (s) => { s.ops.put(Object.assign({}, op)); }); },
      async getOp(seq) { let v; await tx(["ops"], "readonly", async (s, set) => { v = await wrap(s.ops.get(seq)); set(v); }); return v || null; },
      async deleteOp(seq) { await tx(["ops"], "readwrite", (s) => { s.ops.delete(seq); }); },
      async listOps(userId) {
        let v; await tx(["ops"], "readonly", async (s, set) => { v = await wrap(s.ops.getAll()); set(v); });
        return forUser(v || [], userId).sort((a, b) => a.seq - b.seq);
      },

      // ---- photos (Blob by client_id)
      async putPhoto(rec) { await tx(["photos"], "readwrite", (s) => { s.photos.put(Object.assign({}, rec)); }); },
      async getPhoto(clientId) { let v; await tx(["photos"], "readonly", async (s, set) => { v = await wrap(s.photos.get(String(clientId))); set(v); }); return v || null; },
      async deletePhoto(clientId) { await tx(["photos"], "readwrite", (s) => { s.photos.delete(String(clientId)); }); },
      async listPhotos(userId) { let v; await tx(["photos"], "readonly", async (s, set) => { v = await wrap(s.photos.getAll()); set(v); }); return forUser(v || [], userId); },

      // ---- meta
      async getMeta(key) { let v; await tx(["meta"], "readonly", async (s, set) => { v = await wrap(s.meta.get(key)); set(v); }); return v ? v.value : undefined; },
      async setMeta(key, value) { await tx(["meta"], "readwrite", (s) => { s.meta.put({ key, value }); }); },

      // ---- whole-person operations
      // Everything one person has stored: removed when they choose "Discard and sign out". Other people's records are left alone.
      async clearUser(userId) {
        await tx(["audits", "ops", "photos"], "readwrite", async (s) => {
          for (const store of ["audits", "ops", "photos"]) {
            const rows = await wrap(s[store].getAll());
            const key = STORES[store].keyPath;
            rows.filter((r) => String(r.user_id) === String(userId)).forEach((r) => s[store].delete(r[key]));
          }
        });
      },
      // User ids (as strings) that own any queued op or photo: used to notice another person's unsent data.
      async usersWithOps() {
        const ops = await this.listOps(null);
        return Array.from(new Set(ops.filter((o) => o.status !== "done").map((o) => String(o.user_id))));
      },
    };
  }

  return { createStore, DB_NAME };
});
