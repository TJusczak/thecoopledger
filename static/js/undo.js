// Undo / redo history (and the shared confirm-delete helper).
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)


/** The common shape behind every edit modal's Delete button: confirm,
 * delete, toast, close the modal, then refresh whatever needs to reflect
 * it. refreshFn can be sync or async (both are awaited safely). */
// ---------- Undo / redo ----------
//
// Each entry on the stack represents one user-facing action, which may
// touch several records at once (a bulk delete, or later, a chain reaction
// like a hatched chick creating a bird record) -- one undo always reverses
// the whole thing as a single step, never one record at a time.
//
// An action's `operations` array holds one {resource, id, before, after}
// tuple per record it touched. before/after are full record snapshots, or
// null -- null `before` means the record didn't exist yet (a create), null
// `after` means it was deleted. That's enough information to reverse or
// re-apply any create, update, or delete generically, through the exact
// same code path, without this engine needing to know anything
// resource-specific about birds vs eggs vs expenses.
const UNDO_STACK_LIMIT = 10;
let undoStack = [];
let redoStack = [];

/** Call this once, right after a save/delete actually completes, with the
 * full set of record changes that one user action caused. Starts a fresh
 * redo history, since redoing something from before this new action would
 * no longer make sense against the current state. */
function pushUndoAction(label, operations) {
  undoStack.push({ id: newLocalId(), label, operations, timestamp: Date.now() });
  if (undoStack.length > UNDO_STACK_LIMIT) undoStack.shift();
  redoStack = [];
  renderUndoRedoBar();
}

/** Writes a specific target state for one record, generically across any
 * resource -- reused by both undo and redo, just with a different target.
 * A null target means the record shouldn't exist right now (undoing a
 * create, or redoing a delete); anything else means restoring it to
 * exactly that snapshot. Goes through the same localPutMany + outbox shape
 * every local*Update/*Delete function already uses, so this participates
 * in sync normally -- an undo made offline queues and goes out later,
 * exactly like any other change. */
async function applyOperationTarget(resource, id, targetState, coopId) {
  const now = new Date().toISOString();
  if (targetState === null) {
    const existing = await localGetOne(resource, id);
    const record = { ...(existing || { id }), deleted_at: now, updated_at: now };
    await localPutMany(resource, [record]);
    await queueOutbox({ resource, op: "delete", id, payload: null });
  } else {
    const record = { ...targetState, deleted_at: null, updated_at: now };
    await localPutMany(resource, [record]);
    await queueOutbox({ resource, op: "update", id, payload: record });
  }
  trySyncSoon(resource, coopId || (targetState && targetState.coop_id));
}

async function applyAction(action, direction) {
  const ops = direction === "undo" ? [...action.operations].reverse() : action.operations;
  for (const op of ops) {
    const target = direction === "undo" ? op.before : op.after;
    await applyOperationTarget(op.resource, op.id, target, currentCoopId);
  }
}

/** The confirmation popup itself -- reuses the existing confirm-dialog
 * component rather than a bespoke one, so this looks and behaves like
 * every other confirmation in the app instead of introducing a new style
 * of popup for just this. */
async function performUndo() {
  if (undoStack.length === 0) return;
  const action = undoStack[undoStack.length - 1];
  if (!(await showConfirmDialog(`Undo this? ${action.label}`, "Undo"))) return;
  await applyAction(action, "undo");
  undoStack.pop();
  redoStack.push(action);
  if (redoStack.length > UNDO_STACK_LIMIT) redoStack.shift();
  renderUndoRedoBar();
  showToast(`Undone: ${action.label}`, "update");
  await refreshAndRender();
}

async function performRedo() {
  if (redoStack.length === 0) return;
  const action = redoStack[redoStack.length - 1];
  if (!(await showConfirmDialog(`Redo this? ${action.label}`, "Redo"))) return;
  await applyAction(action, "redo");
  redoStack.pop();
  undoStack.push(action);
  if (undoStack.length > UNDO_STACK_LIMIT) undoStack.shift();
  renderUndoRedoBar();
  showToast(`Redone: ${action.label}`, "update");
  await refreshAndRender();
}

/** Small fixed corner bar, mirroring the existing "Local only" badge in
 * the opposite corner -- invisible unless there's actually something to
 * undo or redo, so it never costs any layout space the rest of the time. */
/** Persisted to IndexedDB so undo/redo history survives a page reload or
 * closing and reopening the app -- not synced anywhere, purely local to
 * this device, same as the rest of this feature. */
async function persistUndoHistory() {
  const db = await openLocalDb();
  const tx = db.transaction(["undo_history"], "readwrite");
  tx.objectStore("undo_history").put({ key: "history", undoStack, redoStack });
}
async function loadUndoHistory() {
  try {
    const db = await openLocalDb();
    const tx = db.transaction(["undo_history"], "readonly");
    const row = await idbRequest(tx.objectStore("undo_history").get("history"));
    if (row) { undoStack = row.undoStack || []; redoStack = row.redoStack || []; }
  } catch (err) { /* nothing persisted yet, or this is a first run -- fine, stacks just start empty */ }
}

function renderUndoRedoBar() {
  persistUndoHistory();
  const slot = document.getElementById("undoRedoSlot");
  if (!slot) return;
  let bar = document.getElementById("undoRedoBar");
  if (undoStack.length === 0 && redoStack.length === 0) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "undoRedoBar";
    bar.className = "undo-redo-bar";
    bar.innerHTML = `
      <button id="undoBarBtn" title="Undo">↺</button>
      <button id="redoBarBtn" title="Redo">↻</button>
    `;
    slot.appendChild(bar);
    document.getElementById("undoBarBtn").addEventListener("click", () => performUndo());
    document.getElementById("redoBarBtn").addEventListener("click", () => performRedo());
  }
  document.getElementById("undoBarBtn").disabled = undoStack.length === 0;
  document.getElementById("redoBarBtn").disabled = redoStack.length === 0;
}

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

