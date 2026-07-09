// ---------- State ----------
// Bump this with any meaningful change and check it in Settings -> Connection
// -- if this number doesn't match what you expect after a redeploy, the
// browser/CDN/service worker is serving stale files, not a code bug.
const APP_VERSION = "2026.07.06-106";
const COOP_KEY = "coopLedgerCurrentCoop";
const PAGE_SIZE = 100; // "load more" page size for the Eggs/Expenses/Archive lists
const STATE = { coops: [], birds: [], eggs: [], expenses: [], bedding: [], birdLogs: [], notes: [], supplies: [], hatches: [], activityLog: [], supplyProducts: [] };
let currentCoopId = null;
let activeTab = "dashboard";
let chartRangeDays = 30; // default 30 days -- shows meaningful recent activity without hiding older data by surprise
let charts = {};

const BIRD_TYPES = ["Layer", "Meat", "Dual Purpose"];
const BIRD_STATUSES = ["Active", "Processed", "Sold", "Deceased", "Retired"];
const EXPENSE_CATEGORIES = ["Layer Feed", "Meat Feed", "Treats", "Bedding", "Building Materials", "Equipment", "Birds/Chicks", "Medical/Health", "Other"];
const INCOME_CATEGORIES = ["Egg Sale", "Meat Sale", "Bird Sale", "Other Income"];
// Egg Sale and Meat Sale get their quantity/unit locked, same idea as feed
// categories -- this is what lets the wash-out math work out how many eggs
// or lbs of meat a sale represents, not just its dollar amount.
const INCOME_UNIT_LOCKS = { "Egg Sale": "eggs", "Meat Sale": "lb" };
const BEDDING_AREAS = ["Coop Floor", "Nesting Boxes", "Run"];
const BEDDING_MATERIALS = ["Pine Shavings", "Straw", "Sand", "Hemp Bedding", "Deep Litter (mixed)", "Other"];
const BEDDING_TYPES = ["Top-off", "Churn", "Top-off + Churn", "Full Clean-out"];
const RANGES = [{ label: "7D", days: 7 }, { label: "30D", days: 30 }, { label: "90D", days: 90 }, { label: "180D", days: 180 }, { label: "1Y", days: 365 }, { label: "All", days: null }];
const PIE_COLORS = ["#C1502E", "#D4A017", "#8A9A5B", "#7A8FA6", "#9C7A54", "#6B5B95", "#C77B58"];
const FLOCK_DATE_FIELDS = [
  { label: "Any date", value: "" },
  { label: "Acquired", value: "acquired_date" },
  { label: "Hatched", value: "hatch_date" },
  { label: "Harvested", value: "harvest_date" },
  { label: "Lost", value: "death_date" },
];
let flockFilters = { status: "Active", type: "", dateField: "", year: "", location: "" };
let flockFiltersOpen = false;
let flockSort = "name"; // "name" | "age" | "target"
let selectedBirdIds = new Set();
let selectedSupplyIds = new Set();
let expandedBatches = new Set();
let eggFilters = { year: "" };
let editingEggId = null;
let eggFiltersOpen = false;
let eggsVisibleCount = PAGE_SIZE;
let expenseFilters = { category: "", year: "" };
let expenseMonthKey = null; // "yyyy-MM" of the currently viewed month; null = current month
let editingExpenseId = null;
let expenseFormEntryType = "expense";
let pendingExpenseCategory = null; // persists a new entry's category choice across re-renders (product selection, income/expense toggle) that would otherwise rebuild the dropdown back to its default
let expenseScope = "month"; // "month" | "year" | "all"
let expenseYearKey = null;
let expenseYearKeyTo = null; // "to" end when range mode is active
let expenseMonthKeyTo = null; // "to" end when range mode is active
let expenseRangeMode = false;
let expensesVisibleCount = PAGE_SIZE;
let beddingFilters = { area: "", entryType: "", year: "" };
let editingBeddingId = null;
let beddingFiltersOpen = false;
let selectedProductId = null; // shared by both the direct supply form and the expense form's auto-create flow
let newProductFormOpen = false;
let editingProductId = null;
let newProductCategory = null; // which category "+ Add Product" was clicked for, on the standalone Products page
let pendingProductPhotoBlob = null;
let feedSupplyVisibleCount = PAGE_SIZE;
let beddingSupplyVisibleCount = PAGE_SIZE;
let emptySupplyVisibleCount = PAGE_SIZE;
const SUPPLY_STATUSES = ["Full", "3/4", "1/2", "1/4", "Empty"];
const FEED_SUPPLY_CATEGORIES = new Set(["Layer Feed", "Meat Feed", "Treats"]); // Feed section, and also the categories locked to "lb" below
function supplyStatusTone(status) {
  if (status === "Full" || status === "3/4") return "sage";
  if (status === "1/2") return "gold";
  if (status === "1/4") return "rust";
  return "slate"; // Empty
}
/** Category color, separate from the status tone above (which reflects
 * fullness, not type) -- gives each kind of supply its own identity so the
 * inventory grid reads as more than one undifferentiated pile of cards. */
function supplyCategoryTone(category) {
  if (category === "Layer Feed") return "gold";
  if (category === "Meat Feed") return "rust";
  if (category === "Treats") return "sage";
  if (category === "Bedding") return "slate";
  return "slate";
}
function supplySliderValue(status) {
  const idx = { "Empty": 0, "1/4": 1, "1/2": 2, "3/4": 3, "Full": 4 };
  return idx[status] ?? 4;
}
function supplyStatusFromSlider(value) {
  const byIdx = ["Empty", "1/4", "1/2", "3/4", "Full"];
  return byIdx[Number(value)] ?? "Full";
}
function supplyIsPartial(status) { return status === "1/4" || status === "1/2" || status === "3/4"; }
function supplyFraction(status) { return { "Full": 1, "3/4": 0.75, "1/2": 0.5, "1/4": 0.25, "Empty": 0 }[status] ?? 1; }
function supplyStampLabel(s) {
  if (!s.quantity) return s.status; // no quantity recorded -- nothing to compute a remaining amount from
  const remaining = s.quantity * supplyFraction(s.status);
  const remainingStr = Number.isInteger(remaining) ? String(remaining) : remaining.toFixed(1);
  const unitStr = s.unit ? ` ${s.unit}` : "";
  if (s.status === "Full") return s.opened_at ? `Opened, ${remainingStr}${unitStr}` : `Full ${remainingStr}${unitStr}`;
  if (s.status === "Empty") return "Empty";
  return `${s.status} ${remainingStr}${unitStr} Left`;
}

/** Feed categories always come in pounds in practice, and bedding materials
 * (shavings, straw, etc.) are conventionally sold and measured by the cubic
 * foot -- locking each category's unit keeps "total used" additions
 * accurate instead of silently mixing units that can't be summed. */
const UNIT_LOCKS = { "Layer Feed": "lb", "Meat Feed": "lb", "Treats": "lb", "Bedding": "cu ft" };
function applyFeedUnitLock(categorySelId, unitSelId, lockMap = UNIT_LOCKS) {
  const catEl = document.getElementById(categorySelId);
  const unitEl = document.getElementById(unitSelId);
  if (!catEl || !unitEl) return;
  const sync = () => {
    const locked = lockMap[catEl.value];
    if (locked) {
      unitEl.value = locked;
      unitEl.disabled = true;
    } else {
      unitEl.disabled = false;
    }
  };
  sync();
  catEl.addEventListener("change", sync);
}
let beddingVisibleCount = PAGE_SIZE;
let reviewYear = null;
const DEFAULT_BEDDING_THRESHOLDS = {
  "Coop Floor": { warn: 120, danger: 180, churn: 7 },
  "Nesting Boxes": { warn: 60, danger: 90, churn: 7 },
  "Run": { warn: 120, danger: 180, churn: 7 },
};

// ---------- Helpers ----------
const todayStr = () => new Date().toISOString().slice(0, 10);
const esc = (s) => (s === undefined || s === null) ? "" : String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => !d ? "—" : new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtMoney = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function ageFromDate(dateStr) {
  if (!dateStr) return "Unknown";
  const days = Math.floor((new Date() - new Date(dateStr + "T00:00:00")) / 86400000);
  if (days < 0) return "Not hatched yet";
  if (days < 14) return `${days} day${days !== 1 ? "s" : ""} old`;
  if (days < 56) { const w = Math.floor(days / 7); return `${w} week${w !== 1 ? "s" : ""} old`; }
  if (days < 730) { const mo = Math.floor(days / 30.44); return `${mo} month${mo !== 1 ? "s" : ""} old`; }
  const y = (days / 365.25).toFixed(1);
  return `${y} year${y !== "1.0" ? "s" : ""} old`;
}
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((new Date() - new Date(dateStr + "T00:00:00")) / 86400000);
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr + "T00:00:00") - new Date()) / 86400000);
}
function harvestCountdownHtml(targetDate, extraClass = "") {
  const d = daysUntil(targetDate);
  if (d === null) return "";
  if (d < 0) return `<span class="stamp tone-danger ${extraClass}">Harvest overdue ${-d}d</span>`;
  if (d === 0) return `<span class="stamp tone-danger ${extraClass}">Harvest today</span>`;
  if (d <= 7) return `<span class="stamp tone-gold ${extraClass}">Harvest in ${d}d</span>`;
  return `<span class="stamp tone-slate ${extraClass}">Harvest in ${d}d</span>`;
}
function withinRange(dateStr, days) {
  if (!days) return true;
  return (new Date() - new Date(dateStr + "T00:00:00")) / 86400000 <= days;
}
function weekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
async function resizeImageFileToBlob(file, maxDim = 700, quality = 0.82) {
  // Phone cameras store photos with an EXIF orientation tag rather than
  // physically rotating the pixel data -- drawing that straight to a canvas
  // (the old approach here) ignores that tag and can leave the photo sideways
  // or upside down. createImageBitmap with imageOrientation:"from-image"
  // decodes the pixels already rotated the correct way, so the canvas we draw
  // from is right-side-up regardless of how the camera saved it.
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    // Older browsers without the option overload -- falls back to default
    // decoding, which is how this worked before (may not auto-rotate).
    bitmap = await createImageBitmap(file);
  }
  let w = bitmap.width, h = bitmap.height;
  if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
  else if (h >= w && h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}
async function apiUploadPhoto(id, blob, resource = "birds") {
  const fd = new FormData();
  fd.append("file", blob, "photo.jpg");
  const res = await fetch(apiUrl(`/api/${resource}/${id}/photo`), { method: "POST", headers: authHeaders(), body: fd });
  if (!res.ok) throw new Error(`Photo upload failed (${res.status})`);
  return res.json();
}
function pickBucketMode(days) {
  if (days && days <= 60) return "day";
  if (!days || days > 365) return "month";
  return "week";
}
function bucketLabel(dateStr, mode) {
  if (mode === "day") return dateStr.slice(5);
  if (mode === "week") return weekStart(dateStr).slice(5);
  return dateStr.slice(0, 7);
}

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
function getAuthToken() { return localStorage.getItem(AUTH_TOKEN_KEY) || ""; }
function setAuthToken(token) { localStorage.setItem(AUTH_TOKEN_KEY, token || ""); }
function clearAuthToken() { localStorage.removeItem(AUTH_TOKEN_KEY); localStorage.removeItem(AUTH_NAME_KEY); }

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

async function apiGet(path) { return (await fetch(apiUrl(path), { headers: authHeaders() })).json(); }
async function apiPost(path, body) { return (await fetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) })).json(); }
async function apiPut(path, body) { return (await fetch(apiUrl(path), { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) })).json(); }
async function apiDelete(path) { return (await fetch(apiUrl(path), { method: "DELETE", headers: authHeaders() })).json(); }

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

// ================= LOCAL-FIRST DATA LAYER (every resource) =================
// Everything below makes Eggs work fully offline: reads and writes go to an
// IndexedDB copy on the device first (instant, no network needed), and a
// background sync engine reconciles that copy with the server whenever it's
// reachable. Every other resource (birds, expenses, bedding, etc.) still
// talks to the server directly for now, unchanged -- this is deliberately a
// single proven slice before the same pattern gets extended to the rest.
const LOCAL_DB_NAME = "coopLedgerLocalDB";
const LOCAL_DB_VERSION = 6;
const LOCAL_STORES = ["coops", "birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "activity_log", "supply_products"];
let _localDbPromise = null;

function openLocalDb() {
  if (_localDbPromise) return _localDbPromise;
  _localDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      LOCAL_STORES.forEach(store => {
        if (!db.objectStoreNames.contains(store)) {
          const os = db.createObjectStore(store, { keyPath: "id" });
          os.createIndex("coop_id", "coop_id", { unique: false });
        }
      });
      if (!db.objectStoreNames.contains("_meta")) db.createObjectStore("_meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("_outbox")) db.createObjectStore("_outbox", { keyPath: "outboxId", autoIncrement: true });
      // Photos are binary files, not JSON rows, so they can't ride the normal
      // outbox -- a picked photo queues here (as a real Blob; IndexedDB
      // stores these natively) until a connection is available to actually
      // upload it. Keyed by bird id: a newer picked photo simply replaces an
      // older unsent one rather than piling up duplicates.
      if (!db.objectStoreNames.contains("pending_photos")) db.createObjectStore("pending_photos", { keyPath: "birdId" });
      // Same idea, separate store, for supply product photos -- kept
      // isolated from the bird one rather than sharing a store, so a
      // product and a bird that happened to share an id (astronomically
      // unlikely, but free to rule out) could never collide.
      if (!db.objectStoreNames.contains("pending_product_photos")) db.createObjectStore("pending_product_photos", { keyPath: "productId" });
      // FileSystemDirectoryHandle objects are structured-cloneable, so the
      // handle a user picks via showDirectoryPicker() can be stored here
      // directly and reused across sessions without re-prompting for the
      // folder every time (though write permission itself still needs
      // re-confirming each session -- browsers don't persist that part).
      if (!db.objectStoreNames.contains("sync_folder")) db.createObjectStore("sync_folder", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _localDbPromise;
}

function idbRequest(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function idbDone(tx) { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }

async function queuePendingPhoto(birdId, blob) {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_photos"], "readwrite");
  tx.objectStore("pending_photos").put({ birdId, blob, queuedAt: new Date().toISOString() });
  await idbDone(tx);
}
async function getPendingPhoto(birdId) {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_photos"], "readonly");
  return (await idbRequest(tx.objectStore("pending_photos").get(birdId))) || null;
}
async function getAllPendingPhotos() {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_photos"], "readonly");
  return (await idbRequest(tx.objectStore("pending_photos").getAll())) || [];
}
async function clearPendingPhoto(birdId) {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_photos"], "readwrite");
  tx.objectStore("pending_photos").delete(birdId);
  await idbDone(tx);
}

/** Object URLs for any photos still queued locally, refreshed whenever bird
 * data loads. A synchronous lookup map, since the card-rendering functions
 * build HTML strings synchronously and can't await an IndexedDB read per
 * photo -- this loads all of them once up front instead. */
let pendingPhotoUrls = {};
async function refreshPendingPhotoUrls() {
  Object.values(pendingPhotoUrls).forEach(url => URL.revokeObjectURL(url));
  pendingPhotoUrls = {};
  const pending = await getAllPendingPhotos();
  pending.forEach(p => { pendingPhotoUrls[p.birdId] = URL.createObjectURL(p.blob); });
}
/** The photo to actually display for a bird: a queued-but-not-yet-uploaded
 * local photo takes priority (it's the newest one), falling back to
 * whatever's already on the server. */
function birdPhotoUrl(bird) {
  return pendingPhotoUrls[bird.id] || (bird.photo ? mediaUrl(bird.photo) : null);
}

/** Pushes any queued photos to the server, one at a time; stops at the first
 * failure (still offline) and picks up again on the next sync attempt. */
async function pushPendingPhotosOnce() {
  const pending = await getAllPendingPhotos();
  let anyUploaded = false;
  for (const p of pending) {
    try {
      const result = await apiUploadPhoto(p.birdId, p.blob);
      // Same reasoning as the product-photo fix: update the local record
      // right away so there's no gap between the pending preview clearing
      // and the next full pull picking up the server's copy.
      const existing = await localGetOne("birds", p.birdId);
      if (existing) await localPutMany("birds", [{ ...existing, photo: result.photo }]);
      await clearPendingPhoto(p.birdId);
      anyUploaded = true;
    } catch (err) {
      break;
    }
  }
  if (anyUploaded && currentCoopId) {
    STATE.birds = await localGetAll("birds", currentCoopId);
    await refreshPendingPhotoUrls();
    if (activeTab === "flock") renderFlockHub();
  }
}

async function getPendingProductPhoto(productId) {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_product_photos"], "readonly");
  return (await idbRequest(tx.objectStore("pending_product_photos").get(productId))) || null;
}
async function queuePendingProductPhoto(productId, blob) {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_product_photos"], "readwrite");
  tx.objectStore("pending_product_photos").put({ productId, blob, queuedAt: new Date().toISOString() });
  await idbDone(tx);
}
async function getAllPendingProductPhotos() {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_product_photos"], "readonly");
  return (await idbRequest(tx.objectStore("pending_product_photos").getAll())) || [];
}
async function clearPendingProductPhoto(productId) {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_product_photos"], "readwrite");
  tx.objectStore("pending_product_photos").delete(productId);
  await idbDone(tx);
}
let pendingProductPhotoUrls = {};
async function refreshPendingProductPhotoUrls() {
  Object.values(pendingProductPhotoUrls).forEach(url => URL.revokeObjectURL(url));
  pendingProductPhotoUrls = {};
  const pending = await getAllPendingProductPhotos();
  pending.forEach(p => { pendingProductPhotoUrls[p.productId] = URL.createObjectURL(p.blob); });
}
/** The photo to actually display for a product: same "queued local photo
 * wins" priority as birds. */
function productPhotoUrl(product) {
  if (!product) return null;
  return pendingProductPhotoUrls[product.id] || (product.photo ? mediaUrl(product.photo) : null);
}
async function pushPendingProductPhotosOnce() {
  const pending = await getAllPendingProductPhotos();
  let anyUploaded = false;
  for (const p of pending) {
    try {
      const result = await apiUploadPhoto(p.productId, p.blob, "supply_products");
      // Update the local record with the real photo path right away --
      // without this, there's a gap window between the pending queue entry
      // being cleared (so the temporary local object-URL preview goes away)
      // and the next full data pull picking up the server's copy, during
      // which the product has no photo at all and silently falls back to
      // the placeholder. A page reload "fixes" it only because that forces
      // a fresh pull -- this closes the gap without needing one.
      const existing = await localGetOne("supply_products", p.productId);
      if (existing) await localPutMany("supply_products", [{ ...existing, photo: result.photo }]);
      await clearPendingProductPhoto(p.productId);
      anyUploaded = true;
    } catch (err) {
      break;
    }
  }
  if (anyUploaded && currentCoopId) {
    STATE.supplyProducts = await localGetAll("supply_products", currentCoopId);
    await refreshPendingProductPhotoUrls();
    if (activeTab === "bedding") renderActiveTab();
  }
}
// Multiple resources can try to sync at the same moment (loadCoopData syncs
// all of them in parallel, the background timer does too) -- without this,
// two concurrent passes could both read the same queued photo before either
// clears it and upload it twice. This makes concurrent callers share one
// actual pass instead of racing.
let _pushPhotosInFlight = null;
async function pushPendingPhotos() {
  if (_pushPhotosInFlight) return _pushPhotosInFlight;
  _pushPhotosInFlight = pushPendingPhotosOnce().finally(() => { _pushPhotosInFlight = null; });
  return _pushPhotosInFlight;
}
let _pushProductPhotosInFlight = null;
async function pushPendingProductPhotos() {
  if (_pushProductPhotosInFlight) return _pushProductPhotosInFlight;
  _pushProductPhotosInFlight = pushPendingProductPhotosOnce().finally(() => { _pushProductPhotosInFlight = null; });
  return _pushProductPhotosInFlight;
}

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
  supply_products: "a saved product",
};
const RESOURCE_LABELS_PLURAL = { birds: "birds", supplies: "supply items", supply_products: "saved products" };
const OP_VERBS = { create: "added", update: "updated", delete: "deleted" };

async function queueOutbox(entry) {
  const db = await openLocalDb();
  const tx = db.transaction("_outbox", "readwrite");
  tx.objectStore("_outbox").add({ ...entry, queuedAt: new Date().toISOString() });
  await idbDone(tx);
  // Every mutation flows through here, so this is the one place activity
  // logging needs to hook in -- not two dozen individual create/update/
  // delete functions. Guarded against logging the logging itself.
  if (entry.resource !== "activity_log") await logActivity(entry.resource, entry.op, entry.payload);
}

/** Records "who did what" as its own local-first, syncing resource -- so
 * both devices end up with the same shared history, not just their own. */
async function logActivity(resource, op, payload) {
  const name = getUserName();
  if (!name || !currentCoopId) return; // no identity set for this device -- skip rather than log "Someone"
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
      break; // genuine network failure -- stop and retry the whole queue later
    }
    if (res.ok) {
      await clearOutboxEntry(entry.outboxId);
      continue;
    }
    if (res.status === 401) {
      // Unlike a 404/400, a 401 isn't ambiguous -- it means "you are not
      // logged in," full stop, not "maybe try again later." Silently
      // retrying forever would just grow the outbox indefinitely with zero
      // indication of why. Surface it and stop immediately.
      handleSyncAuthFailure();
      break;
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 403) {
      // A permanent rejection -- e.g. a 404 deleting something that's already
      // gone (two devices both deleted the same record), or a 400 on a
      // malformed payload. Retrying the exact same request will never
      // succeed, so this needs to be discarded, not left to block every
      // entry queued after it forever.
      console.error(`Discarding outbox entry permanently rejected by the server (${res.status}):`, entry);
      await clearOutboxEntry(entry.outboxId);
      continue;
    }
    break; // 403/5xx -- possibly transient -- stop and retry later
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
 * (including tombstones for deleted rows) and merges it into IndexedDB. */
async function pullChanges(resource, coopId) {
  const since = await getLastSync(resource, coopId);
  const url = apiUrl(`/api/sync/${resource}?coop_id=${encodeURIComponent(coopId)}&since=${encodeURIComponent(since)}`);
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) { handleSyncAuthFailure(); throw new Error("not logged in"); }
  if (!res.ok) throw new Error(`sync pull failed for ${resource}`);
  const data = await res.json();
  if (data.rows.length) await localPutMany(resource, data.rows);
  await setLastSync(resource, coopId, data.server_time);
  return data.rows;
}

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

async function syncResource(resource, coopId) {
  if (localOnlyMode) return; // running local-only by choice -- never attempt to reach a server
  markSyncAttempt();
  await pushOutbox();
  await pushPendingPhotos();
  await pushPendingProductPhotos();
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
  if (!anyChanged) return;
  const stateKeyFor = { eggs: "eggs", expenses: "expenses", supplies: "supplies", bedding: "bedding", notes: "notes", bird_logs: "birdLogs", birds: "birds", hatches: "hatches", activity_log: "activityLog", supply_products: "supplyProducts" };
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
    _eventSource.onopen = () => { sseStatus = "connected"; refreshSyncStatus(); };
    _eventSource.onmessage = () => { backgroundSyncTick(); };
    // EventSource retries on its own with backoff after an error -- onerror
    // fires both for "temporarily reconnecting" and genuine failures, so
    // this just reflects "not currently connected" rather than giving up;
    // the polling timer covers us regardless while it's down.
    _eventSource.onerror = () => { sseStatus = "error"; refreshSyncStatus(); };
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
function newLocalId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    try {
      return "c" + crypto.randomUUID().replace(/-/g, "").slice(0, 15);
    } catch (err) { /* fall through */ }
  }
  // crypto.randomUUID requires a secure context (HTTPS or localhost) and is
  // simply unavailable over plain HTTP (e.g. a bare LAN IP with no TLS) --
  // this only needs to be unique within this app, not cryptographically
  // random, so a timestamp + random fallback is perfectly fine here.
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

async function localEggCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("eggs", [record]);
  await queueOutbox({ resource: "eggs", op: "create", id: record.id, payload: record });
  trySyncSoon("eggs", payload.coop_id);
  return record;
}
async function localEggUpdate(id, payload) {
  const existing = await localGetOne("eggs", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("eggs", [record]);
  await queueOutbox({ resource: "eggs", op: "update", id, payload });
  trySyncSoon("eggs", payload.coop_id || (existing && existing.coop_id));
  return record;
}
async function localEggDelete(id, coopId) {
  const existing = await localGetOne("eggs", id);
  const now = new Date().toISOString();
  await localPutMany("eggs", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "eggs", op: "delete", id, payload: null });
  trySyncSoon("eggs", coopId);
}

async function localExpenseCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("expenses", [record]);
  await queueOutbox({ resource: "expenses", op: "create", id: record.id, payload: record });
  trySyncSoon("expenses", payload.coop_id);
  return record;
}
async function localExpenseUpdate(id, payload) {
  const existing = await localGetOne("expenses", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("expenses", [record]);
  await queueOutbox({ resource: "expenses", op: "update", id, payload });
  trySyncSoon("expenses", payload.coop_id || (existing && existing.coop_id));
  return record;
}
async function localExpenseDelete(id, coopId) {
  const existing = await localGetOne("expenses", id);
  const now = new Date().toISOString();
  await localPutMany("expenses", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "expenses", op: "delete", id, payload: null });
  trySyncSoon("expenses", coopId);
}

/** Creates many records at once, local-first -- all written to IndexedDB
 * immediately (so they're usable offline right away, same as individual
 * creates), but queued as ONE outbox entry instead of N separate ones. That
 * single entry syncs via the bulk-create endpoint in one request, instead
 * of turning into hundreds or thousands of sequential HTTP round-trips the
 * next time the outbox drains -- which is what actually crashed the server
 * on a 4000-item group before this existed. */
async function localBulkCreate(resource, payloads) {
  const now = new Date().toISOString();
  const records = payloads.map(p => ({ id: newLocalId(), updated_at: now, deleted_at: null, ...p }));
  await localPutMany(resource, records);
  await queueOutbox({ resource, op: "bulk-create", id: null, payload: records });
  const coopId = records[0] && records[0].coop_id;
  if (coopId) trySyncSoon(resource, coopId);
  return records;
}

/** Deletes many records at once, local-first -- same reasoning as
 * localBulkCreate, but for the delete side. This is what the group-count
 * "raise to add more, lower to remove" flow needs: reducing a pile of 4000
 * down to 4 used to mean 3996 individual delete operations (and eventually
 * 3996 individual sync requests) -- now it's one. */
async function localBulkDelete(resource, ids, coopId) {
  const now = new Date().toISOString();
  const existing = await Promise.all(ids.map(id => localGetOne(resource, id)));
  const records = ids.map((id, i) => ({ ...(existing[i] || { id }), deleted_at: now, updated_at: now }));
  await localPutMany(resource, records);
  await queueOutbox({ resource, op: "bulk-delete", id: null, payload: ids });
  if (coopId) trySyncSoon(resource, coopId);
}

/** Same idea for updates -- payload is an array of {id, fields} objects. */
async function localBulkUpdate(resource, updates, coopId) {
  const now = new Date().toISOString();
  const existingRecords = await Promise.all(updates.map(u => localGetOne(resource, u.id)));
  const records = updates.map((u, i) => ({ ...(existingRecords[i] || { id: u.id }), ...u.fields, updated_at: now }));
  await localPutMany(resource, records);
  await queueOutbox({ resource, op: "bulk-update", id: null, payload: updates });
  if (coopId) trySyncSoon(resource, coopId);
}

async function localSupplyCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("supplies", [record]);
  await queueOutbox({ resource: "supplies", op: "create", id: record.id, payload: record });
  trySyncSoon("supplies", payload.coop_id);
  return record;
}
async function localSupplyUpdate(id, payload) {
  const existing = await localGetOne("supplies", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("supplies", [record]);
  await queueOutbox({ resource: "supplies", op: "update", id, payload });
  trySyncSoon("supplies", payload.coop_id || (existing && existing.coop_id));
  return record;
}
async function localSupplyDelete(id, coopId) {
  const existing = await localGetOne("supplies", id);
  const now = new Date().toISOString();
  await localPutMany("supplies", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "supplies", op: "delete", id, payload: null });
  trySyncSoon("supplies", coopId);
}

async function localSupplyProductCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("supply_products", [record]);
  await queueOutbox({ resource: "supply_products", op: "create", id: record.id, payload: record });
  trySyncSoon("supply_products", payload.coop_id);
  return record;
}
async function localSupplyProductUpdate(id, payload) {
  const existing = await localGetOne("supply_products", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("supply_products", [record]);
  await queueOutbox({ resource: "supply_products", op: "update", id, payload });
  trySyncSoon("supply_products", payload.coop_id || (existing && existing.coop_id));
}
async function localSupplyProductDelete(id, coopId) {
  const existing = await localGetOne("supply_products", id);
  const now = new Date().toISOString();
  await localPutMany("supply_products", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "supply_products", op: "delete", id, payload: null });
  trySyncSoon("supply_products", coopId);
}

async function localBeddingCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("bedding", [record]);
  await queueOutbox({ resource: "bedding", op: "create", id: record.id, payload: record });
  trySyncSoon("bedding", payload.coop_id);
  return record;
}
async function localBeddingUpdate(id, payload) {
  const existing = await localGetOne("bedding", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("bedding", [record]);
  await queueOutbox({ resource: "bedding", op: "update", id, payload });
  trySyncSoon("bedding", payload.coop_id || (existing && existing.coop_id));
  return record;
}
async function localBeddingDelete(id, coopId) {
  const existing = await localGetOne("bedding", id);
  const now = new Date().toISOString();
  await localPutMany("bedding", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "bedding", op: "delete", id, payload: null });
  trySyncSoon("bedding", coopId);
}

async function localHatchCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("hatches", [record]);
  await queueOutbox({ resource: "hatches", op: "create", id: record.id, payload: record });
  trySyncSoon("hatches", payload.coop_id);
  return record;
}
async function localHatchUpdate(id, payload) {
  const existing = await localGetOne("hatches", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("hatches", [record]);
  await queueOutbox({ resource: "hatches", op: "update", id, payload });
  trySyncSoon("hatches", payload.coop_id || (existing && existing.coop_id));
  return record;
}
async function localHatchDelete(id, coopId) {
  const existing = await localGetOne("hatches", id);
  const now = new Date().toISOString();
  await localPutMany("hatches", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "hatches", op: "delete", id, payload: null });
  trySyncSoon("hatches", coopId);
}

async function localNoteCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("notes", [record]);
  await queueOutbox({ resource: "notes", op: "create", id: record.id, payload: record });
  trySyncSoon("notes", payload.coop_id);
  return record;
}
async function localNoteUpdate(id, payload) {
  const existing = await localGetOne("notes", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("notes", [record]);
  await queueOutbox({ resource: "notes", op: "update", id, payload });
  trySyncSoon("notes", payload.coop_id || (existing && existing.coop_id));
  return record;
}
async function localNoteDelete(id, coopId) {
  const existing = await localGetOne("notes", id);
  const now = new Date().toISOString();
  await localPutMany("notes", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "notes", op: "delete", id, payload: null });
  trySyncSoon("notes", coopId);
}

async function localBirdLogCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("bird_logs", [record]);
  await queueOutbox({ resource: "bird_logs", op: "create", id: record.id, payload: record });
  trySyncSoon("bird_logs", payload.coop_id);
  return record;
}
async function localBirdLogUpdate(id, payload) {
  const existing = await localGetOne("bird_logs", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("bird_logs", [record]);
  await queueOutbox({ resource: "bird_logs", op: "update", id, payload });
  trySyncSoon("bird_logs", payload.coop_id || (existing && existing.coop_id));
  return record;
}
async function localBirdLogDelete(id, coopId) {
  const existing = await localGetOne("bird_logs", id);
  const now = new Date().toISOString();
  await localPutMany("bird_logs", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "bird_logs", op: "delete", id, payload: null });
  trySyncSoon("bird_logs", coopId);
}

async function localBirdCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("birds", [record]);
  await queueOutbox({ resource: "birds", op: "create", id: record.id, payload: record });
  trySyncSoon("birds", payload.coop_id);
  return record;
}
async function localBirdUpdate(id, payload) {
  const existing = await localGetOne("birds", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("birds", [record]);
  await queueOutbox({ resource: "birds", op: "update", id, payload });
  trySyncSoon("birds", payload.coop_id || (existing && existing.coop_id));
  return record;
}
async function localBirdDelete(id, coopId) {
  const existing = await localGetOne("birds", id);
  const now = new Date().toISOString();
  await localPutMany("birds", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "birds", op: "delete", id, payload: null });
  await clearPendingPhoto(id); // no point uploading a photo for a bird that's gone
  // If this bird came from a hatching clutch, un-name it there too -- the
  // clutch's pending-to-name queue should reflect that this chick no longer
  // has a bird record, not silently think it's still resolved.
  if (existing && existing.hatch_id) {
    const h = await localGetOne("hatches", existing.hatch_id);
    if (h) await localHatchUpdate(h.id, { named_count: Math.max(0, (Number(h.named_count) || 0) - 1) });
  }
  trySyncSoon("birds", coopId);
}

/** Same as localBulkDelete, but for birds specifically -- preserves the
 * hatch-clutch reconciliation that individual bird deletion already does
 * (un-naming a chick in its originating clutch's pending queue), grouped by
 * clutch so several chicks from the same batch decrement it once by the
 * right amount rather than each reading a stale count before the others
 * have written theirs. */
async function localBulkDeleteBirds(ids, coopId) {
  const now = new Date().toISOString();
  const existing = await Promise.all(ids.map(id => localGetOne("birds", id)));
  const records = ids.map((id, i) => ({ ...(existing[i] || { id }), deleted_at: now, updated_at: now }));
  await localPutMany("birds", records);
  await queueOutbox({ resource: "birds", op: "bulk-delete", id: null, payload: ids });
  await Promise.all(ids.map(id => clearPendingPhoto(id)));
  const hatchDecrements = {};
  existing.forEach(b => { if (b && b.hatch_id) hatchDecrements[b.hatch_id] = (hatchDecrements[b.hatch_id] || 0) + 1; });
  await Promise.all(Object.entries(hatchDecrements).map(async ([hatchId, n]) => {
    const h = await localGetOne("hatches", hatchId);
    if (h) await localHatchUpdate(h.id, { named_count: Math.max(0, (Number(h.named_count) || 0) - n) });
  }));
  if (coopId) trySyncSoon("birds", coopId);
}

async function localCoopCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("coops", [record]);
  await queueOutbox({ resource: "coops", op: "create", id: record.id, payload: record });
  trySyncSoon("coops", null);
  return record;
}
async function localCoopUpdate(id, payload) {
  const existing = await localGetOne("coops", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("coops", [record]);
  await queueOutbox({ resource: "coops", op: "update", id, payload });
  trySyncSoon("coops", null);
  return record;
}
async function localCoopDelete(id) {
  const existing = await localGetOne("coops", id);
  const now = new Date().toISOString();
  await localPutMany("coops", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "coops", op: "delete", id, payload: null });
  // The server hard-deletes everything under this coop in one shot -- clean
  // up the same local records so nothing orphaned lingers in IndexedDB.
  const db = await openLocalDb();
  for (const store of ["birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches"]) {
    const all = await localGetAll(store, id);
    const tx = db.transaction(store, "readwrite");
    all.forEach(r => tx.objectStore(store).delete(r.id));
    await idbDone(tx);
  }
  trySyncSoon("coops", null);
}

// ---------- Fully offline export/import ----------
// This reads/writes IndexedDB directly with zero server contact. The server-
// side .zip export/import (Coops settings page) is still the better format
// for a serious long-term archive -- real photo files, not base64 -- but it
// needs a connection. This is the "100% standalone" path: works with none.

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
function dataUriToBlob(dataUri) { return fetch(dataUri).then(res => res.blob()); }

/** A not-yet-uploaded local photo is used first (guaranteed available with
 * zero network); otherwise, if this bird has a server-hosted photo, try
 * fetching it -- works if we happen to be online, quietly gives up if not. */
async function birdPhotoToDataUri(bird) {
  const pending = await getPendingPhoto(bird.id);
  if (pending && pending.blob) return blobToDataUri(pending.blob);
  if (bird.photo) {
    try {
      const res = await fetch(mediaUrl(bird.photo));
      if (res.ok) return blobToDataUri(await res.blob());
    } catch (err) { /* offline or unreachable -- exported without this photo */ }
  }
  return null;
}
async function productPhotoToDataUri(product) {
  const pending = await getPendingProductPhoto(product.id);
  if (pending && pending.blob) return blobToDataUri(pending.blob);
  if (product.photo) {
    try {
      const res = await fetch(mediaUrl(product.photo));
      if (res.ok) return blobToDataUri(await res.blob());
    } catch (err) { /* offline or unreachable -- exported without this photo */ }
  }
  return null;
}

async function buildLocalExportBundle(coopId) {
  const coop = await localGetOne("coops", coopId);
  const bundle = { version: 1, exported_at: todayStr(), offline_export: true, coop };
  for (const table of ["birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "supply_products"]) {
    const rows = await localGetAll(table, coopId);
    if (table === "birds") {
      for (const r of rows) r.photo = await birdPhotoToDataUri(r);
    } else if (table === "supply_products") {
      for (const r of rows) r.photo = await productPhotoToDataUri(r);
    }
    bundle[table] = rows;
  }
  return bundle;
}

const LAST_BACKUP_KEY = "coopLedgerLastLocalBackupAt";
function recordLocalBackup() { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); renderLocalOnlyBadge(); }
function daysSinceLastBackup() {
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  if (!raw) return Infinity;
  return (Date.now() - Number(raw)) / (24 * 60 * 60 * 1000);
}



/** The better offline backup: same data as the .json export, but photos
 * become real binary files in a photos/ folder instead of base64 text
 * embedded inline -- base64 inflates a photo by roughly a third, and doing
 * that for every bird and product photo in one giant JSON text file is
 * exactly what was making that export unwieldy for anyone with a lot of
 * photographed data. A zip compresses on top of that too. Entirely
 * client-side (JSZip, bundled locally, cached for offline use), so this
 * works with zero connection the same as the .json export always has. */
// Desktop Chrome/Edge only (Windows, Mac, Linux, ChromeOS) -- Android has no
// system file picker that maps to this API at all, on any browser, so this
// is never available there, including inside the wrapped Android app.
const SYNC_FOLDER_SUPPORTED = "showDirectoryPicker" in window;

async function getSyncFolderHandle() {
  if (!SYNC_FOLDER_SUPPORTED) return null;
  const db = await openLocalDb();
  const tx = db.transaction(["sync_folder"], "readonly");
  const row = await idbRequest(tx.objectStore("sync_folder").get("handle"));
  return row ? row.handle : null;
}
async function setSyncFolderHandle(handle) {
  const db = await openLocalDb();
  const tx = db.transaction(["sync_folder"], "readwrite");
  if (handle) tx.objectStore("sync_folder").put({ key: "handle", handle });
  else tx.objectStore("sync_folder").delete("handle");
}

/** True only if we can write without showing a permission prompt right
 * now -- queryPermission never prompts, it just reports the current state.
 * Used to decide whether an automatic background save can proceed silently
 * versus needing the user to actively grant access again first. */
