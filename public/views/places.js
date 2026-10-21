/* Place picker (#/places) and the add/edit place form (shared with the place page). */
(function () {
  const App = window.App;
  const esc = App.esc;

  // ---- add / edit form (admin). onDone(result) runs after a successful save.
  App.placeModal = function (place, onDone) {
    const G = App.GHS;
    const body = document.createElement('div');
    const isNew = !place;
    const p = place || { name: '', place_type: 'workshop', registration: '', notes: '', counts_toward_totals: 1 };
    let touched = !isNew; // an existing place keeps its own switch until the admin changes it
    body.innerHTML = `
      <label for="pl_name">Name</label><input id="pl_name" type="text" maxlength="120" value="${esc(p.name)}" placeholder="For example: Main workshop, or Ute 3" required>
      <label for="pl_type">Type</label>
      <select id="pl_type">${G.PLACE_TYPES.map((t) => `<option value="${t.id}"${t.id === p.place_type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
      <div id="pl_regrow"><label for="pl_reg">Registration</label><input id="pl_reg" type="text" maxlength="20" value="${esc(p.registration || '')}" autocapitalize="characters" placeholder="For example: 1ABC234"></div>
      <label class="inline" style="margin-top:14px"><input id="pl_counts" type="checkbox"${p.counts_toward_totals ? ' checked' : ''}> Counts toward the placard and manifest totals</label>
      <p class="hint" id="pl_counts_hint"></p>
      <label for="pl_notes">Notes (optional)</label><textarea id="pl_notes" rows="2">${esc(p.notes || '')}</textarea>`;
    const q = (s) => body.querySelector(s);
    function hint() {
      const t = q('#pl_type').value;
      q('#pl_regrow').style.display = t === 'vehicle' ? '' : 'none';
      q('#pl_counts_hint').innerHTML = t === 'vehicle'
        ? 'Off by default for a vehicle: products in transit fall under the transport rules and are not counted. This is our understanding and is still to be confirmed with Safe Work Australia or your WHS regulator. Switch it on if they say otherwise.'
        : 'On: the stock kept here is added up and compared with the placard and manifest quantities. Totals are worked out for this place alone.';
    }
    q('#pl_type').addEventListener('change', () => { if (!touched) q('#pl_counts').checked = G.defaultCountsTowardTotals(q('#pl_type').value); hint(); });
    q('#pl_counts').addEventListener('change', () => { touched = true; });
    hint();
    App.modal({ title: isNew ? 'Add a place' : 'Edit place', body, buttons: [
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const name = q('#pl_name').value.trim();
        if (!name) { App.toast('Enter a name.', 'error'); return false; }
        const type = q('#pl_type').value;
        const payload = { name, place_type: type, counts_toward_totals: q('#pl_counts').checked, notes: q('#pl_notes').value.trim() };
        if (type === 'vehicle') payload.registration = q('#pl_reg').value.trim();
        let r;
        if (isNew) r = await App.api('/places', { method: 'POST', body: payload });
        else { if (type !== 'vehicle') payload.registration = ''; r = await App.api('/places/' + place.id, { method: 'PUT', body: payload }); }
        App.toast('Place saved.', 'ok');
        if (onDone) await onDone(r && r.id ? r.id : place && place.id);
      } },
    ] });
  };

  App.setArchived = async function (place, archived) {
    await App.api('/places/' + place.id, { method: 'PUT', body: { archived: !!archived } });
    if (archived && String(App.myPlace()) === String(place.id)) App.setMyPlace(null);
  };

  App.views.register('places', {
    title: 'Places',
    async render(root, params) {
      const G = App.GHS, admin = App.isAdmin();
      const st = { q: '', showArchived: false, active: [], archived: null };
      const mine = App.myPlace();

      async function load() {
        root.innerHTML = App.loadingHtml('Loading places...');
        try { st.active = await App.api('/places?archived=0'); st.archived = null; }
        catch (err) { App.showError(root, err, load); return; }
        draw();
      }
      async function loadArchived() {
        try { st.archived = await App.api('/places?archived=1'); } catch (err) { App.toast(err.message, 'error'); st.archived = []; }
        draw();
      }

      const rowHtml = (p, archived) => `<div>
        <button type="button" class="place-row${String(p.id) === String(mine) ? ' mine' : ''}${archived ? ' archived' : ''}" data-pick="${p.id}"${archived ? ' data-archived="1"' : ''}>
          <span class="pname">${esc(p.name)}<span class="psub">${p.place_type === 'vehicle' && p.registration ? esc(p.registration) + ' &middot; ' : ''}${esc(G.placeTypeLabel(p.place_type))}${String(p.id) === String(mine) ? ' &middot; My place' : ''}${archived ? ' &middot; Archived' : ''}</span></span>
          <span class="pcount">${p.chemical_count || 0} chemical${p.chemical_count === 1 ? '' : 's'}</span><span aria-hidden="true">&rsaquo;</span>
        </button>
        ${admin ? `<div class="place-admin no-print"><button type="button" class="small" data-edit="${p.id}">Edit</button><button type="button" class="small${archived ? '' : ' danger'}" data-arch="${p.id}" data-to="${archived ? 0 : 1}">${archived ? 'Unarchive' : 'Archive'}</button></div>` : ''}</div>`;

      function draw() {
        const needle = st.q.trim().toLowerCase();
        const match = (p) => !needle || (p.name + ' ' + (p.registration || '') + ' ' + G.placeTypeLabel(p.place_type)).toLowerCase().includes(needle);
        const groups = G.PLACE_TYPES.map((t) => [t, st.active.filter((p) => p.place_type === t.id && match(p))]).filter(([, l]) => l.length);
        let h = `<div class="topbar"><div><h1>Places</h1><p class="sub">Pick where you are working. Your choice is remembered on this phone.</p></div></div>
          ${params.query && params.query.first ? '<p style="margin:-6px 0 12px"><a href="#/review">Skip: go to the Review list</a></p>' : ''}
          <div class="reg-tools"><div class="search"><label class="sr-only" for="plQ">Search places</label><input type="search" id="plQ" placeholder="Search by name or registration" value="${esc(st.q)}" autocomplete="off"></div>
          ${admin ? '<button type="button" class="primary" id="plAdd">Add a place</button>' : ''}</div>`;
        if (!st.active.length) {
          h += `<div class="empty-state"><h2>No places yet</h2><p>${admin ? 'Add a workshop, a vehicle or a site, then link chemicals to it.' : 'An admin needs to add the places first.'}</p>${admin ? '<button type="button" class="primary" id="plAdd2">Add a place</button>' : ''}</div>`;
        } else if (!groups.length) {
          h += '<div class="empty-state"><h2>No places match</h2><p>Try a different word.</p></div>';
        } else {
          h += groups.map(([t, l]) => `<section class="place-group" aria-label="${esc(t.label)}"><h2>${({ workshop: 'Workshops and depots', vehicle: 'Vehicles', site: 'Sites' })[t.id] || esc(t.label)}</h2>${l.map((p) => rowHtml(p, false)).join('')}</section>`).join('');
        }
        if (admin) {
          h += `<p style="margin-top:20px"><button type="button" class="small" id="plShowArch">${st.showArchived ? 'Hide archived' : 'Show archived'}</button></p>`;
          if (st.showArchived) {
            if (st.archived === null) h += App.loadingHtml('Loading archived places...');
            else h += st.archived.length ? `<section class="place-group"><h2>Archived</h2>${st.archived.filter(match).map((p) => rowHtml(p, true)).join('')}</section>` : '<p class="muted">No archived places.</p>';
          }
        }
        root.innerHTML = h;
        const q = root.querySelector('#plQ');
        q.addEventListener('input', App.debounce(() => { st.q = q.value; draw(); const nq = root.querySelector('#plQ'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); }, 150));
        const add = () => App.placeModal(null, async (id) => { await load(); });
        ['#plAdd', '#plAdd2'].forEach((s) => { const b = root.querySelector(s); if (b) b.addEventListener('click', add); });
        const sa = root.querySelector('#plShowArch');
        if (sa) sa.addEventListener('click', () => { st.showArchived = !st.showArchived; if (st.showArchived && st.archived === null) { draw(); loadArchived(); } else draw(); });
      }

      root.addEventListener('click', async (e) => {
        const pick = e.target.closest('[data-pick]');
        if (pick) {
          const p = [...st.active, ...(st.archived || [])].find((x) => String(x.id) === pick.dataset.pick);
          if (p && !pick.dataset.archived) App.setMyPlace(p.id, { name: p.name, type: p.place_type, registration: p.registration || '' });
          App.navigate('#/place/' + pick.dataset.pick);
          return;
        }
        const ed = e.target.closest('[data-edit]');
        if (ed) { const p = [...st.active, ...(st.archived || [])].find((x) => String(x.id) === ed.dataset.edit); App.placeModal(p, async () => { st.archived = null; await load(); }); return; }
        const ar = e.target.closest('[data-arch]');
        if (ar) {
          const p = [...st.active, ...(st.archived || [])].find((x) => String(x.id) === ar.dataset.arch);
          const to = ar.dataset.to === '1';
          if (to && !await App.confirm(`Archive "${p.name}"? It drops off the lists and is not counted in totals. Its chemical links are kept.`, { okLabel: 'Archive', danger: true })) return;
          try { await App.setArchived(p, to); App.toast(to ? 'Place archived.' : 'Place restored.', 'ok'); const keep = st.showArchived; await load(); if (keep) { st.showArchived = true; await loadArchived(); } }
          catch (err) { App.toast(err.message, 'error'); }
        }
      });

      await load();
    },
  });
})();
