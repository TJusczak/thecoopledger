// Boot sequence: connection check, init().
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ---------- Init ----------
/** Pings the configured server (or same-origin, if none is set) so the
 * header dot reflects whether the app can actually reach it right now --
 * navigator.onLine alone only tells you the device has *some* network, not
 * that this specific server is reachable (e.g. Tailscale drops, VPN issues,
 * the server itself being down). */
let lastKnownServerVersion = null; // the raw version string from the last successful /api/health check, kept regardless of whether it matched -- serverVersionMismatch alone couldn't answer "what version is it running" once it matched

async function checkConnection() {
  const dot = document.querySelector("#connIndicator .conn-dot");
  const label = document.getElementById("connLabel");
  if (!dot || !label) return;
  if (localOnlyMode) {
    dot.className = "conn-dot local";
    label.textContent = "Local only";
    serverVersionMismatch = null;
    lastKnownServerVersion = null;
    renderServerVersionBadge();
    return;
  }
  try {
    const res = await fetch(apiUrl("/api/health"), { cache: "no-store" });
    if (!res.ok) throw new Error("bad status");
    dot.className = "conn-dot online";
    label.textContent = "Online";
    const data = await res.json();
    lastKnownServerVersion = data.version || null;
    serverVersionMismatch = (data.version && data.version !== APP_VERSION) ? { server: data.version, client: APP_VERSION } : null;
    renderServerVersionBadge();
  } catch (err) {
    dot.className = "conn-dot offline";
    label.textContent = "Offline";
    serverVersionMismatch = null; // can't tell while unreachable -- don't claim outdated when it might just be offline
    lastKnownServerVersion = null;
    renderServerVersionBadge();
  }
}
window.addEventListener("online", () => {
  checkConnection();
  updateSyncIndicator();
  if (!localOnlyMode && currentCoopId) refreshAndRender();
});
window.addEventListener("offline", checkConnection);
setInterval(checkConnection, 30000);

/** Shown once, the very first time the app runs (before any mode has been
 * chosen). Returns true if it was shown. The choice is just the initial
 * default -- Settings -> Connection has the same toggle permanently, so
 * nothing here is a one-way door. */
function showOnboardingIfNeeded() {
  if (localStorage.getItem(MODE_CHOSEN_KEY)) return false;
  document.body.classList.add("onboarding"); // hides the section nav / coop switcher: there's no coop to navigate yet
  document.querySelector(".wrap").innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
      <div class="card" style="max-width:420px;width:100%;border:2px solid var(--rust);box-shadow:0 0 0 1px rgba(193,80,46,0.15), 0 12px 32px rgba(0,0,0,0.35)">
        <div class="eyebrow"><img src="${LOGO_INLINE}" alt="" width="16" height="16" style="border-radius:3px;vertical-align:-3px"> The Coop Ledger</div>
        <h1 style="font-size:24px;margin:2px 0 4px">Get started</h1>
        <div class="dim" style="font-size:12px;margin-bottom:18px">Track your flock, eggs, expenses, and supplies -- right on this device, no account needed.</div>

        <label class="field"><span>Your name</span><input id="gs_name" placeholder="e.g. Alex"></label>
        <div class="dim" style="font-size:11px;margin:4px 0 16px">Used for activity logging -- captured once here either way, so it's already set if you connect to a server later.</div>

        <button class="btn btn-confirm" id="gs_local" style="width:100%;justify-content:center;font-size:15px;padding:12px">📱 Start tracking now</button>
        <div class="dim" style="font-size:11px;margin-top:8px">Everything stays on this device -- nothing is sent anywhere. Export a backup anytime from Settings, or connect to a server later without losing what you've entered.</div>

        <div style="margin:20px 0 4px">
          <button class="btn ghost" id="gs_toggle_server" style="width:100%;justify-content:space-between;font-size:12px">
            <span>Have an invite code for a shared server?</span><span id="gs_toggle_arrow">▾</span>
          </button>
        </div>
        <div id="gs_server_section" style="display:none;margin-top:10px">
          <label class="field"><span>Server address</span><input id="gs_server" placeholder="e.g. https://your-server.example.com"></label>
          <div class="dim" style="font-size:11px;margin:4px 0 12px">Leave blank only if this page is itself your own self-hosted server. If you got this app from somewhere else and want to sync with your own server, enter its address here.</div>
          <label class="field"><span>Invite code</span><input id="gs_code" placeholder="e.g. KTRHY8NW" style="text-transform:uppercase"></label>
          <div id="gs_error" style="color:var(--rust);font-size:12px;margin-top:10px;min-height:1em"></div>
          <button class="btn ghost" id="gs_connect" style="margin-top:4px;width:100%;justify-content:center">Connect &amp; log in</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("gs_toggle_server").addEventListener("click", () => {
    const section = document.getElementById("gs_server_section");
    const arrow = document.getElementById("gs_toggle_arrow");
    const nowOpen = section.style.display === "none";
    section.style.display = nowOpen ? "block" : "none";
    arrow.textContent = nowOpen ? "▴" : "▾";
  });
  document.getElementById("gs_connect").addEventListener("click", doGetStartedConnect);
  ["gs_name", "gs_server", "gs_code"].forEach(id => document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doGetStartedConnect(); }));
  document.getElementById("gs_local").addEventListener("click", () => {
    const name = document.getElementById("gs_name").value.trim();
    if (!name) {
      showToast("Enter your name first", "delete");
      document.getElementById("gs_name").focus();
      return;
    }
    setUserName(name);
    setLocalOnlyMode(true);
    location.reload();
  });
  return true;
}