async function syncFolderHasWriteAccess(handle) {
  if (!handle) return false;
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch (err) {
    return false;
  }
}
/** requestPermission, unlike queryPermission, can prompt -- but only when
 * called from a real user gesture (a click), which is why this is never
 * used for the automatic background save path, only the manual button. */
async function requestSyncFolderWriteAccess(handle) {
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch (err) {
    return false;
  }
}

async function writeBackupToSyncFolder(coopId) {
  const handle = await getSyncFolderHandle();
  if (!handle) throw new Error("No synced folder is set up yet.");
  if (!(await syncFolderHasWriteAccess(handle)) && !(await requestSyncFolderWriteAccess(handle))) {
    throw new Error("Permission to write to that folder wasn't granted.");
  }
  const { blob, filename } = await buildLocalExportZipBlob(coopId);
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  recordLocalBackup();
  return filename;
}

/** Populates the Synced Folder card's status text and buttons -- separate
 * from the main render since it depends on async handle/permission checks
 * that the initial synchronous innerHTML build can't wait on. */
async function refreshSyncFolderUi() {
  const statusEl = document.getElementById("syncFolderStatus");
  const buttonsEl = document.getElementById("syncFolderButtons");
  if (!statusEl || !buttonsEl) return; // not currently on this page
  const pickNewFolder = async () => {
    try {
      const newHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      await setSyncFolderHandle(newHandle);
      showToast(`Synced to "${newHandle.name}"`, "create");
      refreshSyncFolderUi();
    } catch (err) {
      if (err.name !== "AbortError") alert("Couldn't set up that folder: " + err.message); // AbortError just means the picker was closed without choosing anything
    }
  };
  const handle = await getSyncFolderHandle();
  if (!handle) {
    statusEl.textContent = "No folder set up yet.";
    buttonsEl.innerHTML = `<button class="btn btn-confirm" id="chooseSyncFolderBtn">📁 Choose folder...</button>`;
    document.getElementById("chooseSyncFolderBtn").addEventListener("click", pickNewFolder);
    return;
  }
  const hasAccess = await syncFolderHasWriteAccess(handle);
  statusEl.innerHTML = `Synced to: <strong style="color:var(--text)">${esc(handle.name)}</strong>${hasAccess ? "" : ` <span style="color:var(--gold)">-- needs permission confirmed again</span>`}`;
  buttonsEl.innerHTML = `
    <button class="btn btn-confirm" id="saveToSyncFolderBtn">💾 Save backup now</button>
    <button class="btn ghost" id="changeSyncFolderBtn">Change folder</button>
    <button class="btn btn-close" id="disconnectSyncFolderBtn">Disconnect</button>
  `;
  document.getElementById("saveToSyncFolderBtn").addEventListener("click", async (e) => {
    if (!currentCoopId) { alert("Select a coop first."); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Saving...";
    try {
      const filename = await writeBackupToSyncFolder(currentCoopId);
      showToast(`Saved ${filename}`, "create");
      refreshSyncFolderUi();
    } catch (err) {
      alert("Couldn't save: " + err.message);
    }
    btn.disabled = false;
    btn.textContent = originalText;
  });
  document.getElementById("changeSyncFolderBtn").addEventListener("click", pickNewFolder);
  document.getElementById("disconnectSyncFolderBtn").addEventListener("click", async () => {
    await setSyncFolderHandle(null);
    showToast("Synced folder disconnected", "delete");
    refreshSyncFolderUi();
  });
}

async function buildLocalExportZipBlob(coopId) {
  const bundle = await buildLocalExportBundle(coopId);
  const zip = new JSZip();
  const photosFolder = zip.folder("photos");
  for (const bird of bundle.birds || []) {
    if (bird.photo && typeof bird.photo === "string" && bird.photo.startsWith("data:")) {
      const filename = `bird-${bird.id}.jpg`; // every photo in this app is re-encoded to JPEG on upload, so the extension is always safe to assume
      photosFolder.file(filename, await dataUriToBlob(bird.photo));
      bird.photo = `photos/${filename}`;
    }
  }
  for (const product of bundle.supply_products || []) {
    if (product.photo && typeof product.photo === "string" && product.photo.startsWith("data:")) {
      const filename = `product-${product.id}.jpg`;
      photosFolder.file(filename, await dataUriToBlob(product.photo));
      product.photo = `photos/${filename}`;
    }
  }
  zip.file("data.json", JSON.stringify(bundle, null, 2));
  const zipBlob = await zip.generateAsync({ type: "blob" });
  const safeName = (bundle.coop.name || "coop").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { blob: zipBlob, filename: `${safeName}-backup-${todayStr()}.zip` };
}

async function exportLocalZip(coopId) {
  const { blob, filename } = await buildLocalExportZipBlob(coopId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  recordLocalBackup();
}

function toCsvValue(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return (s.includes(",") || s.includes('"') || s.includes("\n")) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowsToCsv(rows, fields) {
  const lines = [fields.join(",")];
  for (const row of rows) lines.push(fields.map(f => toCsvValue(row[f])).join(","));
  return lines.join("\r\n");
}

/** Plain-text CSVs for a spreadsheet, one file per table -- not a backup
 * (there's no import path for this, and it can't hold photos), just a
 * quick way to get the data into a format a spreadsheet program can open.
 * Works with zero connection, same as everything else offline. */
async function exportLocalCsv(coopId) {
  const coop = await localGetOne("coops", coopId);
  const zip = new JSZip();
  for (const table of ["birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "supply_products"]) {
    const rows = await localGetAll(table, coopId);
    if (rows.length === 0) continue;
    const fields = Object.keys(rows[0]).filter(f => f !== "coop_id" && f !== "photo");
    zip.file(`${table}.csv`, rowsToCsv(rows, fields));
  }
  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  const safeName = (coop.name || "coop").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  a.href = url;
  a.download = `${safeName}-csv-${todayStr()}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** Mirrors the server's _do_import_bundle logic exactly (fresh ids for
 * everything, remapping bird_logs.bird_id to the new bird ids) but writes to
 * IndexedDB instead of the server -- so importing a backup works fully
 * offline, with every row (and any embedded photos) queued to push out
 * whenever a connection actually shows up. */
async function importLocalBundle(bundle) {
  const src = bundle.coop || {};
  const newCoop = await localCoopCreate({
    name: (src.name || "Imported Coop").trim(),
    notes: src.notes || "",
    created_date: src.created_date || todayStr(),
    settings: src.settings || "{}",
  });
  const birdIdMap = {};
  const productIdMap = {};
  const createFns = {
    eggs: localEggCreate, expenses: localExpenseCreate, bedding: localBeddingCreate,
    notes: localNoteCreate, supplies: localSupplyCreate, bird_logs: localBirdLogCreate, hatches: localHatchCreate,
  };
  // Birds and supply_products first (so their id maps exist), then
  // everything else, bird_logs and supplies last -- same reasoning as the
  // server: bird_logs needs bird ids remapped, supplies needs product ids
  // remapped, so both must come after the tables they reference.
  for (const table of ["birds", "supply_products", "eggs", "expenses", "bedding", "notes", "hatches", "supplies", "bird_logs"]) {
    for (const row of bundle[table] || []) {
      const oldId = row.id;
      const payload = { ...row, coop_id: newCoop.id };
      delete payload.id; delete payload.updated_at; delete payload.deleted_at;
      if (table === "bird_logs") {
        const newBirdId = birdIdMap[row.bird_id];
        if (!newBirdId) continue; // referenced bird wasn't in this export; skip it, matching server behavior
        payload.bird_id = newBirdId;
      }
      if (table === "supplies" && row.product_id) {
        payload.product_id = productIdMap[row.product_id] || null; // dangling reference (product wasn't in this export) just drops the link, same spirit as the bird_logs skip above
      }
      if (table === "birds") {
        const photoDataUri = payload.photo;
        payload.photo = null;
        const created = await localBirdCreate(payload);
        birdIdMap[oldId] = created.id;
        if (photoDataUri && typeof photoDataUri === "string" && photoDataUri.startsWith("data:")) {
          await queuePendingPhoto(created.id, await dataUriToBlob(photoDataUri));
        }
      } else if (table === "supply_products") {
        const photoDataUri = payload.photo;
        payload.photo = null;
        const created = await localSupplyProductCreate(payload);
        productIdMap[oldId] = created.id;
        if (photoDataUri && typeof photoDataUri === "string" && photoDataUri.startsWith("data:")) {
          await queuePendingProductPhoto(created.id, await dataUriToBlob(photoDataUri));
        }
      } else {
        await createFns[table](payload);
      }
    }
  }
  trySyncSoon("birds", newCoop.id);
  trySyncSoon("supply_products", newCoop.id);
  return newCoop;
}

/** True if this .zip is one of this app's own offline exports (client-side,
 * data.json + a photos/ folder), as opposed to the server-generated export
 * format, which needs the /api/coops/import.zip endpoint instead. Reading
 * this always works with zero connection -- it's just reading a local file. */
async function tryReadOfflineZipBundle(file) {
  try {
    const zip = await JSZip.loadAsync(file);
    const dataEntry = zip.file("data.json");
    if (!dataEntry) return null;
    const bundle = JSON.parse(await dataEntry.async("string"));
    if (!bundle.offline_export) return null;
    for (const bird of bundle.birds || []) {
      if (bird.photo && typeof bird.photo === "string" && bird.photo.startsWith("photos/")) {
        const entry = zip.file(bird.photo);
        bird.photo = entry ? await blobToDataUri(await entry.async("blob")) : null;
      }
    }
    for (const product of bundle.supply_products || []) {
      if (product.photo && typeof product.photo === "string" && product.photo.startsWith("photos/")) {
        const entry = zip.file(product.photo);
        product.photo = entry ? await blobToDataUri(await entry.async("blob")) : null;
      }
    }
    return bundle;
  } catch (err) {
    return null; // not a zip we recognize -- caller falls back to the server-side import path
  }
}

async function loadCoopData() {
  if (!currentCoopId) { STATE.birds = []; STATE.eggs = []; STATE.expenses = []; STATE.bedding = []; STATE.birdLogs = []; STATE.notes = []; STATE.supplies = []; STATE.hatches = []; STATE.supplyProducts = []; return []; }

  // Everything is local-first now, Birds included: eggs, expenses, supplies,
  // bedding, notes, bird_logs (health/medical records per bird), and birds
  // itself. Sync is best-effort per resource -- if one fails (offline), we
  // still read whatever's already in IndexedDB from last time, rather than
  // showing nothing, and one resource's failure can't block the others.
  const stateKeyFor = { eggs: "eggs", expenses: "expenses", supplies: "supplies", bedding: "bedding", notes: "notes", bird_logs: "birdLogs", birds: "birds", hatches: "hatches", activity_log: "activityLog", supply_products: "supplyProducts" };
  let newActivityRows = [];
  await Promise.all(Object.entries(stateKeyFor).map(async ([resource, stateKey]) => {
    if (!localOnlyMode) {
      try {
        const rows = await syncResource(resource, currentCoopId);
        if (resource === "activity_log" && rows) newActivityRows = rows;
      } catch (err) { /* offline; use what's already stored locally */ }
    }
    try {
      STATE[stateKey] = await localGetAll(resource, currentCoopId);
    } catch (err) {
      console.error(`Failed to read ${resource} from local storage:`, err);
      STATE[stateKey] = STATE[stateKey] || []; // keep whatever was already there rather than losing it
    }
  }));
  await refreshPendingPhotoUrls();
  await refreshPendingProductPhotoUrls();

  // Self-healing: before this session's fixes, the status slider and edit
  // form could leave a bag with date_emptied still set even after its
  // status was corrected back up from Empty -- a stale date that would
  // keep counting the bag as "used" in usage totals forever. Quietly
  // repairs any such record found; harmless no-op once nothing's stale.
  const staleEmptied = STATE.supplies.filter(s => s.date_emptied && s.status !== "Empty");
  if (staleEmptied.length) {
    await Promise.all(staleEmptied.map(s => localSupplyUpdate(s.id, { date_emptied: null })));
    STATE.supplies = await localGetAll("supplies", currentCoopId);
  }

  return newActivityRows;
}

async function refreshAndRender() { await loadCoopData(); renderActiveTab(); }

function showWelcomeBackSummary(rows) {
  const myName = getUserName();
  const others = rows.filter(e => e.changed_by && e.changed_by !== myName && !e.deleted_at);
  if (others.length < 2) return; // one or two things is just a normal toast's job, not a whole modal
  others.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div class="confirm-modal" style="max-width:440px;text-align:left">
      <div class="form-head"><span>While you were away</span><button class="icon-btn icon-btn-close" id="closeWelcomeBack">✕</button></div>
      <div class="dim" style="font-size:12px;margin:8px 0 12px">${others.length} change${others.length !== 1 ? "s" : ""} synced from the server:</div>
      <div class="list-stack" style="max-height:300px;overflow-y:auto">
        ${others.slice(0, 20).map(e => `<div class="list-card"><div class="list-card-main"><div><strong style="color:var(--text)">${esc(e.changed_by)}</strong> ${esc(e.summary)}</div><div class="list-card-desc dim">${relativeTime(e.updated_at)}</div></div></div>`).join("")}
      </div>
      ${others.length > 20 ? `<div class="dim" style="font-size:12px;margin-top:8px">+${others.length - 20} more -- see the full history in Settings → Activity</div>` : ""}
      <div style="margin-top:14px"><button class="btn btn-confirm" id="dismissWelcomeBack">Got it</button></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById("closeWelcomeBack").addEventListener("click", close);
  document.getElementById("dismissWelcomeBack").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

// ---------- Coop switching / header ----------
async function switchCoop(id) {
  currentCoopId = id;
  localStorage.setItem(COOP_KEY, id);
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
  renderLocalOnlyBadge();
}

/** A persistent, always-visible corner tag while running local-only --
 * the whole point is that this data lives in exactly one browser's storage
 * and nowhere else, so clearing that browser's site data, uninstalling it,
 * or losing the device loses everything with no recovery path. Easy to
 * forget once the initial "use this device only" choice is behind you --
 * this stays up as a constant, honest reminder rather than a one-time
 * warning that's easy to not think about again. Tapping it jumps straight
 * to Settings, where the actual backup (export) options live. */
const BACKUP_REMINDER_DAYS = 14;
function renderLocalOnlyBadge() {
  let badge = document.getElementById("localOnlyBadge");
  if (!localOnlyMode) {
    if (badge) badge.remove();
    return;
  }
  const overdue = daysSinceLastBackup() > BACKUP_REMINDER_DAYS;
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "localOnlyBadge";
    badge.addEventListener("click", () => {
      switchTab("settings");
      settingsSubTab = "connection";
      renderSettingsHub();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.body.appendChild(badge);
  }
  badge.className = overdue ? "local-only-badge local-only-badge-overdue" : "local-only-badge";
  badge.innerHTML = overdue
    ? `⚠️ Local only <span class="local-only-badge-sub">back up now</span>`
    : `📱 Local only <span class="local-only-badge-sub">not backed up</span>`;
  badge.title = overdue
    ? "It's been a while since your last backup, and this coop's data lives only in this browser. Clearing this browser's site data, or uninstalling/removing the browser, will permanently delete it -- tap to back it up now."
    : "This coop's data lives only in this browser. Clearing this browser's site data, or uninstalling/removing the browser, will permanently delete it -- tap to export a backup or switch to a synced server.";
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
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
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
  renderActiveTab();
}

function renderActiveTab() {
  if (activeTab === "dashboard") renderCoopHub();
  if (activeTab === "flock") renderFlockHub();
  if (activeTab === "eggs") renderEggsHub();
  if (activeTab === "expenses") renderExpenses();
  if (activeTab === "bedding") renderSupplyHub();
  if (activeTab === "settings") renderSettingsHub();
}

// ================= SETTINGS HUB (Coops / Bedding Thresholds / Year Review) =================
let settingsSubTab = "coops";

function renderSettingsHub() {
  const el = document.getElementById("panel-settings");
  const subNav = document.getElementById("settingsSubNav");
  if (!currentCoopId) settingsSubTab = (settingsSubTab === "connection") ? "connection" : "coops"; // the other sections need an active coop to mean anything
  const subs = currentCoopId
    ? [{ id: "coops", label: "Coops" }, { id: "connection", label: "Connection" }, { id: "activity", label: "Activity" }, { id: "defaults", label: "Defaults" }]
    : [{ id: "coops", label: "Coops" }, { id: "connection", label: "Connection" }];
  subNav.innerHTML = subs.map(s => `<button class="range-btn ${settingsSubTab === s.id ? "active" : ""}" data-sub="${s.id}">${s.label}</button>`).join("");
  el.innerHTML = `<div id="settingsContent"></div>`;
  subNav.querySelectorAll("[data-sub]").forEach(b => b.addEventListener("click", () => { settingsSubTab = b.dataset.sub; renderSettingsHub(); }));
  if (settingsSubTab === "coops") renderCoopsSection();
  else if (settingsSubTab === "connection") renderConnectionSection();
  else if (settingsSubTab === "activity") renderActivityLogSection();
  else if (settingsSubTab === "defaults") renderDefaultsSection();
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
            <div class="list-card-desc dim">${relativeTime(e.updated_at)}</div>
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

    ${SYNC_FOLDER_SUPPORTED ? `
    <div class="card" style="margin-top:16px" id="syncFolderCard">
      <div class="card-title">Synced folder</div>
      <div class="dim" style="font-size:12px;margin-bottom:10px" id="syncFolderStatus">Checking...</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Point this at a folder that Dropbox, Google Drive, OneDrive, or anything similar already watches on this device, and a backup can be saved straight into it -- no account or setup with any specific provider needed here, since whatever syncs that folder handles getting it off this device on its own.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap" id="syncFolderButtons"></div>
    </div>
    ` : `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Synced folder</div>
      <div class="dim" style="font-size:12px">Not available in this browser -- this needs a Chromium-based desktop browser (Chrome or Edge on Windows, Mac, Linux, or ChromeOS). It isn't available on Android in any browser, including this app if installed there, since Android has no matching system file picker for it. Exporting a backup manually and saving it into a synced folder yourself works everywhere as an alternative.</div>
    </div>
    `}

    <div class="card" style="margin-top:16px">
      <div class="card-title">Your name</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Used to label changes when syncing with someone else -- so "Alex added an egg entry" shows up on their device instead of a generic notice. Leave blank to skip attribution; per-device, not synced anywhere itself.</div>
      <div style="display:flex;gap:8px">
        <input id="userNameInput" placeholder="e.g. Alex" value="${esc(getUserName())}" style="flex:1">
        <button class="btn btn-confirm" id="saveUserNameBtn">✓ Save</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">How this app runs</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Switch anytime -- nothing is lost either way. Turning sync on later automatically pushes out everything you did while local-only.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ${localOnlyMode ? "btn-confirm" : "ghost"}" id="modeLocalBtn">📱 Local only</button>
        <button class="btn ${!localOnlyMode ? "btn-confirm" : "ghost"}" id="modeSyncBtn">☁️ Sync with a server</button>
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
      <div class="card-title">Local-first sync</div>
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

    <div class="card" style="margin-top:16px">
      <div class="card-title">Failed login attempts</div>
      <div class="dim" style="font-size:12px;margin-bottom:8px">Most recent 100 -- name and code as typed, not confirmed to belong to anyone.</div>
      <div id="failedLoginsList" class="dim" style="font-size:12px">Loading...</div>
    </div>
    `}

    <div class="card" style="margin-top:16px">
      <div class="card-title">Diagnostics</div>
      <div id="diagText" class="dim" style="font-size:11px;font-family:'JetBrains Mono',monospace;line-height:1.8;white-space:pre-wrap">${esc(buildDiagnosticsText())}</div>
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
    renderConnectionSection();
  });
  if (SYNC_FOLDER_SUPPORTED) refreshSyncFolderUi();
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
    if (currentCoopId) refreshAndRender();
  });

  if (localOnlyMode) return; // nothing else on this page applies in local-only mode

  document.getElementById("saveConnBtn").addEventListener("click", async () => {
    if (!getUserName()) {
      showToast("Set your name above first", "delete");
      document.getElementById("userNameInput").focus();
      return;
    }
    setServerUrl(document.getElementById("conn_url").value);
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
    const failedLoginsEl = document.getElementById("failedLoginsList");
    if (failedLoginsEl) {
      try {
        const attempts = await apiGet("/api/auth/failed-logins");
        failedLoginsEl.innerHTML = attempts.length === 0 ? "None" : attempts.map(a => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
            <span>${esc(a.name_attempted || "(no name)")} <span class="mono dim" style="font-size:11px">${esc(a.code_attempted || "")}</span></span>
            <span class="dim" style="font-size:11px;text-align:right">${esc(a.ip)}<br>${relativeTime(a.attempted_at)}</span>
          </div>`).join("");
      } catch (err) {
        failedLoginsEl.textContent = "Couldn't load -- offline?";
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
}

const LOCAL_FIRST_RESOURCES = ["eggs", "expenses", "supplies", "bedding", "notes", "bird_logs", "birds", "coops", "hatches", "activity_log", "supply_products"];
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

async function refreshSyncStatus() {
  const statusEl = document.getElementById("syncStatus");
  if (!statusEl) return;
  const outbox = await getOutbox();
  const pendingPhotos = await getAllPendingPhotos();
  const pending = outbox.filter(o => LOCAL_FIRST_RESOURCES.includes(o.resource)).length + pendingPhotos.length;
  const perResource = currentCoopId
    ? await Promise.all(LOCAL_FIRST_RESOURCES.map(async r => ({ resource: r, lastSync: await getLastSync(r, r === "coops" ? null : currentCoopId) })))
    : [];
  const successTimes = perResource.map(x => x.lastSync).filter(Boolean);
  const oldestSuccess = successTimes.length ? successTimes.sort()[0] : null; // earliest of all of them -- the more conservative, honest answer
  const sseLabel = { off: `<span style="color:var(--text-dim)">off</span>`, connecting: `<span style="color:var(--gold)">connecting...</span>`, connected: `<span style="color:var(--sage)">● connected</span>`, error: `<span style="color:var(--rust)">reconnecting...</span>`, unsupported: `<span style="color:var(--text-dim)">not supported by this browser</span>` }[sseStatus] || sseStatus;
  statusEl.innerHTML = `
    <div>${pending ? `<strong style="color:var(--gold)">${pending} change${pending !== 1 ? "s" : ""} waiting to sync</strong>` : `<span style="color:var(--sage)">Up to date</span>`}</div>
    <div style="margin-top:4px">Live updates: ${sseLabel}</div>
    <div style="margin-top:4px">Last sync attempt: ${relativeTime(getLastSyncAttempt())}</div>
    <div>Last successful server sync: ${relativeTime(oldestSuccess)}</div>
    <details style="margin-top:6px"><summary style="cursor:pointer">Per-resource detail</summary>
      <div style="margin-top:4px;font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.7">
        ${perResource.map(x => `${x.resource}: ${relativeTime(x.lastSync)}`).join("<br>")}
      </div>
    </details>
  `;
}

function getCoopDefaults() {
  const s = getCoopSettings();
  return { eggPrice: s.default_egg_price != null ? s.default_egg_price : "", pricePerLb: s.default_price_per_lb != null ? s.default_price_per_lb : "" };
}

function renderDefaultsSection() {
  const el = document.getElementById("settingsContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const d = getCoopDefaults();
  el.innerHTML = `
    <div class="card">
      <div class="card-title">Default values</div>
      <div class="dim" style="font-size:12px;margin-bottom:14px">Auto-filled into new egg and bird entries so you don't have to re-type them each time. Leave blank for no default. Editing an existing entry never overwrites its own saved value.</div>
      <div class="grid-form">
        <label class="field"><span>Default value per egg ($)</span><input type="number" step="0.01" id="def_egg_price" placeholder="e.g. 0.50" value="${d.eggPrice}"></label>
        <label class="field"><span>Default value per lb ($)</span><input type="number" step="0.01" id="def_price_lb" placeholder="e.g. 5.00" value="${d.pricePerLb}"></label>
      </div>
      <div style="margin-top:14px"><button class="btn btn-confirm" id="saveDefaults">✓ Save defaults</button></div>
    </div>
  `;
  document.getElementById("saveDefaults").addEventListener("click", async () => {
    const settings = getCoopSettings();
    const eggPrice = document.getElementById("def_egg_price").value;
    const priceLb = document.getElementById("def_price_lb").value;
    settings.default_egg_price = eggPrice === "" ? null : Number(eggPrice);
    settings.default_price_per_lb = priceLb === "" ? null : Number(priceLb);
    await localCoopUpdate(currentCoopId, { settings: JSON.stringify(settings) });
    showToast("Defaults saved", "update");
    await loadCoops();
    renderDefaultsSection();
  });
}

/** "$X collected + $Y sold" when a real sale has washed out part of the
 * estimate, otherwise just the plain collected value -- so the breakdown
 * only shows up when there's actually something to explain, rather than
 * cluttering every card for someone who's never logged a sale. */
function valueBreakdownHtml(estimateAfterWashout, actualSold) {
  if (actualSold > 0) return `${fmtMoney(estimateAfterWashout)} collected + ${fmtMoney(actualSold)} sold`;
  return `${fmtMoney(estimateAfterWashout)} value`;
}

function meatProcessedValue(count, weight, value) {
  if (count === 0) return "No birds processed";
  if (weight > 0) return `${weight.toFixed(1)} lb · ${fmtMoney(value)}`;
  return `${count} bird${count !== 1 ? "s" : ""}`;
}

function renderAllTimeStatsSection() {
  const el = document.getElementById("coopSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const s = computeStats();
  const coop = STATE.coops.find(c => c.id === currentCoopId);
  const totalBirdsAdded = STATE.birds.length;
  const totalCleanouts = STATE.bedding.filter(b => b.entry_type === "Full Clean-out").length;
  const catTotals = {};
  STATE.expenses.filter(x => x.entry_type !== "income").forEach(x => { catTotals[x.category] = (catTotals[x.category] || 0) + (Number(x.amount) || 0); });
  const usage = feedBeddingUsageInRange(STATE.supplies, null);
  const layerFeedSpendAll = STATE.expenses.filter(x => x.category === "Layer Feed" && x.entry_type !== "income").reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
  const meatFeedSpendAll = STATE.expenses.filter(x => x.category === "Meat Feed" && x.entry_type !== "income").reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
  const costPerLbLayerFeed = usage.layerFeedLbs > 0 ? layerFeedSpendAll / usage.layerFeedLbs : null;
  const costPerLbMeatFeed = usage.meatFeedLbs > 0 ? meatFeedSpendAll / usage.meatFeedLbs : null;
  const beddingSpendAll = STATE.expenses.filter(x => x.category === "Bedding" && x.entry_type !== "income").reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
  const costPerCuFtBedding = usage.beddingCuFt > 0 ? beddingSpendAll / usage.beddingCuFt : null;
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:12px">All-time totals — ${esc(coop ? coop.name : "")}</div>
    <div class="dim" style="font-size:12px;margin-bottom:14px">Everything this coop has ever logged, no date range -- things that only ever add up, not things like Active Birds that go up and down day to day (that lives on the Coop tab). For a specific year's breakdown (by category, by clean-out area, etc.), use Year Review instead.</div>
    <div class="grid-stats-2">
      <div class="stat"><div class="stat-label">Total birds added, all time</div><div class="stat-value">${totalBirdsAdded}</div><div class="stat-sub">${s.layers + s.meatActive} currently active</div></div>
      <div class="stat tone-slate"><div class="stat-label">Losses, all time</div><div class="stat-value">${s.lossesAll}</div><div class="stat-sub">${s.lossesThisYear} this year</div></div>
      <div class="stat tone-gold"><div class="stat-label">Eggs collected, all time</div><div class="stat-value">${s.totalEggs}</div><div class="stat-sub">${(s.totalEggs / 12).toFixed(1)} dozen · ${valueBreakdownHtml(s.eggIncomeAll, s.eggActualIncomeAll)}</div></div>
      <div class="stat tone-sage"><div class="stat-label">Meat processed, all time</div><div class="stat-value">${meatProcessedValue(s.processed, s.totalWeight, s.meatTotalValueAll)}</div><div class="stat-sub">${s.processed > 0 ? `${s.processed} bird${s.processed !== 1 ? "s" : ""} · ${valueBreakdownHtml(s.meatIncomeAll, s.meatActualIncomeAll)}` : ""}</div></div>
      <div class="stat tone-slate"><div class="stat-label">Spent, all time</div><div class="stat-value">${fmtMoney(s.totalExpenses)}</div><div class="stat-sub">${fmtMoney(s.thisMonth)} this month</div></div>
      <div class="stat tone-gold"><div class="stat-label">Value produced, all time</div><div class="stat-value">${fmtMoney(s.incomeAll)}</div><div class="stat-sub">eggs + meat + other income</div></div>
      <div class="stat ${s.netAll >= 0 ? "tone-sage" : ""}" style="${s.netAll < 0 ? "border-left-color:var(--danger)" : ""}"><div class="stat-label">Net savings, all time</div><div class="stat-value">${fmtMoney(s.netAll)}</div><div class="stat-sub">value − spend</div></div>
      <div class="stat tone-gold"><div class="stat-label">Full clean-outs, all time</div><div class="stat-value">${totalCleanouts}</div><div class="stat-sub">across ${getBeddingAreas().length} tracked area${getBeddingAreas().length !== 1 ? "s" : ""}</div></div>
      <div class="stat tone-gold"><div class="stat-label">Layer feed used, all time</div><div class="stat-value">${usage.layerFeedLbs.toFixed(0)} lb</div><div class="stat-sub">${costPerLbLayerFeed !== null ? fmtMoney(costPerLbLayerFeed) + "/lb" : "no cost data yet"}</div></div>
      <div class="stat tone-rust"><div class="stat-label">Meat feed used, all time</div><div class="stat-value">${usage.meatFeedLbs.toFixed(0)} lb</div><div class="stat-sub">${costPerLbMeatFeed !== null ? fmtMoney(costPerLbMeatFeed) + "/lb" : "no cost data yet"}</div></div>
      <div class="stat tone-slate"><div class="stat-label">Bedding used, all time</div><div class="stat-value">${usage.beddingCuFt.toFixed(1)} cu ft</div><div class="stat-sub">${costPerCuFtBedding !== null ? fmtMoney(costPerCuFtBedding) + "/cu ft" : "no cost data yet"}</div></div>
      ${STATE.hatches.length > 0 ? `
      <div class="stat tone-gold"><div class="stat-label">Chicks hatched, all time</div><div class="stat-value">${s.chicksHatchedAll}</div><div class="stat-sub">across ${STATE.hatches.length} clutch${STATE.hatches.length !== 1 ? "es" : ""}</div></div>
      <div class="stat tone-rust"><div class="stat-label">Lost from hatching, all time</div><div class="stat-value">${s.hatchLossAll}</div><div class="stat-sub">${s.hatchClearAll} clear · ${s.hatchQuitAll} quit · ${s.hatchFailedAll} failed to hatch</div></div>
      ` : ""}
    </div>
    ${(s.costPerDozenLayers !== null || s.costPerLbMeat !== null) ? `<div class="note-box" style="margin-top:14px">
      ${s.costPerDozenLayers !== null ? `Feed cost per dozen eggs: <strong style="color:var(--text)">${fmtMoney(s.costPerDozenLayers)}</strong><br>` : ""}
      ${s.costPerLbMeat !== null ? `Feed cost per lb of meat: <strong style="color:var(--text)">${fmtMoney(s.costPerLbMeat)}</strong><br>` : ""}
      Tag Feed expenses by flock in the Finances tab to sharpen these.
    </div>` : ""}
    ${Object.keys(catTotals).length > 0 ? `
    <div class="chart-grid" style="margin-top:16px">
      <div class="card"><div class="card-title">Spend by category, all time</div><div class="chart-box"><canvas id="allTimeCatChart"></canvas></div></div>
    </div>
    ` : ""}
  `;
  if (Object.keys(catTotals).length > 0) {
    const catLabels = Object.keys(catTotals);
    new Chart(document.getElementById("allTimeCatChart"), {
      type: "pie",
      data: { labels: catLabels, datasets: [{ data: catLabels.map(l => catTotals[l]), backgroundColor: PIE_COLORS }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } } } }
    });
  }
}

function renderProductsSection() {
  const el = document.getElementById("supplySubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const categoryOrder = ["Layer Feed", "Meat Feed", "Treats", "Bedding"];
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:4px">Saved Products</div>
    <div class="dim" style="font-size:12px;margin-bottom:14px">Every product you've photographed or named, grouped the same way the Inventory tab is. Add new ones here, or from the picker when you're actually logging a bag -- either way this is the page for renaming, updating the usual quantity/description, or cleaning up ones you don't need anymore.</div>
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
                  <div class="list-card" style="border-left:4px solid var(--${catTone})">
                    ${productPhotoUrl(p) ? `<div class="thumb-clickable" data-view-photo="${esc(productPhotoUrl(p))}" style="width:48px;height:48px;border-radius:6px;overflow:hidden;flex:0 0 auto;cursor:zoom-in"><img src="${productPhotoUrl(p)}" style="width:100%;height:100%;object-fit:cover"></div>` : `<div style="width:48px;height:48px;border-radius:6px;flex:0 0 auto;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;font-size:20px">📦</div>`}
                    <div class="list-card-main">
                      <div style="font-weight:700">${esc(p.brand || cat)}</div>
                      <div class="list-card-desc dim">${p.default_quantity != null ? `usually ${p.default_quantity} ${esc(p.default_unit || "")}` : "no usual quantity set"}${p.default_description ? ` · "${esc(p.default_description)}"` : ""}</div>
                      ${(inStock > 0 || used > 0) ? `<div class="list-card-desc dim">${inStock > 0 ? `${inStock} in stock` : ""}${inStock > 0 && used > 0 ? " · " : ""}${used > 0 ? `${used} used up` : ""}</div>` : ""}
                    </div>
                    <div class="list-card-side">
                      <button class="icon-btn" data-settings-edit-product="${p.id}" title="Rename or update">✎</button>
                      <button class="icon-btn" data-settings-remove-product="${p.id}" title="Remove">🗑</button>
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
    showPhotoLightbox(el2.dataset.viewPhoto);
  }));
  el.querySelectorAll("[data-add-product-cat]").forEach(btn => btn.addEventListener("click", () => openProductModal(null, btn.dataset.addProductCat)));
  el.querySelectorAll("[data-settings-edit-product]").forEach(btn => btn.addEventListener("click", () => {
    const product = STATE.supplyProducts.find(p => p.id === btn.dataset.settingsEditProduct);
    openProductModal(product, product.category);
  }));
  el.querySelectorAll("[data-settings-remove-product]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.settingsRemoveProduct;
    if (!(await showConfirmDialog("Remove this saved product? Any bags already using its photo will lose it too, not just future ones -- this can't be undone."))) return;
    await localSupplyProductDelete(id, currentCoopId);
    STATE.supplyProducts = await localGetAll("supply_products", currentCoopId);
    showToast("Product removed", "delete");
    renderProductsSection();
  }));
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
  openModal(renderProductEditFormHtml(editingProduct, category, true), () => {
    editingProductId = null;
    newProductFormOpen = false;
    newProductCategory = null;
  });
  const deleteBtn = document.getElementById("deleteProduct");
  if (deleteBtn) deleteBtn.addEventListener("click", () => confirmAndDelete(
    "Remove this saved product? Any bags already using its photo will lose it too, not just future ones -- this can't be undone.",
    () => localSupplyProductDelete(editingProduct.id, currentCoopId),
    "Product removed",
    async () => { STATE.supplyProducts = await localGetAll("supply_products", currentCoopId); renderProductsSection(); }
  ));
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
        brand, default_quantity: qtyVal ? Number(qtyVal) : null, default_unit: unitVal || null, default_description: descVal || null,
      });
      productId = editingProduct.id;
    } else {
      const created = await localSupplyProductCreate({
        coop_id: currentCoopId, category, brand, last_used_at: todayStr(),
        default_quantity: qtyVal ? Number(qtyVal) : null, default_unit: unitVal || null, default_description: descVal || null,
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
  document.getElementById("cancelNewProduct").addEventListener("click", () => closeModal());
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
    // tag reflects the rename instead of silently going stale.
    const renamedBirdUpdates = [];
    areas.forEach((oldName, i) => {
      const newName = newAreas[i];
      if (newName && newName !== oldName) {
        STATE.birds.filter(b => b.location === oldName).forEach(b => renamedBirdUpdates.push(localBirdUpdate(b.id, { location: newName })));
      }
    });
    if (renamedBirdUpdates.length > 0) await Promise.all(renamedBirdUpdates);
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

// ================= NOTES =================
let editingNoteId = null;
let notesFiltersOpen = false;
let noteFilters = { category: "", search: "" };

function renderNotesSection() {
  const el = document.getElementById("flockSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }

  const allGroups = {};
  STATE.notes.forEach(n => { const cat = n.category || "General"; (allGroups[cat] = allGroups[cat] || []).push(n); });
  const categoryNames = Object.keys(allGroups).sort();

  const search = noteFilters.search.trim().toLowerCase();
  const filteredNotes = STATE.notes.filter(n =>
    (!noteFilters.category || (n.category || "General") === noteFilters.category)
    && (!search || (n.title || "").toLowerCase().includes(search) || (n.body || "").toLowerCase().includes(search))
  );
  const groups = {};
  filteredNotes.forEach(n => { const cat = n.category || "General"; (groups[cat] = groups[cat] || []).push(n); });
  const shownCategoryNames = Object.keys(groups).sort();
  const anyFilter = noteFilters.category || noteFilters.search;

  el.innerHTML = `
    <div class="dim" style="font-size:12px;margin-bottom:12px">
      A place for things worth remembering about this coop that don't fit anywhere else — processing timelines, feed amounts, breed quirks, whatever you'd otherwise have to look up again. Tap a category below to add another note to it.
    </div>

    ${categoryNames.length > 0 ? `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
      ${categoryNames.map(c => `<button class="pill-btn" data-pill-cat="${esc(c)}">${esc(c)} (${allGroups[c].length})</button>`).join("")}
      <button class="pill-btn pill-btn-new" data-pill-cat="__new__">+ New category</button>
    </div>` : ""}

    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${filteredNotes.length} of ${STATE.notes.length} shown</div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost small" id="toggleNoteFilters">Filters${anyFilter ? " (on)" : ""} ${notesFiltersOpen ? "▾" : "▸"}</button>
        <button class="btn" id="toggleNoteForm">+ Add note</button>
      </div>
    </div>

    ${notesFiltersOpen ? `
    <div class="form-block" style="padding:12px 16px">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
        <label class="field"><span>Category</span><select id="filterNoteCategory"><option value="">All categories</option>${categoryNames.map(c => `<option value="${esc(c)}" ${noteFilters.category === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
        <label class="field"><span>Search</span><input id="filterNoteSearch" placeholder="Search titles and notes" value="${esc(noteFilters.search)}"></label>
      </div>
      ${anyFilter ? `<div style="margin-top:10px"><button class="btn ghost small" id="clearNoteFilters">Clear filters</button></div>` : ""}
    </div>
    ` : ""}

    ${filteredNotes.length === 0 ? `<div class="card"><div class="empty">${STATE.notes.length === 0 ? "No notes yet." : "No notes match these filters."}</div></div>` : shownCategoryNames.map(cat => `
      <div class="flock-section-header" style="margin-top:18px">${esc(cat)}</div>
      <div class="list-stack">
        ${groups[cat].map(n => `
          <div class="list-card" data-edit="${n.id}" style="cursor:pointer;flex-direction:column;align-items:stretch">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div style="font-weight:700">${esc(n.title || "Untitled")}</div>
              <button class="icon-btn" data-del="${n.id}" onclick="event.stopPropagation()">🗑</button>
            </div>
            <div class="dim" style="white-space:pre-wrap;margin-top:4px;font-size:13px">${esc(n.body || "")}</div>
          </div>`).join("")}
      </div>
    `).join("")}
  `;

  el.querySelectorAll("[data-pill-cat]").forEach(p => p.addEventListener("click", () => openNoteModal(null, p.dataset.pillCat === "__new__" ? "" : p.dataset.pillCat)));
  document.getElementById("toggleNoteForm").addEventListener("click", () => openNoteModal(null, null));
  document.getElementById("toggleNoteFilters").addEventListener("click", () => { notesFiltersOpen = !notesFiltersOpen; renderNotesSection(); });

  el.querySelectorAll("[data-edit]").forEach(card => card.addEventListener("click", () => openNoteModal(STATE.notes.find(n => n.id === card.dataset.edit), null)));
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!(await showConfirmDialog("Delete this note?"))) return;
    await localNoteDelete(b.dataset.del, currentCoopId);
    showToast("Note deleted", "delete");
    if (editingNoteId === b.dataset.del) editingNoteId = null;
    await loadCoopData();
    renderNotesSection();
  }));
  const filterCatEl = document.getElementById("filterNoteCategory");
  // Fires on selection (not per-keystroke), so no re-render-while-typing focus issue.
  if (filterCatEl) filterCatEl.addEventListener("change", (e) => { noteFilters.category = e.target.value; renderNotesSection(); });
  const filterSearchEl = document.getElementById("filterNoteSearch");
  // Uses "change" (fires on Enter/blur) rather than "input", since re-rendering
  // the whole section on every keystroke would keep yanking focus out of the field.
  if (filterSearchEl) filterSearchEl.addEventListener("change", (e) => { noteFilters.search = e.target.value; renderNotesSection(); });
  const clearFiltersBtn = document.getElementById("clearNoteFilters");
  if (clearFiltersBtn) clearFiltersBtn.addEventListener("click", () => { noteFilters = { category: "", search: "" }; renderNotesSection(); });
}

function noteFormHtml(editing, presetCategory) {
  const allGroups = {};
  STATE.notes.forEach(n => { const cat = n.category || "General"; (allGroups[cat] = allGroups[cat] || []).push(n); });
  const categoryNames = Object.keys(allGroups).sort();
  return `
    <div class="form-head">${editing ? "Edit note" : "Add a note"}</div>
    <div class="grid-form">
      <label class="field"><span>Category</span><input id="n_category" list="noteCategories" placeholder="e.g. Meat Birds, Feed, General" value="${editing ? esc(editing.category || "") : esc(presetCategory || "")}"></label>
      <label class="field"><span>Title</span><input id="n_title" placeholder="e.g. Processing age" value="${editing ? esc(editing.title || "") : ""}"></label>
    </div>
    <datalist id="noteCategories">${categoryNames.map(c => `<option value="${esc(c)}">`).join("")}</datalist>
    <label class="field" style="margin-top:10px"><span>Note</span><textarea id="n_body" rows="4" placeholder="e.g. Cornish Cross are typically processed around 8 weeks — go by weight and behavior, not just the calendar.">${editing ? esc(editing.body || "") : ""}</textarea></label>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveNote">${editing ? "✓ Save changes" : "+ Add note"}</button>
      ${editing ? `<button class="btn btn-close" id="deleteNote">🗑 Delete</button>` : ""}
    </div>
  `;
}

function openNoteModal(editing, presetCategory) {
  editingNoteId = editing ? editing.id : null;
  openModal(noteFormHtml(editing, presetCategory), () => { editingNoteId = null; });
  if (!editing) { const titleInput = document.getElementById("n_title"); if (titleInput) titleInput.focus(); }
  document.getElementById("saveNote").addEventListener("click", async () => {
    const title = document.getElementById("n_title").value.trim();
    const body = document.getElementById("n_body").value.trim();
    if (!title && !body) return;
    const payload = { coop_id: currentCoopId, category: document.getElementById("n_category").value.trim() || "General", title, body, created_date: todayStr() };
    if (editing) await localNoteUpdate(editing.id, payload);
    else await localNoteCreate(payload);
    showToast(editing ? "Note updated" : "Note added", editing ? "update" : "create");
    closeModal();
    await loadCoopData();
    renderNotesSection();
  });
  const deleteBtn = document.getElementById("deleteNote");
  if (deleteBtn) deleteBtn.addEventListener("click", () => confirmAndDelete(
    "Delete this note?",
    () => localNoteDelete(editing.id, currentCoopId),
    "Note deleted",
    async () => { await loadCoopData(); renderNotesSection(); }
  ));
}

// ================= COOPS =================
function renderCoopsSection() {
  const el = document.getElementById("settingsContent");
  el.innerHTML = `
    <div class="toolbar"><div class="dim">${STATE.coops.length} coop${STATE.coops.length !== 1 ? "s" : ""}</div></div>

    <div class="form-block">
      <div class="form-head">Create a coop</div>
      <div class="grid-form">
        <label class="field"><span>Name</span><input id="c_name" placeholder="e.g. Home Flock"></label>
        <label class="field"><span>Notes</span><input id="c_notes" placeholder="optional"></label>
      </div>
      <div style="margin-top:12px"><button class="btn btn-confirm" id="createCoop">+ Create coop</button></div>
    </div>

    <div class="form-block">
      <div class="form-head">Import a coop</div>
      <div class="dim" style="font-size:12px;margin-bottom:10px">A .json import works with no connection at all -- everything (including any photos) lands in this device's local storage and syncs to the server whenever one's reachable. A .zip import needs a live connection, since unzipping and writing photo files happens server-side. Either way, this always creates a brand-new coop — it never overwrites an existing one.</div>
      <input type="file" id="importFile" accept=".zip,application/zip,application/json">
    </div>

    <div class="note-box" style="margin-bottom:12px"><strong style="color:var(--text)">Export (.zip)</strong> is the backup to use -- everything, with real photo files in a photos/ folder, and it works the same whether you're online or offline. <strong style="color:var(--text)">Spreadsheet (.csv)</strong> is not a backup -- it's just for viewing or analyzing the data in a spreadsheet program, can't be re-imported, and doesn't include photos.</div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
      ${STATE.coops.length === 0 ? `<div class="empty">No coops yet — create one above to get started.</div>` : STATE.coops.map(c => `
        <div class="coop-card ${c.id === currentCoopId ? "active" : ""}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="display:flex;gap:8px;align-items:center">
              <input class="coop-icon-select" data-coop="${c.id}" title="Icon" value="${esc(coopIcon(c))}" maxlength="10" style="width:44px;text-align:center;font-size:20px;padding:6px 4px">
              <div>
                <div class="card-title" style="margin-bottom:2px">${esc(c.name)}</div>
                <div class="dim" style="font-size:11px">created ${fmtDate(c.created_date)}</div>
              </div>
            </div>
            ${c.id === currentCoopId ? `<span class="stamp tone-sage">Active</span>` : ""}
          </div>
          ${c.notes ? `<div class="dim" style="font-size:12px;margin-top:8px">${esc(c.notes)}</div>` : ""}
          <div style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap">
            ${c.id !== currentCoopId ? `<button class="btn small" data-select="${c.id}">Switch to this coop</button>` : ""}
            <button class="btn ghost small" data-rename="${c.id}" data-name="${esc(c.name)}">Rename</button>
            <button class="btn ghost small" data-export-offline-zip="${c.id}">📦 Export (.zip)</button>
            <button class="btn ghost small" data-export-csv="${c.id}" title="Not a backup -- plain CSV for a spreadsheet, no photos, can't be re-imported">Spreadsheet (.csv)</button>
            <button class="btn btn-close small" data-delete="${c.id}" data-name="${esc(c.name)}">Delete</button>
          </div>
        </div>`).join("")}
    </div>
  `;

  document.getElementById("createCoop").addEventListener("click", async () => {
    const name = document.getElementById("c_name").value.trim();
    if (!name) return;
    const coop = await localCoopCreate({ name, notes: document.getElementById("c_notes").value, created_date: todayStr(), settings: "{}" });
    showToast(`"${name}" created`, "create");
    await loadCoops();
    await switchCoop(coop.id);
    switchTab("dashboard");
  });

  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
      let coop;
      if (isZip) {
        // Two different zip formats share the .zip extension: this app's
        // own offline export (client-side, no connection needed) and the
        // server-generated one (needs the server to unzip and write photo
        // files). Try reading it as the offline format first -- if that
        // doesn't recognize it, it's the server format instead.
        const offlineBundle = await tryReadOfflineZipBundle(file);
        if (offlineBundle) {
          coop = await importLocalBundle(offlineBundle);
          await loadCoops();
        } else {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch(apiUrl("/api/coops/import.zip"), { method: "POST", headers: authHeaders(), body: formData });
          if (!res.ok) throw new Error((await res.json()).detail || "Import failed");
          coop = await res.json();
          await loadCoops();
        }
      } else {
        // JSON imports go straight into IndexedDB -- works with zero
        // connection, same as the offline zip format above.
        const bundle = JSON.parse(await file.text());
        coop = await importLocalBundle(bundle);
        await loadCoops();
      }
      showToast(`"${coop.name}" imported`, "create");
      await switchCoop(coop.id);
      switchTab("dashboard");
    } catch (err) {
      alert("Could not import that file — make sure it's a backup exported from this app.\n\n" + err.message);
    }
    e.target.value = "";
  });

  el.querySelectorAll("[data-export-offline-zip]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    const originalText = b.textContent;
    b.textContent = "Exporting...";
    try {
      await exportLocalZip(b.dataset.exportOfflineZip);
      showToast("Backup downloaded", "create");
    } catch (err) {
      alert("Export failed: " + err.message);
    }
    b.disabled = false;
    b.textContent = originalText;
  }));
  el.querySelectorAll("[data-export-csv]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    const originalText = b.textContent;
    b.textContent = "Exporting...";
    try {
      await exportLocalCsv(b.dataset.exportCsv);
      showToast("Spreadsheet files downloaded", "create");
    } catch (err) {
      alert("Export failed: " + err.message);
    }
    b.disabled = false;
    b.textContent = originalText;
  }));

  el.querySelectorAll(".coop-icon-select").forEach(sel => sel.addEventListener("change", async (e) => {
    const coopId = sel.dataset.coop;
    const coop = STATE.coops.find(c => c.id === coopId);
    let settings = {};
    try { settings = coop.settings ? JSON.parse(coop.settings) : {}; } catch { settings = {}; }
    settings.icon = e.target.value;
    await localCoopUpdate(coopId, { settings: JSON.stringify(settings) });
    showToast("Icon updated", "update");
    await loadCoops();
    updateHeader();
    renderCoopsSection();
  }));
  el.querySelectorAll("[data-select]").forEach(b => b.addEventListener("click", async () => { await switchCoop(b.dataset.select); switchTab("dashboard"); }));
  el.querySelectorAll("[data-rename]").forEach(b => b.addEventListener("click", async () => {
    const newName = prompt("Rename this coop:", b.dataset.name);
    if (!newName || !newName.trim() || newName.trim() === b.dataset.name) return;
    await localCoopUpdate(b.dataset.rename, { name: newName.trim() });
    showToast(`Renamed to "${newName.trim()}"`, "update");
    await loadCoops();
    updateHeader();
    renderCoopsSection();
  }));
  el.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", async () => {
    const confirmed = await showTypeToConfirmDialog(
      `Delete "${b.dataset.name}" and ALL of its birds, eggs, expenses, and bedding logs? This can't be undone — export it first if you want a copy.`,
      b.dataset.name,
      "Delete forever"
    );
    if (!confirmed) return;
    await localCoopDelete(b.dataset.delete);
    showToast(`"${b.dataset.name}" deleted`, "delete");
    await loadCoops();
    if (currentCoopId === b.dataset.delete) {
      currentCoopId = null;
      localStorage.removeItem(COOP_KEY);
      if (STATE.coops.length) await switchCoop(STATE.coops[0].id);
    }
    updateHeader();
    updateTabVisibility();
    renderSettingsHub();
  }));
}

// ================= DASHBOARD =================
/** Feed and bedding "used" is measured from supplies that hit Empty within a
 * date range -- a bag going empty is the closest thing to a real
 * consumption-completed event the data has (as opposed to purchase date,
 * which only tells you when something was bought, not when it ran out).
 * A bag bought in one period and finished in a later one attributes its
 * full quantity to whichever period it was actually finished in. */
function feedBeddingUsageInRange(supplies, days) {
  const emptied = supplies.filter(s => s.date_emptied && withinRange(s.date_emptied, days));
  const sumFor = (cat) => emptied.filter(s => s.category === cat).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  // Bags that are open right now but not yet fully emptied contribute their
  // partial consumption too -- otherwise feed genuinely being eaten from an
  // open bag would show as zero "used" until someone finally drags the
  // status slider all the way down, which could lag reality by weeks.
  const activeSum = (cat) => supplies.filter(s => s.category === cat && !s.date_emptied)
    .reduce((sum, s) => sum + (Number(s.quantity) || 0) * (STATUS_USED_FRACTION[s.status] ?? 0), 0);
  return {
    layerFeedLbs: sumFor("Layer Feed") + activeSum("Layer Feed"),
    meatFeedLbs: sumFor("Meat Feed") + activeSum("Meat Feed"),
    beddingCuFt: sumFor("Bedding") + activeSum("Bedding"),
  };
}
/** Same idea, but a running cumulative total rather than a per-bucket sum --
 * feed/bedding usage is inherently sporadic (a bag can sit at Full for
 * weeks and then suddenly get marked Empty), so summing per-bucket would
 * mostly show zero with occasional spikes, which reads as "nothing's being
 * used" during the gaps even though birds are eating from it the whole
 * time. A running total that steps up on each real event and holds flat
 * between them is the honest picture -- same pattern as the existing
 * cumulative meat chart, which has the identical sporadic-event shape. */
const STATUS_USED_FRACTION = { "Full": 0, "3/4": 0.25, "1/2": 0.5, "1/4": 0.75, "Empty": 1 };

function feedBeddingCumulativeSeries(supplies, days) {
  const mode = pickBucketMode(days);
  const emptiedEvents = supplies.filter(s => s.date_emptied).sort((a, b) => a.date_emptied.localeCompare(b.date_emptied));
  const emptiedInRange = days ? emptiedEvents.filter(s => withinRange(s.date_emptied, days)) : emptiedEvents;

  let runningLayer = 0, runningMeat = 0, runningBedding = 0;
  const layerSparse = {}, meatSparse = {}, beddingSparse = {};
  emptiedInRange.forEach(s => {
    const qty = Number(s.quantity) || 0;
    if (s.category === "Layer Feed") runningLayer += qty;
    else if (s.category === "Meat Feed") runningMeat += qty;
    else if (s.category === "Bedding") runningBedding += qty;
    const k = bucketLabel(s.date_emptied, mode);
    layerSparse[k] = runningLayer; meatSparse[k] = runningMeat; beddingSparse[k] = runningBedding;
  });

  // Partial consumption from bags that are open right now but not yet fully
  // emptied -- there's no history of exactly when a bag's status changed
  // from Full to 3/4 to 1/2 etc, only what it currently is, so this can't
  // be placed accurately anywhere earlier on the timeline. The honest thing
  // is one "as of today" point that includes it on top of the confirmed
  // total, rather than either undercounting real usage by ignoring it, or
  // faking a smooth historical ramp that was never actually observed.
  const activeSum = (cat) => supplies.filter(s => s.category === cat && !s.date_emptied)
    .reduce((sum, s) => sum + (Number(s.quantity) || 0) * (STATUS_USED_FRACTION[s.status] ?? 0), 0);
  const todayKey = bucketLabel(todayStr(), mode);
  layerSparse[todayKey] = runningLayer + activeSum("Layer Feed");
  meatSparse[todayKey] = runningMeat + activeSum("Meat Feed");
  beddingSparse[todayKey] = runningBedding + activeSum("Bedding");

  const labels = [...new Set([...Object.keys(layerSparse), ...Object.keys(meatSparse), ...Object.keys(beddingSparse)])].sort();
  const fillForward = (sparse) => { let last = 0; return labels.map(l => { if (sparse[l] !== undefined) last = sparse[l]; return last; }); };
  return { labels, layer: fillForward(layerSparse), meat: fillForward(meatSparse), bedding: fillForward(beddingSparse) };
}
/** Which of Layer Feed / Meat Feed / Bedding are actually running low right
 * now -- "low" means the best (fullest) currently-active supply item for
 * that category is down to 1/4 or Empty, i.e. there's no fuller backup
 * bag waiting. A near-empty bag with a full one behind it isn't urgent. */
function lowSupplyCategories(supplies) {
  const STATUS_RANK = { "Full": 4, "3/4": 3, "1/2": 2, "1/4": 1, "Empty": 0 };
  const TONE_FOR_RANK = { 2: "gold", 1: "rust", 0: "danger" };
  const results = [];
  for (const cat of ["Layer Feed", "Meat Feed", "Bedding"]) {
    // Never tracked at all for this category -- nothing to be "out" of if
    // it was never being tracked in the first place. Distinct from "was
    // tracked, now fully consumed," which genuinely is worth a warning.
    if (!supplies.some(s => s.category === cat)) continue;
    const active = supplies.filter(s => s.category === cat && !s.date_emptied);
    if (active.length === 0) { results.push({ category: cat, status: "Empty", tone: "danger" }); continue; }
    const recognized = active.filter(s => s.status in STATUS_RANK);
    if (recognized.length === 0) continue; // unrecognized/missing status on every item -- don't guess, don't alarm
    const best = recognized.reduce((a, b) => STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b : a);
    const rank = STATUS_RANK[best.status];
    if (rank <= 2) results.push({ category: cat, status: best.status, tone: TONE_FOR_RANK[rank] });
  }
  return results;
}

/** Weighted average price across a specific set of egg entries, falling
 * back to the coop's default only when there's nothing logged to average.
 * This is the actual fix for the sale-washout bug: a flat "current default"
 * price silently misstates value whenever eggs were logged at a different
 * price than the default (deliberately, or because the default changed
 * since), so washing out a sale needs to use what those eggs were ACTUALLY
 * logged at, not today's default. */
function weightedAvgEggPrice(eggEntries, fallback) {
  const totalCount = eggEntries.reduce((s, e) => s + (Number(e.count) || 0), 0);
  if (totalCount <= 0) return fallback;
  const totalValue = eggEntries.reduce((s, e) => s + (Number(e.count) || 0) * (Number(e.price_per_egg) || 0), 0);
  return totalValue / totalCount;
}
/** Same idea, for meat -- weighted by dressed weight instead of count. */
function weightedAvgMeatPrice(birdEntries, fallback) {
  const totalWeight = birdEntries.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  if (totalWeight <= 0) return fallback;
  const totalValue = birdEntries.reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);
  return totalValue / totalWeight;
}

