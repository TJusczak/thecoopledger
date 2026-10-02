// Notes.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= NOTES =================
let editingNoteId = null;
let notesFiltersOpen = false;
let noteFilters = { category: "", search: "" };

const NOTE_COLORS = [
  { key: "", label: "Default", css: "var(--border)" },
  { key: "gold", label: "Gold", css: "var(--gold)" },
  { key: "rust", label: "Rust", css: "var(--rust)" },
  { key: "sage", label: "Sage", css: "var(--sage)" },
  { key: "slate", label: "Slate", css: "var(--slate)" },
];
function noteColorCss(key) { return (NOTE_COLORS.find(c => c.key === key) || NOTE_COLORS[0]).css; }

/** "Created X" alone, or "Created X · Edited Y" once an edit has actually
 * happened -- compares just the date portion of updated_at against
 * created_date, so saving a note the same day it was created (the very
 * common case) doesn't show a redundant "edited today" next to "created
 * today." */
function noteTimestampLabel(n) {
  if (!n.created_date) return "";
  const created = fmtDate(n.created_date);
  const editedDatePart = n.updated_at ? n.updated_at.slice(0, 10) : null;
  const edited = (editedDatePart && editedDatePart !== n.created_date) ? fmtDate(editedDatePart) : null;
  return edited ? `Created ${created} · Edited ${edited}` : `Created ${created}`;
}

/** A small, purpose-built markdown subset for notes -- bold, italic, and
 * interactive checklists, not a full CommonMark implementation. Escapes
 * first (the same esc() used everywhere else in the app) so markdown
 * syntax characters are the only thing ever interpreted -- raw HTML typed
 * into a note is never rendered as markup, just shown as plain text. */
