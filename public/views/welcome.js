/* First-run welcome for the admin: the disclaimer, then setup guidance. */
(function () {
  const App = window.App;

  App.views.register('welcome', {
    title: 'Welcome',
    adminOnly: true,
    async render(root) {
      root.innerHTML = `
        <div class="topbar"><div><h1>Welcome to SDS EZY</h1><p class="sub">A chemical register with a risk assessment for every chemical, drafted from the safety data sheet.</p></div></div>
        <section class="card">
          <h2>Please read this first</h2>
          ${App.disclaimerHtml()}
          <p style="margin:0 0 8px">SDS EZY helps you keep a register and prepare assessments. It does not replace your own judgement or the supplier's SDS.</p>
          <p style="margin:0"><strong>How hazards are worked out.</strong> Each chemical is classified from section 2 of its SDS, using the Safe Work Australia classification and labelling poster. The decision (hazardous or not), the signal word and the official pictograms follow from that classification. An admin can override the decision or the pictograms, and an override is always shown. The reference data is from Safe Work Australia.</p>
        </section>
        <section class="card">
          <h2>Set up in eight steps</h2>
          <ol class="steps">
            <li><strong>Your business details.</strong> Name, address and logo. They appear on every printed page. <a href="#/settings">Open Settings</a></li>
            <li><strong>AI for reading SDSs (optional).</strong> Pick a provider and add a key, then press Test. Without it you can still upload SDSs, but you fill in each assessment by hand. <a href="#/settings">Open Settings</a></li>
            <li><strong>Your people.</strong> Add a login for each person. A <em>user</em> can look at the register and upload an SDS. An <em>admin</em> can change things. <a href="#/users">Open Users</a></li>
            <li><strong>Your places.</strong> Add each workshop, vehicle and site, then link chemicals to them. People pick their place on their phone and see its chemicals, SDSs and assessments. A vehicle does not count towards placard totals; that is our understanding and is still to be confirmed with the regulator. <a href="#/places">Open Places</a></li>
            <li><strong>The control and PPE lists.</strong> Check the tick-box lists the assessment uses and add your own. <a href="#/options">Open Options</a></li>
            <li><strong>Add your chemicals.</strong> Upload an SDS and the chemical is added and classified for you (an admin checks it). If you already have a spreadsheet, import it. <a href="#/upload">Upload an SDS</a> or <a href="#/import">Import a spreadsheet</a></li>
            <li><strong>Audits.</strong> People walk a place on their phone, mark each chemical Present, Not found or Changed, photograph anything new, and flag items for disposal. Nothing changes the register until an admin accepts it on the Findings screen. You can set the reminder time and photo limits in Settings. <a href="#/audits">Open Audits</a></li>
            <li><strong>Take it with you.</strong> The take-away screen makes a copy of the register and the SDS files you can keep on a phone or print. <a href="#/take-away">Open Take-away</a></li>
          </ol>
        </section>
        <div class="actions"><button type="button" class="primary" id="startBtn">I have read this, set up my business</button><button type="button" id="skipBtn">Skip the setup for now</button></div>`;
      root.querySelector('#startBtn').addEventListener('click', () => App.navigate('#/settings'));
      root.querySelector('#skipBtn').addEventListener('click', async () => {
        try {
          await App.api('/settings', { method: 'PUT', body: { setup_complete: true } });
          App.settings.setup_complete = true;
          App.navigate('#/places');
        } catch (err) { App.toast(err.message, 'error'); }
      });
    },
  });
})();
