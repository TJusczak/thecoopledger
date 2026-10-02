// Outbox push, incremental pull, background sync timer and the live-update (SSE) stream.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

async function localGetAll(store, coopId) {
  const db = await openLocalDb();
  const tx = db.transaction(store, "readonly");
  const os = tx.objectStore(store);
  const all = await idbRequest(coopId ? os.index("coop_id").getAll(coopId) : os.getAll());
  return all.filter(r => !r.deleted_at); // tombstones stay in IndexedDB (the outbox may still need them) but never render
}

async function localPutMany(store, records) {
  const db = await openLocalDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  records.forEach(r => os.put(r));
  await idbDone(tx);
}

async function localGetOne(store, id) {
  const db = await openLocalDb();
  const tx = db.transaction(store, "readonly");
  return idbRequest(tx.objectStore(store).get(id));
}

const USER_NAME_KEY = "coopLedgerUserName";
function getUserName() { return (localStorage.getItem(USER_NAME_KEY) || "").trim(); }
function setUserName(name) { localStorage.setItem(USER_NAME_KEY, (name || "").trim()); }

const RESOURCE_LABELS = {
  eggs: "an egg entry", expenses: "an expense", birds: "a bird", supplies: "a supply item",
  bedding: "a bedding entry", notes: "a note", bird_logs: "a health log entry", coops: "a coop",
  supply_products: "a saved product", bird_photos: "a timeline photo",
};
const RESOURCE_LABELS_PLURAL = { birds: "birds", supplies: "supply items", supply_products: "saved products", bird_photos: "timeline photos" };
const OP_VERBS = { create: "added", update: "updated", delete: "deleted" };

let _suppressActivityLogging = false;

/** Lightweight header indicator, unlike refreshSyncStatus (which only
 * updates anything when the settings/connection page happens to be open) --
 * this is meant to be visible from anywhere in the app, so someone doesn't
 * need to go digging in Settings to notice "oh, it's still pushing changes
 * out." Hidden entirely in local-only mode, since there's no server to
 * sync to. */
/** How many pending outbox items are worth showing the user, in both the
 * header indicator and the settings page's sync status. Deliberately
 * excludes activity_log: logActivity queues its own outbox entry for
 * nearly every real change, so counting it too would make one bird edit
 * read as "2 changes" -- a confusing implementation detail, not something
 * the person actually did. */
async function countPendingChanges() {
  const outbox = await getOutbox();
  const pendingPhotos = await getAllPendingPhotos();
  const pendingProductPhotos = await getAllPendingProductPhotos();
  const pendingBirdHistoryPhotos = await getAllPendingBirdHistoryPhotos();
  return outbox.filter(o => LOCAL_FIRST_RESOURCES.includes(o.resource) && o.resource !== "activity_log").length
    + pendingPhotos.length + pendingProductPhotos.length + pendingBirdHistoryPhotos.length;
}

async function updateSyncIndicator() {
  const el = document.getElementById("syncIndicator");
  if (!el) return;
  if (localOnlyMode || !currentCoopId) { el.style.display = "none"; return; }
  const pending = await countPendingChanges();
  if (pending > 0) {
    el.style.display = "flex";
    el.innerHTML = `<span class="sync-indicator-spin">↻</span> Syncing ${pending} change${pending !== 1 ? "s" : ""}...`;
  } else {
    el.style.display = "none";
  }
}

async function queueOutbox(entry) {
  if (isReadOnlyRole()) {
    showToast("Read-only access -- changes can't be saved", "delete");
    throw new Error("Blocked: read-only role cannot write");
  }
  const db = await openLocalDb();
  const tx = db.transaction("_outbox", "readwrite");
  tx.objectStore("_outbox").add({ ...entry, queuedAt: new Date().toISOString() });
  await idbDone(tx);
  // Every mutation flows through here, so this is the one place activity
  // logging needs to hook in -- not two dozen individual create/update/
  // delete functions. Guarded against logging the logging itself, and
  // against logging at all during a suppressed bulk operation (import),
  // since logActivity's own STATE.activityLog refresh re-reads the whole
  // (still-growing) table on every call -- fine for one record at a time,
  // but turns a loop of thousands into a freeze.
  if (entry.resource !== "activity_log" && !_suppressActivityLogging) await logActivity(entry.resource, entry.op, entry.payload);
  if (!_suppressActivityLogging) updateSyncIndicator();
}

