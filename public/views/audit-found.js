/* Add a found item (#/audit/:id/found): photograph the label, read or type the name, check the register, then link, create or record.
   The photo is kept as proof. Nothing here looks for an SDS anywhere: the register match is the only lookup. */
(function () {
  'use strict';
  const App = window.App;
  const esc = App.esc;
  // Load only what is not there yet: index.html already loads photo.js and audit-client.js, and a second copy would replace the live client.
  const NEED = {'/lib/audit-model.js': 'auditModel', '/lib/audit-client.js': 'auditClient', '/lib/photo.js': 'photo'};
  const libs = () => Promise.all(['/lib/audit-model.js', '/lib/audit-client.js', '/lib/photo.js'].filter((s) => !(window.SDSLib && window.SDSLib[NEED[s]])).map((s) => App.loadScript(s)));
  const CAM_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  let busyN = 0;
  function busy(delta) { busyN = Math.max(0, busyN + delta); App.busy = busyN > 0; }

  App.views.register('auditfound', {
    title: 'Add a found item',
    async render(root, params) {
      await libs();
      const M = window.SDSLib.auditModel, client = window.SDSLib.auditClient, P = window.SDSLib.photo;
      M.ensureCss();
      const id = params.id;
      root.innerHTML = App.loadingHtml('Loading audit...');
      let d;
      try { d = await client.get(id); }
      catch (err) {
        if (err.status === 404) { root.innerHTML = '<div class="empty-state"><h2>Audit not found</h2><a class="btn primary" href="#/places">Choose a place</a></div>'; return; }
        throw err;
      }
      const audit = d.audit;
      if (audit.status !== 'in_progress') {
        root.innerHTML = `<div class="empty-state"><h2>This audit is finished</h2><p>Items can only be added while an audit is in progress.</p><a class="btn primary" href="#/audit/${esc(id)}">Open the audit</a></div>`;
        return;
      }
      const uuid = () => window.SDSLib.auditClientFactory.defaultUuid();
      const isAdmin = App.isAdmin();

      // everything this screen holds; reset by "Add another"
      let S;
      const fresh = () => ({ foundId: uuid(), photo: null, aiName: '', aiSupplier: '', fromAi: false, readState: '', readMsg: '', name: '', supplier: '', note: '', cands: null, matchErr: '', matching: false, saving: false, result: null, readToken: 0, offline: false });
      S = fresh();

      function draw() {
        const hasName = S.name.trim().length > 0;
        root.innerHTML = `<a class="crumb" href="#/audit/${esc(id)}">&larr; Back to the audit</a>
          <div class="chem-head"><h1>Add a found item</h1><div class="muted">${esc(audit.place_name)}</div></div>
          ${S.result ? resultHtml() : `
          <section class="card">
            <h2>1. Photograph the label</h2>
            ${S.photo ? `<div class="au-photos"><div class="au-ph" style="width:96px;height:96px"><img src="${esc(S.photo.url)}" alt="The label photo you took"></div></div>` : ''}
            <button type="button" class="au-big${S.photo ? '' : ' primary'}" id="camBtn">${CAM_SVG} ${S.photo ? 'Take it again' : 'Photograph the label'}</button>
            <p class="hint">The photo is kept as proof with the audit. You can also type the name below without a photo.</p>
            <div id="readLine" role="status" aria-live="polite" style="margin-top:8px">${readLineHtml()}</div>
          </section>
          <section class="card">
            <h2>2. Name and supplier</h2>
            ${S.fromAi ? '<div class="au-check">Check this: read from the photo</div>' : ''}
            <label for="fName">Product name</label><input id="fName" type="text" maxlength="200" value="${esc(S.name)}" autocomplete="off">
            <label for="fSup">Supplier (if you can see it)</label><input id="fSup" type="text" maxlength="200" value="${esc(S.supplier)}" autocomplete="off">
            <label for="fNote">Note (optional, for example where it was)</label><textarea id="fNote" rows="2">${esc(S.note)}</textarea>
            <button type="button" class="primary au-big" id="checkBtn" style="margin-top:14px"${hasName && !S.matching ? '' : ' disabled'}>${S.matching ? 'Checking...' : 'Check the register'}</button>
          </section>
          <div id="matchArea">${matchHtml()}</div>`}`;
        wire();
      }
      function readLineHtml() {
        if (S.readState === 'reading') return 'Reading the label...';
        if (S.readState === 'offline') return `<div class="notice warn" role="status" style="margin:0">${esc(M.NO_SIGNAL_FOUND)} The photo is still kept.</div>`;
        if (S.readState === 'ok') return S.fromAi ? 'Label read. Check the name and supplier below.' : 'The label could not be read. Type the name and supplier below.';
        if (S.readState === 'fail') return `<div class="notice warn" role="alert" style="margin:0">${esc(S.readMsg)}</div>`;
        return '';
      }
      function matchHtml() {
        if (S.cands === null && !S.matchErr && !S.offline) return '';
        if (S.offline) return `<section class="card" aria-labelledby="mh"><h2 id="mh">3. Record it</h2>
          <div class="notice warn" role="status">${esc(M.NO_SIGNAL_FOUND)}</div>
          <button type="button" class="primary au-big" id="recBtn">Record it for the admin to check</button>
          <button type="button" class="au-big" id="newBtn" style="margin-top:10px" disabled aria-describedby="offWhy">This is a new product</button>
          <p class="hint" id="offWhy">Needs a signal. Adding a new product and linking to the register are not available offline.</p>
          <p class="error-text" id="saveErr" role="alert"></p></section>`;
        const cands = S.cands || [];
        return `<section class="card" aria-labelledby="mh"><h2 id="mh">3. Is it on the register?</h2>
          ${S.matchErr ? `<div class="notice warn" role="alert">${esc(S.matchErr)} You can still record it.</div>` : (cands.length ? '<p class="muted" style="margin:0 0 10px">These are on the register. Choose one if it is the same product.</p>' : '<p class="muted" style="margin:0 0 10px">Nothing on the register matches that name.</p>')}
          ${cands.map((c, i) => `<div class="au-cand${c.exact ? ' exact' : ''}"><strong>${esc(c.product_name)}</strong>${c.supplier ? `<br><span class="muted">${esc(c.supplier)}</span>` : ''}
            ${c.exact ? '<br><span class="badge ok">Exact match</span>' : ''}${c.linked_here ? ' <span class="badge none">Already kept here</span>' : ''}
            ${c.linked_here ? '<p class="hint">It is already listed for this place. Look for it in the audit list.</p>' : `<button type="button" class="${c.exact ? 'primary ' : ''}au-big" data-link="${i}">Link it to this place</button>${isAdmin ? '' : '<p class="hint">An admin will check and link it.</p>'}`}</div>`).join('')}
          <button type="button" class="au-big" id="newBtn" style="margin-top:6px">This is a new product</button>
          <p class="hint">It is added to the register as needing an SDS, and you go on to upload the SDS.</p>
          <button type="button" class="au-big" id="recBtn" style="margin-top:10px">Just record it</button>
          <p class="hint">Only noted in this audit. The register does not change.</p>
          <p class="error-text" id="saveErr" role="alert"></p></section>`;
      }
      function resultHtml() {
        const r = S.result;
        return `<section class="card" aria-live="polite">
          <h2>${esc(r.unchecked ? 'Recorded on this phone' : M.foundOutcomeText(r.outcome, isAdmin))}</h2>
          ${r.unchecked ? '<p class="muted" style="margin:0 0 6px">It is sent when you have signal, and the admin will check it.</p>' : ''}
          <p style="margin:0"><strong>${esc(r.name)}</strong>${r.supplier ? ' &middot; ' + esc(r.supplier) : ''}</p>
          ${r.photoState === 'failed' ? `<div class="notice warn" role="alert" style="margin-top:10px">The photo has not been sent. ${esc(r.photoErr)}<br><button type="button" class="small" id="retryPhoto">Send the photo again</button></div>` : ''}
          ${r.photoState === 'sending' ? '<p class="muted">Sending the photo...</p>' : ''}
          ${r.photoState === 'none' || r.photoState === 'sent' ? (S.photo ? '<p class="muted" style="margin:6px 0 0">Photo kept with the audit.</p>' : '') : ''}
          <div class="btn-pair">
            ${r.next ? `<a class="btn primary" href="${esc(r.nextHref)}">Add the SDS now</a>` : `<button type="button" class="primary" id="againBtn">Add another</button>`}
            <a class="btn" href="#/audit/${esc(id)}">Back to the audit</a></div>
          ${r.next ? '<p class="hint">Upload the safety data sheet for this product. It is attached to the new record.</p>' : ''}</section>`;
      }

      function readFields() {
        const g = (s) => root.querySelector(s);
        if (g('#fName')) { S.name = g('#fName').value; S.supplier = g('#fSup').value; S.note = g('#fNote').value; }
      }
      function wire() {
        const g = (s) => root.querySelector(s);
        const cam = g('#camBtn');
        if (cam) cam.addEventListener('click', async () => {
          const f = await P.pick({ capture: true }); if (!f) return;
          readFields();
          const token = ++S.readToken;
          S.readState = 'reading'; S.readMsg = ''; draw();
          try {
            const c = await P.compress(f);
            if (token !== S.readToken) return;
            if (S.photo && S.photo.url) URL.revokeObjectURL(S.photo.url);
            S.photo = Object.assign({ url: URL.createObjectURL(c.blob) }, c);
            S.cands = null; S.matchErr = '';
            if (!App.isOnline()) { S.offline = true; S.readState = 'offline'; draw(); return; }
            draw();
            await readLabel(token);
          } catch (e) { if (token !== S.readToken) return; S.readState = 'fail'; S.readMsg = e.message; draw(); }
        });
        ['#fName', '#fSup', '#fNote'].forEach((sel) => { const el = g(sel); if (el) el.addEventListener('input', () => {
          readFields();
          const cb = g('#checkBtn'); if (cb) cb.disabled = !S.name.trim() || S.matching;
          if (sel !== '#fNote' && S.cands !== null && !S.offline) { S.cands = null; S.matchErr = ''; const m = g('#matchArea'); if (m) m.innerHTML = ''; }
        }); });
        const cb = g('#checkBtn'); if (cb) cb.addEventListener('click', checkRegister);
        root.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => submit('link', S.cands[+b.dataset.link])));
        const nb = g('#newBtn'); if (nb) nb.addEventListener('click', () => submit('create'));
        const rb = g('#recBtn'); if (rb) rb.addEventListener('click', () => submit('record'));
        const ag = g('#againBtn'); if (ag) ag.addEventListener('click', () => { S = fresh(); draw(); });
        const rp = g('#retryPhoto'); if (rp) rp.addEventListener('click', () => sendPhoto());
      }

      async function readLabel(token) {
        try {
          const r = await client.readLabel(id, S.photo.blob);
          if (token !== S.readToken) return;
          if (r && r.ok) {
            S.aiName = String(r.product_name || '').trim(); S.aiSupplier = String(r.supplier || '').trim();
            S.fromAi = !!(S.aiName || S.aiSupplier);
            if (S.fromAi) { if (!S.name.trim()) S.name = S.aiName; if (!S.supplier.trim()) S.supplier = S.aiSupplier; }
            S.readState = 'ok';
          } else { S.readState = 'fail'; S.readMsg = (r && r.message) || 'The label could not be read automatically.'; if (!/type/i.test(S.readMsg)) S.readMsg += ' Type the name and supplier below.'; S.readMsg += ' The photo is still kept.'; }
        } catch (e) {
          if (token !== S.readToken) return;
          if (e.offline) { S.offline = true; S.readState = 'offline'; draw(); return; }
          S.readState = 'fail';
          S.readMsg = (e.offline ? 'No signal, so the label could not be read.' : e.message); if (!/type/i.test(S.readMsg)) S.readMsg += ' Type the name and supplier below.'; S.readMsg += ' The photo is still kept.';
        }
        draw();
        const n = root.querySelector('#fName'); if (n && !n.value) n.focus();
      }

      async function checkRegister() {
        readFields();
        if (!S.name.trim()) return;
        if (!App.isOnline() || S.offline) { S.offline = true; S.cands = []; draw(); return; }
        S.matching = true; S.matchErr = ''; draw();
        try {
          const r = await client.matchFound(id, { productName: S.name.trim(), supplier: S.supplier.trim() });
          S.cands = (r && r.candidates) || [];
        } catch (e) { S.cands = []; if (e.offline) { S.offline = true; S.matchErr = ''; } else S.matchErr = e.message; }
        S.matching = false; draw();
        const m = root.querySelector('#matchArea'); if (m && m.scrollIntoView) m.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }

      async function sendPhoto() {
        const r = S.result; if (!r || !S.photo) return;
        r.photoState = 'sending'; draw(); busy(1);
        try {
          await client.addPhoto(id, { blob: S.photo.blob, ownerType: 'found', ownerKey: S.foundId, takenAt: S.photo.takenAt, width: S.photo.width, height: S.photo.height, clientId: S.photoClientId });
          r.photoState = 'sent';
        } catch (e) { r.photoState = 'failed'; r.photoErr = e.message; }
        finally { busy(-1); }
        draw();
      }

      async function submit(action, cand) {
        if (S.saving) return;
        readFields();
        const err = root.querySelector('#saveErr');
        if (!S.name.trim()) return;
        const offline = S.offline || !App.isOnline();
        if (offline && action !== 'record') { if (err) err.textContent = 'Needs a signal. You can still record it for the admin to check.'; return; }
        S.saving = true; root.querySelectorAll('#matchArea button').forEach((b) => { b.disabled = true; });
        busy(1);
        try {
          // the found row first (own client_id, so a repeat is harmless), then the photo with that id as its owner_key
          const same = S.fromAi && S.name.trim() === S.aiName && S.supplier.trim() === S.aiSupplier;
          const res = await client.addFound(id, offline
            ? Object.assign({ clientId: S.foundId }, M.offlineFoundBody(S))
            : { clientId: S.foundId, productName: S.name.trim(), supplier: S.supplier.trim(), source: same ? 'ai' : 'typed', note: S.note.trim(), action, matchedChemicalId: cand ? cand.chemical_id : undefined });
          const found = res.found || {};
          const next = res.next && res.next.upload_for_chemical ? res.next : null;
          S.result = { outcome: found.outcome || (action === 'create' ? 'created' : action === 'link' ? (isAdmin ? 'linked' : 'link_suggested') : 'recorded'), name: S.name.trim(), supplier: S.supplier.trim(), next, photoState: S.photo ? 'sending' : 'none', photoErr: '', unchecked: offline };
          if (next) S.result.nextHref = `#/upload?for_chemical=${encodeURIComponent(next.upload_for_chemical)}&place=${encodeURIComponent(next.place_id || audit.place_id)}&audit=${encodeURIComponent(id)}`;
          S.photoClientId = uuid();
          busy(-1); S.saving = false;
          draw();
          if (S.photo) {
            await sendPhoto();
            if (next && S.result.photoState !== 'failed') App.navigate(S.result.nextHref);   // straight to the SDS upload
          } else if (next) App.navigate(S.result.nextHref);
          return;
        } catch (e) {
          if (err) err.textContent = e.message + (e.offline ? ' Try again when you have signal.' : '');
          root.querySelectorAll('#matchArea button').forEach((b) => { b.disabled = false; });
          busy(-1); S.saving = false;
        }
      }

      const onOnline = () => { if (S.offline && !S.result && S.readState !== 'reading') { S.offline = false; if (S.readState === 'offline') S.readState = ''; readFields(); draw(); } };
      window.addEventListener('online', onOnline);
      App.onLeave(() => window.removeEventListener('online', onOnline));
      draw();
    },
  });
})();
