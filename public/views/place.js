/* Place page (#/place/:id): what is kept here, with the SDS and assessment one tap away. */
(function () {
  const App = window.App;
  const esc = App.esc;
  const fmtQty = (q) => Number(q).toLocaleString(undefined, { maximumFractionDigits: 3 });

  // ---- shared by the chemical page: the quantity, containers and spill compound fields of a chemical-place link
  App.linkFieldsHtml = function (l) {
    l = l || {};
    return `<div class="row2"><div><label for="lk_qty">How much (optional)</label><input id="lk_qty" type="number" min="0" step="any" inputmode="decimal" value="${esc(l.quantity == null ? '' : l.quantity)}"></div>
      <div><label for="lk_unit">Unit</label><select id="lk_unit"><option value="">No quantity</option><option value="L"${l.unit === 'L' ? ' selected' : ''}>Litres (L)</option><option value="kg"${l.unit === 'kg' ? ' selected' : ''}>Kilograms (kg)</option></select></div></div>
      <label for="lk_note">Containers (optional)</label><input id="lk_note" type="text" value="${esc(l.container_note || '')}" placeholder="For example: 4 x 5 L drums">
      <label for="lk_spill">Spill compound (optional)</label><input id="lk_spill" type="text" value="${esc(l.spill_compound || '')}" placeholder="Leave blank to use the place">
      <p class="hint">Chemicals with the same spill compound text in one place count as one spill area for the flammable liquid category 4 rule.</p>`;
  };
  // Returns the body fields, or null (after a message) when the quantity and unit do not go together.
  App.readLinkFields = function (box) {
    const qs = box.querySelector('#lk_qty').value.trim(), unit = box.querySelector('#lk_unit').value;
    if ((qs && !unit) || (!qs && unit)) { App.toast('Give both a quantity and a unit, or leave both empty.', 'error'); return null; }
    if (qs && !(Number(qs) >= 0)) { App.toast('The quantity must be a number from 0 up.', 'error'); return null; }
    return { quantity: qs ? Number(qs) : null, unit: unit || null, container_note: box.querySelector('#lk_note').value.trim(), spill_compound: box.querySelector('#lk_spill').value.trim() };
  };

  const itemLine = (it) => `Item ${it.item}${it.def && it.def.group ? ': ' + it.def.group + (it.def.desc && !it.def.mixOf && it.def.desc.length < 40 ? ', ' + it.def.desc : '') : ''}`;

  function placardCard(result, place) {
    const G = App.GHS;
    if (!result || !result.counts) {
      const note = (result && result.note) || (place.place_type === 'vehicle' ? G.VEHICLE_TRANSPORT_NOTE : 'This place is set not to count towards the placard and manifest totals.');
      const cav = (result && result.caveat) || (place.place_type === 'vehicle' ? G.VEHICLE_TRANSPORT_CAVEAT : '');
      return `<section class="card"><h2>Placard check</h2><p style="margin:0">${esc(note)}</p>${cav ? `<p class="caveat">${esc(cav)}</p>` : ''}</section>`;
    }
    const t = result.totals || { items: [], issues: [] };
    const overP = (result.over && result.over.placard) || [], overM = (result.over && result.over.manifest) || [];
    const nearP = (result.near && result.near.placard) || [], nearM = (result.near && result.near.manifest) || [];
    const rows = (t.items || []).filter((i) => i.total > 0 || overP.includes(i.item) || overM.includes(i.item));
    let banner;
    if (overP.length || overM.length) banner = `<div class="pc-banner over" role="alert">Over the limit: ${overP.length ? 'placard quantity for ' + overP.map((n) => 'item ' + n).join(', ') : ''}${overP.length && overM.length ? '; ' : ''}${overM.length ? 'manifest quantity for ' + overM.map((n) => 'item ' + n).join(', ') : ''}.</div>`;
    else if (nearP.length || nearM.length) banner = `<div class="pc-banner near">Getting close (80% or more) to the ${nearP.length ? 'placard quantity for ' + nearP.map((n) => 'item ' + n).join(', ') : ''}${nearP.length && nearM.length ? ' and the ' : ''}${nearM.length ? 'manifest quantity for ' + nearM.map((n) => 'item ' + n).join(', ') : ''}.</div>`;
    else banner = `<div class="pc-banner ok">${rows.length ? 'Within the placard and manifest quantities.' : 'No quantities recorded here count towards a placard or manifest item.'}</div>`;
    const status = (i) => {
      const s = [];
      if (overP.includes(i.item)) s.push('<span class="state-over">Over placard</span>');
      else if (nearP.includes(i.item)) s.push('<span class="state-near">Near placard</span>');
      if (overM.includes(i.item)) s.push('<span class="state-over">Over manifest</span>');
      else if (nearM.includes(i.item)) s.push('<span class="state-near">Near manifest</span>');
      return s.join('<br>') || 'OK';
    };
    const unit = (i) => (i.def && i.def.unit && i.def.unit !== 'kg or L' ? i.def.unit : '');
    return `<section class="card"><h2>Placard check</h2>${banner}
      ${rows.length ? `<table class="item-table"><thead><tr><th>Item</th><th>Here</th><th>Placard</th><th>Manifest</th><th>Status</th></tr></thead><tbody>${rows.map((i) => `<tr><td>${esc(itemLine(i))}</td><td>${fmtQty(i.total)} ${esc(unit(i))}</td><td>${i.def ? fmtQty(i.def.placard) : ''}</td><td>${i.def ? fmtQty(i.def.manifest) : ''}</td><td>${status(i)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${(t.issues || []).length ? `<details class="lazy"><summary>${t.issues.length} thing${t.issues.length === 1 ? '' : 's'} to check</summary><ul class="mini-list">${t.issues.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul></details>` : ''}
      <p style="margin:12px 0 0"><a href="#/manifest">See the manifest</a></p></section>`;
  }

  function chemCard(c, admin) {
    const qty = [c.quantity != null && c.unit ? fmtQty(c.quantity) + ' ' + c.unit : '', c.container_note, c.spill_compound ? 'Spill compound: ' + c.spill_compound : ''].filter(Boolean).join(' · ');
    const hasAssess = c.has_assessment;
    return `<article class="pcard">
      <a class="pname" href="#/chemical/${c.chemical_id}">${esc(c.product_name)}</a>
      <div class="psup">${esc(c.supplier || 'Supplier not recorded')}</div>
      <div class="pbadges">${App.pictogramRow(c.pictograms, 44)}${c.signal_word ? `<strong>${esc(c.signal_word)}</strong>` : ''}${App.overrideMark(c.pictograms_overridden, 'pictograms')}</div>
      <div class="pbadges">${App.decisionBadge(c.decision)}${App.overrideMark(c.decision_overridden, 'decision')}${c.decision === 'not_hazardous' ? '' : App.riskBadge(c.risk_level, true)}${App.reviewBadge(c.review_status, c.review_due)}</div>
      ${qty ? `<div class="pqty">${esc(qty)}</div>` : ''}
      <div class="btn-pair">
        ${c.sds_id ? `<a class="btn primary" href="/api/sds/${c.sds_id}/file" target="_blank" rel="noopener">SDS</a>` : '<button type="button" disabled>No SDS on file</button>'}
        ${hasAssess ? `<a class="btn" href="#/chemical/${c.chemical_id}?to=assessment">Assessment</a>` : `<button type="button" disabled>${c.decision === 'not_hazardous' ? 'No assessment needed' : 'No assessment'}</button>`}
      </div>
      ${admin ? `<div class="padmin no-print"><button type="button" class="small" data-chg="${c.link_id}">Change quantity</button><button type="button" class="small danger" data-rm="${c.link_id}">Remove from here</button></div>` : ''}</article>`;
  }

  // ---- audits: last audited line, the audit button, and the history card
  function auditBits(d, p) {
    const last = d.last_audited_at || p.last_audited_at || null;
    const audits = d.audits || p.audits || [];
    const me = App.me || {};
    const mineOpen = audits.find((a) => a.status === 'in_progress' && (a.started_by != null ? String(a.started_by) === String(me.id) : a.started_by_name === me.name));
    const days = App.daysSince(last);
    const lastLine = last
      ? `Last audited ${esc(App.fmtDate(last))}${days != null ? ' (' + (days === 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago') + ')' : ''}`
      : 'Never audited';
    const top = p.archived ? '' : `<div class="no-print" style="margin:10px 0 0">
        <p class="${last ? 'muted' : 'state-near'}" style="margin:0 0 8px;font-weight:600">${lastLine}</p>
        ${mineOpen ? `<div class="notice warn" style="margin-bottom:8px">You already have an audit of this place in progress.</div><a class="btn primary big" href="#/audit/${mineOpen.id}">Continue your audit</a>` : `<a class="btn primary big" href="#/audit/new?place=${p.id}">Audit this place</a>`}</div>`;
    const hist = `<section class="card no-print" id="auditHist"><h2>Audit history</h2>${audits.length ? `<ul class="rowlist">${audits.map((a) => `<li><a class="item" href="${App.auditHref ? App.auditHref(a) : '#/audit/' + a.id + (a.status === 'in_progress' ? '' : '/report')}"><span><span class="name">${esc(App.fmtDate(a.finished_at || a.started_at))}</span> ${a.status === 'in_progress' ? '<span class="badge due_soon">In progress</span>' : ''}<br><span class="sup">${esc(a.started_by_name || '')}${App.auditSummaryText && App.auditSummaryText(a.summary) ? ' &middot; ' + esc(App.auditSummaryText(a.summary)) : ''}</span></span><span aria-hidden="true">&rsaquo;</span></a></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">No audits to show yet.</p>'}</section>`;
    return { top, hist };
  }

  App.views.register('place', {
    title: 'Place',
    async render(root, params) {
      const admin = App.isAdmin(), G = App.GHS, id = params.id;
      let d;
      async function load() {
        root.innerHTML = App.loadingHtml('Loading place...');
        try { d = await App.api('/places/' + encodeURIComponent(id)); }
        catch (err) {
          if (err.status === 404) { root.innerHTML = '<div class="empty-state"><h2>Place not found</h2><a class="btn primary" href="#/places">Choose a place</a></div>'; return false; }
          throw err;
        }
        return true;
      }
      if (!await load()) return;

      function draw() {
        const p = d.place, chems = d.chemicals || [];
        document.title = p.name + ' - ' + App.companyName();
        const isMine = String(App.myPlace()) === String(p.id);
        if (isMine) App.setMyPlace(p.id, { name: p.name, type: p.place_type, registration: p.registration || '' });
        const au = auditBits(d, p);
        root.innerHTML = `<a class="crumb no-print" href="#/places">&larr; Places</a>
          <div class="chem-head"><h1>${esc(p.name)}</h1>
            <div class="muted">${esc(G.placeTypeLabel(p.place_type))}${p.registration ? ' &middot; ' + esc(p.registration) : ''}${p.archived ? ' &middot; <strong>Archived</strong>' : ''}</div>
            ${p.notes ? `<p class="small-text" style="margin:6px 0 0">${esc(p.notes)}</p>` : ''}
            <div class="actions no-print" style="margin-top:10px">${isMine ? '<span class="badge ok">My place</span>' : (p.archived ? '' : '<button type="button" id="mineBtn">Make this my place</button>')}
              ${admin ? '<button type="button" id="editPlace">Edit place</button>' + (p.archived ? '' : '<button type="button" id="addChem" class="primary">Add a chemical</button>') + `<button type="button" class="${p.archived ? '' : 'danger'}" id="archPlace">${p.archived ? 'Unarchive' : 'Archive'}</button>` : ''}</div></div>
          ${au.top}
          <section aria-labelledby="chemH" style="margin-top:14px"><h2 id="chemH" style="font-size:16px;margin:0 0 8px">Chemicals here <span class="muted" style="font-weight:400">(${chems.length})</span></h2>
            ${chems.length ? chems.map((c) => chemCard(c, admin)).join('') : `<div class="empty-state"><h2>Nothing is kept here yet</h2><p>${admin ? 'Add the chemicals that are kept in this place.' : 'An admin can link chemicals to this place.'}</p></div>`}
          </section>
          ${placardCard(d.result, p)}
          <section class="card no-print"><div class="btn-pair" style="margin-top:0">
            <a class="btn primary" href="#/pack?place=${p.id}">Build a job pack from this place</a>
            <a class="btn" href="#/place/${p.id}/label">Place QR label</a></div></section>
          ${au.hist}
          <section class="card no-print" id="offCard" hidden></section>`;
        const q = (s) => root.querySelector(s);
        const mb = q('#mineBtn'); if (mb) mb.addEventListener('click', () => { App.setMyPlace(p.id, { name: p.name, type: p.place_type, registration: p.registration || '' }); App.toast('This is now your place.', 'ok'); draw(); drawOffline(); });
        const ep = q('#editPlace'); if (ep) ep.addEventListener('click', () => App.placeModal(p, async () => { await load(); draw(); drawOffline(); }));
        const ar = q('#archPlace');
        if (ar) ar.addEventListener('click', async () => {
          if (!p.archived && !await App.confirm(`Archive "${p.name}"? It drops off the lists and is not counted in totals. Its chemical links are kept.`, { okLabel: 'Archive', danger: true })) return;
          try { await App.setArchived(p, !p.archived); App.toast(p.archived ? 'Place restored.' : 'Place archived.', 'ok'); if (p.archived) { await load(); draw(); drawOffline(); } else App.navigate('#/places'); }
          catch (err) { App.toast(err.message, 'error'); }
        });
        const ac = q('#addChem'); if (ac) ac.addEventListener('click', addChemical);
      }

      // ---- admin: link a chemical to this place
      function addChemical() {
        const body = document.createElement('div');
        const have = new Set((d.chemicals || []).map((c) => String(c.chemical_id)));
        let chosen = null, ticket = 0;
        body.innerHTML = `<label for="ac_q">Find the chemical</label><input id="ac_q" type="search" placeholder="Name, supplier or code" autocomplete="off">
          <div id="ac_res" style="margin:8px 0;max-height:220px;overflow:auto"></div><div id="ac_fields" hidden><p><strong id="ac_name"></strong></p>${App.linkFieldsHtml()}</div>`;
        const qq = (s) => body.querySelector(s);
        async function search() {
          const my = ++ticket, term = qq('#ac_q').value.trim();
          if (!term) { qq('#ac_res').innerHTML = '<p class="muted small-text">Type to search.</p>'; return; }
          try {
            const r = await App.api('/chemicals?limit=20&q=' + encodeURIComponent(term));
            if (my !== ticket) return;
            qq('#ac_res').innerHTML = (r.items || []).length ? `<ul class="rowlist">${r.items.map((c) => `<li><button type="button" class="item" style="width:100%;border:none;background:none;text-align:left" data-c="${c.id}" data-n="${esc(c.product_name)}"${have.has(String(c.id)) ? ' disabled' : ''}><span><span class="name">${esc(c.product_name)}</span><br><span class="sup">${esc(c.supplier || '')}${have.has(String(c.id)) ? ' (already here)' : ''}</span></span></button></li>`).join('')}</ul>` : '<p class="muted">No chemicals match.</p>';
          } catch (err) { qq('#ac_res').textContent = err.message; }
        }
        qq('#ac_q').addEventListener('input', App.debounce(search, 250));
        qq('#ac_res').addEventListener('click', (e) => {
          const b = e.target.closest('[data-c]'); if (!b) return;
          chosen = Number(b.dataset.c); qq('#ac_name').textContent = b.dataset.n; qq('#ac_fields').hidden = false; qq('#lk_qty').focus();
        });
        search();
        App.modal({ title: 'Add a chemical to ' + d.place.name, wide: true, body, buttons: [
          { label: 'Cancel' },
          { label: 'Add', kind: 'primary', onClick: async () => {
            if (!chosen) { App.toast('Pick a chemical first.', 'error'); return false; }
            const f = App.readLinkFields(body); if (!f) return false;
            await App.api(`/places/${id}/chemicals`, { method: 'POST', body: Object.assign({ chemical_id: chosen }, f) });
            App.toast('Chemical added.', 'ok');
            await load(); draw(); drawOffline();
          } },
        ] });
      }

      root.addEventListener('click', async (e) => {
        const chg = e.target.closest('[data-chg]');
        if (chg) {
          const link = (d.chemicals || []).find((c) => String(c.link_id) === chg.dataset.chg);
          const body = document.createElement('div'); body.innerHTML = `<p><strong>${esc(link.product_name)}</strong></p>` + App.linkFieldsHtml(link);
          App.modal({ title: 'Change quantity', body, buttons: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
            const f = App.readLinkFields(body); if (!f) return false;
            await App.api('/chemical-places/' + link.link_id, { method: 'PUT', body: f });
            await load(); draw(); drawOffline();
          } }] });
          return;
        }
        const rm = e.target.closest('[data-rm]');
        if (rm) {
          const link = (d.chemicals || []).find((c) => String(c.link_id) === rm.dataset.rm);
          if (!await App.confirm(`Remove "${link.product_name}" from ${d.place.name}? The chemical itself stays in the register.`, { okLabel: 'Remove', danger: true })) return;
          try { await App.api('/chemical-places/' + link.link_id, { method: 'DELETE' }); await load(); draw(); drawOffline(); }
          catch (err) { App.toast(err.message, 'error'); }
        }
      });

      // ---- save this place for offline (App.offline comes from the offline code; nothing shows if it is absent)
      async function drawOffline() {
        const card = root.querySelector('#offCard');
        const off = App.offline;
        if (!card || !off || typeof off.savePlace !== 'function') return;
        let info = null;
        try { info = typeof off.info === 'function' ? await off.info(id) : null; } catch (e) { info = null; }
        // Contract: info = {saved_at (ISO), chemicals, sds_files, bytes, problems[], stale} or null when nothing is saved.
        const saved = info && info.saved_at;
        const nChem = info && info.chemicals;
        const nSds = info && info.sds_files;
        const bytes = info && info.bytes;
        const problems = (info && Array.isArray(info.problems)) ? info.problems : [];
        const mb = bytes != null ? (bytes / 1048576).toFixed(1) + ' MB' : '';
        const stale = info && info.stale;
        card.hidden = false;
        card.innerHTML = `<h2>Save this place for offline</h2>
          <p class="hint" style="margin:0 0 8px">Keeps this place's chemicals, assessments and SDS PDFs on this phone so you can read them with no signal. Offline is read only.</p>
          ${stale ? '<div class="notice warn">Updated app: save this place again.</div>' : ''}
          ${info && saved ? `<p style="margin:0 0 8px">Saved ${esc(App.fmtDate(saved))}${nChem != null ? ' &middot; ' + nChem + ' chemical' + (nChem === 1 ? '' : 's') : ''}${nSds != null ? ' &middot; ' + nSds + ' SDS file' + (nSds === 1 ? '' : 's') : ''}${mb ? ' &middot; ' + mb : ''}</p>` : '<p class="muted" style="margin:0 0 8px">Not saved on this phone.</p>'}
          ${problems.length ? `<div class="notice warn"><strong>Not everything could be saved.</strong><ul style="margin:4px 0 0;padding-left:18px">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
          <div class="progress" id="offProg" hidden><i></i></div><p class="hint" id="offMsg" role="status"></p>
          <div class="btn-pair"><button type="button" class="primary" id="offSave"${App.isOnline() ? '' : ' disabled'}>${info && saved ? 'Update now' : 'Save this place for offline'}</button>${info && saved ? '<button type="button" class="danger" id="offRemove">Remove from this phone</button>' : ''}</div>`;
        const prog = card.querySelector('#offProg'), bar = prog.firstElementChild, msg = card.querySelector('#offMsg');
        card.querySelector('#offSave').addEventListener('click', async (e) => {
          e.target.disabled = true; prog.hidden = false; bar.style.width = '3%';
          try {
            const r = await off.savePlace(Number(id), { onProgress: (p) => {
              const f = p && p.total ? p.done / p.total : 0; // {done, total, label}
              bar.style.width = Math.max(3, Math.min(100, f * 100)) + '%';
              if (p && p.label) msg.textContent = p.label;
            } });
            App.toast(r && r.problems && r.problems.length ? 'Saved, but not everything could be saved.' : 'Saved on this phone.', r && r.problems && r.problems.length ? '' : 'ok');
          } catch (err) { App.toast(err.message || 'Could not save this place.', 'error'); }
          drawOffline();
        });
        const rb = card.querySelector('#offRemove');
        if (rb) rb.addEventListener('click', async () => {
          if (!await App.confirm('Remove the saved copy of this place from this phone?', { okLabel: 'Remove', danger: true })) return;
          try { await off.remove(Number(id)); App.toast('Removed from this phone.', 'ok'); } catch (err) { App.toast(err.message, 'error'); }
          drawOffline();
        });
      }

      draw();
      drawOffline();
      if (params.edit && admin) App.placeModal(d.place, async () => { await load(); draw(); drawOffline(); });
    },
  });
})();
