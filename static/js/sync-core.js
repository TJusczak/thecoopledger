// Sync decisions with no DOM or IndexedDB in them, so Node can test them directly
// (tests/test_sync_core.mjs loads this file on its own).
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

const SYNC_PAGE_SIZE = 1000;       // rows per pull request; the server pages on request and never splits a transaction
const MAX_REJECTED_KEPT = 50;      // how many "server refused this change" records to remember

// Keys the server owns. A locally queued create carries the client's own timestamps; they must never be
// laid over a row the server has stamped.
const SERVER_OWNED_FIELDS = ["updated_at", "deleted_at"];

function _stripServerOwned(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) if (!SERVER_OWNED_FIELDS.includes(k)) out[k] = fields[k];
  return out;
}

/** Re-applies still-unsent local changes on top of rows just pulled from the server.
 *
 * Why: a pull replaces the local copy of a row with the server's. If this device has an edit
 * queued that the server hasn't seen yet (the push was interrupted, or a transient 5xx stopped
 * it), a plain replace would make the user's own edit visibly revert -- and a second device's
 * view and ours would briefly disagree about it. Overlaying the queue keeps what the user sees
 * equal to "server state + my pending changes", which is also what the server will hold once the
 * queue drains (updates merge per field there).
 *
 * `outbox` is the array stored in IndexedDB, oldest first. Returns new row objects; inputs are
 * not mutated. */
function rebasePulledRows(resource, rows, outbox) {
  const pending = (outbox || []).filter(o => o.resource === resource);
  if (!pending.length || !rows.length) return rows;
  return rows.map(row => {
    let out = row;
    const copy = () => { if (out === row) out = { ...row }; return out; };
    for (const op of pending) {
      if (op.op === "create" && op.id === row.id) Object.assign(copy(), _stripServerOwned(op.payload));
      else if (op.op === "update" && op.id === row.id) Object.assign(copy(), _stripServerOwned(op.payload));
      else if (op.op === "delete" && op.id === row.id) copy().deleted_at = op.queuedAt || new Date().toISOString();
      else if (op.op === "bulk-create" && Array.isArray(op.payload)) {
        const item = op.payload.find(p => p && p.id === row.id);
        if (item) Object.assign(copy(), _stripServerOwned(item));
      } else if (op.op === "bulk-update" && Array.isArray(op.payload)) {
        for (const u of op.payload) if (u && u.id === row.id) Object.assign(copy(), _stripServerOwned(u.fields));
      } else if (op.op === "bulk-delete" && Array.isArray(op.payload) && op.payload.includes(row.id)) {
        copy().deleted_at = op.queuedAt || new Date().toISOString();
      }
    }
    return out;
  });
}

/** What to do with the server's answer to one queued change.
 *   "done"   -- accepted; remove from the queue
 *   "auth"   -- not logged in; stop and ask the user to log in again (never discard)
 *   "drop"   -- the target is already gone (404 on update/delete: two devices deleted the same
 *               thing); there is nothing left to save, so discard quietly
 *   "reject" -- the server permanently refuses this exact request (bad payload, too large...);
 *               retrying can never work, so remove it from the queue so it can't block everything
 *               behind it -- but KEEP A RECORD so the user finds out their change wasn't saved
 *   "retry"  -- possibly transient (403, 5xx, anything unexpected); stop and try again later */
function classifyOutboxResponse(entry, status) {
  if (status >= 200 && status < 300) return "done";
  if (status === 401) return "auth";
  if (status === 403) return "retry";
  if (status === 404 && (entry.op === "update" || entry.op === "delete" || entry.op === "bulk-update" || entry.op === "bulk-delete")) return "drop";
  if (status >= 400 && status < 500) return "reject";
  return "retry";
}

/** True when the server's cursor is OLDER than the one we hold -- which can only mean the server's
 * database was restored from a backup (its clock only ever moves forward otherwise). Pulling with
 * our newer cursor would return nothing, forever; the right response is a full re-pull. */
function cursorWentBackwards(since, serverTime) {
  return !!since && !!serverTime && serverTime < since;
}

/** Plain-language one-liner for a rejected change, for the Settings list. */
function describeRejectedChange(r) {
  const what = `${r.op} ${r.resource}`;
  return `${what} (HTTP ${r.status}${r.detail ? `: ${r.detail}` : ""})`;
}