async function doGetStartedConnect() {
  const serverUrl = document.getElementById("gs_server").value.trim();
  const name = document.getElementById("gs_name").value.trim();
  const code = document.getElementById("gs_code").value.trim();
  const errEl = document.getElementById("gs_error");
  errEl.textContent = "";
  if (!name || !code) { errEl.textContent = "Enter your name and the invite code."; return; }
  const btn = document.getElementById("gs_connect");
  btn.disabled = true;
  btn.textContent = "Connecting...";
  setServerUrl(serverUrl); // apiUrl() reads this immediately, so the login attempt right below already uses it
  try {
    const res = await fetch(apiUrl("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, code }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.detail || "Couldn't connect -- check the server address and code.";
      btn.disabled = false;
      btn.textContent = "Connect & log in";
      return;
    }
    const data = await res.json();
    setAuthToken(data.token);
    setUserName(data.name);
    setUserRole(data.role);
    setLocalOnlyMode(false);
    location.reload(); // cleanest way to restart the whole app now that everything's configured
  } catch (err) {
    errEl.textContent = "Couldn't reach that server -- check the address and your connection.";
    btn.disabled = false;
    btn.textContent = "Connect & log in";
  }
}

/** Runs after the onboarding choice (if any) has already been made. Returns
 * true if it's fine to proceed with the rest of startup, false if a login
 * screen is now showing and blocking further init(). Deliberately doesn't
 * block just because the server is unreachable right now (offline) -- only
 * blocks when there's genuinely no token, or the server explicitly says the
 * token is no longer valid. Someone who already logged in before shouldn't
 * get locked out of their own already-synced local data just for being
 * offline; that would undercut the whole local-first design. */
async function checkAuthAndShowLoginIfNeeded() {
  if (!localStorage.getItem(MODE_CHOSEN_KEY)) return true; // first-ever launch -- onboarding handles the initial choice first
  if (localOnlyMode) return true; // no server configured on purpose -- nothing to log into
  const token = getAuthToken();
  if (!token) {
    showLoginScreen();
    return false;
  }
  try {
    const res = await fetch(apiUrl("/api/auth/me"), { headers: authHeaders() });
    if (res.status === 401) {
      clearAuthToken();
      showLoginScreen();
      return false;
    }
    if (res.ok) {
      const data = await res.json();
      setUserName(data.name); // keep "who am I" in sync with what the server has on file for this session
    }
  } catch (err) { /* offline -- can't confirm the token right now, but don't lock out already-synced local data over it */ }
  return true;
}

function showLoginScreen() {
  document.body.classList.add("onboarding");
  document.querySelector(".wrap").innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
      <div class="card" style="max-width:380px;width:100%;border:2px solid var(--rust);box-shadow:0 0 0 1px rgba(193,80,46,0.15), 0 12px 32px rgba(0,0,0,0.35)">
        <div class="eyebrow"><img src="${LOGO_INLINE}" alt="" width="16" height="16" style="border-radius:3px;vertical-align:-3px"> The Coop Ledger</div>
        <h1 style="font-size:24px;margin:2px 0 4px">Welcome back</h1>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div class="dim" style="font-size:12px">Connecting to <strong style="color:var(--text)">${esc(getServerUrl() || window.location.origin)}</strong></div>
          <button type="button" class="btn ghost small" id="loginToggleServerBtn" style="flex:0 0 auto;font-size:11px;padding:4px 8px">Not this one?</button>
        </div>
        <div id="loginServerSection" style="display:none;margin-bottom:14px">
          <label class="field"><span>Server address</span><input id="loginServerUrl" value="${esc(getServerUrl())}" placeholder="e.g. https://your-server.example.com"></label>
        </div>
        <label class="field"><span>Your name</span><input id="loginName" placeholder="e.g. Alex"></label>
        <label class="field" style="margin-top:12px"><span>Invite code</span><input id="loginCode" placeholder="e.g. KTRHY8NW" style="text-transform:uppercase"></label>
        <div id="loginError" style="color:var(--rust);font-size:12px;margin-top:10px;min-height:1em"></div>
        <button class="btn btn-confirm" id="loginBtn" style="margin-top:16px;width:100%;justify-content:center">Log in</button>
        <button class="btn ghost" id="loginUseLocalBtn" style="margin-top:10px;width:100%;justify-content:center">Use offline instead</button>
        <div class="dim" style="font-size:11px;margin-top:6px;text-align:center">Switches to local-only mode using whatever's already saved on this device -- handy if this server's unreachable right now. Reconnect anytime from Settings.</div>
      </div>
    </div>
  `;
  document.getElementById("loginBtn").addEventListener("click", doLogin);
  document.getElementById("loginToggleServerBtn").addEventListener("click", () => {
    const section = document.getElementById("loginServerSection");
    const nowOpen = section.style.display === "none";
    section.style.display = nowOpen ? "block" : "none";
    if (nowOpen) document.getElementById("loginServerUrl").focus();
  });
  document.getElementById("loginUseLocalBtn").addEventListener("click", () => {
    setLocalOnlyMode(true);
    location.reload();
  });
  ["loginName", "loginCode", "loginServerUrl"].forEach(id => document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));
}

async function doLogin() {
  const name = document.getElementById("loginName").value.trim();
  const code = document.getElementById("loginCode").value.trim();
  const serverUrl = document.getElementById("loginServerUrl").value.trim();
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  if (!name || !code) { errEl.textContent = "Enter your name and the invite code."; return; }
  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.textContent = "Logging in...";
  setServerUrl(serverUrl); // apiUrl() reads this immediately, so the login attempt right below already uses it
  try {
    const res = await fetch(apiUrl("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, code }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.detail || "Login failed -- check the code and try again.";
      btn.disabled = false;
      btn.textContent = "Log in";
      return;
    }
    const data = await res.json();
    setAuthToken(data.token);
    setUserName(data.name);
    setUserRole(data.role);
    location.reload(); // cleanest way to restart the whole app with the new auth state
  } catch (err) {
    errEl.textContent = "Couldn't reach the server -- check your connection.";
    btn.disabled = false;
    btn.textContent = "Log in";
  }
}

async function init() {
  document.getElementById("todayDate").textContent = fmtDate(todayStr());
  document.getElementById("globalSearchBtn").addEventListener("click", openGlobalSearchModal);
  document.addEventListener("keydown", (e) => {
    const modalOpen = document.getElementById("modalOverlay")?.classList.contains("open");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !modalOpen) {
      e.preventDefault();
      openGlobalSearchModal();
    }
  });
  // Enter in any text/number/date input saves the entry it belongs to --
  // "type 8, hit Enter, egg entry saved" instead of reaching for the button.
  // Scoped to a containing modal or inline form block, and targeting only
  // the primary confirm button (preferring one in .modal-actions when a
  // modal has several buttons). Textareas keep Enter for newlines, and
  // checkboxes/radios/files/buttons keep their native behavior.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const t = e.target;
    if (!t || t.tagName !== "INPUT") return;
    const type = (t.getAttribute("type") || "text").toLowerCase();
    if (["checkbox", "radio", "file", "button", "submit", "range"].includes(type)) return;
    const scope = t.closest("#modalContent") || t.closest(".form-block");
    if (!scope) return;
    const saveBtn = scope.querySelector(".modal-actions .btn-confirm") || scope.querySelector(".btn-confirm");
    if (!saveBtn || saveBtn.disabled) return;
    e.preventDefault();
    t.blur(); // commit any in-progress value (and drop the mobile keyboard) before saving
    saveBtn.click();
  });
  if (showOnboardingIfNeeded()) return; // get-started screen is showing; a choice there reloads the page and restarts init() cleanly
  const authOk = await checkAuthAndShowLoginIfNeeded();
  if (!authOk) return; // login screen is showing; a successful login reloads the page and restarts init() cleanly
  checkConnection();
  try {
    await loadCoops();
  } catch (err) {
    document.getElementById("panel-dashboard").innerHTML = `
      <div class="card">
        <div class="card-title">Can't reach the server</div>
        <div class="dim" style="font-size:13px;margin-top:8px">
          ${getServerUrl() ? `Currently pointed at <strong style="color:var(--text)">${esc(getServerUrl())}</strong>.` : "Using this page's own address."}
          Check your connection, or update the server address in Settings → Connection.
        </div>
      </div>`;
    return;
  }

  currentCoopId = localStorage.getItem(COOP_KEY);
  if (currentCoopId && !STATE.coops.find(c => c.id === currentCoopId)) currentCoopId = null;
  if (!currentCoopId && STATE.coops.length === 1) currentCoopId = STATE.coops[0].id; // convenience if only one exists

  if (currentCoopId) {
    localStorage.setItem(COOP_KEY, currentCoopId);
    const newActivityRows = await loadCoopData();
    showWelcomeBackSummary(newActivityRows);
  }
  updateHeader();
  updateSyncIndicator();
  await loadUndoHistory();
  renderUndoRedoBar();
  updateTabVisibility();
  startBackgroundSyncTimer();
  startEventStream();

  if (localOnlyMode && currentCoopId && backupReminderOverdue()) {
    (async () => {
      const handle = SYNC_FOLDER_SUPPORTED ? await getSyncFolderHandle() : null;
      if (handle && (await syncFolderHasWriteAccess(handle))) {
        try {
          const filename = await writeBackupToSyncFolder(currentCoopId);
          showToast(`Auto-saved a backup to your synced folder (${filename}).`, "create");
          return;
        } catch (err) { /* fall through to the manual reminder below */ }
      }
      showToast("It's been a while since you backed up -- tap the corner tag or Settings → Coops to export a copy.", "update");
    })();
  }

  // Home-screen shortcuts (long-press the app icon) land here with ?action=
  // so they can jump straight into the tab you'd want, not just the app root.
  const action = new URLSearchParams(window.location.search).get("action");
  const shortcutTabs = { eggs: "eggs", expenses: "expenses", flock: "flock" };
  if (currentCoopId && action && shortcutTabs[action]) {
    switchTab(shortcutTabs[action]);
    if (action === "flock") { /* land on Flock; opening the new-bird form immediately felt presumptuous, so just land on the tab */ }
    renderActiveTab();
    if (action === "expenses") openExpenseModal(null);
    if (action === "eggs") openEggModal(null);
    window.history.replaceState({}, "", "/"); // drop the ?action= from the URL bar once it's been applied
  } else {
    switchTab(currentCoopId ? "dashboard" : "settings");
  }
}

