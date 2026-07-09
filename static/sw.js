const CACHE_NAME = "coop-ledger-shell-v4";
const SHELL_ASSETS = [
  "/",
  "/style.css",
  "/app.js",
  "/vendor/chart.umd.js",
  "/vendor/jszip.min.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
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
