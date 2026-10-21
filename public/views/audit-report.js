// Audit report (#/audit/:id/report): the audit on screen, and the same report as one PDF built in the browser.
// Print opens the built PDF (not a second layout); Save as PDF downloads it; Share offers it through the phone's share sheet.
(function () {
  const App = window.App;
  const E = (s) => App.esc(s);

  const CSS = `
  .ar-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin:10px 0}
  .ar-tile{background:var(--surface,#fff);border:1px solid var(--border,#dad5c8);border-radius:10px;padding:10px;text-align:center}
  .ar-tile b{display:block;font-size:22px} .ar-tile span{font-size:12.5px;color:var(--ink-soft,#55594f)}
  .ar-tile.bad{border-color:#b3261e;background:#fdecea} .ar-tile.warn{border-color:#b7791f;background:#fff4d6}
  .ar-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
  .ar-actions button{min-height:48px;font-size:15px;padding:10px 16px}
  .ar-card{background:var(--surface,#fff);border:1px solid var(--border,#dad5c8);border-radius:10px;padding:12px 14px;margin:0 0 8px}
  .ar-card h3{margin:0 0 4px;font-size:15.5px} .ar-card p{margin:2px 0;font-size:13.5px}
  .ar-chip{display:inline-block;font-size:12px;font-weight:800;padding:2px 9px;border-radius:12px;margin-right:6px}
  .ar-chip.present{background:#e6ede3;color:#2f5d2f} .ar-chip.not_found{background:#b3261e;color:#fff} .ar-chip.changed{background:#f6c453;color:#3d2a00} .ar-chip.none{background:#ece9df;color:#55594f}
  .ar-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
  .ar-photo{background:var(--surface,#fff);border:1px solid var(--border,#dad5c8);border-radius:8px;overflow:hidden;font-size:12px}
  .ar-photo img{display:block;width:100%;height:130px;object-fit:cover;background:#eee}
  .ar-photo div{padding:6px 8px}
  .ar-prog{height:10px;border-radius:5px;background:var(--border,#dad5c8);overflow:hidden;margin:6px 0}
  .ar-prog>i{display:block;height:100%;width:0;background:var(--office,#3b6e71);transition:width .15s}
  .ar-banner{border:2px solid #b7791f;background:#fff4d6;border-radius:8px;padding:10px 14px;margin:10px 0;font-weight:700}
  `;
  function css() {
    if (document.getElementById('ar-css')) return;
    const s = document.createElement('style'); s.id = 'ar-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  App.views.register('auditreport', {
    title: 'Audit report',
    async render(root, params) {
      css();
      let dead = false, running = false, cancel = false;
      App.onLeave(() => { dead = true; cancel = true; });
      const id = Number(params.id);
      root.innerHTML = App.loadingHtml('Loading the audit...');
      await App.loadScript('/lib/pdf-bundle.js').catch(() => {});
      await App.loadScript('/lib/audit-report.js');
      const AR = window.SDSLib.auditReport;
      const data = await App.api('/audits/' + id);
      const m = AR.buildModel(data);
      const a = data.audit;
      let built = null;

      const tile = (n, label, cls) => `<div class="ar-tile ${cls || ''}"><b>${n}</b><span>${E(label)}</span></div>`;
      const x = m.summary;
      const chipOf = (r) => `<span class="ar-chip ${r.result || 'none'}">${E(r.resultLabel)}</span>`;

      root.innerHTML = `<div class="topbar"><div><a class="crumb" href="#/audit/${id}">&larr; Audit</a><h1>Audit report</h1><p class="sub">${E(m.title)}. ${E(m.date)}. Audited by ${E(m.auditor)}.</p></div></div>
        ${m.finished ? '' : '<div class="ar-banner" role="status">In progress, not finished. This report shows the audit as it stands now.</div>'}
        <div class="ar-actions no-print"><button type="button" class="primary" id="arPrint">Print</button><button type="button" id="arSave">Save as PDF</button>${canShare() ? '<button type="button" id="arShare">Share</button>' : ''}</div>
        <div id="arProg" hidden role="status" aria-live="polite"><div id="arTitle" style="font-weight:600"></div><div class="ar-prog"><i id="arFill"></i></div><div class="hint" id="arStatus"></div><button type="button" class="small" id="arCancel">Cancel</button></div>
        <div id="arResult"></div>
        <section><h2>Summary</h2>
          <div class="ar-tiles">${tile(x.listed, 'Chemicals')}${tile(x.present, 'Present')}${tile(x.not_found, 'Not found', x.not_found ? 'bad' : '')}${tile(x.changed, 'Changed', x.changed ? 'warn' : '')}${tile(x.not_marked, 'Not marked')}${tile(x.found, 'Found items')}${tile(x.disposals, 'For disposal')}${tile(x.photos, 'Photos (' + m.storageText + ')')}</div>
          <p class="hint">Started ${E(m.startedText)}. Finished: ${E(m.finishedText)}.${m.notes ? ' Notes: ' + E(m.notes) : ''}</p></section>
        <section><h2>Chemicals (${m.itemRows.length})</h2>${m.itemRows.map((r) => `<div class="ar-card"><h3>${E(r.product_name)}</h3><p>${chipOf(r)}${r.markedAt ? `<span class="muted">${E(r.markedAt)}</span>` : ''}</p>
          ${r.changed ? `<p>${E(r.changed)}${r.expected ? ` (was ${E(r.expected)})` : ''}</p>` : ''}${r.note ? `<p>Note: ${E(r.note)}</p>` : ''}
          <p class="muted">SDS review: ${E(r.reviewText || (r.has_sds ? 'unknown' : 'No SDS'))}. ${E(r.assessment)}.</p></div>`).join('') || '<p class="muted">No chemicals were listed for this place.</p>'}</section>
        <section><h2>Found items (${m.foundRows.length})</h2>${m.foundRows.map((f) => `<div class="ar-card"><h3>${E(f.product_name)}${f.supplier ? ' <span class="muted">(' + E(f.supplier) + ')</span>' : ''}</h3><p>${E(f.outcomeLabel)}</p><p class="muted">${E(f.source)}. ${E(f.foundAt)}${f.note ? '. ' + E(f.note) : ''}</p></div>`).join('') || '<p class="muted">Nothing was found that is not on the register.</p>'}</section>
        <section><h2>Flagged for disposal (${m.disposalRows.length})</h2>${m.disposalRows.map((d) => `<div class="ar-card"><h3>${E(d.description)}</h3><p>${E(d.reasonLabel)}. ${E(d.statusLabel)}.</p><p class="muted">Flagged by ${E(d.flaggedBy)}, ${E(d.flaggedAt)}${d.note ? '. ' + E(d.note) : ''}</p>${d.closedAt ? `<p class="muted">Closed by ${E(d.closedBy)}, ${E(d.closedAt)}${d.closeNote ? ': ' + E(d.closeNote) : ''}</p>` : ''}</div>`).join('') || '<p class="muted">Nothing was flagged for disposal.</p>'}</section>
        ${m.findingRows.length ? `<section><h2>Findings for an admin (${m.findingRows.length})</h2>${m.findingRows.map((f) => `<div class="ar-card"><h3>${E(f.product_name)}</h3><p>${E(f.kindLabel)}</p><p class="muted">${E(f.statusLabel)}${f.resolvedBy ? ': ' + E(f.resolvedBy) + ', ' + E(f.resolvedAt) : ''}</p></div>`).join('')}</section>` : ''}
        <section><h2>Photos (${m.photos.length})</h2>${m.photos.length ? `<div class="ar-photos">${m.photos.map((p) => `<figure class="ar-photo" style="margin:0"><img loading="lazy" src="/api/audit-photos/${Number(p.id)}" alt="${E(p.label)}"><div>${E(p.caption)}</div></figure>`).join('')}</div>` : '<p class="muted">No photos were taken.</p>'}</section>
        ${App.disclaimerHtml()}`;

      const $ = (sel) => root.querySelector(sel);
      const prog = (title, text, pct) => { if (dead) return; $('#arProg').hidden = false; $('#arTitle').textContent = title; $('#arStatus').textContent = text || ''; if (pct != null) $('#arFill').style.width = Math.round(pct) + '%'; };
      const setButtons = (on) => root.querySelectorAll('#arPrint,#arSave,#arShare').forEach((b) => { b.disabled = !on; });

      async function build() {
        if (built) return built;
        await App.loadScript('/vendor/pdf-lib.min.js');
        await App.loadScript('/lib/pdf-assets.js');
        cancel = false; running = true; App.busy = true; setButtons(false);
        try {
          prog('Building the PDF', 'Getting the photos...', 2);
          const out = await AR.buildPdf(window.PDFLib, data, {
            D: window.DISCLAIMER || { short: '', full: '', points: [] }, company: Object.assign({ company_name: App.companyName() }, App.settings || {}),
            preparedBy: (App.me && App.me.name) || '', cancelled: () => cancel,
            fetchPhoto: async (pid) => { const r = await fetch('/api/audit-photos/' + Number(pid), { credentials: 'same-origin' }); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; },
            onProgress: (label, d, t) => prog('Building the PDF', label, t ? 5 + (d / t) * 90 : null),
          });
          built = { blob: new Blob([out.bytes], { type: 'application/pdf' }), name: 'Audit report - ' + AR.reportFileBase(data) + '.pdf', notes: out.notes, pages: out.pageCount };
          const n = built.notes.unavailable.length;
          $('#arResult').innerHTML = `<div class="notice${n ? ' warn' : ''}" role="status">The PDF is ready (${built.pages} pages, ${(built.blob.size / 1048576).toFixed(1)} MB).${n ? ` ${n} photo${n === 1 ? ' was' : 's were'} not available and ${n === 1 ? 'is' : 'are'} listed at the end of the report.` : ''}</div>`;
          return built;
        } finally { running = false; App.busy = false; if (!dead) { $('#arProg').hidden = true; setButtons(true); } }
      }
      const fail = (e) => {
        if (dead) return;
        if (e && e.message === 'cancelled') $('#arResult').innerHTML = '<div class="notice">Cancelled.</div>';
        else { console.error(e); $('#arResult').innerHTML = `<div class="notice bad" role="alert">${E(navigator.onLine === false ? 'You have no signal. The photos have to be fetched to build the PDF. Connect and try again.' : (e && e.message) || 'That did not work. Please try again.')}</div>`; }
      };

      $('#arCancel').addEventListener('click', () => { cancel = true; });
      $('#arSave').addEventListener('click', async () => { try { const b = await build(); App.download(b.name, b.blob); } catch (e) { fail(e); } });
      $('#arPrint').addEventListener('click', async () => {
        // open the tab now (inside the tap) so a popup blocker lets it through, point it at the PDF when it is built
        const win = built ? null : window.open('', '_blank');
        try {
          const b = await build();
          const url = URL.createObjectURL(b.blob);
          if (win && !win.closed) { win.location.href = url; }
          else { const w2 = window.open(url, '_blank'); if (!w2) $('#arResult').insertAdjacentHTML('beforeend', `<p><a class="btn primary" href="${url}" target="_blank" rel="noopener">Open the PDF to print</a></p>`); }
          setTimeout(() => URL.revokeObjectURL(url), 120000);
        } catch (e) { if (win) win.close(); fail(e); }
      });
      const share = $('#arShare');
      if (share) share.addEventListener('click', async () => {
        try {
          const wasBuilt = !!built;
          const b = await build();
          if (!wasBuilt) { App.toast('The PDF is ready. Tap Share again.'); return; } // sharing needs a fresh tap after a long build
          await navigator.share({ files: [new File([b.blob], b.name, { type: 'application/pdf' })], title: b.name });
        } catch (e) { if (e && e.name === 'AbortError') return; fail(e); }
      });
      function canShare() {
        try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'application/pdf' })], 'x.pdf', { type: 'application/pdf' })] })); } catch (e) { return false; }
      }
    },
  });
})();
