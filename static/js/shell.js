// Coop switching, header, and the primary tab navigation.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ---------- Coop switching / header ----------
async function switchCoop(id) {
  currentCoopId = id;
  localStorage.setItem(COOP_KEY, id);
  updateHeader(); // show the new coop's name straight away -- loading its data can take a while on a slow connection
  await loadCoopData();
  updateHeader();
  updateTabVisibility();
  startEventStream();
}

function coopIcon(coop) {
  const settings = coop && coop.settings ? (() => { try { return JSON.parse(coop.settings); } catch { return {}; } })() : {};
  return settings.icon || "🐔";
}

function updateHeader() {
  const coop = STATE.coops.find(c => c.id === currentCoopId);
  document.getElementById("coopHeaderName").textContent = coop ? `${coopIcon(coop)} ${coop.name}` : "🐔 No coop selected";
  document.getElementById("eyebrowText").textContent = (coop && coop.created_date) ? `Est. ${fmtDate(coop.created_date)}` : "";
  document.getElementById("coopSwitcher").title = coop ? `${coop.name} -- switch coop` : "Switch coop";
  updatePageHeader();
  renderLocalOnlyBadge();
  renderBetaBadge();
  renderRoleBadge();
}

/** A persistent, always-visible corner tag while running local-only --
 * the whole point is that this data lives in exactly one browser's storage
 * and nowhere else, so clearing that browser's site data, uninstalling it,
 * or losing the device loses everything with no recovery path. Easy to
 * forget once the initial "use this device only" choice is behind you --
 * this stays up as a constant, honest reminder rather than a one-time
 * warning that's easy to not think about again. Tapping it jumps straight
 * to Settings, where the actual backup (export) options live. */
// Was a hardcoded 14 days. Now a per-device setting (App tab): the right
// nag interval depends on how often you actually use the app, and whether
// you want to be nagged at all is a preference, not a policy.
const BACKUP_REMINDER_ENABLED_KEY = "coop_backup_reminder_enabled";
const BACKUP_REMINDER_DAYS_KEY = "coop_backup_reminder_days";
function getBackupReminderEnabled() { return localStorage.getItem(BACKUP_REMINDER_ENABLED_KEY) !== "0"; } // default on
function setBackupReminderEnabled(on) { localStorage.setItem(BACKUP_REMINDER_ENABLED_KEY, on ? "1" : "0"); }
function getBackupReminderDays() {
  const v = Number(localStorage.getItem(BACKUP_REMINDER_DAYS_KEY));
  return Number.isFinite(v) && v >= 1 ? v : 14; // default: two weeks
}
function setBackupReminderDays(d) { localStorage.setItem(BACKUP_REMINDER_DAYS_KEY, String(d)); }
/** True when a backup is overdue AND the user wants to hear about it. */
function backupReminderOverdue() {
  return getBackupReminderEnabled() && daysSinceLastBackup() > getBackupReminderDays();
}
// "Hide the Local only tag": the calm gold tag can be hidden, but the overdue (red) state always
// shows while backup reminders are on -- hiding a reminder must not hide the warning it exists for.
// Turning reminders off (Settings -> App) silences that too.
const LOCAL_TAG_HIDDEN_KEY = "coop_local_tag_hidden";
function getLocalTagHidden() { return localStorage.getItem(LOCAL_TAG_HIDDEN_KEY) === "1"; }
function setLocalTagHidden(hidden) { localStorage.setItem(LOCAL_TAG_HIDDEN_KEY, hidden ? "1" : "0"); }

