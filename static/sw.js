// Shared, DOM-free sync rules (classifyOutboxResponse, REJECTED_KEY, ...) -- the
// background drain below must make exactly the same decisions as the app does.
importScripts("js/sync-core.js");

const CACHE_NAME = "coop-ledger-shell-v8";
const SHELL_ASSETS = [
  "./",
  "style.css",
  "app.js",
  "js/state.js",
  "js/helpers.js",
  "js/connection-auth.js",
  "js/local-db.js",
  "js/sync-core.js",
  "js/sync.js",
  "js/local-crud.js",
  "js/export-import.js",
  "js/shell.js",
  "js/settings.js",
  "js/notes.js",
  "js/coops.js",
  "js/dashboard.js",
  "js/undo.js",
  "js/flock.js",
  "js/eggs.js",
  "js/finances.js",
  "js/supply.js",
  "js/init.js",
  "js/pwa.js",
  "js/main.js",
  "vendor/chart.umd.js",
  "vendor/jszip.min.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — always go to the network for live/current data.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Photos are immutable once uploaded (a different photo is always a
  // different filename, never an overwrite), so cache-first is actually
  // correct here, not just acceptable -- there's no staleness risk, and it
  // means anything you've ever viewed while online stays available offline
  // afterward without needing the network again.
  if (url.pathname.startsWith("/photos/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // App shell: network-first. This means a fresh deploy shows up on the very
  // next load whenever you have a connection -- no more waiting on a cache to
  // expire or remembering to bump a version string. The cached copy is only
  // used as a fallback when the network request actually fails (genuinely
  // offline), which is the only time staleness is an acceptable tradeoff.
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});

// ---------------------------------------------------------------------------
// Background Sync: finish queued changes even after the app is closed.
//
// Writes made offline land in the "_outbox" store of the app's IndexedDB. Until
// now they only drained when the app was open and regained connection -- log a
// bird offline, close the app, and the change sat there until you next opened
// it. A sync event lets the browser hand us a moment of runtime once the device
// is back online, so the queue drains on its own.
//
// The auth token lives in localStorage, which a service worker cannot read, so
// the page mirrors it into a tiny separate database ("coopLedgerSwState"). That
// is kept separate from the main app database on purpose: opening the main one
// here never has to know its schema version, so a future migration can't break
// this worker or vice versa.
// ---------------------------------------------------------------------------
const OUTBOX_SYNC_TAG = "coop-outbox";
const SW_STATE_DB = "coopLedgerSwState";
const APP_DB = "coopLedgerLocalDB";

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** Opens a database WITHOUT a version so we never trigger an upgrade, and
 * resolves null if it doesn't exist yet rather than hanging on a blocked open. */
function openDbNoUpgrade(name) {
  return new Promise((resolve) => {
    let settled = false;
    const req = indexedDB.open(name);
    req.onsuccess = () => { settled = true; resolve(req.result); };
    req.onerror = () => { settled = true; resolve(null); };
    req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (_) {} resolve(null); };
    setTimeout(() => { if (!settled) resolve(null); }, 5000);
  });
}

async function swReadAuthToken() {
  const db = await openDbNoUpgrade(SW_STATE_DB);
  if (!db || !db.objectStoreNames.contains("kv")) return "";
  try {
    const row = await idbReq(db.transaction("kv", "readonly").objectStore("kv").get("authToken"));
    return (row && row.value) || "";
  } catch (_) { return ""; }
}

/** Replays one outbox entry against the same endpoints the app uses. Kept in
 * step with pushOutboxOnce() in app.js -- if the op names there change, they
 * must change here too. */
