// Tests for the client's sync decisions (static/js/sync-core.js), which have no DOM or
// IndexedDB in them precisely so they can be tested here.
//
// Run with: node tests/test_sync_core.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "static");
const read = (p) => readFileSync(join(root, p), "utf8");

// Classic script: run it in a bare context and read back what it declares.
const ctx = vm.createContext({});
vm.runInContext(read("js/sync-core.js") + "\n;this.api = { rebasePulledRows, classifyOutboxResponse, cursorWentBackwards, describeRejectedChange };", ctx);
const { rebasePulledRows, classifyOutboxResponse, cursorWentBackwards, describeRejectedChange } = ctx.api;

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, msg); n++; };

// ---------------------------------------------------------------- rebasePulledRows
const server = [{ id: "a", resource_marker: 1, name: "Server name", breed: "Orp", updated_at: "S1", deleted_at: null },
                { id: "b", name: "Other", updated_at: "S1", deleted_at: null }];

// no pending changes: rows come back untouched (same objects -- nothing to copy)
ok(rebasePulledRows("birds", server, []) === server, "no outbox -> same array");
ok(rebasePulledRows("birds", server, [{ resource: "eggs", op: "update", id: "a", payload: { name: "x" } }]) === server, "other resource's queue is irrelevant");

// a pending local edit survives the pull (this is the 'my edit visibly reverts' bug)
let out = rebasePulledRows("birds", server, [{ resource: "birds", op: "update", id: "a", payload: { name: "My edit" } }]);
eq(out[0].name, "My edit", "pending update is re-applied");
eq(out[0].breed, "Orp", "other fields come from the server");
eq(out[1].name, "Other", "unrelated rows untouched");
eq(server[0].name, "Server name", "input is not mutated");

// queue order wins: a later edit overrides an earlier one
out = rebasePulledRows("birds", server, [
  { resource: "birds", op: "update", id: "a", payload: { name: "first" } },
  { resource: "birds", op: "update", id: "a", payload: { name: "second" } }]);
eq(out[0].name, "second", "later queued edit wins");

// the server owns timestamps: a queued payload's client-side updated_at/deleted_at never overwrite the row's
out = rebasePulledRows("birds", server, [{ resource: "birds", op: "update", id: "a", payload: { name: "n", updated_at: "CLIENT", deleted_at: "CLIENT" } }]);
eq([out[0].updated_at, out[0].deleted_at], ["S1", null], "server-owned fields are not overlaid");

// a pending delete keeps the row deleted locally
out = rebasePulledRows("birds", server, [{ resource: "birds", op: "delete", id: "a", payload: null, queuedAt: "Q1" }]);
eq(out[0].deleted_at, "Q1", "pending delete stays deleted");

// bulk ops
out = rebasePulledRows("birds", server, [{ resource: "birds", op: "bulk-update", payload: [{ id: "b", fields: { name: "bulk" } }] }]);
eq([out[0].name, out[1].name], ["Server name", "bulk"], "bulk-update overlays only its ids");
out = rebasePulledRows("birds", server, [{ resource: "birds", op: "bulk-delete", payload: ["a"], queuedAt: "Q2" }]);
eq([out[0].deleted_at, out[1].deleted_at], ["Q2", null], "bulk-delete");
out = rebasePulledRows("birds", server, [{ resource: "birds", op: "bulk-create", payload: [{ id: "a", name: "from bulk create", updated_at: "C" }] }]);
eq([out[0].name, out[0].updated_at], ["from bulk create", "S1"], "bulk-create overlays by id");

// ------------------------------------------------------------ classifyOutboxResponse
const upd = { op: "update" }, del = { op: "delete" }, crt = { op: "create" };
eq(classifyOutboxResponse(crt, 200), "done"); eq(classifyOutboxResponse(crt, 204), "done");
eq(classifyOutboxResponse(upd, 401), "auth", "401 is never discarded");
eq(classifyOutboxResponse(upd, 403), "retry", "403 is retried (role may change), not dropped");
eq(classifyOutboxResponse(del, 404), "drop", "deleting something already gone is fine");
eq(classifyOutboxResponse(upd, 404), "drop", "editing something gone: nothing left to save");
eq(classifyOutboxResponse(crt, 404), "reject", "a create 404 means a wrong URL, not 'already gone'");
eq(classifyOutboxResponse(crt, 400), "reject"); eq(classifyOutboxResponse(crt, 413), "reject"); eq(classifyOutboxResponse(upd, 422), "reject");
eq(classifyOutboxResponse(upd, 500), "retry"); eq(classifyOutboxResponse(upd, 503), "retry"); eq(classifyOutboxResponse(upd, 0), "retry");

// ------------------------------------------------------------ cursorWentBackwards
ok(cursorWentBackwards("2026-10-02T10:00:00.000001+00:00", "2026-10-01T09:00:00.000001+00:00"), "server older than cursor => restored backup");
ok(!cursorWentBackwards("2026-10-02T10:00:00.000001+00:00", "2026-10-02T10:00:00.000001+00:00"), "equal is fine (nothing new)");
ok(!cursorWentBackwards("2026-10-02T10:00:00.000001+00:00", "2026-10-03T00:00:00.000001+00:00"), "normal forward progress");
ok(!cursorWentBackwards("", "2026-10-03T00:00:00.000001+00:00"), "first sync has no cursor to regress");

ok(/HTTP 400: bad id/.test(describeRejectedChange({ op: "create", resource: "birds", status: 400, detail: "bad id" })), "describe");

// ------------------------------------------------- app and service worker stay in step
// sw.js replays the outbox with its own request builder. If an op is added to the app and not
// there, the background drain would silently skip those entries.
const appOps = new Set([...read("js/sync.js").matchAll(/entry\.op === "([\w-]+)"/g)].map(m => m[1]));
const swOps = new Set([...read("sw.js").matchAll(/case "([\w-]+)":\s*return \{/g)].map(m => m[1]));
eq([...appOps].sort(), [...swOps].sort(), "sw.js outboxRequestFor handles exactly the ops sync.js pushes");

// the worker must reuse the shared rules, not carry its own copy of 'discard on 4xx'
ok(/importScripts\("js\/sync-core\.js"\)/.test(read("sw.js")), "sw.js imports sync-core.js");
ok(/classifyOutboxResponse\(entry, res\.status\)/.test(read("sw.js")), "sw.js uses classifyOutboxResponse");
ok(!/res\.status >= 500\) throw/.test(read("sw.js")), "sw.js no longer deletes on 401/403");
// ...and sync-core.js must be shipped to the offline cache
ok(/"js\/sync-core\.js"/.test(read("sw.js")), "sync-core.js is in the offline shell cache");

console.log(`✓ sync core: ${n} assertions passed`);
