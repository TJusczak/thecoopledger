// Settings hub: coops, bedding thresholds, server, sync, notifications, year review.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= SETTINGS HUB (Coops / Bedding Thresholds / Year Review) =================
let settingsSubTab = "coops";

function renderSettingsHub() {
  const el = document.getElementById("panel-settings");
  const subNav = document.getElementById("settingsSubNav");
  if (!currentCoopId) settingsSubTab = (settingsSubTab === "connection" || settingsSubTab === "server" || settingsSubTab === "app") ? settingsSubTab : "coops"; // activity needs an active coop to mean anything
  const showServerTab = !localOnlyMode && getUserRole() === "admin";
  const subs = currentCoopId
    ? [{ id: "coops", label: "Coops" }, { id: "connection", label: "Connection" }, { id: "activity", label: "Activity" }, { id: "app", label: "App" }, ...(showServerTab ? [{ id: "server", label: "Server" }] : [])]
    : [{ id: "coops", label: "Coops" }, { id: "connection", label: "Connection" }, { id: "app", label: "App" }, ...(showServerTab ? [{ id: "server", label: "Server" }] : [])];
  subNav.innerHTML = subs.map(s => `<button class="range-btn ${settingsSubTab === s.id ? "active" : ""}" data-sub="${s.id}">${s.label}</button>`).join("");
  el.innerHTML = `<div id="settingsContent"></div>`;
  subNav.querySelectorAll("[data-sub]").forEach(b => b.addEventListener("click", () => { settingsSubTab = b.dataset.sub; renderSettingsHub(); }));
  if (settingsSubTab === "coops") renderCoopsSection();
  else if (settingsSubTab === "connection") renderConnectionSection();
  else if (settingsSubTab === "activity") renderActivityLogSection();
  else if (settingsSubTab === "app" || settingsSubTab === "defaults") renderAppSection(); // "defaults" kept as an alias -- this tab used to carry that name
  else if (settingsSubTab === "server" && showServerTab) renderServerSection();
  else renderCoopsSection(); // thresholds used to live here; if a stale settingsSubTab still says so, land somewhere real instead of an empty panel
}

function buildDiagnosticsText() {
  const lines = [];
  lines.push(`App version: ${APP_VERSION}`);
  lines.push(`currentCoopId (in memory): ${currentCoopId || "(none)"}`);
  lines.push(`localStorage COOP_KEY: ${localStorage.getItem(COOP_KEY) || "(none)"}`);
  lines.push(`STATE.coops (in memory, from IndexedDB): ${STATE.coops.length ? STATE.coops.map(c => `${c.name} [${c.id}]`).join(", ") : "(none)"}`);
  lines.push(`navigator.onLine: ${navigator.onLine}`);
  lines.push(`Server URL setting: ${getServerUrl() || "(default/same-origin)"}`);
  if (!localOnlyMode) lines.push(`Page origin: ${window.location.origin}`);
  return lines.join("\n");
}

function renderServerSection() {
  const el = document.getElementById("settingsContent");
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:4px">Server</div>
    <div class="dim" style="font-size:12px;margin-bottom:14px">Admin-only: everything about the server this coop is synced to -- backups, security, disk usage, and database stats, alongside this device's own connection diagnostics.</div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-title" style="font-size:14px">⚙️ Server settings</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Applies to the server itself, for everyone connected to it. Each of these can also be set with an environment variable in your Docker setup -- changing one here overrides that until you reset it back.</div>
      <div id="serverSettingsArea" class="dim" style="font-size:12px">Loading...</div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-title" style="font-size:14px">Server backups</div>
      <div class="dim" style="font-size:12px;margin-bottom:10px">The server automatically keeps a rolling set of daily backups (everything, plus every photo), no action needed. Download any of them below as an extra copy of your own.</div>
      <div id="backupsListArea" class="dim" style="font-size:12px">Loading...</div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-title" style="font-size:14px">Failed login attempts</div>
      <div class="dim" style="font-size:12px;margin-bottom:8px">Most recent 100 -- name and code as typed, not confirmed to belong to anyone.</div>
      <div id="failedLoginsList" class="dim" style="font-size:12px">Loading...</div>
    </div>

    <div id="serverInfoArea" class="dim" style="font-size:12px">Loading...</div>
  `;
  loadServerSettings();
  loadServerBackupsList();
  loadFailedLoginsList();
  loadServerInfo();
}

const SERVER_SETTING_LABELS = {
  session_max_idle_days: { label: "Log out inactive devices after", unit: "days", hint: "0 keeps everyone logged in indefinitely -- right for a kitchen tablet you never want to re-authenticate.", zeroLabel: "Never log out" },
  backups_enabled: { label: "Automatic backups", hint: "The server keeps its own rolling backups of everything, including photos." },
  backup_interval_hours: { label: "Take a backup every", unit: "hours" },
  max_backups_to_keep: { label: "Keep this many backups", unit: "backups", hint: "Backups hard-link photos, so keeping more costs very little disk." },
  activity_log_retention_days: { label: "Keep activity history for", unit: "days" },
};

async function loadServerSettings() {
  const area = document.getElementById("serverSettingsArea");
  if (!area) return;
  try {
    const { settings } = await apiGet("/api/admin/server-settings");
    area.innerHTML = Object.entries(settings).map(([key, s]) => {
      const meta = SERVER_SETTING_LABELS[key] || { label: key };
      const overridden = s.overridden
        ? `<button class="btn ghost small" data-reset-setting="${key}" title="Go back to the value from your environment / compose file (${s.type === "bool" ? (s.env_default ? "on" : "off") : s.env_default})">↺ Reset</button>`
        : `<span class="dim" style="font-size:10px">from environment</span>`;
      const control = s.type === "bool"
        ? `<input type="checkbox" data-setting="${key}" ${s.value ? "checked" : ""} style="width:auto">`
        : `<input type="number" data-setting="${key}" value="${s.value}" min="${s.min ?? 0}" max="${s.max ?? 9999}" style="width:90px">`;
      return `
        <div style="border-top:1px solid var(--border);padding:10px 0">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <div style="color:var(--text);font-size:13px">${meta.label}${meta.unit ? ` <span class="dim">(${meta.unit})</span>` : ""}</div>
            <div style="display:flex;align-items:center;gap:8px">${control}${overridden}</div>
          </div>
          ${meta.hint ? `<div class="dim" style="font-size:11px;margin-top:3px">${meta.hint}</div>` : ""}
          ${key === "session_max_idle_days" && s.value === 0 ? `<div class="dim" style="font-size:11px;margin-top:3px;color:var(--gold)">Currently: ${meta.zeroLabel}</div>` : ""}
        </div>`;
    }).join("") + `<div style="margin-top:12px"><button class="btn btn-confirm" id="saveServerSettings">✓ Save server settings</button></div>`;

    document.getElementById("saveServerSettings").addEventListener("click", async () => {
      const body = {};
      area.querySelectorAll("[data-setting]").forEach(inp => {
        body[inp.dataset.setting] = inp.type === "checkbox" ? inp.checked : Number(inp.value);
      });
      try {
        await apiPutJson("/api/admin/server-settings", body);
        showToast("Server settings saved -- they take effect right away", "update");
        loadServerSettings();
      } catch (err) {
        showToast(err.message || "Couldn't save server settings", "delete");
      }
    });
    area.querySelectorAll("[data-reset-setting]").forEach(btn => btn.addEventListener("click", async () => {
      // null tells the server to drop the override and fall back to the env
      // value, rather than freezing whatever number happens to be in the box.
      await apiPutJson("/api/admin/server-settings", { [btn.dataset.resetSetting]: null });
      showToast("Reset to the value from your environment", "update");
      loadServerSettings();
    }));
  } catch (err) {
    area.innerHTML = `<div class="dim">Couldn't load server settings right now.</div>`;
  }
}

/** PUT with a JSON body that surfaces the server's error message, so a
 * rejected value (out of range, unknown key) says why instead of failing
 * silently. */
async function apiPutJson(path, body) {
  const res = await fetch(apiUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = "Request failed";
    try { msg = (await res.json()).detail || msg; } catch (e) { /* non-JSON error body */ }
    throw new Error(msg);
  }
  return res.json();
}

