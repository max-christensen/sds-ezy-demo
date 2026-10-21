/* Findings (admin): what audits turned up. Nothing changes the register until an admin accepts it. */
(function () {
  const App = window.App;
  const esc = App.esc;

  // The first value found under any of these keys, so small differences in the stored names do not matter.
  const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  const qty = (q, u) => (q != null && q !== '' ? Number(q).toLocaleString(undefined, { maximumFractionDigits: 3 }) + (u ? ' ' + u : '') : '');

  // One plain line saying what Accept will do.
  function acceptLine(f, d) {
    const p = esc(f.product_name), pl = esc(f.place_name);
    if (f.kind === 'not_found') return `Remove ${p} from ${pl}`;
    if (f.kind === 'found_link') return `Link ${p} to ${pl}`;
    if (f.kind === 'found_unchecked') return `Nothing on the register changes. It only marks that you have looked at ${p}`;
    if (f.kind === 'changed') {
      const oq = pick(d, ['expected_quantity', 'old_quantity', 'quantity']), ou = pick(d, ['expected_unit', 'old_unit', 'unit']);
      const nq = pick(d, ['new_quantity']), nu = pick(d, ['new_unit']) || ou;
      const oc = pick(d, ['expected_container_note', 'expected_container', 'old_container_note', 'container_note']), nc = pick(d, ['new_container_note', 'new_container']);
      const parts = [];
      if (nq != null) parts.push(`Change quantity from ${qty(oq, ou) || 'not recorded'} to ${qty(nq, nu)}`);
      if (nc) parts.push(`Change containers from ${oc ? '"' + esc(oc) + '"' : 'not recorded'} to "${esc(nc)}"`);
      return (parts.length ? parts.join('. ') : 'Update the quantity or containers') + ` (${p} at ${pl})`;
    }
    return `${esc(f.kind)}: ${p} at ${pl}`;
  }
  const kindLabel = { not_found: 'Not found', changed: 'Changed', found_link: 'Found, not linked', found_unchecked: 'Found without checking the register' };

  App.views.register('findings', {
    title: 'Findings',
    adminOnly: true,
    async render(root) {
      const st = { status: 'open' };
      async function load() {
        const list = root.querySelector('#fnList');
        list.innerHTML = App.loadingHtml('Loading findings...');
        try {
          const r = await App.api('/findings?status=' + st.status + '&limit=200');
          const arr = Array.isArray(r) ? r : (r.items || []);
          if (st.status === 'open') App.setBadges({ findings: arr.length });
          if (!arr.length) {
            list.innerHTML = `<div class="empty-state"><h2>${st.status === 'open' ? 'Nothing to decide' : 'Nothing here'}</h2><p>${st.status === 'open' ? 'When an audit turns up something that would change the register, it is listed here for you to accept or dismiss.' : 'No findings with that status.'}</p></div>`;
            return;
          }
          list.innerHTML = arr.map((f) => {
            const d = App.parseJson(f.details, {}) || {};
            const note = f.note || pick(d, ['note', 'person_note']);
            const photos = f.photo_ids || d.photo_ids || (f.photos || []).map((p) => (p && p.id) || p);
            return `<article class="fcard" data-id="${f.id}">
              <div class="audit-line" style="margin:0"><span class="badge ${f.status === 'open' ? 'due_soon' : f.status === 'accepted' ? 'ok' : 'none'}">${esc(kindLabel[f.kind] || f.kind)}${f.status !== 'open' ? ' &middot; ' + esc(f.status) : ''}</span><span class="meta">${esc(App.fmtDate(f.created_at))}</span></div>
              <div class="what">${esc(f.product_name)}</div>
              <div class="meta">${esc(f.place_name)} &middot; <a href="#/audit/${f.audit_id}/report">See audit ${f.audit_id}</a></div>
              ${f.kind === 'found_unchecked' ? `<div class="meta">${(f.supplier || d.supplier) ? 'Supplier: ' + esc(f.supplier || d.supplier) + ' &middot; ' : ''}Found ${esc(App.fmtDate(d.found_at || f.created_at))}${d.found_at && /T\d\d:\d\d/.test(d.found_at) ? ' at ' + esc(new Date(d.found_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ''}. It was recorded while the phone had no signal, without checking the register.</div>` : ''}
              ${f.status === 'open' ? `<p style="margin:8px 0 0"><strong>${f.kind === 'found_unchecked' ? 'Note:' : 'Accept will:'}</strong> ${acceptLine(f, d)}.</p>` : `<p class="meta" style="margin:8px 0 0">${esc(f.status === 'accepted' ? 'Accepted' : 'Dismissed')} by ${esc(f.resolved_by_name || 'an admin')}${f.resolved_at ? ' on ' + esc(App.fmtDate(f.resolved_at)) : ''}${f.resolve_note ? '. ' + esc(f.resolve_note) : ''}</p>`}
              ${note ? `<div class="note">${esc(note)}</div>` : ''}
              ${App.photoThumbs(photos)}
              ${f.status === 'open' ? `<div class="btn-pair"><button type="button" class="primary" data-accept="${f.id}">${f.kind === 'found_unchecked' ? 'I\'ve looked at this' : 'Accept'}</button><button type="button" data-dismiss="${f.id}">Dismiss</button></div>` : ''}</article>`;
          }).join('');
        } catch (err) { App.showError(list, err, load); }
      }

      root.innerHTML = `<div class="topbar"><div><h1>Findings</h1><p class="sub">An audit never changes the register by itself. You decide.</p></div></div>
        <div class="seg" role="group" aria-label="Show">${['open', 'accepted', 'dismissed'].map((s) => `<button type="button" data-st="${s}" aria-pressed="${s === st.status}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
        <div id="fnList"></div>`;
      root.addEventListener('click', async (e) => {
        const seg = e.target.closest('[data-st]');
        if (seg) { st.status = seg.dataset.st; root.querySelectorAll('[data-st]').forEach((b) => b.setAttribute('aria-pressed', String(b === seg))); load(); return; }
        const acc = e.target.closest('[data-accept]');
        if (acc) {
          acc.disabled = true;
          try { const r = await App.api('/findings/' + acc.dataset.accept + '/accept', { method: 'POST', body: {} }); App.toast((r && r.message) || 'Done.', 'ok'); await load(); }
          catch (err) { App.toast(err.message, 'error'); acc.disabled = false; }
          return;
        }
        const dis = e.target.closest('[data-dismiss]');
        if (dis) {
          const body = document.createElement('div');
          body.innerHTML = '<p style="margin:0">Dismissing changes nothing in the register.</p><label for="dsNote">Note (optional)</label><textarea id="dsNote" rows="2"></textarea>';
          App.modal({ title: 'Dismiss this finding?', body, buttons: [{ label: 'Cancel' }, { label: 'Dismiss', kind: 'primary', onClick: async () => {
            const r = await App.api('/findings/' + dis.dataset.dismiss + '/dismiss', { method: 'POST', body: { note: body.querySelector('#dsNote').value.trim() } });
            App.toast((r && r.message) || 'Dismissed.', 'ok');
            await load();
          } }] });
        }
      });
      await load();
    },
  });
})();
