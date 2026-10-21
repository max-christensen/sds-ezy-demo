// A fake audit server (enforcing client_id uniqueness like the real one) and a test rig around the outbox. Not a test file.
import { createRequire } from 'node:module';
import { FakeIndexedDB, json } from './offline-fakes.mjs';

const require = createRequire(import.meta.url);
export const { createOutbox } = require('../public/lib/audit-outbox.js');
export const { createStore } = require('../public/lib/audit-store.js');
const clientFactory = require('../public/lib/audit-client.js');

export const PLACE = {
  place: { id: 3, name: 'Ute 1', place_type: 'vehicle', registration: 'TWD 001', archived: 0 },
  chemicals: [
    { link_id: 1, chemical_id: 11, product_name: 'Acetone', supplier: 'A Co', quantity: 5, unit: 'L', container_note: '5 L can', sds_id: 21, has_assessment: true, review_status: 'ok', risk_level: 'high' },
    { link_id: 2, chemical_id: 12, product_name: 'Bleach', supplier: 'B Co', quantity: null, unit: null, sds_id: null, has_assessment: false, review_status: 'no_sds' }
  ],
  result: {}
};

export class FakeAuditServer {
  constructor() { this.audits = []; this.found = []; this.disposals = []; this.photos = []; this.calls = []; this.down = false; this.authFail = false; this.rules = []; this.nextId = 100; this.userId = 5; }
  // Make the server process a request but lose the answer (the page sees a network failure).
  loseNextResponse(n = 1) { this.loseCount = n; }
  rejectWhen(fn, status, message) { this.rules.push({ fn, status, message }); }
  async handle(path, init = {}) {
    const method = init.method || 'GET';
    this.calls.push(method + ' ' + path);
    if (this.down) throw new TypeError('Failed to fetch');
    const res = this.authFail ? json({ error: 'Not logged in' }, 401) : this.route(method, path, init);
    if (this.loseCount > 0 && method !== 'GET') { this.loseCount--; throw new TypeError('Failed to fetch'); }
    return res;
  }
  body(init) { return typeof init.body === 'string' ? JSON.parse(init.body) : init.body; }
  route(method, path, init) {
    const u = new URL(path, 'http://x'), p = u.pathname;
    for (const r of this.rules) if (r.fn(method, p, init)) return json({ error: r.message }, r.status);
    let m;
    if (method === 'GET' && p === '/api/audits') return json(this.audits.filter((a) => !u.searchParams.get('place_id') || String(a.audit.place_id) === u.searchParams.get('place_id')).map((a) => a.audit));
    if (method === 'POST' && p === '/api/audits') {
      const b = this.body(init);
      let a = this.audits.find((x) => x.audit.client_id === b.client_id);
      if (a) return json({ audit: a.audit, items: a.items });
      const other = this.audits.find((x) => x.audit.place_id === b.place_id && x.audit.status === 'in_progress');
      if (other) return json({ audit: other.audit, items: other.items, existing: true });
      const id = this.nextId++;
      a = { audit: { id, client_id: b.client_id, place_id: b.place_id, place_name: PLACE.place.name, place_type: 'vehicle', started_at: b.started_at, status: 'in_progress', finished_at: null, started_by_name: 'Sam' },
        items: PLACE.chemicals.map((c) => ({ audit_id: id, chemical_id: c.chemical_id, product_name: c.product_name, result: null })) };
      this.audits.push(a);
      return json({ audit: a.audit, items: a.items }, 201);
    }
    if ((m = /^\/api\/audits\/(\d+)(\/.*)?$/.exec(p))) {
      const a = this.audits.find((x) => String(x.audit.id) === m[1]);
      if (!a) return json({ error: 'Audit not found' }, 404);
      const rest = m[2] || '';
      if (method === 'GET' && !rest) return json({ audit: a.audit, items: a.items, found: this.found.filter((f) => f.audit_id === a.audit.id), disposals: this.disposals.filter((f) => f.audit_id === a.audit.id), findings: [], photos: this.photos.filter((f) => f.audit_id === a.audit.id) });
      const im = /^\/items\/(\d+)$/.exec(rest);
      if (method === 'PUT' && im) {
        const it = a.items.find((i) => String(i.chemical_id) === im[1]);
        if (!it) return json({ error: 'That chemical is not part of this audit' }, 404);
        const b = this.body(init);
        if (!['present', 'not_found', 'changed'].includes(b.result)) return json({ error: 'result is required: present, not_found or changed' }, 400);
        if (a.audit.status !== 'in_progress') return json({ error: 'This audit is finished' }, 409);
        Object.assign(it, { result: b.result, note: b.note || null, marked_at: b.marked_at, new_quantity: b.new_quantity ?? null });
        return json({ item: it });
      }
      if (method === 'POST' && rest === '/found') {
        const b = this.body(init);
        let f = this.found.find((x) => x.audit_id === a.audit.id && x.client_id === b.client_id);
        if (!f) { f = { id: this.nextId++, audit_id: a.audit.id, client_id: b.client_id, product_name: b.product_name, note: b.note, action: b.action, outcome: b.action === 'link' ? 'link_suggested' : 'recorded' }; this.found.push(f); }
        return json({ found: f });
      }
      if (method === 'POST' && rest === '/disposals') {
        const b = this.body(init);
        let f = this.disposals.find((x) => x.audit_id === a.audit.id && x.client_id === b.client_id);
        if (!f) { f = { id: this.nextId++, audit_id: a.audit.id, client_id: b.client_id, description: b.description, reason: b.reason }; this.disposals.push(f); }
        return json({ disposal: f });
      }
      if (method === 'POST' && rest === '/photos') {
        const fd = init.body;
        const cid = fd.get('client_id');
        let f = this.photos.find((x) => x.audit_id === a.audit.id && x.client_id === cid);
        if (!f) { f = { id: this.nextId++, audit_id: a.audit.id, client_id: cid, owner_type: fd.get('owner_type'), owner_key: fd.get('owner_key'), bytes: fd.get('file').size, taken_at: fd.get('taken_at') }; this.photos.push(f); }
        return json({ photo: f, id: f.id });
      }
      if (method === 'POST' && rest === '/finish') {
        const b = this.body(init);
        if (a.audit.status !== 'finished') { a.audit.status = 'finished'; a.audit.finished_at = b.finished_at; }
        return json({ audit: a.audit, summary: { listed: a.items.length } });
      }
    }
    return json({ error: 'Not found' }, 404);
  }
}

