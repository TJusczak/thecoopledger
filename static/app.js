// ---------- Build identity ----------
// Loaded first. The rest of the app lives in js/ (see index.html for load order).
// Bump this with any meaningful change and check it in Settings -> App
// -- if this number doesn't match what you expect after a redeploy, the
// browser/CDN/service worker is serving stale files, not a code bug.
const APP_VERSION = "2026.10.02-249";
// Substituted at build time by each pipeline (see docker-publish.yml and
// the "Choosing a release channel" section of the README) -- left as the
// literal placeholder if something builds from source without going
// through either pipeline, which intentionally falls through to the
// "beta" case below rather than "stable": better to over-show the
// caution badge than silently hide it on an unverified build.
const BUILD_CHANNEL = "__BUILD_CHANNEL__";
const IS_BETA_BUILD = BUILD_CHANNEL !== "stable";
const LOGO_INLINE = IS_BETA_BUILD ? "logo-inline-beta.png" : "logo-inline.png";
// The sticky header's logo is static markup in index.html (not generated
// by this script), so it needs its src swapped directly rather than
// picking up LOGO_INLINE automatically the way freshly-rendered HTML does.
document.querySelectorAll('.sticky-header-title img').forEach(img => { img.src = LOGO_INLINE; });
// Same story for the favicon / apple-touch icon / manifest: they're
// referenced in the <head> before this script runs, and hardcoded to the
// stable icons. On a beta build, swap them to the -beta variants so the
// browser tab, the installed-app icon, and the "add to home screen"
// preview all carry the beta mark instead of looking identical to stable.
if (IS_BETA_BUILD) {
  const fav = document.getElementById("faviconLink");
  const apple = document.getElementById("appleTouchIcon");
  if (fav) fav.href = "icon-192-beta.png";
  if (apple) apple.href = "icon-192-beta.png";
  // The manifest is fetched independently by the browser, so pointing it at
  // a beta-specific file is the only way its icons (used for the installed
  // PWA) pick up the beta mark.
  const mani = document.querySelector('link[rel="manifest"]');
  if (mani) mani.href = "manifest-beta.json";
}