function renderLocalOnlyBadge() {
  let badge = document.getElementById("localOnlyBadge");
  if (!localOnlyMode) {
    if (badge) badge.remove();
    return;
  }
  const overdue = backupReminderOverdue();
  if (getLocalTagHidden() && !overdue) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "localOnlyBadge";
    badge.className = "status-banner-inner";
    badge.innerHTML = `<div class="local-only-badge"></div>`;
    badge.querySelector(".local-only-badge").addEventListener("click", () => {
      switchTab("settings");
      settingsSubTab = "connection";
      renderSettingsHub();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.getElementById("statusBannerSlot").appendChild(badge);
  }
  const inner = badge.querySelector(".local-only-badge");
  inner.className = overdue ? "local-only-badge local-only-badge-overdue" : "local-only-badge";
  inner.innerHTML = overdue
    ? `⚠️ Local only <span class="local-only-badge-sub">back up now</span>`
    : `📱 Local only <span class="local-only-badge-sub">${backupAgeShort() ? `backed up ${backupAgeShort()}` : "not backed up"}</span>`;
  inner.title = overdue
    ? "It's been a while since your last backup, and this coop's data lives only in this browser. Clearing this browser's site data, or uninstalling/removing the browser, will permanently delete it -- tap to back it up now."
    : "This coop's data lives only in this browser. Clearing this browser's site data, or uninstalling/removing the browser, will permanently delete it -- tap to export a backup or switch to a synced server.";
}

/** A clear, persistent indicator for anyone logged in with something other
 * than full admin access -- shares the same left slot as the local-only
 * badge above, since a session can only ever be one or the other (roles
 * only exist for a synced session; local-only mode has no server to
 * enforce them). */
function renderRoleBadge() {
  const role = getUserRole();
  if (role !== "readonly" || localOnlyMode) return;
  if (document.getElementById("roleBadge")) return; // role never changes mid-session, nothing to update after first render
  const wrap = document.createElement("div");
  wrap.id = "roleBadge";
  wrap.className = "status-banner-inner";
  const title = "You're viewing with read-only access -- everything's real, but nothing can be added, edited, or deleted from here.";
  wrap.innerHTML = `<div class="local-only-badge" style="grid-column:1" title="${esc(title)}">👁 Read-only access</div>`;
  document.getElementById("statusBannerSlot").appendChild(wrap);
}

/** A loud, hard-to-miss badge for anyone who's ended up on the beta
 * channel -- deliberately styled to match the local-only "back up now"
 * warning (same rust color, same pulsing glow) since the goal here is
 * the same: something you'd notice even if you weren't looking for it,
 * in case someone's landed here by accident rather than on purpose. */
function renderBetaBadge() {
  if (!IS_BETA_BUILD) return;
  if (document.getElementById("betaBadgeWrap")) return; // channel never changes mid-session, nothing to update after first render
  const wrap = document.createElement("div");
  wrap.id = "betaBadgeWrap";
  wrap.className = "status-banner-inner";
  wrap.innerHTML = `
    <div class="beta-status-badge-wrap">
      <button id="betaStatusBadge" class="beta-status-badge" type="button" aria-expanded="false">🚨 BETA 🚨</button>
      <div id="betaTabPanel" class="beta-tab-panel">
        <div class="beta-tab-panel-inner">
          <p>You're using the <strong>beta channel</strong> — it tracks active development directly, so new features and fixes land here first, before they're tested and promoted to a stable release.</p>
          <p>Expect rough edges. Bugs and half-finished features happen here — that's the nature of testing something in progress. <strong>Please don't rely on this for flock data you can't afford to lose.</strong> Back up regularly (Settings → Backup), or switch to the stable release if you'd rather not deal with any of that.</p>
        </div>
      </div>
    </div>
  `;
  const btn = wrap.querySelector("#betaStatusBadge");
  const panel = wrap.querySelector("#betaTabPanel");
  btn.addEventListener("click", () => {
    const nowOpen = panel.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(nowOpen));
  });
  document.getElementById("statusBannerSlot").appendChild(wrap);
}

/** Set by checkConnection() when the sync server's reported version doesn't
 * match this app's own -- null means "unknown or matching," otherwise
 * {server, client}. Mutually exclusive with local-only mode in practice
 * (a local-only setup never talks to a server to be out of date with). */
let serverVersionMismatch = null;

function renderServerVersionBadge() {
  let badge = document.getElementById("serverVersionBadge");
  if (!serverVersionMismatch) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "serverVersionBadge";
    badge.className = "status-banner-inner";
    badge.innerHTML = `<div class="server-version-badge"></div>`;
    badge.querySelector(".server-version-badge").addEventListener("click", () => {
      alert(
        `This sync server is running an older version than the app you're using.\n\n` +
        `App version: ${serverVersionMismatch.client}\nServer version: ${serverVersionMismatch.server}\n\n` +
        `The web app itself updates automatically, but the sync server is a separate process that only picks up changes when it's restarted. ` +
        `Until it's restarted, some newer features or fixes may not work correctly, and in some cases data saved through it can be silently dropped.\n\n` +
        `Restart the sync server to resolve this.`
      );
    });
    document.getElementById("statusBannerSlot").appendChild(badge);
  }
  badge.querySelector(".server-version-badge").innerHTML = `⚠️ Sync server outdated <span class="server-version-badge-sub">tap for details</span>`;
}

function updateTabVisibility() {
  const hasCoop = !!currentCoopId;
  document.querySelectorAll(".tab").forEach(t => {
    if (t.dataset.tab === "settings") return; // always reachable -- it's where "create a coop" lives
    t.style.display = hasCoop ? "" : "none";
  });
}

// Coop identity now lives in the header (name + Est. date) and Settings moved to the bottom tab bar for a consistent nav model.

// ---------- Tabs ----------
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