/** Records "who did what" as its own local-first, syncing resource -- so
 * both devices end up with the same shared history, not just their own. */
async function logActivity(resource, op, payload) {
  const name = getUserName() || "Unnamed";
  if (!currentCoopId) return;
  const summary = buildActivitySummary(resource, op, payload);
  const record = { id: newLocalId(), coop_id: currentCoopId, resource, op, changed_by: name, summary, updated_at: new Date().toISOString(), deleted_at: null };
  await localPutMany("activity_log", [record]);
  await queueOutbox({ resource: "activity_log", op: "create", id: record.id, payload: record });
  trySyncSoon("activity_log", currentCoopId);
  STATE.activityLog = await localGetAll("activity_log", currentCoopId);
  if (activeTab === "settings" && settingsSubTab === "activity") renderActivityLogSection();
}

/** More specific than "added eggs" when the payload actually has something
 * worth naming -- a count, a bird's name, an amount. Deletes never get this
 * treatment since the payload is always null by the time something's gone,
 * nothing left to describe beyond the resource type. */
function buildActivitySummary(resource, op, payload) {
  if (op === "bulk-create" && Array.isArray(payload)) {
    const n = payload.length;
    return `added ${n} ${RESOURCE_LABELS_PLURAL[resource] || (RESOURCE_LABELS[resource] || resource) + "s"} at once`;
  }
  if (op === "bulk-delete" && Array.isArray(payload)) {
    const n = payload.length;
    return `deleted ${n} ${RESOURCE_LABELS_PLURAL[resource] || (RESOURCE_LABELS[resource] || resource) + "s"} at once`;
  }
  if (op === "bulk-update" && Array.isArray(payload)) {
    const n = payload.length;
    return `updated ${n} ${RESOURCE_LABELS_PLURAL[resource] || (RESOURCE_LABELS[resource] || resource) + "s"} at once`;
  }
  const verb = OP_VERBS[op] || op;
  if (payload && op !== "delete") {
    if (resource === "eggs" && payload.count != null) {
      const n = Number(payload.count) || 0;
      return `${verb} ${n} egg${n !== 1 ? "s" : ""}${payload.date ? ` (${fmtDate(payload.date)})` : ""}`;
    }
    if (resource === "birds" && payload.name) {
      const batchNote = payload.batch_name ? ` (${payload.batch_name})` : "";
      if (op === "update" && payload.status === "Processed") return `processed ${payload.name}${batchNote}`;
      if (op === "update" && payload.status === "Deceased") return `logged a loss: ${payload.name}${batchNote}`;
      return `${verb} ${payload.name}${batchNote}`;
    }
    if (resource === "expenses" && payload.amount != null) {
      const isIncome = payload.entry_type === "income";
      return `${isIncome ? "logged income" : "logged an expense"}: ${fmtMoney(Number(payload.amount) || 0)}${payload.category ? ` (${payload.category})` : ""}`;
    }
    if (resource === "supplies" && payload.category) {
      return `${verb} a supply item (${payload.category})`;
    }
    if (resource === "bedding" && payload.area) {
      return `${verb} a bedding entry (${payload.area})`;
    }
    if (resource === "hatches") {
      return `${verb} a hatching clutch${payload.breed ? ` (${payload.breed})` : ""}`;
    }
  }
  return `${verb} ${RESOURCE_LABELS[resource] || resource}`;
}

async function getOutbox() {
  const db = await openLocalDb();
  const tx = db.transaction("_outbox", "readonly");
  return idbRequest(tx.objectStore("_outbox").getAll());
}

async function clearOutboxEntry(outboxId) {
  const db = await openLocalDb();
  const tx = db.transaction("_outbox", "readwrite");
  tx.objectStore("_outbox").delete(outboxId);
  await idbDone(tx);
}

