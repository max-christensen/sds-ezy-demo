/* Options (admin): the standard lists of controls and PPE that the assessment picks from. */
(function () {
  const App = window.App;
  const esc = App.esc;
  const KINDS = [
    ['isolation', 'Isolation controls', 'Ways of keeping the chemical away from people, such as storage and containers.'],
    ['ventilation', 'Ventilation controls', 'Ways of moving fumes and vapours away.'],
    ['other', 'Other controls', 'Anything else, such as small quantities or spill kits.'],
    ['ppe', 'PPE', 'Protective equipment used every time.'],
    ['additional_ppe', 'Additional PPE', 'Extra protective equipment for higher risk jobs.'],
  ];

  App.views.register('options', {
    title: 'Options',
    adminOnly: true,
    async render(root) {
      let opts = {};
      async function load() {
        root.innerHTML = App.loadingHtml('Loading options...');
        try { opts = await App.api('/options'); } catch (err) { App.showError(root, err, load); return; }
        draw();
      }

      function draw(focusSel) {
        root.innerHTML = `<div class="topbar"><div><h1>Options</h1><p class="sub">These lists fill the tick boxes in each risk assessment. Add your own, rename them, or switch off ones you do not use.</p></div></div>
          ${KINDS.map(([k, title, hint]) => {
            const list = opts[k] || [];
            return `<section class="card" aria-labelledby="oh-${k}"><h2 id="oh-${k}">${title}</h2><p class="hint" style="margin:0 0 6px">${hint}</p>
              ${list.length ? list.map((o, i) => `<div class="opt-item${o.active === 0 ? ' off' : ''}"><span class="label">${esc(o.label)}${o.active === 0 ? ' <span class="muted">(switched off)</span>' : ''}</span>
                <button type="button" class="small" data-act="up" data-k="${k}" data-i="${i}" aria-label="Move ${esc(o.label)} up"${i === 0 ? ' disabled' : ''}>&uarr;</button>
                <button type="button" class="small" data-act="down" data-k="${k}" data-i="${i}" aria-label="Move ${esc(o.label)} down"${i === list.length - 1 ? ' disabled' : ''}>&darr;</button>
                <button type="button" class="small" data-act="rename" data-id="${o.id}" data-k="${k}" data-i="${i}">Rename</button>
                <button type="button" class="small" data-act="toggle" data-id="${o.id}" data-on="${o.active === 0 ? 0 : 1}">${o.active === 0 ? 'Switch on' : 'Switch off'}</button>
                <button type="button" class="small danger" data-act="del" data-id="${o.id}" data-k="${k}" data-i="${i}">Delete</button></div>`).join('') : '<p class="muted">Nothing here yet.</p>'}
              <form class="add-row" data-add="${k}"><label class="sr-only" for="add-${k}">Add to ${title}</label><input id="add-${k}" type="text" placeholder="Add another..." required><button class="primary" type="submit">Add</button></form></section>`;
          }).join('')}`;
        if (focusSel) { const el = root.querySelector(focusSel); if (el) el.focus(); }
      }

      async function reorder(kind, from, to) {
        const list = (opts[kind] || []).slice();
        const [m] = list.splice(from, 1);
        list.splice(to, 0, m);
        opts[kind] = list;
        draw();
        try {
          await Promise.all(list.map((o, i) => App.api('/options/' + o.id, { method: 'PUT', body: { sort_order: (i + 1) * 10 } })));
        } catch (err) { App.toast(err.message, 'error'); await load(); }
      }

      root.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const { act, k } = b.dataset; const i = Number(b.dataset.i);
        try {
          if (act === 'up') await reorder(k, i, i - 1);
          else if (act === 'down') await reorder(k, i, i + 1);
          else if (act === 'toggle') { await App.api('/options/' + b.dataset.id, { method: 'PUT', body: { active: b.dataset.on === '1' ? 0 : 1 } }); await load(); }
          else if (act === 'rename') {
            const o = opts[k][i];
            const body = document.createElement('div');
            body.innerHTML = `<label for="rn">Name</label><input id="rn" type="text" value="${esc(o.label)}" required>`;
            App.modal({ title: 'Rename', body, buttons: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
              const v = body.querySelector('#rn').value.trim();
              if (!v) return false;
              await App.api('/options/' + o.id, { method: 'PUT', body: { label: v } });
              await load();
            } }] });
          } else if (act === 'del') {
            const o = opts[k][i];
            if (!await App.confirm(`Delete "${o.label}"? If assessments already use it, it is switched off instead of deleted.`, { okLabel: 'Delete', danger: true })) return;
            await App.api('/options/' + o.id, { method: 'DELETE' });
            await load();
          }
        } catch (err) { App.toast(err.message, 'error'); }
      });
      root.addEventListener('submit', async (e) => {
        const f = e.target.closest('[data-add]'); if (!f) return;
        e.preventDefault();
        const input = f.querySelector('input');
        try { await App.api('/options', { method: 'POST', body: { kind: f.dataset.add, label: input.value.trim() } }); opts = await App.api('/options'); draw('#add-' + f.dataset.add); }
        catch (err) { App.toast(err.message, 'error'); }
      });

      await load();
    },
  });
})();