function switchTab(tab) {
  if (activeTab === "flock" && tab !== "flock") { selectedBirdIds.clear(); expandedBatches.clear(); }
  activeTab = tab;
  document.querySelectorAll(".tab").forEach(t => {
    const on = t.dataset.tab === tab;
    t.classList.toggle("active", on);
    if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  });
  document.querySelectorAll(".panel").forEach(p => p.style.display = "none");
  document.getElementById(`panel-${tab}`).style.display = "block";
  document.getElementById("settingsSubNav").classList.toggle("visible", tab === "settings");
  // Reset each tab's sub-nav back to its first sub-tab whenever navigating
  // here fresh -- so Coop -> Year Review -> Eggs -> back to Coop lands on
  // Overview again, not wherever it was last left.
  if (tab === "dashboard") coopSubTab = "overview";
  else if (tab === "flock") flockSubTab = "birds";
  else if (tab === "eggs") eggsSubTab = "eggs";
  else if (tab === "bedding") supplySubTab = "inventory";
  document.querySelector(".wrap").classList.toggle("subnav-open", ["settings", "dashboard", "flock", "eggs", "bedding"].includes(tab));
  updatePageHeader();
  renderActiveTab();
}

/** The wide layout's page header: the active section's icon and name, with the
 * current coop beside it. (Hidden by CSS in the narrow layout, where the bottom tab
 * bar already shows which section you are on.) */
function updatePageHeader() {
  const active = document.querySelector(".tab.active");
  if (!active) return;
  document.getElementById("pageIcon").textContent = active.querySelector(".tab-icon").textContent;
  document.getElementById("pageTitle").textContent = active.querySelector(".tab-label").textContent;
  const coop = STATE.coops.find(c => c.id === currentCoopId);
  document.getElementById("pageSub").textContent = coop ? coop.name : "";
}

// ---------- Coop switcher ----------
// The sidebar's coop card doubles as the switcher: tap it to jump between coops without
// detouring through Settings. (Creating, renaming and deleting coops still lives in
// Settings -> Coops; the menu links there.)
function closeCoopMenu() {
  const menu = document.getElementById("coopMenu");
  menu.hidden = true;
  document.getElementById("coopSwitcher").setAttribute("aria-expanded", "false");
}

function openCoopMenu() {
  const btn = document.getElementById("coopSwitcher");
  const menu = document.getElementById("coopMenu");
  const coops = [...STATE.coops].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  menu.innerHTML = `
    ${coops.map(c => `
      <button class="coop-menu-item${c.id === currentCoopId ? " current" : ""}" role="menuitemradio" aria-checked="${c.id === currentCoopId}" data-coop-id="${esc(c.id)}">
        <span class="coop-menu-icon" aria-hidden="true">${esc(coopIcon(c))}</span>
        <span class="coop-menu-name">${esc(c.name)}</span>
        ${c.id === currentCoopId ? `<span class="coop-menu-check" aria-hidden="true">✓</span>` : ""}
      </button>`).join("")}
    ${coops.length ? `<div class="coop-menu-sep" role="separator"></div>` : ""}
    <button class="coop-menu-item coop-menu-manage" role="menuitem" data-manage-coops>
      <span class="coop-menu-icon" aria-hidden="true">⚙️</span>
      <span class="coop-menu-name">${coops.length ? "Manage coops" : "Create your first coop"}</span>
    </button>`;
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  // Position against the button; fixed so the sidebar's own scrolling can't clip it.
  const r = btn.getBoundingClientRect();
  const narrow = window.innerWidth < 900;
  menu.style.left = narrow ? "12px" : `${Math.round(r.left)}px`;
  menu.style.width = narrow ? "calc(100vw - 24px)" : `${Math.round(r.width)}px`;
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  const current = menu.querySelector(".current") || menu.querySelector(".coop-menu-item");
  if (current) current.focus();
}

document.getElementById("coopSwitcher").addEventListener("click", () => {
  if (document.getElementById("coopMenu").hidden) openCoopMenu(); else closeCoopMenu();
});
document.getElementById("coopMenu").addEventListener("click", async (e) => {
  const item = e.target.closest(".coop-menu-item");
  if (!item) return;
  closeCoopMenu();
  if (item.hasAttribute("data-manage-coops")) {
    settingsSubTab = "coops";
    switchTab("settings");
    return;
  }
  const id = item.dataset.coopId;
  if (id && id !== currentCoopId) {
    await switchCoop(id);
    renderActiveTab();
  }
  document.getElementById("coopSwitcher").focus();
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("coopMenu").hidden && !e.target.closest("#coopMenu, #coopSwitcher")) closeCoopMenu();
});
document.addEventListener("keydown", (e) => {
  const menu = document.getElementById("coopMenu");
  if (menu.hidden) return;
  if (e.key === "Escape") { closeCoopMenu(); document.getElementById("coopSwitcher").focus(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const items = [...menu.querySelectorAll(".coop-menu-item")];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    e.preventDefault();
  }
});
window.addEventListener("resize", closeCoopMenu);

function renderActiveTab() {
  if (activeTab === "dashboard") renderCoopHub();
  if (activeTab === "flock") renderFlockHub();
  if (activeTab === "eggs") renderEggsHub();
  if (activeTab === "expenses") renderExpenses();
  if (activeTab === "bedding") renderSupplyHub();
  if (activeTab === "settings") renderSettingsHub();
}

