/* The register (all chemicals) and the hazardous register. Same screen, two views. */
(function () {
  const App = window.App;
  const RISK_RANK = { significant_not_controlled: 0, significant_controlled: 1, uncertain: 2, not_significant: 3 };

  const CHIPS = {
    register: [
      ['all', 'All', () => true],
      ['hazardous', 'Hazardous', (c) => c.decision === 'hazardous'],
      ['not_hazardous', 'Not hazardous', (c) => c.decision === 'not_hazardous'],
      ['no_decision', 'Not classified yet', (c) => !c.decision],
      ['overdue', 'Review overdue', (c) => c.review_status === 'overdue'],
      ['due_soon', 'Due soon', (c) => c.review_status === 'due_soon'],
      ['no_sds', 'No SDS', (c) => c.review_status === 'no_sds' || !c.sds_id],
    ],
    hazardous: [
      ['all', 'All hazardous', () => true],
      ['overdue', 'Review overdue', (c) => c.review_status === 'overdue'],
      ['due_soon', 'Due soon', (c) => c.review_status === 'due_soon'],
      ['no_sds', 'No SDS', (c) => c.review_status === 'no_sds' || !c.sds_id],
      ['not_controlled', 'Risk not controlled', (c) => c.risk_level === 'significant_not_controlled'],
      ['uncertain', 'Risk uncertain', (c) => c.risk_level === 'uncertain'],
    ],
  };

  const SORTS = [
    ['product', 1, 'Product A to Z'],
    ['product', -1, 'Product Z to A'],
    ['supplier', 1, 'Supplier A to Z'],
    ['review', 1, 'Review due soonest'],
    ['sds_date', 1, 'SDS date, oldest first'],
    ['sds_date', -1, 'SDS date, newest first'],
    ['risk', 1, 'Risk, highest first'],
    ['class', 1, 'ADG class'],
  ];

  const txt = (v) => String(v || '').toLowerCase();
  function cmp(key, a, b) {
    const empty = (v) => v === null || v === undefined || v === '';
    let x, y;
    switch (key) {
      case 'supplier': x = txt(a.supplier); y = txt(b.supplier); break;
      case 'review': x = a.review_due; y = b.review_due; break;
      case 'sds_date': x = a.sds_issue_date; y = b.sds_issue_date; break;
      case 'risk': x = a.risk_level in RISK_RANK ? RISK_RANK[a.risk_level] : 9; y = b.risk_level in RISK_RANK ? RISK_RANK[b.risk_level] : 9; break;
      case 'class': x = a.dg_class; y = b.dg_class; break;
      case 'decision': x = a.decision; y = b.decision; break;
      default: x = txt(a.product_name); y = txt(b.product_name);
    }
    if (empty(x) && empty(y)) return 0;
    if (empty(x)) return 2;   // empty values always last (the sign flip below is undone for them)
    if (empty(y)) return -2;
    if (typeof x === 'number') return x - y;
    return String(x).localeCompare(String(y), undefined, { numeric: true });
  }

  function make(kind) {
    const hazardousOnly = kind === 'hazardous';
    const title = hazardousOnly ? 'Hazardous register' : 'Register';
    return {
      title,
      async render(root, params) {
        const chips = CHIPS[kind];
        const state = { items: [], total: 0, chip: 'all', sort: ['product', 1], q: (params.query && params.query.q) || '' };
        let ticket = 0;
        const mq = window.matchMedia('(max-width: 860px)');
        const redraw = () => draw();
        mq.addEventListener('change', redraw);
        App.onLeave(() => mq.removeEventListener('change', redraw));

        root.innerHTML = `
          <div class="topbar">
            <div><h1>${title}</h1><p class="sub">${hazardousOnly ? 'Chemicals classed as hazardous, with their pictograms and signal word. The ADG class is for illustration only.' : 'Every chemical on site.'}</p></div>
            <div class="actions no-print"><button type="button" id="printBtn">Print</button><button type="button" id="csvBtn">Download CSV</button>${App.isAdmin() ? '<a class="btn primary" href="#/chemical/new">Add a chemical</a>' : ''}</div>
          </div>
          ${App.disclaimerHtml()}
          <div class="reg-tools no-print">
            <div class="search"><label class="sr-only" for="regQ">Search</label><input type="search" id="regQ" placeholder="Search name, supplier, product code or CAS" value="${App.esc(state.q)}" autocomplete="off"></div>
            <div><label class="sr-only" for="regSort">Sort by</label><select id="regSort">${SORTS.map((s, i) => `<option value="${i}">${s[2]}</option>`).join('')}</select></div>
          </div>
          <div class="chips no-print" id="chips" role="group" aria-label="Filter"></div>
          <div class="count-line" id="countLine" aria-live="polite"></div>
          <div id="list"></div>`;
        const $ = (s) => root.querySelector(s);

        function visible() {
          const pred = chips.find((c) => c[0] === state.chip)[2];
          const [key, dir] = state.sort;
          return state.items.filter(pred).sort((a, b) => {
            const r = cmp(key, a, b);
            if (r === 2 || r === -2) return r / 2; // empty values last
            return r * dir;
          });
        }

        function drawChips() {
          $('#chips').innerHTML = chips.map((c) => {
            const n = state.items.filter(c[2]).length;
            return `<button type="button" class="chip" data-chip="${c[0]}" aria-pressed="${state.chip === c[0]}">${c[1]} (${n})</button>`;
          }).join('');
        }

        function cardHtml(c) {
          const picto = (hazardousOnly || c.pictograms) ? App.pictogramRow(c.pictograms, 40) + App.overrideMark(c.pictograms_overridden, 'pictograms') : '';
          const meta = [c.signal_word, c.dg_class ? 'ADG class ' + c.dg_class : '', c.sds_issue_date ? 'SDS ' + App.fmtDate(c.sds_issue_date) : ''].filter(Boolean).join(' · ');
          return `<a class="chem-card" href="#/chemical/${c.id}"><div class="name">${App.esc(c.product_name)}</div><div class="sup">${App.esc(c.supplier || 'Supplier not recorded')}</div>
            <div class="badges">${hazardousOnly ? '' : App.decisionBadge(c.decision) + App.overrideMark(c.decision_overridden, 'decision')}${picto}${App.reviewBadge(c.review_status, c.review_due)}${c.decision === 'not_hazardous' ? '' : App.riskBadge(c.risk_level, true)}</div>
            ${meta ? `<div class="meta">${App.esc(meta)}</div>` : ''}</a>`;
        }

        function thBtn(label, key) {
          const on = state.sort[0] === key;
          const arrow = on ? (state.sort[1] === 1 ? ' ▲' : ' ▼') : '';
          return `<th scope="col" aria-sort="${on ? (state.sort[1] === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${key}">${label}${arrow}</button></th>`;
        }

        function tableHtml(items) {
          const head = hazardousOnly
            ? thBtn('Product', 'product') + thBtn('Supplier', 'supplier') + '<th scope="col">Hazards</th><th scope="col">Signal word</th>' + thBtn('ADG class', 'class') + thBtn('SDS date', 'sds_date') + thBtn('Review', 'review') + thBtn('Risk', 'risk')
            : thBtn('Product', 'product') + thBtn('Supplier', 'supplier') + thBtn('Decision', 'decision') + thBtn('SDS date', 'sds_date') + thBtn('Review', 'review') + thBtn('Risk', 'risk');
          const rows = items.map((c) => {
            const risk = c.decision === 'not_hazardous' ? '<span class="muted">Not needed</span>' : App.riskBadge(c.risk_level, true);
            const cells = hazardousOnly
              ? `<td>${App.pictogramRow(c.pictograms, 40) || '<span class="muted">None</span>'}${App.overrideMark(c.pictograms_overridden, 'pictograms')}</td><td>${App.esc(c.signal_word || '')}</td><td>${App.esc(c.dg_class || '')}</td>`
              : `<td>${App.decisionBadge(c.decision)}${App.overrideMark(c.decision_overridden, 'decision')}</td>`;
            return `<tr class="clickable" data-href="#/chemical/${c.id}"><td><a class="prod" href="#/chemical/${c.id}">${App.esc(c.product_name)}</a></td><td>${App.esc(c.supplier || '')}</td>${cells}<td>${App.esc(App.fmtDate(c.sds_issue_date))}</td><td>${App.reviewBadge(c.review_status, c.review_due)}</td><td>${risk}</td></tr>`;
          }).join('');
          return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
        }

        function emptyHtml() {
          if (state.q || state.chip !== 'all') {
            return `<div class="empty-state"><h2>No chemicals match</h2><p>Try a different word, or clear the search and filters.</p><button type="button" id="clearBtn">Clear search and filters</button></div>`;
          }
          return `<div class="empty-state"><h2>${hazardousOnly ? 'No hazardous chemicals yet' : 'No chemicals yet'}</h2><p>${hazardousOnly ? 'Chemicals decided as hazardous will be listed here.' : 'Upload a safety data sheet to add the first chemical.'}</p><a class="btn primary" href="#/upload">Upload an SDS</a></div>`;
        }

        function draw() {
          drawChips();
          const items = visible();
          $('#countLine').textContent = `Showing ${items.length} of ${state.items.length} chemicals` + (state.q && state.items.length >= 50 && state.total >= 50 ? '. Search shows the first 50 matches, so type more to narrow it down.' : '');
          const list = $('#list');
          if (!items.length) { list.innerHTML = emptyHtml(); }
          else if (mq.matches) list.innerHTML = `<div class="cards">${items.map(cardHtml).join('')}</div>`;
          else list.innerHTML = tableHtml(items);
        }

        async function load() {
          const my = ++ticket;
          $('#list').innerHTML = App.loadingHtml('Loading chemicals...');
          try {
            const qs = `filter=${hazardousOnly ? 'hazardous' : 'all'}&limit=2000` + (state.q ? '&q=' + encodeURIComponent(state.q) : '');
            const data = await App.api('/chemicals?' + qs);
            if (my !== ticket) return;
            state.items = data.items || [];
            state.total = data.total || state.items.length;
            draw();
          } catch (err) {
            if (my !== ticket) return;
            App.showError($('#list'), err, load);
          }
        }

        function exportRows() {
          const rows = [hazardousOnly
            ? ['Product', 'Supplier', 'Decision', 'Hazards', 'Signal word', 'ADG class', 'SDS date', 'Review due', 'Review status', 'Risk']
            : ['Product', 'Supplier', 'Decision', 'SDS date', 'Review due', 'Review status', 'Risk', 'ADG class', 'Signal word', 'Hazards']];
          visible().forEach((c) => {
            const risk = c.risk_level ? App.riskLabel(c.risk_level) : (c.decision === 'not_hazardous' ? 'Not needed' : 'No assessment');
            rows.push(hazardousOnly
              ? [c.product_name, c.supplier, App.decisionLabel(c.decision) + (c.decision_overridden ? ' (overridden)' : ''), App.pictogramNames(c.pictograms) + (c.pictograms_overridden ? ' (overridden)' : ''), c.signal_word, c.dg_class, c.sds_issue_date, c.review_due, App.reviewLabel(c.review_status), risk]
              : [c.product_name, c.supplier, App.decisionLabel(c.decision) + (c.decision_overridden ? ' (overridden)' : ''), c.sds_issue_date, c.review_due, App.reviewLabel(c.review_status), risk, c.dg_class, c.signal_word, App.pictogramNames(c.pictograms)]);
          });
          return rows;
        }

        // events
        const onSearch = App.debounce(() => { state.q = $('#regQ').value.trim(); load(); }, 300);
        $('#regQ').addEventListener('input', onSearch);
        $('#regSort').addEventListener('change', (e) => { state.sort = [SORTS[e.target.value][0], SORTS[e.target.value][1]]; draw(); });
        root.addEventListener('click', (e) => {
          const chip = e.target.closest('[data-chip]');
          if (chip) { state.chip = chip.dataset.chip; draw(); const again = $(`[data-chip="${state.chip}"]`); if (again) again.focus(); return; }
          const sb = e.target.closest('[data-sort]');
          if (sb) {
            const k = sb.dataset.sort;
            state.sort = state.sort[0] === k ? [k, -state.sort[1]] : [k, 1];
            draw();
            const again = $(`[data-sort="${k}"]`); if (again) again.focus();
            return;
          }
          if (e.target.id === 'clearBtn') { state.q = ''; state.chip = 'all'; $('#regQ').value = ''; load(); return; }
          const tr = e.target.closest('tr[data-href]');
          if (tr && !e.target.closest('a')) App.navigate(tr.dataset.href);
        });
        $('#csvBtn').addEventListener('click', () => {
          App.download(`sds-ezy-${kind}-${App.today()}.csv`, App.csv([[App.companyName() + ' - ' + title], ['Printed ' + App.fmtDate(App.today())], [(window.DISCLAIMER && window.DISCLAIMER.short) || ''], [], ...exportRows()]), 'text/csv;charset=utf-8');
        });
        $('#printBtn').addEventListener('click', () => {
          const items = visible();
          if (!items.length) { App.toast('There is nothing to print.', 'error'); return; }
          const rowsHtml = items.map((c) => {
            const risk = c.risk_level ? App.riskLabel(c.risk_level) : (c.decision === 'not_hazardous' ? 'Not needed' : 'No assessment');
            const cells = hazardousOnly
              ? `<td>${App.pictogramRow(c.pictograms, 28)}</td><td>${App.esc(c.signal_word || '')}</td><td>${App.esc(c.dg_class || '')}</td>`
              : `<td>${App.esc(App.decisionLabel(c.decision) + (c.decision_overridden ? ' (overridden)' : ''))}</td>`;
            return `<tr><td><strong>${App.esc(c.product_name)}</strong></td><td>${App.esc(c.supplier || '')}</td>${cells}<td>${App.esc(App.fmtDate(c.sds_issue_date))}</td><td>${App.esc(App.reviewLabel(c.review_status))}${c.review_due ? '<br>' + App.esc(App.fmtDate(c.review_due)) : ''}</td><td>${App.esc(risk)}</td></tr>`;
          }).join('');
          const head = hazardousOnly
            ? '<th>Product</th><th>Supplier</th><th>Hazards</th><th>Signal word</th><th>ADG class</th><th>SDS date</th><th>Review</th><th>Risk</th>'
            : '<th>Product</th><th>Supplier</th><th>Decision</th><th>SDS date</th><th>Review</th><th>Risk</th>';
          App.print(`${App.printHeaderHtml()}<h1>${title}</h1><div class="print-sub">Printed ${App.esc(App.fmtDate(App.today()))}. ${items.length} chemicals.</div>${App.disclaimerHtml()}<table class="data"><thead><tr>${head}</tr></thead><tbody>${rowsHtml}</tbody></table>`, { landscape: true });
        });

        await load();
      },
    };
  }

  App.views.register('register', make('register'));
  App.views.register('hazardous', make('hazardous'));
})();
