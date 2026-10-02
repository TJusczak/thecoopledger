// IndexedDB (the local-first store), pending-photo queues, photo transforms.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= LOCAL-FIRST DATA LAYER (every resource) =================
// Everything below makes Eggs work fully offline: reads and writes go to an
// IndexedDB copy on the device first (instant, no network needed), and a
// background sync engine reconciles that copy with the server whenever it's
// reachable. Every other resource (birds, expenses, bedding, etc.) still
// talks to the server directly for now, unchanged -- this is deliberately a
// single proven slice before the same pattern gets extended to the rest.
const LOCAL_DB_NAME = "coopLedgerLocalDB";
const LOCAL_DB_VERSION = 9;
const LOCAL_STORES = ["coops", "birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "hatch_eggs", "bird_photos", "activity_log", "supply_products"];
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
      // Bird photo HISTORY entries each have their own id (unlike the single
      // "current photo" per bird above), so multiple can genuinely be queued
      // for the same bird at once -- keyed by the bird_photos record's own id.
      if (!db.objectStoreNames.contains("pending_bird_history_photos")) db.createObjectStore("pending_bird_history_photos", { keyPath: "photoId" });
      // FileSystemDirectoryHandle objects are structured-cloneable, so the
      // handle a user picks via showDirectoryPicker() can be stored here
      // directly and reused across sessions without re-prompting for the
      // folder every time (though write permission itself still needs
      // re-confirming each session -- browsers don't persist that part).
      if (!db.objectStoreNames.contains("sync_folder")) db.createObjectStore("sync_folder", { keyPath: "key" });
      if (!db.objectStoreNames.contains("undo_history")) db.createObjectStore("undo_history", { keyPath: "key" });
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
/** CSS position string for a photo's stored crop/reframe offset -- shared by
 * birds and supply_products, the only two resources with their own photo.
 * Defaults to centered, so any photo without a stored position (which is
 * every photo that existed before this feature) displays exactly as it
 * always did. Used as both object-position (on <img> tags) and
 * background-position (on CSS background-image usages) -- the percentage
 * semantics are identical between the two, so one stored value serves both. */
function photoPosition(record) {
  const x = (record && record.photo_pos_x != null) ? record.photo_pos_x : 50;
  const y = (record && record.photo_pos_y != null) ? record.photo_pos_y : 50;
  return `${x}% ${y}%`;
}
function photoZoom(record) {
  return (record && record.photo_zoom != null) ? record.photo_zoom : 1;
}
/** For <img>-based display sites: object-fit:cover already handles the
 * aspect-ratio-correct base fit, so scaling the element itself zooms in
 * further from that already-correct baseline -- no natural-dimension
 * computation needed here, unlike the crop frame's own background-size math.
 * transform-origin is set to match object-position (rather than the
 * transform default of the box's own center) -- without this, scale()
 * always zooms toward the middle of the box regardless of where the photo
 * was actually panned to, since transform-origin and object-position are
 * otherwise completely independent of each other. */
function photoTransformStyle(record) {
  const zoom = photoZoom(record);
  if (zoom === 1) return "";
  const x = (record && record.photo_pos_x != null) ? record.photo_pos_x : 50;
  const y = (record && record.photo_pos_y != null) ? record.photo_pos_y : 50;
  return `transform:scale(${zoom});transform-origin:${x}% ${y}%;`;
}

/** Drag-to-reframe UI for a photo that's already been uploaded (or is about
 * to be) -- resource/id identify which record to save the position onto,
 * aspectRatio shapes the frame to match wherever the photo actually
 * displays (square for birds, 3:4 for supply products), and onSaved (if
 * given) runs after a successful save so the caller can refresh whatever
 * it's showing. Works from a live photo URL, whether that's an already
 * -uploaded server photo or a fresh local object URL for one not saved yet.
 * Zoom is a multiplier on top of the "fill the frame" baseline (1 = no
 * zoom, matching every photo that existed before this feature) -- computed
 * from the image's real natural dimensions rather than a fixed CSS
 * percentage, so it zooms in predictably regardless of the source photo's
 * own resolution or aspect ratio. */
function openPhotoRepositionModal(photoUrl, initialX, initialY, initialZoom, aspectRatio, onSave) {
  // Whatever the parent modal already had, carried forward -- opening this
  // shouldn't silently drop it. Nested flows (e.g. a timeline photo's
  // options) set onBack, not onClose, so that's checked first.
  const preservedOnBack = modalOnBack;
  const preservedOnClose = modalOnClose;
  const html = `
    <div class="form-head">Reposition photo</div>
    <div class="dim" style="font-size:12px;margin-bottom:12px">Drag to reframe, or use the slider to zoom in for more control -- this only changes what shows in cards, the original photo itself is never altered.</div>
    <div id="cropFrame" class="photo-crop-frame" style="aspect-ratio:${aspectRatio}"></div>
    <label class="field" style="margin-top:12px"><span>Zoom</span><input type="range" id="cropZoom" min="100" max="300" step="1" value="${Math.round((initialZoom || 1) * 100)}"></label>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveCropBtn">✓ Save position</button>
      <button class="btn ghost" id="resetCropBtn">Reset</button>
    </div>
  `;
  if (preservedOnBack) openModal(html, null, null, preservedOnBack);
  else openModal(html, preservedOnClose);
  let posX = initialX, posY = initialY, zoom = initialZoom || 1;
  let dragging = false, startClientX, startClientY, startPosX, startPosY;
  let imgW = 0, imgH = 0; // natural dimensions, filled in once the image loads
  const frame = document.getElementById("cropFrame");
  const zoomSlider = document.getElementById("cropZoom");
  const clamp = (v) => Math.max(0, Math.min(100, v));

  function applyBackgroundSize() {
    if (!imgW || !imgH) { frame.style.backgroundSize = "cover"; return; } // fallback while the natural-size probe is still loading
    const rect = frame.getBoundingClientRect();
    const coverScale = Math.max(rect.width / imgW, rect.height / imgH);
    const scale = coverScale * zoom;
    frame.style.backgroundSize = `${Math.round(imgW * scale)}px ${Math.round(imgH * scale)}px`;
  }

  const probe = new Image();
  probe.onload = () => {
    imgW = probe.naturalWidth; imgH = probe.naturalHeight;
    frame.style.backgroundImage = `url('${photoUrl}')`;
    frame.style.backgroundPosition = `${posX}% ${posY}%`;
    applyBackgroundSize();
  };
  probe.src = photoUrl;

  const startDrag = (clientX, clientY) => { dragging = true; startClientX = clientX; startClientY = clientY; startPosX = posX; startPosY = posY; frame.classList.add("dragging"); };
  const moveDrag = (clientX, clientY) => {
    if (!dragging) return;
    const rect = frame.getBoundingClientRect();
    // Dragging right should reveal more of the image's left side (the
    // familiar "grab the photo and slide it" feel), which means DEcreasing
    // the position percentage -- hence subtracting the delta rather than adding it.
    posX = clamp(startPosX - ((clientX - startClientX) / rect.width) * 100);
    posY = clamp(startPosY - ((clientY - startClientY) / rect.height) * 100);
    frame.style.backgroundPosition = `${posX}% ${posY}%`;
  };
  const endDrag = () => { dragging = false; frame.classList.remove("dragging"); };

  frame.addEventListener("mousedown", (e) => { e.preventDefault(); startDrag(e.clientX, e.clientY); });
  window.addEventListener("mousemove", (e) => moveDrag(e.clientX, e.clientY));
  window.addEventListener("mouseup", endDrag);
  frame.addEventListener("touchstart", (e) => { const t = e.touches[0]; startDrag(t.clientX, t.clientY); }, { passive: true });
  frame.addEventListener("touchmove", (e) => { const t = e.touches[0]; moveDrag(t.clientX, t.clientY); }, { passive: true });
  frame.addEventListener("touchend", endDrag);

  zoomSlider.addEventListener("input", (e) => {
    zoom = Number(e.target.value) / 100;
    applyBackgroundSize();
  });

  document.getElementById("resetCropBtn").addEventListener("click", () => {
    posX = 50; posY = 50; zoom = 1;
    frame.style.backgroundPosition = "50% 50%";
    zoomSlider.value = 100;
    applyBackgroundSize();
  });
  document.getElementById("saveCropBtn").addEventListener("click", async () => {
    await onSave(posX, posY, zoom);
  });
}

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

async function queuePendingBirdHistoryPhoto(photoId, blob) {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_bird_history_photos"], "readwrite");
  tx.objectStore("pending_bird_history_photos").put({ photoId, blob, queuedAt: new Date().toISOString() });
  await idbDone(tx);
}
async function getAllPendingBirdHistoryPhotos() {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_bird_history_photos"], "readonly");
  return (await idbRequest(tx.objectStore("pending_bird_history_photos").getAll())) || [];
}
async function clearPendingBirdHistoryPhoto(photoId) {
  const db = await openLocalDb();
  const tx = db.transaction(["pending_bird_history_photos"], "readwrite");
  tx.objectStore("pending_bird_history_photos").delete(photoId);
  await idbDone(tx);
}
/** Object URLs for queued-but-not-yet-uploaded history photos, same
 * synchronous-lookup-map reasoning as pendingPhotoUrls. */
let pendingBirdHistoryPhotoUrls = {};
async function refreshPendingBirdHistoryPhotoUrls() {
  Object.values(pendingBirdHistoryPhotoUrls).forEach(url => URL.revokeObjectURL(url));
  pendingBirdHistoryPhotoUrls = {};
  const pending = await getAllPendingBirdHistoryPhotos();
  pending.forEach(p => { pendingBirdHistoryPhotoUrls[p.photoId] = URL.createObjectURL(p.blob); });
}
function birdHistoryPhotoUrl(photoRecord) {
  return pendingBirdHistoryPhotoUrls[photoRecord.id] || (photoRecord.photo ? mediaUrl(photoRecord.photo) : null);
}
/** Small square thumbnails for a bird's photo history, sorted oldest to
 * newest, each carrying its own stage label if one was set. */
function birdPhotoHistoryThumbsHtml(birdId, selectMode = false, selectedIds = null) {
  const photos = STATE.birdPhotos.filter(p => p.bird_id === birdId).sort((a, b) => (a.date_taken || "").localeCompare(b.date_taken || ""));
  return photos.map(p => {
    const url = birdHistoryPhotoUrl(p);
    const isSelected = selectMode && selectedIds && selectedIds.has(p.id);
    return `<div class="thumb-clickable${isSelected ? " history-thumb-selected" : ""}" data-history-photo="${p.id}" style="flex:0 0 auto;width:64px;height:64px;border-radius:8px;overflow:hidden;position:relative;cursor:pointer;border:1px solid ${isSelected ? "var(--gold)" : "var(--border)"};${isSelected ? "box-shadow:0 0 0 2px var(--gold)" : ""}">
      ${url ? `<img src="${url}" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(p)};${photoTransformStyle(p)}">` : `<div style="width:100%;height:100%;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;font-size:20px">🐔</div>`}
      ${p.stage && !selectMode ? `<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.62);color:#F2E9DC;font-size:8px;text-align:center;padding:1px 0;line-height:1.3">${esc(p.stage)}</div>` : ""}
      ${selectMode ? `<div style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:${isSelected ? "var(--gold)" : "rgba(20,16,13,0.65)"};border:1px solid ${isSelected ? "var(--gold)" : "rgba(255,255,255,0.5)"};display:flex;align-items:center;justify-content:center;font-size:11px;color:#1E1712">${isSelected ? "✓" : ""}</div>` : ""}
    </div>`;
  }).join("");
}
/** Pushes any queued history photos to the server, one at a time -- same
 * shape as pushPendingPhotosOnce. */
async function pushPendingBirdHistoryPhotosOnce() {
  const pending = await getAllPendingBirdHistoryPhotos();
  let anyUploaded = false;
  for (const p of pending) {
    try {
      const result = await apiUploadPhoto(p.photoId, p.blob, "bird_photos");
      const existing = await localGetOne("bird_photos", p.photoId);
      if (existing) await localPutMany("bird_photos", [{ ...existing, photo: result.photo }]);
      await clearPendingBirdHistoryPhoto(p.photoId);
      anyUploaded = true;
    } catch (err) {
      break;
    }
  }
  if (anyUploaded && currentCoopId) {
    STATE.birdPhotos = await localGetAll("bird_photos", currentCoopId);
    await refreshPendingBirdHistoryPhotoUrls();
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
let _pushBirdHistoryPhotosInFlight = null;
async function pushPendingBirdHistoryPhotos() {
  if (_pushBirdHistoryPhotosInFlight) return _pushBirdHistoryPhotosInFlight;
  _pushBirdHistoryPhotosInFlight = pushPendingBirdHistoryPhotosOnce().finally(() => { _pushBirdHistoryPhotosInFlight = null; });
  return _pushBirdHistoryPhotosInFlight;
}