async function getLastSync(resource, coopId) {
  const db = await openLocalDb();
  const tx = db.transaction("_meta", "readonly");
  const rec = await idbRequest(tx.objectStore("_meta").get(`sync:${resource}:${coopId}`));
  return rec ? rec.value : "";
}

async function setLastSync(resource, coopId, timestamp) {
  const db = await openLocalDb();
  const tx = db.transaction("_meta", "readwrite");
  tx.objectStore("_meta").put({ key: `sync:${resource}:${coopId}`, value: timestamp });
  await idbDone(tx);
}

/** Pushes every queued local change to the server, oldest first. Stops at the
 * first failure (rather than skipping it) so a genuinely offline device just
 * quietly retries the same entries next time, in the original order. */
async function pushOutboxOnce() {
  const entries = await getOutbox();
  for (const entry of entries) {
    let res;
    try {
      if (entry.op === "create") {
        res = await fetch(apiUrl(`/api/${entry.resource}`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(entry.payload) });
      } else if (entry.op === "update") {
        res = await fetch(apiUrl(`/api/${entry.resource}/${entry.id}`), { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(entry.payload) });
      } else if (entry.op === "delete") {
        res = await fetch(apiUrl(`/api/${entry.resource}/${entry.id}`), { method: "DELETE", headers: authHeaders() });
      } else if (entry.op === "bulk-create") {
        // The whole batch in one request, not one request per record -- see
        // localBulkCreate for why this exists.
        res = await fetch(apiUrl(`/api/${entry.resource}/bulk-create`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ items: entry.payload }) });
      } else if (entry.op === "bulk-delete") {
        res = await fetch(apiUrl(`/api/${entry.resource}/bulk-delete-items`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ ids: entry.payload }) });
      } else if (entry.op === "bulk-update") {
        res = await fetch(apiUrl(`/api/${entry.resource}/bulk-update-items`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ updates: entry.payload.map(u => ({ id: u.id, fields: u.fields })) }) });
      }
    } catch (networkErr) {
      // Genuine network failure -- stop and retry the whole queue later. Also
      // hand the rest to Background Sync so it drains once the device is back
      // online even if the app has been closed by then.
      requestBackgroundOutboxSync();
      break;
    }
    const verdict = classifyOutboxResponse(entry, res.status);
    if (verdict === "done" || verdict === "drop") {
      await clearOutboxEntry(entry.outboxId);
      updateSyncIndicator();
      continue;
    }
    if (verdict === "auth") {
      // Unlike a 404/400, a 401 isn't ambiguous -- it means "you are not
      // logged in," full stop, not "maybe try again later." Silently
      // retrying forever would just grow the outbox indefinitely with zero
      // indication of why. Surface it and stop immediately.
      handleSyncAuthFailure();
      break;
    }
    if (verdict === "reject") {
      // A permanent rejection (a 400 on a malformed payload, a 413...).
      // Retrying the exact same request will never succeed, so it must leave
      // the queue or it would block every entry behind it forever -- but it
      // used to vanish with only a console message, so the user never knew
      // their change wasn't saved. Keep a record they can see.
      let detail = "";
      try { const body = await res.clone().json(); detail = typeof body.detail === "string" ? body.detail : ""; } catch (_) { /* non-JSON error body */ }
      await addRejectedChange(entry, res.status, detail);
      await clearOutboxEntry(entry.outboxId);
      updateSyncIndicator();
      showToast("A change couldn't be saved to the server -- see Settings → Connection for details", "delete");
      continue;
    }
    break; // "retry": 403/5xx -- possibly transient -- stop and try again later
  }
}
// Same concurrency problem as pushPendingPhotos, and a more serious one here:
// two parallel passes reading the outbox before either clears an entry could
// each push the same "create a bird" request, creating a duplicate record on
// the server. This is the one that actually matters most.
let _pushOutboxInFlight = null;
async function pushOutbox() {
  if (_pushOutboxInFlight) return _pushOutboxInFlight;
  _pushOutboxInFlight = pushOutboxOnce().finally(() => { _pushOutboxInFlight = null; });
  return _pushOutboxInFlight;
}

