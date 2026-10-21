// Job pack (#/pack): pick a place and tick its chemicals (or search the register), enter the client / job details, and build
// ONE print-ready PDF and a zip of the SDS PDFs in this browser. Nothing is sent to the server except the read requests.
// Query: ?place=&ids=&client=&ref=&date=  pre-fills (used for the demo's sample pack).
(function () {
  const App = window.App;
  const E = (s) => App.esc(s);

  const CSS = `
  .pk-step{margin:0 0 14px}
  .pk-step h2{display:flex;gap:10px;align-items:center;font-size:17px;margin:0 0 8px}
  .pk-step h2 b{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--main,#1f2a24);color:var(--on-main,#fff);font-size:15px;flex:none}
  .pk-step select,.pk-step input[type=text],.pk-step input[type=search],.pk-step input[type=date]{min-height:48px;font-size:16px;width:100%}
  .pk-list{list-style:none;margin:8px 0 0;padding:0;border:1px solid var(--border,#dad5c8);border-radius:10px;overflow:hidden;background:var(--surface,#fff)}
  .pk-list li{border-top:1px solid var(--border,#dad5c8)} .pk-list li:first-child{border-top:0}
  .pk-list label{display:flex;gap:12px;align-items:center;margin:0;min-height:56px;padding:8px 14px;cursor:pointer;color:var(--ink,#1f2a24);font-size:15px}
  .pk-list input{width:24px;height:24px;flex:none;margin:0}
  .pk-list .sup{display:block;font-size:12.5px;color:var(--muted,#8a8676)}
  .pk-tools{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
  .pk-tools button{min-height:44px}
  .pk-bar{position:sticky;bottom:0;z-index:5;background:var(--surface,#fff);border-top:2px solid var(--border,#dad5c8);padding:10px 12px;margin:14px -12px 0;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
  @media (max-width:860px){.pk-bar{bottom:calc(58px + env(safe-area-inset-bottom))}}
  .pk-bar strong{font-size:16px}
  .pk-bar button{min-height:48px;font-size:16px;padding:10px 18px}
  .pk-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}
  .pk-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border,#dad5c8);border-radius:20px;background:var(--office-bg,#e7efee);padding:4px 6px 4px 12px;font-size:13.5px}
  .pk-chip button{min-height:32px;min-width:32px;padding:0;border-radius:50%;line-height:1}
  .pk-bar2{height:12px;border-radius:6px;background:var(--border,#dad5c8);overflow:hidden;margin:8px 0}
  .pk-bar2>i{display:block;height:100%;width:0;background:var(--office,#3b6e71);transition:width .15s}
  .pk-actions{display:flex;flex-direction:column;gap:10px;margin-top:10px}
  .pk-actions button,.pk-actions a.btn{min-height:52px;font-size:16px;text-align:center;justify-content:center}
  `;
  function css() {
    if (document.getElementById('pk-css')) return;
    const st = document.createElement('style'); st.id = 'pk-css'; st.textContent = CSS; document.head.appendChild(st);
  }

  const stamp = () => App.today();
  function myPlaceId() {
    try { const m = App.myPlace && App.myPlace(); return m ? String(m.id != null ? m.id : m) : ''; } catch (e) { return ''; }
  }
  const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

  App.views.register('pack', {
    title: 'Job pack',
    async render(root, params) {
      css();
      let dead = false, running = false, cancel = false;
      App.onLeave(() => { dead = true; cancel = true; });
      const q = (params && params.query) || {};
      await App.loadScript('/lib/export-model.js');
      await App.loadScript('/lib/zip-build.js');
      await App.loadScript('/lib/pack-model.js');
      await App.loadScript('/lib/pdf-assets.js');
      const PM = window.SDSLib.packModel;
      const ref = await import('/lib/ghs-ref.mjs');

      const sel = new Map(); // chemical id -> {name, supplier}
      let places = [];
      try { places = await App.api('/places'); } catch (e) { places = []; }
      let placeId = q.place || myPlaceId();
      if (placeId && !places.some((p) => String(p.id) === String(placeId))) placeId = '';
      let placeChems = [];
      let results = [];
      const job = { client: q.client || '', jobRef: q.ref || '', date: /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : stamp() };
      const sdsCache = new Map();
      let built = null; // {pdf: Blob|null, zip: Blob|null, names}

      root.innerHTML = `<div class="topbar"><div><h1>Job pack</h1><p class="sub">Safety data sheets and risk assessments for a job, as one PDF you can send before work starts. Nothing is saved on the server.</p></div></div>
        <div id="pkBody"></div>`;
      const body = root.querySelector('#pkBody');

      // ids from the query (names fetched in one read)
      const qids = PM.parseIds(q.ids);
      if (qids.length) {
        try {
          const d = await App.api('/pack?ids=' + qids.join(','));
          (d.chemicals || []).forEach((e) => sel.set(Number(e.chemical.id), { name: e.chemical.product_name, supplier: e.chemical.supplier }));
        } catch (e) { /* the ids can still be built; names shown as numbers */ qids.forEach((id) => sel.set(id, { name: 'Chemical #' + id, supplier: '' })); }
      }
      async function loadPlace() {
        placeChems = [];
        if (!placeId) return;
        try {
          const d = await App.api('/places/' + Number(placeId));
          placeChems = d.chemicals || [];
          if (!q.ids && !sel.size && !loadPlace.touched) placeChems.forEach((c) => sel.set(Number(c.chemical_id), { name: c.product_name, supplier: c.supplier }));
        } catch (e) { placeChems = []; }
      }
      await loadPlace();

      const placeObj = () => places.find((p) => String(p.id) === String(placeId)) || null;

      function draw() {
        if (dead) return;
        const p = placeObj();
        const keep = body.querySelector('#pkSearch') ? body.querySelector('#pkSearch').value : '';
        body.innerHTML = `
          <section class="card pk-step"><h2><b>1</b> Which chemicals?</h2>
            <label for="pkPlace">A place (its chemicals are listed below)</label>
            <select id="pkPlace"><option value="">No place: I will pick from the register</option>${places.map((x) => `<option value="${x.id}"${String(x.id) === String(placeId) ? ' selected' : ''}>${E(x.name)}${x.place_type === 'vehicle' && x.registration ? ' (' + E(x.registration) + ')' : ''} (${Number(x.chemical_count) || 0})</option>`).join('')}</select>
            ${p ? `<div class="pk-tools"><button type="button" id="pkAll">Tick all here</button><button type="button" id="pkNone">Untick all here</button></div>
              ${placeChems.length ? `<ul class="pk-list">${placeChems.map((c) => `<li><label><input type="checkbox" data-id="${c.chemical_id}"${sel.has(Number(c.chemical_id)) ? ' checked' : ''}><span>${E(c.product_name)}<span class="sup">${E(c.supplier || '')}</span></span></label></li>`).join('')}</ul>` : '<p class="muted">No chemicals are kept at this place yet.</p>'}` : ''}
            <label for="pkSearch" style="margin-top:14px">Or find others in the register</label>
            <input type="search" id="pkSearch" placeholder="Name or supplier" value="${E(keep)}" autocomplete="off">
            <ul class="pk-list" id="pkResults" ${results.length ? '' : 'hidden'}>${results.map((c) => `<li><label><input type="checkbox" data-id="${c.id}"${sel.has(Number(c.id)) ? ' checked' : ''}><span>${E(c.product_name)}<span class="sup">${E(c.supplier || '')}</span></span></label></li>`).join('')}</ul>
            <div class="pk-chips" id="pkChips" aria-label="Chemicals in this pack">${[...sel.entries()].map(([id, v]) => `<span class="pk-chip">${E(v.name)}<button type="button" data-rm="${id}" aria-label="Remove ${E(v.name)}">&times;</button></span>`).join('')}</div>
          </section>
          <section class="card pk-step"><h2><b>2</b> The job</h2>
            <label for="pkClient">Client or site name</label><input type="text" id="pkClient" value="${E(job.client)}" maxlength="120" autocomplete="off">
            <label for="pkRef">Job reference</label><input type="text" id="pkRef" value="${E(job.jobRef)}" maxlength="60" autocomplete="off">
            <label for="pkDate">Date</label><input type="date" id="pkDate" value="${E(job.date)}">
          </section>
          <section class="card pk-step"><h2><b>3</b> Build it</h2>
            <p class="hint" style="margin-top:0">The pack has a cover page, a register page, then each chemical's assessment followed by its safety data sheet. A chemical with no SDS or assessment is still listed and gets a placeholder page.</p>
            ${offline() ? '<div class="notice warn" role="alert">You have no signal. Building a pack needs to read the register. Connect and try again.</div>' : ''}
            <div id="pkProg" hidden role="status" aria-live="polite"><div id="pkTitle" style="font-weight:600"></div><div class="pk-bar2"><i id="pkFill"></i></div><div class="hint" id="pkStatus"></div><button type="button" class="small" id="pkCancel">Cancel</button></div>
            <div id="pkResult"></div>
          </section>
          <div class="pk-bar no-print"><strong id="pkCount">${sel.size} chemical${sel.size === 1 ? '' : 's'}</strong><span style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="primary" id="pkPdf"${sel.size && !offline() ? '' : ' disabled'}>Build the PDF</button><button type="button" id="pkZip"${sel.size && !offline() ? '' : ' disabled'}>Zip of SDS files</button></span></div>`;
        bind();
        if (built) showResult();
      }

      function updateCount() {
        const n = sel.size;
        body.querySelector('#pkCount').textContent = n + ' chemical' + (n === 1 ? '' : 's');
        const dis = !n || offline() || running;
        body.querySelector('#pkPdf').disabled = dis; body.querySelector('#pkZip').disabled = dis;
        body.querySelector('#pkChips').innerHTML = [...sel.entries()].map(([id, v]) => `<span class="pk-chip">${E(v.name)}<button type="button" data-rm="${id}" aria-label="Remove ${E(v.name)}">&times;</button></span>`).join('');
      }

      function bind() {
        const ps = body.querySelector('#pkPlace');
        ps.addEventListener('change', async () => { placeId = ps.value; loadPlace.touched = true; await loadPlace(); draw(); });
        const all = body.querySelector('#pkAll'), none = body.querySelector('#pkNone');
        if (all) all.addEventListener('click', () => { placeChems.forEach((c) => sel.set(Number(c.chemical_id), { name: c.product_name, supplier: c.supplier })); built = null; draw(); });
        if (none) none.addEventListener('click', () => { placeChems.forEach((c) => sel.delete(Number(c.chemical_id))); built = null; draw(); });
        const search = body.querySelector('#pkSearch');
        let t;
        search.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const v = search.value.trim();
            if (v.length < 2) { results = []; body.querySelector('#pkResults').hidden = true; return; }
            try { const d = await App.api('/chemicals?q=' + encodeURIComponent(v) + '&limit=20'); results = d.items || []; } catch (er) { results = []; }
            const ul = body.querySelector('#pkResults');
            if (!ul) return;
            ul.hidden = !results.length;
            ul.innerHTML = results.map((c) => `<li><label><input type="checkbox" data-id="${c.id}"${sel.has(Number(c.id)) ? ' checked' : ''}><span>${E(c.product_name)}<span class="sup">${E(c.supplier || '')}</span></span></label></li>`).join('') || '';
            if (!results.length) { ul.hidden = false; ul.innerHTML = '<li><label>Nothing found</label></li>'; }
          }, 250);
        });
        const link = (id, key) => body.querySelector(id).addEventListener('input', (e) => { job[key] = e.target.value; });
        link('#pkClient', 'client'); link('#pkRef', 'jobRef'); link('#pkDate', 'date');
        body.querySelector('#pkPdf').addEventListener('click', () => run('pdf'));
        body.querySelector('#pkZip').addEventListener('click', () => run('zip'));
        body.querySelector('#pkCancel').addEventListener('click', () => { cancel = true; });
      }

      const prog = (title, text, pct) => {
        if (dead) return;
        const b = body.querySelector('#pkProg'); if (!b) return;
        b.hidden = false; body.querySelector('#pkTitle').textContent = title; body.querySelector('#pkStatus').textContent = text || '';
        if (pct != null) body.querySelector('#pkFill').style.width = Math.round(pct) + '%';
      };

      async function getSds(id) {
        if (sdsCache.has(id)) return sdsCache.get(id);
        const b = await window.SDSLib.pdfAssets.fetchSdsPdf(id);
        if (b) sdsCache.set(id, b);
        return b;
      }

      async function run(kind) {
        if (running || !sel.size) return;
        if (offline()) { App.toast('You have no signal. Connect and try again.', 'error'); return; }
        running = true; App.busy = true; cancel = false; built = built || {};
        body.querySelectorAll('#pkPdf,#pkZip').forEach((b) => (b.disabled = true));
        body.querySelector('#pkResult').innerHTML = '';
        try {
          prog('Reading the register', 'Getting the chemicals...', 3);
          const ids = [...sel.keys()];
          const pack = await App.api('/pack?ids=' + ids.join(','));
          if (dead) return;
          const items = (pack.chemicals || []).map((e) => PM.toBundleChem(e)).sort((a, b) => String(a.product_name).toLowerCase().localeCompare(String(b.product_name).toLowerCase()));
          if (!items.length) throw new Error('None of those chemicals could be found.');
          const jobInfo = { client: job.client, jobRef: job.jobRef, date: job.date, place: placeObj(), preparedBy: (App.me && App.me.name) || '', company: Object.assign({ company_name: App.companyName() }, App.settings || {}) };
          const cover = PM.coverModel(items, jobInfo);
          const base = PM.fileBase(jobInfo);
          const D = window.DISCLAIMER || { short: '', full: '', points: [] };
          if (kind === 'pdf') {
            await App.loadScript('/vendor/pdf-lib.min.js');
            await App.loadScript('/lib/pdf-bundle.js');
            const A = window.SDSLib.pdfAssets;
            const out = await window.SDSLib.pdfBundle.buildPackPdf(window.PDFLib, { cover, chemicals: items }, {
              D, ref, cancelled: () => cancel, fetchSds: getSds, pictoDeps: { fetchBytes: A.fetchBytes, toPng: A.gifToPng },
              onProgress: (label, i) => prog('Building the PDF', label + ' (' + i + ' of ' + items.length + ')', 8 + (i / items.length) * 90),
            });
            if (cancel) throw new Error('cancelled');
            built.pdf = new Blob([out.bytes], { type: 'application/pdf' });
            built.pdfName = base + '.pdf';
            built.notes = out.notes; built.cover = cover; built.pages = out.pageCount;
          } else {
            await App.loadScript('/vendor/fflate.js');
            const ZB = window.SDSLib.zipBuild;
            const zip = new ZB.ZipBuilder(window.fflate);
            const entries = PM.zipEntries(items);
            const missing = [];
            let n = 0;
            for (const e of entries) {
              if (cancel) throw new Error('cancelled');
              prog('Zipping', 'Fetching ' + e.products.join(', '), 8 + (n / Math.max(1, entries.length)) * 85);
              const b = await getSds(e.sds_id);
              if (b) zip.addPdf(e.name.replace(/\.pdf$/i, ''), b); else missing.push(e.products.join(', '));
              n++;
            }
            zip.addText('README.txt', PM.zipReadme(cover, jobInfo, D, missing, entries.length - missing.length));
            built.zip = zip.finish();
            built.zipName = base + ' - SDS files.zip';
            built.zipMissing = missing; built.cover = cover;
          }
          running = false;
          if (!dead) { body.querySelector('#pkProg').hidden = true; showResult(); }
        } catch (err) {
          if (dead) return;
          body.querySelector('#pkProg').hidden = true;
          if (err && err.message === 'cancelled') body.querySelector('#pkResult').innerHTML = '<div class="notice">Cancelled.</div>';
          else { console.error(err); body.querySelector('#pkResult').innerHTML = `<div class="notice bad" role="alert">${E(err.status === 0 || offline() ? 'You have no signal. Connect and try again.' : (err.message || 'That did not work. Please try again.'))}</div>`; }
        } finally { running = false; App.busy = false; if (!dead) updateCount(); }
      }

      function showResult() {
        const r = body.querySelector('#pkResult'); if (!r || !built) return;
        let h = '';
        if (built.pdf) {
          const c = built.cover || { missingCount: 0 };
          const n = built.notes || { missing: [], skipped: [] };
          h += `<div class="notice" role="status"><strong>The PDF is ready</strong> (${built.pages} pages, ${(built.pdf.size / 1048576).toFixed(1)} MB).${c.missingCount ? ` ${c.missingCount} chemical${c.missingCount === 1 ? ' is' : 's are'} missing an SDS or assessment; they are named on the cover.` : ''}${n.missing.length ? ' No PDF could be fetched for: ' + E(n.missing.join(', ')) + '.' : ''}${n.skipped.length ? ' Could not be read: ' + E(n.skipped.join(', ')) + '.' : ''}</div>
            <div class="pk-actions"><button type="button" class="primary" id="pkSave">Save the PDF</button>${canShare() ? '<button type="button" id="pkShare">Share the PDF</button>' : ''}</div>`;
        }
        if (built.zip) {
          h += `<div class="notice" role="status" style="margin-top:10px"><strong>The zip is ready</strong> (${(built.zip.size / 1048576).toFixed(1)} MB).${built.zipMissing && built.zipMissing.length ? ' No PDF could be fetched for: ' + E(built.zipMissing.join(', ')) + '.' : ''}</div><div class="pk-actions"><button type="button" id="pkSaveZip">Save the zip</button></div>`;
        }
        r.innerHTML = h;
        const sv = r.querySelector('#pkSave'); if (sv) sv.addEventListener('click', () => App.download(built.pdfName, built.pdf));
        const sz = r.querySelector('#pkSaveZip'); if (sz) sz.addEventListener('click', () => App.download(built.zipName, built.zip));
        const sh = r.querySelector('#pkShare');
        if (sh) sh.addEventListener('click', async () => {
          try { await navigator.share({ files: [new File([built.pdf], built.pdfName, { type: 'application/pdf' })], title: built.pdfName }); }
          catch (e) { if (e && e.name !== 'AbortError') App.toast('Sharing did not work. Use Save the PDF instead.', 'error'); }
        });
      }
      function canShare() {
        try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'application/pdf' })], 'x.pdf', { type: 'application/pdf' })] })); } catch (e) { return false; }
      }

      // delegated handlers, attached once
      const tick = (cb, name, sup) => { const id = Number(cb.dataset.id); if (cb.checked) sel.set(id, { name, supplier: sup }); else sel.delete(id); built = null; body.querySelector('#pkResult').innerHTML = ''; updateCount(); };
      body.addEventListener('change', (e) => {
        const cb = e.target.closest('input[type=checkbox][data-id]');
        if (!cb) return;
        const id = Number(cb.dataset.id);
        const src = placeChems.find((c) => Number(c.chemical_id) === id) || results.find((c) => Number(c.id) === id);
        tick(cb, src ? src.product_name : 'Chemical #' + id, src ? src.supplier : '');
      });
      body.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-rm]');
        if (rm) { sel.delete(Number(rm.dataset.rm)); built = null; draw(); }
      });
      window.addEventListener('online', draw); window.addEventListener('offline', draw);
      App.onLeave(() => { window.removeEventListener('online', draw); window.removeEventListener('offline', draw); });
      draw();
    },
  });
})();