function computeStats() {
  const active = STATE.birds.filter(b => b.status === "Active");
  const layers = active.filter(b => b.type === "Layer" || b.type === "Dual Purpose").length;
  const meatActive = active.filter(b => b.type === "Meat").length;
  const processed = STATE.birds.filter(b => b.status === "Processed");
  const totalWeight = processed.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  const totalEggs = STATE.eggs.reduce((s, e) => s + (Number(e.count) || 0), 0);
  const last7 = STATE.eggs.filter(e => withinRange(e.date, 7)).reduce((s, e) => s + (Number(e.count) || 0), 0);
  const last30 = STATE.eggs.filter(e => withinRange(e.date, 30)).reduce((s, e) => s + (Number(e.count) || 0), 0);
  const totalExpenses = STATE.expenses.filter(x => x.entry_type !== "income").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const now = new Date();
  const isThisMonth = (d) => { const dt = new Date(d + "T00:00:00"); return dt.getMonth() === now.getMonth() && dt.getFullYear() === now.getFullYear(); };
  const isThisYear = (d) => { const dt = new Date(d + "T00:00:00"); return dt.getFullYear() === now.getFullYear(); };
  const thisMonth = STATE.expenses.filter(x => x.entry_type !== "income" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  // Now that Feed is split into Layer Feed / Meat Feed categories, the category
  // itself tells us which flock it's for -- no need to also gate on for_type.
  // Building Materials/Equipment are excluded on purpose: one-time capital costs
  // that would spike this number in whatever month you built or bought
  // something, rather than reflecting the ongoing cost of keeping birds fed.
  const layerAttributable = STATE.expenses.filter(x => x.category === "Layer Feed" && x.entry_type !== "income").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const meatAttributable = STATE.expenses.filter(x => x.category === "Meat Feed" && x.entry_type !== "income").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const costPerDozenLayers = totalEggs > 0 ? layerAttributable / (totalEggs / 12) : null;
  const costPerLbMeat = totalWeight > 0 ? meatAttributable / totalWeight : null;

  const eggIncomeOf = (e) => (Number(e.count) || 0) * (Number(e.price_per_egg) || 0);
  const meatIncomeOf = (b) => (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0);
  const rawEggIncomeAll = STATE.eggs.reduce((s, e) => s + eggIncomeOf(e), 0);
  const rawEggIncomeMonth = STATE.eggs.filter(e => isThisMonth(e.date)).reduce((s, e) => s + eggIncomeOf(e), 0);
  const rawMeatIncomeAll = processed.reduce((s, b) => s + meatIncomeOf(b), 0);
  const rawMeatIncomeMonth = processed.filter(b => b.harvest_date && isThisMonth(b.harvest_date)).reduce((s, b) => s + meatIncomeOf(b), 0);

  // A real sale washes out its equivalent from the estimated "value
  // produced" -- using a weighted average of what was ACTUALLY logged for
  // eggs/meat in the relevant scope, not the coop's current default price.
  // The default is only a fallback for when nothing's been logged at all;
  // using it as the wash-out price otherwise silently misstates value
  // whenever someone logs at a price different from the default (deliberately,
  // or because the default has since changed). Without washing out at all,
  // a real sale would be counted twice: once as an estimate when collected,
  // again as real income when sold.
  const defaults = getCoopDefaults();
  const eggPriceAll = weightedAvgEggPrice(STATE.eggs, Number(defaults.eggPrice) || 0);
  const meatPriceAll = weightedAvgMeatPrice(processed, Number(defaults.pricePerLb) || 0);
  const incomeEntries = STATE.expenses.filter(x => x.entry_type === "income");
  // Each sale washes out using its OWN locked-in price, captured once at
  // the moment it was logged -- not a single average recomputed over
  // everything that currently exists. Without this, collecting more eggs
  // later would silently re-price a sale that already happened, using
  // eggs it couldn't possibly have come from. Entries logged before this
  // fix (with no locked-in price yet) fall back to the current weighted
  // average, same as before.
  const washedEggValueAll = incomeEntries.filter(x => x.category === "Egg Sale").reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : eggPriceAll), 0);
  const washedEggValueMonth = incomeEntries.filter(x => x.category === "Egg Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : eggPriceAll), 0);
  const washedMeatValueAll = incomeEntries.filter(x => x.category === "Meat Sale").reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : meatPriceAll), 0);
  const washedMeatValueMonth = incomeEntries.filter(x => x.category === "Meat Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : meatPriceAll), 0);
  const eggIncomeAll = Math.max(0, rawEggIncomeAll - washedEggValueAll);
  const eggIncomeMonth = Math.max(0, rawEggIncomeMonth - washedEggValueMonth);
  const meatIncomeAll = Math.max(0, rawMeatIncomeAll - washedMeatValueAll);
  const meatIncomeMonth = Math.max(0, rawMeatIncomeMonth - washedMeatValueMonth);
  const eggActualIncomeAll = incomeEntries.filter(x => x.category === "Egg Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const eggActualIncomeMonth = incomeEntries.filter(x => x.category === "Egg Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const meatActualIncomeAll = incomeEntries.filter(x => x.category === "Meat Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const meatActualIncomeMonth = incomeEntries.filter(x => x.category === "Meat Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const otherActualIncomeAll = incomeEntries.filter(x => x.category !== "Egg Sale" && x.category !== "Meat Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const otherActualIncomeMonth = incomeEntries.filter(x => x.category !== "Egg Sale" && x.category !== "Meat Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const actualIncomeAll = eggActualIncomeAll + meatActualIncomeAll + otherActualIncomeAll;
  const actualIncomeMonth = eggActualIncomeMonth + meatActualIncomeMonth + otherActualIncomeMonth;
  // The true total value of eggs/meat is the leftover estimate for what's
  // still unsold PLUS the real cash for what was sold -- the wash-out only
  // exists to prevent double-counting the sold portion, not to make it
  // disappear from the total.
  const eggTotalValueAll = eggIncomeAll + eggActualIncomeAll;
  const eggTotalValueMonth = eggIncomeMonth + eggActualIncomeMonth;
  const meatTotalValueAll = meatIncomeAll + meatActualIncomeAll;
  const meatTotalValueMonth = meatIncomeMonth + meatActualIncomeMonth;
  const incomeAll = eggIncomeAll + meatIncomeAll + actualIncomeAll;
  const incomeMonth = eggIncomeMonth + meatIncomeMonth + actualIncomeMonth;
  const netAll = incomeAll - totalExpenses;
  const netMonth = incomeMonth - thisMonth;

  const deceased = STATE.birds.filter(b => b.status === "Deceased");
  const lossesAll = deceased.length;
  const lossesThisYear = deceased.filter(b => b.death_date && isThisYear(b.death_date)).length;

  const chicksHatchedAll = STATE.hatches.reduce((s, h) => s + (Number(h.hatched_count) || 0), 0);
  const hatchClearAll = STATE.hatches.reduce((s, h) => s + (Number(h.clear_count) || 0), 0);
  const hatchQuitAll = STATE.hatches.reduce((s, h) => s + (Number(h.quit_count) || 0), 0);
  const hatchFailedAll = STATE.hatches.reduce((s, h) => s + (Number(h.failed_count) || 0), 0);
  const hatchLossAll = hatchClearAll + hatchQuitAll + hatchFailedAll;

  const eggsThisMonth = STATE.eggs.filter(e => isThisMonth(e.date)).reduce((s, e) => s + (Number(e.count) || 0), 0);
  const processedThisMonth = processed.filter(b => b.harvest_date && isThisMonth(b.harvest_date)).length;
  const weightThisMonth = processed.filter(b => b.harvest_date && isThisMonth(b.harvest_date)).reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);

  return { active: active.length, layers, meatActive, processed: processed.length, totalWeight, totalEggs, last7, last30, eggsThisMonth, processedThisMonth, weightThisMonth, totalExpenses, thisMonth, costPerDozenLayers, costPerLbMeat, eggIncomeAll, eggIncomeMonth, meatIncomeAll, meatIncomeMonth, eggActualIncomeAll, eggActualIncomeMonth, meatActualIncomeAll, meatActualIncomeMonth, eggTotalValueAll, eggTotalValueMonth, meatTotalValueAll, meatTotalValueMonth, incomeAll, incomeMonth, actualIncomeAll, actualIncomeMonth, netAll, netMonth, lossesAll, lossesThisYear, chicksHatchedAll, hatchClearAll, hatchQuitAll, hatchFailedAll, hatchLossAll };
}

function allCoopYears() {
  const years = new Set();
  STATE.birds.forEach(b => { ["hatch_date", "acquired_date", "harvest_date", "death_date"].forEach(f => { if (b[f]) years.add(b[f].slice(0, 4)); }); });
  STATE.eggs.forEach(e => { if (e.date) years.add(e.date.slice(0, 4)); });
  STATE.expenses.forEach(x => { if (x.date) years.add(x.date.slice(0, 4)); });
  STATE.bedding.forEach(b => { if (b.date) years.add(b.date.slice(0, 4)); });
  return [...years].sort().reverse();
}

function computeYearStats(year) {
  const inYear = (d) => d && d.slice(0, 4) === year;

  const eggsInYear = STATE.eggs.filter(e => inYear(e.date));
  const eggCount = eggsInYear.reduce((s, e) => s + (Number(e.count) || 0), 0);
  const rawEggValue = eggsInYear.reduce((s, e) => s + (Number(e.count) || 0) * (Number(e.price_per_egg) || 0), 0);

  const expensesInYear = STATE.expenses.filter(x => inYear(x.date));
  const trueExpensesInYear = expensesInYear.filter(x => x.entry_type !== "income");
  const incomeInYear = expensesInYear.filter(x => x.entry_type === "income");
  const totalExpenses = trueExpensesInYear.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const categoryBreakdown = {};
  trueExpensesInYear.forEach(x => { categoryBreakdown[x.category] = (categoryBreakdown[x.category] || 0) + (Number(x.amount) || 0); });

  const processedInYear = STATE.birds.filter(b => b.status === "Processed" && inYear(b.harvest_date));
  const processedWeight = processedInYear.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  const rawMeatValue = processedInYear.reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);

  // Same wash-out reasoning as the Coop tab's all-time figures: a real sale
  // washes out using its OWN locked-in price from the moment it was logged,
  // not a recomputed average -- so collecting more eggs/meat later in the
  // year can't reach back and re-price a sale that already happened.
  // Entries logged before this fix fall back to this year's weighted average.
  const defaults = getCoopDefaults();
  const eggPriceFallback = weightedAvgEggPrice(eggsInYear, Number(defaults.eggPrice) || 0);
  const meatPriceFallback = weightedAvgMeatPrice(processedInYear, Number(defaults.pricePerLb) || 0);
  const washedEggValue = incomeInYear.filter(x => x.category === "Egg Sale").reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : eggPriceFallback), 0);
  const washedMeatValue = incomeInYear.filter(x => x.category === "Meat Sale").reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : meatPriceFallback), 0);
  const eggValue = Math.max(0, rawEggValue - washedEggValue);
  const meatValue = Math.max(0, rawMeatValue - washedMeatValue);
  const eggActualIncome = incomeInYear.filter(x => x.category === "Egg Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const meatActualIncome = incomeInYear.filter(x => x.category === "Meat Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const otherActualIncome = incomeInYear.filter(x => x.category !== "Egg Sale" && x.category !== "Meat Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const actualIncome = eggActualIncome + meatActualIncome + otherActualIncome;
  const eggTotalValue = eggValue + eggActualIncome;
  const meatTotalValue = meatValue + meatActualIncome;

  const lossesInYear = STATE.birds.filter(b => b.status === "Deceased" && inYear(b.death_date)).length;
  const newBirdIds = new Set();
  STATE.birds.forEach(b => { if (inYear(b.acquired_date) || (inYear(b.hatch_date) && !b.acquired_date)) newBirdIds.add(b.id); });

  // Scoped by when each clutch started (individual outcomes don't carry
  // their own date, only the clutch does) -- a clutch spanning New Year's
  // counts toward the year it was set, not necessarily the year it hatched.
  const hatchesInYear = STATE.hatches.filter(h => inYear(h.date_started));
  const chicksHatched = hatchesInYear.reduce((s, h) => s + (Number(h.hatched_count) || 0), 0);
  const hatchClear = hatchesInYear.reduce((s, h) => s + (Number(h.clear_count) || 0), 0);
  const hatchQuit = hatchesInYear.reduce((s, h) => s + (Number(h.quit_count) || 0), 0);
  const hatchFailed = hatchesInYear.reduce((s, h) => s + (Number(h.failed_count) || 0), 0);
  const hatchLoss = hatchClear + hatchQuit + hatchFailed;

  const cleanoutsInYear = STATE.bedding.filter(b => b.entry_type === "Full Clean-out" && inYear(b.date));
  const cleanoutsByArea = {};
  cleanoutsInYear.forEach(b => { cleanoutsByArea[b.area] = (cleanoutsByArea[b.area] || 0) + 1; });

  const income = eggValue + meatValue + actualIncome;
  const net = income - totalExpenses;

  // Feed-only cost, same methodology as the Coop tab's all-time figure but
  // scoped to just this year's Layer/Meat Feed expenses and this year's eggs/meat.
  const layerFeedAttributable = trueExpensesInYear.filter(x => x.category === "Layer Feed").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const meatFeedAttributable = trueExpensesInYear.filter(x => x.category === "Meat Feed").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const costPerDozenLayers = eggCount > 0 ? layerFeedAttributable / (eggCount / 12) : null;
  const costPerLbMeat = processedWeight > 0 ? meatFeedAttributable / processedWeight : null;

  const suppliesEmptiedInYear = STATE.supplies.filter(s => s.date_emptied && inYear(s.date_emptied));
  let layerFeedLbs = suppliesEmptiedInYear.filter(s => s.category === "Layer Feed").reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  let meatFeedLbs = suppliesEmptiedInYear.filter(s => s.category === "Meat Feed").reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  let beddingCuFt = suppliesEmptiedInYear.filter(s => s.category === "Bedding").reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  // Only for the current year -- a bag that's currently 3/4 used but not
  // yet emptied genuinely belongs to "this year" if today is in this year,
  // the same reasoning the All-Time page already uses. For a past year this
  // wouldn't make sense (today's in-progress status isn't part of history),
  // so past years stay confirmed-emptied-only as before.
  if (year === String(new Date().getFullYear())) {
    const activeSum = (cat) => STATE.supplies.filter(s => s.category === cat && !s.date_emptied)
      .reduce((sum, s) => sum + (Number(s.quantity) || 0) * (STATUS_USED_FRACTION[s.status] ?? 0), 0);
    layerFeedLbs += activeSum("Layer Feed");
    meatFeedLbs += activeSum("Meat Feed");
    beddingCuFt += activeSum("Bedding");
  }
  const costPerLbLayerFeed = layerFeedLbs > 0 ? layerFeedAttributable / layerFeedLbs : null;
  const costPerLbMeatFeed = meatFeedLbs > 0 ? meatFeedAttributable / meatFeedLbs : null;

  return { eggCount, eggValue, totalExpenses, categoryBreakdown, processedCount: processedInYear.length, processedWeight, meatValue, lossesInYear, newBirds: newBirdIds.size, cleanoutsByArea, income, net, actualIncome, eggActualIncome, meatActualIncome, eggTotalValue, meatTotalValue, costPerDozenLayers, costPerLbMeat, layerFeedLbs, meatFeedLbs, beddingCuFt, costPerLbLayerFeed, costPerLbMeatFeed, chicksHatched, hatchClear, hatchQuit, hatchFailed, hatchLoss };
}

function renderYearReviewSection() {
  const el = document.getElementById("coopSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const years = allCoopYears();
  if (years.length === 0) { el.innerHTML = `<div class="card"><div class="empty">No dated entries yet — log some eggs, expenses, or birds first.</div></div>`; return; }
  const currentYear = String(new Date().getFullYear());
  const selectedYear = years.includes(reviewYear) ? reviewYear : (years.includes(currentYear) ? currentYear : years[0]);
  reviewYear = selectedYear;
  const s = computeYearStats(selectedYear);

  el.innerHTML = `
    <div class="toolbar">
      <div class="card-title" style="margin:0">Year in review</div>
      <select id="reviewYearSelect" style="max-width:140px">${years.map(y => `<option value="${y}" ${y === selectedYear ? "selected" : ""}>${y}</option>`).join("")}</select>
    </div>

    <div class="grid-stats-2" style="margin-bottom:16px">
      <div class="stat tone-gold"><div class="stat-label">Eggs collected</div><div class="stat-value">${s.eggCount}</div><div class="stat-sub">${(s.eggCount / 12).toFixed(1)} dozen · ${valueBreakdownHtml(s.eggValue, s.eggActualIncome)}</div></div>
      <div class="stat tone-sage"><div class="stat-label">Meat processed</div><div class="stat-value">${meatProcessedValue(s.processedCount, s.processedWeight, s.meatTotalValue)}</div><div class="stat-sub">${s.processedCount > 0 ? `${s.processedCount} bird${s.processedCount !== 1 ? "s" : ""} · ${valueBreakdownHtml(s.meatValue, s.meatActualIncome)}` : ""}</div></div>
      <div class="stat" style="${s.lossesInYear ? "border-left-color:var(--danger)" : ""}"><div class="stat-label">Losses</div><div class="stat-value">${s.lossesInYear}</div><div class="stat-sub">${s.newBirds} new bird${s.newBirds !== 1 ? "s" : ""} added</div></div>
      <div class="stat tone-slate"><div class="stat-label">Total spent</div><div class="stat-value">${fmtMoney(s.totalExpenses)}</div><div class="stat-sub">${Object.keys(s.categoryBreakdown).length} categories</div></div>
      <div class="stat tone-gold"><div class="stat-label">Value produced</div><div class="stat-value">${fmtMoney(s.income)}</div><div class="stat-sub">eggs + meat</div></div>
      <div class="stat ${s.net >= 0 ? "tone-sage" : ""}" style="${s.net < 0 ? "border-left-color:var(--danger)" : ""}"><div class="stat-label">Net for ${selectedYear}</div><div class="stat-value">${fmtMoney(s.net)}</div><div class="stat-sub">value − spend</div></div>
      <div class="stat tone-gold"><div class="stat-label">Layer feed used</div><div class="stat-value">${s.layerFeedLbs.toFixed(0)} lb</div><div class="stat-sub">${s.costPerLbLayerFeed !== null ? fmtMoney(s.costPerLbLayerFeed) + "/lb" : "no cost data yet"}</div></div>
      <div class="stat tone-rust"><div class="stat-label">Meat feed used</div><div class="stat-value">${s.meatFeedLbs.toFixed(0)} lb</div><div class="stat-sub">${s.costPerLbMeatFeed !== null ? fmtMoney(s.costPerLbMeatFeed) + "/lb" : "no cost data yet"}</div></div>
      <div class="stat tone-slate"><div class="stat-label">Bedding used</div><div class="stat-value">${s.beddingCuFt.toFixed(1)} cu ft</div><div class="stat-sub">bags emptied this year</div></div>
      ${(s.chicksHatched + s.hatchLoss) > 0 ? `
      <div class="stat tone-gold"><div class="stat-label">Chicks hatched</div><div class="stat-value">${s.chicksHatched}</div><div class="stat-sub">from clutches started this year</div></div>
      <div class="stat tone-rust"><div class="stat-label">Lost from hatching</div><div class="stat-value">${s.hatchLoss}</div><div class="stat-sub">${s.hatchClear} clear · ${s.hatchQuit} quit · ${s.hatchFailed} failed to hatch</div></div>
      ` : ""}
    </div>

    ${(s.costPerDozenLayers !== null || s.costPerLbMeat !== null) ? `<div class="note-box" style="margin-bottom:16px">
      ${s.costPerDozenLayers !== null ? `Feed cost per dozen eggs, ${selectedYear}: <strong style="color:var(--text)">${fmtMoney(s.costPerDozenLayers)}</strong><br>` : ""}
      ${s.costPerLbMeat !== null ? `Feed cost per lb of meat, ${selectedYear}: <strong style="color:var(--text)">${fmtMoney(s.costPerLbMeat)}</strong><br>` : ""}
      Tag Feed expenses by flock in the Finances tab to sharpen these.
    </div>` : ""}

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Spend by category — ${selectedYear}</div>
        ${Object.keys(s.categoryBreakdown).length === 0 ? `<div class="empty">No expenses logged this year.</div>` : `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${Object.entries(s.categoryBreakdown).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => `
            <div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(cat)}</span><span class="mono">${fmtMoney(amt)}</span></div>
          `).join("")}
        </div>`}
      </div>
      <div class="card">
        <div class="card-title">Bedding clean-outs — ${selectedYear}</div>
        ${Object.keys(s.cleanoutsByArea).length === 0 ? `<div class="empty">No full clean-outs logged this year.</div>` : `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${Object.keys(s.cleanoutsByArea).map(area => `
            <div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(area)}</span><span class="mono">${s.cleanoutsByArea[area]}×</span></div>
          `).join("")}
        </div>`}
      </div>
    </div>

    <div class="chart-grid" style="margin-top:16px">
      <div class="card"><div class="card-title">Eggs by month — ${selectedYear}</div><div class="chart-box"><canvas id="reviewEggChart"></canvas></div></div>
      <div class="card"><div class="card-title">Meat produced by month, lbs — ${selectedYear}</div><div class="chart-box"><canvas id="reviewMeatChart"></canvas></div></div>
      <div class="card"><div class="card-title">Spend by month — ${selectedYear}</div><div class="chart-box"><canvas id="reviewExpenseChart"></canvas></div></div>
      ${years.includes(String(Number(selectedYear) - 1)) ? `<div class="card"><div class="card-title">${selectedYear} vs ${Number(selectedYear) - 1}</div><div class="chart-box"><canvas id="reviewCompareChart"></canvas></div></div>` : ""}
    </div>
  `;
  document.getElementById("reviewYearSelect").addEventListener("change", (e) => { reviewYear = e.target.value; renderYearReviewSection(); });
  drawYearReviewCharts(selectedYear);
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthlyBuckets(items, year, valueFn) {
  const arr = new Array(12).fill(0);
  items.forEach(it => {
    if (it.date && it.date.slice(0, 4) === year) {
      const m = parseInt(it.date.slice(5, 7), 10) - 1;
      if (m >= 0 && m < 12) arr[m] += valueFn(it);
    }
  });
  return arr;
}

let reviewCharts = {};
function drawYearReviewCharts(year) {
  Object.values(reviewCharts).forEach(c => c && c.destroy());
  const s = computeYearStats(year);

  const eggMonthly = monthlyBuckets(STATE.eggs, year, e => Number(e.count) || 0);
  reviewCharts.eggs = new Chart(document.getElementById("reviewEggChart"), {
    type: "bar",
    data: { labels: MONTH_LABELS, datasets: [{ label: "Eggs", data: eggMonthly, backgroundColor: "#D4A017" }] },
    options: chartOpts()
  });

  const processedBirds = STATE.birds.filter(b => b.status === "Processed" && b.harvest_date);
  const meatMonthly = monthlyBuckets(processedBirds.map(b => ({ date: b.harvest_date, weight: Number(b.harvest_weight) || 0 })), year, (it) => it.weight);
  reviewCharts.meat = new Chart(document.getElementById("reviewMeatChart"), {
    type: "bar",
    data: { labels: MONTH_LABELS, datasets: [{ label: "Lbs processed", data: meatMonthly, backgroundColor: "#C1502E" }] },
    options: chartOpts((v) => `${v.toFixed(1)} lb`)
  });

  const expenseMonthly = monthlyBuckets(STATE.expenses.filter(x => x.entry_type !== "income"), year, x => Number(x.amount) || 0);
  reviewCharts.expenses = new Chart(document.getElementById("reviewExpenseChart"), {
    type: "bar",
    data: { labels: MONTH_LABELS, datasets: [{ label: "Spend", data: expenseMonthly, backgroundColor: "#7A8FA6" }] },
    options: chartOpts((v) => fmtMoney(v))
  });

  const compareCanvas = document.getElementById("reviewCompareChart");
  if (compareCanvas) {
    const lastYear = String(Number(year) - 1);
    const prev = computeYearStats(lastYear);
    // Percentage change rather than raw numbers -- egg counts (hundreds)
    // and dollar amounts don't share a sensible axis, but "% change" puts
    // every metric on the same comparable scale, which is what actually
    // shows a trend at a glance.
    const pctChange = (curr, prevVal) => prevVal === 0 ? (curr > 0 ? 100 : 0) : ((curr - prevVal) / Math.abs(prevVal)) * 100;
    const compareLabels = ["Eggs", "Meat (lb)", "Spent", "Net"];
    const compareData = [
      pctChange(s.eggCount, prev.eggCount),
      pctChange(s.processedWeight, prev.processedWeight),
      pctChange(s.totalExpenses, prev.totalExpenses),
      pctChange(s.net, prev.net),
    ];
    reviewCharts.compare = new Chart(compareCanvas, {
      type: "bar",
      data: {
        labels: compareLabels,
        datasets: [{ label: `vs ${lastYear}`, data: compareData, backgroundColor: compareData.map(v => v >= 0 ? "#8A9A5B" : "#C1502E") }]
      },
      options: { ...chartOpts((v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`), plugins: { legend: { display: false } } }
    });
  }
}

function beddingStatsFor(area) {
  const entries = STATE.bedding.filter(b => b.area === area);
  const cleanouts = entries.filter(b => b.entry_type === "Full Clean-out").sort((a, b) => b.date.localeCompare(a.date));
  const lastCleanout = cleanouts[0] || null;
  const topoffsSince = entries.filter(b => (b.entry_type === "Top-off" || b.entry_type === "Top-off + Churn" || b.entry_type === "Top-off / Churn") && (!lastCleanout || b.date > lastCleanout.date)).length;
  const lastActivity = entries.length ? entries.reduce((latest, e) => (!latest || e.date > latest.date) ? e : latest, null) : null;
  // A top-off-only visit doesn't accomplish the actual churning task, so it
  // shouldn't be able to satisfy the churn-due countdown on its own -- only
  // entries where churning genuinely happened count here. A full clean-out
  // obviously also resets it, since fresh bedding has nothing to churn yet.
  // "Top-off / Churn" (the old combined label, before this split existed)
  // is included too, so existing history keeps counting the same way it
  // always did rather than suddenly looking overdue the moment this ships.
  const churnEntries = entries.filter(b => b.entry_type === "Churn" || b.entry_type === "Top-off + Churn" || b.entry_type === "Full Clean-out" || b.entry_type === "Top-off / Churn");
  const lastChurn = churnEntries.length ? churnEntries.reduce((latest, e) => (!latest || e.date > latest.date) ? e : latest, null) : null;
  return { lastCleanout, topoffsSince, lastActivity, lastChurn };
}

function getCoopSettings() {
  const coop = STATE.coops.find(c => c.id === currentCoopId);
  if (!coop || !coop.settings) return {};
  try { return JSON.parse(coop.settings); } catch { return {}; }
}
function getBeddingAreas() {
  const s = getCoopSettings();
  return (s.bedding_areas && s.bedding_areas.length) ? s.bedding_areas : Object.keys(DEFAULT_BEDDING_THRESHOLDS);
}
function getBeddingThresholds(area) {
  const s = getCoopSettings();
  const t = (s.bedding_thresholds && s.bedding_thresholds[area]) || DEFAULT_BEDDING_THRESHOLDS[area] || { warn: 120, danger: 180 };
  return { warn: t.warn, danger: t.danger, churn: t.churn || 7 };
}

function cleanoutTone(days, area) {
  const t = getBeddingThresholds(area);
  if (days === null) return { tone: "slate", label: "No clean-out logged" };
  if (days > t.danger) return { tone: "danger", label: `${days}d since clean-out — overdue` };
  if (days > t.warn) return { tone: "gold", label: `${days}d since clean-out` };
  return { tone: "sage", label: `${days}d since clean-out` };
}

let coopSubTab = "overview";
function renderCoopHub() {
  const el = document.getElementById("panel-dashboard");
  const subs = [{ id: "overview", label: "Overview" }, { id: "review", label: "Year Review" }, { id: "alltime", label: "All-Time Stats" }];
  el.innerHTML = `
    <div class="range-select sub-nav-fixed" id="coopSubNav">
      ${subs.map(s => `<button class="range-btn ${coopSubTab === s.id ? "active" : ""}" data-coopsub="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div id="coopSubContent"></div>
  `;
  el.querySelectorAll("[data-coopsub]").forEach(b => b.addEventListener("click", () => { coopSubTab = b.dataset.coopsub; renderCoopHub(); }));
  if (coopSubTab === "overview") renderCoopOverview();
  else if (coopSubTab === "review") renderYearReviewSection();
  else if (coopSubTab === "alltime") renderAllTimeStatsSection();
}

function renderCoopOverview() {
  const el = document.getElementById("coopSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const s = computeStats();
  const currentYear = String(new Date().getFullYear());
  const ys = computeYearStats(currentYear);
  el.innerHTML = `
    <div class="section-gap">
      <div class="grid-stats-2">
        <div class="stat tone-sage"><div class="stat-label">Active Birds</div><div class="stat-value">${s.active}</div><div class="stat-sub">${s.layers} layer · ${s.meatActive} meat</div></div>
        <div class="stat tone-gold"><div class="stat-label">Value produced this month</div><div class="stat-value">${fmtMoney(s.incomeMonth)}</div><div class="stat-sub">${fmtMoney(ys.income)} this year</div></div>
        <div class="stat tone-gold"><div class="stat-label">Eggs this month</div><div class="stat-value">${s.eggsThisMonth} · ${fmtMoney(s.eggTotalValueMonth)}</div><div class="stat-sub">${valueBreakdownHtml(s.eggIncomeMonth, s.eggActualIncomeMonth)} · ${ys.eggCount} eggs this year</div></div>
        <div class="stat tone-sage"><div class="stat-label">Meat processed this month</div><div class="stat-value">${meatProcessedValue(s.processedThisMonth, s.weightThisMonth, s.meatTotalValueMonth)}</div><div class="stat-sub">${s.processedThisMonth > 0 ? valueBreakdownHtml(s.meatIncomeMonth, s.meatActualIncomeMonth) + " · " : ""}${ys.processedWeight.toFixed(1)} lb this year</div></div>
        <div class="stat tone-slate"><div class="stat-label">Spent this month</div><div class="stat-value">${fmtMoney(s.thisMonth)}</div><div class="stat-sub">${fmtMoney(ys.totalExpenses)} this year</div></div>
        <div class="stat ${s.netMonth >= 0 ? "tone-sage" : ""}" style="${s.netMonth < 0 ? "border-left-color:var(--danger)" : ""}"><div class="stat-label">Net savings this month</div><div class="stat-value">${fmtMoney(s.netMonth)}</div><div class="stat-sub">${fmtMoney(ys.net)} net this year</div></div>
      </div>

      ${(() => {
        const low = lowSupplyCategories(STATE.supplies);
        if (!low.length) return "";
        const STATUS_TEXT = { "1/2": "1/2 left", "1/4": "1/4 left", "Empty": "out" };
        const worstTone = low.some(l => l.tone === "danger") ? "var(--danger)" : low.some(l => l.tone === "rust") ? "var(--rust)" : "var(--gold)";
        return `<div class="card" style="border-color:${worstTone}">
          <div class="card-title">⚠️ Running low</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${low.map(l => `<span class="stamp tone-${l.tone}">${esc(l.category)} -- ${STATUS_TEXT[l.status] || l.status}</span>`).join("")}
          </div>
        </div>`;
      })()}

      <div class="card">
        <div class="card-title">Bedding freshness</div>
        <div style="display:flex;gap:24px;flex-wrap:wrap;padding:6px 2px">
          ${getBeddingAreas().map(area => {
            const bs = beddingStatsFor(area);
            const t = getBeddingThresholds(area);
            const daysSinceCleanout = bs.lastCleanout ? daysSince(bs.lastCleanout.date) : null;
            const daysSinceActivity = bs.lastActivity ? daysSince(bs.lastActivity.date) : null;
            const daysSinceChurn = bs.lastChurn ? daysSince(bs.lastChurn.date) : null;
            const cleanoutToneInfo = cleanoutTone(daysSinceCleanout, area);
            const daysUntilCleanout = daysSinceCleanout !== null ? t.danger - daysSinceCleanout : null;
            const daysUntilChurn = daysSinceChurn !== null ? t.churn - daysSinceChurn : null;
            const cleanoutLabel = daysUntilCleanout === null ? "no clean-out logged"
              : daysUntilCleanout < 0 ? `clean-out overdue ${-daysUntilCleanout}d`
              : daysUntilCleanout === 0 ? "clean-out due today"
              : `clean-out in ${daysUntilCleanout}d`;
            const churnTone = daysUntilChurn === null ? "slate" : daysUntilChurn <= 0 ? "gold" : "sage";
            const churnLabel = daysUntilChurn === null ? "no churn logged"
              : daysUntilChurn < 0 ? `churn overdue ${-daysUntilChurn}d`
              : daysUntilChurn === 0 ? "churn due today"
              : `churn in ${daysUntilChurn}d`;
            return `<div style="min-width:190px;display:flex;flex-direction:column;gap:4px">
              <div style="font-weight:600">${esc(area)}</div>
              <div class="dim" style="font-size:11px">Last activity: ${daysSinceActivity !== null ? daysSinceActivity + "d ago" : "never"}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">
                <span class="stamp tone-${cleanoutToneInfo.tone}">${cleanoutLabel}</span>
                <span class="stamp tone-${churnTone}">${churnLabel}</span>
              </div>
            </div>`;
          }).join("")}
        </div>
        <div class="dim" style="font-size:11px;margin-top:10px">Thresholds are per-area and adjustable in the <strong style="color:var(--text)">Settings</strong> tab.</div>
      </div>

      <div class="range-select" id="rangeSelect">
        ${RANGES.map(r => `<button class="range-btn ${chartRangeDays === r.days ? "active" : ""}" data-days="${r.days}">${r.label}</button>`).join("")}
      </div>
      ${rangeHiddenDataHint()}
      ${(() => {
        const usage = feedBeddingUsageInRange(STATE.supplies, chartRangeDays);
        const activeBirds = STATE.birds.filter(b => b.status === "Active").length;
        const feedLbs = usage.layerFeedLbs + usage.meatFeedLbs;
        if (feedLbs === 0 || activeBirds === 0) return "";
        return `<div class="dim" style="font-size:12px;margin:-4px 0 4px">Feed used per active bird, this period: <strong style="color:var(--text)">${(feedLbs / activeBirds).toFixed(2)} lb</strong> (${activeBirds} active bird${activeBirds !== 1 ? "s" : ""} currently) -- includes an estimate for bags currently open based on their status slider, not just fully emptied ones.</div>`;
      })()}

      <div class="chart-grid">
        <div class="card"><div class="card-title">Flock size over time</div><div class="chart-box"><canvas id="flockSizeChart"></canvas></div></div>
        <div class="card"><div class="card-title">Egg production</div><div class="chart-box"><canvas id="eggChart"></canvas></div></div>
        <div class="card"><div class="card-title">Cumulative meat produced (lbs)</div><div class="chart-box"><canvas id="meatChart"></canvas></div></div>
        <div class="card">
          <div class="card-title">Cumulative feed used (lbs)</div>
          <div class="dim" style="font-size:11px;margin-bottom:6px">Steps up when a bag empties; today's point also includes a partial estimate from bags currently open.</div>
          <div class="chart-box"><canvas id="feedUsedChart"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title">Cumulative bedding used (cu ft)</div>
          <div class="dim" style="font-size:11px;margin-bottom:6px">Same idea -- steps up on empty, today's point includes what's currently in progress.</div>
          <div class="chart-box"><canvas id="beddingUsedChart"></canvas></div>
        </div>
        <div class="card"><div class="card-title">Spend by category</div><div class="chart-box"><canvas id="catChart"></canvas></div></div>
        <div class="card"><div class="card-title">Value produced vs. spend over time</div><div class="chart-box"><canvas id="incomeChart"></canvas></div></div>
        <div class="card"><div class="card-title">Cumulative balance over time</div><div class="chart-box"><canvas id="cumChart"></canvas></div></div>
      </div>
    </div>
  `;
  document.getElementById("rangeSelect").addEventListener("click", (e) => {
    const btn = e.target.closest(".range-btn");
    if (!btn) return;
    chartRangeDays = btn.dataset.days === "null" ? null : Number(btn.dataset.days);
    renderCoopOverview();
  });
  const jumpBtn = document.getElementById("jumpToAll");
  if (jumpBtn) jumpBtn.addEventListener("click", () => { chartRangeDays = null; renderCoopOverview(); });
  drawCharts();
}

function rangeHiddenDataHint() {
  if (!chartRangeDays) return "";
  const hasHiddenEggs = STATE.eggs.length > 0 && !STATE.eggs.some(e => withinRange(e.date, chartRangeDays));
  const hasHiddenExpenses = STATE.expenses.length > 0 && !STATE.expenses.some(x => withinRange(x.date, chartRangeDays));
  if (!hasHiddenEggs && !hasHiddenExpenses) return "";
  return `<div class="note-box">You have entries older than this range, so the charts below look empty. <button class="btn ghost small" id="jumpToAll" style="margin-left:6px">Show All</button></div>`;
}

/** Every distinct bucket (day/week/month, matching pickBucketMode) between the
 * start of the selected range and today, paired with the actual last calendar
 * date in that bucket -- used as the "as of" reference for the flock-size
 * chart, since population is a state check (was this bird active on this day)
 * rather than a sparse event like eggs/expenses. */
function allBucketsInRange(mode, days) {
  const endStr = todayStr();
  let startStr;
  if (days) {
    startStr = addDays(endStr, -days);
  } else {
    const dates = [];
    STATE.birds.forEach(b => { const d = b.acquired_date || b.hatch_date; if (d) dates.push(d); });
    startStr = dates.length ? dates.sort()[0] : endStr;
  }
  const order = [];
  const asOf = {};
  let cursor = startStr;
  let guard = 0;
  while (cursor <= endStr && guard < 20000) {
    const key = bucketLabel(cursor, mode);
    if (!(key in asOf)) order.push(key);
    asOf[key] = cursor; // overwritten each day, so the final value is the last date in this bucket
    cursor = addDays(cursor, 1);
    guard++;
  }
  return order.map(key => ({ key, asOfDate: asOf[key] }));
}

/** Active flock size (layers vs meat) at the end of each bucket, using the
 * same shared range/bucket-mode as every other chart on this tab. A bird
 * counts as "in the flock" as of a given date if it had arrived (acquired or
 * hatched) by then and hadn't yet been processed/lost on or before that day. */
/** How many active birds existed as of a given date -- acquired/hatched by
 * then, and not yet processed or deceased by then. Shared by the flock-size
 * chart and the feed-per-bird chart, since both need "how big was the flock
 * at this point in time," not just the current count. */
function activeBirdCountAsOf(asOfDate) {
  let layers = 0, meat = 0;
  STATE.birds.forEach(b => {
    const acq = b.acquired_date || b.hatch_date;
    if (!acq || acq > asOfDate) return;
    const leftDate = b.status === "Processed" ? b.harvest_date : b.status === "Deceased" ? b.death_date : null;
    if (leftDate && leftDate <= asOfDate) return;
    if (b.type === "Meat") meat++; else layers++;
  });
  return layers + meat;
}

function computeFlockSizeSeries() {
  const mode = pickBucketMode(chartRangeDays);
  const buckets = allBucketsInRange(mode, chartRangeDays);
  const layers = [], meat = [];
  buckets.forEach(({ asOfDate }) => {
    let l = 0, m = 0;
    STATE.birds.forEach(b => {
      const acq = b.acquired_date || b.hatch_date;
      if (!acq || acq > asOfDate) return;
      const leftDate = b.status === "Processed" ? b.harvest_date : b.status === "Deceased" ? b.death_date : null;
      if (leftDate && leftDate <= asOfDate) return;
      if (b.type === "Meat") m++; else l++;
    });
    layers.push(l); meat.push(m);
  });
  return { labels: buckets.map(b => b.key), layers, meat };
}

function drawCharts() {
  Object.values(charts).forEach(c => c && c.destroy());
  const mode = pickBucketMode(chartRangeDays);

  const flockSize = computeFlockSizeSeries();
  charts.flockSize = new Chart(document.getElementById("flockSizeChart"), {
    type: "line",
    data: {
      labels: flockSize.labels,
      datasets: [
        { label: "Layers", data: flockSize.layers, borderColor: "#D4A017", backgroundColor: "#D4A01722", tension: 0.2, pointRadius: 2 },
        { label: "Meat", data: flockSize.meat, borderColor: "#C1502E", backgroundColor: "#C1502E22", tension: 0.2, pointRadius: 2 },
      ]
    },
    options: {
      ...chartOpts(),
      plugins: { legend: { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } } },
    },
  });

  const eggMap = {};
  STATE.eggs.filter(e => withinRange(e.date, chartRangeDays)).forEach(e => {
    const k = bucketLabel(e.date, mode);
    eggMap[k] = (eggMap[k] || 0) + (Number(e.count) || 0);
  });
  const eggLabels = Object.keys(eggMap).sort();
  charts.egg = new Chart(document.getElementById("eggChart"), {
    type: "line",
    data: { labels: eggLabels, datasets: [{ label: "Eggs", data: eggLabels.map(l => eggMap[l]), borderColor: "#D4A017", backgroundColor: "#D4A01733", tension: 0.25, pointRadius: 2 }] },
    options: chartOpts()
  });

  const feedBedding = feedBeddingCumulativeSeries(STATE.supplies, chartRangeDays);
  charts.feedUsed = new Chart(document.getElementById("feedUsedChart"), {
    type: "line",
    data: {
      labels: feedBedding.labels,
      datasets: [
        { label: "Layer Feed", data: feedBedding.layer, borderColor: "#D4A017", backgroundColor: "#D4A01722", stepped: true, pointRadius: 3 },
        { label: "Meat Feed", data: feedBedding.meat, borderColor: "#C1502E", backgroundColor: "#C1502E22", stepped: true, pointRadius: 3 },
      ]
    },
    options: { ...chartOpts((v) => `${v.toFixed(1)} lb`), plugins: { legend: { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } } } },
  });
  charts.beddingUsed = new Chart(document.getElementById("beddingUsedChart"), {
    type: "line",
    data: { labels: feedBedding.labels, datasets: [{ label: "Bedding (cu ft)", data: feedBedding.bedding, borderColor: "#7A8FA6", backgroundColor: "#7A8FA622", stepped: true, pointRadius: 3 }] },
    options: chartOpts((v) => `${v.toFixed(1)} cu ft`),
  });

  const catMap = {};
  STATE.expenses.filter(x => x.entry_type !== "income" && withinRange(x.date, chartRangeDays)).forEach(x => {
    catMap[x.category] = (catMap[x.category] || 0) + (Number(x.amount) || 0);
  });
  const catLabels = Object.keys(catMap);
  charts.cat = new Chart(document.getElementById("catChart"), {
    type: "pie",
    data: { labels: catLabels, datasets: [{ data: catLabels.map(l => catMap[l]), backgroundColor: PIE_COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } } } }
  });

  // Income vs. spend, bucketed the same way as the other charts
  const chartDefaults = getCoopDefaults();
  const chartEggsInRange = STATE.eggs.filter(e => withinRange(e.date, chartRangeDays));
  const chartProcessedInRange = STATE.birds.filter(b => b.status === "Processed" && b.harvest_date && withinRange(b.harvest_date, chartRangeDays));
  const chartEggPrice = weightedAvgEggPrice(chartEggsInRange, Number(chartDefaults.eggPrice) || 0);
  const chartMeatPrice = weightedAvgMeatPrice(chartProcessedInRange, Number(chartDefaults.pricePerLb) || 0);
  const incomeMap = {}, spendMap = {};
  chartEggsInRange.forEach(e => {
    const k = bucketLabel(e.date, mode);
    incomeMap[k] = (incomeMap[k] || 0) + (Number(e.count) || 0) * (Number(e.price_per_egg) || 0);
  });
  chartProcessedInRange.forEach(b => {
    const k = bucketLabel(b.harvest_date, mode);
    incomeMap[k] = (incomeMap[k] || 0) + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0);
  });
  STATE.expenses.filter(x => x.entry_type === "income" && withinRange(x.date, chartRangeDays)).forEach(x => {
    const k = bucketLabel(x.date, mode);
    const washedOut = x.category === "Egg Sale" ? (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : chartEggPrice)
      : x.category === "Meat Sale" ? (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : chartMeatPrice)
      : 0;
    incomeMap[k] = (incomeMap[k] || 0) + (Number(x.amount) || 0) - washedOut;
  });
  STATE.expenses.filter(x => x.entry_type !== "income" && withinRange(x.date, chartRangeDays)).forEach(x => {
    const k = bucketLabel(x.date, mode);
    spendMap[k] = (spendMap[k] || 0) + (Number(x.amount) || 0);
  });
  const incomeLabels = [...new Set([...Object.keys(incomeMap), ...Object.keys(spendMap)])].sort();
  charts.income = new Chart(document.getElementById("incomeChart"), {
    type: "bar",
    data: {
      labels: incomeLabels,
      datasets: [
        { label: "Value produced", data: incomeLabels.map(l => incomeMap[l] || 0), backgroundColor: "#8A9A5B" },
        { label: "Spend", data: incomeLabels.map(l => spendMap[l] || 0), backgroundColor: "#C1502E" },
      ]
    },
    options: {
      ...chartOpts((v) => fmtMoney(v)),
      plugins: { legend: { labels: { color: "#C7B9A6", font: { size: 11 } } }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}` } } },
    }
  });

  // Cumulative balance: income and spend both accumulated over time, plus the net gap between them.
  // Both series carry forward their last known total between events, so gaps read as flat rather than skipped.
  // Filtering to the selected range happens BEFORE accumulating, not after -- so a "last 7 days" view
  // genuinely starts its running total from 0 at the start of that window, rather than carrying forward
  // whatever the all-time total already was going into it.
  const spendSorted = [...STATE.expenses].filter(x => x.entry_type !== "income").sort((a, b) => a.date.localeCompare(b.date));
  const spendInRange = chartRangeDays ? spendSorted.filter(x => withinRange(x.date, chartRangeDays)) : spendSorted;
  let runningSpend = 0;
  const spendPoints = spendInRange.map(x => { runningSpend += Number(x.amount) || 0; return { date: x.date, total: runningSpend }; });
  const spendSparse = {};
  spendPoints.forEach(p => { spendSparse[bucketLabel(p.date, mode)] = p.total; });

  const allTimeEggPrice = weightedAvgEggPrice(STATE.eggs, Number(chartDefaults.eggPrice) || 0);
  const allTimeMeatPrice = weightedAvgMeatPrice(STATE.birds.filter(b => b.status === "Processed" && b.harvest_date), Number(chartDefaults.pricePerLb) || 0);
  const incomeEvents = [
    ...STATE.eggs.map(e => ({ date: e.date, amount: (Number(e.count) || 0) * (Number(e.price_per_egg) || 0) })),
    ...STATE.birds.filter(b => b.status === "Processed" && b.harvest_date).map(b => ({ date: b.harvest_date, amount: (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0) })),
    // A real sale contributes its NET effect at the date it happened: the
    // actual amount received, minus whatever it washes out of the estimate
    // above (using a weighted average of what was actually logged, not the
    // current default price) -- so the running total stays correct at every
    // point along the line, not just in the final sum.
    ...STATE.expenses.filter(x => x.entry_type === "income").map(x => {
      const washedOut = x.category === "Egg Sale" ? (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : allTimeEggPrice)
        : x.category === "Meat Sale" ? (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : allTimeMeatPrice)
        : 0;
      return { date: x.date, amount: (Number(x.amount) || 0) - washedOut };
    }),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const incomeEventsInRange = chartRangeDays ? incomeEvents.filter(e => withinRange(e.date, chartRangeDays)) : incomeEvents;
  let runningIncome = 0;
  const incomePoints = incomeEventsInRange.map(e => { runningIncome += e.amount; return { date: e.date, total: runningIncome }; });
  const incomeSparse = {};
  incomePoints.forEach(p => { incomeSparse[bucketLabel(p.date, mode)] = p.total; });

  const balanceLabels = [...new Set([...Object.keys(incomeSparse), ...Object.keys(spendSparse)])].sort();
  const fillForward = (labels, sparse) => {
    let last = 0;
    return labels.map(l => { if (sparse[l] !== undefined) last = sparse[l]; return last; });
  };
  const incomeSeries = fillForward(balanceLabels, incomeSparse);
  const spendSeries = fillForward(balanceLabels, spendSparse);
  const netSeries = balanceLabels.map((l, i) => incomeSeries[i] - spendSeries[i]);

  charts.cum = new Chart(document.getElementById("cumChart"), {
    type: "line",
    data: {
      labels: balanceLabels,
      datasets: [
        { label: "Cumulative income", data: incomeSeries, borderColor: "#8A9A5B", backgroundColor: "#8A9A5B22", tension: 0.2, pointRadius: 2 },
        { label: "Cumulative spend", data: spendSeries, borderColor: "#C1502E", backgroundColor: "#C1502E22", tension: 0.2, pointRadius: 2 },
        { label: "Net balance", data: netSeries, borderColor: "#D4A017", backgroundColor: "#D4A01722", borderDash: [5, 4], tension: 0.2, pointRadius: 2 },
      ]
    },
    options: {
      ...chartOpts((v) => fmtMoney(v)),
      plugins: { legend: { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}` } } },
    }
  });

  // Cumulative meat produced (lbs) — processing happens rarely (maybe once or twice a year for a
  // home flock), so a running total that steps up on each batch tells the story better than a bar
  // chart full of empty buckets would.
  const meatEvents = STATE.birds
    .filter(b => b.status === "Processed" && b.harvest_date && b.harvest_weight)
    .map(b => ({ date: b.harvest_date, weight: Number(b.harvest_weight) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const meatEventsInRange = chartRangeDays ? meatEvents.filter(e => withinRange(e.date, chartRangeDays)) : meatEvents;
  let runningMeat = 0;
  const meatPoints = meatEventsInRange.map(e => { runningMeat += e.weight; return { date: e.date, total: runningMeat }; });
  const meatSparse = {};
  meatPoints.forEach(p => { meatSparse[bucketLabel(p.date, mode)] = p.total; });
  const meatLabels = Object.keys(meatSparse).sort();
  const meatSeries = fillForward(meatLabels, meatSparse);
  charts.meat = new Chart(document.getElementById("meatChart"), {
    type: "line",
    data: { labels: meatLabels, datasets: [{ label: "Dressed weight", data: meatSeries, borderColor: "#C1502E", backgroundColor: "#C1502E22", stepped: true, pointRadius: 3 }] },
    options: { ...chartOpts((v) => `${v.toFixed(1)} lb`) },
  });
}

function chartOpts(yFormatter) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: yFormatter ? { label: (ctx) => yFormatter(ctx.parsed.y) } : undefined } },
    scales: {
      x: { ticks: { color: "#C7B9A6", font: { size: 10 } }, grid: { color: "#5A4B3C40" } },
      y: { ticks: { color: "#C7B9A6", font: { size: 10 } }, grid: { color: "#5A4B3C40" }, beginAtZero: true }
    }
  };
}

function loadMoreButtonHtml(totalCount, visibleCount, id = "loadMoreBtn") {
  if (totalCount <= visibleCount) return "";
  const remaining = totalCount - visibleCount;
  return `<div style="text-align:center;margin-top:14px"><button class="btn ghost" id="${id}">Load ${Math.min(remaining, PAGE_SIZE)} more (${remaining} left)</button></div>`;
}

/** A styled confirm dialog matching the app's look, replacing the native
 * browser confirm() popup. Returns a Promise<boolean> -- true if the person
 * confirmed, false if they cancelled, clicked outside, or pressed Escape. */
/** A simple full-screen viewer for a photo thumbnail -- lets the actual
 * uploaded photo be seen at full size instead of only the small cropped
 * thumbnail used in cards/forms. Dismissible by clicking outside the image,
 * the close button, or Escape. */
function showPhotoLightbox(url) {
  const overlay = document.createElement("div");
  overlay.className = "photo-lightbox-overlay";
  overlay.innerHTML = `<img src="${url}" class="photo-lightbox-img" alt=""><button class="icon-btn photo-lightbox-close" title="Close">✕</button>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".photo-lightbox-close").addEventListener("click", close);
}

function ensureModalDom() {
  if (document.getElementById("modalOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "modalOverlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" id="modalPanel">
      <button class="modal-close" id="modalCloseBtn" aria-label="Close">✕</button>
      <div id="modalContent"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.getElementById("modalCloseBtn").addEventListener("click", () => closeModal());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.classList.contains("open")) closeModal(); });
}

let modalOnClose = null;

/** Renders html into the shared modal/bottom-sheet. onClose (optional) runs
 * once, however the modal ends up closing -- backdrop click, Escape, the X
 * button, or a form's own Cancel button calling closeModal() itself --
 * so cleanup (clearing an editing-id, resetting a sub-picker's state) only
 * has to be written once instead of once per dismissal path. */
function openModal(html, onClose = null) {
  ensureModalDom();
  modalOnClose = onClose;
  document.getElementById("modalContent").innerHTML = html;
  document.body.style.overflow = "hidden";
  const overlay = document.getElementById("modalOverlay");
  document.getElementById("modalPanel").scrollTop = 0;
  // Adding the open class in the same tick as setting innerHTML can skip
  // straight to the end state with no visible transition -- one frame's
  // delay is enough for the browser to register the starting position first.
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function closeModal() {
  const overlay = document.getElementById("modalOverlay");
  if (!overlay || !overlay.classList.contains("open")) return;
  overlay.classList.remove("open");
  document.body.style.overflow = "";
  if (modalOnClose) { modalOnClose(); modalOnClose = null; }
  setTimeout(() => { const c = document.getElementById("modalContent"); if (c) c.innerHTML = ""; }, 320);
}

/** Updates an already-open modal's content in place -- for a list-style
 * modal (Emptied bags) where an action taken inside it (restore, delete)
 * needs the list to refresh without the whole sheet closing and reopening,
 * which would replay the entrance animation and reset scroll position. */
function refreshModalContent(html) {
  const content = document.getElementById("modalContent");
  if (content) content.innerHTML = html;
}

/** The common shape behind every edit modal's Delete button: confirm,
 * delete, toast, close the modal, then refresh whatever needs to reflect
 * it. refreshFn can be sync or async (both are awaited safely). */
async function confirmAndDelete(message, deleteFn, toastMessage, refreshFn) {
  if (!(await showConfirmDialog(message))) return;
  await deleteFn();
  showToast(toastMessage, "delete");
  closeModal();
  await refreshFn();
}

function showConfirmDialog(message, confirmLabel = "Delete") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-message"></div>
        <div class="confirm-actions">
          <button class="btn ghost" id="confirmNo">Cancel</button>
          <button class="btn btn-close" id="confirmYes"></button>
        </div>
      </div>
    `;
    overlay.querySelector(".confirm-message").textContent = message;
    overlay.querySelector("#confirmYes").textContent = confirmLabel;
    document.body.appendChild(overlay);
    const cleanup = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    function onKey(e) { if (e.key === "Escape") cleanup(false); }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(false); });
    overlay.querySelector("#confirmYes").addEventListener("click", () => cleanup(true));
    overlay.querySelector("#confirmNo").addEventListener("click", () => cleanup(false));
  });
}

