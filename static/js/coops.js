// Coop create/edit/import/export UI.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= COOPS =================
/** Editing this is rare -- mainly for someone importing history from
 * elsewhere, or fixing a coop that got created a few days after it
 * actually started. A native date input rather than the prompt() dialog
 * used for renaming, since typing a date by hand invites typos that a
 * picker avoids entirely. */
function openEditCoopDateModal(coopId, currentDate) {
  const html = `
    <div class="form-head">Established date</div>
    <div class="dim" style="font-size:12px;margin-bottom:14px">When this coop actually started -- shown on its card and used for any "days since established" stats.</div>
    <label class="field"><span>Date</span><input type="date" id="editCoopDate" value="${esc(currentDate || "")}"></label>
    <div class="modal-actions"><button class="btn btn-confirm" id="saveCoopDate">✓ Save</button></div>
  `;
  openModal(html);
  document.getElementById("saveCoopDate").addEventListener("click", async () => {
    const newDate = document.getElementById("editCoopDate").value;
    if (!newDate) { showToast("Pick a date first", "delete"); return; }
    await localCoopUpdate(coopId, { created_date: newDate });
    showToast("Established date updated", "update");
    await loadCoops();
    updateHeader();
    closeModal();
    renderCoopsSection();
  });
}

function renderCoopsSection() {
  const el = document.getElementById("settingsContent");
  el.innerHTML = `
    <div class="toolbar"><div class="dim">${STATE.coops.length} coop${STATE.coops.length !== 1 ? "s" : ""}</div></div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">
    <div class="form-block" style="margin:0">
      <div class="form-head">Create a coop</div>
      <div class="grid-form" style="grid-template-columns:1fr">
        <label class="field"><span>Name</span><input id="c_name" placeholder="e.g. Home Flock"></label>
        <label class="field"><span>Notes</span><input id="c_notes" placeholder="optional"></label>
      </div>
      <div style="margin-top:12px"><button class="btn btn-confirm" id="createCoop">+ Create coop</button></div>
    </div>

    <div class="form-block" style="margin:0">
      <div class="form-head">Import a coop</div>
      <div class="dim" style="font-size:12px;margin-bottom:10px">A .json import works with no connection at all -- everything (including any photos) lands in this device's local storage and syncs to the server whenever one's reachable. A .zip import needs a live connection, since unzipping and writing photo files happens server-side. Either way, this always creates a brand-new coop — it never overwrites an existing one.</div>
      <input type="file" id="importFile" accept=".zip,application/zip,application/json" style="max-width:100%">
    </div>
    </div>

    <div class="note-box" style="margin-bottom:12px"><strong style="color:var(--text)">Export (.zip)</strong> is the backup to use -- everything, with real photo files in a photos/ folder, and it works the same whether you're online or offline. <strong style="color:var(--text)">Spreadsheet (.csv)</strong> is not a backup -- it's a handful of clean, readable files (Flock, Eggs, Finances, Inventory, Bedding, Health Log, Hatches, Notes) for viewing or analyzing in a spreadsheet program. Weights are always in lb regardless of your display setting. It can't be re-imported and doesn't include photos.</div>

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
            <button class="btn ghost small" data-edit-date="${c.id}" data-current-date="${esc(c.created_date || "")}">Edit date</button>
            <button class="btn ghost small" data-export-offline-zip="${c.id}">📦 Export (.zip)</button>
            <button class="btn ghost small" data-export-csv="${c.id}" title="Not a backup -- clean, readable CSV files for a spreadsheet, no photos, can't be re-imported">Spreadsheet (.csv)</button>
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
        openProgressModal("Reading backup");
        const offline = await tryReadOfflineZipBundle(file, (percent, label) => updateProgressModal(Math.round(percent * 0.25), label));
        if (offline) {
          coop = await importLocalBundle(offline.bundle, offline.photoBlobs, (percent, label) => updateProgressModal(25 + Math.round(percent * 0.75), label));
          await loadCoops();
          closeProgressModal();
        } else {
          closeProgressModal();
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
        openProgressModal("Importing backup");
        const bundle = JSON.parse(await file.text());
        coop = await importLocalBundle(bundle, null, (percent, label) => updateProgressModal(percent, label));
        await loadCoops();
        closeProgressModal();
      }
      showToast(`"${coop.name}" imported`, "create");
      if (!localOnlyMode) showToast("Now pushing everything to your sync server -- keep this open a moment", "update");
      await switchCoop(coop.id);
      switchTab("dashboard");
      updateSyncIndicator();
    } catch (err) {
      closeProgressModal();
      alert("Could not import that file — make sure it's a backup exported from this app.\n\n" + err.message);
    }
    e.target.value = "";
  });

  el.querySelectorAll("[data-export-offline-zip]").forEach(b => b.addEventListener("click", async () => {
    openProgressModal("Exporting backup");
    try {
      await exportLocalZip(b.dataset.exportOfflineZip, (percent, label) => updateProgressModal(percent, label));
      updateProgressModal(100, "Done");
      closeProgressModal();
      showToast("Backup downloaded", "create");
    } catch (err) {
      closeProgressModal();
      alert("Export failed: " + err.message);
    }
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
  el.querySelectorAll("[data-edit-date]").forEach(b => b.addEventListener("click", () => {
    openEditCoopDateModal(b.dataset.editDate, b.dataset.currentDate);
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

