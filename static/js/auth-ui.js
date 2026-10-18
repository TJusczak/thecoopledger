// The login page, the "choose your password" page, and how the app decides which one to show.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)
//
// One page serves everyone, and adapts to what it finds:
//   * a Coop Ledger server answers on this origin (a self-hosted install)  -> sign in with a username
//     and password; "use on this device only" is the quiet alternative
//   * nothing answers (the public website, or a server that is down)       -> local-only is the main path
//     ("Start tracking now"); "sign in to a server" is tucked underneath for people who run one
//   * the server predates accounts (no `login` in /api/health)             -> the old name + invite code form

/** Asks `url` (default: the configured server, or this page's own origin) whether a Coop Ledger server lives
 * there, and how it lets people in. Never throws. A static host that answers every path with index.html
 * fails the JSON check, so the website is correctly reported as "no server". */
async function probeServer(url) {
  const base = (url === undefined ? getServerUrl() : url).replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(base + "/api/health", { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return { found: false };
    const data = await res.json();
    if (data.status !== "ok") return { found: false };
    const login = data.login || null; // absent on servers from before accounts existed
    return { found: true, url: base, accounts: !!(login && login.accounts), inviteCodes: login ? !!login.invite_codes : true, version: data.version || null };
  } catch (_) {
    return { found: false };
  } finally {
    clearTimeout(timer);
  }
}

function serverLabel(info) {
  try { return new URL(info.url || window.location.origin, window.location.origin).host; } catch (_) { return info.url || window.location.host; }
}

/** True when a password typed here would cross the network unencrypted to somewhere other than this very machine. */
function passwordsTravelInTheClear() {
  const here = window.location;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(here.hostname);
  const target = getServerUrl() || here.origin;
  return target.startsWith("http://") && !local && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(target);
}

function insecureNoticeHtml() {
  return passwordsTravelInTheClear()
    ? `<div class="auth-notice auth-insecure" role="note">This connection isn't encrypted (<code>http://</code>). On a trusted home network that's usually fine, but anyone on the network path could read your password. If this server is reachable from the internet, put it behind HTTPS.</div>`
    : "";
}

function authCardHtml(inner) {
  return `
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="eyebrow"><img src="${LOGO_INLINE}" alt="" width="16" height="16" style="border-radius:3px;vertical-align:-3px"> The Coop Ledger${IS_BETA_BUILD ? `<span class="auth-beta" title="You're on the beta channel: new features land here first, with the occasional rough edge">BETA</span>` : ""}</div>
        ${inner}
      </div>
    </div>`;
}

function passwordFieldHtml(id, label, autocomplete) {
  return `
    <label class="field"><span>${label}</span>
      <div class="pw-row">
        <input id="${id}" type="password" autocomplete="${autocomplete}" autocapitalize="none" spellcheck="false">
        <button type="button" class="pw-toggle" data-show-for="${id}" aria-label="Show password" aria-pressed="false">Show</button>
      </div>
    </label>`;
}

function wirePasswordToggles(root) {
  root.querySelectorAll("[data-show-for]").forEach(btn => btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.showFor);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-pressed", String(show));
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  }));
}

/** Local-only is the original way to use the app: nothing leaves this browser. */
function startLocalOnly(nameInputId) {
  const input = document.getElementById(nameInputId);
  const name = input.value.trim();
  if (!name) {
    showToast("Enter your name first", "delete");
    input.focus();
    return;
  }
  setUserName(name);
  setLocalOnlyMode(true);
  location.reload();
}

/** Remembers who just signed in (everything the rest of the app needs from the login response). */
function setAuthIdentity(data, serverUrl) {
  setServerUrl(serverUrl);
  setAuthToken(data.token);
  setUserName(data.name);
  setUserRole(data.role);
  setAuthUsername(data.username || "");
  setLocalOnlyMode(false);
}

