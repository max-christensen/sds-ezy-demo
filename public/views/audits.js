/* Audits list (#/audits): a user sees their own audits, an admin sees all of them. */
(function () {
  const App = window.App;
  const esc = App.esc;

  App.auditSummaryText = function (s) {
    s = App.parseJson(s, null);
    if (!s) return '';
    const bits = [];
    if (s.listed != null) bits.push(`${s.listed} listed`);
    if (s.present) bits.push(`${s.present} present`);
    if (s.not_found) bits.push(`${s.not_found} not found`);
    if (s.changed) bits.push(`${s.changed} changed`);
    if (s.found) bits.push(`${s.found} found`);
    if (s.disposals) bits.push(`${s.disposals} to dispose`);
    if (s.not_marked) bits.push(`${s.not_marked} not marked`);
    return bits.join(' · ');
  };
  App.auditStatusBadge = (status) => status === 'in_progress' ? '<span class="badge due_soon">In progress</span>' : '<span class="badge ok">Finished</span>';
  App.auditHref = (a) => a.status === 'in_progress' ? '#/audit/' + a.id : '#/audit/' + a.id + '/report';

  App.views.register('audits', {
    title: 'Audits',
    async render(root) {
      const admin = App.isAdmin();
      const st = { place: '', status: '' };
      let places = [];
      if (admin) { try { places = await App.api('/places?archived=all'); } catch (e) { places = []; } }
      const mine = App.myPlace();

      async function load() {
        const list = root.querySelector('#auList');
        list.innerHTML = App.loadingHtml('Loading audits...');
        try {
          const qs = ['limit=100', st.place && 'place_id=' + encodeURIComponent(st.place), st.status && 'status=' + st.status].filter(Boolean).join('&');
          const items = await App.api('/audits?' + qs);
          const arr = Array.isArray(items) ? items : (items.items || []);
          if (!arr.length) {
            list.innerHTML = `<div class="empty-state"><h2>No audits yet</h2><p>${admin ? 'No audits match.' : 'You have not run an audit yet.'} Open a place and press "Audit this place".</p><a class="btn primary" href="${mine ? '#/audit/new?place=' + mine : '#/places'}">${mine ? 'Audit my place' : 'Choose a place'}</a></div>`;
            return;
          }
          list.innerHTML = arr.map((a) => `<a class="pcard" style="display:block;text-decoration:none;color:inherit" href="${App.auditHref(a)}">
            <div class="audit-line" style="margin:0"><span class="pname">${esc(a.place_name || 'Place')}</span>${App.auditStatusBadge(a.status)}</div>
            <div class="psup">${esc(App.fmtDate(a.finished_at || a.started_at))}${admin && a.started_by_name ? ' &middot; ' + esc(a.started_by_name) : ''}${a.place_type ? ' &middot; ' + esc(App.GHS.placeTypeLabel(a.place_type)) : ''}</div>
            <div class="pqty">${esc(App.auditSummaryText(a.summary) || (a.status === 'in_progress' ? 'Not finished yet. Tap to continue.' : ''))}</div></a>`).join('');
        } catch (err) { App.showError(list, err, load); }
      }

      root.innerHTML = `<div class="topbar"><div><h1>${admin ? 'Audits' : 'My audits'}</h1><p class="sub">${admin ? 'Every audit, newest first.' : 'The audits you have run, newest first.'}</p></div>
        <a class="btn primary" href="${mine ? '#/audit/new?place=' + mine : '#/places'}">${mine ? 'Audit my place' : 'Choose a place to audit'}</a></div>
        ${admin ? `<div class="reg-tools"><div><label class="sr-only" for="auPlace">Place</label><select id="auPlace"><option value="">All places</option>${places.map((p) => `<option value="${p.id}">${esc(p.name)}${p.registration ? ' (' + esc(p.registration) + ')' : ''}${p.archived ? ' - archived' : ''}</option>`).join('')}</select></div>
        <div><label class="sr-only" for="auStatus">Status</label><select id="auStatus"><option value="">Any status</option><option value="in_progress">In progress</option><option value="finished">Finished</option></select></div></div>` : ''}
        <div id="auList"></div>`;
      if (admin) {
        root.querySelector('#auPlace').addEventListener('change', (e) => { st.place = e.target.value; load(); });
        root.querySelector('#auStatus').addEventListener('change', (e) => { st.status = e.target.value; load(); });
      }
      await load();
    },
  });
})();