/** Like showConfirmDialog, but for actions destructive enough to want more
 * than a single tap of confirmation -- the confirm button stays disabled
 * until the exact required text has been typed in. */
function showTypeToConfirmDialog(message, requiredText, confirmLabel = "Delete") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-message"></div>
        <div class="dim" style="font-size:12px;margin:10px 0 6px">Type <strong style="color:var(--text)"></strong> to confirm:</div>
        <input id="typeConfirmInput" autocomplete="off" style="margin-bottom:10px">
        <div class="confirm-actions">
          <button class="btn ghost" id="confirmNo">Cancel</button>
          <button class="btn btn-close" id="confirmYes" disabled></button>
        </div>
      </div>
    `;
    overlay.querySelector(".confirm-message").textContent = message;
    overlay.querySelector(".dim strong").textContent = requiredText;
    overlay.querySelector("#typeConfirmInput").placeholder = requiredText;
    overlay.querySelector("#confirmYes").textContent = confirmLabel;
    document.body.appendChild(overlay);
    const cleanup = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    function onKey(e) { if (e.key === "Escape") cleanup(false); }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(false); });
    const input = overlay.querySelector("#typeConfirmInput");
    const confirmBtn = overlay.querySelector("#confirmYes");
    input.addEventListener("input", () => { confirmBtn.disabled = input.value !== requiredText; });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && input.value === requiredText) cleanup(true); });
    confirmBtn.addEventListener("click", () => { if (input.value === requiredText) cleanup(true); });
    overlay.querySelector("#confirmNo").addEventListener("click", () => cleanup(false));
    setTimeout(() => input.focus(), 50);
  });
}

/** A small corner toast that fades in, sits for a moment, then fades out --
 * confirms an action actually completed without blocking anything. kind
 * controls the accent color: "create" (sage/green), "update" (slate/blue),
 * "delete" (rust/red). */
function showToast(message, kind = "update") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}

function noCoopMessage() {
  return `<div class="card"><div class="empty">No coop selected. Head to the <strong style="color:var(--text)">Coops</strong> tab to create or switch to one.</div></div>`;
}

// ================= FLOCK =================
function flockYearsFor(field) {
  if (!field) return [];
  const years = new Set(STATE.birds.filter(b => b[field]).map(b => b[field].slice(0, 4)));
  return [...years].sort().reverse();
}

function applyFlockFilters(birds) {
  return birds.filter(b => {
    if (flockFilters.status && b.status !== flockFilters.status) return false;
    if (flockFilters.type && b.type !== flockFilters.type) return false;
    if (flockFilters.location && (b.location || "") !== flockFilters.location) return false;
    if (flockFilters.dateField && flockFilters.year) {
      const val = b[flockFilters.dateField];
      if (!val || val.slice(0, 4) !== flockFilters.year) return false;
    }
    return true;
  });
}

function flockSortValue(rep, mode) {
  if (mode === "age") return rep.hatch_date || rep.acquired_date || "9999-99-99";
  if (mode === "target") return rep.target_harvest_date || "9999-99-99";
  return (rep.name || "").toLowerCase();
}
function flockSortComparator(mode) {
  return (a, b) => {
    const va = flockSortValue(a, mode), vb = flockSortValue(b, mode);
    return va < vb ? -1 : va > vb ? 1 : 0;
  };
}

function groupBirds(birds) {
  const ungrouped = [];
  const groups = {};
  birds.forEach(b => {
    if (b.batch_name) {
      (groups[b.batch_name] = groups[b.batch_name] || []).push(b);
    } else {
      ungrouped.push(b);
    }
  });
  return { ungrouped, groups };
}

function summarizeGroup(birds) {
  const counts = {};
  birds.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1; });
  const statusSummary = BIRD_STATUSES.filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(" · ");
  const processed = birds.filter(b => b.status === "Processed");
  const totalWeight = processed.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  const totalValue = processed.reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);
  const first = birds[0];
  return { count: birds.length, statusSummary, totalWeight, totalValue, processedCount: processed.length, breed: first.breed, type: first.type, hatch_date: first.hatch_date, acquired_date: first.acquired_date, target_harvest_date: first.target_harvest_date };
}

function statusTone(status) {
  return status === "Active" ? "sage" : status === "Processed" ? "rust" : status === "Deceased" ? "danger" : "slate";
}

function birdCardHtml(b) {
  const displayName = esc(b.name);
  const age = ageFromDate(b.hatch_date || b.acquired_date);
  const statusDetail = b.status === "Processed"
    ? (b.harvest_weight ? `${b.harvest_weight} lb` : "")
    : b.status === "Deceased"
    ? `${fmtDate(b.death_date)}`
    : "";
  const showCountdown = b.status === "Active" && b.target_harvest_date;
  const weight = Number(b.harvest_weight) || 0;
  const pricePerLb = Number(b.price_per_lb) || 0;
  const meatValue = b.status === "Processed" ? weight * pricePerLb : 0;
  const showRate = b.status === "Processed" && weight > 0 && pricePerLb > 0;
  const accent = b.card_color || null;
  const borderStyle = b.border_style || "solid";
  const pattern = b.card_pattern || "solid";
  const patternBg = !accent ? "" : pattern === "gradient"
    ? `background:linear-gradient(135deg, color-mix(in srgb, ${esc(accent)} 30%, var(--surface)), var(--surface))`
    : pattern === "dots"
    ? `background-color:color-mix(in srgb, ${esc(accent)} 8%, var(--surface));background-image:radial-gradient(color-mix(in srgb, ${esc(accent)} 55%, transparent) 1.5px, transparent 1.5px);background-size:10px 10px`
    : pattern === "stripes"
    ? `background-color:color-mix(in srgb, ${esc(accent)} 8%, var(--surface));background-image:repeating-linear-gradient(45deg, color-mix(in srgb, ${esc(accent)} 25%, transparent), color-mix(in srgb, ${esc(accent)} 25%, transparent) 6px, transparent 6px, transparent 12px)`
    : `background:color-mix(in srgb, ${esc(accent)} 12%, var(--surface))`;
  const cardStyle = accent ? `border-color:${esc(accent)};border-style:${esc(borderStyle)};${patternBg}` : "";
  const nameHtml = accent
    ? `<div class="flock-card-name-ribbon" style="background:color-mix(in srgb, ${esc(accent)} 55%, var(--surface))"><div class="flock-card-name">${displayName}</div></div>`
    : `<div class="flock-card-name">${displayName}</div>`;
  return `<div class="flock-card${accent ? " custom-color" : ""}" data-edit="${b.id}" style="${cardStyle}">
    <div class="flock-card-photo">
      <input type="checkbox" class="flock-card-check bird-check" data-id="${b.id}" ${selectedBirdIds.has(b.id) ? "checked" : ""} onclick="event.stopPropagation()">
      ${birdPhotoUrl(b) ? `<img src="${birdPhotoUrl(b)}">` : "🐔"}
      <span class="stamp stamp-lg stamp-on-photo tone-${statusTone(b.status)} flock-card-status-badge">${esc(b.status)}</span>
      ${b.status === "Processed" && b.harvest_date ? `<div class="flock-card-harvest-badge">Harvested ${fmtDate(b.harvest_date)}</div>` : ""}
      ${showCountdown ? `<div class="flock-card-countdown-badge">${harvestCountdownHtml(b.target_harvest_date, "stamp-on-photo")}</div>` : ""}
    </div>
    <div class="flock-card-info">
      ${nameHtml}
      ${(b.breed || b.type) ? `<div class="flock-card-breed">${esc(b.breed || b.type)}</div>` : ""}
      <div class="flock-card-sub">${age}${statusDetail ? " · " + statusDetail : ""}</div>
      ${b.status === "Active" && b.target_harvest_date ? `<div class="flock-card-sub">target ${fmtDate(b.target_harvest_date)}</div>` : ""}
      ${b.location ? `<span class="stamp tone-slate" style="margin-top:2px">📍 ${esc(b.location)}</span>` : ""}
      ${showRate ? `<span class="stamp tone-slate" style="margin-top:4px">${weight.toFixed(1)} lb @ ${fmtMoney(pricePerLb)}/lb</span>` : ""}
      ${meatValue > 0 ? `<span class="stamp stamp-lg tone-gold" style="margin-top:4px">${fmtMoney(meatValue)}</span>` : ""}
    </div>
  </div>`;
}

function groupCardHtml(batchName, filteredBirds, totalCount) {
  const s = summarizeGroup(filteredBirds);
  const cover = filteredBirds.find(b => b.photo || pendingPhotoUrls[b.id]);
  const countLabel = totalCount && totalCount !== filteredBirds.length ? `${filteredBirds.length}/${totalCount}` : `${s.count}`;
  const hasActive = filteredBirds.some(b => b.status === "Active");
  const processed = filteredBirds.filter(b => b.status === "Processed" && Number(b.harvest_weight) > 0);
  const processedCount = processed.length;
  const totalWeight = processed.reduce((sum, b) => sum + (Number(b.harvest_weight) || 0), 0);
  const totalValue = processed.reduce((sum, b) => sum + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);
  const avgPricePerLb = totalWeight > 0 ? totalValue / totalWeight : 0;
  const locations = new Set(filteredBirds.map(b => b.location || null));
  const sharedLocation = locations.size === 1 ? [...locations][0] : null;
  return `<div class="flock-card flock-card-group" data-open-batch="${esc(batchName)}">
    <div class="flock-card-photo">
      ${cover ? `<img src="${birdPhotoUrl(cover)}">` : "🐣"}
      <span class="stamp stamp-lg stamp-on-photo tone-slate flock-card-status-badge">Batch</span>
      <div class="flock-group-badge"><span class="stamp stamp-lg stamp-on-photo tone-gold">${countLabel} bird${(totalCount || s.count) !== 1 ? "s" : ""}</span></div>
    </div>
    <div class="flock-card-info">
      <div class="flock-card-name">${esc(batchName)}</div>
      <div class="flock-card-sub">${s.statusSummary}${totalCount && totalCount !== filteredBirds.length ? ` · ${totalCount} in batch` : ""}</div>
      ${hasActive && s.target_harvest_date ? `<div style="margin-top:2px">${harvestCountdownHtml(s.target_harvest_date)}</div>` : ""}
      ${sharedLocation ? `<span class="stamp tone-slate" style="margin-top:2px">📍 ${esc(sharedLocation)}</span>` : ""}
      ${processedCount > 0 ? `
        <span class="stamp tone-slate" style="align-self:flex-start;margin-top:4px">${totalWeight.toFixed(1)} lb @ ${fmtMoney(avgPricePerLb)}/lb</span>
        <span class="stamp tone-rust" style="align-self:flex-start;margin-top:4px">${processedCount} Processed</span>
        ${totalValue > 0 ? `<span class="stamp stamp-lg tone-gold" style="align-self:flex-start;margin-top:4px">${fmtMoney(totalValue)}</span>` : ""}
      ` : ""}
    </div>
  </div>`;
}

const FLOCK_SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "age", label: "Age" },
  { value: "target", label: "Target harvest" },
];

function flockSortSelectHtml(id) {
  return `<select id="${id}">${FLOCK_SORT_OPTIONS.map(o => `<option value="${o.value}" ${flockSort === o.value ? "selected" : ""}>Sort: ${o.label}</option>`).join("")}</select>`;
}

let flockSubTab = "birds";
function renderFlockHub() {
  const el = document.getElementById("panel-flock");
  const subs = [{ id: "birds", label: "Birds" }, { id: "notes", label: "Notes" }, { id: "health", label: "Health" }];
  el.innerHTML = `
    <div class="range-select sub-nav-fixed" id="flockSubNav">
      ${subs.map(s => `<button class="range-btn ${flockSubTab === s.id ? "active" : ""}" data-flocksub="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div id="flockSubContent"></div>
  `;
  el.querySelectorAll("[data-flocksub]").forEach(b => b.addEventListener("click", () => { flockSubTab = b.dataset.flocksub; renderFlockHub(); }));
  if (flockSubTab === "birds") renderFlockBirds();
  else if (flockSubTab === "notes") renderNotesSection();
  else if (flockSubTab === "health") renderFlockHealthSection();
}

function renderFlockBirds() {
  const el = document.getElementById("flockSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const allBirds = [...STATE.birds];
  const filtered = applyFlockFilters(allBirds).sort(flockSortComparator(flockSort));
  const years = flockYearsFor(flockFilters.dateField);
  // Type/date-range filters are for digging up specific individuals, so they
  // still flatten to a plain grid. Status alone (including the "Active"
  // default) stays grouped/sectioned -- that's what keeps a years-old flock
  // list from turning into an endless scroll: processed/deceased birds and
  // fully-wound-down batches just drop out of view by default. Broadening the
  // Status filter to "All statuses" (or a specific status) brings them back,
  // still grouped, so there's one mechanism for this rather than a separate
  // archive view duplicating it.
  const forcesFlatView = flockFilters.type || flockFilters.location || (flockFilters.dateField && flockFilters.year);
  const nonDefaultFilterCount = (flockFilters.status !== "Active" ? 1 : 0) + (flockFilters.type ? 1 : 0) + (flockFilters.location ? 1 : 0) + (flockFilters.dateField && flockFilters.year ? 1 : 0);

  const totalByBatch = {};
  STATE.birds.forEach(b => { if (b.batch_name) totalByBatch[b.batch_name] = (totalByBatch[b.batch_name] || 0) + 1; });

  let bodyHtml;
  if (filtered.length === 0) {
    bodyHtml = `<div class="card"><div class="empty">${STATE.birds.length === 0 ? "No birds yet — add your first one." : "No birds match these filters."}</div></div>`;
  } else if (forcesFlatView) {
    bodyHtml = `<div class="flock-grid">${filtered.map(b => birdCardHtml(b)).join("")}</div>`;
  } else {
    const { ungrouped, groups } = groupBirds(filtered);
    const isMeat = (b) => b.type === "Meat";
    const items = [];
    ungrouped.forEach(b => items.push({ isMeat: isMeat(b), rep: b, html: birdCardHtml(b) }));
    Object.keys(groups).forEach(name => {
      const birds = groups[name];
      const rep = { ...summarizeGroup(birds), name };
      items.push({ isMeat: isMeat(birds[0]), rep, html: groupCardHtml(name, birds, totalByBatch[name]) });
    });
    items.sort((a, b) => flockSortComparator(flockSort)(a.rep, b.rep));
    const layerItems = items.filter(it => !it.isMeat);
    const meatItems = items.filter(it => it.isMeat);
    bodyHtml = ""
      + (layerItems.length ? `<div class="flock-section-header">Layers</div><div class="flock-grid">${layerItems.map(it => it.html).join("")}</div>` : "")
      + (meatItems.length ? `<div class="flock-section-header">Meat birds</div><div class="flock-grid">${meatItems.map(it => it.html).join("")}</div>` : "");
  }

  el.innerHTML = `
    <div class="toolbar">
      <div class="dim">${filtered.length} of ${STATE.birds.length} bird${STATE.birds.length !== 1 ? "s" : ""} shown${flockFilters.status === "Active" && nonDefaultFilterCount === 0 ? " (active only)" : ""}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${flockSortSelectHtml("flockSortSelect")}
        <button class="btn ghost small" id="toggleFlockFilters">Filters${nonDefaultFilterCount ? ` (${nonDefaultFilterCount})` : ""} ${flockFiltersOpen ? "▾" : "▸"}</button>
        <button class="btn" id="newBatchBtn">+ Add batch</button>
        <button class="btn" id="newBirdBtn">+ Add bird</button>
      </div>
    </div>

    ${flockFiltersOpen ? `
    <div class="form-block" style="padding:12px 16px">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        <label class="field"><span>Status</span><select id="filterStatus"><option value="">All statuses</option>${BIRD_STATUSES.map(s => `<option value="${s}" ${flockFilters.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label class="field"><span>Type</span><select id="filterType"><option value="">All types</option>${BIRD_TYPES.map(t => `<option value="${t}" ${flockFilters.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field"><span>Location</span><select id="filterLocation"><option value="">All locations</option>${getBeddingAreas().map(a => `<option value="${esc(a)}" ${flockFilters.location === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
        <label class="field"><span>Filter by</span><select id="filterDateField">${FLOCK_DATE_FIELDS.map(f => `<option value="${f.value}" ${flockFilters.dateField === f.value ? "selected" : ""}>${f.label}</option>`).join("")}</select></label>
        <label class="field"><span>Year</span><select id="filterYear" ${!flockFilters.dateField ? "disabled" : ""}><option value="">All years</option>${years.map(y => `<option value="${y}" ${flockFilters.year === y ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost small" id="clearFilters">Show everyone (clear filters)</button>
      </div>
      ${forcesFlatView ? `<div class="dim" style="font-size:11px;margin-top:8px">Type/date filters show everyone as individual cards instead of grouped batches, so nothing's hidden inside a collapsed group.</div>` : ""}
    </div>
    ` : ""}

    ${selectedBirdIds.size > 0 ? `
      <div class="form-block" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-color:var(--rust)">
        <div><strong style="color:var(--text)">${selectedBirdIds.size}</strong> selected</div>
        <div style="display:flex;gap:8px">
          <button class="btn ghost small" id="bulkEditBtn">Bulk edit</button>
          <button class="btn btn-close small" id="bulkDeleteBtn">Delete selected</button>
          <button class="btn ghost small" id="clearSelection">Clear selection</button>
        </div>
      </div>
    ` : ""}

    <div id="birdFormHost"></div>
    ${bodyHtml}
  `;

  document.getElementById("flockSortSelect").addEventListener("change", (e) => { flockSort = e.target.value; renderFlockBirds(); });
  document.getElementById("toggleFlockFilters").addEventListener("click", () => { flockFiltersOpen = !flockFiltersOpen; renderFlockBirds(); });
  document.getElementById("newBirdBtn").addEventListener("click", () => showBirdForm(null));
  document.getElementById("newBatchBtn").addEventListener("click", () => showBulkForm());
  wireFlockCardHandlers(el);

  const filterStatusEl = document.getElementById("filterStatus");
  if (filterStatusEl) filterStatusEl.addEventListener("change", (e) => { flockFilters.status = e.target.value; renderFlockBirds(); });
  const filterTypeEl = document.getElementById("filterType");
  if (filterTypeEl) filterTypeEl.addEventListener("change", (e) => { flockFilters.type = e.target.value; renderFlockBirds(); });
  const filterLocationEl = document.getElementById("filterLocation");
  if (filterLocationEl) filterLocationEl.addEventListener("change", (e) => { flockFilters.location = e.target.value; renderFlockBirds(); });
  const filterDateFieldEl = document.getElementById("filterDateField");
  if (filterDateFieldEl) filterDateFieldEl.addEventListener("change", (e) => { flockFilters.dateField = e.target.value; flockFilters.year = ""; renderFlockBirds(); });
  const filterYearEl = document.getElementById("filterYear");
  if (filterYearEl) filterYearEl.addEventListener("change", (e) => { flockFilters.year = e.target.value; renderFlockBirds(); });
  const clearBtn = document.getElementById("clearFilters");
  if (clearBtn) clearBtn.addEventListener("click", () => { flockFilters = { status: "", type: "", location: "", dateField: "", year: "" }; renderFlockBirds(); });

  el.querySelectorAll(".bird-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedBirdIds.add(cb.dataset.id); else selectedBirdIds.delete(cb.dataset.id);
    renderFlockBirds();
  }));
  const clearSelBtn = document.getElementById("clearSelection");
  if (clearSelBtn) clearSelBtn.addEventListener("click", () => { selectedBirdIds.clear(); renderFlockBirds(); });
  const bulkEditBtn = document.getElementById("bulkEditBtn");
  if (bulkEditBtn) bulkEditBtn.addEventListener("click", () => showBulkEditForm());
  const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
  if (bulkDeleteBtn) bulkDeleteBtn.addEventListener("click", async () => {
    const count = selectedBirdIds.size;
    if (!(await showConfirmDialog(`Delete ${count} selected bird${count !== 1 ? "s" : ""}? This can't be undone.`))) return;
    await localBulkDeleteBirds([...selectedBirdIds], currentCoopId);
    showToast(`${count} bird${count !== 1 ? "s" : ""} deleted`, "delete");
    selectedBirdIds.clear();
    refreshAndRender();
  });
}

/** Individual birds that left Active status on their own (not part of a batch), plus batches where every member has left Active status. */


/** Shared click wiring for both the active grid and the archive grid. */
function wireFlockCardHandlers(el) {
  el.querySelectorAll("[data-edit]").forEach(card => card.addEventListener("click", () => showBirdForm(STATE.birds.find(x => x.id === card.dataset.edit))));
  el.querySelectorAll("[data-open-batch]").forEach(card => card.addEventListener("click", () => showBatchPanel(card.dataset.openBatch)));
}

function showBatchPanel(batchName) {
  const host = document.getElementById("birdFormHost");
  const birds = STATE.birds.filter(b => b.batch_name === batchName);
  const batchIds = birds.map(b => b.id);
  const selectedInBatch = batchIds.filter(id => selectedBirdIds.has(id));
  const allSelected = selectedInBatch.length === batchIds.length;
  const s = summarizeGroup(birds);

  host.innerHTML = `
    <div class="form-block">
      <div class="form-head"><span>${esc(batchName)} -- ${birds.length} birds</span><button class="icon-btn icon-btn-close" id="closeBatchPanel">✕</button></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        <div class="dim" style="font-size:12px">${esc(s.statusSummary)}${s.breed ? ` · ${esc(s.breed)}` : ""}${s.processedCount > 0 && s.totalValue > 0 ? ` · ${fmtMoney(s.totalValue)} value` : ""}</div>
        <button class="btn ghost small" id="openBatchEdit" style="margin-left:auto">✎ Edit group</button>
      </div>

      <div class="toolbar" style="margin-bottom:10px">
        <button class="btn ghost small" id="selectAllInBatch">${allSelected ? "☑" : "☐"} Select all in batch</button>
        ${selectedInBatch.length > 0 ? `<div class="dim">${selectedInBatch.length} of ${birds.length} selected</div>` : ""}
      </div>
      ${selectedInBatch.length > 0 ? `
      <div class="form-block" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-color:var(--rust)">
        <div><strong style="color:var(--text)">${selectedInBatch.length}</strong> selected</div>
        <div style="display:flex;gap:8px">
          <button class="btn ghost small" id="batchBulkEditBtn">Bulk edit</button>
          <button class="btn btn-close small" id="batchBulkDeleteBtn">Delete selected</button>
        </div>
      </div>
      ` : ""}

      <div class="flock-grid">${birds.map(b => birdCardHtml(b)).join("")}</div>
    </div>
  `;
  const close = () => { host.innerHTML = ""; };
  document.getElementById("closeBatchPanel").addEventListener("click", close);
  document.getElementById("openBatchEdit").addEventListener("click", () => openBatchEditModal(batchName));
  document.getElementById("selectAllInBatch").addEventListener("click", () => {
    if (allSelected) batchIds.forEach(id => selectedBirdIds.delete(id));
    else batchIds.forEach(id => selectedBirdIds.add(id));
    showBatchPanel(batchName);
  });
  const batchBulkEditBtn = document.getElementById("batchBulkEditBtn");
  if (batchBulkEditBtn) batchBulkEditBtn.addEventListener("click", () => showBulkEditForm());
  const batchBulkDeleteBtn = document.getElementById("batchBulkDeleteBtn");
  if (batchBulkDeleteBtn) batchBulkDeleteBtn.addEventListener("click", async () => {
    const n = selectedInBatch.length;
    if (!(await showConfirmDialog(`Delete ${n} selected bird${n !== 1 ? "s" : ""}? This can't be undone.`))) return;
    await localBulkDeleteBirds(selectedInBatch, currentCoopId);
    showToast(`${n} bird${n !== 1 ? "s" : ""} deleted`, "delete");
    selectedInBatch.forEach(id => selectedBirdIds.delete(id));
    refreshAndRender();
  });
  host.querySelectorAll(".bird-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedBirdIds.add(cb.dataset.id); else selectedBirdIds.delete(cb.dataset.id);
    showBatchPanel(batchName);
  }));
  host.querySelectorAll("[data-edit]").forEach(card => card.addEventListener("click", () => showBirdForm(STATE.birds.find(x => x.id === card.dataset.edit))));
  host.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!(await showConfirmDialog("Delete this bird? This can't be undone."))) return;
    await localBirdDelete(b.dataset.del, currentCoopId);
    showToast("Bird deleted", "delete");
    refreshAndRender();
  }));
}

