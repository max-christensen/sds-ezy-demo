/* Users (admin): add people, change roles, switch accounts off, reset passwords. */
(function () {
  const App = window.App;
  const esc = App.esc;

  App.views.register('users', {
    title: 'Users',
    adminOnly: true,
    async render(root) {
      let users = [];
      async function load() {
        root.innerHTML = App.loadingHtml('Loading users...');
        try { users = await App.api('/users'); } catch (err) { App.showError(root, err, load); return; }
        draw();
      }

      function draw() {
        root.innerHTML = `<div class="topbar"><div><h1>Users</h1><p class="sub">An <strong>admin</strong> can change anything. A <strong>user</strong> can look at the register and upload an SDS, and nothing else.</p></div>
          <button class="primary" id="newUser" type="button">Add a user</button></div>
          ${users.length ? `<table class="rtable"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
          ${users.map((u) => `<tr><td data-label="Name">${esc(u.name)}</td><td data-label="Email">${esc(u.email)}</td><td data-label="Role">${u.role === 'admin' ? 'Admin' : 'User'}</td><td data-label="Status">${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge none">Switched off</span>'}</td><td><button type="button" class="small" data-edit="${u.id}">Edit</button></td></tr>`).join('')}
          </tbody></table>` : '<div class="empty-state"><h2>No users</h2></div>'}`;
        root.querySelector('#newUser').addEventListener('click', () => userModal(null));
        root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => userModal(users.find((u) => String(u.id) === b.dataset.edit))));
      }

      function userModal(u) {
        const body = document.createElement('div');
        body.innerHTML = `
          <label for="uName">Name</label><input id="uName" type="text" value="${esc(u ? u.name : '')}" required>
          <label for="uEmail">Email</label><input id="uEmail" type="email" value="${esc(u ? u.email : '')}" required autocomplete="off">
          <label for="uPass">Password ${u ? '<span class="muted">(leave blank to keep the current one)</span>' : '<span class="muted">(at least 8 characters)</span>'}</label><input id="uPass" type="password" minlength="8" autocomplete="new-password">
          <label for="uRole">Role</label><select id="uRole"><option value="user"${u && u.role === 'user' || !u ? ' selected' : ''}>User: look and upload only</option><option value="admin"${u && u.role === 'admin' ? ' selected' : ''}>Admin: can change everything</option></select>
          <label class="inline" style="margin-top:14px"><input id="uActive" type="checkbox"${!u || u.active ? ' checked' : ''}> Account is active</label>`;
        App.modal({ title: u ? 'Edit user' : 'Add a user', body, buttons: [
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', onClick: async () => {
            const q = (s) => body.querySelector(s);
            const payload = { name: q('#uName').value.trim(), email: q('#uEmail').value.trim(), role: q('#uRole').value, active: q('#uActive').checked };
            const pw = q('#uPass').value;
            if (!payload.name || !payload.email) { App.toast('Enter a name and an email.', 'error'); return false; }
            if (!u && pw.length < 8) { App.toast('The password needs at least 8 characters.', 'error'); return false; }
            if (pw && pw.length < 8) { App.toast('The password needs at least 8 characters.', 'error'); return false; }
            if (pw) payload.password = pw;
            if (u) await App.api('/users/' + u.id, { method: 'PUT', body: payload });
            else await App.api('/users', { method: 'POST', body: payload });
            App.toast('User saved.', 'ok');
            await load();
          } },
        ] });
      }

      await load();
    },
  });
})();
