/* Disposals (admin): items flagged for disposal in audits. Only an admin closes one. */
(function () {
  const App = window.App;
  const esc = App.esc;
  const REASONS = { expired: 'Expired', unlabelled: 'Unlabelled', damaged: 'Damaged', unknown: 'Unknown product', no_sds: 'No SDS' };

  // photo ids can come as numbers or {id, owner_type}; split the closing photo from the flagging photos
  function photoIds(d) {
    const raw = d.photo_ids || d.photos || [];
    const flag = [], close = [];
    raw.forEach((p) => {
      const id = p && typeof p === 'object' ? p.id : p;
      const type = p && typeof p === 'object' ? p.owner_type : 'disposal';
      (type === 'disposal_close' ? close : flag).push(id);
    });
    (d.close_photo_ids || []).forEach((id) => close.push(id));
    return { flag, close };
  }

  async function uploadClosePhoto(d, file) {
    const r = await App.compressPhoto(file);
    const blob = r instanceof Blob ? r : r.blob;
    const fd = new FormData();
    fd.append('file', blob, 'photo.jpg');
    fd.append('client_id', App.uuid());
    fd.append('owner_type', 'disposal_close');
    fd.append('owner_key', d.client_id || String(d.id));
    fd.append('taken_at', (r && r.taken_at) || (file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString()));
    if (r && r.width) { fd.append('width', String(r.width)); fd.append('height', String(r.height)); }
    await App.apiUpload('/audits/' + d.audit_id + '/photos', fd);
  }

  App.views.register('disposals', {
    title: 'Disposals',
    adminOnly: true,
    async render(root) {
      const st = { status: 'to_dispose' };
      let items = [];
      async function load() {
        const list = root.querySelector('#dpList');
        list.innerHTML = App.loadingHtml('Loading...');
        try {
          const r = await App.api('/disposals?status=' + st.status + '&limit=200');
          items = Array.isArray(r) ? r : (r.items || []);
          if (st.status === 'to_dispose') App.setBadges({ disposals: items.length });
          if (!items.length) { list.innerHTML = `<div class="empty-state"><h2>${st.status === 'to_dispose' ? 'Nothing to dispose of' : 'Nothing disposed of yet'}</h2><p>Items flagged for disposal during an audit are listed here.</p></div>`; return; }
          list.innerHTML = items.map((d) => {
            const ph = photoIds(d);
            return `<article class="fcard">
              <div class="audit-line" style="margin:0"><span class="badge ${d.status === 'disposed' ? 'ok' : 'overdue'}">${d.status === 'disposed' ? 'Disposed' : 'To dispose'}</span><span class="badge none">${esc(REASONS[d.reason] || d.reason)}</span></div>
              <div class="what">${esc(d.description)}</div>
              <div class="meta">${d.place_id ? `<a href="#/place/${d.place_id}">${esc(d.place_name)}</a>` : esc(d.place_name || '')} &middot; flagged by ${esc(d.flagged_by_name || 'someone')} on ${esc(App.fmtDate(d.flagged_at))} &middot; <a href="#/audit/${d.audit_id}/report">See audit ${d.audit_id}</a>${d.chemical_id ? ` &middot; <a href="#/chemical/${d.chemical_id}">Register entry</a>` : ''}</div>
              ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}
              ${App.photoThumbs(ph.flag)}
              ${d.status === 'disposed' ? `<p class="meta" style="margin:8px 0 0">Closed by ${esc(d.closed_by_name || 'an admin')}${d.closed_at ? ' on ' + esc(App.fmtDate(d.closed_at)) : ''}.${d.close_note ? ' ' + esc(d.close_note) : ''}</p>${App.photoThumbs(ph.close)}`
                : `<div class="btn-pair"><button type="button" class="primary" data-close="${d.id}" style="grid-column:1/-1">Close: it has been disposed of</button></div>`}</article>`;
          }).join('');
        } catch (err) { App.showError(list, err, load); }
      }

      root.innerHTML = `<div class="topbar"><div><h1>Disposals</h1><p class="sub">Items flagged during audits. They do not change the register.</p></div></div>
        <div class="seg" role="group" aria-label="Show">${[['to_dispose', 'To dispose'], ['disposed', 'Disposed']].map(([s, l]) => `<button type="button" data-st="${s}" aria-pressed="${s === st.status}">${l}</button>`).join('')}</div>
        <div id="dpList"></div>`;
      root.addEventListener('click', (e) => {
        const seg = e.target.closest('[data-st]');
        if (seg) { st.status = seg.dataset.st; root.querySelectorAll('[data-st]').forEach((b) => b.setAttribute('aria-pressed', String(b === seg))); load(); return; }
        const cl = e.target.closest('[data-close]');
        if (cl) {
          const d = items.find((x) => String(x.id) === cl.dataset.close);
          const body = document.createElement('div');
          body.innerHTML = `<p style="margin:0"><strong>${esc(d.description)}</strong></p>
            <label for="clNote">What was done (required)</label><textarea id="clNote" rows="3" placeholder="For example: taken to the chemical waste depot on Friday"></textarea>
            <label for="clPhoto">Photo (optional)</label><input id="clPhoto" type="file" accept="image/*" capture="environment">`;
          App.modal({ title: 'Close this disposal', body, buttons: [{ label: 'Cancel' }, { label: 'Close it', kind: 'primary', onClick: async () => {
            const note = body.querySelector('#clNote').value.trim();
            if (!note) { App.toast('Say what was done.', 'error'); return false; }
            await App.api('/disposals/' + d.id + '/close', { method: 'PUT', body: { close_note: note, closed_at: new Date().toISOString() } });
            const file = body.querySelector('#clPhoto').files[0];
            if (file) { try { await uploadClosePhoto(d, file); } catch (err) { App.toast('Closed, but the photo was not saved: ' + err.message, 'error'); } }
            App.toast('Closed.', 'ok');
            await load();
          } }] });
        }
      });
      await load();
    },
  });
})();
