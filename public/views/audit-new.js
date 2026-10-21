/* Start an audit (#/audit/new?place=ID): what will be audited, any audit already in progress here, and a big Start button. */
(function () {
  'use strict';
  const App = window.App;
  const esc = App.esc;
  // Load only what is not there yet: index.html already loads photo.js and audit-client.js, and a second copy would replace the live client.
  const NEED = {'/lib/audit-model.js': 'auditModel', '/lib/audit-client.js': 'auditClient', '/lib/photo.js': 'photo'};
  const libs = () => Promise.all(['/lib/audit-model.js', '/lib/audit-client.js', '/lib/photo.js'].filter((s) => !(window.SDSLib && window.SDSLib[NEED[s]])).map((s) => App.loadScript(s)));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  App.views.register('auditnew', {
    title: 'Audit this place',
    async render(root, params) {
      await libs();
      const M = window.SDSLib.auditModel, client = window.SDSLib.auditClient;
      M.ensureCss();
      const placeId = (params.query && params.query.place) || App.myPlace();
      if (!placeId) {
        root.innerHTML = `<div class="empty-state"><h2>Which place?</h2><p>Choose the place you are auditing first.</p><a class="btn primary" href="#/places">Choose a place</a></div>`;
        return;
      }
      root.innerHTML = App.loadingHtml('Loading place...');
      let d;
      try { d = await App.api('/places/' + encodeURIComponent(placeId)); }
      catch (err) {
        if (err.status === 404) { root.innerHTML = '<div class="empty-state"><h2>Place not found</h2><a class="btn primary" href="#/places">Choose a place</a></div>'; return; }
        if (err.offline || !App.isOnline()) { root.innerHTML = `<a class="crumb" href="#/places">&larr; Places</a><div class="chem-head"><h1>Audit this place</h1></div><div class="notice warn" role="alert">${esc(M.OFFLINE_START_NOTICE)}</div><div class="empty-state"><h2>${esc(M.SAVE_PLACE_FIRST)}</h2><p>Open the place while you have signal and press Save this place for offline. Then you can start the audit with no signal.</p><a class="btn primary" href="#/place/${esc(placeId)}">Go to the place page</a></div>`; return; }
        throw err;
      }
      let mine = [];
      try { const r = await client.list({ place_id: placeId, status: 'in_progress', limit: 10 }); mine = Array.isArray(r) ? r : (r && r.audits) || []; } catch (e) { mine = []; }

      const p = d.place, chems = d.chemicals || [];
      const r = M.placeReadiness(chems);
      const typeLabel = App.GHS && App.GHS.placeTypeLabel ? App.GHS.placeTypeLabel(p.place_type) : p.place_type;
      const iHave = mine.some((a) => a.started_by_name === (App.me && App.me.name));
      const demo = App.isDemo && App.isDemo();
      const blocked = p.archived ? 'This place is archived, so it cannot be audited.' : demo ? 'This is the read-only demo. Audits cannot be started here.' : '';

      const lines = [];
      if (r.outOfDate) lines.push(`${plural(r.outOfDate, 'chemical has', 'chemicals have')} a review that is overdue or due soon`);
      if (r.noSds) lines.push(`${plural(r.noSds, 'chemical has', 'chemicals have')} no SDS on file`);
      if (r.noAssessment) lines.push(`${plural(r.noAssessment, 'chemical has', 'chemicals have')} no assessment`);

      root.innerHTML = `<a class="crumb no-print" href="#/place/${esc(p.id)}">&larr; ${esc(p.name)}</a>
        <div class="chem-head"><h1>Audit this place</h1>
          <div class="muted"><strong>${esc(p.name)}</strong> &middot; ${esc(typeLabel)}${p.registration ? ' &middot; ' + esc(p.registration) : ''}</div></div>
        ${mine.length ? `<section class="card" aria-labelledby="inprog"><h2 id="inprog">Audit already in progress</h2>
          <ul class="au-list">${mine.map((a) => `<li>Started ${esc(App.fmtDate(a.started_at))} by ${a.started_by_name === (App.me && App.me.name) ? 'you' : esc(a.started_by_name)}
            <a class="btn primary big" style="margin-top:8px;text-align:center;font-weight:700" href="#/audit/${esc(a.id)}">Continue this audit</a></li>`).join('')}</ul></section>` : ''}
        <section class="card"><h2>What will be audited</h2>
          <p style="margin:0;font-size:17px"><strong>${plural(r.total, 'chemical', 'chemicals')}</strong> listed for this place.</p>
          ${lines.length ? `<ul class="mini-list" style="margin:8px 0 0">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p class="hint">These show first in the audit.</p>` : (r.total ? '<p class="muted" style="margin:6px 0 0">All of them have an SDS in date and an assessment.</p>' : '')}
          ${r.total ? '' : '<p class="muted" style="margin:6px 0 0">You can still start, and add what you find.</p>'}
          <p class="hint" style="margin-top:10px">You will mark each one Present, Not found or Changed, and can take photos as proof. Nothing on the register changes until an admin reviews it.</p></section>
        ${!App.isOnline() ? `<div class="notice" role="status">${esc(M.OFFLINE_START_NOTICE)}</div>` : ''}
        ${blocked ? `<div class="notice warn" role="alert">${esc(blocked)}</div>` : ''}
        ${iHave ? '<p class="hint">You can have one audit in progress for a place. Finish it, then start another.</p>' : `<button type="button" class="primary big au-big" id="startBtn"${blocked ? ' disabled' : ''}>Start audit</button>`}
        <p class="error-text" id="startErr" role="alert"></p>`;

      // One client id for this screen: a second tap, or a retry after a dropped signal, gets the same audit back rather than a second one.
      const clientId = window.crypto && crypto.randomUUID ? crypto.randomUUID() : undefined;
      const btn = root.querySelector('#startBtn'), err = root.querySelector('#startErr');
      if (btn) btn.addEventListener('click', async () => {
        btn.disabled = true; err.textContent = ''; btn.textContent = 'Starting...';
        try {
          const res = await client.start({ placeId: Number(p.id), clientId });
          if (res.existing) App.toast('Continuing your audit of this place.', 'ok');
          App.navigate('#/audit/' + res.audit.id);
        } catch (e) {
          err.textContent = (e.offline || e.needsPlaceSaved || e.code === 'place_not_saved') ? M.SAVE_PLACE_FIRST : e.message;
          btn.disabled = false; btn.textContent = 'Try again';
        }
      });
    },
  });
})();
