// Take-away: the register, manifest, assessments and SDS PDFs as files for sites with no internet.
// Everything is built in this browser from one GET /api/export/all plus the SDS PDFs fetched one by one.
//   Spreadsheet (.xlsx)   write-excel-file
//   One PDF               pdf-lib: register, manifest, then each assessment followed by its SDS pages. An SDS shared by
//                         several products is included once, after the first assessment that uses it.
//   Zip of SDS PDFs       fflate, files named by product, plus README.txt with the disclaimer
(function () {
  const App = window.App;

  const CSS = `
  .tk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:14px 0}
  .tk-card{background:var(--surface,#fff);border:1px solid var(--border,#dad5c8);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:8px}
  .tk-card h2{margin:0;font-size:17px} .tk-card p{margin:0;color:var(--ink-soft,#55594f);font-size:13.5px;flex:1}
  .tk-card button{min-height:48px;font-size:15px}
  .tk-bar{height:10px;border-radius:5px;background:var(--border,#dad5c8);overflow:hidden;margin:6px 0}
  .tk-bar>i{display:block;height:100%;width:0;background:var(--office,#3b6e71);transition:width .15s}
  .tk-status{font-size:13px;color:var(--ink-soft,#55594f);min-height:1.3em;word-break:break-word}
  `;
  function css() {
    if (document.getElementById('tk-css')) return;
    const s = document.createElement('style'); s.id = 'tk-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  const LIBS = ['/lib/export-model.js', '/lib/manifest-layout.js', '/lib/pdf-assets.js'];
  const stamp = () => new Date().toISOString().slice(0, 10);
  const D = () => window.DISCLAIMER || { short: '', full: '', points: [] };

  async function fetchPdf(sdsId) {
    const res = await fetch('/api/sds/' + Number(sdsId) + '/file', { credentials: 'same-origin' });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  App.views.register('take-away', {
    title: 'Take-away',
    async render(root) {
      css();
      root.innerHTML = App.loadingHtml('Getting the register ready...');
      for (const l of LIBS) await App.loadScript(l);
      const L = window.SDSLib;
      const ref = await import('/lib/ghs-ref.mjs');
      const raw = await App.api('/export/all');
      const model = L.exportModel.normalise(raw);
      const company = Object.assign({}, model.company);
      if (!company.company_name) company.company_name = App.companyName();
      model.company = company;
      // One rule: the per-place totals the server sent (place_totals), otherwise computePlaceTotals here (the same function).
      const sections = L.manifestLayout.sectionsFromExport(raw, ref);
      const overList = L.manifestLayout.summaryLines(sections);
      const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
      const recentAudits = (model.audits || []).filter((a) => String(a.started_at || '') >= yearAgo).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      const nChem = model.chemicals.length;
      const nHaz = model.chemicals.filter((c) => c.decision === 'hazardous').length;
      const sdsFiles = model.sdsFiles.filter((f) => f.has_file !== false && f.has_file !== 0);
      let dead = false, running = false, cancel = false;
      App.onLeave(() => { dead = true; cancel = true; });

      root.innerHTML = `<div class="topbar"><div><h1>Take-away copies</h1><p class="sub">Files you can keep on a phone, laptop or USB stick for places with no internet.</p></div></div>
        ${App.disclaimerHtml()}
        ${nChem === 0 ? '<div class="empty-state"><h2>The register is empty</h2><p>There is nothing to take away yet. Upload a safety data sheet first.</p><a class="btn primary" href="#/upload">Upload an SDS</a></div>' : `
        ${overList.over.length ? `<div class="notice bad" role="alert"><strong>Over the placard or manifest quantity:</strong><ul style="margin:6px 0 0">${overList.over.map((b) => `<li>${App.esc(b.text)}</li>`).join('')}</ul></div>` : ''}
        ${overList.near.length ? `<div class="notice warn" role="status"><strong>Near the quantity (80% or more):</strong><ul style="margin:6px 0 0">${overList.near.map((b) => `<li>${App.esc(b.text)}</li>`).join('')}</ul></div>` : ''}
        <p class="muted">${nChem} chemical${nChem === 1 ? '' : 's'} (${nHaz} hazardous) and ${sdsFiles.length} safety data sheet PDF${sdsFiles.length === 1 ? '' : 's'}. Files are made on this device and are only as current as right now (${App.esc(App.fmtDate(model.generated_at))}).</p>
        <div class="tk-grid">
          <section class="tk-card"><h2>Spreadsheet</h2><p>One Excel file with the register, hazardous chemicals, manifest, all 43 placard and manifest items, things to check, assessments and the SDS review list.</p><button class="primary" type="button" data-act="xlsx">Download spreadsheet</button></section>
          <section class="tk-card"><h2>One PDF to print or carry</h2><p>The whole register, then the manifest, then each assessment followed by its safety data sheet. An SDS shared by several products appears once, after the first assessment that uses it.${sdsFiles.length > 150 ? ' With this many sheets it can take several minutes and a lot of memory. The zip is lighter.' : ''}</p><button class="primary" type="button" data-act="pdf">Build the PDF</button></section>
          <section class="tk-card"><h2>Zip of all the SDS PDFs</h2><p>Every safety data sheet as its own file, named after the product, with a README.</p>${recentAudits.length ? `<label class="inline" style="margin:4px 0"><input type="checkbox" id="tkAudits"> Include audit reports (with photos)</label><p class="hint" style="margin:0">${recentAudits.length} audit${recentAudits.length === 1 ? '' : 's'} from the last 12 months, each as a PDF with its photos in an audit-reports folder. Photos make the zip much larger and it takes longer to build.</p>` : ''}<button class="primary" type="button" data-act="zip">Download zip</button></section>
        </div>
        <div id="tkProgress" class="card" hidden role="status" aria-live="polite"><div id="tkTitle" style="font-weight:600"></div><div class="tk-bar"><i id="tkFill"></i></div><div class="tk-status" id="tkStatus"></div><div class="actions" style="margin-top:8px"><button type="button" class="small" id="tkCancel">Cancel</button></div></div>
        <div id="tkResult"></div>`}`;
      if (nChem === 0) return;

      const box = root.querySelector('#tkProgress'), fill = root.querySelector('#tkFill'), status = root.querySelector('#tkStatus'), title = root.querySelector('#tkTitle'), result = root.querySelector('#tkResult');
      root.querySelector('#tkCancel').addEventListener('click', () => { cancel = true; status.textContent = 'Cancelling...'; });
      const prog = (text, done, total) => { if (dead) return; status.textContent = text; if (total) fill.style.width = Math.round((done / total) * 100) + '%'; };
      const setBusy = (on, t) => {
        running = on;
        root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = on));
        if (dead) return;
        box.hidden = !on; if (on) { title.textContent = t; fill.style.width = '0%'; status.textContent = ''; result.innerHTML = ''; cancel = false; }
      };
      const done = (html, kind) => { if (!dead) result.innerHTML = `<div class="notice${kind ? ' ' + kind : ''}" role="status">${html}</div>`; };

      async function makeXlsx() {
        await App.loadScript('/vendor/write-excel-file.min.js');
        await App.loadScript('/lib/xlsx-build.js');
        prog('Building the sheets...', 1, 2);
        const sheets = L.xlsxBuild.buildSheets(model, D(), { ref, sections });
        const blob = await window.writeXlsxFile(sheets).toBlob();
        App.download('sds-ezy-register-' + stamp() + '.xlsx', blob);
        done('The spreadsheet has been downloaded.');
      }

      // One audit report PDF per audit from the last 12 months (the same builder as the report page), into audit-reports/.
      async function addAuditReports(zip, ZB, extra) {
        await App.loadScript('/vendor/pdf-lib.min.js');
        await App.loadScript('/lib/pdf-bundle.js');
        await App.loadScript('/lib/audit-report.js');
        const AR = L.auditReport;
        let ok = 0; const failed = [];
        for (let i = 0; i < recentAudits.length; i++) {
          if (cancel) return;
          const a = recentAudits[i];
          const label = 'Audit ' + (i + 1) + ' of ' + recentAudits.length + ': ' + (a.place_name || '');
          prog(label, i, recentAudits.length);
          try {
            const data = await App.api('/audits/' + Number(a.id));
            const out = await AR.buildPdf(window.PDFLib, data, {
              D: D(), company, preparedBy: (App.me && App.me.name) || '', cancelled: () => cancel,
              fetchPhoto: async (pid) => { try { const r = await fetch('/api/audit-photos/' + Number(pid), { credentials: 'same-origin' }); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } catch (e) { return null; } },
              onProgress: (l) => prog(label, i, recentAudits.length) || (document.getElementById('tkStatus') && (document.getElementById('tkStatus').textContent = label + ' - ' + l)),
            });
            zip.addPdf('audit-reports/' + ZB.sanitiseFileName(AR.reportFileBase(data), 'Audit'), out.bytes);
            ok++;
          } catch (e) { if (e && e.message === 'cancelled') return; failed.push((a.place_name || 'audit') + ' ' + String(a.started_at || '').slice(0, 10)); }
        }
        extra.push('', 'Audit reports (with photos): ' + ok + ' PDF' + (ok === 1 ? '' : 's') + ' in the audit-reports folder, for audits from the last 12 months that were visible to ' + ((App.me && App.me.name) || 'the person who made this zip') + '.');
        if (failed.length) { extra.push('Could not be built:'); failed.forEach((f) => extra.push('  - ' + f)); }
        return { ok, failed };
      }

      async function makeZip() {
        await App.loadScript('/vendor/fflate.js');
        await App.loadScript('/lib/zip-build.js');
        const ZB = L.zipBuild;
        const zip = new ZB.ZipBuilder(window.fflate);
        const names = new Map(); // base names must be decided up front so shared sheets keep stable names
        const missing = [];
        const queue = sdsFiles.slice();
        let n = 0, saved = 0;
        const total = queue.length;
        const worker = async () => {
          while (queue.length && !cancel) {
            const f = queue.shift();
            let bytes = null;
            try { bytes = await fetchPdf(f.sds_id); } catch (e) { bytes = null; }
            if (bytes) { zip.addPdf(ZB.sdsBaseName(f), bytes); saved++; }
            else missing.push((f.product_names || []).join(', ') || f.file_name || 'SDS ' + f.sds_id);
            bytes = null;
            n++;
            prog('Fetched ' + n + ' of ' + total + ' safety data sheets', n, total);
          }
        };
        await Promise.all([worker(), worker(), worker()]);
        void names;
        const extra = [];
        let auditRes = null;
        const wantAudits = root.querySelector('#tkAudits') && root.querySelector('#tkAudits').checked;
        if (!cancel && wantAudits) auditRes = await addAuditReports(zip, ZB, extra);
        if (cancel) { done('Cancelled. Nothing was downloaded.'); return; }
        zip.addText('README.txt', ZB.readme(D().full, company.company_name, App.fmtDate(model.generated_at), saved, missing, L.manifestLayout.SOURCE_LINE, extra));
        const blob = zip.finish();
        App.download('sds-ezy-safety-data-sheets-' + stamp() + '.zip', blob);
        done(`The zip has been downloaded with ${saved} safety data sheet${saved === 1 ? '' : 's'}${auditRes ? ` and ${auditRes.ok} audit report${auditRes.ok === 1 ? '' : 's'}${auditRes.failed.length ? ` (${auditRes.failed.length} could not be built)` : ''}` : ''}.` + (missing.length ? ` ${missing.length} could not be fetched: ${App.esc(missing.slice(0, 8).join(', '))}${missing.length > 8 ? ', and more' : ''}. They are listed in the README.` : ''), missing.length ? 'warn' : '');
      }

      async function makePdf() {
        await App.loadScript('/vendor/pdf-lib.min.js');
        await App.loadScript('/lib/pdf-bundle.js');
        const total = nChem;
        const out = await L.pdfBundle.buildBundle(window.PDFLib, model, {
          D: D(), ref, sections, pictoDeps: { fetchBytes: window.SDSLib.pdfAssets.fetchBytes, toPng: window.SDSLib.pdfAssets.gifToPng },
          cancelled: () => cancel,
          fetchSds: (id) => fetchPdf(id),
          onProgress: (label, i) => { prog(label + ' (' + i + ' of ' + total + ')', i, total); },
        });
        if (cancel) { done('Cancelled. Nothing was downloaded.'); return; }
        prog('Saving the file...', total, total);
        App.download('sds-ezy-register-' + stamp() + '.pdf', new Blob([out.bytes], { type: 'application/pdf' }));
        const n = out.notes;
        const bits = [];
        if (n.missing.length) bits.push('No PDF was on file for: ' + App.esc(n.missing.slice(0, 8).join(', ')) + (n.missing.length > 8 ? ', and more' : '') + '.');
        if (n.skipped.length) bits.push('Could not be added: ' + App.esc(n.skipped.slice(0, 8).join(', ')) + '.');
        done(`The PDF has been downloaded (${out.pageCount} pages).${bits.length ? ' ' + bits.join(' ') : ''}`, bits.length ? 'warn' : '');
      }

      root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
        if (running) return;
        const act = b.dataset.act;
        setBusy(true, { xlsx: 'Making the spreadsheet', pdf: 'Building the PDF', zip: 'Zipping the safety data sheets' }[act]);
        try {
          if (act === 'xlsx') await makeXlsx(); else if (act === 'zip') await makeZip(); else await makePdf();
        } catch (e) {
          console.error(e);
          if (e && e.message !== 'cancelled') done('That did not work: ' + App.esc(e.message || 'unknown error') + '. Please try again.', 'bad');
          else done('Cancelled. Nothing was downloaded.');
        } finally { setBusy(false); }
      }));
    },
  });
})();
