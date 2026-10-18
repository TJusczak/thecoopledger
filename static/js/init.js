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