function inlineMd(escapedLine) {
  return escapedLine
    .replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(/(^|[^A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>");
}
function renderNoteMarkdown(text) {
  if (!text) return "";
  const lines = esc(text).split("\n");
  let html = "";
  let listType = null; // null | "check" | "bullet"
  const closeListIfOpen = () => { if (listType) { html += "</ul>"; listType = null; } };
  lines.forEach((line, idx) => {
    const checkMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
    const bulletMatch = !checkMatch ? line.match(/^\s*[-*]\s+(.*)$/) : null;
    if (checkMatch) {
      if (listType !== "check") { closeListIfOpen(); html += `<ul class="note-checklist">`; listType = "check"; }
      const checked = checkMatch[1].toLowerCase() === "x";
      html += `<li class="note-check-item${checked ? " checked" : ""}" data-line="${idx}"><span class="note-check-box">${checked ? "☑" : "☐"}</span><span>${inlineMd(checkMatch[2])}</span></li>`;
    } else if (bulletMatch) {
      if (listType !== "bullet") { closeListIfOpen(); html += `<ul class="note-bullet-list">`; listType = "bullet"; }
      html += `<li>${inlineMd(bulletMatch[1])}</li>`;
    } else {
      closeListIfOpen();
      html += line.trim() === "" ? "<br>" : `<div>${inlineMd(line)}</div>`;
    }
  });
  closeListIfOpen();
  return html;
}

/** Toggles a single checklist line's [ ]/[x] state and saves -- used both
 * from the note card preview and the modal's own preview, so ticking
 * something off never requires opening the edit form first. */
async function toggleNoteChecklistLine(noteId, lineIndex) {
  const note = STATE.notes.find(n => n.id === noteId);
  if (!note || !note.body) return;
  const lines = note.body.split("\n");
  const line = lines[lineIndex];
  if (line == null) return;
  const match = line.match(/^(\s*-\s*\[)([ xX])(\]\s*.*)$/);
  if (!match) return;
  const newChar = match[2].toLowerCase() === "x" ? " " : "x";
  lines[lineIndex] = match[1] + newChar + match[3];
  await localNoteUpdate(noteId, { body: lines.join("\n") });
  STATE.notes = await localGetAll("notes", currentCoopId);
  renderNotesSection();
}

/** Wraps the textarea's current selection in markdown delimiters (or just
 * inserts them at the cursor with nothing selected), used by the Bold/
 * Italic toolbar buttons. */
function wrapTextareaSelection(textareaId, before, after = before) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const value = ta.value;
  const selected = value.slice(start, end);
  ta.value = value.slice(0, start) + before + selected + after + value.slice(end);
  ta.focus();
  ta.selectionStart = start + before.length;
  ta.selectionEnd = start + before.length + selected.length;
}
/** Inserts a prefix at the start of the current line, used by the
 * Checklist/Bullet toolbar buttons. */
function insertAtLineStart(textareaId, prefix) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  const start = ta.selectionStart;
  const value = ta.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  ta.value = value.slice(0, lineStart) + prefix + value.slice(lineStart);
  const newPos = start + prefix.length;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = newPos;
}

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
        ${selectModeButtonHtml("notes", "toggleNoteSelectMode")}
        <button class="btn" id="toggleNoteForm">+ Add note</button>
      </div>
    </div>

    ${bulkDeleteBarHtml(selectedNoteIds)}

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
          <div class="list-card${selectedNoteIds.has(n.id) ? " card-selected" : ""}" data-edit="${n.id}" data-id="${n.id}" style="cursor:pointer;flex-direction:column;align-items:stretch;border-left:4px solid ${noteColorCss(n.color)}">
            <div style="display:flex;gap:8px;align-items:flex-start">
              ${selectionState.notes.mode ? `<input type="checkbox" class="list-card-check note-check" data-id="${n.id}" ${selectedNoteIds.has(n.id) ? "checked" : ""} onclick="event.stopPropagation()">` : ""}
              <div style="font-weight:700;flex:1">${esc(n.title || "Untitled")}</div>
            </div>
            <div class="note-body-preview dim" data-note-id="${n.id}" style="margin-top:4px;font-size:13px">${renderNoteMarkdown(n.body)}</div>
            ${noteTimestampLabel(n) ? `<div class="dim" style="font-size:10px;margin-top:8px">${noteTimestampLabel(n)}</div>` : ""}
          </div>`).join("")}
      </div>
    `).join("")}
  `;

  el.querySelectorAll("[data-pill-cat]").forEach(p => p.addEventListener("click", () => openNoteModal(null, p.dataset.pillCat === "__new__" ? "" : p.dataset.pillCat)));
  document.getElementById("toggleNoteForm").addEventListener("click", () => openNoteModal(null, null));
  document.getElementById("toggleNoteFilters").addEventListener("click", () => { notesFiltersOpen = !notesFiltersOpen; renderNotesSection(); });
  document.getElementById("toggleNoteSelectMode").addEventListener("click", () => {
    selectionState.notes.mode = !selectionState.notes.mode;
    if (!selectionState.notes.mode) selectedNoteIds.clear();
    renderNotesSection();
  });

  el.querySelectorAll(".note-body-preview [data-line]").forEach(item => item.addEventListener("click", (e) => {
    e.stopPropagation();
    const noteId = item.closest("[data-note-id]").dataset.noteId;
    toggleNoteChecklistLine(noteId, Number(item.dataset.line));
  }));
  el.querySelectorAll(".note-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedNoteIds.add(cb.dataset.id); else selectedNoteIds.delete(cb.dataset.id);
    renderNotesSection();
  }));
  wireCardSelection(
    el.querySelectorAll("[data-edit]"),
    selectedNoteIds,
    "notes",
    () => [...el.querySelectorAll("[data-edit]")].map(c => c.dataset.id),
    (id) => openNoteModal(STATE.notes.find(n => n.id === id), null),
    renderNotesSection
  );
  wireBulkDeleteBar(selectedNoteIds, "notes", "note", async () => { STATE.notes = await localGetAll("notes", currentCoopId); }, renderNotesSection);
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
  const currentColor = editing ? (editing.color || "") : "";
  return `
    <div class="form-head">${editing ? "Edit note" : "Add a note"}</div>
    ${editing && noteTimestampLabel(editing) ? `<div class="dim" style="font-size:11px;margin-top:-6px;margin-bottom:12px">${noteTimestampLabel(editing)}</div>` : ""}
    <div class="grid-form">
      <label class="field"><span>Category</span><input id="n_category" list="noteCategories" placeholder="e.g. Meat Birds, Feed, General" value="${editing ? esc(editing.category || "") : esc(presetCategory || "")}"></label>
      <label class="field"><span>Title</span><input id="n_title" placeholder="e.g. Processing age" value="${editing ? esc(editing.title || "") : ""}"></label>
    </div>
    <datalist id="noteCategories">${categoryNames.map(c => `<option value="${esc(c)}">`).join("")}</datalist>

    <div class="field" style="margin-top:10px">
      <span>Color</span>
      <div class="note-color-picker" id="n_color_picker">
        ${NOTE_COLORS.map(c => `<button type="button" class="note-color-swatch${currentColor === c.key ? " active" : ""}" data-color="${c.key}" style="--swatch-color:${c.css}" title="${c.label}"></button>`).join("")}
      </div>
    </div>

    <div class="field" style="margin-top:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px">
        <span>Note</span>
        <div style="display:flex;gap:4px">
          <button type="button" class="btn ghost small active" id="n_tab_write">✎ Write</button>
          <button type="button" class="btn ghost small" id="n_tab_preview">👁 Preview</button>
        </div>
      </div>
      <div class="note-toolbar" id="n_toolbar">
        <button type="button" class="note-toolbar-btn" id="nt_bold" title="Bold"><strong>B</strong></button>
        <button type="button" class="note-toolbar-btn" id="nt_italic" title="Italic"><em>I</em></button>
        <button type="button" class="note-toolbar-btn" id="nt_check" title="Checklist item">☑ Check</button>
        <button type="button" class="note-toolbar-btn" id="nt_bullet" title="Bullet item">• List</button>
      </div>
      <textarea id="n_body" rows="10" placeholder="e.g. Cornish Cross are typically processed around 8 weeks — go by weight and behavior, not just the calendar.&#10;&#10;- [ ] Order feed for next batch&#10;- [x] Clean brooder">${editing ? esc(editing.body || "") : ""}</textarea>
      <div id="n_preview" class="note-preview-box" style="display:none"></div>
      <div class="dim" style="font-size:11px;margin-top:6px">Markdown: **bold**, *italic*, "- [ ] task" for a checklist, "- item" for a bullet.</div>
    </div>

    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveNote">${editing ? "✓ Save changes" : "+ Add note"}</button>
    </div>
  `;
}

function openNoteModal(editing, presetCategory) {
  editingNoteId = editing ? editing.id : null;
  let selectedColor = editing ? (editing.color || "") : "";
  openModal(
    noteFormHtml(editing, presetCategory),
    () => { editingNoteId = null; },
    editing ? () => confirmAndDelete(
      "Delete this note?",
      () => localNoteDelete(editing.id, currentCoopId),
      "Note deleted",
      async () => { await loadCoopData(); renderNotesSection(); }
    ) : null,
    null,
    "modal-panel-large"
  );
  if (!editing) { const titleInput = document.getElementById("n_title"); if (titleInput) titleInput.focus(); }

  document.getElementById("n_color_picker").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-color]");
    if (!btn) return;
    selectedColor = btn.dataset.color;
    document.querySelectorAll(".note-color-swatch").forEach(s => s.classList.toggle("active", s.dataset.color === selectedColor));
  });

  const writeTab = document.getElementById("n_tab_write");
  const previewTab = document.getElementById("n_tab_preview");
  const toolbar = document.getElementById("n_toolbar");
  const textarea = document.getElementById("n_body");
  const previewBox = document.getElementById("n_preview");

  textarea.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || textarea.selectionStart !== textarea.selectionEnd) return; // only plain Enter, not Enter-with-a-selection
    const val = textarea.value;
    const pos = textarea.selectionStart;
    const lineStart = val.lastIndexOf("\n", pos - 1) + 1;
    const lineEnd = val.indexOf("\n", pos);
    const lineEndPos = lineEnd === -1 ? val.length : lineEnd;
    const textToCursor = val.slice(lineStart, pos);
    const checkMatch = textToCursor.match(/^(\s*)-\s*\[([ xX])\]\s*/);
    const bulletMatch = !checkMatch ? textToCursor.match(/^(\s*)-\s+/) : null;
    const match = checkMatch || bulletMatch;
    if (!match) return; // not on a list line -- let Enter behave normally
    e.preventDefault();
    const indent = match[1] || "";
    const lineText = val.slice(lineStart, lineEndPos);
    const hasContent = lineText.slice(match[0].length).trim() !== "";
    if (!hasContent) {
      // Empty list item -- exit the list instead of continuing it, or every
      // attempt to stop typing a list would just add another empty item.
      const rest = val.slice(lineStart + match[0].length, lineEndPos);
      textarea.value = val.slice(0, lineStart) + rest + "\n" + val.slice(lineEndPos);
      const newPos = lineStart + rest.length + 1;
      textarea.selectionStart = textarea.selectionEnd = newPos;
    } else {
      const newPrefix = checkMatch ? `${indent}- [ ] ` : `${indent}- `;
      textarea.value = val.slice(0, pos) + "\n" + newPrefix + val.slice(pos);
      const newPos = pos + 1 + newPrefix.length;
      textarea.selectionStart = textarea.selectionEnd = newPos;
    }
  });

  function wirePreviewChecklist() {
    previewBox.querySelectorAll("[data-line]").forEach(item => item.addEventListener("click", () => {
      const lines = textarea.value.split("\n");
      const idx = Number(item.dataset.line);
      const line = lines[idx];
      const match = line != null && line.match(/^(\s*-\s*\[)([ xX])(\]\s*.*)$/);
      if (!match) return;
      lines[idx] = match[1] + (match[2].toLowerCase() === "x" ? " " : "x") + match[3];
      textarea.value = lines.join("\n");
      previewBox.innerHTML = renderNoteMarkdown(textarea.value) || `<span class="dim">Nothing to preview yet.</span>`;
      wirePreviewChecklist();
    }));
  }
  previewTab.addEventListener("click", () => {
    previewBox.innerHTML = renderNoteMarkdown(textarea.value) || `<span class="dim">Nothing to preview yet.</span>`;
    wirePreviewChecklist();
    previewBox.style.display = "block";
    textarea.style.display = "none";
    toolbar.style.display = "none";
    previewTab.classList.add("active");
    writeTab.classList.remove("active");
  });
  writeTab.addEventListener("click", () => {
    previewBox.style.display = "none";
    textarea.style.display = "block";
    toolbar.style.display = "flex";
    writeTab.classList.add("active");
    previewTab.classList.remove("active");
    textarea.focus();
  });
  document.getElementById("nt_bold").addEventListener("click", () => wrapTextareaSelection("n_body", "**"));
  document.getElementById("nt_italic").addEventListener("click", () => wrapTextareaSelection("n_body", "*"));
  document.getElementById("nt_check").addEventListener("click", () => insertAtLineStart("n_body", "- [ ] "));
  document.getElementById("nt_bullet").addEventListener("click", () => insertAtLineStart("n_body", "- "));

  document.getElementById("saveNote").addEventListener("click", async () => {
    const title = document.getElementById("n_title").value.trim();
    const body = document.getElementById("n_body").value.trim();
    if (!title && !body) return;
    const payload = { coop_id: currentCoopId, category: document.getElementById("n_category").value.trim() || "General", title, body, color: selectedColor };
    if (editing) await localNoteUpdate(editing.id, payload);
    else await localNoteCreate({ ...payload, created_date: todayStr() });
    showToast(editing ? "Note updated" : "Note added", editing ? "update" : "create");
    closeModal();
    await loadCoopData();
    renderNotesSection();
  });
}

