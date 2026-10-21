/* Settings (admin): business details, logo, colours, AI, upload limits, sign-in security. */
(function () {
  const App = window.App;
  const esc = App.esc;
  const PRESETS = [
    { name: 'Forest', main: '#1F2A24', accent: '#3B6E71' },
    { name: 'Navy', main: '#14213D', accent: '#1D6FA3' },
    { name: 'Charcoal', main: '#2B2B2B', accent: '#B85C00' },
    { name: 'Plum', main: '#3A1F3D', accent: '#8A3FA0' },
    { name: 'Slate', main: '#263238', accent: '#2E7D4F' },
    { name: 'Sand', main: '#E8E2D0', accent: '#7A4E1D' },
  ];

  App.views.register('settings', {
    title: 'Settings',
    adminOnly: true,
    async render(root) {
      root.innerHTML = App.loadingHtml('Loading settings...');
      await App.refreshSettings();
      let ai = null;
      try { ai = await App.api('/settings/ai'); } catch (e) { ai = null; }
      const c = App.settings;
      const T = App.theme;
      App.onLeave(() => T.applyTheme(App.publicSettings.main_color, App.publicSettings.accent_color)); // drop an unsaved colour preview

      root.innerHTML = `
        <div class="topbar"><div><h1>Settings</h1><p class="sub">Your business details, how the app looks, and how SDSs are read.</p></div></div>
        ${c.setup_complete === false ? '<div class="notice"><strong>Set up your business.</strong> Fill in your details below and press Save. They appear in the header and on every printed page.</div>' : ''}
        <form id="settingsForm">
          <section class="card settings-card"><h2>Business details</h2>
            <label for="sName">Business name</label><input type="text" id="sName" value="${esc(c.company_name)}" placeholder="For example: Smith Engineering">
            <label for="sAddress">Address</label><input type="text" id="sAddress" value="${esc(c.company_address)}">
            <div class="row2"><div><label for="sPhone">Phone</label><input type="text" id="sPhone" value="${esc(c.company_phone)}"></div>
            <div><label for="sEmail">Email</label><input type="email" id="sEmail" value="${esc(c.company_email)}"></div></div>
            <label for="sReg">ABN or other registration number</label><input type="text" id="sReg" value="${esc(c.company_reg)}">
          </section>
          <section class="card settings-card"><h2>Colours</h2>
            <p class="hint" style="margin:0 0 8px">The main colour is used for the menu and buttons. The accent colour is used for links and highlights.</p>
            <div class="actions" id="presetRow" style="margin-bottom:12px">${PRESETS.map((p, i) => `<button type="button" class="preset" data-i="${i}"><i style="background:${p.main}"></i><i style="background:${p.accent}"></i>${p.name}</button>`).join('')}</div>
            <div class="actions" style="gap:24px">
              <label class="inline"><input type="color" id="sMain" class="swatch" value="${esc((c.main_color || T.DEFAULT_MAIN).toLowerCase())}"> Main</label>
              <label class="inline"><input type="color" id="sAccent" class="swatch" value="${esc((c.accent_color || T.DEFAULT_ACCENT).toLowerCase())}"> Accent</label>
            </div>
            <div id="contrastMain" class="contrast-line"></div><div id="contrastAccent" class="contrast-line"></div>
          </section>
          <section class="card settings-card"><h2>Uploads</h2>
            <div class="row2"><div><label for="sMaxMb">Biggest SDS file (MB)</label><input type="number" id="sMaxMb" min="1" max="25" value="${esc(c.upload_max_mb || 15)}"></div>
            <div><label for="sRate">Uploads each person can make per hour</label><input type="number" id="sRate" min="1" max="200" value="${esc(c.upload_rate_per_hour || 10)}"></div></div>
            <p class="hint">The biggest file allowed is 25 MB. Only PDF files are accepted.</p>
          </section>
          <section class="card settings-card"><h2>Audits</h2>
            <p class="hint" style="margin:0 0 6px">Limits for audits and their photos. Photos are shrunk on the phone before they are sent.</p>
            <label for="sRemind">Remind me when a place has not been audited for (days)</label><input type="number" id="sRemind" min="1" max="730" step="1" value="${esc(c.audit_reminder_days || 90)}">
            <p class="hint">From 1 to 730 days. Places that are overdue show on the Review list.</p>
            <div class="row2"><div><label for="sPhotoMb">Biggest photo (MB)</label><input type="number" id="sPhotoMb" min="0.2" max="8" step="0.1" value="${esc(c.audit_photo_max_mb || 2)}"></div>
            <div><label for="sPhotoN">Most photos in one audit</label><input type="number" id="sPhotoN" min="1" max="200" step="1" value="${esc(c.audit_max_photos || 50)}"></div></div>
            <p class="hint">Photo size from 0.2 to 8 MB. Photos per audit from 1 to 200.</p>
            <div class="row2"><div><label for="sTotalMb">Most photo storage in one audit (MB)</label><input type="number" id="sTotalMb" min="5" max="200" step="1" value="${esc(c.audit_max_total_mb || 40)}"></div>
            <div><label for="sLabelRate">Label photo reads per person per hour</label><input type="number" id="sLabelRate" min="1" max="200" step="1" value="${esc(c.label_read_rate_per_hour || 30)}"></div></div>
            <p class="hint">Total per audit from 5 to 200 MB. Label reads from 1 to 200 an hour.</p>
          </section>
          <section class="card settings-card"><h2>Sign-in security</h2>
            <label class="inline"><input type="checkbox" id="sTwofa"${c.twofa_enabled !== false ? ' checked' : ''}${c.resend_configured ? '' : ' disabled'}> Ask for an emailed 6-digit code when logging in</label>
            <p class="hint" id="twofaStatus">${c.resend_configured
              ? (c.twofa_enabled !== false ? 'On. After the password, people get a code by email. A login lasts 30 days, so the code is needed about once a month.' : 'Off. Anyone with a password can log in without a code.')
              : 'Not available: no email service is set up. Add the RESEND_API_KEY secret to turn this on (see the README).'}</p>
          </section>
          <div class="actions" style="max-width:640px; margin-bottom:24px"><button type="submit" class="primary" id="saveBtn">Save settings</button></div>
        </form>

        <section class="card settings-card"><h2>Logo</h2>
          <p class="hint" style="margin:0">PNG, JPG, WebP, GIF or SVG, up to 2 MB. It is shown next to your business name. Until you add one, the SDS EZY mark is used.</p>
          <div class="logo-preview" id="logoPreview">${App.brandMarkHtml()}</div>
          <label for="sLogoFile">Choose an image</label><input type="file" id="sLogoFile" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml">
          <div class="actions" style="margin-top:8px"><button type="button" id="uploadLogoBtn">Upload logo</button><button type="button" class="danger" id="removeLogoBtn"${App.publicSettings.has_logo ? '' : ' style="display:none"'}>Remove logo</button></div>
        </section>

        <section class="card settings-card" id="aiCard"></section>`;

      const $ = (s) => root.querySelector(s);

      // ---- colours
      function contrast() {
        const main = $('#sMain').value, accent = $('#sAccent').value;
        const m = T.contrastRatio(main, T.readableOn(main)), a = T.contrastRatio(accent, '#FFFFFF');
        $('#contrastMain').className = 'contrast-line ' + (m >= 4.5 ? 'ok' : 'bad');
        $('#contrastMain').textContent = `Menu text on the main colour: ${m.toFixed(1)}:1 ${m >= 4.5 ? '(easy to read)' : '(hard to read, pick a different main colour)'}`;
        $('#contrastAccent').className = 'contrast-line ' + (a >= 4.5 ? 'ok' : 'bad');
        $('#contrastAccent').textContent = `Accent colour on white: ${a.toFixed(1)}:1 ${a >= 4.5 ? '(easy to read)' : '(too light for links and text, pick a darker accent)'}`;
        $('#saveBtn').disabled = a < 4.5 || m < 4.5;
        T.applyTheme(main, accent);
      }
      $('#sMain').addEventListener('input', contrast);
      $('#sAccent').addEventListener('input', contrast);
      $('#presetRow').addEventListener('click', (e) => {
        const b = e.target.closest('.preset'); if (!b) return;
        const p = PRESETS[b.dataset.i];
        $('#sMain').value = p.main.toLowerCase(); $('#sAccent').value = p.accent.toLowerCase();
        contrast();
      });
      contrast();

      // ---- save
      $('#settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#saveBtn'); btn.disabled = true;
        try {
          const body = {
            company_name: $('#sName').value.trim(), company_address: $('#sAddress').value.trim(), company_phone: $('#sPhone').value.trim(),
            company_email: $('#sEmail').value.trim(), company_reg: $('#sReg').value.trim(),
            main_color: $('#sMain').value, accent_color: $('#sAccent').value,
            upload_max_mb: Math.min(25, Math.max(1, Number($('#sMaxMb').value) || 15)),
            upload_rate_per_hour: Math.max(1, Number($('#sRate').value) || 10),
            audit_reminder_days: Math.min(730, Math.max(1, Math.round(Number($('#sRemind').value) || 90))),
            audit_photo_max_mb: Math.min(8, Math.max(0.2, Number($('#sPhotoMb').value) || 2)),
            audit_max_photos: Math.min(200, Math.max(1, Math.round(Number($('#sPhotoN').value) || 50))),
            audit_max_total_mb: Math.min(200, Math.max(5, Number($('#sTotalMb').value) || 40)),
            label_read_rate_per_hour: Math.min(200, Math.max(1, Math.round(Number($('#sLabelRate').value) || 30))),
            setup_complete: true,
          };
          if (c.resend_configured) body.twofa_enabled = $('#sTwofa').checked;
          await App.api('/settings', { method: 'PUT', body });
          await App.refreshSettings();
          App.toast('Settings saved.', 'ok');
          App.route();
        } catch (err) { App.toast(err.message, 'error'); btn.disabled = false; }
      });

      // ---- logo
      $('#uploadLogoBtn').addEventListener('click', async () => {
        const f = $('#sLogoFile').files[0];
        if (!f) { App.toast('Choose an image first.', 'error'); return; }
        if (f.size > 2 * 1024 * 1024) { App.toast('That image is bigger than 2 MB.', 'error'); return; }
        const fd = new FormData(); fd.append('file', f);
        try { await App.apiUpload('/settings/logo', fd); await App.refreshSettings(); App.toast('Logo saved.', 'ok'); App.route(); }
        catch (err) { App.toast(err.message, 'error'); }
      });
      $('#removeLogoBtn').addEventListener('click', async () => {
        if (!await App.confirm('Remove the logo?', { okLabel: 'Remove', danger: true })) return;
        try { await App.api('/settings/logo', { method: 'DELETE' }); await App.refreshSettings(); App.route(); }
        catch (err) { App.toast(err.message, 'error'); }
      });

      // ---- AI
      // The server says whether the chosen model takes images; accept the likely field names.
      function visionState(a) {
        const v = a.vision && a.vision.supports_images != null ? a.vision.supports_images : null;
        return v === true ? 'Yes' : v === false ? 'No. People will need to type the name and supplier.' : '<span class="none">Not known. Press Test photo reading.</span>';
      }
      function drawAi() {
        const box = $('#aiCard');
        if (!ai) { box.innerHTML = '<h2>Reading SDSs with AI</h2><p class="muted">The AI settings could not be loaded.</p>'; return; }
        const providers = ai.providers || [];
        const cur = providers.find((p) => p.id === ai.provider) || providers[0] || { id: ai.provider, label: ai.provider, default_model: '' };
        const needsKey = cur.id !== 'workers_ai';
        const keyText = { secret: 'A key is set on the server as a secret, and it is used first. You do not need to enter one here.', stored: 'A key is saved (it is stored encrypted and is never shown again). Type a new one to replace it, or leave this blank to keep it.', none: 'No key is saved yet.' }[ai.key_source] || '';
        box.innerHTML = `<h2>Reading SDSs with AI</h2>
          <p class="hint" style="margin:0 0 8px">When someone uploads an SDS, the AI reads the text and drafts the hazard details and the risk assessment. Without it, the SDS is still saved, and the assessment is left blank for you to fill in. A person must always check the result.</p>
          <label for="aiProv">AI provider</label>
          <select id="aiProv">${providers.map((p) => `<option value="${esc(p.id)}"${p.id === cur.id ? ' selected' : ''}>${esc(p.label)}${p.id === 'workers_ai' && !ai.workers_ai_available ? ' (not available on this server)' : ''}</option>`).join('')}</select>
          <label for="aiModel">Model (leave blank to use the default)</label>
          <input type="text" id="aiModel" value="${esc(ai.model || '')}" placeholder="${esc(cur.default_model || '')}" autocomplete="off">
          <div id="keyBlock"${needsKey ? '' : ' style="display:none"'}><label for="aiKey">API key</label><input type="password" id="aiKey" autocomplete="new-password" placeholder="${ai.key_source === 'stored' ? 'A key is saved. Type here to replace it.' : 'Paste your key here'}" spellcheck="false">
          <p class="hint" id="keyStatus">Key status: <strong>${ai.key_source === 'secret' ? 'set on the server' : ai.key_source === 'stored' ? 'saved' : 'none'}</strong>. ${keyText}</p></div>
          <p class="hint" id="noKey"${needsKey ? ' style="display:none"' : ''}>This one needs no key.${ai.workers_ai_available ? '' : ' It is not switched on for this server, so pick another provider.'}</p>
          <h3 style="font-size:14px;margin:18px 0 4px">Photo reading</h3>
          <p class="hint" style="margin:0 0 6px">When someone photographs a label during an audit, a model that can look at images reads the product name and supplier. If it cannot, people type them in and the photo is still kept.</p>
          <dl class="kv" style="margin:0 0 6px">
            <dt>Vision model</dt><dd>${ai.vision && ai.vision.model ? esc(ai.vision.model) : '<span class="none">Not set</span>'}</dd>
            <dt>Can it read images?</dt><dd>${visionState(ai)}</dd>
          </dl>
          <label for="aiVision">Model for reading photos (leave blank for the default)</label><input type="text" id="aiVision" value="${esc(ai.vision && ai.vision.model && ai.vision.model !== ai.vision.default_model ? ai.vision.model : '')}" placeholder="${esc((ai.vision && ai.vision.default_model) || cur.default_vision_model || '')}" autocomplete="off">
          <div class="actions" style="margin-top:12px"><button type="button" class="primary" id="aiSave">Save AI settings</button><button type="button" id="aiTest">Test the saved settings</button>${ai.key_source === 'stored' ? '<button type="button" class="danger" id="aiClear">Remove the saved key</button>' : ''}</div>
          <p class="hint" id="aiDirty" style="display:none">You have unsaved changes. Save them before testing.</p>
          <div class="actions" style="margin-top:8px"><button type="button" id="aiTestVision">Test photo reading</button></div>
          <div id="aiResult" role="status"></div>`;
        const dirty = () => { $('#aiTest').disabled = true; $('#aiDirty').style.display = 'block'; };
        box.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', dirty));
        $('#aiProv').addEventListener('change', () => {
          const p = providers.find((x) => x.id === $('#aiProv').value);
          $('#aiModel').placeholder = (p && p.default_model) || '';
          $('#aiVision').placeholder = (p && p.default_vision_model) || '';
          const nk = !!p && p.id !== 'workers_ai';
          $('#keyBlock').style.display = nk ? '' : 'none';
          $('#noKey').style.display = nk ? 'none' : '';
          $('#keyStatus').innerHTML = p && p.id === ai.provider ? $('#keyStatus').innerHTML : 'Save to see whether a key is already set for this provider.';
        });
        $('#aiSave').addEventListener('click', async () => {
          const body = { provider: $('#aiProv').value, model: $('#aiModel').value.trim() };
          if ($('#aiVision')) body.vision_model = $('#aiVision').value.trim();
          const k = $('#aiKey') ? $('#aiKey').value.trim() : '';
          if (k) body.api_key = k;
          try {
            await App.api('/settings/ai', { method: 'PUT', body });
            ai = await App.api('/settings/ai');
            drawAi();
            App.toast('AI settings saved.', 'ok');
          } catch (err) { App.toast(err.message, 'error'); }
        });
        const clr = $('#aiClear');
        if (clr) clr.addEventListener('click', async () => {
          if (!await App.confirm('Remove the saved API key?', { okLabel: 'Remove', danger: true })) return;
          try { await App.api('/settings/ai', { method: 'PUT', body: { provider: ai.provider, model: ai.model || '', clear_key: true } }); ai = await App.api('/settings/ai'); drawAi(); App.toast('Key removed.', 'ok'); }
          catch (err) { App.toast(err.message, 'error'); }
        });
        $('#aiTestVision').addEventListener('click', async () => {
          const b = $('#aiTestVision'); b.disabled = true; b.textContent = 'Testing...';
          try {
            const r = await App.api('/settings/ai/test-vision', { method: 'POST', body: {} });
            $('#aiResult').innerHTML = `<div class="notice ${r.ok ? '' : 'bad'}" style="margin-top:12px"><strong>${r.ok ? 'Photo reading works.' : 'Photo reading did not work.'}</strong> ${esc(r.message || '')}</div>`;
          } catch (err) { $('#aiResult').innerHTML = `<div class="notice bad" style="margin-top:12px">${esc(err.message)}</div>`; }
          b.disabled = false; b.textContent = 'Test photo reading';
        });
        $('#aiTest').addEventListener('click', async () => {
          const b = $('#aiTest'); b.disabled = true; b.textContent = 'Testing...';
          try {
            const r = await App.api('/settings/ai/test', { method: 'POST', body: {} });
            $('#aiResult').innerHTML = `<div class="notice ${r.ok ? '' : 'bad'}" style="margin-top:12px"><strong>${r.ok ? 'It works.' : 'It did not work.'}</strong> ${esc(r.message || '')}</div>`;
          } catch (err) { $('#aiResult').innerHTML = `<div class="notice bad" style="margin-top:12px">${esc(err.message)}</div>`; }
          b.disabled = false; b.textContent = 'Test the saved settings';
        });
      }
      drawAi();
    },
  });
})();
