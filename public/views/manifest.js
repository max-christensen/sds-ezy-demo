// Hazardous chemicals manifest, PER PLACE, by placard / manifest ITEM (Schedule 11 of the WHS Regulations).
// Totals are worked out for each place on its own (computePlaceTotals in /lib/ghs-ref.mjs, done by the server);
// /lib/manifest-layout.js shapes them for display.
//
// REUSABLE: window.SDSLib.manifestView.renderPlaceCheck(container, result, opts) draws one place's check (items table, over / near
// banners, things to check, optional rows) or the vehicle note, for the place page. `result` is the object from
// GET /api/places/:id (`result`) or one entry of GET /api/manifest `places`. opts: {rows, showHeading}. Returns a promise.
(function () {
  const App = window.App;
  window.SDSLib = window.SDSLib || {};

  const CSS = `
  .mf-sheet{background:var(--surface,#fff);border:1px solid var(--border,#dad5c8);border-radius:8px;padding:18px}
  .mf-sheet h2.mf-title{margin:0 0 2px;font-size:20px}
  .mf-sheet .mf-sub{margin:0 0 12px;color:var(--muted,#8a8676);font-size:13px}
  .mf-facts{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:0 0 16px;font-size:13.5px}
  .mf-facts dt{color:var(--ink-soft,#55594f)} .mf-facts dd{margin:0;font-weight:600}
  .mf-over{border:3px solid #b3261e;background:#fdecea;color:#5c0f0a;border-radius:8px;padding:14px 16px;margin:0 0 14px}
  .mf-over h2,.mf-over h4{margin:0 0 6px;font-size:17px;color:#8c1a12}
  .mf-over ul{margin:0;padding-left:20px} .mf-over li{font-weight:700;font-size:15px;margin:4px 0}
  .mf-nearbox{border:3px solid #b7791f;background:#fff4d6;color:#4d3300;border-radius:8px;padding:12px 16px;margin:0 0 14px}
  .mf-nearbox h4{margin:0 0 6px;font-size:16px;color:#7a4f00} .mf-nearbox ul{margin:0;padding-left:20px} .mf-nearbox li{font-weight:600;font-size:14.5px;margin:3px 0}
  .mf-ok{border:2px solid #4c7a4c;background:#e6ede3;border-radius:8px;padding:10px 14px;margin:0 0 14px;font-weight:600}
  .mf-scroll{overflow-x:auto}
  table.mf-table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:6px}
  table.mf-table th,table.mf-table td{border:1px solid var(--border,#dad5c8);padding:5px 7px;text-align:left;vertical-align:top}
  table.mf-table th{background:var(--office-bg,#e7efee);font-weight:600}
  table.mf-table td.num,table.mf-table th.num{text-align:right;font-variant-numeric:tabular-nums}
  table.mf-table thead{display:table-header-group} table.mf-table tr{break-inside:avoid}
  td.st-over{background:#b3261e;color:#fff;font-weight:800;letter-spacing:.04em}
  td.st-near{background:#f6c453;color:#3d2a00;font-weight:800}
  td.st-ok{color:#2f5d2f;font-weight:600} td.st-na{color:#6b5400;font-style:italic;background:#fbf3df}
  tr.mf-detail td{background:#faf9f5;font-size:12.5px} tr.mf-detail ul{margin:0;padding-left:18px}
  .mf-toggle,.mf-all{font-size:13px;padding:6px 10px;min-height:36px}
  .mf-sheet h3{font-size:15px;margin:18px 0 6px}
  .mf-place{border-top:3px solid var(--border,#dad5c8);margin-top:22px;padding-top:6px}
  .mf-place h2{font-size:18px;margin:10px 0 4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .mf-chip{font-size:12px;font-weight:800;padding:2px 9px;border-radius:12px;letter-spacing:.04em}
  .mf-chip.over{background:#b3261e;color:#fff} .mf-chip.near{background:#f6c453;color:#3d2a00} .mf-chip.ok{background:#e6ede3;color:#2f5d2f}
  .mf-note{font-size:12px;color:var(--ink-soft,#55594f);margin:4px 0}
  .mf-vehicle{border:2px dashed var(--border,#dad5c8);border-radius:8px;padding:10px 14px;margin:6px 0 12px}
  .mf-vehicle p{margin:0 0 4px} .mf-vehicle .small{font-size:12px;color:var(--ink-soft,#55594f)}
  .mf-issue{margin:0 0 12px} .mf-issue h4{margin:0 0 2px;font-size:14px} .mf-issue p{margin:0 0 4px;font-size:12.5px;color:var(--ink-soft,#55594f)}
  .mf-issue ul{margin:0;padding-left:20px;font-size:13px}
  .mf-how ul{margin:6px 0;padding-left:20px;font-size:13px} .mf-how li{margin:3px 0}
  .mf-source{font-size:12px;color:var(--muted,#8a8676);margin:16px 0 0}
  .mf-sheet .disclaimer{margin-top:14px}
  @media (max-width:640px){.mf-sheet{padding:12px}table.mf-table{font-size:12px}}
  @media print{.mf-sheet{border:0;padding:0}.mf-scroll{overflow:visible}.mf-over,.mf-nearbox,td.st-over,td.st-near,.mf-chip{-webkit-print-color-adjust:exact;print-color-adjust:exact}.mf-place{break-before:page}}
  `;
  function css() {
    if (document.getElementById('mf-css')) return;
    const s = document.createElement('style'); s.id = 'mf-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  let libs = null;
  async function loadLibs() {
    if (libs) return libs;
    await App.loadScript('/lib/manifest-layout.js');
    const ref = await import('/lib/ghs-ref.mjs');
    libs = { ML: window.SDSLib.manifestLayout, ref };
    return libs;
  }

  const E = (s) => App.esc(s);
  const stClass = (s) => (s === 'OVER' ? 'st-over' : s === 'NEAR' ? 'st-near' : s === 'OK' ? 'st-ok' : 'st-na');
  const stCell = (s, note) => `<td class="${stClass(s)}">${E(s)}${note ? `<br><span style="font-weight:400;font-size:11.5px">${E(note)}</span>` : ''}</td>`;

  // ---- html builders (pure strings; `uid` keeps element ids unique when several places are on one page)
  function contribHtml(x) {
    const parts = x.mixParts ? `<div><strong>Adds up:</strong> ${x.mixParts.map((p) => `item ${p.item}: ${E(libs.ML.fmtNum(p.total))}`).join(', ')}</div>` : '';
    const list = x.contributors.map((c) => `<li>${E(c.name)}: ${E(libs.ML.fmtNum(c.quantity))} ${E(c.unit)}${c.counted ? '' : ' <strong>(not counted: wrong unit for this item)</strong>'}${c.check ? ' <em>(category not confirmed)</em>' : ''}${c.rule === 'spill_compound' ? ' <em>(counted as a lower flash point category: same spill compound)</em>' : ''}</li>`).join('');
    return parts + (list ? `<ul>${list}</ul>` : (x.mixParts ? '' : '<em>No stock</em>'));
  }

  function itemsTable(list, uid, printing) {
    const { ML, ref } = libs;
    const L = ML.LAYOUT;
    const head = `<thead><tr>${L.items.map((c) => `<th scope="col"${c.num ? ' class="num"' : ''}>${E(c.key === 'total' ? 'Total here' : c.label)}</th>`).join('')}${printing ? '' : '<th scope="col"><span class="sr-only">Details</span></th>'}</tr></thead>`;
    const body = list.map((x) => {
      const notes = x.notes.length ? ' ' + x.notes.map((n) => `<sup title="${E(ref.PLACARD_NOTES[n] || '')}">note ${n}</sup>`).join(' ') : '';
      const main = `<tr><td class="num">${x.item}</td><td>${E(x.title)}${notes}</td><td>${E(x.adg)}</td><td class="num">${E(ML.fmtNum(x.placard))} ${E(x.unit)}</td><td class="num">${E(ML.fmtNum(x.manifest))} ${E(x.unit)}</td><td class="num"><strong>${E(x.totalText)}</strong></td>${stCell(x.pstatus, x.pnote)}${stCell(x.mstatus, x.mnote)}<td>${printing ? contribHtml(x) : E(x.productsText)}</td>${printing ? '' : `<td>${x.hasStock ? `<button type="button" class="mf-toggle" data-d="mfd-${uid}-${x.item}" aria-expanded="false">Details</button>` : ''}</td>`}</tr>`;
      const det = printing ? '' : `<tr class="mf-detail" id="mfd-${uid}-${x.item}" hidden><td></td><td colspan="${L.items.length}">${contribHtml(x)}</td></tr>`;
      return main + det;
    }).join('');
    return `<table class="mf-table">${head}<tbody>${body}</tbody></table>`;
  }

  function rowsTable(rows) {
    const L = libs.ML.LAYOUT;
    if (!rows || !rows.length) return `<p class="muted">${E(L.emptyText)}</p>`;
    return `<table class="mf-table"><thead><tr>${L.rows.map((c) => `<th scope="col"${c.num ? ' class="num"' : ''}>${E(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${L.rows.map((c) => `<td${c.num ? ' class="num"' : ''}>${E(c.get(r))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function issuesHtml(groups) {
    if (!groups.length) return '<p class="muted">Nothing needs checking.</p>';
    return groups.map((g) => `<div class="mf-issue"><h4>${E(g.title)} (${g.entries.length})</h4>${g.help ? `<p>${E(g.help)}</p>` : ''}<ul>${g.entries.map((e) => `<li>${E(e.message)}</li>`).join('')}</ul></div>`).join('');
  }

  function bannersHtml(model) {
    const { ML } = libs;
    const over = ML.overBanners(model), near = ML.nearBanners(model);
    let h = '';
    if (over.length) h += `<div class="mf-over" role="alert"><h4>Over the placard or manifest quantity</h4><ul>${over.map((b) => `<li>${E(b.text)}</li>`).join('')}</ul></div>`;
    if (near.length) h += `<div class="mf-nearbox" role="status"><h4>Near the quantity (80% or more)</h4><ul>${near.map((b) => `<li>${E(b.text)}</li>`).join('')}</ul></div>`;
    if (!over.length && !near.length && model.some((x) => x.hasStock)) h += '<div class="mf-ok" role="status">No item is over or near its placard or manifest quantity here.</div>';
    return h;
  }

  function vehicleHtml(result) {
    return `<div class="mf-vehicle"><p>${E(result.note || '')}</p>${result.caveat ? `<p class="small">${E(result.caveat)}</p>` : ''}</div>`;
  }

  // One place's check as html. o: {uid, rows, showAll, printing}
  function checkHtml(result, o) {
    const { ML } = libs;
    if (!result.counts) return vehicleHtml(result);
    const model = ML.itemsModel(result.totals);
    const stock = model.filter((x) => x.hasStock);
    const list = o.printing ? stock : (o.showAll ? model : stock);
    const hidden = model.length - stock.length;
    const groups = ML.groupIssues(result.totals);
    return `${bannersHtml(model)}
      ${list.length ? `<div class="mf-scroll">${itemsTable(list, o.uid, o.printing)}</div>` : '<p class="muted">No quantities are recorded here, so every item is at zero.</p>'}
      ${o.printing ? (hidden ? `<p class="mf-note">${hidden} other items in the table have no stock here and are not listed.</p>` : '') : (hidden ? `<p><button type="button" class="mf-all" data-all="${o.uid}" aria-pressed="${!!o.showAll}">${o.showAll ? 'Show only items with stock' : 'Show all ' + model.length + ' items'}</button></p>` : '')}
      <h3>Things to check${groups.length ? ` (${groups.reduce((n, g) => n + g.entries.length, 0)})` : ''}</h3>${issuesHtml(groups)}
      ${o.rows ? `<h3>Hazardous chemicals kept here</h3><div class="mf-scroll">${rowsTable(o.rows)}</div>` : ''}`;
  }

  function howHtml() {
    const { ML, ref } = libs;
    return `<div class="mf-how"><p class="mf-note">${E(ref.ADG_COLUMN_NOTE)}</p><p class="mf-note"><strong>Flammable liquids category 4:</strong> ${E(ref.FLAM_LIQ_CAT4_RULE)}</p>
      <p class="mf-note"><strong>Notes to the table</strong></p><ul>${Object.entries(ref.PLACARD_NOTES).map(([n, t]) => `<li><strong>Note ${n}:</strong> ${E(t)}</li>`).join('')}</ul>
      <p class="mf-note"><strong>"Near"</strong> means ${Math.round(ref.NEAR_FRACTION * 100)}% or more of the quantity but not over it. It is a reading aid; the table has no such threshold.</p>
      <p class="mf-note"><strong>Vehicles:</strong> ${E(ref.VEHICLE_TRANSPORT_NOTE)} ${E(ref.VEHICLE_TRANSPORT_CAVEAT)}</p>
      <p class="mf-note"><strong>Where the source is not clear, SDS EZY takes the cautious reading:</strong></p><ul>${ML.DECISIONS.map((d) => `<li>${E(d)}</li>`).join('')}</ul></div>`;
  }

  // Wire the Details / Show all buttons inside `container`. rerender(uid) is called for "show all".
  function wire(container, rerender) {
    container.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !container.contains(t)) return;
      if (t.classList.contains('mf-toggle')) {
        const d = container.querySelector('#' + t.dataset.d);
        if (!d) return;
        const open = d.hidden; d.hidden = !open; t.setAttribute('aria-expanded', String(open)); t.textContent = open ? 'Hide' : 'Details';
      } else if (t.classList.contains('mf-all')) rerender(t.dataset.all);
    });
  }

  // ---- reusable: one place's check, for the place page
  async function renderPlaceCheck(container, result, opts) {
    css();
    await loadLibs();
    const o = opts || {};
    const state = { showAll: false };
    const draw = () => { container.innerHTML = `<div class="mf-sheet">${o.showHeading ? `<h2>${E(result.place.name)}</h2>` : ''}${checkHtml(result, { uid: 'p' + result.place.id, rows: o.rows, showAll: state.showAll })}</div>`; };
    draw();
    wire(container, () => { state.showAll = !state.showAll; draw(); });
  }
  window.SDSLib.manifestView = { renderPlaceCheck };

  App.views.register('manifest', {
    title: 'Manifest',
    async render(root) {
      css();
      root.innerHTML = App.loadingHtml('Loading the manifest...');
      const { ML, ref } = await loadLibs();
      const L = ML.LAYOUT;
      const m = await App.api('/manifest');
      const places = m.places || [], notCounted = m.not_counted || [];
      const company = Object.assign({}, App.settings || {});
      const when = App.fmtDate(m.generated_at || new Date().toISOString());
      const rank = (sec) => { const mod = ML.itemsModel(sec.totals); return mod.some((x) => x.placardOver || x.manifestOver) ? 0 : mod.some((x) => x.placardNear || x.manifestNear) ? 1 : 2; };
      places.sort((a, b) => rank(a) - rank(b) || String(a.place.name).localeCompare(String(b.place.name)));
      const summary = ML.summaryLines(m);
      const showAll = new Set();

      function summaryHtml() {
        let h = '';
        if (summary.over.length) h += `<div class="mf-over" role="alert"><h2>Over the placard or manifest quantity</h2><ul>${summary.over.map((b) => `<li>${E(b.text)}</li>`).join('')}</ul></div>`;
        if (summary.near.length) h += `<div class="mf-nearbox" role="status"><h4>Near the quantity (80% or more)</h4><ul>${summary.near.map((b) => `<li>${E(b.text)}</li>`).join('')}</ul></div>`;
        if (!summary.over.length && !summary.near.length) h += places.length ? '<div class="mf-ok" role="status">No place is over or near its placard or manifest quantity.</div>' : '';
        return h;
      }
      const chip = (sec) => {
        const mod = ML.itemsModel(sec.totals);
        const over = mod.some((x) => x.placardOver || x.manifestOver), near = mod.some((x) => x.placardNear || x.manifestNear);
        return `<span class="mf-chip ${over ? 'over' : near ? 'near' : 'ok'}">${over ? 'OVER' : near ? 'NEAR' : 'OK'}</span>`;
      };
      function placeSection(sec, printing) {
        const uid = 'm' + sec.place.id;
        return `<section class="mf-place" aria-labelledby="mfp-${uid}"><h2 id="mfp-${uid}">${E(ML.placeTitle(sec.place))} ${chip(sec)}</h2>${checkHtml({ counts: true, totals: sec.totals }, { uid, rows: sec.rows, showAll: showAll.has(uid), printing })}</section>`;
      }
      function notCountedHtml() {
        if (!notCounted.length) return '';
        return `<section class="mf-place"><h2>Places that are not counted</h2>${notCounted.map((n) => `<div class="mf-vehicle"><p><strong>${E(ML.placeTitle(n.place))}</strong></p><p>${E(n.note || '')}</p>${n.caveat ? `<p class="small">${E(n.caveat)}</p>` : ''}</div>`).join('')}</section>`;
      }
      function sheetHtml(printing) {
        const facts = ML.headerFacts(company, when, L);
        return `<style>${CSS}</style><div class="mf-sheet">
          <h2 class="mf-title">${E(L.title)}</h2><p class="mf-sub">${E(L.subtitle)}. Worked out for each place on its own.</p>
          <dl class="mf-facts">${facts.map((f) => `<dt>${E(f.label)}</dt><dd>${E(f.value)}</dd>`).join('')}</dl>
          ${summaryHtml()}
          ${places.length ? places.map((s) => placeSection(s, printing)).join('') : '<div class="empty-state"><h2>No place counts yet</h2><p>Add a workshop, depot or site and link chemicals to it. Vehicles are listed below but not counted.</p></div>'}
          ${notCountedHtml()}
          <p class="mf-note">${E(ref.ADG_COLUMN_NOTE)}</p>
          <h3>How this is worked out</h3>${printing ? howHtml() : `<details><summary>Show how this is worked out</summary>${howHtml()}</details>`}
          <p class="mf-source">${E(ML.SOURCE_LINE)}</p>
          ${App.disclaimerHtml()}</div>`;
      }

      root.innerHTML = `<div class="topbar"><div><h1>${E(L.title)}</h1><p class="sub">Quantities held at each place against the placard and manifest quantities in Schedule 11.</p></div>
        <div class="actions no-print"><button type="button" class="primary" id="mfPrint">Print</button><button type="button" id="mfCsv">Download CSV</button></div></div>
        <div id="mfBody"></div>`;
      const body = root.querySelector('#mfBody');
      const draw = () => { body.innerHTML = sheetHtml(false); };
      draw();
      wire(body, (uid) => { if (showAll.has(uid)) showAll.delete(uid); else showAll.add(uid); draw(); });

      root.querySelector('#mfPrint').addEventListener('click', () => App.print(App.printHeaderHtml() + sheetHtml(true), { landscape: true }));
      root.querySelector('#mfCsv').addEventListener('click', () => {
        const csv = ML.csvRows({ places, not_counted: notCounted, generated_at: when }, company, ref);
        csv.splice(1, 0, [(window.DISCLAIMER && window.DISCLAIMER.short) || '']);
        App.download('hazardous-manifest-' + (m.generated_at || App.today()).slice(0, 10) + '.csv', App.csv(csv), 'text/csv;charset=utf-8');
      });
    },
  });
})();
