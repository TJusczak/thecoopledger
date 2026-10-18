// Settings -> Account (anyone signed in to a server) and Settings -> Users (admins).
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

const ROLE_INFO = {
  admin: { label: "Admin", blurb: "Everything, including users and server settings." },
  member: { label: "Member", blurb: "Add and edit flock data. Can't manage users or the server." },
  readonly: { label: "Read-only", blurb: "Can look at everything, can't change anything." },
};
function roleLabel(role) { return (ROLE_INFO[role] || { label: role }).label; }

async function apiPatch(path, body) {
  return apiResult(await fetch(apiUrl(path), { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) }));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* insecure context / permission: fall back below */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { /* nothing more to try */ }
  ta.remove();
  return ok;
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** The little "who am I" button in the top bar. Hidden when running local-only (there is no account then). */
function updateUserChip() {
  const chip = document.getElementById("userChip");
  if (!chip) return;
  const signedIn = !localOnlyMode && !!getAuthToken();
  chip.hidden = !signedIn;
  if (!signedIn) return;
  const name = getUserName() || getAuthUsername() || "Account";
  chip.querySelector(".user-chip-initials").textContent = initials(name);
  chip.querySelector(".user-chip-name").textContent = name;
  chip.title = `${name} -- account settings`;
}

// ---------------------------------------------------------------------------------------------- Account

function renderAccountSection() {
  const el = document.getElementById("settingsContent");
  const role = getUserRole();
  const username = getAuthUsername();
  const hasAccount = !!username;
  el.innerHTML = `
    <div class="card">
      <div class="acct-who">
        <div class="acct-avatar" aria-hidden="true">${esc(initials(getUserName()))}</div>
        <div>
          <div class="card-title" style="margin:0">${esc(getUserName() || "You")}</div>
          <div class="dim" style="font-size:12px">${hasAccount ? `@${esc(username)}` : "Signed in with a shared invite code"} · <span class="role-chip role-${esc(role)}">${esc(roleLabel(role))}</span></div>
        </div>
      </div>
      <label class="field" style="margin-top:16px"><span>Display name</span>
        <div style="display:flex;gap:8px"><input id="acct_name" value="${esc(getUserName())}" maxlength="60" autocomplete="name"><button class="btn btn-confirm" id="acct_name_save">✓ Save</button></div>
      </label>
      <div class="dim" style="font-size:11px;margin-top:6px">Shown on activity (“Alex added 12 eggs”) and to other people on this server.</div>
    </div>

    ${hasAccount ? `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Change password</div>
      <form id="acct_pw_form" novalidate>
        ${passwordFieldHtml("acct_pw_current", "Current password", "current-password")}
        ${passwordFieldHtml("acct_pw_new", "New password", "new-password")}
        ${passwordFieldHtml("acct_pw_confirm", "New password, again", "new-password")}
        <div class="dim" style="font-size:11px;margin:6px 0 0">At least 8 characters. Changing it signs you out of your <em>other</em> devices; this one stays signed in.</div>
        <div id="acct_pw_error" class="auth-error" role="alert"></div>
        <button class="btn btn-confirm" id="acct_pw_save" type="submit">Change password</button>
      </form>
    </div>` : `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Password</div>
      <div class="dim" style="font-size:12px">This device signed in with a shared invite code, which has no password of its own. Ask an admin to add you under Settings → Users, then sign in with your own username and password.</div>
    </div>`}

    <div class="card" style="margin-top:16px">
      <div class="card-title">Sign out</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Signs this device out. Anything not yet synced is kept on this device and sent next time you sign in.</div>
      <button class="btn btn-close" id="acct_signout">Sign out</button>
    </div>`;

  wirePasswordToggles(el);
  document.getElementById("acct_name_save").addEventListener("click", async () => {
    try {
      const out = await apiPatch("/api/auth/profile", { display_name: document.getElementById("acct_name").value });
      setUserName(out.name);
      showToast("Name updated", "update");
      updateHeader();
      renderAccountSection();
    } catch (err) { showToast(err.detail || "Couldn't update your name", "delete"); }
  });
  document.getElementById("acct_name").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("acct_name_save").click(); });

  const form = document.getElementById("acct_pw_form");
  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("acct_pw_error");
    errEl.textContent = "";
    const next = document.getElementById("acct_pw_new").value;
    if (next !== document.getElementById("acct_pw_confirm").value) { errEl.textContent = "The two new passwords don't match."; return; }
    const btn = document.getElementById("acct_pw_save");
    btn.disabled = true;
    try {
      await apiPost("/api/auth/password", { current_password: document.getElementById("acct_pw_current").value, new_password: next });
      showToast("Password changed", "create");
      renderAccountSection();
    } catch (err) {
      errEl.textContent = err.detail || "Couldn't change the password.";
      btn.disabled = false;
    }
  });

  document.getElementById("acct_signout").addEventListener("click", async () => {
    if (!(await showConfirmDialog("Sign out of this device?", "Sign out"))) return;
    try { await apiPost("/api/auth/logout", {}); } catch (_) { /* best effort -- clearing the local token below is what actually matters */ }
    clearAuthToken();
    location.reload();
  });
}

