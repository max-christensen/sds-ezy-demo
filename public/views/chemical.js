/* Chemical page (#/chemical/:id) and the admin edit screen (#/chemical/:id/edit). */
(function () {
  const App = window.App;
  const esc = App.esc;
  const FORMS = ['liquid', 'solid', 'powder', 'gas', 'aerosol', 'paste', 'other'];
  const KINDS = [
    ['isolation', 'Isolation'], ['ventilation', 'Ventilation'], ['other', 'Other controls'],
    ['ppe', 'PPE'], ['additional_ppe', 'Additional PPE'],
  ];
  const FIELD_NAMES = {
    issue_date: 'SDS issue date', revision: 'Revision', emergency_phone: 'Emergency phone', signal_word: 'Signal word',
    hazard_classification: 'Hazard classification', h_statements: 'Hazard statements', p_statements: 'Precautionary statements',
    poison_schedule: 'Poison schedule', un_number: 'UN number', dg_class: 'Dangerous goods class', subsidiary_class: 'Subsidiary class',
    packing_group: 'Packing group', hazchem_code: 'Hazchem code', proper_shipping_name: 'Proper shipping name',
    cas_numbers: 'CAS numbers', supplier: 'Supplier', title: 'Product name on the SDS', fire_response: 'Fire response', spill_response: 'Spill response',
    use_description: 'Description of use', controls_notes: 'Control notes', ppe_notes: 'PPE notes',
  };
  const fieldName = (f) => FIELD_NAMES[f] || String(f).replace(/_/g, ' ');

  // ------------------------------------------------------------ small helpers
  const nl = (s) => esc(s).replace(/\r?\n/g, '<br>');
  function list(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch (e) { return []; }
  }
  const FLAG = '<span class="flag">Not found in the SDS text, check</span>';
  function kvRow(label, value, field, unv) {
    const has = value !== null && value !== undefined && String(value).trim() !== '';
    const html = has ? (typeof value === 'object' && value.html ? value.html : nl(value)) : '<span class="none">Not recorded</span>';
    return `<dt>${esc(label)}</dt><dd>${html}${field && unv && unv.has(field) ? FLAG : ''}</dd>`;
  }
  const fmtQty = (q) => Number(q).toLocaleString(undefined, { maximumFractionDigits: 3 });
  const tick = (label, on, stack) => `<span class="tick${on ? ' on' : ''}${stack ? ' stack' : ''}">${esc(label)}<span class="sr-only"> (${on ? 'ticked' : 'not ticked'})</span></span>`;
  const phoneLink = (p) => p ? { html: `<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}">${esc(p)}</a>` } : '';

  // ------------------------------------------------------------ the assessment checklist (screen and print)
  function assessmentTable(d) {
    const a = d.assessment, c = d.chemical, s = d.sds;
    const unv = new Set([...list(a.unverified)]);
    const by = {};
    (a.controls || []).forEach((o) => { (by[o.kind] = by[o.kind] || []).push(o.label); });
    const group = (kind, title) => `<div class="ctl-group"><b>${title}</b>${by[kind] && by[kind].length ? `<ul>${by[kind].map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<span class="muted">None selected</span>'}</div>`;
    const yn = (needed, note) => `${tick('Yes', needed === 1 || needed === true)}${tick('No', needed === 0 || needed === false)}${needed === null || needed === undefined ? '<span class="muted">Not decided yet</span>' : ''}${note ? `<div>${nl(note)}</div>` : ''}`;
    const row = (label, html, field) => `<tr><th scope="row">${esc(label)}</th><td>${html}${field && unv.has(field) ? FLAG : ''}</td></tr>`;
    const text = (v) => v && String(v).trim() ? nl(v) : '<span class="muted">Not recorded</span>';
    const phone = s && s.emergency_phone ? ` <span class="muted">Emergency phone:</span> ${esc(s.emergency_phone)}` : '';
    return `<table class="checklist"><tbody>
      ${row('Product', `<strong>${esc(c.product_name)}</strong>`)}
      ${row('Supplier and phone', (c.supplier ? esc(c.supplier) : '<span class="muted">Not recorded</span>') + phone)}
      ${row('Date of assessment', a.assessed_date ? esc(App.fmtDate(a.assessed_date)) : '<span class="muted">Not recorded</span>')}
      ${row('SDS date', (a.sds_date || (s && s.issue_date)) ? esc(App.fmtDate(a.sds_date || s.issue_date)) : '<span class="muted">Not recorded</span>')}
      ${row('Form', a.form || c.physical_form ? esc(a.form || c.physical_form) : '<span class="muted">Not recorded</span>')}
      ${row('Description of use', text(a.use_description || c.use_description), 'use_description')}
      ${row('Routes of entry', tick('Inhalation', a.route_inhalation) + tick('Ingestion', a.route_ingestion) + tick('Absorption (skin or eyes)', a.route_absorption))}
      ${row('Fire response', text(a.fire_response), 'fire_response')}
      ${row('Spill response', text(a.spill_response), 'spill_response')}
      ${row('Controls', group('isolation', 'Isolation') + group('ventilation', 'Ventilation') + group('other', 'Other') + (a.controls_notes ? `<div>${nl(a.controls_notes)}</div>` : ''), 'controls_notes')}
      ${row('PPE', group('ppe', 'PPE') + group('additional_ppe', 'Additional PPE') + (a.ppe_notes ? `<div>${nl(a.ppe_notes)}</div>` : ''), 'ppe_notes')}
      ${row('Level of risk', `<div class="risk-options">${App.RISK_LEVELS.map((l) => tick(App.riskLabel(l), a.risk_level === l)).join('')}</div>`)}
      ${row('Atmospheric monitoring needed', yn(a.monitoring_needed, a.monitoring_note))}
      ${row('Health surveillance needed', yn(a.surveillance_needed, a.surveillance_note))}
      ${row('Assessed by and date', `${a.assessed_by ? esc(a.assessed_by) : '<span class="muted">Not recorded</span>'}${a.assessed_date ? ' on ' + esc(App.fmtDate(a.assessed_date)) : ''}`)}
    </tbody></table>`;
  }

  function aiNote(a) {
    if (a.source === 'ai') {
      return `<div class="notice"><span class="badge ai">Prepared from the SDS</span> on ${esc(App.fmtDate(a.created_at))}. This is a draft. Read it, check it against the SDS and your own workplace, and correct anything that is wrong.</div>`;
    }
    if (a.source === 'blank') return '<div class="notice warn">This assessment has not been filled in yet. The level of risk is "Uncertain" until someone completes it.</div>';
    return '';
  }

  function hazardSummaryLine(d) {
    const c = d.chemical;
    return `<div class="pa-head" style="margin:6px 0 10px">${App.pictogramRow(c.pictograms, 44)} ${c.signal_word ? `<strong>${esc(c.signal_word)}</strong>` : ''}</div>`;
  }

  // ------------------------------------------------------------ classification (from the Safe Work Australia poster)
  const G = () => App.GHS;
  function pList(v) { return G().parsePictogramList(v) || []; }
  const hText = (code) => `<span class="hcode">${esc(code)}</span> ${esc(G().H_STATEMENTS[code] || '')}`;

  // Table of each classified class and category: pictogram, signal word, H-code and hazard statement.
  function classTableHtml(cls) {
    const rows = [];
    cls.forEach((e) => {
      const unconfirmed = e.k == null;
      G().rowsFor(e.c, unconfirmed ? null : String(e.k)).forEach((r, i) => rows.push({ e, r, first: i === 0, unconfirmed }));
    });
    if (!rows.length) return '';
    return `<table class="rtable classtable"><thead><tr><th>Class and category</th><th>Pictogram</th><th>Signal word</th><th>Hazard statement</th></tr></thead><tbody>${rows.map(({ e, r, first, unconfirmed }) => {
      const cat = unconfirmed ? '<span class="flag">Category not confirmed, check the SDS</span>' : esc(G().categoryText(r.categories.includes(String(e.k)) ? e.k : r.categories[0]));
      const src = e.src === 'ai' ? 'read by the AI' : e.src === 'h_code' ? 'from the H-codes' : e.src === 'admin' ? 'added by an admin' : '';
      return `<tr><td data-label="Class"><strong>${esc(r.classLabel)}</strong><br>${unconfirmed ? esc(r.categories.map(G().categoryText).join(' / ')) + (first ? '<br>' + cat : '') : cat}${e.check ? ' <span class="flag">Check this one</span>' : ''}${src ? `<br><span class="cls-src">${src}</span>` : ''}</td>
        <td class="pic" data-label="Pictogram">${r.pictograms.length ? App.pictogramRow(r.pictograms, 44) : '<span class="muted">No pictogram</span>'}</td>
        <td data-label="Signal word">${r.signal ? esc(r.signal) : '<span class="muted">No signal word</span>'}</td>
        <td data-label="Hazard statement">${r.hCodes.length ? r.hCodes.map(hText).join('<br>') : '<span class="muted">None</span>'}${r.note ? `<div class="hint">${esc(r.note)}</div>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  // "Derived from the classification" or "Overridden by an admin (derived: ...)"
  function provenance(overridden, derivedText) {
    return overridden ? `<span class="ovr">Overridden by an admin</span> <span class="muted small-text">(derived: ${esc(derivedText)})</span>` : '<span class="muted small-text">Derived from the classification</span>';
  }
  const derivedPictText = (codes) => codes.length ? App.pictogramNames(codes) : 'none';

  function classificationCard(d, admin) {
    const c = d.chemical;
    const cls = Array.isArray(c.classification) ? c.classification : null;
    const flags = list(c.classification_flags);
    const der = c.derived || {};
    const derPict = pList(der.pictograms);
    let h = `<section class="card" id="classCard"><div class="card-head"><h2>Classification <span class="count">(from the Safe Work Australia poster)</span></h2>${admin ? `<a class="btn no-print" href="#/chemical/${c.id}/edit?focus=classification">${cls === null ? 'Classify' : 'Edit classification'}</a>` : ''}</div>`;
    if (flags.length) h += `<div class="notice warn" role="note"><strong>Check these details.</strong><ul style="margin:4px 0 0;padding-left:18px">${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`;
    if (cls === null) {
      h += '<div class="notice"><strong>Not classified yet.</strong> Nobody has read the hazard classes and categories from the SDS (section 2), so there is no hazardous or not hazardous decision yet.</div>';
    } else if (!cls.length) {
      h += '<div class="notice"><strong>Classified: it carries none of the classifications, so it is non-hazardous.</strong></div>';
    } else {
      h += classTableHtml(cls);
    }
    h += `<dl class="kv" style="margin-top:14px">
      <dt>Decision</dt><dd>${App.decisionBadge(c.decision)} ${provenance(c.decision_overridden, App.decisionLabel(der.decision || null))}${c.decision_by ? ` <span class="muted small-text">set by ${esc(c.decision_by)}${c.decision_at ? ' on ' + esc(App.fmtDate(c.decision_at)) : ''}</span>` : ''}</dd>
      <dt>Pictograms</dt><dd>${App.pictogramRow(c.pictograms, 56) || '<span class="none">None</span>'} ${provenance(c.pictograms_overridden, derivedPictText(derPict))}</dd>
      <dt>Signal word</dt><dd>${c.signal_word ? esc(c.signal_word) : '<span class="none">None</span>'} <span class="muted small-text">Derived from the classification</span></dd>
      ${c.decision_note ? `<dt>Note</dt><dd>${nl(c.decision_note)}</dd>` : ''}
    </dl></section>`;
    return h;
  }

  function printAssessment(d) {
    const c = d.chemical, a = d.assessment;
    const locs = (d.places || []).slice(0, 8);
    const locHtml = locs.length ? `<p style="margin:8px 0 2px"><strong>Kept at:</strong> ${locs.map((l) => esc(l.name) + (l.registration ? ' ' + esc(l.registration) : '') + (l.quantity != null && l.unit ? ' (' + fmtQty(l.quantity) + ' ' + esc(l.unit) + ')' : '')).join('; ')}</p>` : '';
    App.print(`${App.printHeaderHtml()}<h1>Hazard risk assessment: ${esc(c.product_name)}</h1>
      <div class="print-sub">${esc(c.supplier || '')}${c.supplier ? ' · ' : ''}Printed ${esc(App.fmtDate(App.today()))}</div>
      ${hazardSummaryLine(d)}
      ${a.source === 'ai' ? `<p style="margin:0 0 6px"><strong>Prepared from the SDS</strong> on ${esc(App.fmtDate(a.created_at))} (draft, to be checked).</p>` : ''}
      ${assessmentTable(d)}${locHtml}
      <div style="margin-top:10px">${App.disclaimerHtml()}</div>`);
  }

  // A "Find SDS" link (new tab) for a chemical with no SDS: the supplier's own search page if known, else a web search.
  function findSdsButton(c) {
    const F = window.SDSLib && window.SDSLib.findSds;
    const l = F && F.findSdsLink({ name: c.product_name, supplier: c.supplier, code: c.product_codes });
    return l && l.url ? ` <a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Find SDS</a>` : '';
  }

  // ------------------------------------------------------------ view screen
  async function renderView(root, id, params) {
    root.innerHTML = App.loadingHtml('Loading chemical...');
    let d;
    try { d = await App.api('/chemicals/' + encodeURIComponent(id)); }
    catch (err) {
      if (err.status === 404) { root.innerHTML = '<div class="empty-state"><h2>Chemical not found</h2><p>It may have been removed.</p><a class="btn primary" href="#/register">Back to the register</a></div>'; return; }
      throw err;
    }
    const c = d.chemical, s = d.sds, a = d.assessment, admin = App.isAdmin();
    const sdsUnv = new Set(list(s && s.unverified));
    // "Find SDS" on the no-SDS card needs the link builder; load it only when it will be shown, and carry on without it if it will not load.
    if (!s && admin) { try { await Promise.all([['/lib/sds-suppliers.js', 'sdsSuppliers'], ['/lib/find-sds.js', 'findSds']].filter(([, k]) => !(window.SDSLib && window.SDSLib[k])).map(([u]) => App.loadScript(u))); } catch (e) { /* the button is simply left out */ } }
    document.title = c.product_name + ' - ' + App.companyName();
    const unvAll = [...new Set([...sdsUnv, ...list(a && a.unverified)])];

    let html = `<a class="crumb no-print" href="#/${c.decision === 'hazardous' ? 'hazardous' : 'register'}">&larr; ${c.decision === 'hazardous' ? 'Hazardous register' : 'Register'}</a>
      <div class="chem-head">
        <div class="topbar" style="margin-bottom:0"><h1>${esc(c.product_name)}</h1>
          <div class="actions no-print">
            ${a ? '<button type="button" id="printBtn">Print assessment</button>' : ''}
            <a class="btn" href="#/chemical/${c.id}/label">QR label</a>
            ${admin ? `<a class="btn primary" href="#/chemical/${c.id}/edit">Edit</a>` : ''}
          </div></div>
        <div class="muted">${esc(c.supplier || 'Supplier not recorded')}</div>
        <div class="badges">${App.decisionBadge(c.decision)}${App.overrideMark(c.decision_overridden, 'decision')}${App.reviewBadge(c.review_status, c.review_due)}${c.decision === 'not_hazardous' ? '' : App.riskBadge(a ? a.risk_level : c.risk_level)}</div>
      </div>
      ${App.disclaimerHtml()}`;

    // Details to check: classification flags and anything the AI returned that was not in the SDS text (fields other than the classification, which has its own card)
    const unvOther = unvAll.filter((f) => f !== 'classification');
    if (unvOther.length) {
      html += `<div class="notice warn" role="note"><strong>Check these details.</strong> They were not found in the text of the SDS, so they have been left blank: ${unvOther.map((f) => esc(fieldName(f))).join(', ')}. Look at the SDS itself and fill them in.</div>`;
    }

    // Product details
    html += `<section class="card"><h2>Product details</h2><dl class="kv">
      ${kvRow('Product', c.product_name)}
      ${kvRow('Supplier', c.supplier)}
      ${kvRow('Other names', c.synonyms)}
      ${kvRow('Product codes', c.product_codes)}
      ${kvRow('Form', c.physical_form)}
      ${kvRow('What it is used for', c.use_description)}
      ${kvRow('Hazardous or not', { html: App.decisionBadge(c.decision) + App.overrideMark(c.decision_overridden, 'decision') })}
    </dl></section>`;

    if (d.has_label_photo) html += `<section class="card"><h2>Label photo</h2><img src="/api/chemicals/${c.id}/label-photo" alt="Photo of the product label" style="max-width:100%;max-height:360px;border-radius:6px"></section>`;

    // Classification from the poster
    html += classificationCard(d, admin);


    // SDS card
    const total = d.sds_products_total != null ? d.sds_products_total : (d.sds_products || []).length;
    html += `<section class="card"><div class="card-head"><h2>Safety data sheet</h2>${s && s.has_file ? `<a class="btn primary no-print" href="/api/sds/${s.id}/file" target="_blank" rel="noopener">View the PDF</a>` : ''}</div>`;
    if (!s) {
      html += `<div class="empty-state" style="padding:18px"><h2>No SDS on file</h2><p>${admin ? 'Attach the safety data sheet so the hazard details and review date can be kept up to date.' : 'Ask an admin to attach one, or upload it from Upload SDS.'}</p>${admin ? `<a class="btn primary" href="#/chemical/${c.id}/edit?focus=sds">Attach an SDS</a>${findSdsButton(c)}` : '<a class="btn" href="#/upload">Upload SDS</a>'}</div>`;
    } else {
      html += `<dl class="kv">
        ${kvRow('Issue date', s.issue_date ? App.fmtDate(s.issue_date) : '', 'issue_date', sdsUnv)}
        ${kvRow('Revision', s.revision, 'revision', sdsUnv)}
        ${kvRow('Emergency phone', phoneLink(s.emergency_phone), 'emergency_phone', sdsUnv)}
        ${kvRow('Review due', { html: App.reviewBadge(c.review_status, s.review_due || c.review_due) })}
        ${kvRow('Version', s.version_no ? 'Version ' + s.version_no : '')}
        ${kvRow('File', s.has_file ? s.file_name : { html: '<span class="none">No PDF attached</span>' })}
      </dl>
      <h3 style="font-size:14px;margin:16px 0 6px">As printed on the SDS</h3>
      <dl class="kv">
        ${kvRow('Signal word', s.signal_word, 'signal_word', sdsUnv)}
        ${kvRow('Hazard classification', s.hazard_classification, 'hazard_classification', sdsUnv)}
        ${kvRow('Hazard statements', s.h_statements, 'h_statements', sdsUnv)}
        ${kvRow('Precautionary statements', s.p_statements, 'p_statements', sdsUnv)}
        ${kvRow('Poison schedule', s.poison_schedule, 'poison_schedule', sdsUnv)}
        ${kvRow('CAS numbers', s.cas_numbers, 'cas_numbers', sdsUnv)}
      </dl>
      <h3 style="font-size:14px;margin:16px 0 2px">Transport details</h3>
      <p class="hint" style="margin:0 0 6px">ADG class (for illustration only; quantities use the GHS classification).</p>
      <dl class="kv">
        ${kvRow('ADG class', s.dg_class, 'dg_class', sdsUnv)}
        ${kvRow('Subsidiary class', s.subsidiary_class, 'subsidiary_class', sdsUnv)}
        ${kvRow('UN number', s.un_number, 'un_number', sdsUnv)}
        ${kvRow('Packing group', s.packing_group, 'packing_group', sdsUnv)}
        ${kvRow('Hazchem code', s.hazchem_code, 'hazchem_code', sdsUnv)}
        ${kvRow('Proper shipping name', s.proper_shipping_name, 'proper_shipping_name', sdsUnv)}
      </dl>`;
      if (total > 0) {
        html += `<details class="lazy" id="prodDetails"><summary>Also covers ${total} other product${total === 1 ? '' : 's'}</summary><ul class="mini-list" id="prodList">${(d.sds_products || []).map((p) => `<li><a href="#/chemical/${p.id}">${esc(p.product_name)}</a></li>`).join('')}</ul></details>`;
      }
      html += `<details class="lazy" id="histDetails"><summary>Version history</summary><div id="histBody" class="muted">Loading...</div></details>`;
    }
    html += '</section>';

    // Assessment
    html += `<section class="card" id="assessCard"><div class="card-head"><h2>Hazard risk assessment</h2>${admin ? `<a class="btn no-print" href="#/chemical/${c.id}/edit?focus=assessment">${a ? 'Edit assessment' : 'Start assessment'}</a>` : ''}</div>`;
    if (c.decision === 'not_hazardous' && !a) {
      html += `<div class="notice"><strong>Not hazardous.</strong> No risk assessment is needed for this chemical.${c.decision_note ? ' ' + esc(c.decision_note) : ''}</div>`;
    } else if (a) {
      if (c.decision === 'not_hazardous') html += '<div class="notice">This chemical is not hazardous. An assessment is shown because one was already made.</div>';
      html += aiNote(a) + hazardSummaryLine(d) + assessmentTable(d);
      html += `<details class="lazy no-print" id="assessHist"><summary>Older assessments</summary><div id="assessHistBody" class="muted">Loading...</div></details>`;
    } else {
      html += `<div class="empty-state" style="padding:18px"><h2>${c.decision ? 'No assessment yet' : 'Not classified yet'}</h2><p>${c.decision ? 'There is no risk assessment for this chemical yet.' : 'This chemical has not been classified yet. Read section 2 of the SDS and record the classification.'}</p>${admin ? `<a class="btn primary" href="#/chemical/${c.id}/edit?focus=${c.decision ? 'assessment' : 'classification'}">${c.decision ? 'Start assessment' : 'Classify it'}</a>` : ''}</div>`;
    }
    html += '</section>';

    // Where it is kept
    const pls = d.places || [];
    html += `<section class="card" id="placesCard"><div class="card-head"><h2>Where it is kept</h2>${admin ? `<a class="btn no-print" href="#/chemical/${c.id}/edit?focus=places">Change places</a>` : ''}</div>`;
    if (!pls.length) html += '<p class="muted" style="margin:0">Not linked to any place yet.</p>';
    else html += `<ul class="rowlist">${pls.map((l) => `<li><a class="item" href="#/place/${l.place_id}"><span><span class="name">${esc(l.name)}</span>${l.archived ? ' <span class="badge none">Archived</span>' : ''}<br><span class="sup">${esc(App.GHS.placeTypeLabel(l.place_type))}${l.registration ? ' &middot; ' + esc(l.registration) : ''}${l.quantity != null && l.unit ? ' &middot; ' + fmtQty(l.quantity) + ' ' + esc(l.unit) : ''}${l.container_note ? ' &middot; ' + esc(l.container_note) : ''}${l.spill_compound ? ' &middot; Spill compound: ' + esc(l.spill_compound) : ''}</span></span><span aria-hidden="true">&rsaquo;</span></a></li>`).join('')}</ul>`;
    html += '</section>';

    root.innerHTML = html;
    if (params && params.query && params.query.to === 'assessment') { const ac = root.querySelector('#assessCard'); if (ac) ac.scrollIntoView({ block: 'start' }); }

    const pb = root.querySelector('#printBtn');
    if (pb) pb.addEventListener('click', () => printAssessment(d));

    const prod = root.querySelector('#prodDetails');
    if (prod && total > (d.sds_products || []).length) {
      prod.addEventListener('toggle', async function once() {
        if (!prod.open) return;
        prod.removeEventListener('toggle', once);
        try {
          const r = await App.api(`/sds/${s.id}/chemicals`);
          const items = (r.items || r.chemicals || r || []).filter((p) => String(p.id) !== String(c.id));
          root.querySelector('#prodList').innerHTML = items.map((p) => `<li><a href="#/chemical/${p.id}">${esc(p.product_name)}</a></li>`).join('');
        } catch (e) { /* keep what we have */ }
      });
    }

    let histData = null;
    async function loadHistory() {
      if (histData) return histData;
      histData = await App.api(`/chemicals/${c.id}/history`);
      return histData;
    }
    const hd = root.querySelector('#histDetails');
    if (hd) hd.addEventListener('toggle', async function once() {
      if (!hd.open) return;
      hd.removeEventListener('toggle', once);
      const body = root.querySelector('#histBody');
      try {
        const h = await loadHistory();
        const v = h.sds_versions || [];
        body.className = '';
        body.innerHTML = v.length ? `<ul class="mini-list">${v.map((x) => `<li><strong>Version ${x.version_no}</strong>${x.is_current ? ' <span class="badge ok">Current</span>' : ''}<span>Issued ${x.issue_date ? esc(App.fmtDate(x.issue_date)) : 'date not recorded'}</span><span class="muted">added ${esc(App.fmtDate(x.uploaded_at))}</span>${x.file_name ? `<a href="/api/sds/${x.id}/file" target="_blank" rel="noopener">View PDF</a>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No earlier versions.</p>';
      } catch (e) { body.textContent = 'Could not load the history: ' + e.message; }
    });
    const ah = root.querySelector('#assessHist');
    if (ah) ah.addEventListener('toggle', async function once() {
      if (!ah.open) return;
      ah.removeEventListener('toggle', once);
      const body = root.querySelector('#assessHistBody');
      try {
        const h = await loadHistory();
        const older = h.assessments || [];
        body.className = '';
        body.innerHTML = older.length ? `<ul class="mini-list">${older.map((x) => `<li><span>${x.assessed_date ? esc(App.fmtDate(x.assessed_date)) : esc(App.fmtDate(x.created_at))}</span>${App.riskBadge(x.risk_level, true)}<span class="muted">${esc(x.assessed_by || '')}</span><button type="button" class="small" data-old="${x.id}">View</button></li>`).join('')}</ul>` : '<p class="muted">No older assessments.</p>';
        body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-old]'); if (!b) return;
          try {
            const old = await App.api('/assessments/' + b.dataset.old);
            const aa = old.assessment || old;
            App.modal({ title: 'Older assessment', wide: true, body: `<div class="notice warn">This is an older assessment, kept for the record.</div>` + assessmentTable({ chemical: c, sds: s, assessment: aa }) });
          } catch (er) { App.toast(er.message, 'error'); }
        });
      } catch (e) { body.textContent = 'Could not load older assessments: ' + e.message; }
    });
  }

  // ------------------------------------------------------------ edit screen (admin)
  const inp = (id, label, val, extra) => `<label for="${id}">${label}</label><input id="${id}" value="${esc(val == null ? '' : val)}" ${extra || ''}>`;
  const area = (id, label, val, rows) => `<label for="${id}">${label}</label><textarea id="${id}" rows="${rows || 2}">${esc(val == null ? '' : val)}</textarea>`;
  const select = (id, label, opts, val) => `<label for="${id}">${label}</label><select id="${id}">${opts.map((o) => `<option value="${esc(o[0])}"${String(o[0]) === String(val == null ? '' : val) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  const formOpts = [['', 'Not recorded']].concat(FORMS.map((f) => [f, f[0].toUpperCase() + f.slice(1)]));

  async function renderEdit(root, id, params) {
    if (!App.isAdmin()) { App.navigate('#/chemical/' + id); return; }
    root.innerHTML = App.loadingHtml('Loading chemical...');
    let d = await App.api('/chemicals/' + encodeURIComponent(id));
    let optionsCache = null;
    document.title = 'Edit ' + d.chemical.product_name + ' - ' + App.companyName();

    root.innerHTML = `<a class="crumb" href="#/chemical/${id}">&larr; Back to the chemical</a>
      <div class="topbar"><div><h1 id="editTitle"></h1><p class="sub">Changes are saved one section at a time.</p></div></div>
      <section class="card" id="cardDetails"></section>
      <section class="card" id="cardClass"></section>
      <section class="card" id="cardSds"></section>
      <section class="card" id="cardAssess"></section>
      <section class="card" id="cardLocs"></section>
      <section class="card" id="cardDanger"></section>`;
    const $ = (s) => root.querySelector(s);

    async function reload(...cards) {
      d = await App.api('/chemicals/' + encodeURIComponent(id));
      drawTitle();
      cards.forEach((n) => draw[n]());
    }
    // The fields every chemical save sends along, so saving one section never blanks another.
    function baseFields() {
      const c = d.chemical;
      return { product_name: c.product_name, supplier: c.supplier, synonyms: c.synonyms, product_codes: c.product_codes, use_description: c.use_description, physical_form: c.physical_form, decision_note: c.decision_note };
    }
    function drawTitle() { $('#editTitle').textContent = 'Edit: ' + d.chemical.product_name; }

    const draw = {
      details() {
        const c = d.chemical;
        $('#cardDetails').innerHTML = `<h2>Product details</h2><form id="fDetails">
          ${inp('c_name', 'Product name', c.product_name, 'required')}
          ${inp('c_supplier', 'Supplier', c.supplier)}
          ${area('c_syn', 'Other names (one per line or separated by commas)', c.synonyms)}
          ${inp('c_codes', 'Product codes', c.product_codes)}
          ${area('c_use', 'What it is used for', c.use_description)}
          ${select('c_form', 'Form', formOpts, c.physical_form)}
          ${area('c_note', 'Note about the classification or decision (optional)', c.decision_note)}
          <div class="actions" style="margin-top:12px"><button class="primary" type="submit">Save details</button></div></form>`;
        $('#fDetails').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = e.target.querySelector('button.primary'); btn.disabled = true;
          try {
            await App.api('/chemicals/' + id, { method: 'PUT', body: {
              product_name: $('#c_name').value.trim(), supplier: $('#c_supplier').value.trim(), synonyms: $('#c_syn').value.trim(),
              product_codes: $('#c_codes').value.trim(), use_description: $('#c_use').value.trim(), physical_form: $('#c_form').value || null,
              decision_note: $('#c_note').value.trim(),
            } });
            App.toast('Details saved.', 'ok');
            await reload('details');
          } catch (err) { App.toast(err.message, 'error'); }
          finally { btn.disabled = false; }
        });
      },

      classification() {
        const c = d.chemical, G = App.GHS;
        const orig = Array.isArray(c.classification) ? c.classification : null;
        const st = {
          mode: orig === null ? 'none' : (orig.length ? 'list' : 'empty'),
          list: (orig || []).map((e) => Object.assign({}, e)),
          decOv: c.decision_override || '',
          pictMode: c.pictograms_override == null ? 'derived' : (pList(c.pictograms_override).length ? 'pick' : 'none'),
          pict: new Set(pList(c.pictograms_override)),
        };
        const box = $('#cardClass');
        const flags = list(c.classification_flags);
        box.innerHTML = `<h2>Classification <span class="count">(from the Safe Work Australia poster)</span></h2>
          <p class="hint" style="margin:0 0 6px">Read section 2 of the SDS and pick each hazard class and category it shows. The decision, signal word and pictograms are worked out from this list.</p>
          ${flags.length ? `<div class="notice warn"><strong>Check these details.</strong><ul style="margin:4px 0 0;padding-left:18px">${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
          <form id="fClass">
          <fieldset><legend>Has it been classified?</legend>
            <label class="inline"><input type="radio" name="cl_mode" value="none"> Not classified yet</label>
            <label class="inline"><input type="radio" name="cl_mode" value="empty"> Classified: it carries none of the classifications (so it is non-hazardous)</label>
            <label class="inline"><input type="radio" name="cl_mode" value="list"> Classified with the hazards below</label>
          </fieldset>
          <div id="clsEditor">
            <ul class="cls-list" id="clsList"></ul>
            <div class="row3" style="align-items:end">
              <div><label for="cl_class">Hazard class</label><select id="cl_class">${G.HAZARD_CLASSES.map((h) => `<option value="${esc(h.id)}">${esc(h.label)}</option>`).join('')}</select></div>
              <div><label for="cl_cat">Category</label><select id="cl_cat"></select></div>
              <div><button type="button" id="cl_add">Add to the list</button></div>
            </div>
          </div>
          <fieldset><legend>Decision override (optional)</legend>
            <p class="hint" style="margin:0 0 4px">Only use this if the classification does not give the right answer. An override is shown to everyone.</p>
            <div class="actions"><label class="inline"><select id="cl_dec" style="width:auto"><option value="">Use the derived decision</option><option value="hazardous">Hazardous</option><option value="not_hazardous">Not hazardous</option></select></label><button type="button" class="small" id="cl_decReset">Reset to derived</button></div>
          </fieldset>
          <fieldset><legend>Pictogram override (optional)</legend>
            <label class="inline"><input type="radio" name="cl_pm" value="derived"> Use the derived pictograms</label>
            <label class="inline"><input type="radio" name="cl_pm" value="pick"> Choose the pictograms myself</label>
            <div class="pic-opts" id="cl_pics">${G.PICTOGRAMS.map((p) => `<label class="inline"><input type="checkbox" name="cl_pic" value="${p.code}"> ${App.pictogramImg(p.code, 40)} <span>${esc(p.code)} ${esc(p.name)}</span></label>`).join('')}</div>
            <label class="inline"><input type="radio" name="cl_pm" value="none"> Show no pictograms</label>
            <div class="actions" style="margin-top:6px"><button type="button" class="small" id="cl_pmReset">Reset to derived</button></div>
          </fieldset>
          <div class="preview" id="clsPreview" aria-live="polite"></div>
          <div class="actions" style="margin-top:12px"><button class="primary" type="submit">Save classification</button></div></form>`;
        const q = (s) => box.querySelector(s);
        const fillCats = () => {
          const h = G.HAZARD_CLASSES.find((x) => x.id === q('#cl_class').value);
          q('#cl_cat').innerHTML = h.categories.map((k) => `<option value="${esc(k)}">${esc(G.categoryText(k))}</option>`).join('') + '<option value="">Category not known</option>';
        };
        function currentPictOverride() { return st.pictMode === 'derived' ? null : st.pictMode === 'none' || !st.pict.size ? [] : [...st.pict]; }
        function refresh() {
          box.querySelectorAll('input[name=cl_mode]').forEach((r) => { r.checked = r.value === st.mode; });
          box.querySelectorAll('input[name=cl_pm]').forEach((r) => { r.checked = r.value === st.pictMode; });
          box.querySelectorAll('input[name=cl_pic]').forEach((x) => { x.checked = st.pict.has(x.value); x.disabled = st.pictMode !== 'pick'; });
          q('#cl_dec').value = st.decOv;
          q('#clsEditor').style.display = st.mode === 'list' ? '' : 'none';
          q('#clsList').innerHTML = st.list.length ? st.list.map((e, i) => `<li><span class="label">${esc(G.classificationLabel(e))}${e.k == null ? ' <span class="flag">Category not confirmed</span>' : ''}${e.check ? ' <span class="flag">Check this one</span>' : ''}</span><button type="button" class="small danger" data-rm="${i}" aria-label="Remove ${esc(G.classificationLabel(e))}">Remove</button></li>`).join('') : '<li class="muted">Nothing added yet.</li>';
          const cl = st.mode === 'none' ? null : st.mode === 'empty' ? [] : st.list;
          const ef = G.effective(cl, { decision: st.decOv || null, pictograms: currentPictOverride() });
          q('#clsPreview').innerHTML = `<strong>What this gives</strong>
            <dl class="kv" style="margin-top:6px"><dt>Decision</dt><dd>${App.decisionBadge(ef.decision)} ${provenance(ef.decision_overridden, App.decisionLabel(ef.derived.decision))}</dd>
            <dt>Pictograms</dt><dd>${App.pictogramRow(ef.pictograms, 44) || '<span class="none">None</span>'} ${provenance(ef.pictograms_overridden, derivedPictText(ef.derived.pictograms))}</dd>
            <dt>Signal word</dt><dd>${ef.signal_word ? esc(ef.signal_word) : '<span class="none">None</span>'}</dd></dl>
            ${cl && cl.length ? classTableHtml(cl) : (cl ? '<p class="muted" style="margin:8px 0 0">It carries none of the classifications, so it is non-hazardous.</p>' : '<p class="muted" style="margin:8px 0 0">Not classified yet, so there is no decision.</p>')}`;
        }
        fillCats();
        q('#cl_class').addEventListener('change', fillCats);
        q('#cl_add').addEventListener('click', () => {
          const e = { c: q('#cl_class').value, k: q('#cl_cat').value || null };
          if (st.list.some((x) => x.c === e.c && x.k === e.k)) { App.toast('That one is already in the list.', 'error'); return; }
          st.list.push(e); st.mode = 'list'; refresh();
        });
        box.addEventListener('click', (e) => {
          const rm = e.target.closest('[data-rm]');
          if (rm) { st.list.splice(Number(rm.dataset.rm), 1); refresh(); }
        });
        box.addEventListener('change', (e) => {
          if (e.target.name === 'cl_mode') st.mode = e.target.value;
          else if (e.target.name === 'cl_pm') st.pictMode = e.target.value;
          else if (e.target.name === 'cl_pic') { e.target.checked ? st.pict.add(e.target.value) : st.pict.delete(e.target.value); }
          else if (e.target.id === 'cl_dec') st.decOv = e.target.value;
          refresh();
        });
        q('#cl_decReset').addEventListener('click', () => { st.decOv = ''; refresh(); });
        q('#cl_pmReset').addEventListener('click', () => { st.pictMode = 'derived'; st.pict = new Set(); refresh(); });
        q('#fClass').addEventListener('submit', async (e) => {
          e.preventDefault();
          if (st.mode === 'list' && !st.list.length) { App.toast('Add at least one hazard class, or choose "carries none of the classifications".', 'error'); return; }
          const po = currentPictOverride();
          const btn = e.target.querySelector('button.primary'); btn.disabled = true;
          try {
            await App.api('/chemicals/' + id, { method: 'PUT', body: Object.assign(baseFields(), {
              ghs_classification: st.mode === 'none' ? null : st.mode === 'empty' ? [] : st.list,
              decision_override: st.decOv || null,
              pictograms_override: po === null ? null : (po.length ? po : 'none'),
            }) });
            App.toast('Classification saved.', 'ok');
            await reload('classification', 'details');
          } catch (err) { App.toast(err.message, 'error'); btn.disabled = false; }
        });
        refresh();
      },

      sds() {
        const s = d.sds, others = d.sds_products_total != null ? d.sds_products_total : (d.sds_products || []).length;
        let h = '<h2>Safety data sheet</h2>';
        if (!s) {
          h += '<p class="muted">No SDS is attached to this chemical.</p><div class="actions"><button type="button" class="primary" id="sdsAttach">Attach an SDS</button></div>';
        } else {
          h += `<dl class="kv">${kvRow('Version', 'Version ' + s.version_no)}${kvRow('Issue date', s.issue_date ? App.fmtDate(s.issue_date) : '')}${kvRow('Review due', s.review_due ? App.fmtDate(s.review_due) : '')}${kvRow('File', s.has_file ? s.file_name : '')}</dl>`;
          if (others > 0) h += `<div class="notice warn" style="margin-top:12px">This SDS is shared with ${others} other product${others === 1 ? '' : 's'}. Changing or replacing it changes it for all of them.</div>`;
          h += `<div class="actions" style="margin-top:12px">${s.has_file ? `<a class="btn" href="/api/sds/${s.id}/file" target="_blank" rel="noopener">View the PDF</a>` : ''}<button type="button" id="sdsEdit">Edit SDS details</button><button type="button" class="primary" id="sdsReplace">Replace with a newer version</button><button type="button" class="danger" id="sdsUnlink">Remove from this product</button></div>`;
        }
        $('#cardSds').innerHTML = h;
        const on = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
        on('#sdsAttach', () => sdsModal('attach'));
        on('#sdsEdit', () => sdsModal('edit'));
        on('#sdsReplace', () => sdsModal('replace'));
        on('#sdsUnlink', async () => {
          if (!await App.confirm('Take this SDS off this chemical? The SDS itself is kept if other products use it.', { okLabel: 'Remove', danger: true })) return;
          try { await App.api(`/chemicals/${id}/unlink-sds`, { method: 'POST', body: {} }); App.toast('SDS removed from this chemical.', 'ok'); await reload('sds', 'assess'); }
          catch (err) { App.toast(err.message, 'error'); }
        });
      },

      async assess() {
        const box = $('#cardAssess');
        box.innerHTML = '<h2>Hazard risk assessment</h2>' + App.loadingHtml('Loading...');
        if (!optionsCache) {
          try { optionsCache = await App.api('/options'); }
          catch (err) { box.innerHTML = '<h2>Hazard risk assessment</h2>'; App.showError(box, err, () => draw.assess()); return; }
        }
        const a = d.assessment, c = d.chemical, s = d.sds;
        const v = a || {
          assessed_date: App.today(), sds_date: s ? s.issue_date : '', form: c.physical_form, use_description: c.use_description,
          risk_level: 'uncertain', assessed_by: App.me.name, controls: [],
        };
        const selected = new Set((v.controls || []).map((o) => String(o.id)));
        const selLabels = new Set((v.controls || []).map((o) => o.kind + '|' + o.label));
        const isSel = (kind, o) => selected.has(String(o.id)) || selLabels.has(kind + '|' + o.label);
        const ctl = (kind, title) => {
          const opts = (optionsCache[kind] || []).filter((o) => o.active !== 0 || isSel(kind, o));
          return `<fieldset><legend>${title}</legend><div class="checks">${opts.length ? opts.map((o) => `<label class="inline"><input type="checkbox" name="ctl" value="${o.id}"${isSel(kind, o) ? ' checked' : ''}> ${esc(o.label)}${o.active === 0 ? ' (no longer offered)' : ''}</label>`).join('') : '<span class="muted">No options. Add some under Options.</span>'}</div></fieldset>`;
        };
        const tri = (name, val) => `<div class="actions">${[['1', 'Yes'], ['0', 'No'], ['', 'Not decided']].map((o) => `<label class="inline"><input type="radio" name="${name}" value="${o[0]}"${(val === null || val === undefined ? '' : String(val ? 1 : 0)) === o[0] ? ' checked' : ''}> ${o[1]}</label>`).join('')}</div>`;
        const unv = list(a && a.unverified);
        box.innerHTML = `<h2>Hazard risk assessment</h2>
          ${a ? aiNote(a) : '<p class="muted">There is no assessment yet. Fill this in from the SDS.</p>'}
          ${unv.length ? `<div class="notice warn">Not found in the SDS text, check: ${unv.map((f) => esc(fieldName(f))).join(', ')}.</div>` : ''}
          <form id="fAssess">
          <div class="row2">${inp('a_date', 'Date of assessment', v.assessed_date, 'type="date"')}${inp('a_sds', 'SDS date', v.sds_date, 'type="date"')}</div>
          <div class="row2">${select('a_form', 'Form', formOpts, v.form)}${inp('a_by', 'Assessed by', v.assessed_by)}</div>
          ${area('a_use', 'Description of use', v.use_description, 2)}
          <fieldset><legend>Routes of entry</legend><div class="checks">
            <label class="inline"><input type="checkbox" id="a_inh"${v.route_inhalation ? ' checked' : ''}> Inhalation</label>
            <label class="inline"><input type="checkbox" id="a_ing"${v.route_ingestion ? ' checked' : ''}> Ingestion</label>
            <label class="inline"><input type="checkbox" id="a_abs"${v.route_absorption ? ' checked' : ''}> Absorption (skin or eyes)</label></div></fieldset>
          ${area('a_fire', 'Fire response', v.fire_response, 3)}
          ${area('a_spill', 'Spill response', v.spill_response, 3)}
          ${ctl('isolation', 'Isolation controls')}${ctl('ventilation', 'Ventilation controls')}${ctl('other', 'Other controls')}
          ${area('a_cnotes', 'Other control notes', v.controls_notes)}
          ${ctl('ppe', 'PPE')}${ctl('additional_ppe', 'Additional PPE')}
          ${area('a_pnotes', 'Other PPE notes', v.ppe_notes)}
          <fieldset><legend>Level of risk</legend>${App.RISK_LEVELS.map((l) => `<label class="inline"><input type="radio" name="a_risk" value="${l}"${(v.risk_level || 'uncertain') === l ? ' checked' : ''}> ${esc(App.riskLabel(l))}</label>`).join('')}</fieldset>
          <fieldset><legend>Atmospheric monitoring needed?</legend>${tri('a_mon', v.monitoring_needed)}${inp('a_mnote', 'Note', v.monitoring_note)}</fieldset>
          <fieldset><legend>Health surveillance needed?</legend>${tri('a_sur', v.surveillance_needed)}${inp('a_snote', 'Note', v.surveillance_note)}</fieldset>
          <div class="sticky-save actions">
            ${a ? '<button class="primary" type="submit" data-mode="put">Save changes</button><button type="submit" data-mode="post">Save as a new version</button><button type="button" class="danger" id="a_del">Delete this assessment</button>' : '<button class="primary" type="submit" data-mode="post">Save assessment</button>'}
          </div>
          ${a ? '<p class="hint">"Save as a new version" keeps the current one in the history and makes this one current.</p>' : ''}</form>`;
        let mode = 'put';
        box.querySelectorAll('button[type=submit]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; }));
        const tri2 = (name) => { const r = box.querySelector(`input[name=${name}]:checked`); return !r || r.value === '' ? null : Number(r.value); };
        $('#fAssess').addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = {
            assessed_date: $('#a_date').value || null, sds_date: $('#a_sds').value || null, form: $('#a_form').value || null,
            use_description: $('#a_use').value.trim(), route_inhalation: $('#a_inh').checked ? 1 : 0, route_ingestion: $('#a_ing').checked ? 1 : 0,
            route_absorption: $('#a_abs').checked ? 1 : 0, fire_response: $('#a_fire').value.trim(), spill_response: $('#a_spill').value.trim(),
            controls_notes: $('#a_cnotes').value.trim(), ppe_notes: $('#a_pnotes').value.trim(),
            risk_level: (box.querySelector('input[name=a_risk]:checked') || {}).value || 'uncertain',
            monitoring_needed: tri2('a_mon'), monitoring_note: $('#a_mnote').value.trim(),
            surveillance_needed: tri2('a_sur'), surveillance_note: $('#a_snote').value.trim(),
            assessed_by: $('#a_by').value.trim(),
            control_option_ids: [...box.querySelectorAll('input[name=ctl]:checked')].map((x) => Number(x.value)),
          };
          const btns = box.querySelectorAll('button'); btns.forEach((b) => { b.disabled = true; });
          try {
            if (a && mode === 'put') await App.api('/assessments/' + a.id, { method: 'PUT', body });
            else await App.api(`/chemicals/${id}/assessments`, { method: 'POST', body });
            App.toast('Assessment saved.', 'ok');
            await reload('assess');
          } catch (err) { App.toast(err.message, 'error'); btns.forEach((b) => { b.disabled = false; }); }
        });
        const del = $('#a_del');
        if (del) del.addEventListener('click', async () => {
          if (!await App.confirm('Delete this assessment? This cannot be undone.', { okLabel: 'Delete', danger: true })) return;
          try { await App.api('/assessments/' + a.id, { method: 'DELETE' }); App.toast('Assessment deleted.', 'ok'); await reload('assess'); }
          catch (err) { App.toast(err.message, 'error'); }
        });
      },

      places() {
        const pls = d.places || [];
        $('#cardLocs').innerHTML = `<div class="card-head"><h2>Where it is kept</h2><button type="button" class="primary" id="plAdd">Add a place</button></div>
          ${pls.length ? `<ul class="rowlist">${pls.map((l) => `<li style="padding:8px 0"><div><strong>${esc(l.name)}</strong> <span class="muted small-text">${esc(App.GHS.placeTypeLabel(l.place_type))}${l.registration ? ' \u00b7 ' + esc(l.registration) : ''}${l.archived ? ' \u00b7 archived' : ''}</span></div><div class="small-text muted">${l.quantity != null && l.unit ? fmtQty(l.quantity) + ' ' + esc(l.unit) : 'No quantity'}${l.container_note ? ' \u00b7 ' + esc(l.container_note) : ''}${l.spill_compound ? ' \u00b7 Spill compound: ' + esc(l.spill_compound) : ''}</div><div class="actions" style="margin-top:6px"><button type="button" class="small" data-lk="${l.link_id}">Change</button><button type="button" class="small danger" data-lkdel="${l.link_id}">Remove</button></div></li>`).join('')}</ul>` : '<p class="muted">Not linked to any place yet.</p>'}`;
        $('#plAdd').addEventListener('click', () => linkModal(null));
        $('#cardLocs').onclick = async (e) => {
          const ed = e.target.closest('[data-lk]');
          if (ed) { linkModal(pls.find((l) => String(l.link_id) === ed.dataset.lk)); return; }
          const dl = e.target.closest('[data-lkdel]');
          if (dl) {
            if (!await App.confirm('Remove this chemical from that place?', { okLabel: 'Remove', danger: true })) return;
            try { await App.api('/chemical-places/' + dl.dataset.lkdel, { method: 'DELETE' }); await reload('places'); }
            catch (err) { App.toast(err.message, 'error'); }
          }
        };
      },


      danger() {
        $('#cardDanger').innerHTML = `<h2>Delete this chemical</h2><p class="muted">This removes the chemical, its links to places and its assessments. The SDS and its PDF are removed too, unless another product uses them.</p><button type="button" class="danger" id="chemDel">Delete this chemical</button>`;
        $('#chemDel').addEventListener('click', async () => {
          if (!await App.confirm(`Delete "${d.chemical.product_name}" for good?`, { okLabel: 'Delete', danger: true })) return;
          try { await App.api('/chemicals/' + id, { method: 'DELETE' }); App.toast('Chemical deleted.', 'ok'); App.navigate('#/register'); }
          catch (err) { App.toast(err.message, 'error'); }
        });
      },
    };

    // ---- location modal
    function linkModal(l) {
      const body = document.createElement('div');
      body.innerHTML = '<p class="muted">Loading places...</p>';
      const m = App.modal({ title: l ? 'Change ' + l.name : 'Add a place', body, buttons: [
        { label: 'Cancel' },
        { label: 'Save', kind: 'primary', onClick: async () => {
          const f = App.readLinkFields(body); if (!f) return false;
          if (l) await App.api('/chemical-places/' + l.link_id, { method: 'PUT', body: f });
          else {
            const pid = body.querySelector('#lk_place') && body.querySelector('#lk_place').value;
            if (!pid) { App.toast('Pick a place.', 'error'); return false; }
            await App.api(`/chemicals/${id}/places`, { method: 'POST', body: Object.assign({ place_id: Number(pid) }, f) });
          }
          await reload('places');
        } },
      ] });
      (async () => {
        let pick = '';
        if (!l) {
          try {
            const all = await App.api('/places?archived=0');
            const have = new Set((d.places || []).map((x) => String(x.place_id)));
            const avail = all.filter((p) => !have.has(String(p.id)));
            pick = avail.length ? `<label for="lk_place">Place</label><select id="lk_place">${avail.map((p) => `<option value="${p.id}">${esc(p.name)}${p.registration ? ' (' + esc(p.registration) + ')' : ''} - ${esc(App.GHS.placeTypeLabel(p.place_type))}</option>`).join('')}</select>` : '<p class="muted">Every place already has this chemical, or there are no places yet. Add one under Places.</p>';
          } catch (err) { pick = '<p class="muted">' + esc(err.message) + '</p>'; }
        }
        body.innerHTML = pick + App.linkFieldsHtml(l);
      })();
      return m;
    }


    // ---- SDS modal: attach / edit / replace
    function sdsModal(mode) {
      const s = d.sds || {};
      const body = document.createElement('div');
      const maxMb = (App.settings && App.settings.upload_max_mb) || 15;
      body.innerHTML = `
        ${mode !== 'edit' ? `<label for="s_file">${mode === 'replace' ? 'The newer PDF (required)' : 'PDF file (optional)'}</label><input type="file" id="s_file" accept="application/pdf,.pdf"><p class="hint">PDF only, up to ${maxMb} MB.${mode === 'replace' ? ' The old version is kept in the history. The risk assessment is not changed, so check it against the new SDS.' : ''}</p>` : ''}
        ${inp('s_title', 'Product name on the SDS', s.title)}
        ${inp('s_sup', 'Supplier', s.supplier || d.chemical.supplier)}
        <div class="row2">${inp('s_issue', 'Issue date', s.issue_date, 'type="date"')}${inp('s_rev', 'Revision', s.revision)}</div>
        ${mode === 'edit' ? `${inp('s_due', 'Review due', s.review_due, 'type="date"')}<p class="hint">Leave this alone and it is worked out as the issue date plus 5 years.</p>` : ''}
        ${inp('s_phone', 'Emergency phone', s.emergency_phone)}
        <div class="row2">${select('s_signal', 'Signal word', [['', 'None'], ['Danger', 'Danger'], ['Warning', 'Warning']], s.signal_word)}</div>
        ${area('s_class', 'Hazard classification', s.hazard_classification)}
        ${area('s_h', 'Hazard statements (H codes)', s.h_statements)}
        ${area('s_p', 'Precautionary statements (P codes)', s.p_statements)}
        <div class="row3">${inp('s_poison', 'Poison schedule', s.poison_schedule)}${inp('s_un', 'UN number', s.un_number)}${inp('s_dg', 'ADG class', s.dg_class)}</div>
        <div class="row3">${inp('s_sub', 'Subsidiary class', s.subsidiary_class)}${select('s_pg', 'Packing group', [['', 'None'], ['I', 'I'], ['II', 'II'], ['III', 'III']], s.packing_group)}${inp('s_hazchem', 'Hazchem code', s.hazchem_code)}</div>
        ${inp('s_psn', 'Proper shipping name', s.proper_shipping_name)}
        ${inp('s_cas', 'CAS numbers (separated by commas)', s.cas_numbers)}`;
      const titles = { attach: 'Attach an SDS', edit: 'Edit SDS details', replace: 'Replace with a newer version' };
      App.modal({ title: titles[mode], wide: true, body, buttons: [
        { label: 'Cancel' },
        { label: mode === 'replace' ? 'Replace SDS' : 'Save', kind: 'primary', onClick: async () => {
          const q = (sel) => body.querySelector(sel);
          const file = q('#s_file') && q('#s_file').files[0];
          if (mode === 'replace' && !file) { App.toast('Choose the newer PDF first.', 'error'); return false; }
          if (file) {
            if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { App.toast('That file is not a PDF.', 'error'); return false; }
            if (file.size > maxMb * 1024 * 1024) { App.toast(`That file is bigger than ${maxMb} MB.`, 'error'); return false; }
          }
          const data = {
            title: q('#s_title').value.trim(), supplier: q('#s_sup').value.trim(), issue_date: q('#s_issue').value || null, revision: q('#s_rev').value.trim(),
            emergency_phone: q('#s_phone').value.trim(), signal_word: q('#s_signal').value || null,
            hazard_classification: q('#s_class').value.trim(), h_statements: q('#s_h').value.trim(), p_statements: q('#s_p').value.trim(),
            poison_schedule: q('#s_poison').value.trim(), un_number: q('#s_un').value.replace(/\D/g, ''), dg_class: q('#s_dg').value.trim(),
            subsidiary_class: q('#s_sub').value.trim(), packing_group: q('#s_pg').value || null, hazchem_code: q('#s_hazchem').value.trim(),
            proper_shipping_name: q('#s_psn').value.trim(), cas_numbers: q('#s_cas').value.trim(),
          };
          if (mode === 'edit') {
            const due = q('#s_due').value;
            if (due !== (s.review_due || '')) data.review_due = due || null;
            await App.api('/sds/' + s.id, { method: 'PUT', body: data });
          } else {
            const fd = new FormData();
            if (file) fd.append('file', file);
            fd.append('data', JSON.stringify(data));
            if (mode === 'attach') {
              fd.append('chemical_ids', JSON.stringify([Number(id)]));
              const r = await App.api('/sds', { method: 'POST', body: fd });
              const check = await App.api('/chemicals/' + id);
              if (!check.sds || check.sds.id !== r.id) await App.api(`/chemicals/${id}/link-sds`, { method: 'POST', body: { sds_id: r.id } });
            } else {
              await App.api(`/sds/${s.id}/replace`, { method: 'POST', body: fd });
            }
          }
          App.toast('SDS saved.', 'ok');
          await reload('sds', 'assess', 'places');
        } },
      ] });
    }

    drawTitle();
    draw.details(); draw.classification(); draw.sds(); draw.places(); draw.danger();
    await draw.assess();
    const focus = params.query && params.query.focus;
    const target = { details: '#cardDetails', classification: '#cardClass', sds: '#cardSds', assessment: '#cardAssess', locations: '#cardLocs', places: '#cardLocs' }[focus];
    if (target) { const el = $(target); if (el) el.scrollIntoView({ block: 'start' }); }
  }

  App.views.register('chemical', {
    title: 'Chemical',
    async render(root, params) {
      if (params.edit) return renderEdit(root, params.id, params);
      return renderView(root, params.id, params);
    },
  });
})();
