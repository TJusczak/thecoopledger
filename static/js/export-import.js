// Offline export/import (zip, csv, json), local backups, loadCoopData.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ---------- Fully offline export/import ----------
// This reads/writes IndexedDB directly with zero server contact. The server-
// side .zip export/import (Coops settings page) is still the better format
// for a serious long-term archive -- real photo files, not base64 -- but it
// needs a connection. This is the "100% standalone" path: works with none.

function dataUriToBlob(dataUri) { return fetch(dataUri).then(res => res.blob()); }

/** A not-yet-uploaded local photo is used first (guaranteed available with
 * zero network); otherwise, if this bird has a server-hosted photo, try
 * fetching it -- works if we happen to be online, quietly gives up if not. */
async function birdPhotoToBlob(bird) {
  const pending = await getPendingPhoto(bird.id);
  if (pending && pending.blob) return pending.blob;
  if (bird.photo) {
    try {
      const res = await fetch(mediaUrl(bird.photo));
      if (res.ok) return await res.blob();
    } catch (err) { /* offline or unreachable -- exported without this photo */ }
  }
  return null;
}
async function birdHistoryPhotoToBlob(photoRecord) {
  const pending = await (async () => {
    const db = await openLocalDb();
    const tx = db.transaction(["pending_bird_history_photos"], "readonly");
    return (await idbRequest(tx.objectStore("pending_bird_history_photos").get(photoRecord.id))) || null;
  })();
  if (pending && pending.blob) return pending.blob;
  if (photoRecord.photo) {
    try {
      const res = await fetch(mediaUrl(photoRecord.photo));
      if (res.ok) return await res.blob();
    } catch (err) { /* offline or unreachable -- exported without this photo */ }
  }
  return null;
}
async function productPhotoToBlob(product) {
  const pending = await getPendingProductPhoto(product.id);
  if (pending && pending.blob) return pending.blob;
  if (product.photo) {
    try {
      const res = await fetch(mediaUrl(product.photo));
      if (res.ok) return await res.blob();
    } catch (err) { /* offline or unreachable -- exported without this photo */ }
  }
  return null;
}

async function buildLocalExportBundle(coopId, onProgress) {
  const coop = await localGetOne("coops", coopId);
  const bundle = { version: 1, exported_at: todayStr(), offline_export: true, coop };
  const photoBlobs = {}; // zip-relative path -> Blob, collected here so the zip step never has to re-derive or re-decode anything
  const tables = ["birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "hatch_eggs", "bird_photos", "supply_products"];
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const rows = await localGetAll(table, coopId);
    if (table === "birds" || table === "supply_products" || table === "bird_photos") {
      const toBlobFn = table === "birds" ? birdPhotoToBlob : table === "supply_products" ? productPhotoToBlob : birdHistoryPhotoToBlob;
      const prefix = table === "birds" ? "bird" : table === "supply_products" ? "product" : "birdhist";
      for (let j = 0; j < rows.length; j++) {
        const r = rows[j];
        const blob = await toBlobFn(r);
        if (blob) {
          const path = `photos/${prefix}-${r.id}.jpg`;
          photoBlobs[path] = blob;
          r.photo = path;
        } else {
          r.photo = null;
        }
        if (onProgress) onProgress(Math.round(((i + (j + 1) / Math.max(rows.length, 1)) / tables.length) * 60), `Gathering ${table}... ${j + 1}/${rows.length}`);
      }
    } else if (onProgress) {
      onProgress(Math.round(((i + 1) / tables.length) * 60), `Gathering ${table}... (${rows.length})`);
    }
    bundle[table] = rows;
  }
  return { bundle, photoBlobs };
}

