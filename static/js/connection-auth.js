// Server connection (self-hosted URL), API helpers, login and session handling.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ---------- API ----------
// ---------- Configurable server connection ----------
// Defaults to "" (same-origin, current behavior). Settable from Settings ->
// Connection so an installed copy of the app -- especially a wrapped native
// shell -- can point at any reachable server instead of only the origin it
// happened to be loaded from.
const SERVER_URL_KEY = "coopLedgerServerUrl";
function getServerUrl() { return (localStorage.getItem(SERVER_URL_KEY) || "").replace(/\/$/, ""); }
function isRunningAsInstalledPwa() { return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; }
function setServerUrl(url) { localStorage.setItem(SERVER_URL_KEY, (url || "").trim().replace(/\/$/, "")); }
function apiUrl(path) { return getServerUrl() + path; }
function mediaUrl(path) {
  if (!path || !path.startsWith("/")) return path;
  const token = getAuthToken();
  const sep = path.includes("?") ? "&" : "?";
  return getServerUrl() + path + (token ? `${sep}token=${encodeURIComponent(token)}` : "");
}

// ---------- Auth ----------
// A bearer token, not a cookie -- works identically whether the app is
// same-origin or (via the configurable server URL above) cross-origin,
// with none of the CORS-credential complications cookies would introduce.
const AUTH_TOKEN_KEY = "coopLedgerAuthToken";
const AUTH_NAME_KEY = "coopLedgerAuthName";
const AUTH_ROLE_KEY = "coopLedgerAuthRole";
function getAuthToken() { return localStorage.getItem(AUTH_TOKEN_KEY) || ""; }
function setAuthToken(token) { localStorage.setItem(AUTH_TOKEN_KEY, token || ""); mirrorTokenForServiceWorker(token || ""); }

/** Copies the auth token into a tiny standalone IndexedDB the service worker
 * can read. Service workers have no access to localStorage, and Background
 * Sync runs with the app closed, so without this the worker couldn't
 * authenticate the queued requests it's trying to finish.
 *
 * Deliberately a separate database from the app's: the worker then never needs
 * to know the main schema version, so migrations on either side stay
 * independent. Same-origin storage either way, so this exposes nothing that
 * localStorage didn't already. */
function mirrorTokenForServiceWorker(token) {
  try {
    const req = indexedDB.open("coopLedgerSwState", 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      try {
        const tx = db.transaction("kv", "readwrite");
        if (token) tx.objectStore("kv").put({ key: "authToken", value: token });
        else tx.objectStore("kv").delete("authToken"); // signing out revokes the worker's access too
      } catch (_) { /* best effort -- sync just falls back to in-app draining */ }
    };
  } catch (_) { /* no IndexedDB: Background Sync simply won't engage */ }
}

/** Asks the browser to drain the outbox once connectivity returns, even if the
 * app has been closed by then. A no-op where Background Sync isn't supported
 * (Safari), which is fine -- the existing "online" listener still covers the
 * app-is-open case everywhere. */
async function requestBackgroundOutboxSync() {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg && reg.sync) await reg.sync.register("coop-outbox");
  } catch (_) { /* not supported or permission denied -- no action needed */ }
}
function getUserRole() { return localStorage.getItem(AUTH_ROLE_KEY) || "admin"; } // existing sessions from before roles existed are implicitly admin
function setUserRole(role) { localStorage.setItem(AUTH_ROLE_KEY, role || "admin"); }
function isReadOnlyRole() { return getUserRole() === "readonly"; }
function clearAuthToken() { localStorage.removeItem(AUTH_TOKEN_KEY); localStorage.removeItem(AUTH_NAME_KEY); localStorage.removeItem(AUTH_ROLE_KEY); }

let _handlingAuthFailure = false;
/** A 401 from anywhere in the sync engine means the same thing no matter
 * which request hit it: this device is not logged in anymore. Clears the
 * dead token and shows the login screen immediately, rather than letting
 * the outbox quietly grow forever with no indication of why. Guarded so a
 * whole batch of requests failing in the same tick (which is exactly what
 * happens once this fires) doesn't try to show the login screen repeatedly. */
function handleSyncAuthFailure() {
  if (_handlingAuthFailure || localOnlyMode) return;
  if (!localStorage.getItem(MODE_CHOSEN_KEY)) return; // onboarding hasn't happened yet -- nobody's logged in yet, that's expected here, not a failure
  _handlingAuthFailure = true;
  clearAuthToken();
  stopEventStream();
  showLoginScreen();
}
function authHeaders() {
  const token = getAuthToken();
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

/** Turns a response into either its JSON body or a readable Error.
 *
 * Previously these blindly called .json() on whatever came back, so a server
 * error rendered as an HTML page produced "Unexpected token '<'" -- which says
 * nothing about what actually failed. Surfacing the status and the server's
 * own `detail` makes a failure diagnosable from the toast alone. */
async function apiResult(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  if (!res.ok) {
    const detail = (data && (data.detail || data.message)) || (text || "").slice(0, 120).trim();
    const err = new Error(detail ? `${res.status}: ${detail}` : `Request failed (${res.status})`);
    err.status = res.status;
    // Callers that already read `err.detail` for a server-supplied message keep
    // working unchanged.
    err.detail = detail || null;
    throw err;
  }
  return data;
}
async function apiGet(path) { return apiResult(await fetch(apiUrl(path), { headers: authHeaders() })); }
async function apiPost(path, body) { return apiResult(await fetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) })); }
async function apiDelete(path) { return apiResult(await fetch(apiUrl(path), { method: "DELETE", headers: authHeaders() })); }

// Local-only mode: a deliberate choice to never attempt to reach a server at
// all, distinct from "has a server configured but it's currently
// unreachable." Chosen once (onboarding, or later in Settings -> Connection)
// and persisted; switching to sync mode later just starts pushing whatever
// already accumulated locally in the meantime -- nothing is lost either way.
const LOCAL_ONLY_KEY = "coopLedgerLocalOnly";
const MODE_CHOSEN_KEY = "coopLedgerModeChosen";
let localOnlyMode = localStorage.getItem(LOCAL_ONLY_KEY) === "1";
function setLocalOnlyMode(isLocalOnly) {
  localOnlyMode = isLocalOnly;
  localStorage.setItem(LOCAL_ONLY_KEY, isLocalOnly ? "1" : "0");
  localStorage.setItem(MODE_CHOSEN_KEY, "1");
}

/** Detects if the currently-selected coop has been deleted (from another
 * device) and gracefully switches away rather than leaving someone stuck
 * looking at -- or worse, trying to save new changes into -- a coop that no
 * longer exists anywhere. localGetAll already filters out soft-deleted
 * rows, so "not in STATE.coops anymore" reliably means "actually gone." */
async function checkCurrentCoopStillExists() {
  if (!currentCoopId) return;
  if (STATE.coops.some(c => c.id === currentCoopId)) return; // still exists, nothing to do
  showToast("This coop was deleted from another device", "delete");
  currentCoopId = null;
  localStorage.removeItem(COOP_KEY);
  stopEventStream();
  if (STATE.coops.length) {
    await switchCoop(STATE.coops[0].id);
  } else {
    await loadCoopData();
    updateHeader();
    updateTabVisibility();
    renderActiveTab();
  }
}

async function loadCoops() {
  if (!localOnlyMode) {
    try { await syncResource("coops", null); } catch (err) { /* offline; use what's already stored locally */ }
  }
  STATE.coops = await localGetAll("coops");
  await checkCurrentCoopStillExists();
}