/** The batch-wide editor (photo, location, styling, delete-the-whole-batch)
 * -- split out from showBatchPanel above into its own explicit modal, so
 * opening a group to browse its birds and deliberately editing the whole
 * group's shared properties are two distinct actions instead of the same
 * tap always surfacing both at once. */
function batchEditModalHtml(batchName) {
  const birds = STATE.birds.filter(b => b.batch_name === batchName);
  const cover = birds.find(b => b.photo || pendingPhotoUrls[b.id]);
  // If every bird in the batch already shares the same value, reflect that
  // in the form instead of a hardcoded default -- so reopening this shows
  // what's actually applied, not a reset-looking blank state.
  const sharedValue = (field, fallback) => {
    const vals = new Set(birds.map(b => b[field] || null));
    return vals.size === 1 && [...vals][0] ? [...vals][0] : fallback;
  };
  const sharedColor = sharedValue("card_color", "#5A4B3C");
  const sharedBorderStyle = sharedValue("border_style", "solid");
  const sharedPattern = sharedValue("card_pattern", "solid");
  const sharedLocation = sharedValue("location", "");
  return `
    <div class="form-head">Edit group -- ${esc(batchName)}</div>
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <div style="width:64px;height:64px;border-radius:8px;overflow:hidden;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;font-size:26px;flex:0 0 auto">
        ${cover ? `<img src="${birdPhotoUrl(cover)}" style="width:100%;height:100%;object-fit:cover">` : "🐣"}
      </div>
      <div style="flex:1;min-width:180px">
        <label class="field"><span>Set group photo (applies to every bird in this batch)</span><input type="file" id="batchPhotoInput" accept="image/*"></label>
      </div>
    </div>

    <div class="form-block" style="margin-bottom:14px">
      <div class="dim" style="font-size:12px;margin-bottom:8px">Group location -- applies to every bird in this batch</div>
      <label class="field"><span>Location</span><select id="batch_location"><option value="">(unspecified)</option>${getBeddingAreas().map(a => `<option value="${esc(a)}" ${sharedLocation === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
      <button class="btn ghost small" id="applyBatchLocation" style="margin-top:10px">Apply to whole batch</button>
    </div>

    <div class="form-block" style="margin-bottom:14px">
      <div class="dim" style="font-size:12px;margin-bottom:8px">Group card styling -- applies to every bird in this batch</div>
      <div class="grid-form">
        <label class="field"><span>Card color</span><input type="color" id="batch_color" value="${sharedColor}" style="width:60px;height:38px;padding:2px;cursor:pointer"></label>
        <label class="field"><span>Border style</span><select id="batch_border_style">${["solid", "dashed", "dotted"].map(s => `<option value="${s}" ${sharedBorderStyle === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
        <label class="field"><span>Background</span><select id="batch_pattern">${[["solid", "Solid tint"], ["gradient", "Gradient"], ["dots", "Dots"], ["stripes", "Stripes"]].map(([v, l]) => `<option value="${v}" ${sharedPattern === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost small" id="applyBatchStyle">Apply to whole batch</button>
        <button class="btn ghost small" id="clearBatchStyle">Clear styling from whole batch</button>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn btn-close small" id="deleteBatchBtn">🗑 Delete entire batch</button>
      <button class="btn ghost small" id="closeBatchEditModal" style="margin-left:auto">Done</button>
    </div>
  `;
}

function wireBatchEditModal(batchName) {
  const birds = STATE.birds.filter(b => b.batch_name === batchName);
  const refresh = () => { refreshModalContent(batchEditModalHtml(batchName)); wireBatchEditModal(batchName); };
  document.getElementById("closeBatchEditModal").addEventListener("click", () => closeModal());
  document.getElementById("applyBatchLocation").addEventListener("click", async () => {
    const location = document.getElementById("batch_location").value;
    await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: { location: location || null } })), currentCoopId);
    showToast("Batch location applied", "update");
    await loadCoopData();
    refresh();
  });
  document.getElementById("applyBatchStyle").addEventListener("click", async () => {
    const updates = {
      card_color: document.getElementById("batch_color").value,
      border_style: document.getElementById("batch_border_style").value,
      card_pattern: document.getElementById("batch_pattern").value,
    };
    await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: updates })), currentCoopId);
    showToast("Batch styling applied", "update");
    await loadCoopData();
    refresh();
  });
  document.getElementById("clearBatchStyle").addEventListener("click", async () => {
    await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: { card_color: null, border_style: null, card_pattern: null } })), currentCoopId);
    showToast("Batch styling cleared", "update");
    await loadCoopData();
    refresh();
  });
  document.getElementById("deleteBatchBtn").addEventListener("click", async () => {
    if (!(await showConfirmDialog(`Delete the entire "${batchName}" batch -- all ${birds.length} birds? This can't be undone.`))) return;
    await localBulkDeleteBirds(birds.map(x => x.id), currentCoopId);
    showToast(`"${batchName}" batch deleted`, "delete");
    closeModal();
    document.getElementById("birdFormHost").innerHTML = ""; // the batch panel behind this modal no longer has anything to show
    refreshAndRender();
  });
  document.getElementById("batchPhotoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const blob = await resizeImageFileToBlob(file);
    await Promise.all(birds.map(b => queuePendingPhoto(b.id, blob)));
    trySyncSoon("birds", currentCoopId);
    showToast("Group photo updated", "update");
    await loadCoopData();
    refresh();
  });
}

function openBatchEditModal(batchName) {
  openModal(batchEditModalHtml(batchName), () => {
    // Whatever changed in here (photo, location, styling) should be
    // reflected in the batch panel underneath once this closes, regardless
    // of which button was used to close it.
    if (document.getElementById("birdFormHost")) showBatchPanel(batchName);
  });
  wireBatchEditModal(batchName);
}

function renderFlockHealthSection() {
  const el = document.getElementById("flockSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const logs = [...STATE.birdLogs].sort((a, b) => b.date.localeCompare(a.date));
  const birdNameOf = (id) => { const b = STATE.birds.find(x => x.id === id); return b ? b.name : "(deleted bird)"; };
  el.innerHTML = `
    <div class="form-block">
      <div class="form-head"><span>Flock health &amp; notes log</span></div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">Every log entry across every bird, most recent first. Add or remove entries from an individual bird's edit screen.</div>
      ${logs.length === 0 ? `<div class="empty">No log entries yet.</div>` : `
      <div style="display:flex;flex-direction:column;gap:8px;max-height:520px;overflow-y:auto">
        ${logs.map(l => `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:start;font-size:13px;border-bottom:1px solid #5A4B3C30;padding-bottom:8px">
            <div>
              <span class="mono dim" style="font-size:11px">${fmtDate(l.date)}</span>
              <span class="stamp tone-slate" style="margin-left:6px">${esc(birdNameOf(l.bird_id))}</span>
              <div style="margin-top:4px">${esc(l.note)}</div>
            </div>
            <button class="icon-btn" data-del-flock-log="${l.id}">🗑</button>
          </div>`).join("")}
      </div>`}
    </div>
  `;
  el.querySelectorAll("[data-del-flock-log]").forEach(b => b.addEventListener("click", async () => {
    await localBirdLogDelete(b.dataset.delFlockLog, currentCoopId);
    STATE.birdLogs = await localGetAll("bird_logs", currentCoopId);
    renderFlockHealthSection();
  }));
}

function showBulkEditForm() {
  const count = selectedBirdIds.size;
  const html = `
    <div class="form-head">Bulk edit ${count} bird${count !== 1 ? "s" : ""}</div>
    <div class="note-box" style="margin-bottom:12px">Leave a field blank to leave it unchanged on all selected birds. Only fields you fill in get applied.</div>
    <div class="grid-form">
      <label class="field"><span>Status</span><select id="be_status"><option value="">(no change)</option>${BIRD_STATUSES.map(s => `<option value="${s}">${s}</option>`).join("")}</select></label>
      <label class="field"><span>Location</span><select id="be_location"><option value="">(no change)</option>${getBeddingAreas().map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select></label>
      <label class="field"><span>Target harvest date</span><input type="date" id="be_target"></label>
    </div>
    <label class="field" style="display:flex;flex-direction:row;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="be_set_batch" style="width:auto"><span>Set batch (leave name blank to remove from any batch)</span></label>
    <label class="field" style="margin-top:6px"><span>Batch name</span><input id="be_batch" placeholder="e.g. Spring Cornish Cross"></label>
    <div class="dim" style="font-size:11px;margin:12px 0 4px">If setting Status to Processed, these fill in the harvest record:</div>
    <div class="grid-form">
      <label class="field"><span>Harvest date</span><input type="date" id="be_harvest_date"></label>
      <label class="field"><span>Harvest weight (lb, each)</span><input type="number" step="0.01" id="be_harvest_weight" placeholder="(no change)"></label>
      <label class="field"><span>Store-equivalent value per lb ($)</span><input type="number" step="0.01" id="be_price" placeholder="(no change)"></label>
    </div>
    <div class="dim" style="font-size:11px;margin:12px 0 4px">If setting Status to Deceased, these fill in the loss record:</div>
    <div class="grid-form">
      <label class="field"><span>Death date</span><input type="date" id="be_death_date"></label>
      <label class="field"><span>Cause</span><input id="be_death_cause" placeholder="(no change)"></label>
    </div>
    <div class="dim" style="font-size:11px;margin:12px 0 4px">Card styling:</div>
    <div class="grid-form">
      <label class="field"><span>Border style</span><select id="be_border_style"><option value="">(no change)</option>${["solid", "dashed", "dotted"].map(s => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
      <label class="field"><span>Background</span><select id="be_pattern"><option value="">(no change)</option>${[["solid", "Solid tint"], ["gradient", "Gradient"], ["dots", "Dots"], ["stripes", "Stripes"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
    </div>
    <label class="field" style="display:flex;flex-direction:row;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="be_set_color" style="width:auto"><span>Set card color</span></label>
    <label class="field" style="margin-top:6px"><span>Card color</span><input type="color" id="be_color" value="#5A4B3C" style="width:60px;height:38px;padding:2px;cursor:pointer"></label>
    <div class="modal-actions"><button class="btn btn-confirm" id="saveBulkEdit">✓ Apply to ${count} bird${count !== 1 ? "s" : ""}</button></div>
  `;
  openModal(html);
  document.getElementById("saveBulkEdit").addEventListener("click", async () => {
    const updates = {};
    const status = document.getElementById("be_status").value;
    const location = document.getElementById("be_location").value;
    const batch = document.getElementById("be_batch").value;
    const setBatch = document.getElementById("be_set_batch").checked;
    const target = document.getElementById("be_target").value;
    const harvestDate = document.getElementById("be_harvest_date").value;
    const harvestWeight = document.getElementById("be_harvest_weight").value;
    const price = document.getElementById("be_price").value;
    const deathDate = document.getElementById("be_death_date").value;
    const deathCause = document.getElementById("be_death_cause").value;
    const borderStyle = document.getElementById("be_border_style").value;
    const pattern = document.getElementById("be_pattern").value;
    const setColor = document.getElementById("be_set_color").checked;
    if (status) updates.status = status;
    if (location) updates.location = location;
    if (setBatch) updates.batch_name = batch.trim() || null;
    if (target) updates.target_harvest_date = target;
    if (harvestDate) updates.harvest_date = harvestDate;
    if (harvestWeight) updates.harvest_weight = Number(harvestWeight);
    if (price) updates.price_per_lb = Number(price);
    if (deathDate) updates.death_date = deathDate;
    if (deathCause) updates.death_cause = deathCause;
    if (borderStyle) updates.border_style = borderStyle;
    if (pattern) updates.card_pattern = pattern;
    if (setColor) updates.card_color = document.getElementById("be_color").value;
    if (Object.keys(updates).length === 0) { closeModal(); return; }
    const n = selectedBirdIds.size;
    await localBulkUpdate("birds", [...selectedBirdIds].map(id => ({ id, fields: updates })), currentCoopId);
    showToast(`${n} bird${n !== 1 ? "s" : ""} updated`, "update");
    selectedBirdIds.clear();
    closeModal();
    refreshAndRender();
  });
}

function renderBirdLogSection(birdId) {
  const host = document.getElementById("birdLogSection");
  if (!host) return;
  const logs = STATE.birdLogs.filter(l => l.bird_id === birdId).sort((a, b) => b.date.localeCompare(a.date));
  host.innerHTML = `
    <div style="border-top:1px solid var(--border);padding-top:14px">
      <div class="form-head" style="margin-bottom:8px"><span>Health &amp; notes log</span></div>
      <div class="grid-form" style="grid-template-columns:140px 1fr auto">
        <label class="field"><span>Date</span><input type="date" id="log_date" value="${todayStr()}"></label>
        <label class="field"><span>Entry</span><input id="log_note" placeholder="e.g. treated for mites, limping on left leg"></label>
        <div style="align-self:end"><button class="btn small" id="addLogEntry">+ Add</button></div>
      </div>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
        ${logs.length === 0 ? `<div class="dim" style="font-size:12px">No log entries yet.</div>` : logs.map(l => `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:start;font-size:13px;border-bottom:1px solid #5A4B3C30;padding-bottom:8px">
            <div><span class="mono dim" style="font-size:11px">${fmtDate(l.date)}</span><div>${esc(l.note)}</div></div>
            <button class="icon-btn" data-del-log="${l.id}">🗑</button>
          </div>`).join("")}
      </div>
    </div>
  `;
  document.getElementById("addLogEntry").addEventListener("click", async () => {
    const note = document.getElementById("log_note").value.trim();
    if (!note) return;
    await localBirdLogCreate({ coop_id: currentCoopId, bird_id: birdId, date: document.getElementById("log_date").value, note });
    STATE.birdLogs = await localGetAll("bird_logs", currentCoopId);
    renderBirdLogSection(birdId);
  });
  host.querySelectorAll("[data-del-log]").forEach(b => b.addEventListener("click", async () => {
    await localBirdLogDelete(b.dataset.delLog, currentCoopId);
    STATE.birdLogs = await localGetAll("bird_logs", currentCoopId);
    renderBirdLogSection(birdId);
  }));
}

function showBirdForm(bird) {
  const isEdit = !!bird;
  let pendingPhotoBlob = null;   // a newly-picked file, resized, waiting to be uploaded on save
  let photoRemoved = false;      // user asked to remove the existing photo
  let previewUrl = bird ? birdPhotoUrl(bird) : null;

  let formState = bird ? { ...bird } : {
    name: "", breed: "", type: "Layer", hatch_date: "", acquired_date: "", status: "Active",
    target_harvest_date: "", harvest_date: "", harvest_weight: "", notes: "", photo: null,
    price_per_lb: getCoopDefaults().pricePerLb, death_date: "", death_cause: "", card_color: "", border_style: "", card_pattern: "", location: "", batch_name: "",
  };

  // Reads whatever's currently in the DOM (for fields that exist) and falls
  // back to the last known state for anything hidden by the conditional
  // sections below -- so switching Status/Type to reveal/hide fields never
  // silently discards something you already typed elsewhere in the form.
  function readCurrentValues() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    return {
      ...formState,
      name: val("f_name") ?? formState.name,
      breed: val("f_breed") ?? formState.breed,
      type: val("f_type") ?? formState.type,
      location: val("f_location") ?? formState.location,
      status: val("f_status") ?? formState.status,
      batch_name: val("f_batch") ?? formState.batch_name,
      hatch_date: val("f_hatch") ?? formState.hatch_date,
      acquired_date: val("f_acquired") ?? formState.acquired_date,
      target_harvest_date: val("f_target") ?? formState.target_harvest_date,
      harvest_date: val("f_hdate") ?? formState.harvest_date,
      harvest_weight: val("f_weight") ?? formState.harvest_weight,
      price_per_lb: val("f_price") ?? formState.price_per_lb,
      death_date: val("f_death_date") ?? formState.death_date,
      death_cause: val("f_death_cause") ?? formState.death_cause,
      card_color: val("f_color") ?? formState.card_color,
      border_style: val("f_border_style") ?? formState.border_style,
      card_pattern: val("f_pattern") ?? formState.card_pattern,
      notes: val("f_notes") ?? formState.notes,
    };
  }

  function render(firstOpen) {
    const f = formState;
    const showTarget = f.status === "Active" && (f.type === "Meat" || f.type === "Dual Purpose");
    const showProcessed = f.status === "Processed";
    const showLoss = f.status === "Deceased";

    const html = `
      <div class="form-head">${isEdit ? "Edit bird" : "New bird"}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;align-items:flex-start">
        <div id="photoPreview">${previewUrl ? `<img src="${previewUrl}" data-view-photo="${esc(previewUrl)}" class="thumb-clickable" style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:zoom-in">` : `<div style="width:84px;height:84px;border-radius:8px;background:var(--bg);border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;font-size:28px">🐔</div>`}</div>
        <div>
          <label class="field"><span>Photo</span><input type="file" id="f_photo" accept="image/*"></label>
          ${previewUrl ? `<button class="btn btn-close small" id="removePhoto" style="margin-top:6px">Remove photo</button>` : ""}
        </div>
        <div>
          <label class="field"><span>Card color</span><input type="color" id="f_color" value="${esc(f.card_color || "#5A4B3C")}" style="width:60px;height:38px;padding:2px;cursor:pointer"></label>
          ${f.card_color ? `<button class="btn ghost small" id="clearColor" style="margin-top:6px">Clear color</button>` : ""}
        </div>
        <label class="field"><span>Border style</span><select id="f_border_style">${["solid", "dashed", "dotted"].map(s => `<option value="${s}" ${(f.border_style || "solid") === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
        <label class="field"><span>Background</span><select id="f_pattern">${[["solid", "Solid tint"], ["gradient", "Gradient"], ["dots", "Dots"], ["stripes", "Stripes"]].map(([v, l]) => `<option value="${v}" ${(f.card_pattern || "solid") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>

      <div class="grid-form">
        <label class="field"><span>Name</span><input id="f_name" value="${esc(f.name)}" placeholder="e.g. Nugget"></label>
        <label class="field"><span>Breed</span><input id="f_breed" value="${esc(f.breed)}" placeholder="e.g. Rhode Island Red"></label>
        <label class="field"><span>Type</span><select id="f_type">${BIRD_TYPES.map(t => `<option ${f.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field"><span>Location</span><select id="f_location"><option value="">(unspecified)</option>${getBeddingAreas().map(a => `<option value="${esc(a)}" ${f.location === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
        <label class="field"><span>Status</span><select id="f_status">${BIRD_STATUSES.map(s => `<option ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label class="field"><span>Batch</span><input id="f_batch" value="${esc(f.batch_name || "")}" placeholder="(not in a batch)"></label>
        ${showProcessed ? `<label class="field"><span>Value per LB</span><input type="number" step="0.01" id="f_price" value="${f.price_per_lb ?? ""}" placeholder="e.g. 5.00"></label>` : ""}
        ${showProcessed ? `<label class="field"><span>Dressed Weight (lb)</span><input type="number" step="0.1" id="f_weight" value="${f.harvest_weight ?? ""}"></label>` : ""}
      </div>

      <div class="grid-form" style="margin-top:10px">
        <label class="field"><span>Hatch date</span><input type="date" id="f_hatch" value="${f.hatch_date || ""}"></label>
        <label class="field"><span>Acquired date</span><input type="date" id="f_acquired" value="${f.acquired_date || ""}"></label>
        ${showTarget ? `<label class="field"><span>Target harvest date</span><input type="date" id="f_target" value="${f.target_harvest_date || ""}"></label>` : ""}
        ${showProcessed ? `<label class="field"><span>Harvest date</span><input type="date" id="f_hdate" value="${f.harvest_date || ""}"></label>` : ""}
        ${showLoss ? `<label class="field"><span>Date of loss</span><input type="date" id="f_death_date" value="${f.death_date || ""}"></label>` : ""}
        ${showLoss ? `<label class="field"><span>Cause of loss</span><input id="f_death_cause" value="${esc(f.death_cause)}" placeholder="e.g. predator, illness"></label>` : ""}
      </div>

      <div style="margin-top:12px"><label class="field"><span>Notes</span><textarea id="f_notes">${esc(f.notes)}</textarea></label></div>
      <div id="birdLogSection" style="margin-top:16px"></div>
      <div class="modal-actions"><button class="btn btn-confirm" id="saveBird">✓ Save</button>${isEdit ? `<button class="btn btn-close" id="deleteBird">🗑 Delete</button>` : ""}</div>
    `;

    if (firstOpen) openModal(html);
    else refreshModalContent(html);

    if (isEdit) renderBirdLogSection(bird.id);
    else document.getElementById("birdLogSection").innerHTML = `<div class="dim" style="font-size:12px">Save this bird first to start a health/notes log for it.</div>`;

    document.getElementById("photoPreview").addEventListener("click", (e) => {
      const url = e.target.dataset ? e.target.dataset.viewPhoto : null;
      if (url) showPhotoLightbox(url);
    });
    const deleteBtn = document.getElementById("deleteBird");
    if (deleteBtn) deleteBtn.addEventListener("click", () => confirmAndDelete(
      "Delete this bird? This can't be undone.",
      () => localBirdDelete(bird.id, currentCoopId),
      "Bird deleted",
      refreshAndRender
    ));

    document.getElementById("f_type").addEventListener("change", (e) => { formState = readCurrentValues(); formState.type = e.target.value; render(false); });
    document.getElementById("f_status").addEventListener("change", (e) => { formState = readCurrentValues(); formState.status = e.target.value; render(false); });

    document.getElementById("f_photo").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        pendingPhotoBlob = await resizeImageFileToBlob(file);
        photoRemoved = false;
        const objectUrl = URL.createObjectURL(pendingPhotoBlob);
        document.getElementById("photoPreview").innerHTML = `<img src="${objectUrl}" style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--border)">`;
      } catch (err) {
        alert("Couldn't read that image: " + err.message);
      }
    });
    const removeBtn = document.getElementById("removePhoto");
    if (removeBtn) removeBtn.addEventListener("click", () => {
      pendingPhotoBlob = null;
      photoRemoved = true;
      previewUrl = null;
      document.getElementById("photoPreview").innerHTML = `<div style="width:84px;height:84px;border-radius:8px;background:var(--bg);border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;font-size:28px">🐔</div>`;
    });
    const clearColorBtn = document.getElementById("clearColor");
    if (clearColorBtn) clearColorBtn.addEventListener("click", () => {
      formState = readCurrentValues();
      formState.card_color = "";
      render(false);
    });

    document.getElementById("saveBird").addEventListener("click", async () => {
      const current = readCurrentValues();
      const payload = {
        coop_id: currentCoopId,
        name: current.name.trim(),
        breed: current.breed,
        type: current.type,
        status: current.status,
        hatch_date: current.hatch_date,
        acquired_date: current.acquired_date,
        target_harvest_date: current.target_harvest_date,
        harvest_date: current.harvest_date,
        harvest_weight: current.harvest_weight ? Number(current.harvest_weight) : null,
        price_per_lb: current.price_per_lb ? Number(current.price_per_lb) : null,
        death_date: current.death_date,
        death_cause: current.death_cause,
        card_color: current.card_color || null,
        border_style: current.border_style || null,
        card_pattern: current.card_pattern || null,
        location: current.location || null,
        batch_name: (current.batch_name || "").trim() || null,
        notes: current.notes,
      };
      if (!payload.name) return;
      let birdId = isEdit ? bird.id : null;
      if (isEdit) {
        await localBirdUpdate(birdId, payload);
      } else {
        const created = await localBirdCreate(payload);
        birdId = created.id;
      }
      if (pendingPhotoBlob) {
        // Queued locally, not uploaded directly -- works the same whether
        // online or off. It uploads as soon as a connection is available
        // (right away if we already have one), same timing as everything
        // else in the outbox.
        await queuePendingPhoto(birdId, pendingPhotoBlob);
        trySyncSoon("birds", currentCoopId);
      } else if (photoRemoved && isEdit) {
        // Clearing the reference locally works offline immediately; the
        // orphaned file on the server gets cleaned up next time this bird's
        // update actually reaches it. Not worth a whole separate removal
        // queue for how rarely this happens.
        await localBirdUpdate(birdId, { photo: null });
      }
      await refreshPendingPhotoUrls();
      showToast(isEdit ? `${payload.name} updated` : `${payload.name} added`, isEdit ? "update" : "create");
      closeModal();
      refreshAndRender();
    });
  }

  render(true);
}

function showBulkForm() {
  const today = todayStr();
  const defaultHatch = addDays(today, -7); // chicks are typically ~1 week old at pickup; adjust if known exactly
  const defaultTarget = addDays(defaultHatch, 42);
  const html = `
    <div class="form-head">Add a batch</div>
    <div class="grid-form">
      <label class="field"><span>How many birds</span><input type="number" id="k_count" min="1" max="200" value="25"></label>
      <label class="field"><span>Batch name</span><input id="k_batch" placeholder="e.g. July Cornish Cross"></label>
      <label class="field"><span>Breed</span><input id="k_breed" placeholder="e.g. Cornish Cross"></label>
      <label class="field"><span>Hatch date</span><input type="date" id="k_hatch" value="${defaultHatch}"></label>
      <label class="field"><span>Acquired date</span><input type="date" id="k_acquired" value="${today}"></label>
      <label class="field"><span>Target harvest date</span><input type="date" id="k_target" value="${defaultTarget}"></label>
    </div>
    <div class="note-box" style="margin-top:10px">Each bird gets its own record — named "Batch name #1", "#2", and so on — so you can still log an individual dressed weight for each one at processing time. This just saves you from typing the shared details over and over. Hatch date defaults to a week before pickup (typical for chick delivery) — adjust it if the hatchery told you the actual date. Target harvest defaults to 6 weeks from hatch; adjust it if your breed runs longer.</div>
    <div style="margin-top:12px"><label class="field"><span>Notes</span><textarea id="k_notes" placeholder="optional"></textarea></label></div>
    <div style="margin-top:12px"><label class="field"><span>Group photo (optional, applied to every bird in the batch)</span><input type="file" id="k_photo" accept="image/*"></label></div>
    <div class="modal-actions"><button class="btn btn-confirm" id="saveBulk">✓ Create batch</button></div>
  `;
  openModal(html);
  let targetTouched = false;
  document.getElementById("k_hatch").addEventListener("change", (e) => {
    if (!targetTouched) document.getElementById("k_target").value = addDays(e.target.value, 42);
  });
  document.getElementById("k_target").addEventListener("input", () => { targetTouched = true; });
  document.getElementById("saveBulk").addEventListener("click", async () => {
    const count = Number(document.getElementById("k_count").value);
    if (!count || count < 1) return;
    if (count > 200) { alert("That's a lot of birds for one batch — try 200 or fewer at a time"); return; }
    const batchName = document.getElementById("k_batch").value.trim() || `Batch ${todayStr()}`;
    const shared = {
      coop_id: currentCoopId,
      breed: document.getElementById("k_breed").value,
      type: "Meat",
      status: "Active",
      hatch_date: document.getElementById("k_hatch").value,
      acquired_date: document.getElementById("k_acquired").value,
      target_harvest_date: document.getElementById("k_target").value,
      batch_name: batchName,
      notes: document.getElementById("k_notes").value,
    };
    const created = await localBulkCreate("birds", Array.from({ length: count }, (_, i) => ({ ...shared, name: `${batchName} #${i + 1}` })));
    const photoFile = document.getElementById("k_photo").files[0];
    if (photoFile) {
      const blob = await resizeImageFileToBlob(photoFile);
      await Promise.all(created.map(b => queuePendingPhoto(b.id, blob)));
      trySyncSoon("birds", currentCoopId);
    }
    showToast(`${count} bird batch added`, "create");
    closeModal();
    refreshAndRender();
  });
}

// ================= EGGS =================
function eggCartonHtml(count) {
  const shown = Math.min(count, 60);
  const dozens = Math.floor(shown / 12);
  const remainder = shown % 12;
  const cartons = [];
  for (let i = 0; i < dozens; i++) cartons.push(12);
  if (remainder > 0) cartons.push(remainder);
  if (cartons.length === 0) return "";
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
    ${cartons.map(n => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--surface-raised);line-height:1.4;font-size:16px">
        <div>${"🥚".repeat(Math.min(n, 6))}</div>
        ${n > 6 ? `<div>${"🥚".repeat(n - 6)}</div>` : ""}
      </div>`).join("")}
    ${count > 60 ? `<div class="dim" style="font-size:11px;align-self:center">+${count - 60} more</div>` : ""}
  </div>`;
}

let eggsSubTab = "eggs";
function renderEggsHub() {
  const el = document.getElementById("panel-eggs");
  const subs = [{ id: "eggs", label: "Eggs" }, { id: "hatching", label: "Hatching" }];
  el.innerHTML = `
    <div class="range-select sub-nav-fixed" id="eggsSubNav">
      ${subs.map(s => `<button class="range-btn ${eggsSubTab === s.id ? "active" : ""}" data-eggssub="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div id="eggsSubContent"></div>
  `;
  el.querySelectorAll("[data-eggssub]").forEach(b => b.addEventListener("click", () => { eggsSubTab = b.dataset.eggssub; renderEggsHub(); }));
  if (eggsSubTab === "eggs") renderEggsMain();
  else if (eggsSubTab === "hatching") renderHatching();
}

/** Standard chicken incubation is 21 days. Phase boundaries here reflect the
 * real process: eggs get turned regularly through day 17 ("setting"), with
 * candling checks around day 7 (spot infertile/"clear" eggs) and day 14
 * (spot "quitters" -- eggs that started developing but died). Day 18 is
 * "lockdown": turning stops, humidity rises, and eggs are left undisturbed
 * through hatch day. Chicks can take a bit longer than exactly 21 days, so
 * day 22+ reads as "overdue" rather than alarming. */
function hatchDayInfo(dateStarted) {
  const daysIn = daysSince(dateStarted);
  const candle1Date = addDays(dateStarted, 7);
  const candle2Date = addDays(dateStarted, 14);
  const lockdownDate = addDays(dateStarted, 18);
  const expectedHatchDate = addDays(dateStarted, 21);
  let phase, tone, milestone;
  if (daysIn < 0) { phase = "Not started yet"; tone = "slate"; }
  else if (daysIn === 0) { phase = "Just set"; tone = "slate"; milestone = `Candling #1 due ${fmtDate(candle1Date)}`; }
  else if (daysIn < 7) { phase = "Incubating — turn eggs regularly"; tone = "slate"; milestone = `Candling #1 due ${fmtDate(candle1Date)}`; }
  else if (daysIn === 7) { phase = "🔦 Candle today — check for fertility"; tone = "gold"; }
  else if (daysIn < 14) { phase = "Incubating — developing"; tone = "slate"; milestone = `Candling #2 due ${fmtDate(candle2Date)}`; }
  else if (daysIn === 14) { phase = "🔦 Candle today — check for quitters"; tone = "gold"; }
  else if (daysIn < 18) { phase = "Incubating — developing"; tone = "slate"; milestone = `Lockdown starts ${fmtDate(lockdownDate)}`; }
  else if (daysIn < 21) { phase = "🔒 Lockdown — stop turning, raise humidity"; tone = "rust"; milestone = `Hatch day ${fmtDate(expectedHatchDate)}`; }
  else if (daysIn === 21) { phase = "🐣 Hatch day!"; tone = "danger"; }
  else { phase = `Overdue ${daysIn - 21}d — some chicks take a little longer than 21 days`; tone = "danger"; }
  return { daysIn, phase, tone, milestone, candle1Date, candle2Date, lockdownDate, expectedHatchDate };
}

/** A horizontal timeline bar spanning the 21-day incubation window, shaded
 * by phase (setting / lockdown / hatch), with a marker for today. */
function hatchTimelineBarHtml(dateStarted) {
  const daysIn = Math.max(0, Math.min(22, daysSince(dateStarted)));
  const pct = Math.min(100, (daysIn / 21) * 100);
  return `
    <div style="position:relative;height:20px;border-radius:6px;overflow:hidden;background:linear-gradient(to right, var(--sage) 0%, var(--sage) 85.7%, var(--gold) 85.7%, var(--gold) 95.2%, var(--danger) 95.2%, var(--danger) 100%);margin:8px 0 4px">
      <div style="position:absolute;top:0;bottom:0;left:${pct}%;width:2px;background:var(--text);box-shadow:0 0 0 2px var(--bg)"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em">
      <span>Day 0</span><span>Candle d7</span><span>Candle d14</span><span>Lockdown d18</span><span>Hatch d21</span>
    </div>`;
}

let editingHatchId = null;

function renderHatching() {
  const el = document.getElementById("eggsSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const active = STATE.hatches.filter(h => h.status !== "Complete").sort((a, b) => a.date_started.localeCompare(b.date_started));
  const complete = STATE.hatches.filter(h => h.status === "Complete").sort((a, b) => b.date_started.localeCompare(a.date_started));

  const stepperRow = (label, hint, count, incAttr, decAttr, incDisabled, decDisabled) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
      <div style="font-size:13px">${label}${hint ? `<span class="dim" style="font-size:11px;display:block">${hint}</span>` : ""}</div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="icon-btn" ${decAttr} ${count === 0 || decDisabled ? "disabled" : ""}>−</button>
        <span style="min-width:18px;text-align:center;font-weight:700">${count}</span>
        <button class="icon-btn" ${incAttr} ${incDisabled ? "disabled" : ""}>+</button>
      </div>
    </div>`;

  const clutchCardHtml = (h) => {
    const info = hatchDayInfo(h.date_started);
    const hatchedCount = Number(h.hatched_count) || 0;
    const namedCount = Number(h.named_count) || 0;
    const clearCount = Number(h.clear_count) || 0;
    const quitCount = Number(h.quit_count) || 0;
    const failedCount = Number(h.failed_count) || 0;
    const accountedFor = hatchedCount + clearCount + quitCount + failedCount;
    const remaining = Math.max(0, (Number(h.egg_count) || 0) - accountedFor);
    const allAccountedFor = remaining === 0 && (Number(h.egg_count) || 0) > 0;
    const pendingToName = Math.max(0, hatchedCount - namedCount);
    const isComplete = h.status === "Complete";
    return `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title" style="margin-bottom:2px">${esc(h.breed) || "Mixed"} · ${h.egg_count} egg${h.egg_count !== 1 ? "s" : ""}</div>
          <div class="dim" style="font-size:12px">Set ${fmtDate(h.date_started)}${!isComplete ? ` · Day ${info.daysIn} · expected hatch ${fmtDate(info.expectedHatchDate)}` : ""}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="icon-btn" data-edit-hatch="${h.id}">✎</button>
          <button class="icon-btn" data-del-hatch="${h.id}">🗑</button>
        </div>
      </div>

      ${!isComplete ? `
        ${hatchTimelineBarHtml(h.date_started)}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          <span class="stamp tone-${info.tone}">${info.phase}</span>
          ${info.milestone ? `<span class="stamp tone-slate">${info.milestone}</span>` : ""}
        </div>
        <div class="dim" style="font-size:10px;margin-top:6px">Candling: ${fmtDate(info.candle1Date)} &amp; ${fmtDate(info.candle2Date)} · Lockdown: ${fmtDate(info.lockdownDate)} · Hatch: ${fmtDate(info.expectedHatchDate)}</div>
      ` : `<div class="stamp tone-sage" style="margin-top:8px">Complete</div>`}

      ${!isComplete ? `
      <div style="margin-top:12px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        ${stepperRow("🐣 Hatched", null, hatchedCount, `data-inc-hatch="${h.id}"`, `data-dec-hatch="${h.id}"`, pendingToName > 0, pendingToName === 0)}
        ${stepperRow("Clear", "infertile -- no chick ever developed", clearCount, `data-inc-clear="${h.id}"`, `data-dec-clear="${h.id}"`, false, false)}
        ${stepperRow("Quit", "started developing, didn't make it", quitCount, `data-inc-quit="${h.id}"`, `data-dec-quit="${h.id}"`, false, false)}
        ${stepperRow("Failed to hatch", "fully developed, never pipped", failedCount, `data-inc-failed="${h.id}"`, `data-dec-failed="${h.id}"`, false, false)}
      </div>
      ` : `
      <div class="dim" style="font-size:12px;margin-top:10px">🐣 ${hatchedCount} hatched · ${clearCount} clear · ${quitCount} quit · ${failedCount} failed to hatch</div>
      `}
      ${pendingToName > 0 ? `<div class="dim" style="font-size:11px;margin-top:4px">Name the chick below before logging another hatch.</div>` : ""}
      <div class="dim" style="font-size:11px;margin-top:8px">${remaining} still incubating${allAccountedFor && !isComplete && pendingToName === 0 ? " -- all eggs accounted for, mark this clutch complete when you're ready" : ""}</div>
      ${allAccountedFor && !isComplete && pendingToName === 0 ? `<button class="btn ghost small" data-complete-hatch="${h.id}" style="margin-top:6px">✓ Mark clutch complete</button>` : ""}
      ${(() => {
        const chicks = STATE.birds.filter(b => b.hatch_id === h.id).sort((a, b) => (a.hatch_date || "").localeCompare(b.hatch_date || ""));
        if (chicks.length === 0) return "";
        return `<div class="dim" style="font-size:11px;margin-top:8px">${chicks.map(c => `${esc(c.name)} (${fmtDate(c.hatch_date)})`).join(", ")}</div>`;
      })()}
      ${h.notes ? `<div class="dim" style="font-size:12px;margin-top:8px">${esc(h.notes)}</div>` : ""}

      ${pendingToName > 0 ? `
        <div class="form-block" style="margin-top:12px;border-color:var(--sage)">
          <div class="form-head" style="font-size:13px">🐣 Name this chick${pendingToName > 1 ? ` (${pendingToName} waiting)` : ""}</div>
          <div class="grid-form">
            <label class="field"><span>Name</span><input id="qc_name_${h.id}" placeholder="e.g. Nugget"></label>
            <label class="field"><span>Type</span><select id="qc_type_${h.id}">${BIRD_TYPES.map(t => `<option ${t === "Layer" ? "selected" : ""}>${t}</option>`).join("")}</select></label>
          </div>
          <div class="dim" style="font-size:11px;margin-top:6px">Breed (${esc(h.breed) || "Mixed"}) and hatch date (${fmtDate(todayStr())}) carry over automatically -- add a photo or anything else later from the Flock tab.</div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn btn-confirm small" data-save-chick="${h.id}">+ Add to flock</button>
            <button class="btn ghost small" data-skip-chick="${h.id}" title="Mark as named without creating a flock record">Already tracked elsewhere</button>
          </div>
        </div>
      ` : ""}
    </div>`;
  };

  el.innerHTML = `
    <div class="toolbar" style="margin-bottom:12px">
      <div class="dim">${active.length} active clutch${active.length !== 1 ? "es" : ""}</div>
      <button class="btn" id="toggleHatchForm">+ Start a clutch</button>
    </div>

    ${active.length === 0 && complete.length === 0 ? `<div class="card"><div class="empty">No clutches yet -- start one when you set eggs in the incubator.</div></div>` : ""}
    ${active.map(clutchCardHtml).join("")}
    ${complete.length > 0 ? `<div class="flock-section-header" style="margin-top:18px">Completed</div>${complete.map(clutchCardHtml).join("")}` : ""}
  `;

  document.getElementById("toggleHatchForm").addEventListener("click", () => openHatchModal(null));
  el.querySelectorAll("[data-edit-hatch]").forEach(b => b.addEventListener("click", () => openHatchModal(STATE.hatches.find(h => h.id === b.dataset.editHatch))));
  el.querySelectorAll("[data-del-hatch]").forEach(b => b.addEventListener("click", async () => {
    if (!(await showConfirmDialog("Delete this clutch and its tracked outcomes? This can't be undone."))) return;
    await localHatchDelete(b.dataset.delHatch, currentCoopId);
    STATE.hatches = await localGetAll("hatches", currentCoopId);
    showToast("Clutch deleted", "delete");
    renderHatching();
  }));
  el.querySelectorAll("[data-complete-hatch]").forEach(b => b.addEventListener("click", async () => {
    await localHatchUpdate(b.dataset.completeHatch, { status: "Complete" });
    STATE.hatches = await localGetAll("hatches", currentCoopId);
    renderHatching();
  }));

  // Shared stepper wiring: each outcome is its own +/- pair, field name
  // passed in so one function handles all four instead of four near-copies.
  const wireStepper = (incSelector, decSelector, field) => {
    el.querySelectorAll(`[${incSelector}]`).forEach(b => b.addEventListener("click", async () => {
      const id = b.getAttribute(incSelector);
      const h = STATE.hatches.find(x => x.id === id);
      await localHatchUpdate(h.id, { [field]: (Number(h[field]) || 0) + 1 });
      STATE.hatches = await localGetAll("hatches", currentCoopId);
      renderHatching();
    }));
    el.querySelectorAll(`[${decSelector}]`).forEach(b => b.addEventListener("click", async () => {
      const id = b.getAttribute(decSelector);
      const h = STATE.hatches.find(x => x.id === id);
      await localHatchUpdate(h.id, { [field]: Math.max(0, (Number(h[field]) || 0) - 1) });
      STATE.hatches = await localGetAll("hatches", currentCoopId);
      renderHatching();
    }));
  };
  wireStepper("data-inc-hatch", "data-dec-hatch", "hatched_count");
  wireStepper("data-inc-clear", "data-dec-clear", "clear_count");
  wireStepper("data-inc-quit", "data-dec-quit", "quit_count");
  wireStepper("data-inc-failed", "data-dec-failed", "failed_count");

  el.querySelectorAll("[data-skip-chick]").forEach(b => b.addEventListener("click", async () => {
    const h = STATE.hatches.find(x => x.id === b.dataset.skipChick);
    await localHatchUpdate(h.id, { named_count: (Number(h.named_count) || 0) + 1 });
    STATE.hatches = await localGetAll("hatches", currentCoopId);
    renderHatching();
  }));
  el.querySelectorAll("[data-save-chick]").forEach(b => b.addEventListener("click", async () => {
    const h = STATE.hatches.find(x => x.id === b.dataset.saveChick);
    const name = document.getElementById(`qc_name_${h.id}`).value.trim();
    if (!name) return;
    const type = document.getElementById(`qc_type_${h.id}`).value;
    await localBirdCreate({ coop_id: currentCoopId, name, breed: h.breed || "", type, status: "Active", hatch_date: todayStr(), hatch_id: h.id });
    await localHatchUpdate(h.id, { named_count: (Number(h.named_count) || 0) + 1 });
    showToast(`${name} added to the flock`, "create");
    STATE.hatches = await localGetAll("hatches", currentCoopId);
    renderHatching();
  }));
}

function hatchFormHtml(editing) {
  return `
    <div class="form-head">${editing ? "Edit clutch" : "Start a new clutch"}</div>
    <div class="grid-form">
      <label class="field"><span>Breed</span><input id="h_breed" placeholder="e.g. Rhode Island Red, or leave blank for mixed" value="${editing ? esc(editing.breed || "") : ""}"></label>
      <label class="field"><span>Date started</span><input type="date" id="h_date" value="${editing ? editing.date_started : todayStr()}"></label>
      <label class="field"><span>Number of eggs</span><input type="number" min="1" step="1" id="h_count" value="${editing ? editing.egg_count : ""}" placeholder="e.g. 12"></label>
    </div>
    <label class="field" style="margin-top:12px"><span>Notes</span><input id="h_notes" placeholder="optional" value="${editing ? esc(editing.notes || "") : ""}"></label>
    <div class="note-box" style="margin-top:10px">Expected hatch date is day 21 from when the eggs went in -- the timeline below each clutch tracks it automatically, including candling and lockdown reminders.</div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveHatch">${editing ? "✓ Save changes" : "+ Start clutch"}</button>
      ${editing ? `<button class="btn btn-close" id="deleteHatch">🗑 Delete</button>` : ""}
    </div>
  `;
}

function openHatchModal(editing) {
  editingHatchId = editing ? editing.id : null;
  openModal(hatchFormHtml(editing), () => { editingHatchId = null; });
  document.getElementById("saveHatch").addEventListener("click", async () => {
    const breed = document.getElementById("h_breed").value.trim();
    const date_started = document.getElementById("h_date").value;
    const egg_count = Number(document.getElementById("h_count").value) || 0;
    const notes = document.getElementById("h_notes").value.trim();
    if (!date_started || egg_count <= 0) return;
    const payload = { coop_id: currentCoopId, breed, date_started, egg_count, notes };
    if (editing) {
      await localHatchUpdate(editing.id, payload);
      showToast("Clutch updated", "update");
    } else {
      await localHatchCreate({ ...payload, hatched_count: 0, named_count: 0, clear_count: 0, quit_count: 0, failed_count: 0, status: "Incubating" });
      showToast("Clutch started", "create");
    }
    closeModal();
    STATE.hatches = await localGetAll("hatches", currentCoopId);
    renderHatching();
  });
  const deleteBtn = document.getElementById("deleteHatch");
  if (deleteBtn) deleteBtn.addEventListener("click", () => confirmAndDelete(
    "Delete this clutch and its tracked outcomes? This can't be undone.",
    () => localHatchDelete(editing.id, currentCoopId),
    "Clutch deleted",
    async () => { STATE.hatches = await localGetAll("hatches", currentCoopId); renderHatching(); }
  ));
}

function renderEggsMain() {
  const el = document.getElementById("eggsSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const years = yearsFromDates(STATE.eggs, "date");
  const filtered = STATE.eggs.filter(e => !eggFilters.year || e.date.slice(0, 4) === eggFilters.year);
  const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date));
  el.innerHTML = `
    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${sorted.length} of ${STATE.eggs.length} shown</div>
      <div style="display:flex;gap:8px">
        ${years.length > 0 ? `<button class="btn ghost small" id="toggleEggFilters">Filters${eggFilters.year ? " (1)" : ""} ${eggFiltersOpen ? "▾" : "▸"}</button>` : ""}
        <button class="btn" id="toggleEggForm">+ Add entry</button>
      </div>
    </div>

    ${eggFiltersOpen && years.length > 0 ? `
    <div class="form-block" style="padding:12px 16px">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <label class="field"><span>Year</span><select id="filterEggYear"><option value="">All years</option>${years.map(y => `<option value="${y}" ${eggFilters.year === y ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      </div>
    </div>
    ` : ""}

    ${sorted.length > 0 ? (() => {
      const totalCount = sorted.reduce((s, e) => s + (Number(e.count) || 0), 0);
      const totalValue = sorted.reduce((s, e) => s + (Number(e.count) || 0) * (Number(e.price_per_egg) || 0), 0);
      return `<div class="note-box" style="margin-bottom:10px">${eggFilters.year ? eggFilters.year : "All time"}: <strong style="color:var(--text)">${totalCount} eggs</strong> (${(totalCount / 12).toFixed(1)} dozen) across ${sorted.length} entr${sorted.length !== 1 ? "ies" : "y"}${totalValue ? ` · <strong style="color:var(--text)">${fmtMoney(totalValue)}</strong> value` : ""}</div>`;
    })() : ""}

    ${sorted.length === 0 ? `<div class="card"><div class="empty">${STATE.eggs.length === 0 ? "No egg logs yet." : "No eggs logged in this year."}</div></div>` : (() => {
      const visible = sorted.slice(0, eggsVisibleCount);
      return `
    <div class="list-stack">
      ${visible.map(e => {
        const value = (Number(e.count) || 0) * (Number(e.price_per_egg) || 0);
        const daysAgo = daysSince(e.date);
        const freshTone = daysAgo === 0 ? "sage" : daysAgo <= 7 ? "slate" : "";
        const freshLabel = daysAgo === 0 ? "New" : daysAgo <= 7 ? "Recent" : "";
        return `
        <div class="list-card${freshTone ? " tone-" + freshTone : ""}" data-edit="${e.id}" style="cursor:pointer;align-items:flex-start">
          <div class="list-card-main">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
              <div style="font-weight:700">${fmtDate(e.date)}${freshLabel ? ` <span class="stamp tone-${freshTone}" style="margin-left:4px">${freshLabel}</span>` : ""}</div>
              ${value > 0 ? `<span class="stamp stamp-lg tone-gold">${fmtMoney(value)}</span>` : ""}
            </div>
            <div class="list-card-desc dim">${e.count} egg${e.count !== 1 ? "s" : ""}${e.price_per_egg ? ` @ ${fmtMoney(e.price_per_egg)}/egg` : ""}${e.notes ? " · " + esc(e.notes) : ""}</div>
            ${eggCartonHtml(Number(e.count) || 0)}
          </div>
          <button class="icon-btn" data-del="${e.id}" onclick="event.stopPropagation()">🗑</button>
        </div>`;
      }).join("")}
    </div>
    ${loadMoreButtonHtml(sorted.length, eggsVisibleCount)}`;
    })()}
  `;
  document.getElementById("toggleEggForm").addEventListener("click", () => openEggModal(null));
  const toggleFiltersBtn = document.getElementById("toggleEggFilters");
  if (toggleFiltersBtn) toggleFiltersBtn.addEventListener("click", () => { eggFiltersOpen = !eggFiltersOpen; renderEggsMain(); });
  const yearFilterEl = document.getElementById("filterEggYear");
  if (yearFilterEl) yearFilterEl.addEventListener("change", (e) => { eggFilters.year = e.target.value; eggsVisibleCount = PAGE_SIZE; renderEggsMain(); });
  const loadMoreEl = document.getElementById("loadMoreBtn");
  if (loadMoreEl) loadMoreEl.addEventListener("click", () => { eggsVisibleCount += PAGE_SIZE; renderEggsMain(); });
  el.querySelectorAll("[data-edit]").forEach(card => card.addEventListener("click", () => openEggModal(STATE.eggs.find(e => e.id === card.dataset.edit))));
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    await localEggDelete(b.dataset.del, currentCoopId);
    showToast("Egg log deleted", "delete");
    if (editingEggId === b.dataset.del) editingEggId = null;
    STATE.eggs = await localGetAll("eggs", currentCoopId);
    renderEggsMain();
  }));
}

function eggFormHtml(editing) {
  return `
    <div class="form-head">${editing ? "Edit egg log" : "Log eggs collected"}</div>
    <div class="grid-form">
      <label class="field"><span>Date</span><input type="date" id="e_date" value="${editing ? editing.date : todayStr()}"></label>
      <label class="field"><span>Count</span><input type="number" id="e_count" placeholder="e.g. 8" value="${editing ? editing.count : ""}"></label>
      <label class="field"><span>Value Per Egg</span><input type="number" step="0.01" id="e_price" placeholder="e.g. 0.50" value="${editing ? (editing.price_per_egg != null ? editing.price_per_egg : "") : getCoopDefaults().eggPrice}"></label>
      <label class="field"><span>Notes</span><input id="e_notes" placeholder="optional" value="${editing ? esc(editing.notes || "") : ""}"></label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveEgg">${editing ? "✓ Save changes" : "+ Add entry"}</button>
      ${editing ? `<button class="btn btn-close" id="deleteEgg">🗑 Delete</button>` : ""}
    </div>
  `;
}

function openEggModal(editing) {
  editingEggId = editing ? editing.id : null;
  openModal(eggFormHtml(editing), () => { editingEggId = null; });
  document.getElementById("saveEgg").addEventListener("click", async () => {
    const count = document.getElementById("e_count").value;
    if (!count) return;
    const price = document.getElementById("e_price").value;
    const payload = { coop_id: currentCoopId, date: document.getElementById("e_date").value, count: Number(count), price_per_egg: price ? Number(price) : null, notes: document.getElementById("e_notes").value };
    if (editing) await localEggUpdate(editing.id, payload);
    else await localEggCreate(payload);
    showToast(editing ? "Egg log updated" : "Egg log added", editing ? "update" : "create");
    closeModal();
    STATE.eggs = await localGetAll("eggs", currentCoopId);
    renderEggsMain();
  });
  const deleteBtn = document.getElementById("deleteEgg");
  if (deleteBtn) deleteBtn.addEventListener("click", () => confirmAndDelete(
    "Delete this egg log entry? This can't be undone.",
    () => localEggDelete(editing.id, currentCoopId),
    "Egg log deleted",
    async () => { STATE.eggs = await localGetAll("eggs", currentCoopId); renderEggsMain(); }
  ));
}

// ================= EXPENSES =================
const EXPENSE_FOR_TYPES = ["All Birds", "Layers Only", "Meat Birds Only"];
const EXPENSE_UNITS = ["lb", "kg", "cu ft", "bag", "bale", "gallon", "unit", "eggs"];
const QUANTITY_CATEGORIES = new Set(["Layer Feed", "Meat Feed", "Treats", "Bedding"]); // categories where "how much did I buy" is worth tracking

function yearsFromDates(items, field) {
  const years = new Set(items.filter(i => i[field]).map(i => i[field].slice(0, 4)));
  return [...years].sort().reverse();
}

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthKeyOf(dateStr) { return dateStr ? dateStr.slice(0, 7) : null; }
function shiftMonthKey(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabelOf(key) {
  const d = new Date(`${key}-01T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function allExpenseMonthKeys() {
  const keys = new Set(STATE.expenses.map(x => monthKeyOf(x.date)).filter(Boolean));
  keys.add(monthKeyOf(todayStr()));
  return [...keys].sort();
}

function expenseYearKeys() {
  const keys = new Set(STATE.expenses.map(x => x.date.slice(0, 4)));
  keys.add(String(new Date().getFullYear()));
  return [...keys].sort();
}

/** Snapshot the wash-out price at the moment a sale is saved, using only
 * eggs/meat collected on or before the sale's own date -- once saved, this
 * is locked in and won't shift later just because more got collected
 * afterward. Only meaningful for Egg Sale / Meat Sale income entries. */
function computeWashoutSnapshotPrice(category, entryDate) {
  const defaults = getCoopDefaults();
  if (category === "Egg Sale") {
    return weightedAvgEggPrice(STATE.eggs.filter(e => e.date <= entryDate), Number(defaults.eggPrice) || 0);
  }
  if (category === "Meat Sale") {
    return weightedAvgMeatPrice(STATE.birds.filter(b => b.status === "Processed" && b.harvest_date && b.harvest_date <= entryDate), Number(defaults.pricePerLb) || 0);
  }
  return null;
}
function renderExpenses() {
  const el = document.getElementById("panel-expenses");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }

  let scopedExpenses, navHtml, periodLabel;

  if (expenseScope === "all") {
    scopedExpenses = STATE.expenses;
    periodLabel = "All time";
    navHtml = "";
  } else if (expenseScope === "year") {
    const years = expenseYearKeys();
    const minYear = Number(years[0]), maxYear = Number(years[years.length - 1]);
    if (!expenseYearKey || !years.includes(expenseYearKey)) expenseYearKey = String(new Date().getFullYear());
    if (expenseRangeMode) {
      if (!expenseYearKeyTo || !years.includes(expenseYearKeyTo)) expenseYearKeyTo = expenseYearKey;
      const fromY = Math.min(Number(expenseYearKey), Number(expenseYearKeyTo));
      const toY = Math.max(Number(expenseYearKey), Number(expenseYearKeyTo));
      scopedExpenses = STATE.expenses.filter(x => { const y = Number(x.date.slice(0, 4)); return y >= fromY && y <= toY; });
      periodLabel = fromY === toY ? String(fromY) : `${fromY}–${toY}`;
      navHtml = `
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <button class="icon-btn icon-btn-period" id="prevPeriod" ${fromY <= minYear ? "disabled" : ""} style="font-size:18px">‹</button>
          <span class="dim" style="font-size:12px">From</span>
          <select class="period-select" id="rangeFromYear">${years.map(y => `<option value="${y}" ${Number(y) === fromY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <span class="dim" style="font-size:12px">to</span>
          <select class="period-select" id="rangeToYear">${years.map(y => `<option value="${y}" ${Number(y) === toY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <button class="icon-btn icon-btn-period" id="nextPeriod" ${toY >= maxYear ? "disabled" : ""} style="font-size:18px">›</button>
        </div>`;
    } else {
      const y = Number(expenseYearKey);
      scopedExpenses = STATE.expenses.filter(x => x.date.slice(0, 4) === expenseYearKey);
      periodLabel = expenseYearKey;
      navHtml = `
        <div style="display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
          <button class="icon-btn icon-btn-period" id="prevPeriod" ${y <= minYear ? "disabled" : ""} style="font-size:20px">‹</button>
          <select class="period-select" id="jumpPeriod">${years.map(y2 => `<option value="${y2}" ${y2 === expenseYearKey ? "selected" : ""}>${y2}</option>`).join("")}</select>
          <button class="icon-btn icon-btn-period" id="nextPeriod" ${y >= maxYear ? "disabled" : ""} style="font-size:20px">›</button>
        </div>`;
    }
  } else {
    const monthKeys = allExpenseMonthKeys();
    const minKey = monthKeys[0], maxKey = monthKeys[monthKeys.length - 1];
    const yearsForMonth = expenseYearKeys();
    if (!expenseMonthKey || !monthKeys.includes(expenseMonthKey)) expenseMonthKey = monthKeyOf(todayStr());
    if (expenseRangeMode) {
      if (!expenseMonthKeyTo) expenseMonthKeyTo = expenseMonthKey;
      const fromKey = expenseMonthKey <= expenseMonthKeyTo ? expenseMonthKey : expenseMonthKeyTo;
      const toKey = expenseMonthKey <= expenseMonthKeyTo ? expenseMonthKeyTo : expenseMonthKey;
      scopedExpenses = STATE.expenses.filter(x => { const k = monthKeyOf(x.date); return k >= fromKey && k <= toKey; });
      periodLabel = fromKey === toKey ? monthLabelOf(fromKey) : `${monthLabelOf(fromKey)} – ${monthLabelOf(toKey)}`;
      const [fromY, fromM] = fromKey.split("-");
      const [toY, toM] = toKey.split("-");
      const monthOptions = (selectedM) => MONTH_NAMES_SHORT.map((name, i) => `<option value="${String(i + 1).padStart(2, "0")}" ${String(i + 1).padStart(2, "0") === selectedM ? "selected" : ""}>${name}</option>`).join("");
      navHtml = `
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <button class="icon-btn icon-btn-period" id="prevPeriod" ${fromKey <= minKey ? "disabled" : ""} style="font-size:18px">‹</button>
          <span class="dim" style="font-size:12px">From</span>
          <select class="period-select" id="rangeFromMonth">${monthOptions(fromM)}</select>
          <select class="period-select" id="rangeFromYear">${yearsForMonth.map(y => `<option value="${y}" ${y === fromY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <span class="dim" style="font-size:12px">to</span>
          <select class="period-select" id="rangeToMonth">${monthOptions(toM)}</select>
          <select class="period-select" id="rangeToYear">${yearsForMonth.map(y => `<option value="${y}" ${y === toY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <button class="icon-btn icon-btn-period" id="nextPeriod" ${toKey >= maxKey ? "disabled" : ""} style="font-size:18px">›</button>
        </div>`;
    } else {
      const [curY, curM] = expenseMonthKey.split("-");
      scopedExpenses = STATE.expenses.filter(x => monthKeyOf(x.date) === expenseMonthKey);
      periodLabel = monthLabelOf(expenseMonthKey);
      navHtml = `
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <button class="icon-btn icon-btn-period" id="prevPeriod" ${expenseMonthKey <= minKey ? "disabled" : ""} style="font-size:20px">‹</button>
          <select class="period-select" id="jumpMonth">${MONTH_NAMES_SHORT.map((name, i) => `<option value="${String(i + 1).padStart(2, "0")}" ${String(i + 1).padStart(2, "0") === curM ? "selected" : ""}>${name}</option>`).join("")}</select>
          <select class="period-select" id="jumpYear">${yearsForMonth.map(y => `<option value="${y}" ${y === curY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <button class="icon-btn icon-btn-period" id="nextPeriod" ${expenseMonthKey >= maxKey ? "disabled" : ""} style="font-size:20px">›</button>
        </div>`;
    }
  }

  // Category totals for the whole scoped period, regardless of the active
  // category filter -- tapping one both shows its total and filters the list.
  // Categories never mix income and expense (their names don't overlap), so
  // each category's own total is safe to show as a plain positive amount --
  // it's only the OVERALL summary that needs to distinguish direction.
  const categoryTotals = {};
  const categoryQuantities = {}; // { category: { unit: totalQty } } -- quantities only sum cleanly within the same unit
  scopedExpenses.forEach(x => {
    categoryTotals[x.category] = (categoryTotals[x.category] || 0) + (Number(x.amount) || 0);
    if (x.quantity && x.unit) {
      categoryQuantities[x.category] = categoryQuantities[x.category] || {};
      categoryQuantities[x.category][x.unit] = (categoryQuantities[x.category][x.unit] || 0) + Number(x.quantity);
    }
  });
  const totalSpent = scopedExpenses.filter(x => x.entry_type !== "income").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const totalEarned = scopedExpenses.filter(x => x.entry_type === "income").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const netForPeriod = totalEarned - totalSpent;
  const sortedCats = Object.keys(categoryTotals).sort((a, b) => categoryTotals[b] - categoryTotals[a]);
  const quantityLabel = (cat) => {
    const q = categoryQuantities[cat];
    if (!q) return "";
    return " · " + Object.entries(q).map(([unit, total]) => `${total} ${unit}`).join(", ");
  };

  const filteredExpenses = scopedExpenses.filter(x => !expenseFilters.category || x.category === expenseFilters.category);
  const sorted = [...filteredExpenses].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const rows = sorted.map(x => { running += (x.entry_type === "income" ? 1 : -1) * (Number(x.amount) || 0); return { x, running }; });

  el.innerHTML = `
    <div class="range-select" style="margin-bottom:10px;justify-content:center">
      <button class="range-btn ${expenseScope === "month" ? "active" : ""}" data-scope="month">Month</button>
      <button class="range-btn ${expenseScope === "year" ? "active" : ""}" data-scope="year">Year</button>
      <button class="range-btn ${expenseScope === "all" ? "active" : ""}" data-scope="all">All</button>
      ${expenseScope !== "all" ? `<button class="range-btn ${expenseRangeMode ? "active" : ""}" id="toggleRangeMode">↔ Range</button>` : ""}
    </div>

    ${navHtml}

    <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-bottom:12px">
      ${sortedCats.map(cat => `<button class="pill-btn ${expenseFilters.category === cat ? "range-btn active" : ""}" data-cat-pill="${esc(cat)}">${esc(cat)}: ${fmtMoney(categoryTotals[cat])}${quantityLabel(cat)}</button>`).join("")}
    </div>
    ${sortedCats.length > 0 ? `
    <div class="dim" style="text-align:center;font-size:11px;margin-bottom:4px">${esc(periodLabel)}</div>
    <div class="card" style="margin-bottom:14px;display:flex;text-align:center;padding:10px 4px">
      <div style="flex:1">
        <div class="dim" style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.03em">Spent</div>
        <div style="font-weight:700;font-size:16px;font-family:'JetBrains Mono',monospace">${fmtMoney(totalSpent)}</div>
      </div>
      <div style="flex:1;border-left:1px solid var(--border)">
        <div class="dim" style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.03em">Income</div>
        <div style="font-weight:700;font-size:16px;font-family:'JetBrains Mono',monospace;${totalEarned > 0 ? "color:var(--sage)" : ""}">${fmtMoney(totalEarned)}</div>
      </div>
      <div style="flex:1;border-left:1px solid var(--border)">
        <div class="dim" style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.03em">Net</div>
        <div style="font-weight:700;font-size:16px;font-family:'JetBrains Mono',monospace;${netForPeriod >= 0 ? "color:var(--sage)" : "color:var(--danger)"}">${netForPeriod >= 0 ? "+" : ""}${fmtMoney(netForPeriod)}</div>
      </div>
    </div>
    ` : ""}

    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${sorted.length} entr${sorted.length !== 1 ? "ies" : "y"}${expenseFilters.category ? ` in ${esc(expenseFilters.category)}` : ""}</div>
      <button class="btn" id="toggleExpenseForm">+ Add entry</button>
    </div>

    ${sorted.length === 0 ? `<div class="card"><div class="empty">No entries logged${expenseFilters.category ? ` for ${esc(expenseFilters.category)}` : ""} in ${esc(periodLabel)}.</div></div>` : (() => {
      const visibleRows = [...rows].reverse().slice(0, expensesVisibleCount);
      return `
    <div class="list-stack list-stack-timeline">
      ${visibleRows.map(({ x, running }) => {
        const isIncome = x.entry_type === "income";
        return `
        <div class="list-card" data-edit="${x.id}" style="cursor:pointer">
          <div class="timeline-total" style="${running >= 0 ? "color:var(--sage);border-color:var(--sage)" : "color:var(--danger);border-color:var(--danger)"}">${running >= 0 ? "+" : ""}${fmtMoney(running)}</div>
          <div class="list-card-main">
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <span class="stamp tone-${isIncome ? "sage" : "slate"}">${esc(x.category)}</span>
              ${!isIncome ? `<span class="stamp tone-${x.for_type === "Meat Birds Only" ? "rust" : x.for_type === "Layers Only" ? "gold" : "sage"}">${esc(x.for_type || "All Birds")}</span>` : ""}
            </div>
            <div class="list-card-desc dim">${fmtDate(x.date)}${x.quantity ? ` · ${x.quantity} ${esc(x.unit || "")}` : ""}${x.description ? " · " + esc(x.description) : ""}</div>
          </div>
          <div class="list-card-side">
            <span class="stamp stamp-lg tone-${isIncome ? "sage" : "rust"}">${isIncome ? "+" : "−"}${fmtMoney(x.amount)}</span>
            <button class="icon-btn" data-del="${x.id}" onclick="event.stopPropagation()">🗑</button>
          </div>
        </div>`;
      }).join("")}
    </div>
    ${loadMoreButtonHtml(rows.length, expensesVisibleCount)}`;
    })()}
  `;

  el.querySelectorAll("[data-scope]").forEach(b => b.addEventListener("click", () => {
    expenseScope = b.dataset.scope;
    expenseFilters.category = ""; // a category pill from one scope wouldn't necessarily make sense in another
    expensesVisibleCount = PAGE_SIZE;
    renderExpenses();
  }));
  const rangeToggleBtn = document.getElementById("toggleRangeMode");
  if (rangeToggleBtn) rangeToggleBtn.addEventListener("click", () => {
    expenseRangeMode = !expenseRangeMode;
    if (expenseRangeMode) { expenseYearKeyTo = expenseYearKey; expenseMonthKeyTo = expenseMonthKey; }
    expensesVisibleCount = PAGE_SIZE;
    renderExpenses();
  });
  el.querySelectorAll("[data-cat-pill]").forEach(b => b.addEventListener("click", () => {
    const cat = b.dataset.catPill;
    expenseFilters.category = expenseFilters.category === cat ? "" : cat; // tap again to clear
    expensesVisibleCount = PAGE_SIZE;
    renderExpenses();
  }));
  document.getElementById("toggleExpenseForm").addEventListener("click", () => openExpenseModal(null));
  const shiftPeriod = (delta) => {
    if (expenseScope === "year") {
      if (expenseRangeMode) {
        const fromY = Math.min(Number(expenseYearKey), Number(expenseYearKeyTo));
        const toY = Math.max(Number(expenseYearKey), Number(expenseYearKeyTo));
        expenseYearKey = String(fromY + delta);
        expenseYearKeyTo = String(toY + delta);
      } else {
        expenseYearKey = String(Number(expenseYearKey) + delta);
      }
    } else {
      if (expenseRangeMode) {
        const fromKey = expenseMonthKey <= expenseMonthKeyTo ? expenseMonthKey : expenseMonthKeyTo;
        const toKey = expenseMonthKey <= expenseMonthKeyTo ? expenseMonthKeyTo : expenseMonthKey;
        expenseMonthKey = shiftMonthKey(fromKey, delta);
        expenseMonthKeyTo = shiftMonthKey(toKey, delta);
      } else {
        expenseMonthKey = shiftMonthKey(expenseMonthKey, delta);
      }
    }
    expensesVisibleCount = PAGE_SIZE;
    renderExpenses();
  };
  const prevBtn = document.getElementById("prevPeriod");
  if (prevBtn) prevBtn.addEventListener("click", () => shiftPeriod(-1));
  const nextBtn = document.getElementById("nextPeriod");
  if (nextBtn) nextBtn.addEventListener("click", () => shiftPeriod(1));

  // Year scope, single point
  const jumpEl = document.getElementById("jumpPeriod");
  if (jumpEl) jumpEl.addEventListener("change", (e) => { expenseYearKey = e.target.value; expensesVisibleCount = PAGE_SIZE; renderExpenses(); });

  // Month scope, single point -- split Year+Month dropdowns recombine into one key
  const jumpYearEl = document.getElementById("jumpYear");
  const jumpMonthEl = document.getElementById("jumpMonth");
  if (jumpYearEl && jumpMonthEl) {
    const recombine = () => { expenseMonthKey = `${jumpYearEl.value}-${jumpMonthEl.value}`; expensesVisibleCount = PAGE_SIZE; renderExpenses(); };
    jumpYearEl.addEventListener("change", recombine);
    jumpMonthEl.addEventListener("change", recombine);
  }

  // Range mode -- these element IDs are shared between year-scope and
  // month-scope range markup, but only one of the two ever renders at once.
  const rangeFromYearEl = document.getElementById("rangeFromYear");
  const rangeToYearEl = document.getElementById("rangeToYear");
  const rangeFromMonthEl = document.getElementById("rangeFromMonth");
  const rangeToMonthEl = document.getElementById("rangeToMonth");
  if (rangeFromYearEl && rangeFromMonthEl) {
    const recombineFrom = () => { expenseMonthKey = `${rangeFromYearEl.value}-${rangeFromMonthEl.value}`; expensesVisibleCount = PAGE_SIZE; renderExpenses(); };
    const recombineTo = () => { expenseMonthKeyTo = `${rangeToYearEl.value}-${rangeToMonthEl.value}`; expensesVisibleCount = PAGE_SIZE; renderExpenses(); };
    rangeFromYearEl.addEventListener("change", recombineFrom);
    rangeFromMonthEl.addEventListener("change", recombineFrom);
    rangeToYearEl.addEventListener("change", recombineTo);
    rangeToMonthEl.addEventListener("change", recombineTo);
  } else if (rangeFromYearEl) {
    rangeFromYearEl.addEventListener("change", (e) => { expenseYearKey = e.target.value; expensesVisibleCount = PAGE_SIZE; renderExpenses(); });
    rangeToYearEl.addEventListener("change", (e) => { expenseYearKeyTo = e.target.value; expensesVisibleCount = PAGE_SIZE; renderExpenses(); });
  }
  const loadMoreEl = document.getElementById("loadMoreBtn");
  if (loadMoreEl) loadMoreEl.addEventListener("click", () => { expensesVisibleCount += PAGE_SIZE; renderExpenses(); });
  el.querySelectorAll("[data-edit]").forEach(card => card.addEventListener("click", () => openExpenseModal(STATE.expenses.find(x => x.id === card.dataset.edit))));
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    const wasIncome = STATE.expenses.find(x => x.id === b.dataset.del)?.entry_type === "income";
    await localExpenseDelete(b.dataset.del, currentCoopId);
    showToast(wasIncome ? "Income deleted" : "Expense deleted", "delete");
    if (editingExpenseId === b.dataset.del) editingExpenseId = null;
    refreshAndRender();
  }));
}

function expenseFormHtml(editing) {
  return `
    <div class="form-head">${editing ? "Edit entry" : "Log an entry"}</div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button type="button" class="btn ${expenseFormEntryType === "expense" ? "btn-close" : "ghost"} small" id="entryTypeExpense">💸 Expense</button>
      <button type="button" class="btn ${expenseFormEntryType === "income" ? "btn-confirm" : "ghost"} small" id="entryTypeIncome">💰 Income</button>
    </div>
    <div class="grid-form">
      <label class="field"><span>Date</span><input type="date" id="x_date" value="${editing ? editing.date : todayStr()}"></label>
      <label class="field"><span>Category</span><select id="x_cat">${(expenseFormEntryType === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(c => `<option ${(editing ? editing.category === c : pendingExpenseCategory === c) ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field"><span>Amount ($, total)</span><input type="number" step="0.01" id="x_amount" value="${editing ? editing.amount : ""}"></label>
      <label class="field"><span>Quantity${expenseFormEntryType === "income" ? "" : " (per bag/item)"}</span><input type="number" step="0.01" id="x_qty" placeholder="e.g. 50" value="${editing && editing.quantity != null ? editing.quantity : ""}"></label>
      <label class="field"><span>Unit</span><select id="x_unit"><option value="">—</option>${EXPENSE_UNITS.map(u => `<option ${editing && editing.unit === u ? "selected" : ""}>${u}</option>`).join("")}</select></label>
      ${!editing && expenseFormEntryType === "expense" ? `<label class="field"><span>Number of bags/items</span><input type="number" min="1" max="200" step="1" id="x_count" value="1"></label>` : ""}
      ${expenseFormEntryType === "expense" ? `<label class="field"><span>Applies to</span><select id="x_for">${EXPENSE_FOR_TYPES.map(t => `<option ${editing ? (editing.for_type === t ? "selected" : "") : (t === "All Birds" ? "selected" : "")}>${t}</option>`).join("")}</select></label>` : ""}
      <label class="field"><span>Description</span><input id="x_desc" placeholder="${expenseFormEntryType === "income" ? "e.g. Sold to neighbor" : "e.g. 50lb layer feed"}" value="${editing ? esc(editing.description || "") : ""}"></label>
    </div>
    <div class="note-box" style="margin-top:10px">${expenseFormEntryType === "income"
      ? `For Egg Sale or Meat Sale specifically, fill in the quantity (eggs or lbs) -- this lets the app subtract that amount from the estimated "value produced" on the Coop tab, so a sale doesn't get counted twice: once as an estimate when collected, and again as real income here.`
      : `Layer Feed and Meat Feed are separate categories now, so the cost-per-dozen and cost-per-lb estimates on the Coop tab stay accurate without needing a flock tag. "Applies to" still matters for shared costs like Bedding or Equipment.${!editing ? " Buying more than one bag at once? Set the count, and the total amount here covers all of them -- each still becomes its own separate, independently trackable item in the Supply tab's inventory." : ""}`}</div>
    ${!editing && expenseFormEntryType === "expense" && QUANTITY_CATEGORIES.has(document.getElementById("x_cat") ? document.getElementById("x_cat").value : EXPENSE_CATEGORIES[0]) ? `<div id="productPickerHost">${renderProductPickerRow(document.getElementById("x_cat") ? document.getElementById("x_cat").value : EXPENSE_CATEGORIES[0])}</div>` : ""}
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveExpense">${editing ? "✓ Save changes" : "+ Add entry"}</button>
      ${editing ? `<button class="btn btn-close" id="deleteExpense">🗑 Delete</button>` : ""}
    </div>
  `;
}

/** Wires the expense form. The entry-type toggle and category change both
 * affect which fields show (Applies-to only for expenses, the product
 * picker only for quantity-tracked expense categories, etc) -- rather than
 * closing and reopening the modal for that, refreshModalContent() rebuilds
 * just the form in place and this re-wires the fresh copy, the same way
 * wireProductPicker already refreshes just its own row without touching
 * the form around it. */
function wireExpenseFormModal(editing) {
  applyFeedUnitLock("x_cat", "x_unit", expenseFormEntryType === "income" ? INCOME_UNIT_LOCKS : UNIT_LOCKS);
  const refreshForm = () => { refreshModalContent(expenseFormHtml(editing)); wireExpenseFormModal(editing); };
  document.getElementById("entryTypeExpense").addEventListener("click", () => { expenseFormEntryType = "expense"; pendingExpenseCategory = null; refreshForm(); });
  document.getElementById("entryTypeIncome").addEventListener("click", () => { expenseFormEntryType = "income"; pendingExpenseCategory = null; refreshForm(); });
  document.getElementById("x_cat").addEventListener("change", (e) => { pendingExpenseCategory = e.target.value; refreshForm(); });
  const productPickerHost = document.getElementById("productPickerHost");
  if (productPickerHost) wireProductPicker(productPickerHost, { categoryFieldId: "x_cat", brandFieldId: "x_desc", qtyFieldId: "x_qty", unitFieldId: "x_unit", rerenderFn: refreshForm });

  document.getElementById("saveExpense").addEventListener("click", async () => {
    const amount = document.getElementById("x_amount").value;
    if (!amount) return;
    const perItemQty = document.getElementById("x_qty").value;
    const category = document.getElementById("x_cat").value;
    const unit = document.getElementById("x_unit").value || null;
    const description = document.getElementById("x_desc").value;
    const date = document.getElementById("x_date").value;
    const countEl = document.getElementById("x_count");
    const count = countEl ? Math.max(1, Number(countEl.value) || 1) : 1;
    if (count > 200) { alert("That's a lot of separate bags for one entry — try 200 or fewer at a time"); return; }
    // The expense's own quantity is the TOTAL across all bags (for accurate
    // category aggregation elsewhere); the inventory gets `count` separate
    // per-bag items instead, so each is trackable on its own.
    const totalQty = perItemQty ? Number(perItemQty) * count : null;
    const forTypeEl = document.getElementById("x_for");
    const washoutUnitPrice = (expenseFormEntryType === "income" && (category === "Egg Sale" || category === "Meat Sale"))
      ? computeWashoutSnapshotPrice(category, date)
      : null;
    const payload = { coop_id: currentCoopId, date, category, for_type: forTypeEl ? forTypeEl.value : null, description, amount: Number(amount), quantity: totalQty, unit, entry_type: expenseFormEntryType, washout_unit_price: washoutUnitPrice };
    if (editing) {
      await localExpenseUpdate(editing.id, payload);
      showToast(expenseFormEntryType === "income" ? "Income updated" : "Expense updated", "update");
    } else {
      const created = await localExpenseCreate(payload);
      showToast(expenseFormEntryType === "income" ? "Income added" : "Expense added", "create");
      // A new purchase with a quantity, in a trackable category, becomes
      // fresh "Full" item(s) in the Supply tab's inventory automatically --
      // Supplies are local-first too now, so this works offline the same as
      // the expense itself.
      if (perItemQty && QUANTITY_CATEGORIES.has(category)) {
        const selectedProduct = selectedProductId ? STATE.supplyProducts.find(p => p.id === selectedProductId) : null;
        if (selectedProductId) await localSupplyProductUpdate(selectedProductId, { last_used_at: todayStr() });
        await localBulkCreate("supplies", Array.from({ length: count }, () => ({
          coop_id: currentCoopId, category, description: (selectedProduct && selectedProduct.default_description) || description || category, brand: selectedProduct ? selectedProduct.brand : null,
          quantity: Number(perItemQty), unit, status: "Full", date_added: date, source_expense_id: created.id,
          product_id: selectedProductId || null,
        })));
        showToast(count > 1 ? `${count} items added to inventory` : `Added to inventory: ${description || category}`, "create");
      }
    }
    closeModal();
    refreshAndRender();
  });
  const deleteBtn = document.getElementById("deleteExpense");
  if (deleteBtn) deleteBtn.addEventListener("click", () => confirmAndDelete(
    editing.entry_type === "income" ? "Delete this income entry? This can't be undone." : "Delete this expense entry? This can't be undone.",
    () => localExpenseDelete(editing.id, currentCoopId),
    editing.entry_type === "income" ? "Income deleted" : "Expense deleted",
    refreshAndRender
  ));
}

function openExpenseModal(editing) {
  editingExpenseId = editing ? editing.id : null;
  expenseFormEntryType = editing ? (editing.entry_type === "income" ? "income" : "expense") : "expense";
  pendingExpenseCategory = null;
  selectedProductId = null;
  editingProductId = null;
  newProductFormOpen = false;
  openModal(expenseFormHtml(editing), () => {
    editingExpenseId = null;
    pendingExpenseCategory = null;
    selectedProductId = null;
    editingProductId = null;
    newProductFormOpen = false;
  });
  wireExpenseFormModal(editing);
}

// ================= BEDDING =================
/** A horizontal row of saved product photos to reuse instead of retaking a
 * photo of the same brand every time it's bought again, plus a tile to add
 * a new one. Shared by the supply form and the expense form's auto-create
 * flow -- both just embed this HTML and call wireProductPicker after. */
/** Shared by both the picker's inline mini-form and the Supply tab's
 * "Products" page's edit form -- one definition, so the two never drift apart. */
function renderProductEditFormHtml(editingProduct, category, standalone = false) {
  const lockedUnit = UNIT_LOCKS[category];
  const inner = `
      <div class="dim" style="font-size:11px;margin-bottom:6px">${editingProduct ? `Editing "${esc(editingProduct.brand)}"` : "New saved product"}</div>
      <div class="grid-form">
        <label class="field"><span>Brand</span><input id="np_brand" placeholder="e.g. Purina Layena" value="${editingProduct ? esc(editingProduct.brand || "") : ""}"></label>
        <label class="field"><span>Photo${editingProduct ? " (leave blank to keep current)" : ""}</span><input type="file" id="np_photo" accept="image/*"></label>
        <label class="field"><span>Description</span><input id="np_desc" placeholder="e.g. large bag" value="${editingProduct ? esc(editingProduct.default_description || "") : ""}"></label>
        <label class="field"><span>Usual quantity</span><input type="number" step="0.01" id="np_qty" placeholder="e.g. 50" value="${editingProduct && editingProduct.default_quantity != null ? editingProduct.default_quantity : ""}"></label>
        <label class="field"><span>Usual unit</span><select id="np_unit" ${lockedUnit ? "disabled" : ""}>${lockedUnit
          ? `<option selected>${lockedUnit}</option>`
          : `<option value="">—</option>${EXPENSE_UNITS.map(u => `<option ${editingProduct && editingProduct.default_unit === u ? "selected" : ""}>${u}</option>`).join("")}`
        }</select></label>
      </div>
      <div class="dim" style="font-size:11px;margin-top:6px">Selecting this product will fill in the brand (and description/quantity/unit, if set here) automatically -- keeps bags of the same product consistent instead of drifting apart by typo.</div>
      ${standalone ? `
      <div class="modal-actions">
        <button class="btn btn-confirm" id="saveNewProduct">✓ Save product</button>
        ${editingProduct ? `<button class="btn btn-close" id="deleteProduct">🗑 Delete</button>` : ""}
      </div>
      ` : `
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-confirm small" id="saveNewProduct">✓ Save product</button>
        <button class="btn btn-close small" id="cancelNewProduct">Cancel</button>
      </div>
      `}
  `;
  return standalone ? inner : `<div class="form-block" style="margin:4px 0 8px;padding:10px">${inner}</div>`;
}

function renderProductPickerRow(category) {
  const products = STATE.supplyProducts.filter(p => !category || p.category === category);
  // Group by brand so duplicate/near-duplicate saved products (e.g. two
  // "Purina Layena" entries created by accident) are visually clustered
  // together instead of scattered through the row.
  const groups = {};
  products.forEach(p => {
    const key = p.brand || p.category;
    (groups[key] = groups[key] || []).push(p);
  });
  const sortedGroups = Object.entries(groups)
    .map(([brand, items]) => ({ brand, items: items.sort((a, b) => (b.last_used_at || "").localeCompare(a.last_used_at || "")) }))
    .sort((a, b) => (b.items[0].last_used_at || "").localeCompare(a.items[0].last_used_at || ""));
  const editingProduct = editingProductId ? STATE.supplyProducts.find(p => p.id === editingProductId) : null;
  const formOpen = newProductFormOpen || !!editingProduct;
  const tileHtml = (p) => {
    const qtyPart = p.default_quantity != null ? `${p.default_quantity} ${p.default_unit || ""}`.trim() : "";
    const label = [p.default_description, qtyPart].filter(Boolean).join(" -- ") || p.brand || p.category;
    return `
        <div class="product-picker-item${selectedProductId === p.id ? " selected" : ""}" data-product="${p.id}">
          <span class="product-picker-remove" data-remove-product="${p.id}" title="Remove this saved product">×</span>
          <span class="product-picker-edit" data-edit-product="${p.id}" title="Rename or update this product">✎</span>
          <div class="product-picker-thumb">${productPhotoUrl(p) ? `<img src="${productPhotoUrl(p)}">` : "📦"}</div>
          <div class="product-picker-label">${esc(label)}</div>
        </div>`;
  };
  return `
    <div class="dim" style="font-size:11px;margin:8px 0 2px">Saved products${category ? ` (${category})` : ""} -- tap to reuse instead of retaking a photo</div>
    <div class="product-picker-row" id="productPickerRow">
      ${sortedGroups.map(({ brand, items }) => `
        <div class="product-brand-group">
          <div class="product-brand-group-label">${esc(brand)}</div>
          <div class="product-brand-group-items">${items.map(tileHtml).join("")}</div>
        </div>`).join("")}
      <div class="product-picker-new" id="newProductTile">
        <div class="product-picker-thumb">+</div>
        <div class="product-picker-label">New</div>
      </div>
    </div>
    ${formOpen ? renderProductEditFormHtml(editingProduct, editingProduct ? editingProduct.category : category) : ""}
  `;
}

/** Wires the picker rendered above. categoryFieldId/brandFieldId let it work
 * inside either the supply form or the expense form without duplicating
 * this logic -- it just reads/writes whichever field ids that host form
 * actually uses. rerenderFn re-renders enough of the host form to reflect
 * a new selection or a newly-created product. */
function wireProductPicker(el, { categoryFieldId, brandFieldId, descFieldId, qtyFieldId, unitFieldId, rerenderFn }) {
  // Re-renders and re-wires just the picker itself, not the whole host
  // form -- a full rerenderFn() rebuilds category/brand/quantity fields
  // from scratch, which would erase whatever was just filled in (including
  // snapping the category dropdown back to its default, since a brand-new
  // item has no "selected" category to persist across a rebuild).
  const refreshPicker = () => {
    const categoryField = document.getElementById(categoryFieldId);
    const currentCategory = categoryField ? categoryField.value : null;
    el.innerHTML = renderProductPickerRow(currentCategory);
    wireProductPicker(el, { categoryFieldId, brandFieldId, descFieldId, qtyFieldId, unitFieldId, rerenderFn });
  };
  el.querySelectorAll("[data-product]").forEach(item => item.addEventListener("click", () => {
    const id = item.dataset.product;
    selectedProductId = selectedProductId === id ? null : id; // tap again to deselect
    const product = STATE.supplyProducts.find(p => p.id === id);
    // Always sync these fields to the selected product (not just when
    // empty) -- this is what keeps every bag of the same product
    // consistent, which is what the grouping logic actually depends on to
    // collapse identical sealed bags together correctly.
    if (product) {
      const brandField = document.getElementById(brandFieldId);
      if (brandField) brandField.value = product.brand;
      const descField = descFieldId ? document.getElementById(descFieldId) : null;
      if (descField && product.default_description) descField.value = product.default_description;
      const qtyField = qtyFieldId ? document.getElementById(qtyFieldId) : null;
      if (qtyField && product.default_quantity != null) qtyField.value = product.default_quantity;
      const unitField = unitFieldId ? document.getElementById(unitFieldId) : null;
      if (unitField && product.default_unit) unitField.value = product.default_unit;
    }
    refreshPicker();
  }));
  el.querySelectorAll("[data-remove-product]").forEach(btn => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const id = btn.dataset.removeProduct;
    if (!(await showConfirmDialog("Remove this saved product? Any bags already using its photo will lose it too, not just future ones -- this can't be undone."))) return;
    await localSupplyProductDelete(id, currentCoopId);
    if (selectedProductId === id) selectedProductId = null;
    STATE.supplyProducts = await localGetAll("supply_products", currentCoopId);
    refreshPicker();
  }));
  el.querySelectorAll("[data-edit-product]").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    editingProductId = btn.dataset.editProduct;
    newProductFormOpen = false;
    refreshPicker();
  }));
  const newTile = document.getElementById("newProductTile");
  if (newTile) newTile.addEventListener("click", () => { newProductFormOpen = true; editingProductId = null; refreshPicker(); });
  const cancelBtn = document.getElementById("cancelNewProduct");
  if (cancelBtn) cancelBtn.addEventListener("click", () => { newProductFormOpen = false; editingProductId = null; refreshPicker(); });
  const saveBtn = document.getElementById("saveNewProduct");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const brand = document.getElementById("np_brand").value.trim();
    if (!brand) { alert("Give the product a name first"); return; }
    const qtyVal = document.getElementById("np_qty").value;
    const unitVal = document.getElementById("np_unit").value;
    const descVal = document.getElementById("np_desc").value;
    const photoFile = document.getElementById("np_photo").files[0];
    let productId;
    if (editingProductId) {
      await localSupplyProductUpdate(editingProductId, {
        brand, default_quantity: qtyVal ? Number(qtyVal) : null, default_unit: unitVal || null, default_description: descVal || null,
      });
      productId = editingProductId;
    } else {
      const categoryField = document.getElementById(categoryFieldId);
      const category = categoryField ? categoryField.value : "";
      const created = await localSupplyProductCreate({
        coop_id: currentCoopId, category, brand, last_used_at: todayStr(),
        default_quantity: qtyVal ? Number(qtyVal) : null, default_unit: unitVal || null, default_description: descVal || null,
      });
      productId = created.id;
    }
    if (photoFile) {
      const blob = await resizeImageFileToBlob(photoFile);
      await queuePendingProductPhoto(productId, blob);
      trySyncSoon("supply_products", currentCoopId);
      await refreshPendingProductPhotoUrls();
    }
    selectedProductId = productId;
    newProductFormOpen = false;
    editingProductId = null;
    STATE.supplyProducts = await localGetAll("supply_products", currentCoopId);
    const brandField = document.getElementById(brandFieldId);
    if (brandField) brandField.value = brand;
    refreshPicker();
  });
}

function supplyCardHtml(s) {
  const tone = supplyStatusTone(s.status); // "sage" | "gold" | "rust" | "slate"
  const catTone = supplyCategoryTone(s.category);
  const headerText = (catTone === "rust" || catTone === "danger") ? "#F2E9DC" : "#1E1712";
  const fillPctMap = { "Full": 100, "3/4": 75, "1/2": 50, "1/4": 25, "Empty": 3 };
  const fillPct = fillPctMap[s.status] ?? 100;
  const sliderVal = supplySliderValue(s.status);
  const amountLabel = s.quantity ? `${s.quantity} ${esc(s.unit || "")}` : "";
  const product = s.product_id ? STATE.supplyProducts.find(p => p.id === s.product_id) : null;
  const photo = product ? productPhotoUrl(product) : null;
  // Flipped from a colored overlay showing how full a bag is, to full
  // color where product remains and greyscale + red dashes where it's
  // been used -- clip-path on the color layer is what reveals only the
  // remaining fraction, from the bottom up.
  const bagBorderStyle = `border-color:color-mix(in srgb, var(--${catTone}) 45%, var(--border))`;
  const bagStyle = photo ? bagBorderStyle : `background:color-mix(in srgb, var(--${catTone}) 10%, var(--bg));${bagBorderStyle}`;
  const bagInner = photo
    ? `<div class="supply-bag-grey-base" style="background-image:url('${photo}')"></div>
       <div class="supply-bag-dash-overlay"></div>
       <div class="supply-bag-color-reveal" style="background-image:url('${photo}');clip-path:inset(${100 - fillPct}% 0 0 0)"></div>`
    : `<div class="supply-bag-fill" style="height:${fillPct}%;background:var(--${tone})"></div>`;
  const line1 = s.brand || s.description || s.category;
  const line2 = (s.description && s.description !== line1) ? s.description : "";
  return `<div class="supply-card" data-edit-supply="${s.id}" style="border-color:var(--${catTone})">
    <input type="checkbox" class="supply-card-check supply-check" data-id="${s.id}" ${selectedSupplyIds.has(s.id) ? "checked" : ""} onclick="event.stopPropagation()">
    <div class="supply-card-header-bar" style="background:var(--${catTone});color:${headerText}">
      <div class="supply-card-header-name">${esc(line1)}</div>
      ${line2 ? `<div class="supply-card-header-sub">${esc(line2)}</div>` : ""}
    </div>
    <div class="supply-card-meta dim" style="text-align:center">${esc(s.category)}${amountLabel ? ` -- ${amountLabel}` : ""}</div>
    <div class="supply-bag-visual" title="${esc(s.status)}" style="${bagStyle}">${bagInner}</div>
    <div class="supply-slider-wrap">
      <input type="range" class="supply-slider" min="0" max="4" step="1" value="${sliderVal}" data-id="${s.id}" style="accent-color:var(--${tone});color:var(--${tone})" onclick="event.stopPropagation()">
    </div>
    <div class="supply-stamp-row"><span class="stamp tone-${tone}">${esc(supplyStampLabel(s))}</span></div>
  </div>`;
}

function supplyGroupFormHtml(members) {
  const first = members[0];
  return `
    <div class="form-head">Edit group (${members.length} full)</div>
    <div class="dim" style="font-size:12px;margin:8px 0 14px">Changes apply to the whole pile. Raise the count to add more (e.g. you actually bought 10, not 9), lower it to remove some -- no need to open and delete bags one at a time.</div>
    <div class="grid-form">
      <label class="field"><span>Category</span><select id="grp_category">${[...QUANTITY_CATEGORIES].map(c => `<option ${first.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field"><span>Brand</span><input id="grp_brand" value="${esc(first.brand || "")}"></label>
      <label class="field"><span>Description</span><input id="grp_desc" value="${esc(first.description || "")}"></label>
      <label class="field"><span>Quantity (per item)</span><input type="number" step="0.01" id="grp_qty" value="${first.quantity ?? ""}"></label>
      <label class="field"><span>Unit</span><select id="grp_unit">${EXPENSE_UNITS.map(u => `<option ${first.unit === u ? "selected" : ""}>${u}</option>`).join("")}</select></label>
      <label class="field"><span>Date added</span><input type="date" id="grp_date" value="${first.date_added || todayStr()}"></label>
      <label class="field"><span>Count</span><input type="number" min="0" max="500" step="1" id="grp_count" value="${members.length}"></label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveGroupBtn">✓ Save changes</button>
      <button class="btn btn-close" id="deleteGroupBtn">🗑 Delete all ${members.length}</button>
    </div>
  `;
}

function openSupplyGroupModal(key) {
  const members = STATE.supplies.filter(s => s.status === "Full" && !s.opened_at && supplyGroupKey(s) === key);
  if (members.length === 0) return;
  openModal(supplyGroupFormHtml(members));
  applyFeedUnitLock("grp_category", "grp_unit");

  document.getElementById("saveGroupBtn").addEventListener("click", async () => {
    const payload = {
      coop_id: currentCoopId,
      category: document.getElementById("grp_category").value,
      brand: document.getElementById("grp_brand").value,
      description: document.getElementById("grp_desc").value,
      quantity: document.getElementById("grp_qty").value ? Number(document.getElementById("grp_qty").value) : null,
      unit: document.getElementById("grp_unit").value,
      date_added: document.getElementById("grp_date").value,
      status: "Full",
      date_emptied: null,
      product_id: members[0] ? (members[0].product_id || null) : null,
    };
    const targetCount = Math.max(0, Math.floor(Number(document.getElementById("grp_count").value) || 0));
    if (targetCount > 500) { alert("That's a lot of bags for one group -- try 500 or fewer at a time"); return; }
    const currentIds = members.map(m => m.id);
    const keepIds = currentIds.slice(0, Math.min(targetCount, currentIds.length));
    const removeIds = currentIds.slice(keepIds.length);
    const addCount = Math.max(0, targetCount - currentIds.length);
    // Whichever of these actually has anything to do fires as ONE bulk
    // request, not one request per bag -- this is what changing the count
    // by a lot (raising or lowering) used to turn into hundreds or
    // thousands of individual sync operations.
    await Promise.all([
      keepIds.length > 0 ? localBulkUpdate("supplies", keepIds.map(id => ({ id, fields: payload })), currentCoopId) : Promise.resolve(),
      removeIds.length > 0 ? localBulkDelete("supplies", removeIds, currentCoopId) : Promise.resolve(),
      addCount > 0 ? localBulkCreate("supplies", Array.from({ length: addCount }, () => payload)) : Promise.resolve(),
    ]);
    showToast(`Group updated (${targetCount} full)`, "update");
    closeModal();
    await loadCoopData();
    renderSupplyInventory();
  });

  document.getElementById("deleteGroupBtn").addEventListener("click", async () => {
    if (!(await showConfirmDialog(`Delete all ${members.length} bags in this group? This can't be undone.`))) return;
    await localBulkDelete("supplies", members.map(m => m.id), currentCoopId);
    showToast(`${members.length} items deleted`, "delete");
    closeModal();
    await loadCoopData();
    renderSupplyInventory();
  });
}

function emptySupplyModalHtml() {
  const emptyItems = STATE.supplies.filter(s => s.status === "Empty").sort((a, b) => (b.date_emptied || "").localeCompare(a.date_emptied || ""));
  const paged = emptyItems.slice(0, emptySupplyVisibleCount);
  return `
    <div class="form-head">Emptied (${emptyItems.length})</div>
    <div class="dim" style="font-size:12px;margin:8px 0 14px">Kept for your records — how long each one lasted stays intact for future cost/usage stats. Slide one back to a fill level if it was marked empty by mistake, or delete it for good.</div>
    ${emptyItems.length === 0 ? `<div class="empty">Nothing emptied yet.</div>` : `
    <div class="list-stack">
      ${paged.map(s => {
        const product = s.product_id ? STATE.supplyProducts.find(p => p.id === s.product_id) : null;
        const photo = product ? productPhotoUrl(product) : null;
        return `
        <div class="list-card tone-slate">
          ${photo ? `<div style="width:44px;height:44px;border-radius:6px;overflow:hidden;flex:0 0 auto;margin-right:2px"><img src="${photo}" style="width:100%;height:100%;object-fit:cover;opacity:0.75"></div>` : ""}
          <div class="list-card-main">
            <div style="font-weight:600">${esc(s.brand || s.description || s.category)}</div>
            <div class="list-card-desc dim">${esc(s.category)}${s.quantity ? ` · ${s.quantity} ${esc(s.unit || "")}` : ""}</div>
            <div class="list-card-desc dim">${s.date_added ? `added ${fmtDate(s.date_added)}` : ""}${s.date_emptied ? ` · emptied ${fmtDate(s.date_emptied)}` : ""}${s.date_added && s.date_emptied ? ` · lasted ${daysSince(s.date_added) - daysSince(s.date_emptied)}d` : ""}</div>
          </div>
          <div class="list-card-side">
            <button class="icon-btn" data-restore-supply="${s.id}" title="Not actually empty -- restore to Full">↺</button>
            <button class="icon-btn" data-del-supply-modal="${s.id}" title="Delete permanently">🗑</button>
          </div>
        </div>`;
      }).join("")}
    </div>
    ${loadMoreButtonHtml(emptyItems.length, emptySupplyVisibleCount, "loadMoreEmptyBtn")}
    `}
  `;
}

function wireEmptySupplyModal() {
  document.querySelectorAll("[data-restore-supply]").forEach(b => b.addEventListener("click", async () => {
    await localSupplyUpdate(b.dataset.restoreSupply, { status: "Full", date_emptied: null });
    showToast("Restored to Full", "update");
    await loadCoopData();
    refreshModalContent(emptySupplyModalHtml());
    wireEmptySupplyModal();
    renderSupplyInventory();
  }));
  document.querySelectorAll("[data-del-supply-modal]").forEach(b => b.addEventListener("click", async () => {
    if (!(await showConfirmDialog("Delete this supply item permanently? This can't be undone."))) return;
    await localSupplyDelete(b.dataset.delSupplyModal, currentCoopId);
    showToast("Supply item deleted", "delete");
    await loadCoopData();
    refreshModalContent(emptySupplyModalHtml());
    wireEmptySupplyModal();
    renderSupplyInventory();
  }));
  const loadMoreEmptyEl = document.getElementById("loadMoreEmptyBtn");
  if (loadMoreEmptyEl) loadMoreEmptyEl.addEventListener("click", () => {
    emptySupplyVisibleCount += PAGE_SIZE;
    refreshModalContent(emptySupplyModalHtml());
    wireEmptySupplyModal();
  });
}

function openEmptySupplyModal() {
  emptySupplyVisibleCount = PAGE_SIZE;
  openModal(emptySupplyModalHtml());
  wireEmptySupplyModal();
}

/** A pile of identical Full bags (same category/description/quantity/unit)
 * collapses into one compact card with a count, instead of one big card per
 * bag -- buying 10 bags on a good sale shouldn't mean 10 cards. "Open one"
 * just opens the normal edit form for a single bag from the pile; once its
 * status changes from Full, it naturally becomes its own individual card and
 * the pile's count drops by one. */
function supplyGroupKey(s) { return `${s.category}|${s.brand || s.description || ""}|${s.quantity}|${s.unit || ""}`; }

function supplyGroupCardHtml(items) {
  const first = items[0];
  const count = items.length;
  const key = supplyGroupKey(first);
  const catTone = supplyCategoryTone(first.category);
  const headerText = (catTone === "rust" || catTone === "danger") ? "#F2E9DC" : "#1E1712";
  const amountLabel = first.quantity ? `${first.quantity} ${esc(first.unit || "")} each` : "";
  const MAX_SHOWN = 6;
  const shownCount = Math.min(count, MAX_SHOWN);
  // Any item in the group with a resolvable photo, not just whichever
  // happens to be first -- a group can end up mixing older items (created
  // before they were linked to a product) with newer, correctly-linked
  // ones, since grouping is based on matching description/quantity/unit,
  // not on having a consistent product link.
  let groupPhoto = null;
  for (const it of items) {
    const p = it.product_id ? STATE.supplyProducts.find(x => x.id === it.product_id) : null;
    const url = p ? productPhotoUrl(p) : null;
    if (url) { groupPhoto = url; break; }
  }
  const miniBagStyle = groupPhoto
    ? `background-image:url('${groupPhoto}');background-size:cover;background-position:center`
    : `background:var(--${catTone})`;
  const miniBags = Array.from({ length: shownCount }, () => `<div class="supply-mini-bag" style="${miniBagStyle}"></div>`).join("");
  const overflow = count > MAX_SHOWN ? `<span class="supply-mini-bag-more">+${count - MAX_SHOWN} more</span>` : "";
  const line1 = first.brand || first.description || first.category;
  const line2 = (first.description && first.description !== line1) ? first.description : "";
  return `<div class="supply-card" style="border-color:var(--${catTone})">
    <div class="supply-card-header-bar" data-edit-group="${esc(key)}" style="background:var(--${catTone});color:${headerText};cursor:pointer">
      <div class="supply-card-header-name">${esc(line1)}</div>
      ${line2 ? `<div class="supply-card-header-sub">${esc(line2)}</div>` : ""}
    </div>
    <div class="supply-card-meta dim" style="text-align:center">${esc(first.category)}${amountLabel ? ` -- ${amountLabel}` : ""}</div>
    <div class="supply-mini-bag-grid" data-edit-group="${esc(key)}" title="${count} sealed bags">${miniBags}${overflow}</div>
    <div class="supply-stamp-row"><span class="stamp tone-sage">Full × ${count}</span></div>
    <button class="supply-open-one-btn" data-open-one-supply="${first.id}" style="--fold-color:var(--${catTone})">📦 Open one →</button>
  </div>`;
}

/** Splits a list of supply items into display cards: partial-status items
 * stay individual (they're what you're actively tracking), Full-status items
 * with identical category/description/quantity/unit collapse into one
 * grouped card. Returns { html, sortKey } entries pre-sorted the same way
 * the plain list would be (partial first, soonest-to-empty first). */
function buildSupplyEntries(items) {
  const partial = items.filter(s => s.status !== "Full" || s.opened_at);
  const full = items.filter(s => s.status === "Full" && !s.opened_at);
  const fullGroups = {};
  full.forEach(s => {
    const key = supplyGroupKey(s);
    (fullGroups[key] = fullGroups[key] || []).push(s);
  });
  // Grouped by category, not by fullness -- an opened bag's position stays
  // fixed (by date added) regardless of how its status changes, so dragging
  // a slider doesn't jump it around the list. Sealed-spare groups always
  // sort last within their category, since they're not actively in use yet.
  const entries = partial.map(s => ({ category: s.category, isGroup: false, sortKey: s.date_added || "", html: supplyCardHtml(s) }));
  Object.values(fullGroups).forEach(group => {
    const sortKey = [...group].sort((a, b) => (b.date_added || "").localeCompare(a.date_added || ""))[0].date_added || "";
    entries.push({ category: group[0].category, isGroup: true, sortKey, html: group.length > 1 ? supplyGroupCardHtml(group) : supplyCardHtml(group[0]) });
  });
  entries.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.isGroup !== b.isGroup) return a.isGroup ? 1 : -1;
    return b.sortKey.localeCompare(a.sortKey);
  });
  return entries;
}

let supplySubTab = "inventory";
function renderSupplyHub() {
  const el = document.getElementById("panel-bedding");
  const subs = [{ id: "inventory", label: "Inventory" }, { id: "freshness", label: "Freshness" }, { id: "products", label: "Products" }];
  el.innerHTML = `
    <div class="range-select sub-nav-fixed" id="supplySubNav">
      ${subs.map(s => `<button class="range-btn ${supplySubTab === s.id ? "active" : ""}" data-supplysub="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div id="supplySubContent"></div>
  `;
  el.querySelectorAll("[data-supplysub]").forEach(b => b.addEventListener("click", () => { supplySubTab = b.dataset.supplysub; renderSupplyHub(); }));
  if (supplySubTab === "inventory") renderSupplyInventory();
  else if (supplySubTab === "freshness") renderBeddingFreshness();
  else if (supplySubTab === "products") renderProductsSection();
}

function renderSupplyInventory() {
  const el = document.getElementById("supplySubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const emptyCount = STATE.supplies.filter(s => s.status === "Empty").length;
  const activeSupplies = STATE.supplies.filter(s => s.status !== "Empty");
  const feedEntries = buildSupplyEntries(activeSupplies.filter(s => FEED_SUPPLY_CATEGORIES.has(s.category)));
  const beddingEntries = buildSupplyEntries(activeSupplies.filter(s => !FEED_SUPPLY_CATEGORIES.has(s.category)));
  const pagedFeed = feedEntries.slice(0, feedSupplyVisibleCount);
  const pagedBedding = beddingEntries.slice(0, beddingSupplyVisibleCount);
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:4px">Feed &amp; Bedding Inventory</div>
    <div class="dim" style="font-size:12px;margin-bottom:12px">Bags/supplies logged with a quantity on the Finances tab show up here automatically as "Full." Drag the slider as you work through one, or add something directly if you didn't buy it through an expense entry.</div>

    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${pagedFeed.length + pagedBedding.length} of ${feedEntries.length + beddingEntries.length} shown</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${emptyCount ? `<button class="btn ghost small" id="openEmptyModal">📦 Emptied (${emptyCount})</button>` : ""}
        <button class="btn" id="toggleSupplyForm">+ Add supply item</button>
      </div>
    </div>

    ${selectedSupplyIds.size > 0 ? `
      <div class="form-block" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-color:var(--rust);margin-bottom:10px">
        <div><strong style="color:var(--text)">${selectedSupplyIds.size}</strong> selected</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-close small" id="supplyBulkDeleteBtn">Delete selected</button>
          <button class="btn ghost small" id="supplyClearSelection">Clear selection</button>
        </div>
      </div>
    ` : ""}

    ${feedEntries.length === 0 && beddingEntries.length === 0 ? `<div class="card"><div class="empty">${STATE.supplies.length === 0 ? "No supplies logged yet -- log a Feed or Bedding expense with a quantity, or add one directly." : "Nothing currently in stock -- check Emptied above, or add a new item."}</div></div>` : `
    <div class="supply-columns">
      <div${feedEntries.length > 0 && beddingEntries.length > 0 ? ` style="border-right:2px dashed var(--border);padding-right:20px"` : ""}>
        ${feedEntries.length > 0 ? `
          <div class="flock-section-header" style="border-bottom:2px dashed var(--border);padding-bottom:4px">🌾 Feed</div>
          <div class="supply-grid">${pagedFeed.map(e => e.html).join("")}</div>
          ${loadMoreButtonHtml(feedEntries.length, feedSupplyVisibleCount, "loadMoreFeedSupplyBtn")}
        ` : ""}
      </div>
      <div>
        ${beddingEntries.length > 0 ? `
          <div class="flock-section-header" style="border-bottom:2px dashed var(--border);padding-bottom:4px">🛏️ Bedding</div>
          <div class="supply-grid">${pagedBedding.map(e => e.html).join("")}</div>
          ${loadMoreButtonHtml(beddingEntries.length, beddingSupplyVisibleCount, "loadMoreBeddingSupplyBtn")}
        ` : ""}
      </div>
    </div>
    `}

    `;

  // ---- Supply inventory handlers ----
  document.getElementById("toggleSupplyForm").addEventListener("click", () => openSupplyModal(null));
  const openEmptyBtn = document.getElementById("openEmptyModal");
  if (openEmptyBtn) openEmptyBtn.addEventListener("click", () => openEmptySupplyModal());
  el.querySelectorAll(".supply-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedSupplyIds.add(cb.dataset.id); else selectedSupplyIds.delete(cb.dataset.id);
    renderSupplyInventory();
  }));
  const supplyBulkDeleteBtn = document.getElementById("supplyBulkDeleteBtn");
  if (supplyBulkDeleteBtn) supplyBulkDeleteBtn.addEventListener("click", async () => {
    const n = selectedSupplyIds.size;
    if (!(await showConfirmDialog(`Delete ${n} selected item${n !== 1 ? "s" : ""}? This can't be undone.`))) return;
    await localBulkDelete("supplies", [...selectedSupplyIds], currentCoopId);
    showToast(`${n} item${n !== 1 ? "s" : ""} deleted`, "delete");
    selectedSupplyIds.clear();
    STATE.supplies = await localGetAll("supplies", currentCoopId);
    renderSupplyInventory();
  });
  const supplyClearSelectionBtn = document.getElementById("supplyClearSelection");
  if (supplyClearSelectionBtn) supplyClearSelectionBtn.addEventListener("click", () => { selectedSupplyIds.clear(); renderSupplyInventory(); });
  const loadMoreFeedEl = document.getElementById("loadMoreFeedSupplyBtn");
  if (loadMoreFeedEl) loadMoreFeedEl.addEventListener("click", () => { feedSupplyVisibleCount += PAGE_SIZE; renderSupplyInventory(); });
  const loadMoreBeddingSupplyEl = document.getElementById("loadMoreBeddingSupplyBtn");
  if (loadMoreBeddingSupplyEl) loadMoreBeddingSupplyEl.addEventListener("click", () => { beddingSupplyVisibleCount += PAGE_SIZE; renderSupplyInventory(); });
  el.querySelectorAll("[data-edit-supply]").forEach(card => card.addEventListener("click", () => openSupplyModal(STATE.supplies.find(s => s.id === card.dataset.editSupply))));
  el.querySelectorAll("[data-open-one-supply]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    b.classList.add("tearing");
    b.disabled = true;
    await new Promise(resolve => setTimeout(resolve, 380)); // let the tear animation actually finish playing before the card re-renders out from under it
    await localSupplyUpdate(b.dataset.openOneSupply, { opened_at: todayStr() });
    STATE.supplies = await localGetAll("supplies", currentCoopId);
    showToast("Bag opened -- still tracked as Full until you use some", "update");
    renderSupplyInventory();
  }));
  el.querySelectorAll("[data-edit-group]").forEach(card => card.addEventListener("click", () => openSupplyGroupModal(card.dataset.editGroup)));
  el.querySelectorAll(".supply-slider").forEach(slider => slider.addEventListener("change", async (e) => {
    const id = slider.dataset.id;
    const existing = STATE.supplies.find(s => s.id === id);
    const newStatus = supplyStatusFromSlider(e.target.value);
    const payload = { status: newStatus };
    // date_emptied needs to be a two-way gate, not just set-on-reaching-Empty:
    // dragging back up (correcting an accidental drag, or just changing your
    // mind) needs to clear it too, or the stale date keeps counting this
    // bag as "used" in usage totals long after it's no longer actually empty.
    payload.date_emptied = newStatus === "Empty" ? todayStr() : null;
    // Any slider interaction implies the bag has been handled -- mark it
    // opened (once, idempotently) so it stops being grouped with sealed
    // spares from here on, regardless of how little has actually been used.
    if (existing && !existing.opened_at) payload.opened_at = todayStr();
    await localSupplyUpdate(id, payload);
    showToast(`Marked ${newStatus}`, "update");
    refreshAndRender();
  }));

}

/** Just the form's own markup -- no outer .form-block wrapper, since the
 * modal panel itself already provides that card-like container. Kept as a
 * pure function of editingSupply so it's easy to reason about independent
 * of wherever it ends up being rendered. */
function supplyFormHtml(editingSupply) {
  return `
    <div class="form-head">${editingSupply ? "Edit supply item" : "Add a supply item"}</div>
    <div class="grid-form">
      <label class="field"><span>Category</span><select id="sp_category">${[...QUANTITY_CATEGORIES].map(c => `<option ${editingSupply && editingSupply.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field"><span>Brand</span><input id="sp_brand" placeholder="e.g. Purina Layena" value="${editingSupply ? esc(editingSupply.brand || "") : ""}"></label>
      <label class="field"><span>Description</span><input id="sp_desc" placeholder="e.g. large bag, opened" value="${editingSupply ? esc(editingSupply.description || "") : ""}"></label>
      <label class="field"><span>Quantity (per item)</span><input type="number" step="0.01" id="sp_qty" value="${editingSupply && editingSupply.quantity != null ? editingSupply.quantity : ""}"></label>
      <label class="field"><span>Unit</span><select id="sp_unit">${EXPENSE_UNITS.map(u => `<option ${editingSupply && editingSupply.unit === u ? "selected" : ""}>${u}</option>`).join("")}</select></label>
      <label class="field"><span>Status</span><select id="sp_status">${SUPPLY_STATUSES.map(s => `<option ${(editingSupply ? editingSupply.status === s : s === "Full") ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field"><span>Date added</span><input type="date" id="sp_date" value="${editingSupply ? (editingSupply.date_added || todayStr()) : todayStr()}"></label>
      ${editingSupply ? `<label class="field"><span>Date emptied${editingSupply.status !== "Empty" ? " (if applicable)" : ""}</span><input type="date" id="sp_date_emptied" value="${editingSupply.date_emptied || ""}"></label>` : ""}
      ${!editingSupply ? `<label class="field"><span>Number of items</span><input type="number" min="1" max="500" step="1" id="sp_count" value="1" placeholder="e.g. 3 for three separate bags"></label>` : ""}
    </div>
    ${!editingSupply ? `<div id="productPickerHost">${renderProductPickerRow([...QUANTITY_CATEGORIES][0])}</div>` : ""}
    ${editingSupply ? `<label class="field" style="display:flex;flex-direction:row;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="sp_opened" ${editingSupply.opened_at ? "checked" : ""} style="width:auto"><span>Opened -- won't group with sealed spares even at Full</span></label>` : ""}
    ${!editingSupply ? `<div class="dim" style="font-size:11px;margin-top:8px">Buying multiple bags at once? Set the count above -- each one is added as its own separate, independently trackable item rather than a single item marked "3 bags." Identical full bags collapse into one compact card automatically -- "Open one" peels a single bag off to track it on its own.</div>` : ""}
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveSupply">${editingSupply ? "✓ Save changes" : "+ Add item"}</button>
      ${editingSupply ? `<button class="btn btn-close" id="deleteSupply">🗑 Delete</button>` : ""}
    </div>
  `;
}

/** Wires up everything inside the form -- unchanged from before the modal
 * conversion, just operating on whatever container the form's HTML
 * actually ended up in (the modal content area), found the same way it
 * always was: by element id, which doesn't care where in the DOM it lives. */
function wireSupplyForm(editingSupply) {
  applyFeedUnitLock("sp_category", "sp_unit");
  const productPickerHost = document.getElementById("productPickerHost");
  const rerenderPicker = () => { productPickerHost.innerHTML = renderProductPickerRow(document.getElementById("sp_category").value); wireProductPicker(productPickerHost, pickerCfg); };
  const pickerCfg = { categoryFieldId: "sp_category", brandFieldId: "sp_brand", descFieldId: "sp_desc", qtyFieldId: "sp_qty", unitFieldId: "sp_unit", rerenderFn: rerenderPicker };
  if (productPickerHost) {
    wireProductPicker(productPickerHost, pickerCfg);
    document.getElementById("sp_category").addEventListener("change", rerenderPicker);
  }
  document.getElementById("saveSupply").addEventListener("click", async () => {
    const status = document.getElementById("sp_status").value;
    const dateEmptiedEl = document.getElementById("sp_date_emptied");
    const openedEl = document.getElementById("sp_opened");
    const payload = {
      coop_id: currentCoopId,
      category: document.getElementById("sp_category").value,
      brand: document.getElementById("sp_brand").value,
      description: document.getElementById("sp_desc").value,
      quantity: document.getElementById("sp_qty").value ? Number(document.getElementById("sp_qty").value) : null,
      unit: document.getElementById("sp_unit").value,
      status,
      date_added: document.getElementById("sp_date").value,
      // Respects an explicitly back-dated value, but only when the final
      // status is actually Empty -- still forced to null otherwise, same
      // reasoning as the earlier fix: a status corrected away from Empty
      // must not leave a stale emptied date behind.
      date_emptied: status === "Empty" ? ((dateEmptiedEl && dateEmptiedEl.value) || editingSupply?.date_emptied || todayStr()) : null,
      opened_at: openedEl ? (openedEl.checked ? (editingSupply?.opened_at || todayStr()) : null) : (editingSupply?.opened_at || null),
    };
    if (editingSupply) {
      await localSupplyUpdate(editingSupply.id, payload);
      showToast("Supply item updated", "update");
    } else {
      if (selectedProductId) {
        payload.product_id = selectedProductId;
        await localSupplyProductUpdate(selectedProductId, { last_used_at: todayStr() });
      }
      const countEl = document.getElementById("sp_count");
      const count = countEl ? Math.max(1, Number(countEl.value) || 1) : 1;
      if (count > 500) { alert("That's a lot of separate items to add at once -- try 500 or fewer at a time"); return; }
      await localBulkCreate("supplies", Array.from({ length: count }, () => payload));
      showToast(count > 1 ? `${count} items added` : "Supply item added", "create");
    }
    closeModal();
    refreshAndRender();
  });
  const deleteBtn = document.getElementById("deleteSupply");
  if (deleteBtn) deleteBtn.addEventListener("click", () => confirmAndDelete(
    "Delete this supply item permanently? This can't be undone.",
    () => localSupplyDelete(editingSupply.id, currentCoopId),
    "Supply item deleted",
    refreshAndRender
  ));
}

/** Single entry point for both "+ Add supply item" (pass null) and editing
 * an existing card (pass that supply). Replaces the old pattern of setting
 * module-level open/editing state and re-rendering the whole inline panel
 * just to reveal a form -- the modal is a separate layer now, so opening
 * it doesn't touch the list underneath at all. */
function openSupplyModal(supply) {
  selectedProductId = null;
  editingProductId = null;
  newProductFormOpen = false;
  openModal(supplyFormHtml(supply), () => {
    selectedProductId = null;
    editingProductId = null;
    newProductFormOpen = false;
  });
  wireSupplyForm(supply);
}

function renderBeddingFreshness() {
  const el = document.getElementById("supplySubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const years = yearsFromDates(STATE.bedding, "date");
  const filtered = STATE.bedding.filter(b =>
    (!beddingFilters.area || b.area === beddingFilters.area)
    && (!beddingFilters.entryType || b.entry_type === beddingFilters.entryType)
    && (!beddingFilters.year || b.date.slice(0, 4) === beddingFilters.year)
  );
  const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date));
  const anyFilter = beddingFilters.area || beddingFilters.entryType || beddingFilters.year;
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:4px">Bedding Freshness</div>
    <div class="grid-stats" style="margin-bottom:16px">
      ${getBeddingAreas().map(area => {
        const bs = beddingStatsFor(area);
        const t = getBeddingThresholds(area);
        const daysSinceCleanout = bs.lastCleanout ? daysSince(bs.lastCleanout.date) : null;
        const daysSinceActivity = bs.lastActivity ? daysSince(bs.lastActivity.date) : null;
        const daysSinceChurn = bs.lastChurn ? daysSince(bs.lastChurn.date) : null;
        const cleanoutToneInfo = cleanoutTone(daysSinceCleanout, area);
        const daysUntilCleanout = daysSinceCleanout !== null ? t.danger - daysSinceCleanout : null;
        const daysUntilChurn = daysSinceChurn !== null ? t.churn - daysSinceChurn : null;
        const cleanoutLabel = daysUntilCleanout === null ? "no clean-out logged"
          : daysUntilCleanout < 0 ? `overdue ${-daysUntilCleanout}d`
          : daysUntilCleanout === 0 ? "due today"
          : `in ${daysUntilCleanout}d`;
        const churnToneClass = daysUntilChurn === null ? "slate" : daysUntilChurn <= 0 ? "gold" : "sage";
        const churnLabel = daysUntilChurn === null ? "no churn logged"
          : daysUntilChurn < 0 ? `overdue ${-daysUntilChurn}d`
          : daysUntilChurn === 0 ? "due today"
          : `in ${daysUntilChurn}d`;
        return `<div class="stat tone-${cleanoutToneInfo.tone === "danger" ? "" : cleanoutToneInfo.tone}">
          <div class="stat-label">${esc(area)}</div>
          <div class="stat-value">${daysSinceActivity !== null ? daysSinceActivity + "d" : "—"}</div>
          <div class="stat-sub">last activity${bs.lastCleanout ? ` · last material: ${esc(bs.lastCleanout.material)}` : ""}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <span class="stamp tone-${cleanoutToneInfo.tone}">${daysUntilCleanout === null ? cleanoutLabel : "Clean-out " + cleanoutLabel}</span>
            <span class="stamp tone-${churnToneClass}">${daysUntilChurn === null ? churnLabel : "Churn " + churnLabel}</span>
          </div>
        </div>`;
      }).join("")}
    </div>

    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${sorted.length} of ${STATE.bedding.length} shown</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost small" id="openBedThresholds" title="Add/remove/reorder tracking areas, and set warn/overdue timing for each">⚙ Areas &amp; thresholds</button>
        <button class="btn ghost small" id="toggleBedFilters">Filters${anyFilter ? " (on)" : ""} ${beddingFiltersOpen ? "▾" : "▸"}</button>
        <button class="btn" id="toggleBedForm">+ Add entry</button>
      </div>
    </div>

    ${beddingFiltersOpen ? `
    <div class="form-block" style="padding:12px 16px">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <label class="field"><span>Area</span><select id="filterBedArea"><option value="">All areas</option>${[...new Set([...getBeddingAreas(), ...STATE.bedding.map(b => b.area)])].map(a => `<option value="${a}" ${beddingFilters.area === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
        <label class="field"><span>Type</span><select id="filterBedType"><option value="">All types</option>${BEDDING_TYPES.map(t => `<option value="${t}" ${beddingFilters.entryType === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field"><span>Year</span><select id="filterBedYear"><option value="">All years</option>${years.map(y => `<option value="${y}" ${beddingFilters.year === y ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      </div>
      ${anyFilter ? `<div style="margin-top:10px"><button class="btn ghost small" id="clearBedFilters">Clear filters</button></div>` : ""}
    </div>
    ` : ""}

    ${sorted.length === 0 ? `<div class="card"><div class="empty">${STATE.bedding.length === 0 ? "No bedding changes logged yet." : "No entries match these filters."}</div></div>` : (() => {
      const visible = sorted.slice(0, beddingVisibleCount);
      return `
    <div class="list-stack">
      ${visible.map(b => `
        <div class="list-card tone-${b.entry_type === "Full Clean-out" ? "sage" : "gold"}" data-edit="${b.id}" style="cursor:pointer">
          <div class="list-card-main">
            <div style="font-weight:600">${esc(b.area)}</div>
            <div class="list-card-desc dim">${fmtDate(b.date)} · ${esc(b.material)}${b.notes ? " · " + esc(b.notes) : ""}</div>
          </div>
          <div class="list-card-side">
            <span class="stamp tone-${b.entry_type === "Full Clean-out" ? "sage" : "gold"}">${esc(b.entry_type)}</span>
            <button class="icon-btn" data-del="${b.id}" onclick="event.stopPropagation()">🗑</button>
          </div>
        </div>`).join("")}
    </div>
    ${loadMoreButtonHtml(sorted.length, beddingVisibleCount)}`;
    })()}
  `;

  document.getElementById("toggleBedForm").addEventListener("click", () => openBeddingModal(null));
  document.getElementById("openBedThresholds").addEventListener("click", () => openBeddingThresholdsModal());
  document.getElementById("toggleBedFilters").addEventListener("click", () => { beddingFiltersOpen = !beddingFiltersOpen; renderBeddingFreshness(); });
  const filterAreaEl = document.getElementById("filterBedArea");
  if (filterAreaEl) filterAreaEl.addEventListener("change", (e) => { beddingFilters.area = e.target.value; beddingVisibleCount = PAGE_SIZE; renderBeddingFreshness(); });
  const filterTypeEl = document.getElementById("filterBedType");
  if (filterTypeEl) filterTypeEl.addEventListener("change", (e) => { beddingFilters.entryType = e.target.value; beddingVisibleCount = PAGE_SIZE; renderBeddingFreshness(); });
  const filterYearEl = document.getElementById("filterBedYear");
  if (filterYearEl) filterYearEl.addEventListener("change", (e) => { beddingFilters.year = e.target.value; beddingVisibleCount = PAGE_SIZE; renderBeddingFreshness(); });
  const clearBtn = document.getElementById("clearBedFilters");
  if (clearBtn) clearBtn.addEventListener("click", () => { beddingFilters = { area: "", entryType: "", year: "" }; beddingVisibleCount = PAGE_SIZE; renderBeddingFreshness(); });
  const loadMoreEl = document.getElementById("loadMoreBtn");
  if (loadMoreEl) loadMoreEl.addEventListener("click", () => { beddingVisibleCount += PAGE_SIZE; renderBeddingFreshness(); });
  el.querySelectorAll("[data-edit]").forEach(card => card.addEventListener("click", () => openBeddingModal(STATE.bedding.find(b => b.id === card.dataset.edit))));
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    await localBeddingDelete(b.dataset.del, currentCoopId);
    showToast("Bedding entry deleted", "delete");
    if (editingBeddingId === b.dataset.del) editingBeddingId = null;
    refreshAndRender();
  }));
}

function beddingFormHtml(editing) {
  return `
    <div class="form-head">${editing ? "Edit bedding entry" : "Log a bedding change"}</div>
    <div class="grid-form">
      <label class="field"><span>Date</span><input type="date" id="d_date" value="${editing ? editing.date : todayStr()}"></label>
      <label class="field"><span>Area</span><select id="d_area">${getBeddingAreas().map(a => `<option ${editing && editing.area === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
      <label class="field"><span>Entry type</span><select id="d_type">${BEDDING_TYPES.map(t => `<option ${editing && editing.entry_type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="field"><span>Material</span><select id="d_material">${BEDDING_MATERIALS.map(m => `<option ${editing && editing.material === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      <label class="field"><span>Notes</span><input id="d_notes" placeholder="optional" value="${editing ? esc(editing.notes || "") : ""}"></label>
    </div>
    <div class="note-box" style="margin-top:10px"><strong style="color:var(--text)">Top-off</strong> is adding fresh material without stirring. <strong style="color:var(--text)">Churn</strong> is stirring what's already there without adding anything. <strong style="color:var(--text)">Top-off + Churn</strong> is both in the same visit. Only Churn and Top-off + Churn count toward the churn-due countdown above -- topping off alone doesn't reset it. Use <strong style="color:var(--text)">Full Clean-out</strong> when the coop or run is emptied down to bare floor.</div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveBedding">${editing ? "✓ Save changes" : "+ Add entry"}</button>
      ${editing ? `<button class="btn btn-close" id="deleteBedding">🗑 Delete</button>` : ""}
    </div>
  `;
}

function openBeddingModal(editing) {
  editingBeddingId = editing ? editing.id : null;
  openModal(beddingFormHtml(editing), () => { editingBeddingId = null; });
  document.getElementById("saveBedding").addEventListener("click", async () => {
    const payload = {
      coop_id: currentCoopId,
      date: document.getElementById("d_date").value,
      area: document.getElementById("d_area").value,
      entry_type: document.getElementById("d_type").value,
      material: document.getElementById("d_material").value,
      notes: document.getElementById("d_notes").value,
    };
    if (editing) await localBeddingUpdate(editing.id, payload);
    else await localBeddingCreate(payload);
    showToast(editing ? "Bedding entry updated" : "Bedding entry added", editing ? "update" : "create");
    closeModal();
    refreshAndRender();
  });
  const deleteBtn = document.getElementById("deleteBedding");
  if (deleteBtn) deleteBtn.addEventListener("click", () => confirmAndDelete(
    "Delete this bedding entry? This can't be undone.",
    () => localBeddingDelete(editing.id, currentCoopId),
    "Bedding entry deleted",
    refreshAndRender
  ));
}

// ---------- Init ----------
/** Pings the configured server (or same-origin, if none is set) so the
 * header dot reflects whether the app can actually reach it right now --
 * navigator.onLine alone only tells you the device has *some* network, not
 * that this specific server is reachable (e.g. Tailscale drops, VPN issues,
 * the server itself being down). */
async function checkConnection() {
  const dot = document.querySelector("#connIndicator .conn-dot");
  const label = document.getElementById("connLabel");
  if (!dot || !label) return;
  if (localOnlyMode) {
    dot.className = "conn-dot local";
    label.textContent = "Local only";
    return;
  }
  try {
    const res = await fetch(apiUrl("/api/health"), { cache: "no-store" });
    if (!res.ok) throw new Error("bad status");
    dot.className = "conn-dot online";
    label.textContent = "Online";
  } catch (err) {
    dot.className = "conn-dot offline";
    label.textContent = "Offline";
  }
}
window.addEventListener("online", () => {
  checkConnection();
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
  document.querySelector(".wrap").innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
      <div class="card" style="max-width:420px;width:100%;border:2px solid var(--rust);box-shadow:0 0 0 1px rgba(193,80,46,0.15), 0 12px 32px rgba(0,0,0,0.35)">
        <div class="eyebrow">🐔 The Coop Ledger</div>
        <h1 style="font-size:24px;margin:2px 0 4px">Get started</h1>
        <div class="dim" style="font-size:12px;margin-bottom:18px">Track your flock, eggs, expenses, and supplies -- right on this device, no account needed.</div>

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
          <label class="field"><span>Your name</span><input id="gs_name" placeholder="e.g. Alex"></label>
          <label class="field" style="margin-top:12px"><span>Invite code</span><input id="gs_code" placeholder="e.g. KTRHY8NW" style="text-transform:uppercase"></label>
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
  ["gs_server", "gs_name", "gs_code"].forEach(id => document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doGetStartedConnect(); }));
  document.getElementById("gs_local").addEventListener("click", () => {
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
  document.querySelector(".wrap").innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
      <div class="card" style="max-width:380px;width:100%;border:2px solid var(--rust);box-shadow:0 0 0 1px rgba(193,80,46,0.15), 0 12px 32px rgba(0,0,0,0.35)">
        <div class="eyebrow">🐔 The Coop Ledger</div>
        <h1 style="font-size:24px;margin:2px 0 4px">Welcome back</h1>
        <div class="dim" style="font-size:12px;margin-bottom:18px">Connecting to <strong style="color:var(--text)">${esc(getServerUrl() || window.location.origin)}</strong></div>
        <label class="field"><span>Your name</span><input id="loginName" placeholder="e.g. Alex"></label>
        <label class="field" style="margin-top:12px"><span>Invite code</span><input id="loginCode" placeholder="e.g. KTRHY8NW" style="text-transform:uppercase"></label>
        <div id="loginError" style="color:var(--rust);font-size:12px;margin-top:10px;min-height:1em"></div>
        <button class="btn btn-confirm" id="loginBtn" style="margin-top:16px;width:100%;justify-content:center">Log in</button>
      </div>
    </div>
  `;
  document.getElementById("loginBtn").addEventListener("click", doLogin);
  ["loginName", "loginCode"].forEach(id => document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));
}

async function doLogin() {
  const name = document.getElementById("loginName").value.trim();
  const code = document.getElementById("loginCode").value.trim();
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  if (!name || !code) { errEl.textContent = "Enter your name and the invite code."; return; }
  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.textContent = "Logging in...";
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
    location.reload(); // cleanest way to restart the whole app with the new auth state
  } catch (err) {
    errEl.textContent = "Couldn't reach the server -- check your connection.";
    btn.disabled = false;
    btn.textContent = "Log in";
  }
}

async function init() {
  document.getElementById("todayDate").textContent = fmtDate(todayStr());
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
  updateTabVisibility();
  startBackgroundSyncTimer();
  startEventStream();

  if (localOnlyMode && currentCoopId && daysSinceLastBackup() > BACKUP_REMINDER_DAYS) {
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

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          // Only surfaces once there's already an active controller -- i.e.
          // this is a genuine update, not just the very first install.
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateAvailableToast();
          }
        });
      });
    }).catch((err) => console.warn("Service worker registration failed:", err));
  });
}

function showUpdateAvailableToast() {
  if (document.querySelector(".toast-update")) return; // already showing one -- don't stack duplicates
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = "toast toast-update";
  toast.innerHTML = `<div>A new version is ready.</div><button class="btn btn-confirm small" id="refreshForUpdateBtn" style="margin-top:8px">Refresh</button>`;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  const refreshBtn = document.getElementById("refreshForUpdateBtn");
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing...";
    try {
      // location.reload() alone can still be satisfied by this browser's own
      // short-lived cache on these specific files (up to 60s), which is
      // exactly why the button could appear to do nothing -- force each one
      // fresh from the network first, which also updates that cache, so the
      // reload right after is guaranteed to actually use the new version.
      await Promise.all(["./", "app.js", "style.css"].map(u => fetch(u, { cache: "reload" }).catch(() => {})));
    } finally {
      window.location.reload();
    }
  });
  // Deliberately no auto-dismiss timer here -- this one waits for you to act.
}

/** The updatefound-based check above only fires when sw.js itself changes
 * bytes, which is rare -- most deploys only touch app.js/style.css, which
 * this doesn't catch at all. Meanwhile those files already refresh
 * themselves on every load when online (a short cache, not the old
 * no-store, but still short), so by the time that toast could show, the
 * "update" was frequently already loaded -- which is exactly why clicking
 * Refresh often visibly did nothing: there was nothing left to fetch.
 * This checks the actual thing that matters -- whether the version this
 * tab is running differs from what the server has right now -- so the
 * toast (and its Refresh button) corresponds to a real, waiting change. */
async function checkForAppUpdate({ manual = false } = {}) {
  if (localOnlyMode && !navigator.onLine) {
    if (manual) showToast("Can't check right now -- you're offline.", "delete");
    return;
  }
  try {
    const res = await fetch("app.js", { cache: "no-store" });
    if (!res.ok) { if (manual) showToast("Couldn't reach the server to check.", "delete"); return; }
    const text = await res.text();
    const match = text.match(/const APP_VERSION = "([^"]+)"/);
    if (match && match[1] && match[1] !== APP_VERSION) {
      showUpdateAvailableToast();
    } else if (manual) {
      showToast("You're already on the latest version.", "update");
    }
  } catch (err) {
    if (manual) showToast("Couldn't reach the server to check.", "delete");
  }
}
window.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForAppUpdate(); });
setInterval(checkForAppUpdate, 5 * 60 * 1000); // also catches a long-lived tab that's never actually hidden