async function loadServerBackupsList() {
  const area = document.getElementById("backupsListArea");
  if (!area) return;
  try {
    const res = await fetch(apiUrl("/api/backups"), { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to load backups");
    const { backups } = await res.json();
    if (backups.length === 0) {
      area.innerHTML = `<div class="dim">No backups yet -- the first one is created automatically within a day of the server starting up.</div>`;
      return;
    }
    // The keep-count can be set as high as 365, so this list gets long. Show
    // the most recent handful (the ones you'd actually reach for) and tuck
    // the rest behind a toggle so the Server page stays scannable.
    const row = (b) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="color:var(--text);font-size:13px">${esc(new Date(b.created_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }))}</div>
          <div class="dim" style="font-size:11px">${fmtBytes(b.size_bytes)}</div>
        </div>
        <a class="btn ghost small" href="${apiUrl(`/api/backups/${encodeURIComponent(b.filename)}`)}?token=${encodeURIComponent(getAuthToken())}" download>⬇ Download</a>
      </div>`;
    renderCollapsibleList(area, backups, row, 5, "backups");
  } catch (err) {
    area.innerHTML = `<div class="dim">Couldn't load the backup list right now.</div>`;
  }
}

async function loadFailedLoginsList() {
  const area = document.getElementById("failedLoginsList");
  if (!area) return;
  try {
    const attempts = await apiGet("/api/auth/failed-logins");
    if (attempts.length === 0) { area.textContent = "None"; return; }
    const row = (a) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span>${esc(a.name_attempted || "(no name)")} <span class="mono dim" style="font-size:11px">${esc(a.code_attempted || "")}</span></span>
        <span class="dim" style="font-size:11px;text-align:right">${esc(a.ip)}<br>${relativeTime(a.attempted_at)}</span>
      </div>`;
    renderCollapsibleList(area, attempts, row, 5, "attempts");
  } catch (err) {
    area.textContent = "Couldn't load -- offline?";
  }
}

/** Renders the first `collapsedCount` rows, hiding the rest behind a
 * show-all/show-fewer toggle. Shared by the backup and failed-login lists
 * so both long lists on the Server page behave identically. `rowFn` maps
 * one item to its HTML string; `noun` is the plural label in the button. */
function renderCollapsibleList(area, items, rowFn, collapsedCount, noun) {
  const recent = items.slice(0, collapsedCount).map(rowFn).join("");
  const rest = items.slice(collapsedCount).map(rowFn).join("");
  const restId = `collapse-rest-${Math.random().toString(36).slice(2, 8)}`; // unique so two lists on one page don't collide
  area.innerHTML = recent + (rest
    ? `<div id="${restId}" style="display:none">${rest}</div>
       <button class="btn ghost small collapse-toggle" style="margin-top:10px">Show all ${items.length} ${noun}</button>`
    : "");
  const toggle = area.querySelector(".collapse-toggle");
  if (toggle) toggle.addEventListener("click", () => {
    const restEl = document.getElementById(restId);
    const open = restEl.style.display !== "none";
    restEl.style.display = open ? "none" : "block";
    toggle.textContent = open ? `Show all ${items.length} ${noun}` : "Show fewer";
  });
}

async function loadServerInfo() {
  const area = document.getElementById("serverInfoArea");
  if (!area) return;
  try {
    const res = await fetch(apiUrl("/api/admin/server-info"), { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to load server info");
    const info = await res.json();

    const statRow = (label, value) => `
      <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
        <span class="dim">${esc(label)}</span><span style="color:var(--text)">${value}</span>
      </div>
    `;
    const tombs = info.database.tombstone_counts || {};
    const rowCountRows = Object.entries(info.database.row_counts)
      .filter(([table, n]) => n > 0 || tombs[table] > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([table, n]) => statRow(table, `${n.toLocaleString()}${tombs[table] ? ` <span class="dim" style="font-size:11px">+ ${tombs[table].toLocaleString()} deleted</span>` : ""}`))
      .join("");
    // Per-coop breakdown -- the flat totals sum every live coop, so this is
    // what answers "why is birds bigger than my flock" at a glance.
    const perCoopHtml = (info.database.per_coop && info.database.per_coop.length > 1) ? info.database.per_coop.map(c => `
      <div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px">
        <div style="font-size:12px;color:var(--text);font-weight:600;margin-bottom:2px">${esc(c.name)}</div>
        ${Object.entries(c.counts).filter(([, n]) => n > 0).map(([table, n]) => statRow(table, n.toLocaleString())).join("") || `<div class="dim" style="font-size:12px;padding:3px 0">empty</div>`}
      </div>`).join("") : "";

    area.innerHTML = `
      <div class="card">
        <div class="card-title" style="font-size:14px">Server</div>
        ${statRow("App version", esc(info.server_version))}
        ${statRow("Python", esc(info.python_version))}
        ${statRow("SQLite", `${esc(info.sqlite_version)} (${esc(info.database.journal_mode)} mode)`)}
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title" style="font-size:14px">Disk usage</div>
        ${statRow("Photos", fmtBytes(info.disk.photos_bytes))}
        ${statRow("Backups", fmtBytes(info.disk.backups_bytes))}
        <div style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px">
          ${statRow("Total (data directory)", fmtBytes(info.disk.data_dir_bytes))}
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title" style="font-size:14px">Database</div>
        ${statRow("Database file size", fmtBytes(info.database.size_bytes))}
        ${statRow("Coops", `${info.database.coop_count}${info.database.deleted_coop_count ? ` <span class="dim" style="font-size:11px">+ ${info.database.deleted_coop_count} deleted</span>` : ""}`)}
        ${rowCountRows ? `<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px">${rowCountRows}</div>` : ""}
        ${(info.database.tombstone_counts && Object.keys(info.database.tombstone_counts).length) ? `<div class="dim" style="font-size:11px;margin-top:8px">"Deleted" rows are sync markers, not clutter -- they're how other devices learn something was removed. They're excluded from every count and total in the app itself.</div>` : ""}
      </div>

      ${perCoopHtml ? `
      <div class="card" style="margin-top:14px">
        <div class="card-title" style="font-size:14px">Per coop</div>
        <div style="margin-top:-6px">${perCoopHtml}</div>
      </div>` : ""}

      <div class="card" style="margin-top:14px">
        <div class="card-title" style="font-size:14px">Backups</div>
        ${statRow("Currently kept", `${info.backups.count} of ${info.backups.max_kept}`)}
        ${statRow("Most recent", info.backups.most_recent ? relativeTime(info.backups.most_recent) : "none yet")}
        ${statRow("Runs every", `${info.backups.interval_hours}h`)}
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title" style="font-size:14px">Access</div>
        ${statRow("Active invite codes", info.auth.active_invite_codes)}
        ${statRow("Active sessions", info.auth.active_sessions)}
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title" style="font-size:14px">This device</div>
        <div id="diagText" class="dim" style="font-size:11px;font-family:'JetBrains Mono',monospace;line-height:1.8;white-space:pre-wrap;margin-top:6px">${esc(buildDiagnosticsText())}</div>
      </div>
    `;
  } catch (err) {
    area.innerHTML = `<div class="dim">Couldn't load server info right now.</div>`;
  }
}

let activityLogVisibleCount = PAGE_SIZE;

function renderActivityLogSection() {
  const el = document.getElementById("settingsContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const sorted = [...STATE.activityLog].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const paged = sorted.slice(0, activityLogVisibleCount);
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:4px">Activity Log</div>
    <div class="dim" style="font-size:12px;margin-bottom:14px">Who changed what, shared across every device connected to this coop. Only shows entries from devices that have a name set in Connection -- changes from a device with no name aren't attributed here.</div>
    ${sorted.length === 0 ? `<div class="card"><div class="empty">No activity logged yet.</div></div>` : `
    <div class="list-stack">
      ${paged.map(e => {
        const tone = e.op === "create" ? "sage" : e.op === "delete" ? "rust" : "slate";
        return `
        <div class="list-card tone-${tone}">
          <div class="list-card-main">
            <div><strong style="color:var(--text)">${esc(e.changed_by || "Someone")}</strong> ${esc(e.summary || `${e.op} ${e.resource}`)}</div>
            <div class="list-card-desc dim">${e.updated_at ? esc(new Date(e.updated_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })) : ""} — <span style="color:var(--gold)">${relativeTimeLong(e.updated_at)}</span></div>
          </div>
        </div>`;
      }).join("")}
    </div>
    ${loadMoreButtonHtml(sorted.length, activityLogVisibleCount, "loadMoreActivityBtn")}
    `}
  `;
  const loadMoreEl = document.getElementById("loadMoreActivityBtn");
  if (loadMoreEl) loadMoreEl.addEventListener("click", () => { activityLogVisibleCount += PAGE_SIZE; renderActivityLogSection(); });
}

function renderConnectionSection() {
  const el = document.getElementById("settingsContent");
  const current = getServerUrl();
  const groupHeaderStyle = "font-family:'Roboto Slab',serif;font-weight:700;font-size:15px;color:var(--gold);margin:26px 0 2px";
  el.innerHTML = `
    <div class="card">
      <div class="card-title">How this app runs</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Switch anytime -- nothing is lost either way. Turning sync on later automatically pushes out everything you did while local-only.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ${localOnlyMode ? "btn-confirm" : "ghost"}" id="modeLocalBtn">📱 Local only</button>
        <button class="btn ${!localOnlyMode ? "btn-confirm" : "ghost"}" id="modeSyncBtn">☁️ Sync with a server</button>
      </div>
    </div>

    <div style="${groupHeaderStyle}">Online sync</div>
    <div class="card" style="margin-top:10px">
      <div class="card-title">Your name</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Used to label changes when syncing with someone else -- so "Alex added an egg entry" shows up on their device instead of a generic notice. Leave blank to skip attribution; per-device, not synced anywhere itself.</div>
      <div style="display:flex;gap:8px">
        <input id="userNameInput" placeholder="e.g. Alex" value="${esc(getUserName())}" style="flex:1">
        <button class="btn btn-confirm" id="saveUserNameBtn">✓ Save</button>
      </div>
    </div>

    ${localOnlyMode ? `
    <div class="card" style="margin-top:16px;border-color:var(--gold)">
      <div class="card-title">Running local-only</div>
      <div class="dim" style="font-size:12px;margin-bottom:8px">This coop's data lives only in this browser's storage on this device -- it is not sent anywhere, and nothing is backed up automatically. <strong style="color:var(--text)">Clearing this browser's site data or cache, uninstalling/removing the browser, or losing this device will permanently delete it, with no way to recover it.</strong></div>
      <div class="dim" style="font-size:12px">The safest way to protect it is exporting a backup from Settings → Coops -- do this periodically, and especially before clearing any browser data. Switching to "Sync with a server" above (anytime, without losing anything already entered) also keeps a live copy safe on the server automatically.</div>
    </div>
    ` : `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Server connection</div>
      <div class="dim" style="font-size:12px;margin-bottom:10px">
        ${current ? `Currently using: <strong style="color:var(--text)">${esc(current)}</strong>` : `No server address set.`}
      </div>
      ${current && current !== window.location.origin ? `
      <div class="dim" style="font-size:12px;margin-bottom:10px;border-left:2px solid var(--gold);padding-left:10px">
        This app was opened from a different address than the server above. That's fine, but the two update independently -- for guaranteed compatibility between what you see and what your server understands, open the app directly from your server's own address instead when you can. Frontend and backend always ship together there, so there's nothing to drift out of sync.
      </div>
      ` : ""}
      <div id="serverVersionLine" class="dim" style="font-size:12px;margin-bottom:10px">Sync server version: checking...</div>
      <div id="liveUpdatesLine" class="dim" style="font-size:12px;margin-bottom:14px">Live updates: checking...</div>
      <div class="dim" style="font-size:12px;margin-bottom:14px">
        Only change this if you've installed/cached this app separately and need to point it at a specific server -- for example, a wrapped native copy that should always reach your home server directly.
      </div>
      <label class="field"><span>Server URL</span><input id="conn_url" placeholder="e.g. https://your-server.example.com" value="${esc(current)}"></label>
      <div id="connStatus" class="dim" style="font-size:12px;margin-top:10px"></div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-confirm" id="saveConnBtn">✓ Save &amp; reconnect</button>
        <button class="btn ghost" id="testConnBtn">Test connection</button>
        ${current ? `<button class="btn btn-close" id="clearConnBtn">Reset to default</button>` : ""}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">Sync status</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">
        Everything is stored on this device first and syncs with the server in the background -- birds, eggs, expenses, supplies, bedding, notes, health/medical logs, and coop management (creating, renaming, deleting a coop, and settings like defaults and bedding areas). Photos queue separately (they're files, not data rows) and upload as soon as a connection is available. Exporting a full backup works with or without a connection.
      </div>
      <div id="syncStatus" class="dim" style="font-size:12px;margin-bottom:10px">Checking...</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        <button class="btn btn-confirm" id="syncNowBtn">↻ Sync now</button>
        <label class="field" style="margin:0"><span style="font-size:11px">Auto-sync</span>
          <select id="syncIntervalSelect">
            <option value="30" ${getSyncIntervalSec() === 30 ? "selected" : ""}>Every 30 seconds</option>
            <option value="60" ${getSyncIntervalSec() === 60 ? "selected" : ""}>Every minute</option>
            <option value="300" ${getSyncIntervalSec() === 300 ? "selected" : ""}>Every 5 minutes</option>
            <option value="0" ${getSyncIntervalSec() === 0 ? "selected" : ""}>Manual only</option>
          </select>
        </label>
      </div>
    </div>

    ${getUserRole() === "admin" ? `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Invite codes</div>
      <div class="dim" style="font-size:12px;margin-bottom:10px">
        <strong>Admin</strong> codes can do anything. <strong>Read-only</strong> codes can see everything but can't change anything.
      </div>
      <div id="inviteCodesListArea" class="dim" style="font-size:12px;margin-bottom:14px">Loading...</div>
      <div class="grid-form">
        <label class="field"><span>New code's access level</span>
          <select id="newInviteRole">
            <option value="readonly">Read-only</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label class="field"><span>Label (optional)</span><input id="newInviteLabel" placeholder="e.g. Grandma's viewer link"></label>
      </div>
      <div style="margin-top:10px"><button class="btn btn-confirm" id="createInviteBtn">+ Create invite code</button></div>
    </div>
    ` : ""}

    <div class="card" style="margin-top:16px">
      <div class="card-title">Account</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Logged in as <strong style="color:var(--text)">${esc(getUserName() || "(unknown)")}</strong>.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn btn-close" id="logoutBtn">Log out</button>
      </div>
      <div class="dim" style="font-size:12px;margin-bottom:8px">Invite code -- share this with anyone you want to give access. Rotating it only affects future logins; nobody already connected gets kicked out.</div>
      <div id="inviteCodeDisplay" class="dim" style="font-family:'JetBrains Mono',monospace;font-size:16px;margin-bottom:10px">Loading...</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
        <button class="btn ghost" id="rotateInviteBtn">↻ Rotate now</button>
        <label class="field" style="margin:0"><span style="font-size:11px">Auto-rotate</span>
          <select id="autoRotateSelect">
            <option value="">Never (manual only)</option>
            <option value="7">Every 7 days</option>
            <option value="30">Every 30 days</option>
            <option value="90">Every 90 days</option>
          </select>
        </label>
      </div>
      <div class="dim" style="font-size:12px;margin-bottom:8px">Active sessions -- everyone currently logged in.</div>
      <div id="sessionsList" class="dim" style="font-size:12px">Loading...</div>
    </div>

    `}

  `;
  document.getElementById("saveUserNameBtn").addEventListener("click", () => {
    setUserName(document.getElementById("userNameInput").value);
    showToast(getUserName() ? `Set as ${getUserName()}` : "Name cleared", "update");
  });
  document.getElementById("modeLocalBtn").addEventListener("click", () => {
    if (localOnlyMode) return;
    setLocalOnlyMode(true);
    stopEventStream();
    showToast("Switched to local-only", "update");
    renderConnectionSection();
    checkConnection();
    updateSyncIndicator();
  });
  document.getElementById("modeSyncBtn").addEventListener("click", () => {
    if (!localOnlyMode) return;
    if (!getUserName()) {
      showToast("Set your name above first", "delete");
      document.getElementById("userNameInput").focus();
      return;
    }
    setLocalOnlyMode(false);
    showToast("Switched to server sync", "update");
    renderConnectionSection();
    checkConnection();
    startEventStream();
    updateSyncIndicator();
    if (currentCoopId) refreshAndRender();
  });

  if (localOnlyMode) return; // nothing else on this page applies in local-only mode

  if (getUserRole() === "admin") {
    async function loadInviteCodesList() {
      const area = document.getElementById("inviteCodesListArea");
      if (!area) return;
      try {
        const res = await fetch(apiUrl("/api/auth/invite-codes"), { headers: authHeaders() });
        if (!res.ok) throw new Error("Failed to load invite codes");
        const codes = await res.json();
        const roleLabel = { admin: "Admin", readonly: "Read-only" };
        area.innerHTML = codes.map(c => `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
            <div style="${c.revoked_at ? "opacity:0.5" : ""}">
              <div style="color:var(--text);font-size:13px"><span class="stamp tone-${c.role === "admin" ? "gold" : "sage"}">${roleLabel[c.role] || c.role}</span> ${esc(c.label || "")}${c.revoked_at ? ` <span class="stamp tone-rust">Revoked</span>` : ""}</div>
              <div class="dim" style="font-size:11px;font-family:'JetBrains Mono',monospace">${esc(c.code)}</div>
            </div>
            ${!c.revoked_at
              ? `<button class="btn btn-close small" data-revoke-code="${c.id}" style="flex:0 0 auto">Revoke</button>`
              : `<button class="btn btn-close small" data-delete-code="${c.id}" style="flex:0 0 auto">🗑 Delete permanently</button>`}
          </div>
        `).join("") || `<div class="dim">No invite codes yet.</div>`;
        area.querySelectorAll("[data-revoke-code]").forEach(btn => btn.addEventListener("click", async () => {
          if (!(await showConfirmDialog("Revoke this invite code? Anyone currently logged in with it will be signed out immediately."))) return;
          const res2 = await fetch(apiUrl(`/api/auth/invite-codes/${btn.dataset.revokeCode}`), { method: "DELETE", headers: authHeaders() });
          if (!res2.ok) {
            const err = await res2.json().catch(() => ({}));
            showToast(err.detail || "Couldn't revoke that code", "delete");
            return;
          }
          showToast("Invite code revoked", "delete");
          loadInviteCodesList();
        }));
        area.querySelectorAll("[data-delete-code]").forEach(btn => btn.addEventListener("click", async () => {
          if (!(await showConfirmDialog("Permanently delete this revoked invite code from the list? This can't be undone."))) return;
          const res2 = await fetch(apiUrl(`/api/auth/invite-codes/${btn.dataset.deleteCode}/permanent`), { method: "DELETE", headers: authHeaders() });
          if (!res2.ok) {
            const err = await res2.json().catch(() => ({}));
            showToast(err.detail || "Couldn't delete that code", "delete");
            return;
          }
          showToast("Invite code deleted", "delete");
          loadInviteCodesList();
        }));
      } catch (err) {
        area.innerHTML = `<div class="dim">Couldn't load invite codes right now.</div>`;
      }
    }
    loadInviteCodesList();

    document.getElementById("createInviteBtn").addEventListener("click", async () => {
      const role = document.getElementById("newInviteRole").value;
      const label = document.getElementById("newInviteLabel").value.trim();
      const res = await fetch(apiUrl("/api/auth/invite-codes"), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ role, label }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Couldn't create that invite code", "delete");
        return;
      }
      const data = await res.json();
      showToast(`New ${role} code created: ${data.code}`, "create");
      document.getElementById("newInviteLabel").value = "";
      loadInviteCodesList();
    });
  }

  document.getElementById("saveConnBtn").addEventListener("click", async () => {
    if (!getUserName()) {
      showToast("Set your name above first", "delete");
      document.getElementById("userNameInput").focus();
      return;
    }
    const previousUrl = getServerUrl();
    const newUrl = document.getElementById("conn_url").value.trim().replace(/\/$/, "");
    setServerUrl(newUrl);
    if (previousUrl && newUrl && newUrl !== previousUrl) {
      // A genuine switch to a different server, not just re-saving the same
      // one -- the previously-selected coop almost certainly doesn't exist
      // on this new server at all, so clearing it forces a fresh pick
      // instead of the app quietly trying to keep using a coop id that
      // belongs to somewhere else entirely.
      localStorage.removeItem(COOP_KEY);
    }
    showToast("Server connection saved", "update");
    location.reload();
  });
  const clearBtn = document.getElementById("clearConnBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    setServerUrl("");
    showToast("Reset to default connection", "update");
    location.reload();
  });
  document.getElementById("testConnBtn").addEventListener("click", async () => {
    const url = document.getElementById("conn_url").value.trim().replace(/\/$/, "");
    const statusEl = document.getElementById("connStatus");
    statusEl.textContent = "Checking...";
    try {
      const res = await fetch(url + "/api/health", { cache: "no-store" });
      statusEl.innerHTML = res.ok ? `<span style="color:var(--sage)">✓ Reachable</span>` : `<span style="color:var(--danger)">Server responded, but with an error</span>`;
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--danger)">✕ Could not reach that address</span>`;
    }
  });
  refreshSyncStatus();
  refreshServerConnectionStatus();
  (async () => {
    const pendingPhotos = await getAllPendingPhotos();
    const outbox = await getOutbox();
    const diagEl = document.getElementById("diagText");
    if (!diagEl) return;
    diagEl.textContent += `\nPending photo uploads: ${pendingPhotos.length}${pendingPhotos.length ? " (" + pendingPhotos.map(p => p.birdId).join(", ") + ")" : ""}`;
    diagEl.textContent += `\nOutbox entries: ${outbox.length}${outbox.length ? "\n  " + outbox.map(o => `${o.op} ${o.resource} [${o.id}]`).join("\n  ") : ""}`;
  })();
  document.getElementById("syncNowBtn").addEventListener("click", async () => {
    if (!currentCoopId) { showToast("Select a coop first", "update"); return; }
    const statusEl = document.getElementById("syncStatus");
    statusEl.textContent = "Syncing...";
    try {
      await Promise.all(LOCAL_FIRST_RESOURCES.map(r => syncResource(r, r === "coops" ? null : currentCoopId)));
      showToast("Synced", "update");
      await loadCoopData();
      updateHeader();
      renderActiveTab();
    } catch (err) {
      showToast("Sync failed -- still offline?", "delete");
    }
    refreshSyncStatus();
    refreshServerConnectionStatus();
    updateSyncIndicator();
  });
  const intervalSelect = document.getElementById("syncIntervalSelect");
  if (intervalSelect) intervalSelect.addEventListener("change", (e) => {
    setSyncIntervalSec(Number(e.target.value));
    startBackgroundSyncTimer();
    showToast(e.target.value === "0" ? "Auto-sync off -- use Sync now" : "Auto-sync interval updated", "update");
  });

  const inviteCodeEl = document.getElementById("inviteCodeDisplay");
  const sessionsEl = document.getElementById("sessionsList");
  async function refreshAccountCard() {
    if (inviteCodeEl) {
      try {
        const data = await apiGet("/api/auth/invite-code");
        inviteCodeEl.textContent = data.invite_code;
        const autoRotateSelect = document.getElementById("autoRotateSelect");
        if (autoRotateSelect) autoRotateSelect.value = data.auto_rotate_days || "";
      } catch (err) {
        inviteCodeEl.textContent = "Couldn't load -- offline?";
      }
    }
    if (sessionsEl) {
      try {
        const sessions = await apiGet("/api/auth/sessions");
        sessionsEl.innerHTML = sessions.length === 0 ? "None" : sessions.map(s => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
            <span>${esc(s.name)} <span class="dim" style="font-size:11px">-- active ${s.last_activity ? relativeTime(s.last_activity) : "never"} · joined ${relativeTime(s.created_at)}</span></span>
            <button class="btn ghost small" data-revoke="${s.id}">Revoke</button>
          </div>`).join("");
        sessionsEl.querySelectorAll("[data-revoke]").forEach(b => b.addEventListener("click", async () => {
          if (!(await showConfirmDialog("Revoke this session? That device will need the invite code again to reconnect."))) return;
          try {
            await apiDelete(`/api/auth/sessions/${b.dataset.revoke}`);
            showToast("Session revoked", "delete");
            refreshAccountCard();
          } catch (err) { showToast("Couldn't revoke -- offline?", "delete"); }
        }));
      } catch (err) {
        sessionsEl.textContent = "Couldn't load -- offline?";
      }
    }
  }
  refreshAccountCard();

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    if (!(await showConfirmDialog("Log out of this device? You'll need the invite code again to log back in."))) return;
    try { await apiPost("/api/auth/logout", {}); } catch (err) { /* best effort -- clearing the local token below is what actually matters */ }
    clearAuthToken();
    location.reload();
  });
  const rotateInviteBtn = document.getElementById("rotateInviteBtn");
  if (rotateInviteBtn) rotateInviteBtn.addEventListener("click", async () => {
    if (!(await showConfirmDialog("Rotate the invite code? Anyone already logged in stays logged in -- this only changes what's needed for new logins."))) return;
    try {
      await apiPost("/api/auth/invite-code/rotate", {});
      showToast("Invite code rotated", "update");
      refreshAccountCard();
    } catch (err) { showToast("Couldn't rotate -- offline?", "delete"); }
  });
  const autoRotateSelect = document.getElementById("autoRotateSelect");
  if (autoRotateSelect) autoRotateSelect.addEventListener("change", async (e) => {
    const days = e.target.value ? Number(e.target.value) : null;
    try {
      await apiPost("/api/auth/invite-code/auto-rotate", { days });
      showToast(days ? `Auto-rotating every ${days} days` : "Auto-rotate turned off", "update");
    } catch (err) { showToast("Couldn't save -- offline?", "delete"); }
  });
  renderPushSettings();
  renderIntegrationSettings();
}

/** Integrations card: a long-lived read-only API key for Home Assistant,
 * Grafana and friends. Rendered after the fact like the push card because it
 * has to fetch current key state from the server. */
async function renderIntegrationSettings() {
  const host = document.getElementById("settingsContent");
  if (!host) return;
  const wrap = document.createElement("div");
  wrap.className = "card";
  host.appendChild(wrap);

  let key = null;
  try { key = (await apiGet("/api/integrations/key")).api_key || null; }
  catch (_) { wrap.innerHTML = `<div class="card-title">Integrations</div><div class="dim" style="font-size:12px">Couldn't reach the server.</div>`; return; }

  wrap.innerHTML = `
    <div class="card-title">Integrations</div>
    <div class="dim" style="font-size:12px;margin-bottom:10px">
      A read-only feed of your stats for Home Assistant, Grafana or a dashboard.
      The key is separate from your login and only reaches <span class="mono">/api/integrations/stats</span> -- it can't change anything.
    </div>
    ${key ? `
      <label class="field"><span>API key</span>
        <input type="text" id="intKey" readonly value="${esc(key)}" style="font-family:'JetBrains Mono',monospace;font-size:12px">
      </label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn ghost small" id="intCopy">Copy key</button>
        <button class="btn ghost small" id="intUrl">Copy URL</button>
        <button class="btn ghost small" id="intRotate">Rotate</button>
        <button class="btn ghost small" id="intRevoke" style="color:var(--danger)">Revoke</button>
      </div>
      <div class="dim" style="font-size:11px;margin-top:10px">Rotating or revoking immediately breaks anything still using the old key. Setup examples are in <span class="mono">INTEGRATIONS.md</span>.</div>
    ` : `
      <button class="btn btn-confirm small" id="intGen">Generate key</button>
    `}
  `;

  const gen = wrap.querySelector("#intGen");
  if (gen) gen.addEventListener("click", async () => {
    try { await apiPost("/api/integrations/key/rotate", {}); showToast("Key generated", "create"); renderConnectionSection(); }
    catch (_) { showToast("Couldn't generate a key", "delete"); }
  });
  const copyText = async (text, label) => {
    try { await navigator.clipboard.writeText(text); showToast(`${label} copied`, "update"); }
    catch (_) { showToast("Couldn't copy", "delete"); }
  };
  const copyBtn = wrap.querySelector("#intCopy");
  if (copyBtn) copyBtn.addEventListener("click", () => copyText(key, "Key"));
  const urlBtn = wrap.querySelector("#intUrl");
  if (urlBtn) urlBtn.addEventListener("click", () => copyText(`${getServerUrl() || location.origin}/api/integrations/stats`, "URL"));
  const rotateBtn = wrap.querySelector("#intRotate");
  if (rotateBtn) rotateBtn.addEventListener("click", async () => {
    if (!confirm("Rotate the key? Anything using the current key will stop working until you update it.")) return;
    try { await apiPost("/api/integrations/key/rotate", {}); showToast("Key rotated", "update"); renderConnectionSection(); }
    catch (_) { showToast("Couldn't rotate", "delete"); }
  });
  const revokeBtn = wrap.querySelector("#intRevoke");
  if (revokeBtn) revokeBtn.addEventListener("click", async () => {
    if (!confirm("Revoke the key? The stats feed will stop responding until you generate a new one.")) return;
    try { await apiDelete("/api/integrations/key"); showToast("Key revoked", "delete"); renderConnectionSection(); }
    catch (_) { showToast("Couldn't revoke", "delete"); }
  });
}

/** Notifications card, appended to the Connection settings tab. Rendered
 * separately because it has to inspect async browser state (permission and
 * existing subscription) that isn't available while building the page HTML. */
async function renderPushSettings() {
  const host = document.getElementById("settingsContent");
  if (!host) return;
  const wrap = document.createElement("div");
  wrap.className = "card";
  host.appendChild(wrap);

  const supported = pushSupported();
  const permission = supported ? Notification.permission : "unsupported";
  const sub = supported ? await getPushSubscription() : null;
  const on = !!sub && permission === "granted";
  const prefs = getPushPrefs();

  if (!supported) {
    wrap.innerHTML = `<div class="card-title">Notifications</div>
      <div class="dim" style="font-size:12px">This browser doesn't support push notifications. On iPhone, add the app to your Home Screen first -- Safari only allows them for installed apps.</div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="card-title">Notifications</div>
    <div class="dim" style="font-size:12px;margin-bottom:10px">Reminders arrive even when the app is closed. ${permission === "denied"
      ? `<strong style="color:var(--danger)">Blocked in your browser settings</strong> -- re-allow notifications for this site to turn them on.`
      : "Your device's own notification settings always have the final say."}</div>
    <label class="switch-row">
      <span>Push notifications</span>
      <input type="checkbox" id="pushMaster" ${on ? "checked" : ""} ${permission === "denied" ? "disabled" : ""}>
    </label>
    <div id="pushCats" style="margin-top:10px;${on ? "" : "opacity:.45;pointer-events:none"}">
      ${PUSH_CATEGORIES.map(c => `
        <label class="switch-row">
          <span>${c.emoji} ${esc(c.label)}</span>
          <input type="checkbox" data-push-cat="${c.key}" ${prefs[c.key] ? "checked" : ""}>
        </label>`).join("")}
    </div>
    <div style="margin-top:12px"><button class="btn ghost small" id="pushTest" ${on ? "" : "disabled"}>Send a test notification</button></div>
  `;

  wrap.querySelector("#pushMaster").addEventListener("change", async (e) => {
    const want = e.target.checked;
    e.target.disabled = true;
    try {
      if (want) { await enablePushNotifications(); showToast("Notifications on", "create"); }
      else { await disablePushNotifications(); showToast("Notifications off", "update"); }
    } catch (err) {
      showToast(err.message || "Couldn't change that", "delete");
    }
    renderConnectionSection();
  });
  wrap.querySelectorAll("[data-push-cat]").forEach(cb => cb.addEventListener("change", async () => {
    const prefs = getPushPrefs();
    prefs[cb.dataset.pushCat] = cb.checked;
    setPushPrefs(prefs);
    // Every category off means nothing would ever be delivered -- drop the
    // subscription rather than keep a live channel that stays silent.
    if (PUSH_CATEGORIES.every(c => !prefs[c.key])) {
      await disablePushNotifications();
      showToast("All categories off -- notifications disabled", "update");
      renderConnectionSection();
      return;
    }
    try { await syncPushPrefs(); showToast("Saved", "update"); }
    catch (_) { showToast("Couldn't save -- offline?", "delete"); }
  }));
  const testBtn = wrap.querySelector("#pushTest");
  if (testBtn) testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    try {
      const r = await apiPost("/api/push/test", {});
      showToast(r.sent ? `Sent to ${r.sent} device(s)` : "Nothing sent -- check the server log", r.sent ? "create" : "delete");
    } catch (_) { showToast("Couldn't send test", "delete"); }
    testBtn.disabled = false;
  });
}

const LOCAL_FIRST_RESOURCES = ["eggs", "expenses", "supplies", "bedding", "notes", "bird_logs", "birds", "coops", "hatches", "hatch_eggs", "bird_photos", "activity_log", "supply_products"];
/** Relative time like "3m ago" / "2h ago", falling back to a plain date once
 * it's more than a day old -- precise-enough-to-verify-syncing without
 * needing a raw timestamp. */
function relativeTime(iso) {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return fmtDate(iso.slice(0, 10));
}

/** Like relativeTime, but never falls back to a plain date -- keeps counting
 * in days/weeks/months/years. Used where the exact timestamp is already
 * shown alongside it (the activity log), so a second date would be noise. */
function relativeTimeLong(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

async function refreshSyncStatus() {
  const statusEl = document.getElementById("syncStatus");
  if (!statusEl) return;
  const pending = await countPendingChanges();
  const perResource = currentCoopId
    ? await Promise.all(LOCAL_FIRST_RESOURCES.map(async r => ({ resource: r, lastSync: await getLastSync(r, r === "coops" ? null : currentCoopId) })))
    : [];
  const successTimes = perResource.map(x => x.lastSync).filter(Boolean);
  const oldestSuccess = successTimes.length ? successTimes.sort()[0] : null; // earliest of all of them -- the more conservative, honest answer
  const rejected = await getRejectedChanges();
  statusEl.innerHTML = `
    ${rejected.length ? `
      <div class="rejected-changes" style="border:1px solid var(--rust);border-radius:8px;padding:10px;margin-bottom:10px">
        <strong style="color:var(--rust)">${rejected.length} change${rejected.length !== 1 ? "s were" : " was"} refused by the server and not saved</strong>
        <ul style="margin:6px 0 8px 18px;padding:0;font-size:11px">${rejected.slice(-5).map(r => `<li>${esc(describeRejectedChange(r))} -- ${relativeTime(r.at)}</li>`).join("")}</ul>
        <button class="btn ghost small" id="dismissRejectedBtn">Dismiss</button>
      </div>` : ""}
    <div>${pending ? `<strong style="color:var(--gold)">${pending} change${pending !== 1 ? "s" : ""} waiting to sync</strong>` : `<span style="color:var(--sage)">Up to date</span>`}</div>
    <div style="margin-top:4px">Last sync attempt: ${relativeTime(getLastSyncAttempt())}</div>
    <div>Last successful server sync: ${relativeTime(oldestSuccess)}</div>
    <details style="margin-top:6px"><summary style="cursor:pointer">Per-resource detail</summary>
      <div style="margin-top:4px;font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.7">
        ${perResource.map(x => `${x.resource}: ${relativeTime(x.lastSync)}`).join("<br>")}
      </div>
    </details>
  `;
  const dismiss = document.getElementById("dismissRejectedBtn");
  if (dismiss) dismiss.addEventListener("click", async () => { await clearRejectedChanges(); refreshSyncStatus(); });
}

/** Lightweight, DOM-only update from whatever's currently known (no network
 * call) -- safe to call often, e.g. on every SSE status change. */
function updateServerConnectionStatusUi() {
  const versionEl = document.getElementById("serverVersionLine");
  const liveEl = document.getElementById("liveUpdatesLine");
  if (versionEl) {
    versionEl.innerHTML = lastKnownServerVersion
      ? (serverVersionMismatch
          ? `⚠️ <span style="color:var(--rust)">Sync server version: ${esc(lastKnownServerVersion)} (outdated -- this app is running ${esc(APP_VERSION)}. Restart the sync server.)</span>`
          : `Sync server version: ${esc(lastKnownServerVersion)} <span style="color:var(--sage)">✓ up to date</span>`)
      : `Sync server version: unknown (unreachable)`;
  }
  if (liveEl) {
    const sseLabel = { off: `<span style="color:var(--text-dim)">off</span>`, connecting: `<span style="color:var(--gold)">connecting...</span>`, connected: `<span style="color:var(--sage)">● connected</span>`, error: `<span style="color:var(--rust)">reconnecting...</span>`, unsupported: `<span style="color:var(--text-dim)">not supported by this browser</span>` }[sseStatus] || sseStatus;
    liveEl.innerHTML = `Live updates: ${sseLabel}`;
  }
}
/** Re-verifies with the server first, then updates the DOM -- called when
 * the settings page opens, so it shows current state rather than whatever
 * the last background timer tick (up to 30 seconds ago) happened to see. */
async function refreshServerConnectionStatus() {
  if (!document.getElementById("serverVersionLine") && !document.getElementById("liveUpdatesLine")) return;
  await checkConnection();
  updateServerConnectionStatusUi();
}

function getCoopDefaults() {
  const s = getCoopSettings();
  return { eggPrice: s.default_egg_price != null ? s.default_egg_price : "", pricePerLb: s.default_price_per_lb != null ? s.default_price_per_lb : "" };
}

function renderAppSection() {
  const el = document.getElementById("settingsContent");
  const d = currentCoopId ? getCoopDefaults() : null;
  const weightUnit = currentCoopId ? getWeightUnit() : null;
  const mutedCats = currentCoopId ? getMutedAlertCategories() : [];
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div class="dim" style="font-size:11px;font-family:'JetBrains Mono',monospace">App version: ${esc(APP_VERSION)}</div>
      <button class="btn ghost small" id="checkUpdateBtn">Check for updates</button>
    </div>

    <div class="card">
      <div class="card-title">App installation</div>
      ${isRunningAsInstalledPwa()
        ? `<div class="dim" style="font-size:12px">✓ Running as an installed app -- its own window, icon, and full offline access.</div>`
        : deferredInstallPrompt
          ? `<div class="dim" style="font-size:12px;margin-bottom:10px">Install this for its own icon and window, and full offline access after your first visit.</div>
             <button class="btn btn-confirm" id="manualInstallBtn">⬇ Install app</button>`
          : `<div class="dim" style="font-size:12px">Not currently installed. If your browser supports it, look for an install icon in the address bar, or an "Install app" / "Add to Home Screen" option in its menu.</div>`
      }
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">📸 Photo quality</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">How big new photos get saved at -- applies to birds, their timeline history, and supply products alike, going forward only (nothing already saved changes). Per-device, not synced, so a phone and a desktop can each use whatever tier makes sense for them.</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${Object.entries(PHOTO_QUALITY_TIERS).map(([key, tier]) => `
          <label class="field" style="display:flex;flex-direction:row;align-items:flex-start;gap:10px;cursor:pointer;margin:0">
            <input type="radio" name="photoQualityTier" value="${key}" ${getPhotoQualityTier() === key ? "checked" : ""} style="width:auto;margin-top:3px">
            <span><strong style="color:var(--text)">${tier.label}</strong> <span class="dim" style="font-size:11px">(~${tier.maxDim}px)</span><br><span class="dim" style="font-size:11px">${tier.hint}</span></span>
          </label>
        `).join("")}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">🔔 Backup reminder</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">How long the app waits before reminding you to export a backup. Per-device. ${localOnlyMode ? "You're running local-only, so this data exists on this device and nowhere else -- the reminder is the only thing standing between a lost phone and a lost flock record." : "You're synced to a server, which already keeps its own backups, so this is just an extra prompt to keep a copy of your own."}</div>
      <label class="field" style="display:flex;flex-direction:row;align-items:center;gap:10px;cursor:pointer;margin:0 0 12px">
        <input type="checkbox" id="backupReminderEnabled" ${getBackupReminderEnabled() ? "checked" : ""} style="width:auto">
        <span style="color:var(--text)">Remind me to back up</span>
      </label>
      <label class="field" id="backupReminderDaysField" style="${getBackupReminderEnabled() ? "" : "opacity:0.45;pointer-events:none"}">
        <span>Remind me after this many days without a backup</span>
        <select id="backupReminderDays">
          ${[3, 7, 14, 30, 60, 90].map(d => `<option value="${d}" ${getBackupReminderDays() === d ? "selected" : ""}>${d} days${d === 14 ? " (default)" : ""}</option>`).join("")}
        </select>
      </label>
      <div class="dim" style="font-size:11px;margin-top:8px">Last backup: ${lastBackupLabel()}</div>
    </div>

    ${SYNC_FOLDER_SUPPORTED ? `
    <div class="card" style="margin-top:16px" id="syncFolderCard">
      <div class="card-title">Local backup -- synced folder</div>
      <div class="dim" style="font-size:12px;margin-bottom:10px" id="syncFolderStatus">Checking...</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Point this at a folder that Dropbox, Google Drive, OneDrive, or anything similar already watches on this device, and a backup can be saved straight into it -- no account or setup with any specific provider needed here, since whatever syncs that folder handles getting it off this device on its own.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap" id="syncFolderButtons"></div>
    </div>
    ` : `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Local backup -- synced folder</div>
      <div class="dim" style="font-size:12px">Not available in this browser -- this needs a Chromium-based desktop browser (Chrome or Edge on Windows, Mac, Linux, or ChromeOS). It isn't available on Android in any browser, including this app if installed there, since Android has no matching system file picker for it. Exporting a backup manually and saving it into a synced folder yourself works everywhere as an alternative.</div>
    </div>
    `}

    ${currentCoopId ? `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Units</div>
      <div class="dim" style="font-size:12px;margin-bottom:14px">Applies to bird weights throughout the app. Existing weights aren't changed or converted in storage -- only how they're shown and entered.</div>
      <div style="display:flex;gap:8px">
        <button class="btn ${weightUnit === "lb" ? "btn-confirm" : "ghost"}" id="unitLbBtn">lb</button>
        <button class="btn ${weightUnit === "kg" ? "btn-confirm" : "ghost"}" id="unitKgBtn">kg</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">Default values</div>
      <div class="dim" style="font-size:12px;margin-bottom:14px">Auto-filled into new egg and bird entries so you don't have to re-type them each time. Leave blank for no default. Editing an existing entry never overwrites its own saved value.</div>
      <div class="grid-form">
        <label class="field"><span>Default value per egg ($)</span><input type="number" step="0.01" id="def_egg_price" placeholder="e.g. 0.50" value="${d.eggPrice}"></label>
        <label class="field"><span>Default value per lb ($)</span><input type="number" step="0.01" id="def_price_lb" placeholder="e.g. 5.00" value="${d.pricePerLb}"></label>
      </div>
      <div style="margin-top:14px"><button class="btn btn-confirm" id="saveDefaults">✓ Save defaults</button></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">🔔 Supply alerts</div>
      <div class="dim" style="font-size:12px;margin-bottom:14px">The "Running low" alert on the overview, per category. Turn one off if you don't want to be reminded right now -- e.g. Meat Feed while there's no active meat batch -- and turn it back on any time.</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${["Layer Feed", "Meat Feed", "Bedding"].map(cat => `
        <label class="switch-row"><span>${cat}</span><input type="checkbox" class="alert-cat-toggle" data-cat="${esc(cat)}" ${mutedCats.includes(cat) ? "" : "checked"}></label>
        `).join("")}
      </div>
      ${mutedCats.length > 0 ? `<button class="btn ghost small" id="resetAllMutedAlerts" style="margin-top:12px">Reset all -- clear every muted category</button>` : ""}
    </div>
    ` : `<div class="card" style="margin-top:16px"><div class="dim" style="font-size:12px">Units and default values are per-coop -- pick or create a coop to set them.</div></div>`}

    <div class="card" style="margin-top:16px;border-color:rgba(184,76,62,0.4)">
      <div class="card-title">⚠️ Clear local data</div>
      <div class="dim" style="font-size:12px;margin-bottom:14px">
        Wipes everything cached on this device -- every coop, bird, egg entry, all of it -- and starts fresh. Mainly useful if switching servers has left old, unrelated coops sitting in this device's local cache.
        ${localOnlyMode
          ? " You're in local-only mode, so this is permanent -- there's no server copy to fall back on. Export a backup first if there's anything here you'd want to keep."
          : " If you're synced with a server, this is generally safe -- everything gets re-downloaded from there once reconnected. But anything saved on this device that hasn't synced yet (e.g. while offline) will be lost for good."}
      </div>
      <button class="btn btn-close" id="clearLocalDataBtn">🗑 Clear local data and start fresh</button>
    </div>
  `;
  const checkUpdateBtn = document.getElementById("checkUpdateBtn");
  if (checkUpdateBtn) checkUpdateBtn.addEventListener("click", () => checkForAppUpdate({ manual: true }));
  const manualInstallBtn = document.getElementById("manualInstallBtn");
  if (manualInstallBtn) manualInstallBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    renderAppSection();
  });
  document.querySelectorAll('input[name="photoQualityTier"]').forEach(radio => radio.addEventListener("change", (e) => {
    setPhotoQualityTier(e.target.value);
    showToast(`Photo quality set to ${PHOTO_QUALITY_TIERS[e.target.value].label} -- applies to new photos from here on`, "update");
  }));
  document.getElementById("backupReminderEnabled").addEventListener("change", (e) => {
    setBackupReminderEnabled(e.target.checked);
    renderAppSection();       // re-render so the days field enables/disables with it
    renderLocalOnlyBadge();   // the corner tag's overdue state depends on this
  });
  document.getElementById("backupReminderDays").addEventListener("change", (e) => {
    setBackupReminderDays(Number(e.target.value));
    showToast(`Backup reminder set to ${e.target.value} days`, "update");
    renderLocalOnlyBadge();
  });
  if (SYNC_FOLDER_SUPPORTED) refreshSyncFolderUi();
  document.getElementById("clearLocalDataBtn").addEventListener("click", async () => {
    const confirmed = await showTypeToConfirmDialog(
      localOnlyMode
        ? "This permanently deletes everything cached on this device -- every coop, bird, and log entry -- with no server copy to restore from. Export a backup first if you want to keep any of it."
        : "This deletes everything cached on this device. Anything already synced re-downloads from the server automatically, but anything saved here that hasn't synced yet (e.g. while offline) is lost for good.",
      "CLEAR",
      "Clear local data"
    );
    if (!confirmed) return;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(LOCAL_DB_NAME);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
      req.onblocked = resolve; // another tab has it open -- still proceeds, just may need a manual refresh there too
    });
    localStorage.removeItem(COOP_KEY);
    location.reload();
  });
  if (!currentCoopId) return; // the per-coop handlers below have nothing to attach to
  el.querySelectorAll(".alert-cat-toggle").forEach(cb => cb.addEventListener("change", async () => {
    const settings = getCoopSettings();
    const muted = new Set(getMutedAlertCategories());
    if (cb.checked) muted.delete(cb.dataset.cat); else muted.add(cb.dataset.cat);
    settings.muted_alert_categories = [...muted];
    await localCoopUpdate(currentCoopId, { settings: JSON.stringify(settings) });
    await loadCoops();
    showToast(`${cb.dataset.cat} alerts ${cb.checked ? "turned on" : "muted"}`, "update");
    renderAppSection();
  }));
  const resetMutedBtn = document.getElementById("resetAllMutedAlerts");
  if (resetMutedBtn) resetMutedBtn.addEventListener("click", async () => {
    const settings = getCoopSettings();
    settings.muted_alert_categories = [];
    await localCoopUpdate(currentCoopId, { settings: JSON.stringify(settings) });
    await loadCoops();
    showToast("All supply alerts reset", "update");
    renderAppSection();
  });
  document.getElementById("unitLbBtn").addEventListener("click", async () => {
    const settings = getCoopSettings();
    settings.weight_unit = "lb";
    await localCoopUpdate(currentCoopId, { settings: JSON.stringify(settings) });
    await loadCoops();
    renderAppSection();
  });
  document.getElementById("unitKgBtn").addEventListener("click", async () => {
    const settings = getCoopSettings();
    settings.weight_unit = "kg";
    await localCoopUpdate(currentCoopId, { settings: JSON.stringify(settings) });
    await loadCoops();
    renderAppSection();
  });
  document.getElementById("saveDefaults").addEventListener("click", async () => {
    const settings = getCoopSettings();
    const eggPrice = document.getElementById("def_egg_price").value;
    const priceLb = document.getElementById("def_price_lb").value;
    settings.default_egg_price = eggPrice === "" ? null : Number(eggPrice);
    settings.default_price_per_lb = priceLb === "" ? null : Number(priceLb);
    await localCoopUpdate(currentCoopId, { settings: JSON.stringify(settings) });
    showToast("Defaults saved", "update");
    await loadCoops();
    renderAppSection();
  });
}

/** "$X collected + $Y sold" when a real sale has washed out part of the
 * estimate, otherwise just the plain collected value -- so the breakdown
 * only shows up when there's actually something to explain, rather than
 * cluttering every card for someone who's never logged a sale. */
function meatProcessedValue(count, weight, value) {
  if (count === 0) return "No birds processed";
  if (weight > 0) return `${displayWeight(weight)} ${getWeightUnit()} · ${fmtMoney(value)}`;
  return `${count} bird${count !== 1 ? "s" : ""}`;
}

function renderAllTimeStatsSection() {
  const el = document.getElementById("coopSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const s = computeStats();
  const coop = STATE.coops.find(c => c.id === currentCoopId);
  const totalBirdsAdded = STATE.birds.length;
  // Regardless of current status -- every layer-type and meat-type bird ever
  // recorded, not just the ones still active. The active/right-now breakdown
  // already lives on the Overview tab; this is the all-time counterpart.
  const layersAllTime = STATE.birds.filter(b => b.type === "Layer" || b.type === "Dual Purpose").length;
  const meatAllTime = STATE.birds.filter(b => b.type === "Meat").length;
  const catTotals = {};
  STATE.expenses.filter(x => x.entry_type !== "income").forEach(x => { catTotals[x.category] = (catTotals[x.category] || 0) + (Number(x.amount) || 0); });
  const usage = feedBeddingUsageInRange(STATE.supplies, null);
  const ty = yearlyTrends(); // one bucket per calendar year with data
  el.innerHTML = `
    <div class="toolbar">
      <div class="card-title" style="margin:0">All-time totals — ${esc(coop ? coop.name : "")}</div>
    </div>
    <div class="grid-stats-2">
      ${statPanel("sage", "🪶", "Flock",
        statPanelHero("Total Birds Added, All Time", totalBirdsAdded)
        + statPanelRows(
          statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} Layers, all time`, layersAllTime)
          + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} Meat birds, all time`, meatAllTime)
          + statPanelRow("Processed, all time", s.processed)
          + statPanelRow("Losses, all time", s.lossesAll, s.lossesAll > 0 ? "rust" : "")
        )
        + statPanelSubhead("🌾 Feed & Bedding")
        + statPanelRows(
          statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} Layer feed used`, `${displayWeight(usage.layerFeedLbs)} ${getWeightUnit()}`)
          + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} Meat feed used`, `${displayWeight(usage.meatFeedLbs)} ${getWeightUnit()}`)
          + statPanelRow("Bedding used", `${usage.beddingCuFt.toFixed(1)} cu ft`)
        )
        + statPanelSubhead("🐣 Hatching, All Time")
        + statPanelRows(
          statPanelRow("Chicks hatched", s.chicksHatchedAll)
          + statPanelRow("Lost from hatching", s.hatchLossAll, s.hatchLossAll > 0 ? "rust" : "")
          + statPanelRow("Clear · Quit · Failed", `${s.hatchClearAll} · ${s.hatchQuitAll} · ${s.hatchFailedAll}`)
        ), "flock"
      )}
      ${statPanel("gold", "💲", "Value",
        statPanelHero("Value Produced, All Time", fmtMoney(s.incomeAll))
        + statPanelRows(
          statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} Eggs collected`, s.totalEggs)
          + statPanelRow("Income from eggs", fmtMoney(s.eggTotalValueAll))
          + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} Meat processed`, s.totalWeight > 0 ? `${displayWeight(s.totalWeight)} ${getWeightUnit()}` : "—")
          + statPanelRow("Income from meat", fmtMoney(s.meatTotalValueAll))
          + statPanelRow("Avg weight / bird", s.processed > 0 ? weightLabel(s.totalWeight / s.processed) : "—")
        )
        + statPanelSubhead("💵 Finances")
        + statPanelHeroPair(
          statPanelHero("Spent", fmtMoney(s.totalExpenses)),
          statPanelHero("Net", fmtMoney(s.netAll), { valueTone: s.netAll >= 0 ? "sage" : "rust" })
        ), "expenses"
      )}
    </div>
    ${(() => {
      // Consumption-based feed cost: layer feed (+ supplements) eaten -> per
      // dozen eggs, meat feed eaten -> per lb of meat, each valued at what the
      // bags actually cost. A year or all-time is the honest window for these
      // (a single month misleads, especially for meat).
      const dozenBreakdown = costPerDozenBreakdown(s.totalEggs, () => true);
      const meatBreakdown = costPerLbMeatBreakdown(s.totalWeight, () => true);
      const cards = feedCostHeadlineHtml(dozenBreakdown, meatBreakdown, "all time");
      if (!cards) return "";
      return `<div style="margin-top:16px">${cards}
        <div class="dim" style="font-size:11px;margin-top:8px">Based on feed actually consumed, valued at each bag's cost.</div>
      </div>`;
    })()}
    ${(Object.keys(catTotals).length > 0 || s.totalEggs > 0 || s.totalWeight > 0) ? `<div class="grid-2" style="margin-top:16px">
      ${spendCategoryBarsHtml(catTotals, { title: "Spending by category, all time", totalLabel: "Total spent, all time" })}
      ${valueSourceBarsHtml(valueBreakdownIn(() => true), { title: "Value by source, all time", totalLabel: "Total value, all time" })}
    </div>` : ""}
  `;
  wireStatPanelGoto(el);
  wireCostBreakdownCards(el);
}

function renderProductsSection() {
  const el = document.getElementById("supplySubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const categoryOrder = ["Layer Feed", "Meat Feed", "Treats", "Bedding"];
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:4px">Saved Products</div>
    <div class="dim" style="font-size:12px;margin-bottom:14px">Every product you've photographed or named, grouped the same way the Inventory tab is. Add new ones here, or from the picker when you're actually logging a bag -- either way this is the page for renaming, updating the usual quantity/description, or cleaning up ones you don't need anymore.</div>
    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${STATE.supplyProducts.length} saved product${STATE.supplyProducts.length !== 1 ? "s" : ""}</div>
      ${selectModeButtonHtml("products", "toggleProductSelectMode")}
    </div>
    ${bulkDeleteBarHtml(selectedProductIds)}
    ${categoryOrder.map(cat => {
      const catTone = supplyCategoryTone(cat);
      const products = STATE.supplyProducts.filter(p => p.category === cat).sort((a, b) => (a.brand || "").localeCompare(b.brand || ""));
      const groups = {};
      products.forEach(p => { const key = p.brand || cat; (groups[key] = groups[key] || []).push(p); });
      const brandGroups = Object.entries(groups).map(([brand, items]) => ({ brand, items }));
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:18px;border-bottom:2px solid var(--${catTone});padding-bottom:4px">
          <div class="flock-section-header" style="color:var(--${catTone});margin:0;border:none;padding:0">${esc(cat)}${products.length ? ` (${products.length})` : ""}</div>
          <button class="btn ghost small" data-add-product-cat="${esc(cat)}" style="flex:0 0 auto">+ Add Product</button>
        </div>
        ${products.length === 0 ? `<div class="dim" style="font-size:12px;margin:8px 0">No saved products in this category yet.</div>` : `
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:10px">
          ${brandGroups.map(({ brand, items }) => `
            <div class="product-brand-group" style="width:100%;box-sizing:border-box">
              <div class="product-brand-group-label">${esc(brand)}${items.length > 1 ? ` (${items.length})` : ""}</div>
              <div class="list-stack">
                ${items.map(p => {
                  const inStock = STATE.supplies.filter(s => s.product_id === p.id && s.status !== "Empty").length;
                  const used = STATE.supplies.filter(s => s.product_id === p.id && s.status === "Empty").length;
                  return `
                  <div class="list-card${selectedProductIds.has(p.id) ? " card-selected" : ""}" data-edit-product="${p.id}" data-id="${p.id}" style="border-left:4px solid var(--${catTone});cursor:pointer">
                    ${selectionState.products.mode ? `<input type="checkbox" class="list-card-check product-check" data-id="${p.id}" ${selectedProductIds.has(p.id) ? "checked" : ""} onclick="event.stopPropagation()">` : ""}
                    ${productPhotoUrl(p) ? `<div class="thumb-clickable" data-view-photo="${esc(productPhotoUrl(p))}" data-product-id="${p.id}" style="width:48px;height:48px;border-radius:6px;overflow:hidden;flex:0 0 auto;cursor:zoom-in"><img src="${productPhotoUrl(p)}" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(p)};${photoTransformStyle(p)}"></div>` : `<div style="width:48px;height:48px;border-radius:6px;flex:0 0 auto;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;font-size:20px">📦</div>`}
                    <div class="list-card-main">
                      <div style="font-weight:700">${esc(p.brand || cat)}</div>
                      <div class="list-card-desc dim">${p.default_quantity != null ? `usually ${displayQty(p.default_quantity, p.default_unit)} ${esc(unitLabel(p.default_unit))}` : "no usual quantity set"}${p.default_description ? ` · "${esc(p.default_description)}"` : ""}</div>
                      ${(inStock > 0 || used > 0) ? `<div class="list-card-desc dim">${inStock > 0 ? `${inStock} in stock` : ""}${inStock > 0 && used > 0 ? " · " : ""}${used > 0 ? `${used} used up` : ""}</div>` : ""}
                    </div>
                  </div>
                `;}).join("")}
              </div>
            </div>
          `).join("")}
        </div>
        `}
      `;
    }).join("")}
  `;
  el.querySelectorAll("[data-view-photo]").forEach(el2 => el2.addEventListener("click", (e) => {
    e.stopPropagation();
    const product = STATE.supplyProducts.find(p => p.id === el2.dataset.productId);
    showPhotoLightbox(el2.dataset.viewPhoto, {
      x: product.photo_pos_x ?? 50, y: product.photo_pos_y ?? 50, aspectRatio: "1/1",
      onSave: async (x, y) => { await localSupplyProductUpdate(product.id, { photo_pos_x: x, photo_pos_y: y }); renderProductsSection(); },
    });
  }));
  el.querySelectorAll("[data-add-product-cat]").forEach(btn => btn.addEventListener("click", () => openProductModal(null, btn.dataset.addProductCat)));
  el.querySelectorAll(".product-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedProductIds.add(cb.dataset.id); else selectedProductIds.delete(cb.dataset.id);
    renderProductsSection();
  }));
  wireCardSelection(
    el.querySelectorAll("[data-edit-product]"),
    selectedProductIds,
    "products",
    () => [...el.querySelectorAll("[data-edit-product]")].map(c => c.dataset.id),
    (id) => { const product = STATE.supplyProducts.find(p => p.id === id); openProductModal(product, product.category); },
    renderProductsSection
  );
  document.getElementById("toggleProductSelectMode").addEventListener("click", () => {
    selectionState.products.mode = !selectionState.products.mode;
    if (!selectionState.products.mode) selectedProductIds.clear();
    renderProductsSection();
  });
  wireBulkDeleteBar(selectedProductIds, "supply_products", "product", async () => { STATE.supplyProducts = await localGetAll("supply_products", currentCoopId); }, renderProductsSection);
}

/** Single entry point for the standalone Products page's add/edit, mirroring
 * openSupplyModal's shape. This is deliberately separate from the embedded
 * picker's own inline "+New" flow inside the supply form -- that one stays
 * as an inline expansion within the supply modal rather than stacking a
 * second modal on top of it, since layering modals is generally confusing
 * to navigate on mobile. They share the same underlying form markup
 * (renderProductEditFormHtml) and save logic, just triggered differently. */
function openProductModal(editingProduct, category) {
  editingProductId = editingProduct ? editingProduct.id : null;
  newProductFormOpen = !editingProduct;
  newProductCategory = category;
  openModal(
    renderProductEditFormHtml(editingProduct, category, true),
    () => { editingProductId = null; newProductFormOpen = false; newProductCategory = null; },
    editingProduct ? () => confirmAndDelete(
      "Remove this saved product? Any bags already using its photo will lose it too, not just future ones -- this can't be undone.",
      () => localSupplyProductDelete(editingProduct.id, currentCoopId),
      "Product removed",
      async () => { STATE.supplyProducts = await localGetAll("supply_products", currentCoopId); renderProductsSection(); }
    ) : null
  );
  const refreshProductModal = () => { refreshModalContent(renderProductEditFormHtml(editingProduct, category, true)); wireProductModalPhoto(); };
  function captureUnsavedProductFields() {
    return {
      brand: document.getElementById("np_brand")?.value,
      default_description: document.getElementById("np_desc")?.value,
      default_quantity: document.getElementById("np_qty")?.value,
      default_unit: document.getElementById("np_unit")?.value,
    };
  }
  function syncProductEverywhere() {
    const idx = STATE.supplyProducts.findIndex(p => p.id === editingProduct.id);
    if (idx !== -1) STATE.supplyProducts[idx] = editingProduct; else STATE.supplyProducts.push(editingProduct);
    if (document.getElementById("supplySubContent")) renderProductsSection(); // refreshes the card behind this modal; if Supply Inventory isn't the active sub-tab right now it'll just read the updated STATE.supplyProducts whenever it's next shown, no reload needed
  }
  function wireProductModalPhoto() {
    const preview = document.getElementById("productPhotoPreview");
    if (preview) preview.addEventListener("click", (e) => {
      const url = e.target.dataset ? e.target.dataset.viewPhoto : null;
      if (!url) return;
      const unsaved = captureUnsavedProductFields();
      showPhotoLightbox(url, {
        x: editingProduct.photo_pos_x ?? 50, y: editingProduct.photo_pos_y ?? 50, zoom: photoZoom(editingProduct), aspectRatio: "1/1",
        onSave: async (x, y, zoom) => {
          editingProduct = { ...(await localSupplyProductUpdate(editingProduct.id, { photo_pos_x: x, photo_pos_y: y, photo_zoom: zoom })), ...unsaved };
          syncProductEverywhere();
          refreshProductModal();
        },
      });
    });
    const repositionBtn = document.getElementById("repositionProductPhoto");
    if (repositionBtn) repositionBtn.addEventListener("click", () => {
      const unsaved = captureUnsavedProductFields();
      openPhotoRepositionModal(productPhotoUrl(editingProduct), editingProduct.photo_pos_x ?? 50, editingProduct.photo_pos_y ?? 50, photoZoom(editingProduct), "1/1", async (x, y, zoom) => {
        editingProduct = { ...(await localSupplyProductUpdate(editingProduct.id, { photo_pos_x: x, photo_pos_y: y, photo_zoom: zoom })), ...unsaved };
        syncProductEverywhere();
        refreshProductModal();
      });
    });
  }
  wireProductModalPhoto();
  const saveBtn = document.getElementById("saveNewProduct");
  saveBtn.addEventListener("click", async () => {
    const brand = document.getElementById("np_brand").value.trim();
    if (!brand) { alert("Give the product a name first"); return; }
    const qtyVal = document.getElementById("np_qty").value;
    const unitVal = document.getElementById("np_unit").value;
    const descVal = document.getElementById("np_desc").value;
    let productId;
    if (editingProduct) {
      await localSupplyProductUpdate(editingProduct.id, {
        brand, default_quantity: parseQtyInput(qtyVal, unitVal), default_unit: unitVal || null, default_description: descVal || null,
      });
      productId = editingProduct.id;
    } else {
      const created = await localSupplyProductCreate({
        coop_id: currentCoopId, category, brand, last_used_at: todayStr(),
        default_quantity: parseQtyInput(qtyVal, unitVal), default_unit: unitVal || null, default_description: descVal || null,
      });
      productId = created.id;
    }
    const photoFile = document.getElementById("np_photo").files[0];
    if (photoFile) {
      const blob = await resizeImageFileToBlob(photoFile);
      await queuePendingProductPhoto(productId, blob);
      trySyncSoon("supply_products", currentCoopId);
      await refreshPendingProductPhotoUrls();
    }
    STATE.supplyProducts = await localGetAll("supply_products", currentCoopId);
    showToast(editingProduct ? "Product updated" : "Product added", editingProduct ? "update" : "create");
    closeModal();
    renderProductsSection();
  });
}

function beddingThresholdsFormHtml() {
  const coop = STATE.coops.find(c => c.id === currentCoopId);
  const settings = getCoopSettings();
  const areas = getBeddingAreas();
  const thresholds = settings.bedding_thresholds || {};
  return `
    <div class="form-head">Bedding tracking areas — ${esc(coop ? coop.name : "")}</div>
    <div class="dim" style="font-size:12px;margin-bottom:14px">
      Track as many physical areas as your setup actually has — e.g. split "Coop Floor" into separate Layer-side and Meat-side entries if you clean them on different schedules. Each area gets its own freshness badge on the Coop tab and Bedding tab, and its own warn/overdue thresholds below. Renaming an area here only affects new tracking; past log entries keep whatever area name they were logged under.
      These same areas are also what's available as a bird's Location on the Flock tab — add one here (e.g. a small second coop elsewhere in the yard) and it's immediately assignable to birds, without needing a whole separate coop just to track where they are.
    </div>
    ${areas.map((area, i) => {
      const t = thresholds[area] || { warn: 120, danger: 180, churn: 7 };
      return `
      <div class="form-block" style="padding:12px 14px;margin-bottom:10px">
        <div style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:end">
          <div style="display:flex;flex-direction:column;gap:2px;padding-bottom:8px">
            <button class="icon-btn" data-move-up="${i}" ${i === 0 ? "disabled" : ""} style="padding:0 6px;font-size:12px" title="Move up">▲</button>
            <button class="icon-btn" data-move-down="${i}" ${i === areas.length - 1 ? "disabled" : ""} style="padding:0 6px;font-size:12px" title="Move down">▼</button>
          </div>
          <label class="field"><span>Area name</span><input class="area-name" data-idx="${i}" value="${esc(area)}"></label>
          <button class="icon-btn" data-remove-area="${i}" title="Remove this area">🗑</button>
        </div>
        <div class="grid-form" style="grid-template-columns:1fr 1fr 1fr;margin-top:10px">
          <label class="field"><span>Top-off / churn every (days)</span><input type="number" min="1" class="threshold-churn" data-area="${esc(area)}" value="${t.churn || 7}"></label>
          <label class="field"><span>Warn after (days)</span><input type="number" min="1" class="threshold-warn" data-area="${esc(area)}" value="${t.warn}"></label>
          <label class="field"><span>Overdue after (days)</span><input type="number" min="1" class="threshold-danger" data-area="${esc(area)}" value="${t.danger}"></label>
        </div>
      </div>`;
    }).join("")}
    <button class="btn small" id="addAreaBtn">+ Add tracking area</button>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveSettings">✓ Save areas &amp; thresholds</button>
    </div>
  `;
}

function wireBeddingThresholdsModal() {
  const areas = getBeddingAreas();
  const thresholds = getCoopSettings().bedding_thresholds || {};
  const refresh = () => { refreshModalContent(beddingThresholdsFormHtml()); wireBeddingThresholdsModal(); };
  document.getElementById("addAreaBtn").addEventListener("click", () => {
    const name = prompt("Name this new area (e.g. \"Coop Floor — Meat Side\"):");
    if (!name || !name.trim()) return;
    if (areas.includes(name.trim())) { alert("An area with that name already exists."); return; }
    const newAreas = [...areas, name.trim()];
    saveAreaSettings(newAreas, { ...thresholds, [name.trim()]: { warn: 120, danger: 180, churn: 7 } });
  });
  document.querySelectorAll("[data-move-up]").forEach(b => b.addEventListener("click", () => {
    const i = Number(b.dataset.moveUp);
    if (i <= 0) return;
    const newAreas = [...areas];
    [newAreas[i - 1], newAreas[i]] = [newAreas[i], newAreas[i - 1]];
    saveAreaSettings(newAreas, thresholds);
  }));
  document.querySelectorAll("[data-move-down]").forEach(b => b.addEventListener("click", () => {
    const i = Number(b.dataset.moveDown);
    if (i >= areas.length - 1) return;
    const newAreas = [...areas];
    [newAreas[i], newAreas[i + 1]] = [newAreas[i + 1], newAreas[i]];
    saveAreaSettings(newAreas, thresholds);
  }));
  document.querySelectorAll("[data-remove-area]").forEach(b => b.addEventListener("click", () => {
    const idx = Number(b.dataset.removeArea);
    const removed = areas[idx];
    if (!confirm(`Stop tracking "${removed}"? Past log entries for it are kept, but it won't show a freshness badge anymore.`)) return;
    const newAreas = areas.filter((_, i) => i !== idx);
    saveAreaSettings(newAreas, thresholds);
  }));
  document.getElementById("saveSettings").addEventListener("click", async () => {
    const modalEl = document.getElementById("modalContent");
    const newAreas = [...modalEl.querySelectorAll(".area-name")].map(inp => inp.value.trim()).filter(Boolean);
    const newThresholds = {};
    newAreas.forEach((area, i) => {
      const originalArea = areas[i];
      const churnInput = modalEl.querySelector(`.threshold-churn[data-area="${originalArea}"]`);
      const warnInput = modalEl.querySelector(`.threshold-warn[data-area="${originalArea}"]`);
      const dangerInput = modalEl.querySelector(`.threshold-danger[data-area="${originalArea}"]`);
      newThresholds[area] = {
        churn: Number(churnInput ? churnInput.value : 7) || 7,
        warn: Number(warnInput ? warnInput.value : 120) || 120,
        danger: Number(dangerInput ? dangerInput.value : 180) || 180,
      };
    });
    // Same position, different name = a rename, not a different area --
    // update any bird currently assigned to the old name so its location
    // tag reflects the rename instead of silently going stale. Combined
    // into one undo action rather than one per bird, since renaming an
    // area is a single settings action regardless of how many birds it touches.
    const renamedBirdOps = [];
    areas.forEach((oldName, i) => {
      const newName = newAreas[i];
      if (newName && newName !== oldName) {
        STATE.birds.filter(b => b.location === oldName).forEach(b => renamedBirdOps.push(b));
      }
    });
    if (renamedBirdOps.length > 0) {
      const updated = await Promise.all(renamedBirdOps.map((b, i) => {
        const newName = newAreas[areas.indexOf(b.location)];
        return localBirdUpdate(b.id, { location: newName }, { suppressUndo: true });
      }));
      pushUndoAction(renamedBirdOps.length === 1 ? "Renamed a bedding area (1 bird reassigned)" : `Renamed a bedding area (${renamedBirdOps.length} birds reassigned)`, renamedBirdOps.map((b, i) => ({ resource: "birds", id: b.id, before: b, after: updated[i] })));
    }
    await saveAreaSettings(newAreas, newThresholds);
  });
}

function openBeddingThresholdsModal() {
  openModal(beddingThresholdsFormHtml());
  wireBeddingThresholdsModal();
}

async function saveAreaSettings(newAreas, newThresholds) {
  const settings = getCoopSettings();
  const newSettings = { ...settings, bedding_areas: newAreas, bedding_thresholds: newThresholds };
  await localCoopUpdate(currentCoopId, { settings: JSON.stringify(newSettings) });
  showToast("Bedding areas updated", "update");
  await loadCoops();
  closeModal();
  renderBeddingFreshness();
}