// A phone: one IndexedDB, one signed-in person, one outbox. Make a second rig over the same `idb` to simulate the page dying and reopening.
export function rig({ idb = new FakeIndexedDB(), server = new FakeAuditServer(), user = { id: 5, name: 'Sam' }, online = true, place = PLACE, choose, estimate, timers: customTimers } = {}) {
  const env = { idb, server, user, online, notes: [], place };
  const store = createStore({ indexedDB: idb });
  const fetch = (path, init) => server.handle(path, init);
  const orig = clientFactory.create({ fetch, sleep: async () => {}, backoff: [0, 0] });
  const timers = customTimers || { setTimeout: () => null, clearTimeout() {}, setInterval: () => null, clearInterval() {} };
  let n = 0;
  const { api, internals } = createOutbox({
    client: orig, store, timers,
    uuid: () => 'u' + String(++n + (env.uuidBase || 0)).padStart(4, '0'),
    getUser: () => env.user, isOnline: () => env.online,
    fetchPlace: async (id) => (env.online && !server.down ? { ...env.place } : env.cachedPlace === undefined ? (env.place ? { ...env.place } : null) : env.cachedPlace),
    probe: () => orig.list({ limit: 1 }),
    notify: (m) => env.notes.push(m),
    choose: async (info) => (choose ? choose(info) : 'cancel'),
    estimate,
    objectUrl: () => 'blob:test'
  });
  env.api = api; env.ob = internals; env.store = store; env.orig = orig;
  env.offline = () => { env.online = false; server.down = true; };
  env.goOnline = () => { env.online = true; server.down = false; };
  return env;
}
export const photoBlob = (n = 2000) => new Blob([new Uint8Array(n).fill(0xff)], { type: 'image/jpeg' });