function outboxRequestFor(entry) {
  const base = `/api/${entry.resource}`;
  const json = (body) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  switch (entry.op) {
    case "create": return { url: base, method: "POST", ...json(entry.payload) };
    case "update": return { url: `${base}/${entry.id}`, method: "PUT", ...json(entry.payload) };
    case "delete": return { url: `${base}/${entry.id}`, method: "DELETE" };
    case "bulk-create": return { url: `${base}/bulk-create`, method: "POST", ...json({ items: entry.payload }) };
    case "bulk-delete": return { url: `${base}/bulk-delete-items`, method: "POST", ...json({ ids: entry.payload }) };
    case "bulk-update": return { url: `${base}/bulk-update-items`, method: "POST", ...json({ updates: (entry.payload || []).map(u => ({ id: u.id, fields: u.fields })) }) };
    default: return null;
  }
}

/** Same record the app keeps (see addRejectedChange in js/sync.js), so a change refused
 * while the app was closed still shows up in Settings -> Connection on next open. */
async function swRecordRejected(db, entry, status, detail) {
  if (!db.objectStoreNames.contains("_meta")) return;
  const store = (mode) => db.transaction("_meta", mode).objectStore("_meta");
  const existing = await idbReq(store("readonly").get(REJECTED_KEY));
  const list = existing && Array.isArray(existing.value) ? existing.value : [];
  list.push({ resource: entry.resource, op: entry.op, id: entry.id || null, status, detail, queuedAt: entry.queuedAt || null, at: new Date().toISOString(), payload: entry.payload ?? null });
  await idbReq(store("readwrite").put({ key: REJECTED_KEY, value: list.slice(-MAX_REJECTED_KEPT) }));
}

async function drainOutboxInBackground() {
  const token = await swReadAuthToken();
  if (!token) return; // not signed in on this device -- nothing we may send
  const db = await openDbNoUpgrade(APP_DB);
  if (!db || !db.objectStoreNames.contains("_outbox")) return;

  const entries = await idbReq(db.transaction("_outbox", "readonly").objectStore("_outbox").getAll());
  // Oldest first, and stop at the first failure so ordering is preserved --
  // same contract as the in-app push. Throwing makes the browser retry later.
  entries.sort((a, b) => String(a.queuedAt || "").localeCompare(String(b.queuedAt || "")));
  for (const entry of entries) {
    const spec = outboxRequestFor(entry);
    if (!spec) continue;
    const res = await fetch(spec.url, {
      method: spec.method,
      headers: { ...(spec.headers || {}), "Authorization": `Bearer ${token}` },
      body: spec.body,
    });
    // Same verdicts as the app (js/sync-core.js). This used to delete the entry
    // on ANY non-5xx answer -- including a 401 from an expired token and a 403 --
    // silently throwing the user's change away.
    const verdict = classifyOutboxResponse(entry, res.status);
    if (verdict === "auth" || verdict === "retry") throw new Error(`server ${res.status}`); // keep it queued; the browser retries later
    if (verdict === "reject") {
      let detail = "";
      try { const body = await res.clone().json(); detail = typeof body.detail === "string" ? body.detail : ""; } catch (_) { /* non-JSON error body */ }
      await swRecordRejected(db, entry, res.status, detail);
    }
    const tx = db.transaction("_outbox", "readwrite");
    tx.objectStore("_outbox").delete(entry.outboxId);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  }

  const clientList = await self.clients.matchAll({ type: "window" });
  clientList.forEach(c => c.postMessage({ type: "outbox-drained" }));
}

self.addEventListener("sync", (event) => {
  if (event.tag === OUTBOX_SYNC_TAG) event.waitUntil(drainOutboxInBackground());
});

// Periodic sync is only granted to installed apps with enough engagement, so
// treat it as a bonus: if the browser gives us a slot, drain anything pending.
self.addEventListener("periodicsync", (event) => {
  if (event.tag === OUTBOX_SYNC_TAG) event.waitUntil(drainOutboxInBackground());
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = data.title || "The Coop Ledger";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    // Tag collapses repeats of the same subject into one notification rather
    // than stacking duplicates in the shade.
    tag: data.tag || "coop-ledger",
    renotify: false,
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  // Focus an already-open window instead of opening a second copy.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
