/* After finishing (#/audit/:id/summary): the counts and what happens next, in plain words.
   Finished with no signal: says so, and switches to the normal summary once the outbox has sent everything ('synced'). */
(function () {
  'use strict';
  const App = window.App;
  const esc = App.esc;
  // Load only what is not there yet (index.html already loads audit-client.js).
  const NEED = {'/lib/audit-model.js': 'auditModel', '/lib/audit-client.js': 'auditClient', '/lib/photo.js': 'photo'};
  const libs = () => Promise.all(['/lib/audit-model.js', '/lib/audit-client.js'].filter((s) => !(window.SDSLib && window.SDSLib[NEED[s]])).map((s) => App.loadScript(s)));

  App.views.register('auditsummary', {
    title: 'Audit summary',
    async render(root, params) {
      await libs();
      const M = window.SDSLib.auditModel, client = window.SDSLib.auditClient;
      M.ensureCss();
      let id = params.id;
      const qNow = () => { try { return client.queue() || []; } catch (e) { return []; } };
      const serverIdNow = () => { try { const s = client.serverId(id); return s == null ? null : String(s); } catch (e) { return null; } };
      root.innerHTML = App.loadingHtml('Loading summary...');
      let d;
      try { d = await client.get(id); }
      catch (err) {
        if (err.status === 404) { root.innerHTML = '<div class="empty-state"><h2>Audit not found</h2><a class="btn primary" href="#/places">Choose a place</a></div>'; return; }
        throw err;
      }
      const a = d.audit;
      if (a.status === 'in_progress' && M.hasQueuedFinish(qNow(), [id, params.id])) a.status = 'finished'; // finished on this phone, the finish is still in the outbox
      if (a.status === 'in_progress') {
        root.innerHTML = `<div class="empty-state"><h2>This audit is not finished</h2><p>The summary appears once the audit is finished.</p><a class="btn primary" href="#/audit/${esc(id)}">Go back to the audit</a></div>`;
        return;
      }
      const s = M.summaryFromAudit(d);
      // Not yet on the server: a local id, or work for this audit still waiting in the outbox.
      const unsent = () => M.isLocalId(id) || M.unsentForAudit(qNow(), [id, params.id]);
      document.title = 'Audit summary - ' + App.companyName();
      function draw() {
        const un = unsent();
        root.innerHTML = `<div class="chem-head"><h1>Audit finished</h1>
          <div class="muted">${esc(a.place_name)}${a.place_registration ? ' &middot; ' + esc(a.place_registration) : ''} &middot; ${esc(App.fmtDate(a.finished_at || a.started_at))}</div></div>
        ${un ? `<div class="notice warn" role="status"><strong>${esc(M.FINISHED_ON_PHONE)}</strong></div>` : ''}
        <section class="card" aria-label="Counts"><table class="au-sum"><tbody>${M.summaryRows(s).map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</tbody></table></section>
        <section class="card"><h2>What happens next</h2><ul class="mini-list" style="margin:0;padding-left:18px">${M.nextSteps(s).map((t) => `<li style="margin-bottom:6px">${esc(t)}</li>`).join('')}</ul></section>
        <div class="btn-pair">${un ? '<button type="button" disabled>View the report (after it is sent)</button>' : `<a class="btn primary" href="#/audit/${esc(id)}/report">View the report</a>`}<a class="btn" href="#/place/${esc(a.place_id)}">Back to the place</a></div>
        ${un && App.isOnline() ? '<p style="margin-top:14px"><button type="button" class="link" id="sendNow">Send now</button></p>' : ''}
        ${!un && App.isAdmin() && (s.not_found + s.changed + s.found + s.disposals) > 0 ? '<p style="margin-top:14px"><a href="#/findings">Review the findings</a></p>' : ''}`;
        const sn = root.querySelector('#sendNow');
        if (sn) sn.addEventListener('click', async () => { try { await client.sendNow(); } catch (e) { App.toast(e.message, 'error'); } });
      }
      draw();

      // Once the outbox has sent it all, show the normal summary: the address gets the server id (no reload of the screen's state needed).
      let gone = false, timer = null, wasUnsent = unsent();
      const off = client.onChange((ev) => {
        if (gone) return;
        if (ev && ev.type !== 'synced' && ev.type !== 'sent') return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (gone || !wasUnsent) return;
          const sid = serverIdNow();
          if (sid && !M.isLocalId(sid)) { id = sid; try { history.replaceState(null, '', '#/audit/' + encodeURIComponent(id) + '/summary'); } catch (e) { /* ignore */ } }
          if (!unsent()) { wasUnsent = false; try { d = await client.get(id); Object.assign(a, d.audit); Object.assign(s, M.summaryFromAudit(d)); } catch (e) { /* keep what we have */ } draw(); }
        }, 150);
      });
      App.onLeave(() => { gone = true; clearTimeout(timer); off(); });
    },
  });
})();