/** Signs in with a username and password (or, for an older server, a name and invite code). */
async function submitSignIn({ base, mode }) {
  const errEl = document.getElementById("login_error");
  const btn = document.getElementById("login_submit");
  errEl.textContent = "";
  let body;
  if (mode === "code") {
    const name = document.getElementById("login_code_name").value.trim();
    const code = document.getElementById("login_code").value.trim();
    if (!name || !code) { errEl.textContent = "Enter your name and the invite code."; return; }
    body = { name, code };
  } else {
    const username = document.getElementById("login_username").value.trim();
    const password = document.getElementById("login_password").value;
    if (!username || !password) { errEl.textContent = "Enter your username and password."; return; }
    body = { username, password };
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Signing in...";
  try {
    const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errEl.textContent = typeof data.detail === "string" ? data.detail : "Couldn't sign in. Check your details and try again.";
      if (mode !== "code") { const pw = document.getElementById("login_password"); if (pw) { pw.value = ""; pw.focus(); } }
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    setAuthIdentity(data, base);
    location.reload(); // cleanest way to restart the whole app with the new auth state
  } catch (_) {
    errEl.textContent = "Couldn't reach that server -- check the address and your connection.";
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** The login page. `opts.message` is shown above the form (e.g. "You were signed out"). */
async function showLoginScreen(opts = {}) {
  document.body.classList.add("onboarding"); // hides the section nav / coop switcher: there is nothing to navigate yet
  const wrap = document.querySelector(".wrap");
  wrap.innerHTML = authCardHtml(`<h1 class="auth-title">One moment…</h1><div class="dim" style="font-size:12px">Looking for your server</div>`);
  const info = await probeServer();
  const hadServer = !!getServerUrl();
  const legacyOnly = info.found && !info.accounts;
  const notice = opts.message ? `<div class="auth-notice" role="status">${esc(opts.message)}</div>` : "";

  if (info.found) {
    // ---- a server is here: sign in is the main path ----
    const codeToggle = legacyOnly || info.inviteCodes;
    wrap.innerHTML = authCardHtml(`
      <h1 class="auth-title">Sign in</h1>
      <div class="auth-sub dim">to <strong>${esc(serverLabel(info))}</strong>
        <button type="button" class="link-btn" id="login_toggle_server">Not this one?</button></div>
      ${notice}
      ${insecureNoticeHtml()}
      <div id="login_server_section" hidden>
        <label class="field"><span>Server address</span><input id="login_server" value="${esc(info.url)}" placeholder="e.g. https://your-server.example.com" autocapitalize="none" spellcheck="false"></label>
        <div class="dim" style="font-size:11px;margin:4px 0 12px">Leave it as it is to use this server.</div>
      </div>
      <form id="login_form" novalidate>
        <div id="login_account_fields" ${legacyOnly ? "hidden" : ""}>
          <label class="field"><span>Username</span><input id="login_username" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus></label>
          ${passwordFieldHtml("login_password", "Password", "current-password")}
        </div>
        <div id="login_code_fields" ${legacyOnly ? "" : "hidden"}>
          <label class="field"><span>Your name</span><input id="login_code_name" placeholder="e.g. Alex" autocomplete="name"></label>
          <label class="field" style="margin-top:12px"><span>Invite code</span><input id="login_code" placeholder="e.g. KTRHY8NW" style="text-transform:uppercase" autocapitalize="characters" spellcheck="false"></label>
        </div>
        <div id="login_error" class="auth-error" role="alert"></div>
        <button class="btn btn-confirm auth-primary" id="login_submit" type="submit">Sign in</button>
      </form>
      ${codeToggle && !legacyOnly ? `<div class="auth-center"><button type="button" class="link-btn" id="login_use_code">Have an invite code instead?</button></div>` : ""}

      <div class="auth-divider"><span>or</span></div>
      <button class="btn ghost auth-secondary" id="gs_local_toggle" type="button" aria-expanded="false">📱 Use on this device only</button>
      <div id="gs_local_section" hidden>
        <label class="field" style="margin-top:12px"><span>Your name</span><input id="gs_name" placeholder="e.g. Alex" value="${esc(getUserName())}"></label>
        <button class="btn btn-confirm auth-primary" id="gs_local" type="button" style="margin-top:12px">Start tracking now</button>
        <div class="dim auth-fine">No account needed. Everything stays in this browser -- nothing is sent anywhere. Export a backup anytime from Settings.</div>
      </div>
    `);
    let mode = legacyOnly ? "code" : "account";
    const form = document.getElementById("login_form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const serverField = document.getElementById("login_server");
      const base = (serverField && !document.getElementById("login_server_section").hidden ? serverField.value.trim() : info.url).replace(/\/$/, "");
      submitSignIn({ base, mode });
    });
    document.getElementById("login_toggle_server").addEventListener("click", () => {
      const section = document.getElementById("login_server_section");
      section.hidden = !section.hidden;
      if (!section.hidden) document.getElementById("login_server").focus();
    });
    const useCode = document.getElementById("login_use_code");
    if (useCode) useCode.addEventListener("click", () => {
      mode = mode === "account" ? "code" : "account";
      document.getElementById("login_account_fields").hidden = mode !== "account";
      document.getElementById("login_code_fields").hidden = mode !== "code";
      useCode.textContent = mode === "code" ? "Sign in with a username instead" : "Have an invite code instead?";
      document.getElementById(mode === "code" ? "login_code_name" : "login_username").focus();
    });
    document.getElementById("gs_local_toggle").addEventListener("click", (e) => {
      const section = document.getElementById("gs_local_section");
      section.hidden = !section.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!section.hidden));
      if (!section.hidden) document.getElementById("gs_name").focus();
    });
  } else {
    // ---- no server here (the website, or an unreachable one): local-only is the main path ----
    wrap.innerHTML = authCardHtml(`
      <h1 class="auth-title">${opts.message ? "Welcome back" : "Get started"}</h1>
      <div class="auth-sub dim">Track your flock, eggs, expenses, and supplies -- right on this device, no account needed.</div>
      ${notice}
      <label class="field"><span>Your name</span><input id="gs_name" placeholder="e.g. Alex" value="${esc(getUserName())}"></label>
      <div class="dim auth-fine" style="margin:4px 0 16px">Used for activity logging -- already set if you sign in to a server later.</div>
      <button class="btn btn-confirm auth-primary" id="gs_local" type="button">📱 Start tracking now</button>
      <div class="dim auth-fine">Everything stays on this device -- nothing is sent anywhere. Export a backup anytime from Settings, or connect to a server later without losing what you've entered.</div>

      <div class="auth-divider"><span>or</span></div>
      <button class="btn ghost auth-secondary" id="gs_toggle_server" type="button" aria-expanded="false">
        <span>Sign in to your own server</span><span id="gs_toggle_arrow" aria-hidden="true">▾</span>
      </button>
      <div id="gs_server_section" hidden>
        <form id="login_form" novalidate style="margin-top:10px">
          <label class="field"><span>Server address</span><input id="login_server" value="${esc(hadServer ? getServerUrl() : "")}" placeholder="e.g. https://coop.example.com" autocapitalize="none" spellcheck="false"></label>
          <div class="dim auth-fine" style="margin:4px 0 12px">Your own self-hosted Coop Ledger. ${hadServer ? `<strong style="color:var(--text)">Couldn't reach ${esc(getServerUrl())} just now.</strong>` : ""}</div>
          <label class="field"><span>Username</span><input id="login_username" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
          ${passwordFieldHtml("login_password", "Password", "current-password")}
          <div id="login_error" class="auth-error" role="alert"></div>
          <button class="btn btn-confirm auth-primary" id="login_submit" type="submit">Sign in</button>
        </form>
      </div>
    `);
    document.getElementById("gs_toggle_server").addEventListener("click", (e) => {
      const section = document.getElementById("gs_server_section");
      section.hidden = !section.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!section.hidden));
      document.getElementById("gs_toggle_arrow").textContent = section.hidden ? "▾" : "▴";
      if (!section.hidden) document.getElementById("login_server").focus();
    });
    document.getElementById("login_form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const entered = document.getElementById("login_server").value.trim();
      if (!entered) { document.getElementById("login_error").textContent = "Enter your server's address."; return; }
      const found = await probeServer(entered);
      if (!found.found) { document.getElementById("login_error").textContent = "No Coop Ledger server answered at that address. Check it and try again."; return; }
      // Older servers only take an invite code; this form is for accounts.
      if (!found.accounts) { document.getElementById("login_error").textContent = "That server is older than accounts. Open its own address in your browser to sign in there."; return; }
      submitSignIn({ base: found.url, mode: "account" });
    });
  }
  wirePasswordToggles(wrap);
  document.getElementById("gs_local").addEventListener("click", () => startLocalOnly("gs_name"));
  document.getElementById("gs_name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startLocalOnly("gs_name"); } });
}

/** First visit: the login page. Returns true if it is showing (and init() should stop; a choice on it
 * reloads the page and starts init() again). Choosing a mode is never a one-way door -- Settings ->
 * Connection has the same switch. */
function showOnboardingIfNeeded() {
  if (localStorage.getItem(MODE_CHOSEN_KEY)) return false;
  showLoginScreen();
  return true;
}

/** The page shown when a person's password has to be replaced before they can use anything: a new account,
 * or one an admin just reset. (The server refuses everything else until it is done.) */
function showPasswordChangeScreen(me) {
  document.body.classList.add("onboarding");
  document.querySelector(".wrap").innerHTML = authCardHtml(`
    <h1 class="auth-title">Choose your password</h1>
    <div class="auth-sub dim">Welcome${me && me.name ? `, <strong style="color:var(--text)">${esc(me.name)}</strong>` : ""}. You're signed in with a temporary password -- pick your own to continue.</div>
    <form id="pwchange_form" novalidate>
      ${passwordFieldHtml("pw_current", "Temporary password", "current-password")}
      ${passwordFieldHtml("pw_new", "New password", "new-password")}
      <div class="dim auth-fine" style="margin:-4px 0 10px">At least 8 characters. A few words together is stronger than a clever short one.</div>
      ${passwordFieldHtml("pw_confirm", "New password, again", "new-password")}
      <div id="pw_error" class="auth-error" role="alert"></div>
      <button class="btn btn-confirm auth-primary" id="pw_submit" type="submit">Save and continue</button>
    </form>
    <div class="auth-center"><button type="button" class="link-btn" id="pw_signout">Sign out</button></div>
  `);
  wirePasswordToggles(document.querySelector(".wrap"));
  document.getElementById("pw_current").focus();
  document.getElementById("pwchange_form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("pw_error");
    const current = document.getElementById("pw_current").value;
    const next = document.getElementById("pw_new").value;
    if (next !== document.getElementById("pw_confirm").value) { err.textContent = "The two new passwords don't match."; return; }
    const btn = document.getElementById("pw_submit");
    btn.disabled = true;
    try {
      await apiPost("/api/auth/password", { current_password: current, new_password: next });
      location.reload();
    } catch (ex) {
      err.textContent = ex.detail || "Couldn't change the password.";
      btn.disabled = false;
    }
  });
  document.getElementById("pw_signout").addEventListener("click", async () => {
    try { await apiPost("/api/auth/logout", {}); } catch (_) { /* best effort */ }
    clearAuthToken();
    location.reload();
  });
}

/** Runs after the first-visit choice (if any) has been made. Returns true if it's fine to proceed with the rest
 * of startup, false if a login or password page is now showing and blocking init(). Deliberately doesn't block
 * just because the server is unreachable right now (offline) -- only when there's genuinely no token, or the
 * server explicitly says the token is no longer valid. Someone who already signed in shouldn't get locked out
 * of their own already-synced local data just for being offline; that would undercut the local-first design. */
async function checkAuthAndShowLoginIfNeeded() {
  if (!localStorage.getItem(MODE_CHOSEN_KEY)) return true; // first-ever launch -- the login page handles the initial choice first
  if (localOnlyMode) return true; // no server configured on purpose -- nothing to sign in to
  if (!getAuthToken()) {
    showLoginScreen({ message: "Sign in to continue." });
    return false;
  }
  try {
    const res = await fetch(apiUrl("/api/auth/me"), { headers: authHeaders() });
    if (res.status === 401) {
      clearAuthToken();
      showLoginScreen({ message: "You've been signed out. Sign in again to continue." });
      return false;
    }
    if (res.ok) {
      const me = await res.json();
      setUserName(me.name);               // keep "who am I" in step with what the server has on file...
      setUserRole(me.role);               // ...including a role an admin changed since this device last looked
      setAuthUsername(me.username || "");
      if (me.must_change_password) { showPasswordChangeScreen(me); return false; }
    }
  } catch (err) { /* offline -- can't confirm the token right now, but don't lock out already-synced local data over it */ }
  return true;
}
