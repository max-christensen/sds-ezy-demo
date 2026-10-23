// Add a chemical by hand (admin): type the details, or take a photo of the product label and let the AI fill them in for you to check.
// Nothing is saved until "Save chemical". The photo is only kept (in R2, with the chemical) if you save. "Find SDS" opens a search for the
// safety data sheet in a new tab; the PDF you download there goes through the normal Upload SDS flow.
(function () {
  'use strict';
  const App = window.App;
  const esc = App.esc;
  const NEED = { '/lib/audit-model.js': 'auditModel', '/lib/photo.js': 'photo', '/lib/sds-suppliers.js': 'sdsSuppliers', '/lib/find-sds.js': 'findSds' };
  const libs = () => Promise.all(Object.keys(NEED).filter((s) => !(window.SDSLib && window.SDSLib[NEED[s]])).map((s) => App.loadScript(s)));
  const CAM_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const FIND_WEB = "Find SDS opens a web search in a new tab. Download the PDF there, then upload it on the chemical's page and the assessment is drafted from it.";

  App.views.register('chemicalnew', {
    title: 'Add a chemical',
    adminOnly: true,
    async render(root) {
      await libs();
      const P = window.SDSLib.photo, F = window.SDSLib.findSds;
      const demo = App.isDemo();
      let photo = null;      // {blob, url}: kept only if the chemical is saved
      let reading = 0, saving = false;

      root.innerHTML = `<a class="crumb" href="#/register">&larr; Register</a>
        <div class="topbar"><div><h1>Add a chemical</h1><p class="sub">Type the details, or photograph the product label and check what was read. Nothing is saved until you press Save.</p></div></div>
        ${demo ? '<div class="notice warn" role="note">This is the read-only demo, so nothing can be saved here and photos are not read.</div>' : ''}
        <section class="card">
          <div class="actions" style="margin-bottom:6px"><button type="button" id="camBtn"${demo ? ' disabled' : ''}>${CAM_SVG} Add from label photo</button></div>
          <p class="hint" id="camNote" role="status" aria-live="polite">${demo ? 'Reading a label photo is switched off in the demo.' : 'Takes a photo with the camera (or picks one on a computer). The photo is only kept if you save the chemical.'}</p>
          <div id="photoRow"></div>
          <form id="f" novalidate>
            <label for="nName">Product name</label><input id="nName" required maxlength="200" autocomplete="off">
            <label for="nSup">Supplier</label><input id="nSup" maxlength="200" autocomplete="off">
            <label for="nCode">Product code or item number</label><input id="nCode" maxlength="200" autocomplete="off">
            <label for="nNote">Note (optional)</label><textarea id="nNote" rows="3" maxlength="500"></textarea>
            <div id="labelRead" class="notice" role="note" hidden></div>
            <div class="actions" style="margin-top:12px">
              <button type="submit" class="primary" id="saveBtn"${demo ? ' disabled' : ''}>Save chemical</button>
              <a class="btn" id="findBtn" target="_blank" rel="noopener noreferrer" aria-disabled="true">Find SDS</a>
            </div>
            <p class="hint" id="findHint">${esc(FIND_WEB)}</p>
          </form>
        </section>`;
      const $ = (s) => root.querySelector(s);

      function updateFind() {
        const l = F.findSdsLink({ name: $('#nName').value, supplier: $('#nSup').value, code: $('#nCode').value });
        const a = $('#findBtn');
        if (l.url) { a.href = l.url; a.removeAttribute('aria-disabled'); a.classList.remove('disabled'); }
        else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); a.classList.add('disabled'); }
        $('#findHint').textContent = l.known ? `Find SDS opens ${l.known}'s own safety data sheet search in a new tab. Download the PDF there, then upload it on the chemical's page.` : FIND_WEB;
      }
      ['#nName', '#nSup', '#nCode'].forEach((s) => $(s).addEventListener('input', updateFind));
      $('#findBtn').addEventListener('click', (e) => { if (!$('#findBtn').getAttribute('href')) e.preventDefault(); });
      updateFind();

      function drawPhoto() {
        $('#photoRow').innerHTML = photo ? `<div style="display:flex;gap:10px;align-items:center;margin:8px 0"><img src="${photo.url}" alt="The label photo" style="width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid #ccc"><span class="muted">Photo ready. It is kept with the chemical if you save.</span> <button type="button" id="dropPhoto">Remove photo</button></div>` : '';
        const d = $('#dropPhoto'); if (d) d.addEventListener('click', () => { URL.revokeObjectURL(photo.url); photo = null; drawPhoto(); });
      }

      function setNote(msg, warn) { const n = $('#camNote'); n.textContent = msg; n.className = warn ? 'notice warn' : 'hint'; }

      // Everything the model said is untrusted text: it goes into the page with textContent or esc(), never as HTML.
      function showRead(r) {
        const bits = [];
        if (r.signal_word) bits.push(`Signal word: <strong>${esc(r.signal_word)}</strong>`);
        if (r.hazard_text) bits.push(`Hazard text: ${esc(r.hazard_text)}`);
        const box = $('#labelRead');
        box.hidden = !bits.length;
        box.innerHTML = bits.length ? `<strong>Also on the label (check it):</strong><br>${bits.join('<br>')}<br><button type="button" id="useNote" style="margin-top:6px">Put this in the note</button> <span class="hint">The hazard classification itself comes from the SDS, not from this.</span>` : '';
        const u = $('#useNote'); if (u) u.addEventListener('click', () => {
          const text = 'From the label: ' + [r.signal_word, r.hazard_text].filter(Boolean).join('. ');
          const n = $('#nNote'); n.value = ((n.value ? n.value + '\n' : '') + text).slice(0, 500);
        });
      }

      $('#camBtn').addEventListener('click', async () => {
        if (demo) return;
        const f = await P.pick({ capture: true }); if (!f) return;
        const my = ++reading;
        setNote('Reading the label...');
        let c;
        try { c = await P.compress(f); } catch (e) { setNote(e.message, true); return; }
        if (photo) URL.revokeObjectURL(photo.url);
        photo = { blob: c.blob, url: URL.createObjectURL(c.blob) }; drawPhoto();
        if (!App.isOnline()) { setNote('No signal, so the label was not read. Type the details; the photo is kept if you save.', true); return; }
        try {
          const fd = new FormData(); fd.append('image', c.blob, 'label.jpg');
          const r = await App.api('/chemicals/read-label', { method: 'POST', body: fd });
          if (my !== reading) return;
          if (r && r.ok) {
            // Only fill an empty field, so nothing you already typed is overwritten.
            if (r.product_name && !$('#nName').value.trim()) $('#nName').value = r.product_name;
            if (r.supplier && !$('#nSup').value.trim()) $('#nSup').value = r.supplier;
            if (r.product_code && !$('#nCode').value.trim()) $('#nCode').value = r.product_code;
            showRead(r); updateFind();
            setNote('Label read. Check every field before you save: the AI can get words wrong.');
          } else setNote(((r && r.message) || 'The label could not be read.') + ' Fill in the form by hand.', true);
        } catch (e) {
          if (my !== reading) return;
          setNote((e.offline ? 'No signal, so the label was not read.' : (e.message || 'The label could not be read.')) + ' Fill in the form by hand.', true);
        }
      });

      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (demo || saving) return;
        const name = $('#nName').value.trim();
        if (!name) { App.toast('Enter the product name.', 'error'); $('#nName').focus(); return; }
        saving = true; $('#saveBtn').disabled = true;
        try {
          const r = await App.api('/chemicals', { method: 'POST', body: { product_name: name, supplier: $('#nSup').value.trim(), product_codes: $('#nCode').value.trim(), decision_note: $('#nNote').value.trim() } });
          let kept = true;
          if (photo) {
            try { const fd = new FormData(); fd.append('image', photo.blob, 'label.jpg'); await App.api(`/chemicals/${r.id}/label-photo`, { method: 'POST', body: fd }); }
            catch (err) { kept = false; }
          }
          App.toast(kept ? 'Chemical saved. Now find and upload its safety data sheet.' : 'Chemical saved, but the label photo could not be kept.', kept ? 'ok' : 'error');
          App.navigate('#/chemical/' + r.id);
        } catch (err) { App.toast(err.message, 'error'); saving = false; $('#saveBtn').disabled = false; }
      });
    },
  });
})();