const LAST_BACKUP_KEY = "coopLedgerLastLocalBackupAt";
function recordLocalBackup() { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); renderLocalOnlyBadge(); }
function daysSinceLastBackup() {
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  if (!raw) return Infinity;
  return (Date.now() - Number(raw)) / (24 * 60 * 60 * 1000);
}
/** Compact age for the sidebar tag: "today", "1d ago", "12d ago" -- or "" if there has never been a backup. */
function backupAgeShort() {
  const d = daysSinceLastBackup();
  if (!Number.isFinite(d)) return "";
  if (d < 1) return "today";
  return `${Math.floor(d)}d ago`;
}
/** Human-readable "when did I last export" for the App settings card. */
function lastBackupLabel() {
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  if (!raw) return "never from this device";
  const iso = new Date(Number(raw)).toISOString();
  return `${new Date(Number(raw)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} (${relativeTimeLong(iso)})`;
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

/** Backs up EVERY coop in one go: into the synced folder when one is set up and writable, otherwise
 * as one .zip download per coop (the browser may ask once to allow multiple downloads).
 * Returns { count, where } for the confirmation message. */
async function backUpAllCoopsNow(onProgress) {
  const coops = [...STATE.coops];
  if (!coops.length) throw new Error("There are no coops to back up yet.");
  const handle = SYNC_FOLDER_SUPPORTED ? await getSyncFolderHandle() : null;
  const toFolder = !!handle && (await syncFolderHasWriteAccess(handle));
  for (let i = 0; i < coops.length; i++) {
    const c = coops[i];
    if (toFolder) {
      if (onProgress) onProgress(Math.round((i / coops.length) * 100), `Saving ${c.name}`);
      await writeBackupToSyncFolder(c.id);
    } else {
      await exportLocalZip(c.id, (pct, label) => { if (onProgress) onProgress(Math.round(((i + pct / 100) / coops.length) * 100), `${c.name}: ${label || "exporting"}`); });
    }
  }
  return { count: coops.length, where: toFolder ? "your synced folder" : "your downloads" };
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

async function buildLocalExportZipBlob(coopId, onProgress) {
  const { bundle, photoBlobs } = await buildLocalExportBundle(coopId, onProgress);
  const zip = new JSZip();
  Object.entries(photoBlobs).forEach(([path, blob]) => zip.file(path, blob));
  zip.file("data.json", JSON.stringify(bundle, null, 2));
  const zipBlob = await zip.generateAsync({ type: "blob" }, (metadata) => {
    if (onProgress) onProgress(60 + Math.round(metadata.percent * 0.4), `Compressing... ${Math.round(metadata.percent)}%`);
  });
  const safeName = (bundle.coop.name || "coop").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { blob: zipBlob, filename: `${safeName}-backup-${todayStr()}.zip` };
}

async function exportLocalZip(coopId, onProgress) {
  const { blob, filename } = await buildLocalExportZipBlob(coopId, onProgress);
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
 * Standardized spreadsheet export: a handful of clean, human-readable files
 * rather than a raw dump of every internal table -- foreign keys resolved
 * (a health log shows the bird's name, not its id), weight always in lb and
 * labeled as such (a spreadsheet export needs one fixed, predictable unit,
 * not one that silently depends on the display toggle), money as a bare
 * decimal so SUM() works without stripping a "$" first. Ported field-for-
 * field from the server's export_coop_csv -- this is the client-side,
 * offline-capable path the export button actually reaches, so this copy is
 * the one that has to be right, not just the server's.
 * Not a backup (there's no import path for this, and it can't hold photos),
 * just a clean way to get the data into a spreadsheet program. Works with
 * zero connection, same as everything else offline. */
async function exportLocalCsv(coopId) {
  const coop = await localGetOne("coops", coopId);
  const zip = new JSZip();
  const num = (v, digits = 2) => (v === null || v === undefined || v === "" ? "" : Math.round(Number(v) * 10 ** digits) / 10 ** digits);
  const write = (filename, headerObjs) => zip.file(filename, rowsToCsv(headerObjs, Object.keys(headerObjs[0] || {})));

  const birds = await localGetAll("birds", coopId);
  const eggs = await localGetAll("eggs", coopId);
  const expenses = await localGetAll("expenses", coopId);
  const supplies = await localGetAll("supplies", coopId);
  const bedding = await localGetAll("bedding", coopId);
  const birdLogs = await localGetAll("bird_logs", coopId);
  const hatches = await localGetAll("hatches", coopId);
  const notes = await localGetAll("notes", coopId);

  const birdNameById = {};
  birds.forEach(b => { birdNameById[b.id] = b.name || "(unnamed)"; });

  if (birds.length) write("Flock.csv", birds.map(b => ({
    "Name": b.name || "(unnamed)", "Type": b.type || "", "Breed": b.breed || "", "Gender": b.gender || "",
    "Status": b.status || "", "Batch": b.batch_name || "", "Location": b.location || "",
    "Hatch Date": b.hatch_date || "", "Acquired Date": b.acquired_date || "", "Target Harvest Date": b.target_harvest_date || "",
    "Harvest Date": b.harvest_date || "", "Dressed Weight (lb)": num(b.harvest_weight), "Price per lb": num(b.price_per_lb),
    "Harvest Value": num(b.harvest_weight && b.price_per_lb ? Number(b.harvest_weight) * Number(b.price_per_lb) : null),
    "Death Date": b.death_date || "", "Death Cause": b.death_cause || "", "Notes": b.notes || "",
  })));

  if (eggs.length) write("Eggs.csv", eggs.map(e => ({
    "Date": e.date || "", "Count": num(e.count, 0), "Price per Egg": num(e.price_per_egg, 4),
    "Value": num(e.count && e.price_per_egg ? Number(e.count) * Number(e.price_per_egg) : null),
    "Notes": e.notes || "",
  })));

  if (expenses.length) write("Finances.csv", expenses.map(x => ({
    "Date": x.date || "", "Type": x.entry_type === "income" ? "Income" : "Expense",
    "Category": x.category || "", "Description": x.description || "", "Amount": num(x.amount),
    "Quantity": num(x.quantity), "Unit": x.unit || "", "Applies To": x.for_type || "", "Notes": "",
  })));

  if (supplies.length) write("Inventory.csv", supplies.map(s => ({
    "Category": s.category || "", "Description": s.description || "", "Brand": s.brand || "",
    "Quantity": num(s.quantity), "Unit": s.unit || "", "Cost": num(s.cost), "Status": s.status || "",
    "Date Added": s.date_added || "", "Opened": s.opened_at || "", "Emptied": s.date_emptied || "",
  })));

  if (bedding.length) write("Bedding.csv", bedding.map(bd => ({
    "Date": bd.date || "", "Area": bd.area || "", "Material": bd.material || "",
    "Type": bd.entry_type || "", "Notes": bd.notes || "",
  })));

  if (birdLogs.length) write("Health Log.csv", birdLogs.map(log => ({
    "Date": log.date || "", "Bird": birdNameById[log.bird_id] || "(deleted bird)", "Note": log.note || "",
  })));

  if (hatches.length) write("Hatches.csv", hatches.map(h => ({
    "Breed": h.breed || "", "Date Started": h.date_started || "", "Status": h.status || "",
    "Eggs Set": num(h.egg_count, 0), "Hatched": num(h.hatched_count, 0), "Named": num(h.named_count, 0),
    "Clear": num(h.clear_count, 0), "Quit": num(h.quit_count, 0), "Failed to Hatch": num(h.failed_count, 0),
    "Notes": h.notes || "",
  })));

  if (notes.length) write("Notes.csv", notes.map(n => ({
    "Date": n.created_date || "", "Category": n.category || "", "Title": n.title || "", "Note": n.body || "",
  })));

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  const safeName = (coop.name || "coop").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  a.href = url;
  a.download = `${safeName}-spreadsheet-${todayStr()}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** Mirrors the server's _do_import_bundle logic exactly (fresh ids for
 * everything, remapping bird_logs.bird_id to the new bird ids) but writes to
 * IndexedDB instead of the server -- so importing a backup works fully
 * offline, with every row (and any embedded photos) queued to push out
 * whenever a connection actually shows up. */
async function importLocalBundle(bundle, photoBlobs, onProgress) {
  const src = bundle.coop || {};
  const newCoop = await localCoopCreate({
    name: (src.name || "Imported Coop").trim(),
    notes: src.notes || "",
    created_date: src.created_date || todayStr(),
    settings: src.settings || "{}",
  });
  const birdIdMap = {};
  const productIdMap = {};
  const hatchIdMap = {};
  const createFns = {
    eggs: localEggCreate, expenses: localExpenseCreate, bedding: localBeddingCreate,
    notes: localNoteCreate, supplies: localSupplyCreate, bird_logs: localBirdLogCreate, hatches: localHatchCreate,
    hatch_eggs: localHatchEggCreate,
  };
  // Birds and supply_products first (so their id maps exist), then
  // everything else, bird_logs and bird_photos after that (both need bird
  // ids remapped), hatch_eggs last of all since it needs both hatches and
  // birds already imported.
  const tables = ["birds", "supply_products", "eggs", "expenses", "bedding", "notes", "hatches", "supplies", "bird_logs", "bird_photos", "hatch_eggs"];
  const totalRows = tables.reduce((sum, t) => sum + (bundle[t] || []).length, 0) || 1;
  let doneRows = 0;
  _suppressActivityLogging = true;
  try {
    for (const table of tables) {
      const rows = bundle[table] || [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const oldId = row.id;
        const payload = { ...row, coop_id: newCoop.id };
        delete payload.id; delete payload.updated_at; delete payload.deleted_at;
        if (table === "bird_logs") {
          const newBirdId = birdIdMap[row.bird_id];
          if (!newBirdId) { doneRows++; continue; } // referenced bird wasn't in this export; skip it, matching server behavior
          payload.bird_id = newBirdId;
        }
        if (table === "supplies" && row.product_id) {
          payload.product_id = productIdMap[row.product_id] || null; // dangling reference (product wasn't in this export) just drops the link, same spirit as the bird_logs skip above
        }
        if (table === "hatch_eggs") {
          const newHatchId = hatchIdMap[row.hatch_id];
          if (!newHatchId) { doneRows++; continue; } // referenced clutch wasn't in this export; skip it
          payload.hatch_id = newHatchId;
          if (row.bird_id) payload.bird_id = birdIdMap[row.bird_id] || null; // dangling reference just drops the flock link, egg stays otherwise intact
        }
        if (table === "bird_photos") {
          const newBirdId = birdIdMap[row.bird_id];
          if (!newBirdId) { doneRows++; continue; } // referenced bird wasn't in this export; skip it
          payload.bird_id = newBirdId;
        }
        if (table === "birds" || table === "supply_products" || table === "bird_photos") {
          const photoRef = payload.photo;
          payload.photo = null;
          const created = table === "birds" ? await localBirdCreate(payload) : table === "supply_products" ? await localSupplyProductCreate(payload) : await localBirdPhotoCreate(payload, { suppressUndo: true });
          if (table === "birds") birdIdMap[oldId] = created.id;
          if (table === "supply_products") productIdMap[oldId] = created.id;
          // A zip import has real blobs already extracted (photoBlobs, keyed
          // by the path stored in the bundle); a plain JSON import (or an
          // older export) still has photos as literal data URIs inline --
          // both are handled here so neither format broke when the zip path
          // stopped needing the data-URI round trip.
          let blob = null;
          if (photoBlobs && typeof photoRef === "string" && photoBlobs[photoRef]) blob = photoBlobs[photoRef];
          else if (typeof photoRef === "string" && photoRef.startsWith("data:")) blob = await dataUriToBlob(photoRef);
          if (blob) {
            if (table === "birds") await queuePendingPhoto(created.id, blob);
            else if (table === "supply_products") await queuePendingProductPhoto(created.id, blob);
            else await queuePendingBirdHistoryPhoto(created.id, blob);
          }
        } else {
          const created = await createFns[table](payload);
          if (table === "hatches") hatchIdMap[oldId] = created.id;
        }
        doneRows++;
        if (onProgress && (doneRows % 20 === 0 || doneRows === totalRows)) onProgress(Math.round((doneRows / totalRows) * 100), `Importing ${table}... ${i + 1}/${rows.length}`);
      }
    }
  } finally {
    _suppressActivityLogging = false;
  }
  // One summary entry instead of the thousands that would've resulted from
  // logging individually -- against the coop actually being imported into,
  // not whatever was active before this (currentCoopId doesn't switch to
  // the new coop until after this function returns).
  const name = getUserName() || "Unnamed";
  const summaryRecord = { id: newLocalId(), coop_id: newCoop.id, resource: "coops", op: "import", changed_by: name, summary: `imported ${doneRows} records`, updated_at: new Date().toISOString(), deleted_at: null };
  await localPutMany("activity_log", [summaryRecord]);
  await queueOutbox({ resource: "activity_log", op: "create", id: summaryRecord.id, payload: summaryRecord });
  trySyncSoon("birds", newCoop.id);
  trySyncSoon("supply_products", newCoop.id);
  return newCoop;
}

/** True if this .zip is one of this app's own offline exports (client-side,
 * data.json + a photos/ folder), as opposed to the server-generated export
 * format, which needs the /api/coops/import.zip endpoint instead. Reading
 * this always works with zero connection -- it's just reading a local file.
 * Returns photos as raw blobs (photoBlobs, keyed by their in-zip path) rather
 * than decoding them to data URIs here only for importLocalBundle to
 * immediately re-encode them back to blobs -- same wasted-round-trip fix as
 * the export side. */
async function tryReadOfflineZipBundle(file, onProgress) {
  try {
    const zip = await JSZip.loadAsync(file);
    const dataEntry = zip.file("data.json");
    if (!dataEntry) return null;
    const bundle = JSON.parse(await dataEntry.async("string"));
    if (!bundle.offline_export) return null;
    const photoBlobs = {};
    const photoRows = [...(bundle.birds || []), ...(bundle.supply_products || [])].filter(r => r.photo && typeof r.photo === "string" && r.photo.startsWith("photos/"));
    for (let i = 0; i < photoRows.length; i++) {
      const r = photoRows[i];
      const entry = zip.file(r.photo);
      if (entry) photoBlobs[r.photo] = await entry.async("blob");
      if (onProgress) onProgress(Math.round(((i + 1) / Math.max(photoRows.length, 1)) * 100), `Reading photos... ${i + 1}/${photoRows.length}`);
    }
    return { bundle, photoBlobs };
  } catch (err) {
    return null; // not a zip we recognize -- caller falls back to the server-side import path
  }
}

async function loadCoopData() {
  if (!currentCoopId) { STATE.birds = []; STATE.eggs = []; STATE.expenses = []; STATE.bedding = []; STATE.birdLogs = []; STATE.notes = []; STATE.supplies = []; STATE.hatches = []; STATE.hatchEggs = []; STATE.birdPhotos = []; STATE.supplyProducts = []; return []; }

  // Everything is local-first now, Birds included: eggs, expenses, supplies,
  // bedding, notes, bird_logs (health/medical records per bird), and birds
  // itself. Sync is best-effort per resource -- if one fails (offline), we
  // still read whatever's already in IndexedDB from last time, rather than
  // showing nothing, and one resource's failure can't block the others.
  const stateKeyFor = { eggs: "eggs", expenses: "expenses", supplies: "supplies", bedding: "bedding", notes: "notes", bird_logs: "birdLogs", birds: "birds", hatches: "hatches", hatch_eggs: "hatchEggs", bird_photos: "birdPhotos", activity_log: "activityLog", supply_products: "supplyProducts" };
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
  await refreshPendingBirdHistoryPhotoUrls();

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

  // Individual egg tracking: any clutch without its own hatch_eggs rows yet
  // gets them generated now (from old aggregate counters if this clutch
  // predates per-egg tracking, or fresh "Incubating" eggs if it's brand new).
  const hatchesNeedingEggs = STATE.hatches.filter(h => !STATE.hatchEggs.some(e => e.hatch_id === h.id));
  if (hatchesNeedingEggs.length) {
    for (const h of hatchesNeedingEggs) await ensureHatchEggsExist(h);
  }

  // Photo timeline: any bird with a current photo but no history entries
  // yet (every bird from before this feature existed) gets one seeded from
  // that photo, so the timeline isn't empty despite already having a shot.
  const birdsNeedingPhotoHistory = STATE.birds.filter(b => b.photo && !STATE.birdPhotos.some(p => p.bird_id === b.id));
  if (birdsNeedingPhotoHistory.length) {
    for (const b of birdsNeedingPhotoHistory) await ensureBirdPhotoHistorySeeded(b);
  }

  // Backfill main_bird_photo_id for birds linked the old way (by matching
  // file path, from before this field existed) -- reposition/delete sync
  // already falls back to a file-path match for these, so this isn't
  // needed for correctness, just to settle everything onto one consistent
  // linking mechanism instead of leaning on that fallback indefinitely.
  const birdsNeedingLinkBackfill = STATE.birds.filter(b => b.photo && !b.main_bird_photo_id);
  for (const b of birdsNeedingLinkBackfill) {
    const match = STATE.birdPhotos.find(p => p.bird_id === b.id && p.photo === b.photo);
    if (match) await localBirdUpdate(b.id, { main_bird_photo_id: match.id });
  }

  return newActivityRows;
}

async function refreshAndRender() { await loadCoopData(); renderActiveTab(); updateSyncIndicator(); }

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

