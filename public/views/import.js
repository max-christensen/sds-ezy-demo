// One-time import from a spreadsheet (.xlsx). Admin only. The sheet is read in the browser; the column guessing
// lives in /lib/import-map.js. Steps: choose file -> match columns -> check rows -> dry run -> import.
(function () {
  const App = window.App;

  const CSS = `
  .im-map{display:grid;grid-template-columns:minmax(120px,200px) 1fr;gap:8px 12px;align-items:center;margin:10px 0}
  .im-map label{margin:0}
  .im-wrap{overflow-x:auto;border:1px solid var(--border,#dad5c8);border-radius:8px;background:var(--surface,#fff)}
  table.im-t{border-collapse:collapse;width:100%;font-size:13px}
  table.im-t th,table.im-t td{padding:5px 8px;border-bottom:1px solid var(--border,#dad5c8);text-align:left;vertical-align:top;white-space:nowrap}
  table.im-t td.wrap{white-space:normal;min-width:220px}
  table.im-t th{background:var(--office-bg,#e7efee)}
  table.im-t tr.bad td{background:#f7e3df} table.im-t tr.warn td{background:#fbf3df}
  .im-stats{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
  .im-stats span{padding:6px 12px;border-radius:16px;background:var(--office-bg,#e7efee);font-size:13px}
  `;
  function css() {
    if (document.getElementById('im-css')) return;
    const s = document.createElement('style'); s.id = 'im-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  const colName = (i) => { let n = i + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const txt = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

  App.views.register('import', {
    title: 'Import',
    adminOnly: true,
    async render(root) {
      css();
      let dead = false;
      App.onLeave(() => { dead = true; });
      await App.loadScript('/vendor/read-excel-file.min.js');
      await App.loadScript('/lib/import-map.js');
      const IM = window.SDSLib.importMap;
      const st = { sheets: [], sheet: 0, rows: [], header: 0, mapping: {}, items: [], fileName: '' };

      const top = '<div class="topbar"><div><h1>Import from a spreadsheet</h1><p class="sub">Bring in an existing chemical register. Only needs doing once.</p></div></div>';
      const shell = (inner) => { if (!dead) root.innerHTML = top + inner; };

      function stepChoose(msg) {
        shell(`${msg ? `<div class="notice bad" role="alert">${App.esc(msg)}</div>` : ''}
          <div class="card"><h2>1. Choose your spreadsheet</h2>
          <p class="hint">An Excel file (.xlsx). Any layout works as long as the first rows have column headings, such as Product, Supplier, Place, Quantity. You will match the columns in the next step. Nothing is saved until the final step.</p>
          <label for="imFile">Spreadsheet</label><input type="file" id="imFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>`);
        root.querySelector('#imFile').addEventListener('change', async (e) => {
          const f = e.target.files[0]; if (!f) return;
          if (!/\.xlsx$/i.test(f.name)) return stepChoose('That is not an .xlsx file. In Excel, use Save As and choose "Excel Workbook (.xlsx)".');
          shell('<div class="card" role="status">' + App.loadingHtml('Reading the spreadsheet...') + '</div>');
          try {
            const res = await window.readXlsxFile(f);
            st.fileName = f.name;
            st.sheets = (res || []).filter((s) => s.data && s.data.some((r) => r.some((c) => txt(c) !== '')));
            if (!st.sheets.length) return stepChoose('That spreadsheet has no data in it.');
            useSheet(0);
            stepMap();
          } catch (err) { console.error(err); stepChoose('That file could not be read. It may be damaged, password protected or not a real .xlsx file.'); }
        });
      }

      function useSheet(i) {
        st.sheet = i;
        st.rows = st.sheets[i].data;
        st.header = IM.detectHeaderRow(st.rows);
        remap();
      }
      function remap() { st.mapping = IM.guessMapping((st.rows[st.header] || []).map(txt)); }

      function colOptions(selected) {
        const headers = st.rows[st.header] || [];
        const n = Math.max(headers.length, ...st.rows.slice(st.header, st.header + 30).map((r) => r.length));
        let h = `<option value="-1"${selected < 0 ? ' selected' : ''}>Not in my spreadsheet</option>`;
        for (let i = 0; i < n; i++) h += `<option value="${i}"${selected === i ? ' selected' : ''}>${colName(i)}: ${App.esc(txt(headers[i]) || '(no heading)')}</option>`;
        return h;
      }

      function stepMap() {
        const sample = st.rows.slice(st.header, st.header + 6);
        const ncol = Math.max(...sample.map((r) => r.length), 1);
        shell(`<div class="card"><h2>2. Match the columns</h2>
          <p class="hint">File: <strong>${App.esc(st.fileName)}</strong>. We guessed which column is which. Please check each one.</p>
          ${st.sheets.length > 1 ? `<div class="row2"><div><label for="imSheet">Sheet</label><select id="imSheet">${st.sheets.map((s, i) => `<option value="${i}"${i === st.sheet ? ' selected' : ''}>${App.esc(s.sheet)}</option>`).join('')}</select></div></div>` : ''}
          <div class="row2"><div><label for="imHeader">Row with the column headings</label><input type="number" id="imHeader" min="1" max="${st.rows.length}" value="${st.header + 1}"></div></div>
          <div class="im-map">${IM.FIELDS.map((f) => `<label for="map_${f.key}">${App.esc(f.label)}${f.required ? ' *' : ''}</label><select id="map_${f.key}" data-field="${f.key}">${colOptions(st.mapping[f.key])}</select>`).join('')}</div>
          <h3 style="font-size:14px;margin:16px 0 6px">First rows of your sheet</h3>
          <div class="im-wrap"><table class="im-t"><thead><tr>${Array.from({ length: ncol }, (_, i) => `<th scope="col">${colName(i)}</th>`).join('')}</tr></thead><tbody>${sample.map((r, ri) => `<tr>${Array.from({ length: ncol }, (_, i) => `<td${ri === 0 ? ' style="font-weight:600"' : ''}>${App.esc(txt(r[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
          <p class="error-text" id="imErr" role="alert" hidden></p>
          <div class="actions" style="margin-top:14px"><button type="button" class="primary" id="imCheck">Check the rows</button><button type="button" id="imBack">Choose a different file</button></div></div>`);
        const sheetSel = root.querySelector('#imSheet');
        if (sheetSel) sheetSel.addEventListener('change', () => { useSheet(Number(sheetSel.value)); stepMap(); });
        root.querySelector('#imHeader').addEventListener('change', (e) => {
          st.header = Math.min(Math.max(0, (Number(e.target.value) || 1) - 1), st.rows.length - 1); remap(); stepMap();
        });
        root.querySelector('#imBack').addEventListener('click', () => stepChoose());
        root.querySelector('#imCheck').addEventListener('click', () => {
          const m = {};
          root.querySelectorAll('[data-field]').forEach((s) => { m[s.dataset.field] = Number(s.value); });
          if (m.product_name < 0) { const e = root.querySelector('#imErr'); e.textContent = 'Please choose which column holds the product name.'; e.hidden = false; return; }
          st.mapping = m;
          st.items = IM.buildRows(st.rows, m, st.header);
          stepPreview();
        });
      }

      const PREVIEW_COLS = [['product_name', 'Product'], ['supplier', 'Supplier'], ['place', 'Place'], ['place_type', 'Type'], ['quantity', 'Qty'], ['unit', 'Unit'], ['un_number', 'UN'], ['dg_class', 'ADG class'], ['packing_group', 'PG'], ['hazchem_code', 'Hazchem'], ['sds_date', 'SDS date'], ['decision', 'Decision']];

      function stepPreview(dry) {
        const s = IM.summarise(st.items);
        const probs = st.items.filter((i) => i.problems.length);
        const shown = st.items.slice(0, 15);
        const rowHtml = (it) => `<tr class="${it.skip ? 'bad' : it.problems.length ? 'warn' : ''}"><td>${it.rowNumber}</td>${PREVIEW_COLS.map(([k]) => `<td>${App.esc(it.row[k] == null ? '' : it.row[k])}</td>`).join('')}<td class="wrap">${it.problems.map((p) => App.esc(p.text)).join('<br>')}</td></tr>`;
        const head = `<thead><tr><th scope="col">Row</th>${PREVIEW_COLS.map(([, l]) => `<th scope="col">${l}</th>`).join('')}<th scope="col">Problems</th></tr></thead>`;
        shell(`<div class="card"><h2>3. Check the rows</h2>
          <div class="im-stats"><span><strong>${s.total}</strong> rows found</span><span><strong>${s.importable}</strong> ready to import</span><span><strong>${s.withWarnings}</strong> with notes</span><span><strong>${s.skipped}</strong> will be skipped</span></div>
          <p class="hint">Rows with a note are still imported, with the unclear value left blank. Rows with no product name are skipped. Products already in the register (same name and supplier) are skipped by the import. The place column becomes a place (a workshop, vehicle or site); places that do not exist yet are created.</p>
          ${probs.length ? `<h3 style="font-size:14px;margin:12px 0 6px">Rows with notes (${probs.length})</h3><div class="im-wrap" style="max-height:340px;overflow:auto"><table class="im-t">${head}<tbody>${probs.slice(0, 200).map(rowHtml).join('')}</tbody></table></div>${probs.length > 200 ? '<p class="hint">Showing the first 200.</p>' : ''}` : ''}
          <h3 style="font-size:14px;margin:12px 0 6px">First ${shown.length} rows</h3><div class="im-wrap"><table class="im-t">${head}<tbody>${shown.map(rowHtml).join('')}</tbody></table></div>
          <div id="imDry">${dry || ''}</div>
          <div class="actions" style="margin-top:14px"><button type="button" class="primary" id="imDryBtn"${s.importable ? '' : ' disabled'}>Test run (nothing is saved)</button><button type="button" id="imBack2">Back to the columns</button></div></div>`);
        root.querySelector('#imBack2').addEventListener('click', () => stepMap());
        root.querySelector('#imDryBtn').addEventListener('click', () => run(true));
      }

      // Rows for the same product must travel in ONE request (the Worker merges them into one chemical with
      // several locations), so sort by product and only split between different products.
      function batches(items) {
        const key = (i) => (i.row.product_name || '').toLowerCase() + '|' + (i.row.supplier || '').toLowerCase();
        const sorted = items.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.rowNumber - b.rowNumber));
        const out = []; let cur = [];
        for (const it of sorted) {
          if (cur.length >= 1500 && key(cur[cur.length - 1]) !== key(it)) { out.push(cur); cur = []; }
          cur.push(it);
        }
        if (cur.length) out.push(cur);
        return out;
      }

      async function send(items, dry) {
        const total = { created: 0, skipped: 0, locations: 0, places: 0, errors: [], skippedRows: [] };
        for (const part of batches(items)) {
          const r = await App.api('/import', { method: 'POST', body: { rows: part.map((i) => i.row), dry_run: !!dry } });
          total.created += Number(r.created) || 0;
          total.skipped += Number(r.skipped) || 0;
          total.locations += Number(r.links_created != null ? r.links_created : r.locations_created) || 0;
          total.places += Number(r.places_created) || 0;
          (r.errors || []).forEach((e) => {
            const it = e && e.row ? part[e.row - 1] : null;
            total.errors.push((it ? 'Row ' + it.rowNumber + ': ' : '') + (typeof e === 'string' ? e : e.error || e.message || JSON.stringify(e)));
          });
          (r.skipped_rows || []).forEach((s) => total.skippedRows.push(s.product_name));
        }
        return total;
      }

      async function run(dry) {
        const rows = st.items.filter((i) => !i.skip);
        const btn = root.querySelector('#imDryBtn'); if (btn) btn.disabled = true;
        const box = root.querySelector('#imDry');
        if (box) box.innerHTML = '<p class="muted" role="status">Working...</p>';
        try {
          const r = await send(rows, dry);
          if (dead) return;
          if (dry) {
            const html = `<div class="notice" role="status" style="margin-top:12px"><strong>Test run finished.</strong> ${r.created} would be added, ${r.skipped} already in the register would be skipped, ${r.locations} place link${r.locations === 1 ? '' : 's'} would be added${r.places ? ' and ' + r.places + ' new place' + (r.places === 1 ? '' : 's') + ' created' : ''}${r.errors.length ? `, and ${r.errors.length} had problems` : ''}.
              ${r.errors.length ? `<ul>${r.errors.slice(0, 20).map((e) => `<li>${App.esc(e)}</li>`).join('')}</ul>` : ''}
              <div class="actions" style="margin-top:10px"><button type="button" class="primary" id="imGo"${r.created ? '' : ' disabled'}>Import ${r.created} chemical${r.created === 1 ? '' : 's'} now</button></div></div>`;
            stepPreview(html);
            const go = root.querySelector('#imGo');
            if (go) go.addEventListener('click', async () => {
              if (await App.confirm(`Add ${r.created} chemicals to the register?`, { okLabel: 'Import', title: 'Import now' })) run(false);
            });
          } else {
            shell(`<div class="card" role="status"><h2>Import finished</h2><p>${r.created} chemical${r.created === 1 ? ' was' : 's were'} added to the register. ${r.skipped} ${r.skipped === 1 ? 'was' : 'were'} skipped because ${r.skipped === 1 ? 'it was' : 'they were'} already there.</p>
              ${r.errors.length ? `<div class="notice warn"><strong>${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}:</strong><ul>${r.errors.slice(0, 30).map((e) => `<li>${App.esc(e)}</li>`).join('')}</ul></div>` : ''}
              <p class="hint">Imported chemicals are not classified yet and have no safety data sheet. The ADG class in a spreadsheet says nothing about the GHS hazard class and category, so they show as "not classified" on the manifest until the SDS is uploaded or an admin records the classification.</p>
              <div class="actions"><a class="btn primary" href="#/register">Open the register</a><a class="btn" href="#/upload">Upload an SDS</a></div></div>`);
          }
        } catch (e) {
          if (dead) return;
          if (box) box.innerHTML = `<p class="error-text" role="alert">${App.esc(e.message || 'The import failed.')}</p>`;
          if (btn) btn.disabled = false;
        }
      }

      stepChoose();
    },
  });
})();
