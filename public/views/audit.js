/* The audit run screen (#/audit/:id): one card per chemical, three big answer buttons, notes, photos, disposals, finish.
   Answers save as the person taps (optimistic). Every call goes through SDSLib.auditClient. A finished audit opens read-only. */
(function () {
  'use strict';
  const App = window.App;
  const esc = App.esc;
  // Load only what is not there yet: index.html already loads photo.js and audit-client.js, and a second copy would replace the live client.
  const NEED = {'/lib/audit-model.js': 'auditModel', '/lib/audit-client.js': 'auditClient', '/lib/photo.js': 'photo'};
  const libs = () => Promise.all(['/lib/audit-model.js', '/lib/audit-client.js', '/lib/photo.js'].filter((s) => !(window.SDSLib && window.SDSLib[NEED[s]])).map((s) => App.loadScript(s)));
  const CAM_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const fmtQty = (q) => Number(q).toLocaleString(undefined, { maximumFractionDigits: 3 });

  // ---- busy flag shared with the app (a service worker update must wait while a photo is going up or a finish is running)
  let busyN = 0;
  function syncBusy() {
    let sending = false;
    try { const L = window.SDSLib; sending = L.auditModel.isSending(L.auditClient.queue()); } catch (e) { sending = false; }
    App.busy = busyN > 0 || sending;
  }
  function busy(delta) { busyN = Math.max(0, busyN + delta); syncBusy(); }

  App.views.register('audit', {
    title: 'Audit',
    async render(root, params) {
      await libs();
      const M = window.SDSLib.auditModel, client = window.SDSLib.auditClient, P = window.SDSLib.photo;
      M.ensureCss();
      let id = params.id;                        // may be a local id (local-<uuid>) until the start op has been sent
      const qNow = () => { try { return client.queue() || []; } catch (e) { return []; } };
      const pendNow = () => { try { return client.pending() || {}; } catch (e) { return {}; } };
      const idList = () => [params.id, id];
      root.innerHTML = App.loadingHtml('Loading audit...');
      let d;
      try { d = await client.get(id); }
      catch (err) {
        if (err.status === 404) { root.innerHTML = '<div class="empty-state"><h2>Audit not found</h2><p>It may belong to someone else.</p><a class="btn primary" href="#/places">Choose a place</a></div>'; return; }
        throw err;
      }
      const audit = d.audit;
      const readOnly = audit.status !== 'in_progress';
      d.found = d.found || []; d.disposals = d.disposals || []; d.photos = d.photos || [];
      const items = M.sortItems(d.items || []);
      const byChem = new Map(items.map((i) => [String(i.chemical_id), i]));
      const ui = new Map();                       // chemical id -> {state, err, draft, saving, dirty}
      const U = (cid) => { cid = String(cid); if (!ui.has(cid)) ui.set(cid, { state: '', err: '', draft: false, saving: false, dirty: false }); return ui.get(cid); };
      const uploads = [];                         // photos on their way or failed: {key, ownerType, ownerKey, blob, ..., status, error}
      const localThumb = {};                      // photo id -> object URL of the blob we just sent
      const inflight = new Set();
      let gone = false;
      App.onLeave(() => { gone = true; });
      const offChange = client.onChange((ev) => onClientEvent(ev));
      App.onLeave(() => { offChange(); syncBusy(); });
      const track = (p) => { inflight.add(p); p.then(() => inflight.delete(p), () => inflight.delete(p)); return p; };
      const uuid = () => window.SDSLib.auditClientFactory.defaultUuid();

      document.title = audit.place_name + ' audit - ' + App.companyName();
      root.innerHTML = `<div class="au-head" id="auHead"></div><div class="au-prog" id="auProg"><div id="auProgIn"></div><div id="auUnsent"></div></div><div id="auExtras"></div><div id="auCards"></div><div id="auPhotoStrip"></div>
        <div class="au-bar no-print" id="auBar"${readOnly ? ' hidden' : ''}></div>`;
      const q = (s) => root.querySelector(s);

      // ------------------------------------------------------------------ header, unsent notice
      function drawHead() {
        const p = M.progress(items);
        q('#auProgIn').innerHTML = `<div class="au-count" role="status">${esc(M.progressText(p))}</div>
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.marked}" aria-label="Chemicals marked"><i style="width:${p.pct}%"></i></div>`;
        q('#auHead').innerHTML = `<a class="crumb" href="#/place/${esc(audit.place_id)}">&larr; ${esc(audit.place_name)}</a>
          <h1>${readOnly ? 'Audit (finished)' : 'Audit'}: ${esc(audit.place_name)}</h1>
          <div class="au-sub">${esc(App.fmtDate(audit.started_at))} &middot; started by ${esc(audit.started_by_name)}${audit.place_registration ? ' &middot; ' + esc(audit.place_registration) : ''}</div>
          ${readOnly ? `<p class="au-ro">This audit is finished and cannot be changed. <a href="#/audit/${esc(id)}/report">View the report</a> &middot; <a href="#/audit/${esc(id)}/summary">Summary</a></p>` : ''}`;
      }
      function unsentCounts() {
        let answers = 0, photos = 0;
        ui.forEach((u) => { if (u.state === 'error') answers++; });
        uploads.forEach((u) => { if (u.status === 'failed') photos++; });
        return { answers, photos, other: 0 };
      }
      function drawUnsent() {
        const c = unsentCounts(), p = pendNow();
        const sum = { answers: c.answers + (p.answers || 0), photos: c.photos + (p.photos || 0), other: (p.other || 0), failed: p.failed || 0 };
        const t = M.headerText(sum), anyQueued = M.pendingTotal(p) > 0 || qNow().length > 0;
        const online = App.isOnline();
        const off = !online && !readOnly ? '<div class="au-unsent" role="status" style="background:var(--office-bg);color:var(--ink);border-color:var(--office)">Offline: answers are saved on this phone and sent when you have signal.</div>' : '';
        q('#auUnsent').innerHTML = off + (t ? `<div class="au-unsent" role="alert">${esc(t)} ${online && anyQueued ? '<button type="button" class="link" data-act="sendnow">Send now</button>' : ''}${c.answers || c.photos ? ' <button type="button" class="small" data-act="sendall">Try again now</button>' : ''}</div>` : '');
      }

      // ------------------------------------------------------------------ found items and disposals already on this audit
      function drawExtras() {
        const f = d.found, x = d.disposals;
        if (!f.length && !x.length) { q('#auExtras').innerHTML = ''; return; }
        q('#auExtras').innerHTML = `<details class="card" style="padding:12px 14px"><summary style="font-weight:700;min-height:28px;cursor:pointer">${[f.length ? 'Found items (' + f.length + ')' : '', x.length ? 'Flagged for disposal (' + x.length + ')' : ''].filter(Boolean).join(' · ')}</summary>
          ${f.length ? `<h2>Found items (${f.length})</h2><ul class="au-list">${f.map((r) => `<li><strong>${esc(r.product_name)}</strong>${r.supplier ? ' &middot; ' + esc(r.supplier) : ''}<br><span class="muted">${esc(M.foundOutcomeText(r.outcome, App.isAdmin()))}${r.unsent ? ' &middot; not sent yet' : ''}${r.unchecked ? ' &middot; unchecked' : ''}</span></li>`).join('')}</ul>` : ''}
          ${x.length ? `<h2${f.length ? ' style="margin-top:14px"' : ''}>Flagged for disposal (${x.length})</h2><ul class="au-list">${x.map((r) => `<li><strong>${esc(r.description)}</strong><br><span class="muted">${esc(M.REASON_LABEL[r.reason] || r.reason)}${r.status === 'disposed' ? ' &middot; disposed' : ''}${r.unsent ? ' &middot; not sent yet' : ''}</span></li>`).join('')}</ul>` : ''}</details>`;
      }

      // ------------------------------------------------------------------ one card
      const photosFor = (cid) => d.photos.filter((p) => p.owner_type === 'item' && String(p.owner_key) === String(cid));
      const uploadsFor = (cid) => uploads.filter((u) => u.ownerType === 'item' && String(u.ownerKey) === String(cid));
      function photoHtml(cid, name) {
        const sent = photosFor(cid), pend = uploadsFor(cid);
        const srcOf = (p) => localThumb[p.id] || p.local_url || p.url || client.photoUrl(p.id);
        const qn = qNow();
        const thumbs = sent.map((p) => `<button type="button" class="au-ph" data-view="${esc(srcOf(p))}" aria-label="View photo of ${esc(name)}"><img src="${esc(srcOf(p))}" alt="Photo of ${esc(name)}" loading="lazy">${M.isUnsentPhoto(qn, p) ? '<span class="au-phs">Not sent yet</span>' : ''}</button>`).join('')
          + pend.map((u) => `<div class="au-ph${u.status === 'failed' ? ' err' : ''}">${u.url ? `<img src="${esc(u.url)}" alt="Photo being sent">` : ''}<span class="au-phs">${u.status === 'failed' ? 'Not sent' : u.status === 'sending' ? 'Sending...' : 'Preparing...'}</span>${u.status === 'failed' ? `<button type="button" class="small" style="position:absolute;inset:0;opacity:0" data-act="retryphoto" data-key="${esc(u.key)}" aria-label="Try sending this photo again">Retry</button>` : ''}</div>`).join('');
        const count = sent.length + pend.length;
        const can = !readOnly && count < M.MAX_PHOTOS_PER_OWNER;
        const failed = pend.filter((u) => u.status === 'failed');
        return `<div class="au-photos">${thumbs}${can ? `<button type="button" class="au-cam" data-act="cam" aria-label="Take a photo of ${esc(name)}">${CAM_SVG}<span>Photo</span></button>` : ''}</div>
          ${failed.map((u) => `<div class="au-state err">${esc(u.error || 'Photo not sent.')} <button type="button" class="small" data-act="retryphoto" data-key="${esc(u.key)}">${u.blob ? 'Try again' : 'Dismiss'}</button></div>`).join('')}
          ${count ? '<p class="hint">Photos can\'t be removed once sent.</p>' : ''}`;
      }
      function stateHtml(cid) {
        const u = U(cid);
        const qs = M.cardState(qNow(), idList(), cid);
        if (qs.state && u.state !== 'saving' && u.state !== 'edited' && u.state !== 'error') {
          return esc(M.cardStateText(qs)) + (qs.state === 'failed' ? ' <button type="button" class="small" data-act="sendnow">Try again</button>' : '');
        }
        if (u.state === 'saving') return 'Saving...';
        if (u.state === 'saved') return '&#10003; Saved';
        if (u.state === 'edited') return 'Press Save change to send this.';
        if (u.state === 'error') return `Not sent yet. ${esc(u.err)} <button type="button" class="small" data-act="retry">Try again</button>`;
        return '';
      }
      function cardHtml(it) {
        const cid = it.chemical_id, u = U(cid), r = it.result;
        const showForm = !readOnly && (u.draft || r === 'changed');
        const attn = M.needsAttention(it);
        const exp = M.expectedText(it, fmtQty);
        const btn = (v) => {
          const on = r === v || (v === 'changed' && u.draft);
          return `<button type="button" data-r="${v}" aria-pressed="${on}"${readOnly ? ' disabled' : ''}>${on ? '<span class="au-tick" aria-hidden="true">&#10003;</span>' : ''}${M.RESULT_LABEL[v]}</button>`;
        };
        const roChanged = readOnly && r === 'changed' ? `<p class="au-exp">Now: ${esc([it.new_quantity != null && it.new_unit ? fmtQty(it.new_quantity) + ' ' + it.new_unit : '', it.new_container_note].filter(Boolean).join(' · ') || 'see note')}</p>` : '';
        return `<article class="au-card${attn ? ' attn' : ''}${r ? ' done-' + r : ''}" id="c${esc(cid)}" data-c="${esc(cid)}" aria-label="${esc(it.product_name)}">
          <div class="au-name">${esc(it.product_name)}</div>
          <div class="au-sup">${esc(it.supplier || 'Supplier not recorded')}</div>
          <div class="au-exp">Expected: ${exp ? esc(exp) : 'no quantity recorded'}</div>
          <div class="au-badges">${App.reviewBadge(it.review_status, it.review_due)}${it.has_assessment ? App.riskBadge(it.risk_level, true) : '<span class="badge none">No assessment</span>'}</div>
          ${readOnly
            ? `<p class="au-ro" style="margin-top:10px">${r ? esc(M.RESULT_LABEL[r]) : 'Not marked'}</p>${roChanged}${it.note ? `<p style="margin:6px 0 0">${esc(it.note)}</p>` : ''}`
            : `<div class="au-three" role="group" aria-label="Result for ${esc(it.product_name)}">${M.RESULTS.map(btn).join('')}</div>
               <div class="au-state${u.state === 'error' ? ' err' : ''}" role="status" aria-live="polite">${stateHtml(cid)}</div>
               ${showForm ? `<div class="au-form"><div class="row2"><div><label for="nq${esc(cid)}">New quantity</label><input id="nq${esc(cid)}" data-f="new_quantity" type="number" min="0" step="any" inputmode="decimal" value="${esc(it.new_quantity == null ? '' : it.new_quantity)}"></div>
                 <div><label for="nu${esc(cid)}">Unit</label><select id="nu${esc(cid)}" data-f="new_unit"><option value="">Unit</option><option value="L"${it.new_unit === 'L' ? ' selected' : ''}>L</option><option value="kg"${it.new_unit === 'kg' ? ' selected' : ''}>kg</option></select></div></div>
                 <label for="nc${esc(cid)}">New containers</label><input id="nc${esc(cid)}" data-f="new_container_note" type="text" value="${esc(it.new_container_note || '')}" placeholder="For example: 2 x 5 L drums">
                 <p class="au-state err" data-formerr role="alert" style="margin:6px 0 0"></p>
                 <button type="button" class="primary big" style="margin-top:8px" data-act="savechange">Save change</button></div>` : ''}
               <label for="nt${esc(cid)}">Note (optional)</label><textarea id="nt${esc(cid)}" data-f="note" rows="2" placeholder="Anything worth recording">${esc(it.note || '')}</textarea>`}
          ${photoHtml(cid, it.product_name)}
          ${readOnly ? '' : `<div class="au-links"><button type="button" class="link" data-act="dispose">Flag this for disposal</button></div>`}
        </article>`;
      }
      function drawCards() { q('#auCards').innerHTML = items.length ? items.map(cardHtml).join('') : `<div class="empty-state"><h2>No chemicals are listed for this place</h2><p>${readOnly ? '' : 'Use "Add a found item" below for anything you find.'}</p></div>`; }
      function refreshCard(cid) {
        const old = q(`#c${CSS.escape(String(cid))}`); if (!old) return;
        const a = document.activeElement, had = old.contains(a), key = had ? (a.dataset.r ? `[data-r="${a.dataset.r}"]` : a.dataset.act ? `[data-act="${a.dataset.act}"]` : a.id ? '#' + CSS.escape(a.id) : '') : '';
        const tmp = document.createElement('div'); tmp.innerHTML = cardHtml(byChem.get(String(cid)));
        old.replaceWith(tmp.firstElementChild);
        if (key) { const n = q(`#c${CSS.escape(String(cid))} ${key}`); if (n) n.focus({ preventScroll: true }); }
      }
      function paintState(cid) {
        const u = U(cid), el = q(`#c${CSS.escape(String(cid))} .au-state`);
        if (el) { el.className = 'au-state' + (u.state === 'error' || M.cardState(qNow(), idList(), cid).state === 'failed' ? ' err' : ''); el.innerHTML = stateHtml(cid); }
        drawUnsent();
      }

      // ------------------------------------------------------------------ saving an answer (coalesces taps made while a save is running)
      function payload(it) {
        const f = { result: it.result, note: it.note || '' };
        if (it.result === 'changed') { f.newQuantity = it.new_quantity == null || it.new_quantity === '' ? null : Number(it.new_quantity); f.newUnit = it.new_unit || null; f.newContainerNote = it.new_container_note || ''; }
        return f;
      }
      async function save(cid) {
        const it = byChem.get(String(cid)), u = U(cid);
        if (!it.result) return;
        if (u.saving) { u.dirty = true; return; }
        u.saving = true; u.state = 'saving'; paintState(cid);
        const run = (async () => {
          try {
            do { u.dirty = false; await client.markItem(id, cid, payload(it)); } while (u.dirty);
            u.state = 'saved'; u.err = '';
          } catch (e) { u.state = 'error'; u.err = e.message; }
          finally { u.saving = false; }
          paintState(cid);
        })();
        track(run);
        await run;
      }

      // ------------------------------------------------------------------ photos
      async function sendUpload(rec) {
        rec.status = 'sending'; rec.error = '';
        if (rec.ownerType === 'item') refreshCard(rec.ownerKey); else drawStrip();
        busy(1);
        try {
          const res = await client.addPhoto(id, { blob: rec.blob, ownerType: rec.ownerType, ownerKey: rec.ownerKey, takenAt: rec.takenAt, width: rec.width, height: rec.height, clientId: rec.clientId });
          const row = res.photo || res;
          const pid = row.id != null ? row.id : res.id;
          d.photos.push({ id: pid, client_id: res.client_id, owner_type: rec.ownerType, owner_key: String(rec.ownerKey == null ? '' : rec.ownerKey), taken_at: rec.takenAt, bytes: rec.blob.size, width: rec.width, height: rec.height });
          if (pid != null && rec.url) localThumb[pid] = rec.url;
          uploads.splice(uploads.indexOf(rec), 1);
        } catch (e) { rec.status = 'failed'; rec.error = e.message; }
        finally { busy(-1); }
        if (rec.ownerType === 'item') refreshCard(rec.ownerKey); else drawStrip();
        drawUnsent();
      }
      // File -> compress -> upload. The original is never kept; the compressed copy is held in memory until it is sent.
      async function addPhoto(ownerType, ownerKey, file, preset) {
        const rec = { key: uuid(), ownerType, ownerKey, status: 'preparing', error: '', clientId: uuid() };
        uploads.push(rec);
        if (ownerType === 'item') refreshCard(ownerKey); else drawStrip();
        const run = (async () => {
          try {
            const c = preset || await P.compress(file);
            Object.assign(rec, { blob: c.blob, width: c.width, height: c.height, takenAt: c.takenAt, url: URL.createObjectURL(c.blob) });
          } catch (e) { rec.status = 'failed'; rec.error = e.message; if (ownerType === 'item') refreshCard(ownerKey); else drawStrip(); drawUnsent(); return; }
          await sendUpload(rec);
        })();
        track(run);
        return run;
      }
      function drawStrip() {
        const list = uploads.filter((u) => u.ownerType !== 'item');
        q('#auPhotoStrip').innerHTML = list.length ? `<section class="card"><h2>Photos for found and flagged items</h2>${list.map((u) => `<div class="au-state${u.status === 'failed' ? ' err' : ''}">${u.status === 'failed' ? esc(u.error || 'Photo not sent.') : u.status === 'sending' ? 'Sending a photo...' : 'Preparing a photo...'} ${u.status === 'failed' ? `<button type="button" class="small" data-act="retryphoto" data-key="${esc(u.key)}">${u.blob ? 'Try again' : 'Dismiss'}</button>` : ''}</div>`).join('')}</section>` : '';
      }

      // ------------------------------------------------------------------ events on the cards
      root.addEventListener('input', (e) => {
        const el = e.target.closest('[data-f]'); if (!el) return;
        const card = el.closest('[data-c]'); const it = byChem.get(card.dataset.c);
        it[el.dataset.f] = el.value;
        if (el.dataset.f !== 'note' && it.result === 'changed') { const u = U(card.dataset.c); u.state = 'edited'; paintState(card.dataset.c); }
      });
      root.addEventListener('change', (e) => {
        const el = e.target.closest('[data-f="note"]'); if (!el) return;
        const cid = el.closest('[data-c]').dataset.c, it = byChem.get(cid);
        it.note = el.value;
        if (it.result && it.result !== 'changed') save(cid);            // already marked: send the note with the answer
        else if (it.result === 'changed' && U(cid).state !== 'edited') save(cid);
      });
      root.addEventListener('click', async (e) => {
        const view = e.target.closest('[data-view]');
        if (view) { const img = document.createElement('img'); img.src = view.dataset.view; img.alt = 'Audit photo'; img.style.cssText = 'max-width:100%;max-height:70vh;display:block;margin:0 auto'; App.modal({ title: 'Photo', body: img, buttons: [{ label: 'Close' }] }); return; }
        const act = e.target.closest('[data-act]');
        const card = e.target.closest('[data-c]');
        const rb = e.target.closest('[data-r]');
        if (rb && card && !readOnly) {
          const cid = card.dataset.c, it = byChem.get(cid), u = U(cid), v = rb.dataset.r;
          const live = card.querySelector('[data-f="note"]'); if (live) it.note = live.value;
          if (v === 'changed') { u.draft = true; refreshCard(cid); const f = q(`#nq${CSS.escape(cid)}`); if (f && it.result !== 'changed') f.focus(); return; }
          if (it.result === v && !u.draft) return;
          u.draft = false; it.result = v;
          refreshCard(cid); drawHead(); save(cid);
          return;
        }
        if (!act) return;
        const a = act.dataset.act;
        if (a === 'sendnow') { try { await client.sendNow(); } catch (err) { App.toast(err.message, 'error'); } drawUnsent(); items.forEach((it) => paintState(it.chemical_id)); return; }
        if (a === 'sendall') { await retryAll(); return; }
        if (a === 'retryphoto') {
          const rec = uploads.find((x) => x.key === act.dataset.key); if (!rec) return;
          if (!rec.blob) { uploads.splice(uploads.indexOf(rec), 1); rec.ownerType === 'item' ? refreshCard(rec.ownerKey) : drawStrip(); drawUnsent(); return; }
          track(sendUpload(rec)); return;
        }
        if (!card) return;
        const cid = card.dataset.c, it = byChem.get(cid);
        if (a === 'retry') { save(cid); return; }
        if (a === 'savechange') {
          const live = card.querySelector('[data-f="note"]'); if (live) it.note = live.value;
          const problem = M.changedProblem({ newQuantity: it.new_quantity, newUnit: it.new_unit, newContainerNote: it.new_container_note, note: it.note });
          const pe = card.querySelector('[data-formerr]'); if (pe) pe.textContent = problem;
          if (problem) return;
          it.result = 'changed'; U(cid).draft = false; U(cid).state = '';
          refreshCard(cid); drawHead(); save(cid); return;
        }
        if (a === 'cam') {
          const file = await P.pick({ capture: true });
          if (file) addPhoto('item', cid, file);
          return;
        }
        if (a === 'dispose') openDisposal(it);
      });

      // Events from the client (the offline wrapper emits sending | sent | failed | synced). Repaint what depends on them.
      let repaintTimer = null;
      function onClientEvent(ev) {
        syncBusy();
        if (gone) return;
        clearTimeout(repaintTimer);
        repaintTimer = setTimeout(() => {
          if (gone) return;
          swapToServerId();
          items.forEach((it) => paintState(it.chemical_id));
          drawUnsent();
        }, 120);
      }
      // After the start op is sent the audit has a server id: put it in the address without re-rendering (the screen keeps its state).
      function swapToServerId() {
        if (!M.isLocalId(id)) return;
        let sid = null; try { sid = client.serverId(id); } catch (e) { sid = null; }
        if (sid != null && !M.isLocalId(sid)) { id = String(sid); try { history.replaceState(null, '', '#/audit/' + encodeURIComponent(id)); } catch (e) { /* ignore */ } }
      }
      async function retryAll() {
        const jobs = [];
        ui.forEach((u, cid) => { if (u.state === 'error') jobs.push(save(cid)); });
        uploads.filter((u) => u.status === 'failed' && u.blob).forEach((u) => jobs.push(track(sendUpload(u))));
        await Promise.allSettled(jobs);
      }
      // Wait for everything in flight; true when nothing is left unsent.
      async function allSent() {
        await Promise.allSettled([...inflight]);
        const c = unsentCounts();
        if (c.answers || c.photos) { await retryAll(); await Promise.allSettled([...inflight]); }
        const c2 = unsentCounts();
        return !(c2.answers || c2.photos);
      }

      // ------------------------------------------------------------------ the bottom sheet for "Flag for disposal"
      function sheet(title, build) {
        const ov = document.createElement('div'); ov.className = 'au-sheet-ov';
        const box = document.createElement('div'); box.className = 'au-sheet'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
        ov.appendChild(box); document.body.appendChild(ov);
        const prev = document.activeElement;
        const ctl = { box, close() { document.removeEventListener('keydown', onKey, true); ov.remove(); if (prev && prev.focus) try { prev.focus(); } catch (e) { /* ignore */ } } };
        function onKey(ev) {
          if (ev.key === 'Escape') { ev.stopPropagation(); ctl.close(); }
          if (ev.key === 'Tab') {
            const f = [...box.querySelectorAll('button:not(:disabled),input,textarea,select,a[href]')].filter((x) => x.offsetParent !== null);
            if (!f.length) return;
            if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
            else if (!ev.shiftKey && document.activeElement === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
          }
        }
        document.addEventListener('keydown', onKey, true);
        ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) ctl.close(); });
        build(box, ctl);
        return ctl;
      }
      function openDisposal(it) {
        if (readOnly) return;
        const clientId = uuid();                         // one id for this sheet: a second tap or a retry cannot make a second row
        let reason = it && !it.has_sds ? 'no_sds' : '', comp = null, sending = false;
        sheet('Flag for disposal', (box, ctl) => {
          box.innerHTML = `<h2>Flag for disposal</h2>
            <label for="dsDesc">What is it?</label><input id="dsDesc" type="text" maxlength="200" value="${esc(it ? it.product_name + (it.supplier ? ' (' + it.supplier + ')' : '') : '')}" placeholder="Product, container, where it is">
            <label id="dsRl">Why?</label>
            <div class="au-reasons" role="group" aria-labelledby="dsRl">${M.REASONS.map((r) => `<button type="button" data-reason="${r.value}" aria-pressed="${reason === r.value}">${esc(r.label)}</button>`).join('')}</div>
            <label for="dsNote">Note (optional)</label><textarea id="dsNote" rows="2"></textarea>
            <div class="au-photos" id="dsPh"><button type="button" class="au-cam" id="dsCam" aria-label="Take a photo">${CAM_SVG}<span>Photo</span></button></div>
            <p class="error-text" id="dsErr" role="alert"></p>
            <div class="btn-pair"><button type="button" id="dsCancel">Cancel</button><button type="button" class="primary" id="dsSave">Flag it</button></div>`;
          const b = (s) => box.querySelector(s);
          b('#dsDesc').focus();
          box.addEventListener('click', async (ev) => {
            const rb = ev.target.closest('[data-reason]');
            if (rb) { reason = rb.dataset.reason; box.querySelectorAll('[data-reason]').forEach((x) => x.setAttribute('aria-pressed', String(x === rb))); return; }
            if (ev.target.closest('#dsCancel')) { ctl.close(); return; }
            if (ev.target.closest('#dsCam')) {
              const f = await P.pick({ capture: true }); if (!f) return;
              try { comp = await P.compress(f); } catch (e) { b('#dsErr').textContent = e.message; return; }
              b('#dsPh').innerHTML = `<div class="au-ph"><img src="${URL.createObjectURL(comp.blob)}" alt="Photo to send with this item"></div>`;
              return;
            }
            if (ev.target.closest('#dsSave')) {
              if (sending) return;
              const description = b('#dsDesc').value.trim();
              if (!description) { b('#dsErr').textContent = 'Say what the item is.'; b('#dsDesc').focus(); return; }
              if (!reason) { b('#dsErr').textContent = 'Choose a reason.'; return; }
              sending = true; b('#dsSave').disabled = true; b('#dsErr').textContent = ''; busy(1);
              try {
                const res = await client.addDisposal(id, { description, reason, note: b('#dsNote').value.trim(), chemicalId: it ? it.chemical_id : undefined, clientId });
                d.disposals.push(res.disposal || { description, reason, status: 'to_dispose', client_id: clientId });
                drawExtras();
                if (comp) addPhoto('disposal', clientId, null, comp);
                ctl.close(); App.toast('Flagged for disposal.', 'ok');
              } catch (e) { b('#dsErr').textContent = e.message + (e.offline ? ' Try again when you have signal.' : ''); b('#dsSave').disabled = false; sending = false; }
              finally { busy(-1); }
            }
          });
        });
      }

      // ------------------------------------------------------------------ bottom actions and finishing
      async function goFound() {
        if (!await allSent()) { App.toast('Some answers or photos have not been sent. Fix that first, so nothing is lost.', 'error'); return; }
        App.navigate('#/audit/' + id + '/found');
      }
      async function finishAudit() {
        if (!await allSent()) { App.toast('Some answers or photos have not been sent yet. Check your signal and press Try again.', 'error'); return; }
        const unmarked = M.progress(items).unmarked;
        const body = document.createElement('div');
        body.innerHTML = `${unmarked ? `<div class="notice warn" role="alert">${esc(M.unmarkedWarning(unmarked))}</div>` : ''}
          <p style="margin:0 0 8px">Once finished, this audit cannot be changed.</p>
          <label for="finNotes">Notes about the whole audit (optional)</label><textarea id="finNotes" rows="2"></textarea>`;
        App.modal({ title: unmarked ? 'Finish with ' + unmarked + ' not marked?' : 'Finish this audit?', body, buttons: [
          { label: 'Keep going' },
          { label: 'Finish audit', kind: 'primary', onClick: async () => {
            busy(1);
            try { await client.finish(id, { notes: body.querySelector('#finNotes').value.trim() }); }
            finally { busy(-1); }
            App.navigate('#/audit/' + id + '/summary');
          } },
        ] });
      }
      q('#auBar').innerHTML = `<button type="button" id="bFound">Add a found item</button><button type="button" id="bDisp">Flag for disposal</button><button type="button" class="primary au-finish" id="bFinish">Finish audit</button>`;
      q('#bFound').addEventListener('click', goFound);
      q('#bDisp').addEventListener('click', () => openDisposal(null));
      q('#bFinish').addEventListener('click', finishAudit);
      window.addEventListener('beforeunload', onUnload);
      App.onLeave(() => window.removeEventListener('beforeunload', onUnload));
      function onUnload(ev) { if (!gone && (busyN > 0 || unsentCounts().answers || unsentCounts().photos)) { ev.preventDefault(); ev.returnValue = ''; } }

      drawHead(); drawUnsent(); drawExtras(); drawCards(); drawStrip();
    },
  });
})();
