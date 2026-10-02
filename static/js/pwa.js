// Service worker, update checks, install prompt, push-notification opt-in.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)


if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // Carry any session that predates this build into the worker-readable
      // store, so Background Sync works without waiting for the next sign-in.
      if (getAuthToken()) mirrorTokenForServiceWorker(getAuthToken());
      // Nudge the queue whenever a worker is ready, in case changes were left
      // behind by a previous session that closed while offline.
      requestBackgroundOutboxSync();
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
  // The check below compares this page's own address against itself --
  // meaningful only when that's also where synced data comes from. If a
  // different server is configured (e.g. the app was opened from
  // thecoopledger.com but points at a self-hosted server for sync), an
  // "update available" here would only reflect thecoopledger.com's own
  // code, not the actual server this device talks to -- misleading rather
  // than useful, since reloading could pair newer frontend code with an
  // older backend that doesn't support it yet.
  const serverUrl = getServerUrl();
  if (serverUrl && serverUrl !== window.location.origin) {
    if (manual) showToast("This app was opened from a different address than the server you're syncing with, so this check isn't meaningful here. Open the app directly from your server's own address for a reliable check -- frontend and backend always ship together there.", "delete");
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
    <div><img src="${LOGO_INLINE}" alt="" width="18" height="18" style="border-radius:4px;vertical-align:-4px"> Install The Coop Ledger for the full app experience</div>
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

// ---------------------------------------------------------------------------
// Push notification opt-in
//
// Two separate gates, deliberately: the browser's own permission prompt, and
// per-category switches in Settings. Turning every category off unsubscribes
// the device entirely rather than leaving a live subscription that receives
// nothing -- so "off" really means the server stops holding a channel to this
// phone. Android's own app notification settings remain the final say, and
// revoking there simply stops delivery.
// ---------------------------------------------------------------------------
const PUSH_PREF_KEY = "coopLedgerPushPrefs";
const PUSH_CATEGORIES = [
  { key: "bedding", label: "Bedding due for a clean-out", emoji: "🍂" },
  { key: "hatch", label: "Hatch milestones (lockdown, hatch day)", emoji: "🐣" },
  { key: "supplies", label: "Feed running low", emoji: "🌾" },
];

function getPushPrefs() {
  try { return { bedding: true, hatch: true, supplies: true, ...JSON.parse(localStorage.getItem(PUSH_PREF_KEY) || "{}") }; }
  catch (_) { return { bedding: true, hatch: true, supplies: true }; }
}
function setPushPrefs(prefs) { localStorage.setItem(PUSH_PREF_KEY, JSON.stringify(prefs)); }

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** base64url VAPID key -> the Uint8Array the PushManager expects. */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function getPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Asks permission if needed, subscribes, and registers with the server.
 *
 * Each step is labelled, because they fail for completely different reasons and
 * a bare "Failed to fetch" doesn't say whether the server was unreachable, the
 * push service refused, or the browser blocked us. The step name is what makes
 * the toast actionable.
 */
async function enablePushNotifications() {
  if (!pushSupported()) throw new Error("This browser doesn't support push notifications.");
  const step = async (label, fn) => {
    try { return await fn(); }
    catch (e) {
      const raw = (e && (e.detail || e.message)) || String(e);
      const err = new Error(`${label}: ${raw}`);
      err.step = label;
      err.cause = e;
      console.error(`[push] ${label} failed`, e);
      throw err;
    }
  };

  const permission = await step("Permission", () => Notification.requestPermission());
  if (permission !== "granted") {
    throw new Error(permission === "denied"
      ? "Notifications are blocked for this site. Re-allow them in your browser or Android app settings."
      : "Notification permission wasn't granted.");
  }

  const keyUrl = apiUrl("/api/push/public-key");
  const res = await step(`Reaching server (${keyUrl})`, () => apiGet("/api/push/public-key"));
  const public_key = res && res.public_key;
  if (!public_key) throw new Error("The server didn't return a push key -- is pywebpush installed?");

  const reg = await step("Service worker", async () => {
    const r = await navigator.serviceWorker.ready;
    if (!r || !r.pushManager) throw new Error("no pushManager on the registration");
    return r;
  });

  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // A subscription made against a different VAPID key can't be reused --
    // the server would be unable to sign for it. Drop and re-create.
    const existingKey = sub.options && sub.options.applicationServerKey;
    const sameKey = existingKey && btoa(String.fromCharCode(...new Uint8Array(existingKey)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === public_key;
    if (!sameKey) { try { await sub.unsubscribe(); } catch (_) {} sub = null; }
  }
  if (!sub) {
    sub = await step("Push service", () => reg.pushManager.subscribe({
      userVisibleOnly: true, // required by Chrome: every push must show a notification
      applicationServerKey: urlBase64ToUint8Array(public_key),
    }));
  }

  await step("Saving subscription", () => apiPost("/api/push/subscribe", { subscription: sub.toJSON(), prefs: getPushPrefs() }));
  return true;
}

/** Drops the subscription both locally and on the server, so nothing is left
 * pointing at this device. */
async function disablePushNotifications() {
  const sub = await getPushSubscription();
  if (!sub) return;
  try { await apiPost("/api/push/unsubscribe", { endpoint: sub.endpoint }); } catch (_) {}
  try { await sub.unsubscribe(); } catch (_) {}
}

/** Re-sends the current category choices for an already-subscribed device. */
async function syncPushPrefs() {
  const sub = await getPushSubscription();
  if (!sub) return;
  await apiPost("/api/push/subscribe", { subscription: sub.toJSON(), prefs: getPushPrefs() });
}