/** Pulls everything changed on the server since the last successful sync
 * (including tombstones for deleted rows) and merges it into IndexedDB.
 *
 * - Paged: a first sync of years of history arrives as a series of bounded requests, and the cursor
 *   is saved after each page, so an interrupted pull resumes instead of starting over.
 * - The server's `server_time` is the cursor (never this device's clock): it is read in the same
 *   snapshot as the rows, so nothing committed can ever land behind it.
 * - Rows are rebased over this device's unsent changes (see rebasePulledRows).
 * - If the server's cursor is older than ours, the server was restored from a backup: start over. */
async function pullChanges(resource, coopId) {
  let since = await getLastSync(resource, coopId);
  const received = [];
  let checkedForRestore = false;
  for (let page = 0; page < 500; page++) {
    const url = apiUrl(`/api/sync/${resource}?coop_id=${encodeURIComponent(coopId)}&since=${encodeURIComponent(since)}&limit=${SYNC_PAGE_SIZE}`);
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 401) { handleSyncAuthFailure(); throw new Error("not logged in"); }
    if (!res.ok) throw new Error(`sync pull failed for ${resource}`);
    const data = await res.json();
    if (!checkedForRestore) {
      checkedForRestore = true;
      if (cursorWentBackwards(since, data.server_time)) {
        console.warn(`Server clock for ${resource} is behind this device's cursor (${since} > ${data.server_time}) -- the server was likely restored from a backup. Doing a full re-sync.`);
        since = "";
        await setLastSync(resource, coopId, "");
        continue;
      }
    }
    if (data.rows.length) await localPutMany(resource, rebasePulledRows(resource, data.rows, await getOutbox()));
    received.push(...data.rows);
    await setLastSync(resource, coopId, data.server_time);
    if (!data.has_more) break; // an older server ignores `limit` and returns everything with no has_more
    since = data.server_time;
  }
  return received;
}

// ---- Changes the server permanently refused ----
// Kept in the same IndexedDB `_meta` store as the sync cursors. Small and capped: this is a "you
// should know" list, not a log.
const REJECTED_KEY = "rejected-changes";
async function getRejectedChanges() {
  const db = await openLocalDb();
  const rec = await idbRequest(db.transaction("_meta", "readonly").objectStore("_meta").get(REJECTED_KEY));
  return rec && Array.isArray(rec.value) ? rec.value : [];
}
async function _putRejectedChanges(list) {
  const db = await openLocalDb();
  const tx = db.transaction("_meta", "readwrite");
  tx.objectStore("_meta").put({ key: REJECTED_KEY, value: list });
  await idbDone(tx);
}
async function addRejectedChange(entry, status, detail) {
  const list = await getRejectedChanges();
  list.push({ resource: entry.resource, op: entry.op, id: entry.id || null, status, detail: detail || "", queuedAt: entry.queuedAt || null, at: new Date().toISOString(), payload: entry.payload ?? null });
  await _putRejectedChanges(list.slice(-MAX_REJECTED_KEPT));
}
async function clearRejectedChanges() { await _putRejectedChanges([]); }

/** Push-then-pull for one resource. Push first, so a local edit reaches the
 * server before the pull -- otherwise the pull could momentarily overwrite
 * your own pending change with the older server copy. */
const LAST_ATTEMPT_KEY = "coopLedgerLastSyncAttempt";
function markSyncAttempt() { localStorage.setItem(LAST_ATTEMPT_KEY, new Date().toISOString()); }
function getLastSyncAttempt() { return localStorage.getItem(LAST_ATTEMPT_KEY) || ""; }

const SYNC_INTERVAL_KEY = "coopLedgerSyncIntervalSec";
function getSyncIntervalSec() {
  const raw = localStorage.getItem(SYNC_INTERVAL_KEY);
  const v = raw === null ? 60 : Number(raw); // default: every 60 seconds
  return Number.isFinite(v) && v >= 0 ? v : 60;
}
function setSyncIntervalSec(sec) { localStorage.setItem(SYNC_INTERVAL_KEY, String(sec)); }