// ---------------------------------------------------------------------------------------------- Users (admin)

function showTemporaryPasswordModal(username, password, headline) {
  openModal(`
    <div class="form-head">${esc(headline)}</div>
    <div class="dim" style="font-size:13px;margin-bottom:12px">Give <strong style="color:var(--text)">@${esc(username)}</strong> this temporary password. They'll be asked to choose their own the first time they sign in.</div>
    <div class="temp-password" id="tempPw">${esc(password)}</div>
    <div class="auth-notice" style="margin-top:12px">This is the only time it's shown. If it's lost, reset the password again.</div>
    <div class="modal-actions">
      <button class="btn ghost" id="tempPwCopy">📋 Copy</button>
      <button class="btn btn-confirm" id="tempPwDone">Done</button>
    </div>`);
  document.getElementById("tempPwCopy").addEventListener("click", async (e) => {
    e.currentTarget.textContent = (await copyText(password)) ? "✓ Copied" : "Select it and copy by hand";
  });
  document.getElementById("tempPwDone").addEventListener("click", closeModal);
}

function userFormHtml(user) {
  const editing = !!user;
  return `
    <div class="form-head">${editing ? `Edit @${esc(user.username)}` : "Add a user"}</div>
    ${editing ? "" : `<label class="field"><span>Username</span><input id="uf_username" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. maya"></label>
      <div class="dim" style="font-size:11px;margin:4px 0 12px">3-32 letters, numbers, dots, dashes or underscores. This is what they type to sign in.</div>`}
    <label class="field"><span>Display name</span><input id="uf_display" value="${esc(editing ? user.display_name : "")}" maxlength="60" placeholder="e.g. Maya"></label>
    <label class="field" style="margin-top:12px"><span>Role</span>
      <select id="uf_role" ${editing && user.isSelf ? "disabled" : ""}>
        ${Object.entries(ROLE_INFO).map(([id, r]) => `<option value="${id}" ${(editing ? user.role : "member") === id ? "selected" : ""}>${r.label} -- ${r.blurb}</option>`).join("")}
      </select>
    </label>
    ${editing && user.isSelf ? `<div class="dim" style="font-size:11px;margin-top:4px">You can't change your own role. Ask another admin.</div>` : ""}
    ${editing ? "" : `
    <label class="field" style="margin-top:12px"><span>Password (optional)</span><input id="uf_password" type="text" autocomplete="off" spellcheck="false" placeholder="Leave empty to generate one"></label>
    <div class="dim" style="font-size:11px;margin-top:4px">Either way they must choose their own the first time they sign in.</div>`}
    <div id="uf_error" class="auth-error" role="alert"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="uf_cancel">Cancel</button>
      <button class="btn btn-confirm" id="uf_save">${editing ? "✓ Save" : "+ Add user"}</button>
    </div>`;
}

function openUserForm(user, onDone) {
  openModal(userFormHtml(user));
  document.getElementById("uf_cancel").addEventListener("click", closeModal);
  document.getElementById("uf_save").addEventListener("click", async () => {
    const err = document.getElementById("uf_error");
    err.textContent = "";
    const display = document.getElementById("uf_display").value.trim();
    try {
      if (user) {
        const body = { display_name: display || user.username };
        if (!user.isSelf) body.role = document.getElementById("uf_role").value;
        await apiPatch(`/api/auth/users/${user.id}`, body);
        closeModal();
        showToast("User updated", "update");
      } else {
        const out = await apiPost("/api/auth/users", {
          username: document.getElementById("uf_username").value.trim(),
          display_name: display,
          role: document.getElementById("uf_role").value,
          password: document.getElementById("uf_password").value || undefined,
        });
        closeModal();
        if (out.temporary_password) setTimeout(() => showTemporaryPasswordModal(out.user.username, out.temporary_password, "User added"), 350);
        else showToast(`@${out.user.username} added`, "create");
      }
      onDone();
    } catch (ex) { err.textContent = ex.detail || "Couldn't save that."; }
  });
  setTimeout(() => { const f = document.getElementById(user ? "uf_display" : "uf_username"); if (f) f.focus(); }, 50);
}

async function renderUsersSection() {
  const el = document.getElementById("settingsContent");
  el.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div>
          <div class="card-title" style="margin:0">Users</div>
          <div class="dim" style="font-size:12px;margin-top:2px">Everyone who can sign in to this server. Passwords are stored as one-way hashes -- nobody, including you, can read them.</div>
        </div>
        <button class="btn btn-confirm" id="addUserBtn">+ Add user</button>
      </div>
      <div id="usersList" style="margin-top:14px" class="dim">Loading…</div>
    </div>
    <div class="card" style="margin-top:16px" id="legacyCodesCard"></div>`;
  document.getElementById("addUserBtn").addEventListener("click", () => openUserForm(null, renderUsersSection));

  let users = [];
  try {
    users = (await apiGet("/api/auth/users")).users;
  } catch (err) {
    document.getElementById("usersList").textContent = "Couldn't load users right now -- are you offline?";
    return;
  }
  const meName = getAuthUsername().toLowerCase();
  document.getElementById("usersList").classList.remove("dim");
  document.getElementById("usersList").innerHTML = users.map(u => {
    const isSelf = u.username.toLowerCase() === meName;
    return `
    <div class="user-row ${u.disabled ? "is-disabled" : ""}" data-user-row="${esc(u.id)}">
      <div class="acct-avatar small" aria-hidden="true">${esc(initials(u.display_name))}</div>
      <div class="user-main">
        <div class="user-name">${esc(u.display_name)}
          ${isSelf ? `<span class="chip">you</span>` : ""}
          ${u.disabled ? `<span class="chip chip-warn">disabled</span>` : ""}
          ${u.must_change_password && !u.disabled ? `<span class="chip chip-warn" title="They haven't chosen their own password yet">temporary password</span>` : ""}
        </div>
        <div class="dim" style="font-size:12px">@${esc(u.username)} · last signed in ${u.last_login_at ? relativeTime(u.last_login_at) : "never"}</div>
      </div>
      <span class="role-chip role-${esc(u.role)}">${esc(roleLabel(u.role))}</span>
      <div class="user-actions">
        <button class="btn ghost small" data-edit="${esc(u.id)}">Edit</button>
        <button class="btn ghost small" data-reset="${esc(u.id)}">Reset password</button>
        ${isSelf ? "" : `<button class="btn ghost small" data-toggle="${esc(u.id)}">${u.disabled ? "Enable" : "Disable"}</button>
        <button class="btn btn-close small" data-delete="${esc(u.id)}">Delete</button>`}
      </div>
    </div>`;
  }).join("") || `<div class="dim">No users yet.</div>`;

  const byId = (id) => { const u = users.find(x => x.id === id); return u && { ...u, isSelf: u.username.toLowerCase() === meName }; };
  const list = document.getElementById("usersList");
  list.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openUserForm(byId(b.dataset.edit), renderUsersSection)));
  list.querySelectorAll("[data-reset]").forEach(b => b.addEventListener("click", async () => {
    const u = byId(b.dataset.reset);
    if (!(await showConfirmDialog(`Reset ${u.display_name}'s password? They'll be signed out everywhere and given a temporary one.`, "Reset"))) return;
    try {
      const out = await apiPost(`/api/auth/users/${u.id}/password`, {});
      showTemporaryPasswordModal(u.username, out.temporary_password, "Password reset");
      renderUsersSection();
    } catch (err) { showToast(err.detail || "Couldn't reset that password", "delete"); }
  }));
  list.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
    const u = byId(b.dataset.toggle);
    if (!u.disabled && !(await showConfirmDialog(`Disable ${u.display_name}? They'll be signed out and can't sign in until you enable them again.`, "Disable"))) return;
    try {
      await apiPatch(`/api/auth/users/${u.id}`, { disabled: !u.disabled });
      showToast(u.disabled ? "User enabled" : "User disabled", "update");
      renderUsersSection();
    } catch (err) { showToast(err.detail || "Couldn't do that", "delete"); }
  }));
  list.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", async () => {
    const u = byId(b.dataset.delete);
    if (!(await showConfirmDialog(`Delete ${u.display_name} (@${u.username})? They're signed out immediately and can't come back without a new account. Anything they added to the flock stays.`))) return;
    try {
      await apiDelete(`/api/auth/users/${u.id}`);
      showToast("User deleted", "delete");
      renderUsersSection();
    } catch (err) { showToast(err.detail || "Couldn't delete that user", "delete"); }
  }));

  // The pre-accounts way in: a shared code. Off by default on new servers; servers that upgraded keep it on until an admin decides.
  let codesOn = false;
  try { codesOn = !!(await apiGet("/api/admin/server-settings")).settings.allow_invite_codes.value; } catch (_) { /* leave the card minimal */ }
  const card = document.getElementById("legacyCodesCard");
  card.innerHTML = `
    <div class="card-title">Shared invite codes (older sign-in)</div>
    <div class="dim" style="font-size:12px;margin-bottom:12px">Before accounts, everyone signed in with one shared code. It still works while this is on -- turn it off once everyone has their own account, so there's no shared way in.${codesOn ? ` Manage the codes in Settings → Server.` : ""}</div>
    <label style="display:flex;gap:10px;align-items:center;justify-content:flex-start;cursor:pointer;font-size:13px">
      <input type="checkbox" id="allowCodes" ${codesOn ? "checked" : ""} style="width:auto"> <span style="color:var(--text)">Allow signing in with an invite code</span>
    </label>`;
  document.getElementById("allowCodes").addEventListener("change", async (e) => {
    const on = e.target.checked;
    if (!on && !(await showConfirmDialog("Turn off invite codes? Devices that are signed in with a shared code are signed out right away. People with their own accounts aren't affected.", "Turn off"))) { e.target.checked = true; return; }
    try {
      await fetch(apiUrl("/api/admin/server-settings"), { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ allow_invite_codes: on }) }).then(apiResult);
      showToast(on ? "Invite codes are on" : "Invite codes are off -- only accounts can sign in", "update");
      renderUsersSection();
    } catch (err) { e.target.checked = !on; showToast(err.detail || "Couldn't change that", "delete"); }
  });
}

document.getElementById("userChip").addEventListener("click", () => { settingsSubTab = "account"; switchTab("settings"); });