// ---- Install prompt ----
// Chrome/Android normally decide on their own when (or whether) to show an
// install banner, which is inconsistent. Capturing the event and offering a
// clear "Install" button whenever the browser says it's eligible is more
// visible and puts the choice in front of the person right away.
let deferredInstallPrompt = null;
const INSTALL_DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days -- long enough to not be pushy, short enough that an old dismissal (very plausible during testing) doesn't silence this forever
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const dismissedAt = Number(localStorage.getItem("installBannerDismissedAt") || 0);
  if (!dismissedAt || Date.now() - dismissedAt > INSTALL_DISMISS_COOLDOWN_MS) showInstallBanner();
});

function showInstallBanner() {
  if (document.getElementById("installBanner")) return;
  const banner = document.createElement("div");
  banner.id = "installBanner";
  banner.className = "install-banner";
  banner.innerHTML = `
    <div>🐔 Install The Coop Ledger for the full app experience</div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button class="btn btn-confirm small" id="installBtn">Install</button>
      <button class="icon-btn" id="dismissInstallBtn">✕</button>
    </div>
  `;
  document.querySelector(".wrap").prepend(banner);
  document.getElementById("installBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    banner.remove();
  });
  document.getElementById("dismissInstallBtn").addEventListener("click", () => {
    localStorage.setItem("installBannerDismissedAt", String(Date.now()));
    banner.remove();
  });
}

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const banner = document.getElementById("installBanner");
  if (banner) banner.remove();
  showToast("Installed! Launch it from your home screen next time.", "create");
});