/** How big new photos get saved at -- applies to every photo type (a
 * bird's current photo, its timeline history, and product photos) since
 * they all funnel through the same resize step. Per-device, not synced,
 * since it's about this device's own storage/bandwidth tradeoff, not the
 * data itself -- someone could reasonably want "low" on a phone with
 * limited storage and "high" on a desktop. "medium" is an exact match for
 * what every photo was already saved at before this setting existed, so
 * leaving it alone changes nothing for anyone already using the app. */
const PHOTO_QUALITY_KEY = "coopLedgerPhotoQuality";
const PHOTO_QUALITY_TIERS = {
  low:    { maxDim: 480,  quality: 0.72, label: "Low",    hint: "Smallest files, fastest to sync -- fine for a quick visual reference." },
  medium: { maxDim: 700,  quality: 0.82, label: "Medium",  hint: "The default -- a solid balance of detail and file size." },
  high:   { maxDim: 1600, quality: 0.88, label: "High",   hint: "Noticeably sharper, especially when zoomed in -- meaningfully bigger files, slower to sync." },
};
function getPhotoQualityTier() {
  const raw = localStorage.getItem(PHOTO_QUALITY_KEY);
  return PHOTO_QUALITY_TIERS[raw] ? raw : "medium";
}
function setPhotoQualityTier(tier) {
  if (PHOTO_QUALITY_TIERS[tier]) localStorage.setItem(PHOTO_QUALITY_KEY, tier);
}

async function syncResource(resource, coopId) {
  if (localOnlyMode) return; // running local-only by choice -- never attempt to reach a server
  markSyncAttempt();
  await pushOutbox();
  await pushPendingPhotos();
  await pushPendingProductPhotos();
  await pushPendingBirdHistoryPhotos();
  return pullChanges(resource, coopId);
}

/** Syncs every local-first resource and, if anything actually changed,
 * refreshes STATE from IndexedDB and re-renders whatever's currently on
 * screen -- this is what lets someone else's edit show up without a manual
 * pull-to-refresh. Deliberately re-reads from IndexedDB directly here rather
 * than calling loadCoopData() (which would trigger a second, redundant round
 * of syncing on top of the one just done below). */
async function backgroundSyncTick() {
  if (localOnlyMode || !currentCoopId) return;
  if (document.visibilityState !== "visible") return; // don't burn battery/data while backgrounded
  let anyChanged = false;
  let newActivityRows = [];
  for (const r of LOCAL_FIRST_RESOURCES) {
    try {
      const rows = await syncResource(r, r === "coops" ? null : currentCoopId);
      if (rows && rows.length) {
        anyChanged = true;
        if (r === "activity_log") newActivityRows = rows;
      }
    } catch (err) {
      break; // offline -- stop this round, the next tick will retry everything
    }
  }
  refreshSyncStatus(); // the underlying timestamps advance on every successful attempt, whether or not anything new came in -- keep the display honest about that
  updateSyncIndicator();
  if (!anyChanged) return;
  const stateKeyFor = { eggs: "eggs", expenses: "expenses", supplies: "supplies", bedding: "bedding", notes: "notes", bird_logs: "birdLogs", birds: "birds", hatches: "hatches", hatch_eggs: "hatchEggs", bird_photos: "birdPhotos", activity_log: "activityLog", supply_products: "supplyProducts" };
  for (const [resource, stateKey] of Object.entries(stateKeyFor)) {
    try {
      STATE[stateKey] = await localGetAll(resource, currentCoopId);
    } catch (err) {
      console.error(`Failed to read ${resource} from local storage:`, err);
    }
  }
  STATE.coops = await localGetAll("coops");
  await checkCurrentCoopStillExists();
  await refreshPendingPhotoUrls();
  await refreshPendingProductPhotoUrls();
  updateHeader();
  renderActiveTab();

  // Attribute the toast to whoever actually made the change, when we know --
  // falls back to a generic message if nobody's set a name on their device.
  const myName = getUserName();
  const fromOthers = newActivityRows.filter(e => e.changed_by && e.changed_by !== myName && !e.deleted_at);
  if (fromOthers.length) {
    fromOthers.slice(0, 3).forEach(e => showToast(`${e.changed_by} ${e.summary}`, "update"));
    if (fromOthers.length > 3) showToast(`+${fromOthers.length - 3} more change${fromOthers.length - 3 !== 1 ? "s" : ""}`, "update");
  } else if (newActivityRows.length === 0) {
    // Something did change (anyChanged is true), but no activity was logged
    // for it at all -- that only happens when the device making the change
    // has no name set (logActivity silently skips without one). Still worth
    // a generic notice, since this genuinely came from elsewhere.
    showToast("Updated from server", "update");
  }
  // else: activity WAS logged, but every entry is attributable to this
  // device's own name -- this is just our own recent action (egg added,
  // bird edited, whatever) echoing back through sync now that it's near-
  // instant, not actual news. Stay silent rather than notify ourselves
  // about our own edit a second time.
}

