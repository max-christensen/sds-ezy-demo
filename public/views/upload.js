// Upload an SDS: read the PDF in the browser, check for duplicates, ask five quick questions, send it, show what was created.
// The Worker does no PDF parsing: the text is extracted here with pdf.js and sent along with the file.
(function () {
  const App = window.App;
  const LIBS = ['/lib/sds-hash.js', '/lib/pdf-text.js'];

  const FIELD_LABELS = {
    un_number: 'UN number', dg_class: 'Dangerous goods class', subsidiary_class: 'Subsidiary risk', packing_group: 'Packing group',
    hazchem_code: 'Hazchem code', proper_shipping_name: 'Proper shipping name', issue_date: 'SDS issue date', revision: 'Revision',
    emergency_phone: 'Emergency phone', poison_schedule: 'Poison schedule', h_statements: 'Hazard statements', p_statements: 'Precautionary statements',
    cas_numbers: 'CAS numbers', classification: 'GHS classification', signal_word: 'Signal word', supplier: 'Supplier', title: 'Product name',
  };
  const OFFLINE_TEXT = 'Uploading needs a signal. Connect and try again.';
  const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
  const myPlaceId = () => { try { const m = App.myPlace && App.myPlace(); return m ? String(m.id != null ? m.id : m) : ''; } catch (e) { return ''; } };
  const label = (k) => FIELD_LABELS[k] || String(k).replace(/_/g, ' ');

  const CSS = `
  .up-drop{display:block;border:2px dashed var(--border,#dad5c8);border-radius:10px;background:var(--surface,#fff);padding:34px 18px;text-align:center;cursor:pointer}
  .up-drop:hover,.up-drop.over,.up-drop:focus-within{border-color:var(--office,#3b6e71);background:var(--office-bg,#e7efee)}
  .up-drop strong{display:block;font-size:17px;margin-bottom:4px}
  .up-drop input{position:absolute;opacity:0;width:1px;height:1px}
  .up-bar{height:12px;border-radius:6px;background:var(--border,#dad5c8);overflow:hidden;margin:12px 0 8px}
  .up-bar>i{display:block;height:100%;width:0;background:var(--office,#3b6e71);transition:width .2s}
  .up-q{margin:0 0 22px;padding:0;border:0}
  .up-q legend{font-weight:600;font-size:15px;padding:0;margin-bottom:4px}
  .up-q .hint{margin:0 0 8px}
  .up-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
  .up-choices label{margin:0;display:flex;align-items:center;gap:10px;min-height:48px;padding:10px 14px;border:1.5px solid var(--border,#dad5c8);border-radius:10px;background:var(--surface,#fff);cursor:pointer;color:var(--ink,#1f2a24);font-size:15px}
  .up-choices label:has(input:checked){border-color:var(--office,#3b6e71);background:var(--office-bg,#e7efee);font-weight:600}
  .up-choices label:has(input:focus-visible){outline:3px solid var(--office,#3b6e71);outline-offset:2px}
  .up-choices input{width:20px;height:20px;flex:none;margin:0}
  .up-qty{display:grid;grid-template-columns:minmax(110px,1fr) auto;gap:8px;align-items:center;margin-bottom:8px}
  .up-qty input{min-height:48px;font-size:16px}
  .up-q textarea{min-height:96px;font-size:16px}
  .up-q input[type=text]{min-height:48px;font-size:16px}
  .up-file{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
  .up-file b{word-break:break-all}
  .up-submit{min-height:52px;font-size:16px;padding:12px 24px}
  .up-links{margin:6px 0 0;padding-left:18px}
  .up-links li{margin:4px 0}
  `;
  function css() {
    if (document.getElementById('up-css')) return;
    const s = document.createElement('style'); s.id = 'up-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  const fmtMb = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB');

  async function loadLibs() {
    for (const l of LIBS) await App.loadScript(l);
    return window.SDSLib;
  }

  function friendlyError(err, maxMb) {
    const st = err && err.status;
    if (st === 429) return 'You have reached the upload limit for this hour. Please try again a little later, or ask an admin to raise the limit.';
    if (st === 413) return 'That file is too big' + (maxMb ? ' (the limit is ' + maxMb + ' MB)' : '') + '. Try a smaller PDF.';
    if (st === 401) return 'Your session ended. Please log in again.';
    if (st === 403) return (err && err.message) || 'Uploading is not allowed right now.';
    if (st === 400) return (err && err.message) || 'That file could not be accepted. Make sure it is a PDF.';
    if (st === 0) return OFFLINE_TEXT;
    return (err && err.message) || 'Something went wrong. Please try again.';
  }

  App.views.register('upload', {
    title: 'Upload an SDS',
    async render(root, params) {
      const q = (params && params.query) || {};
      css();
      let dead = false;
      App.onLeave(() => { dead = true; });
      const lib = await loadLibs();
      const st = { placeId: myPlaceId(), places: [], file: null, buf: null, hash: '', text: '', scanned: false, pages: 0, pre: null, replaceId: null, maxMb: Number((App.settings && App.settings.upload_max_mb) || 15) };
      try { const pl = await App.api('/places'); st.places = Array.isArray(pl) ? pl : []; } catch (e) { st.places = []; }
      // Found during an audit: #/upload?for_chemical=ID&place=ID&audit=ID. The SDS is attached to that existing record.
      st.forChem = Number(q.for_chemical) || 0;
      st.auditId = Number(q.audit) || 0;
      if (st.forChem && q.place) st.placeId = String(q.place);
      st.lockPlace = !!(st.forChem && q.place);
      if (st.placeId && !st.places.some((x) => String(x.id) === st.placeId)) { if (!st.lockPlace) st.placeId = ''; }
      st.forName = '';
      if (st.forChem) { try { st.forName = (await App.api('/chemicals/' + st.forChem)).chemical.product_name || ''; } catch (e) { st.forName = ''; } }
      const onNet = () => { const n = root.querySelector('#offNote'); if (n) n.hidden = !isOffline(); const b = root.querySelector('#qSubmit'); if (b) b.disabled = isOffline(); };
      window.addEventListener('online', onNet); window.addEventListener('offline', onNet);
      App.onLeave(() => { window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); });

      const topbar = st.forChem ? `<div class="topbar"><div><h1>Add the safety data sheet</h1><p class="sub">Adding the SDS for <strong>${App.esc(st.forName || 'chemical #' + st.forChem)}</strong> found during your audit. The PDF is attached to that record and its assessment is drafted.</p></div></div>` : '<div class="topbar"><div><h1>Upload a safety data sheet</h1><p class="sub">Add a PDF and SDS EZY will read it, add the chemical to the register and draft its risk assessment.</p></div></div>';
      const shell = (inner) => { root.innerHTML = topbar + inner; };

      function stepChoose(message) {
        shell(`${message ? `<div class="notice bad" role="alert">${App.esc(message)}</div>` : ''}
          <div class="notice warn" id="offNote" role="alert"${isOffline() ? '' : ' hidden'}>${OFFLINE_TEXT}</div>
          <div class="card">
            <label class="up-drop" id="drop"><strong>Choose a PDF</strong><span class="muted">or drop it here. PDF files only, up to ${st.maxMb} MB.</span>
              <input type="file" id="file" accept="application/pdf,.pdf"></label>
            <p class="hint" style="margin-bottom:0">Your file is read on this device first. Only the text and the PDF are sent.</p>
          </div>`);
        const input = root.querySelector('#file'), drop = root.querySelector('#drop');
        input.addEventListener('change', () => input.files[0] && start(input.files[0]));
        ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
        drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) start(f); });
      }

      function stepBusy(title, detail, pct) {
        shell(`<div class="card" role="status" aria-live="polite"><h2>${App.esc(title)}</h2><div class="up-bar"><i style="width:${pct == null ? 100 : pct}%${pct == null ? ';opacity:.35' : ''}"></i></div><p class="muted" id="busyDetail" style="margin:0">${App.esc(detail || '')}</p></div>`);
      }
      const setBusy = (detail, pct) => {
        const d = root.querySelector('#busyDetail'); if (d) d.textContent = detail;
        const b = root.querySelector('.up-bar>i'); if (b && pct != null) b.style.width = pct + '%';
      };

      async function start(file) {
        if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return stepChoose('That is not a PDF. Please choose the safety data sheet as a PDF file.');
        if (file.size > st.maxMb * 1048576) return stepChoose(`That file is ${fmtMb(file.size)}, which is over the ${st.maxMb} MB limit. Try a smaller PDF.`);
        if (file.size < 100) return stepChoose('That file looks empty. Please choose another one.');
        st.file = file; st.pre = null; st.replaceId = null;
        stepBusy('Reading ' + file.name, 'Opening the file...', 2);
        try {
          st.buf = await file.arrayBuffer();
          const head = new Uint8Array(st.buf, 0, 5);
          if (String.fromCharCode(...head) !== '%PDF-') return stepChoose('That file is not a real PDF. Please choose the safety data sheet as a PDF.');
          st.hash = await lib.sdsHash.sha256Hex(st.buf);
          let pdfjs;
          try {
            pdfjs = await import('/vendor/pdf.min.mjs');
            pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
          } catch (e) { throw new Error('Could not load the PDF reader. Reload the page and try again.'); }
          let r;
          try {
            r = await lib.pdfText.extractText(pdfjs, new Uint8Array(st.buf.slice(0)), { onProgress: (d, t) => { if (!dead) setBusy('Reading the sheet... page ' + d + ' of ' + t, 5 + Math.round((d / t) * 75)); } });
          } catch (e) {
            if (e && e.name === 'PasswordException') return stepChoose('That PDF is password protected. Remove the password and try again.');
            return stepChoose('That PDF could not be opened. It may be damaged. Try downloading it again from the supplier.');
          }
          if (dead) return;
          st.text = r.text; st.scanned = r.scanned; st.pages = r.pages;
          setBusy('Checking whether it is already in the register...', 90);
          try {
            st.pre = await App.api('/uploads/precheck', { method: 'POST', body: lib.sdsHash.precheckBody(st.hash, file.name, file.size, st.text) });
          } catch (e) { return stepChoose(friendlyError(e, st.maxMb)); }
          if (dead) return;
          if (st.pre.limits && st.pre.limits.max_mb) st.maxMb = st.pre.limits.max_mb;
          if (st.pre.limits && file.size > st.pre.limits.max_mb * 1048576) return stepChoose(`That file is over the ${st.pre.limits.max_mb} MB limit.`);
          if (st.pre.exact_duplicate) return stepDuplicate(st.pre.exact_duplicate);
          if (st.pre.limits && st.pre.limits.remaining_this_hour === 0) return stepChoose('You have reached the upload limit for this hour. Please try again a little later.');
          if (st.pre.candidates && st.pre.candidates.length && !st.forChem) return stepCandidates(st.pre.candidates);
          stepQuestions();
        } catch (e) {
          console.error(e);
          if (!dead) stepChoose(e.message || 'Something went wrong while reading the file.');
        }
      }

      function chemLinks(ids, prefix) {
        return (ids || []).length ? `<ul class="up-links">${ids.map((id) => `<li><a href="#/chemical/${Number(id)}">${prefix || 'Open'} chemical #${Number(id)}</a></li>`).join('')}</ul>` : '';
      }

      async function namedLinks(ids) {
        const out = [];
        for (const id of ids || []) {
          try { const d = await App.api('/chemicals/' + Number(id)); out.push({ id: Number(id), name: d.chemical.product_name, c: d.chemical }); } catch (e) { out.push({ id: Number(id), name: 'Chemical #' + Number(id) }); }
        }
        return out;
      }

      async function stepDuplicate(d) {
        const links = await namedLinks(d.chemical_ids);
        shell(`<div class="card"><h2>This sheet is already in the register</h2>
          <p>This exact file has already been uploaded${d.title ? ' as <strong>' + App.esc(d.title) + '</strong>' : ''}, so nothing was added.</p>
          ${links.length ? `<ul class="up-links">${links.map((l) => `<li><a href="#/chemical/${l.id}">${App.esc(l.name)}</a></li>`).join('')}</ul>` : ''}
          <div class="actions" style="margin-top:14px"><button type="button" id="again">Choose a different file</button></div></div>`);
        root.querySelector('#again').addEventListener('click', () => stepChoose());
      }

      function stepCandidates(cands) {
        shell(`<form class="card" id="candForm"><h2>Is this a newer version of something you already have?</h2>
          <p class="hint">The text of this sheet mentions ${cands.length === 1 ? 'a product' : 'products'} that ${cands.length === 1 ? 'is' : 'are'} already in the register.</p>
          <fieldset class="up-q" style="margin-top:10px"><legend class="sr-only">What is this sheet?</legend><div class="up-choices" style="grid-template-columns:1fr">
            ${cands.map((c, i) => `<label><input type="radio" name="cand" value="${Number(c.sds_id)}"${i === 0 ? ' checked' : ''}><span>This looks like a newer version of <strong>${App.esc(c.title || 'an existing sheet')}</strong>${c.supplier ? ' (' + App.esc(c.supplier) + ')' : ''}${c.issue_date ? ', issued ' + App.esc(App.fmtDate(c.issue_date)) : ''}. Add it as the new version.</span></label>`).join('')}
            <label><input type="radio" name="cand" value=""><span>It is a different product. Add it separately.</span></label></div></fieldset>
          <div class="actions"><button class="primary" type="submit">Continue</button><button type="button" id="back">Choose a different file</button></div></form>`);
        root.querySelector('#back').addEventListener('click', () => stepChoose());
        root.querySelector('#candForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const v = root.querySelector('input[name=cand]:checked').value;
          st.replaceId = v ? Number(v) : null;
          stepQuestions();
        });
      }

      const radio = (name, items, def) => `<div class="up-choices">${items.map(([v, t]) => `<label><input type="radio" name="${name}" value="${v}"${v === def ? ' checked' : ''}><span>${t}</span></label>`).join('')}</div>`;

      function stepQuestions(prev) {
        const a = prev || {};
        const ai = st.pre && st.pre.ai;
        shell(`
          <div class="card up-file"><span>File: <b>${App.esc(st.file.name)}</b> (${fmtMb(st.file.size)}, ${st.pages} page${st.pages === 1 ? '' : 's'})</span><button type="button" class="small" id="change">Change file</button></div>
          ${st.scanned ? '<div class="notice warn" role="alert"><strong>This looks like a scanned sheet.</strong> There is no readable text in it, so nothing can be filled in automatically. It will still be added to the register, as a draft for an admin to complete. A PDF downloaded straight from the supplier works best.</div>' : ''}
          ${st.replaceId ? '<div class="notice">This will be added as the <strong>new version</strong> of the sheet you chose. The old version is kept in the history.</div>' : ''}
          ${ai && !ai.configured ? '<div class="notice warn">The assistant that drafts the assessment is not switched on, so this will be added as a draft with the PDF attached, for an admin to complete.</div>' : ''}
          <form class="card" id="qForm" novalidate>
            <fieldset class="up-q"><legend><label for="qPlace" style="margin:0;color:inherit;font-size:inherit">Where is it kept?</label></legend>
              <p class="hint">Pick the vehicle, workshop or site. You can leave it as not recorded.</p>
              <select id="qPlace" style="min-height:48px;font-size:16px"${st.lockPlace ? ' disabled' : ''}><option value="">Not recorded</option>${st.places.map((x) => `<option value="${x.id}"${String(x.id) === st.placeId ? ' selected' : ''}>${App.esc(x.name)}${x.registration ? ' (' + App.esc(x.registration) + ')' : ''}</option>`).join('')}</select></fieldset>
            <h2>Five quick questions</h2>
            <p class="hint">The safety data sheet cannot tell us how <em>you</em> use the chemical. Your answers help draft the assessment. Pick the closest answer.</p>
            <fieldset class="up-q"><legend><label for="q1" style="margin:0;color:inherit;font-size:inherit">1. Where and how is it used?</label></legend>
              <textarea id="q1" maxlength="1000" placeholder="e.g. Workshop bench, wiped onto parts with a rag">${App.esc(a.use_where_how || '')}</textarea></fieldset>
            <fieldset class="up-q"><legend>2. Is it sprayed, or turned into a mist or vapour?</legend>
              ${radio('aero', [['no', 'No'], ['sometimes', 'Sometimes'], ['yes', 'Yes']], a.aerosolised)}</fieldset>
            <fieldset class="up-q"><legend>3. Roughly how much do you keep?</legend>
              <div class="up-qty"><input id="q3" type="number" inputmode="decimal" min="0" step="any" placeholder="Amount" value="${App.esc(a.quantity_amount || '')}" aria-label="Amount">${radio('unit', [['L', 'Litres (L)'], ['kg', 'Kilograms (kg)']], a.quantity_unit || 'L')}</div>
              <input id="q3n" type="text" maxlength="200" placeholder="Optional note, e.g. 4 x 5 L drums" value="${App.esc(a.quantity_note || '')}" aria-label="Quantity note"></fieldset>
            <fieldset class="up-q"><legend>4. How long are people exposed to it at a time?</legend>
              ${radio('exp', [['under_15_min', 'Under 15 minutes'], ['15_to_60_min', '15 to 60 minutes'], ['1_to_4_hours', '1 to 4 hours'], ['over_4_hours', 'Over 4 hours'], ['not_sure', 'Not sure']], a.exposure || 'not_sure')}</fieldset>
            <fieldset class="up-q"><legend>5. How well ventilated is the area?</legend>
              ${radio('vent', [['outdoors', 'Outdoors or open air'], ['good', 'Good: open workshop, fans or extraction'], ['poor', 'Poor: small room, little airflow'], ['none_enclosed', 'None: enclosed space'], ['not_sure', 'Not sure']], a.ventilation || 'not_sure')}</fieldset>
            <p class="error-text" id="qErr" role="alert" hidden></p>
            <div class="notice warn" id="offNote" role="alert"${isOffline() ? '' : ' hidden'}>${OFFLINE_TEXT}</div>
            <div class="actions"><button class="primary up-submit" id="qSubmit" type="submit"${isOffline() ? ' disabled' : ''}>Add to the register</button></div>
          </form>`);
        root.querySelector('#change').addEventListener('click', () => stepChoose());
        root.querySelector('#qForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const aero = root.querySelector('input[name=aero]:checked');
          const err = root.querySelector('#qErr');
          if (!aero) { err.textContent = 'Please answer question 2: is it sprayed or turned into a mist?'; err.hidden = false; root.querySelector('input[name=aero]').focus(); return; }
          const amount = root.querySelector('#q3').value.trim();
          if (amount !== '' && !(Number(amount) >= 0)) { err.textContent = 'Please enter the amount as a number, or leave it empty.'; err.hidden = false; return; }
          st.placeId = root.querySelector('#qPlace').value;
          if (isOffline()) { err.textContent = OFFLINE_TEXT; err.hidden = false; return; }
          send({
            use_where_how: root.querySelector('#q1').value.trim(),
            aerosolised: aero.value,
            quantity_amount: amount === '' ? null : Number(amount),
            quantity_unit: root.querySelector('input[name=unit]:checked').value,
            quantity_note: root.querySelector('#q3n').value.trim(),
            exposure: root.querySelector('input[name=exp]:checked').value,
            ventilation: root.querySelector('input[name=vent]:checked').value,
          });
        });
      }

      async function send(answers) {
        App.uploading = true;
        const fd = new FormData();
        fd.append('file', new File([st.buf], st.file.name, { type: 'application/pdf' }));
        fd.append('text', st.text);
        fd.append('answers', JSON.stringify(answers));
        if (st.placeId) fd.append('place_id', st.placeId);
        if (st.forChem) fd.append('for_chemical_id', String(st.forChem));
        if (st.replaceId) fd.append('replace_sds_id', String(st.replaceId));
        fd.append('request_id', (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random());
        stepBusy('Reading the sheet...', 'Sending the file...', null);
        const t1 = setTimeout(() => { if (!dead) { const h = root.querySelector('h2'); if (h) h.textContent = 'Drafting the assessment...'; setBusy('This can take up to a minute. Please keep this page open.'); } }, 3500);
        try {
          const res = await App.apiUpload('/uploads', fd);
          App.uploading = false;
          clearTimeout(t1);
          if (!dead) stepResult(res);
        } catch (e) {
          clearTimeout(t1);
          App.uploading = false;
          if (dead) return;
          stepQuestions(answers);
          const err = root.querySelector('#qErr');
          err.textContent = friendlyError(e, st.maxMb); err.hidden = false;
          err.scrollIntoView({ block: 'center' });
        }
      }

      let ref = null;
      // What the sheet was classified as (GHS class and category), the pictograms and signal word worked out from it, and any flags.
      function classHtml(c) {
        if (!c) return '';
        const cl = c.classification;
        let h = '<div class="hint" style="margin:2px 0 6px">';
        if (cl == null) h += 'Not classified yet: no hazard class could be read from the sheet, so an admin needs to record it.';
        else if (!cl.length) h += 'None of the GHS hazard classifications apply (not hazardous).';
        else h += '<strong>Classification:</strong> ' + cl.map((e) => App.esc((ref ? ref.classificationLabel(e) : e.c + (e.k ? ' ' + e.k : '')) + (e.check ? ' (category not confirmed)' : ''))).join('; ') + '.';
        if (cl != null) h += ' <strong>Signal word:</strong> ' + App.esc(c.signal_word || 'none') + '.';
        h += '</div>';
        if (c.pictograms) h += '<div style="margin:0 0 6px">' + App.pictogramRow(c.pictograms, 44) + '</div>';
        const fl = c.classification_flags || [];
        if (fl.length) h += '<div class="notice warn" style="margin:4px 0 8px"><strong>Please check the classification:</strong><ul style="margin:4px 0 0;padding-left:18px">' + fl.map((f) => '<li>' + App.esc(typeof f === 'string' ? f : f.message || '') + '</li>').join('') + '</ul></div>';
        return h;
      }

      async function stepResult(res) {
        try { ref = ref || await import('/lib/ghs-ref.mjs'); } catch (e) { ref = null; }
        const ids = res.chemical_ids || [];
        const links = await namedLinks(ids);
        if (dead) return;
        const flagged = (res.unverified || []).map((f) => (typeof f === 'string' ? f : (f && f.field) || ''))
          .filter(Boolean);
        const flat = [...new Set(flagged)];
        let headline, body;
        if (res.mode === 'draft_only') {
          headline = 'Added, as a draft';
          body = 'The drafting assistant is not available right now. The sheet and its PDF are in the register, and an empty draft assessment is waiting for an admin to complete.';
        } else if (res.mode === 'new_version') {
          headline = 'New version added';
          body = 'The old version is kept in the history. Everything that used it now points at this new one.';
        } else {
          headline = 'Added to the register';
          body = 'The assessment was drafted from the sheet and your answers. Please check it makes sense for your workplace.';
        }
        shell(`<div class="card" role="status"><h2>${App.esc(st.forChem ? 'SDS attached' : headline)}</h2><p>${App.esc(st.forChem ? 'The safety data sheet was attached to the existing record' + (st.forName ? ' for ' + st.forName : '') + '. ' + body : body)}</p>
          ${st.scanned ? '<div class="notice warn">The sheet had no readable text, so the entry is a draft for an admin to fill in.</div>' : ''}
          <h3 style="font-size:14px;margin:14px 0 4px">What was created</h3>
          ${st.placeId ? `<p class="hint" style="margin:0 0 4px">Linked to the place: <strong>${App.esc((st.places.find((x) => String(x.id) === st.placeId) || {}).name || 'chosen place')}</strong>.</p>` : '<p class="hint" style="margin:0 0 4px">Where it is kept was not recorded.</p>'}
          <ul class="up-links">${links.length ? links.map((l) => `<li><a href="#/chemical/${l.id}">${App.esc(l.name)}</a>${classHtml(l.c)}</li>`).join('') : '<li>The safety data sheet was saved.</li>'}</ul>
          ${flat.length ? `<div class="notice warn" style="margin-top:14px"><strong>Please check these:</strong> ${flat.map((f) => `<span class="flag">${App.esc(label(f))}</span>`).join(' ')}<br><span class="hint">These were not found in the SDS text, so they were left blank rather than guessed.</span></div>` : ''}
          ${(res.warnings || []).length ? `<ul class="up-links">${res.warnings.map((w) => `<li>${App.esc(typeof w === 'string' ? w : w.message || '')}</li>`).join('')}</ul>` : ''}
          <p class="hint" style="margin-top:16px">${App.esc((window.DISCLAIMER && window.DISCLAIMER.short) || '')}</p>
          <div class="actions" style="margin-top:12px">${st.forChem && st.auditId ? `<a class="btn primary" href="#/audit/${st.auditId}">Back to the audit</a>` : ''}<button type="button" class="${st.forChem && st.auditId ? '' : 'primary'}" id="another">Upload another sheet</button><a class="btn" href="#/register">Open the register</a></div></div>`);
        root.querySelector('#another').addEventListener('click', () => stepChoose());
      }

      stepChoose();
    },
  });
})();
