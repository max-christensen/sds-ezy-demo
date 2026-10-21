// Printable cabinet label with a QR code that opens the chemical's page (the core keeps the hash through login).
(function () {
  const App = window.App;

  const SIZES = {
    a6: { name: 'A6 (105 x 148 mm)', page: '105mm 148mm', cls: 'lb-a6' },
    small: { name: 'Small (100 x 60 mm)', page: '100mm 60mm', cls: 'lb-sm' },
  };

  const CSS = `
  .lb{box-sizing:border-box;background:#fff;color:#000;border:1px solid #999;font-family:Arial,Helvetica,sans-serif;overflow:hidden;display:flex;page-break-inside:avoid;break-inside:avoid}
  .lb *{box-sizing:border-box}
  .lb .lb-co{font-size:8pt;color:#333;text-transform:uppercase;letter-spacing:.04em}
  .lb .lb-name{font-weight:700;line-height:1.1;word-break:break-word}
  .lb .lb-sup{color:#333}
  .lb .lb-sig{display:inline-block;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:1mm 3mm;border:.6mm solid #000}
  .lb .lb-sig.danger{background:#000;color:#fff}
  .lb .lb-dg{display:inline-block;border:.5mm solid #000;font-weight:700;padding:1mm 2.5mm}
  .lb .lb-qr svg{display:block;width:100%;height:auto}
  .lb .lb-scan{color:#333;text-align:center}
  .lb .picto-row{display:flex;gap:1.5mm;flex-wrap:wrap}
  .lb .lb-note{font-size:7pt;color:#444}
  .lb-a6{width:105mm;height:148mm;flex-direction:column;padding:6mm;gap:3.5mm}
  .lb-a6 .lb-name{font-size:25pt} .lb-a6 .lb-sup{font-size:12pt} .lb-a6 .lb-sig{font-size:15pt;align-self:flex-start} .lb-a6 .lb-dg{font-size:12pt;align-self:flex-start}
  .lb-a6 .lb-pic svg,.lb-a6 .lb-pic img{width:22mm;height:22mm;image-rendering:auto}
  .lb-a6 .lb-bottom{margin-top:auto;display:flex;align-items:flex-end;gap:4mm}
  .lb-a6 .lb-qr{width:36mm;flex:none} .lb-a6 .lb-scan{font-size:9pt;text-align:left}
  .lb-sm{width:100mm;height:60mm;flex-direction:row;padding:3.5mm;gap:3.5mm}
  .lb-sm .lb-qr{width:28mm;flex:none} .lb-sm .lb-scan{font-size:6pt;margin-top:1mm}
  .lb-sm .lb-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1.6mm}
  .lb-sm .lb-name{font-size:14pt} .lb-sm .lb-sup{font-size:8pt} .lb-sm .lb-sig{font-size:9pt;padding:.4mm 2mm;align-self:flex-start} .lb-sm .lb-dg{font-size:8pt;padding:.4mm 2mm;align-self:flex-start}
  .lb-sm .lb-pic svg,.lb-sm .lb-pic img{width:13mm;height:13mm;image-rendering:auto} .lb-sm .lb-co{font-size:6pt}
  .lb-stage{overflow-x:auto;padding:4px}
  `;

  function css() {
    if (document.getElementById('lb-css')) return;
    const s = document.createElement('style'); s.id = 'lb-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  const TYPE_TEXT = { workshop: 'Workshop or depot', vehicle: 'Vehicle', site: 'Site' };
  const isPlaceLabel = (params) => !!(params && (params.place || params.kind === 'place')) || /^#\/place\//.test(location.hash);

  // Place label: QR to the place's chemical list, the place name, type, registration and the company.
  async function renderPlace(root, params) {
    css();
    const id = Number(params.id);
    root.innerHTML = App.loadingHtml('Preparing the label...');
    await App.loadScript('/vendor/qrcode.js');
    await App.loadScript('/lib/qr.js');
    const d = await App.api('/places/' + id);
    const pl = d.place;
    const url = location.origin + '/#/place/' + id;
    const qr = window.SDSLib.qr.qrSvg(window.qrcode, url, { label: 'QR code. Scan to open the chemical list for ' + pl.name + ' in SDS EZY', margin: 2 });
    const typeText = TYPE_TEXT[pl.place_type] || pl.place_type || '';
    let size = 'a6';
    try { size = localStorage.getItem('sdsezy.labelSize') || 'a6'; } catch (e) { /* ignore */ }
    if (!SIZES[size]) size = 'a6';

    function labelHtml(key) {
      const S = SIZES[key];
      const reg = pl.registration ? `<span class="lb-dg">${App.esc(pl.registration)}</span>` : '';
      const typ = `<div class="lb-sup">${App.esc(typeText)}</div>`;
      if (key === 'a6') {
        return `<div class="lb ${S.cls}"><div class="lb-co">${App.esc(App.companyName())}</div><div class="lb-name">${App.esc(pl.name)}</div>${typ}${reg}
          <div class="lb-bottom"><div><div class="lb-qr" style="width:46mm">${qr}</div></div><div class="lb-scan" style="font-size:12pt;font-weight:700">Scan for the chemical list</div></div></div>`;
      }
      return `<div class="lb ${S.cls}"><div class="lb-main"><div class="lb-co">${App.esc(App.companyName())}</div><div class="lb-name">${App.esc(pl.name)}</div>${typ}${reg}</div><div><div class="lb-qr">${qr}</div><div class="lb-scan">Scan for the chemical list</div></div></div>`;
    }

    root.innerHTML = `<div class="topbar"><div><a class="crumb" href="#/place/${id}">&larr; ${App.esc(pl.name)}</a><h1>Place label</h1><p class="sub">Stick it in the vehicle, depot or site office. Scanning the code opens this place's chemical list (after signing in).</p></div></div>
      <div class="card no-print"><div class="row2"><div><label for="lbSize">Label size</label><select id="lbSize">${Object.entries(SIZES).map(([k, v]) => `<option value="${k}"${k === size ? ' selected' : ''}>${v.name}</option>`).join('')}</select></div></div>
      <div class="actions" style="margin-top:12px"><button type="button" class="primary" id="lbPrint">Print label</button></div>
      <p class="hint">In the print window choose "Actual size" or 100%, and turn off headers and footers.</p></div>
      <div class="lb-stage" id="lbStage" aria-label="Label preview"></div>`;
    const stage = root.querySelector('#lbStage');
    const draw = () => { stage.innerHTML = labelHtml(size); };
    draw();
    root.querySelector('#lbSize').addEventListener('change', (e) => { size = e.target.value; draw(); try { localStorage.setItem('sdsezy.labelSize', size); } catch (err) { /* ignore */ } });
    root.querySelector('#lbPrint').addEventListener('click', () => {
      document.getElementById('printArea').innerHTML = `<style>${CSS}</style>${labelHtml(size)}`;
      document.getElementById('pageStyle').textContent = `@page { size: ${SIZES[size].page}; margin: 0; }`;
      window.print();
    });
  }

  App.views.register('placelabel', { title: 'Place label', render: (root, params) => renderPlace(root, params) });
  App.views.register('label', {
    title: 'Label',
    async render(root, params) {
      if (isPlaceLabel(params)) return renderPlace(root, params);
      css();
      const id = Number(params.id);
      root.innerHTML = App.loadingHtml('Preparing the label...');
      await App.loadScript('/vendor/qrcode.js');
      await App.loadScript('/lib/qr.js');
      const d = await App.api('/chemicals/' + id);
      const c = d.chemical, sds = d.sds || {};
      const url = location.origin + '/#/chemical/' + id;
      const qr = window.SDSLib.qr.qrSvg(window.qrcode, url, { label: 'QR code. Scan to open ' + c.product_name + ' in SDS EZY', margin: 2 });
      const dgBits = [c.dg_class || sds.dg_class ? 'ADG class ' + (c.dg_class || sds.dg_class) + ' (illustration only)' : '', sds.un_number ? 'UN ' + String(sds.un_number).replace(/^UN\s*/i, '') : ''].filter(Boolean).join('  |  ');
      const signal = c.signal_word || sds.signal_word || '';
      const pictos = c.pictograms || '';
      let size = 'a6';
      try { size = localStorage.getItem('sdsezy.labelSize') || 'a6'; } catch (e) { /* ignore */ }
      if (!SIZES[size]) size = 'a6';

      function labelHtml(key) {
        const S = SIZES[key];
        const sig = signal ? `<span class="lb-sig ${/danger/i.test(signal) ? 'danger' : ''}">${App.esc(signal)}</span>` : '';
        const pic = pictos ? `<div class="lb-pic">${App.pictogramRow(pictos, key === 'a6' ? 83 : 49)}</div>` : '';
        const dg = dgBits ? `<span class="lb-dg">${App.esc(dgBits)}</span>` : '';
        const qrBox = `<div><div class="lb-qr">${qr}</div>${key === 'small' ? '<div class="lb-scan">Scan for the SDS and assessment</div>' : ''}</div>`;
        if (key === 'a6') {
          return `<div class="lb ${S.cls}"><div class="lb-co">${App.esc(App.companyName())}</div><div class="lb-name">${App.esc(c.product_name)}</div>
            ${c.supplier ? `<div class="lb-sup">${App.esc(c.supplier)}</div>` : ''}${sig}${pic}${dg}
            <div class="lb-bottom">${qrBox}<div class="lb-scan">Scan to open the safety data sheet and risk assessment.</div></div></div>`;
        }
        return `<div class="lb ${S.cls}"><div class="lb-main"><div class="lb-co">${App.esc(App.companyName())}</div><div class="lb-name">${App.esc(c.product_name)}</div>
          ${c.supplier ? `<div class="lb-sup">${App.esc(c.supplier)}</div>` : ''}${sig}${pic}${dg}</div>${qrBox}</div>`;
      }

      root.innerHTML = `<div class="topbar"><div><a class="crumb" href="#/chemical/${id}">&larr; ${App.esc(c.product_name)}</a><h1>Cabinet label</h1><p class="sub">Print it, stick it on the cabinet or container. Scanning the code opens this chemical (after logging in).</p></div></div>
        <div class="card no-print"><div class="row2"><div><label for="lbSize">Label size</label><select id="lbSize">${Object.entries(SIZES).map(([k, v]) => `<option value="${k}"${k === size ? ' selected' : ''}>${v.name}</option>`).join('')}</select></div></div>
        ${c.classification == null ? '<p class="notice warn" style="margin-top:12px">This chemical has not been classified yet, so there are no pictograms or signal word to show. Record its GHS classification and the label will fill in. Until then it shows the name and code only.</p>' : ''}
        <div class="actions" style="margin-top:12px"><button type="button" class="primary" id="lbPrint">Print label</button></div>
        <p class="hint">In the print window choose "Actual size" or 100%, and turn off headers and footers. Use a label sheet or plain paper.</p></div>
        <div class="lb-stage" id="lbStage" aria-label="Label preview"></div>`;

      const stage = root.querySelector('#lbStage');
      const draw = () => { stage.innerHTML = labelHtml(size); };
      draw();
      root.querySelector('#lbSize').addEventListener('change', (e) => {
        size = e.target.value; draw();
        try { localStorage.setItem('sdsezy.labelSize', size); } catch (err) { /* ignore */ }
      });
      root.querySelector('#lbPrint').addEventListener('click', () => {
        // Exact page size so the label fills the sheet or label stock.
        document.getElementById('printArea').innerHTML = `<style>${CSS}</style>${labelHtml(size)}`;
        document.getElementById('pageStyle').textContent = `@page { size: ${SIZES[size].page}; margin: 0; }`;
        window.print();
      });
    },
  });
})();