let _backgroundSyncTimer = null;
function startBackgroundSyncTimer() {
  if (_backgroundSyncTimer) clearInterval(_backgroundSyncTimer);
  const sec = getSyncIntervalSec();
  if (!sec) return; // 0 = manual only, via the Sync now button
  _backgroundSyncTimer = setInterval(backgroundSyncTick, sec * 1000);
}
// Catches up right away when you switch back to the app/tab, rather than
// waiting out however much of the interval is left.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") backgroundSyncTick(); });

// ---------- Live updates (Server-Sent Events) ----------
// A quiet, long-lived connection that gets a tiny "something changed"
// message the instant anyone (including this device) mutates data for the
// current coop, so we can sync immediately rather than waiting out the
// polling interval. This is purely a faster trigger for the exact same
// backgroundSyncTick() used everywhere else -- no separate code path for
// what happens once notified, so conflict resolution, the outbox, all of it
// behaves identically either way.
let _eventSource = null;
let sseStatus = "off"; // "off" | "connecting" | "connected" | "error" | "unsupported"
function startEventStream() {
  stopEventStream();
  if (localOnlyMode || !currentCoopId) { sseStatus = "off"; return; }
  if (document.visibilityState !== "visible") { sseStatus = "off"; return; } // no point holding a connection open while backgrounded
  if (typeof EventSource === "undefined") { sseStatus = "unsupported"; return; }
  try {
    sseStatus = "connecting";
    _eventSource = new EventSource(apiUrl(`/api/events?coop_id=${encodeURIComponent(currentCoopId)}&token=${encodeURIComponent(getAuthToken())}`));
    _eventSource.onopen = () => { sseStatus = "connected"; refreshSyncStatus(); updateServerConnectionStatusUi(); };
    _eventSource.onmessage = () => { backgroundSyncTick(); };
    // EventSource retries on its own with backoff after an error -- onerror
    // fires both for "temporarily reconnecting" and genuine failures, so
    // this just reflects "not currently connected" rather than giving up;
    // the polling timer covers us regardless while it's down.
    _eventSource.onerror = () => { sseStatus = "error"; refreshSyncStatus(); updateServerConnectionStatusUi(); };
  } catch (err) {
    sseStatus = "error"; // EventSource unsupported or failed to construct -- polling still covers this device fine
  }
}
function stopEventStream() {
  if (_eventSource) { _eventSource.close(); _eventSource = null; }
  sseStatus = "off";
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { startEventStream(); checkConnection(); }
  else stopEventStream();
});


let _syncInFlight = false;
async function trySyncSoon(resource, coopId) {
  if (localOnlyMode) return; // running local-only by choice -- never attempt to reach a server
  if (_syncInFlight) return;
  _syncInFlight = true;
  try { await syncResource(resource, coopId); } catch (err) { /* offline -- the outbox just waits */ }
  _syncInFlight = false;
}

// ---- Local-first CRUD for Eggs specifically ----
