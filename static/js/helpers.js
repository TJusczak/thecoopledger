// Formatting, DOM, toast/modal and photo-upload helpers used everywhere.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ---------- Helpers ----------
/** Formats a Date as YYYY-MM-DD in LOCAL time -- deliberately not
 * toISOString(), which is always UTC and will silently roll a date over to
 * "tomorrow" (or back to "yesterday") for anyone whose local time and UTC
 * fall on different calendar days, which is most of the day for most
 * timezones. Every calendar-date string in the app should go through this,
 * not toISOString().slice(0, 10) -- that pattern is only correct for actual
 * timestamps (updated_at, queuedAt), where UTC is the right, unambiguous
 * choice for cross-device ordering. */
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const todayStr = () => localDateStr(new Date());
const esc = (s) => (s === undefined || s === null) ? "" : String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => !d ? "—" : new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
function fmtBytes(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
const fmtMoney = (n) => `$${(Number(n) || 0).toFixed(2)}`;
/** Splits an amount into the pieces a finance-app-style figure needs:
 * sign, whole dollars (with thousands separators), and cents. Kept
 * separate from fmtMoney so the plain string version still exists for
 * toasts, summaries, and the activity log. */
function fmtMoneyParts(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const dollars = Math.floor(abs);
  const cents = Math.round((abs - dollars) * 100).toString().padStart(2, "0");
  return { sign: v < 0 ? "-" : "", dollars: dollars.toLocaleString(), cents };
}
/** The big right-aligned amount used on finance line items: dollars carry
 * the weight, cents are smaller and dimmer so the figure reads at a glance
 * and the decimal places line up down the column. `dir` ("income" |
 * "expense") sets the +/− prefix and color. */
function moneyFigureHtml(amount, dir) {
  const { dollars, cents } = fmtMoneyParts(amount);
  const income = dir === "income";
  return `<div class="money-figure ${income ? "money-income" : "money-expense"}">`
    + `<span class="money-sign">${income ? "+" : "−"}</span>`
    + `<span class="money-dollars">$${dollars}</span>`
    + `<span class="money-cents">.${cents}</span>`
    + `</div>`;
}

function ageFromDate(dateStr) {
  if (!dateStr) return "Unknown";
  const days = Math.floor((new Date() - new Date(dateStr + "T00:00:00")) / 86400000);
  if (days < 0) return "Not hatched yet";
  if (days < 14) return `${days} day${days !== 1 ? "s" : ""} old`;
  // Weeks through ~4 months (140 days = 20 weeks): meat birds especially are
  // conventionally tracked by week during this stretch (a "1 month old" bird
  // reading as barely 4 weeks was misleading when it was really 7), and it
  // reads naturally for young layers too. Months take over once weekly
  // tracking stops being the useful granularity.
  if (days < 140) { const w = Math.floor(days / 7); return `${w} week${w !== 1 ? "s" : ""} old`; }
  if (days < 730) { const mo = Math.floor(days / 30.44); return `${mo} month${mo !== 1 ? "s" : ""} old`; }
  const y = (days / 365.25).toFixed(1);
  return `${y} year${y !== "1.0" ? "s" : ""} old`;
}
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((new Date() - new Date(dateStr + "T00:00:00")) / 86400000);
}
/** Age phrased relative to a specific date (e.g. when a history photo was
 * taken) rather than always "today" -- same phrasing rules as ageFromDate. */
function ageAtDate(hatchDateStr, atDateStr) {
  if (!hatchDateStr || !atDateStr) return null;
  const days = Math.floor((new Date(atDateStr + "T00:00:00") - new Date(hatchDateStr + "T00:00:00")) / 86400000);
  if (days < 0) return null;
  if (days < 14) return `${days} day${days !== 1 ? "s" : ""} old`;
  // Weeks through ~4 months (140 days = 20 weeks): meat birds especially are
  // conventionally tracked by week during this stretch (a "1 month old" bird
  // reading as barely 4 weeks was misleading when it was really 7), and it
  // reads naturally for young layers too. Months take over once weekly
  // tracking stops being the useful granularity.
  if (days < 140) { const w = Math.floor(days / 7); return `${w} week${w !== 1 ? "s" : ""} old`; }
  if (days < 730) { const mo = Math.floor(days / 30.44); return `${mo} month${mo !== 1 ? "s" : ""} old`; }
  const y = (days / 365.25).toFixed(1);
  return `${y} year${y !== "1.0" ? "s" : ""} old`;
}
const BIRD_STAGES = ["Chick", "Adolescent", "Young Adult", "Adult"];
/** A reasonable starting guess for growth stage, based on age at the photo's
 * date -- always editable by hand afterward, since real development varies
 * by breed and this is just meant to save a click in the common case. */
function suggestStage(hatchDateStr, atDateStr) {
  if (!hatchDateStr || !atDateStr) return "";
  const days = Math.floor((new Date(atDateStr + "T00:00:00") - new Date(hatchDateStr + "T00:00:00")) / 86400000);
  if (days < 0) return "";
  if (days <= 56) return "Chick";        // 0-8 weeks
  if (days <= 140) return "Adolescent";  // 8-20 weeks
  if (days <= 365) return "Young Adult"; // 20 weeks-1 year
  return "Adult";
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr + "T00:00:00") - new Date()) / 86400000);
}
function harvestCountdownHtml(targetDate, extraClass = "") {
  const d = daysUntil(targetDate);
  if (d === null) return "";
  if (d < 0) return `<span class="stamp tone-danger ${extraClass}">Harvest overdue ${-d}d</span>`;
  if (d === 0) return `<span class="stamp tone-danger ${extraClass}">Harvest today</span>`;
  if (d <= 7) return `<span class="stamp tone-gold ${extraClass}">Harvest in ${d}d</span>`;
  return `<span class="stamp tone-slate ${extraClass}">Harvest in ${d}d</span>`;
}
function withinRange(dateStr, days) {
  if (!days) return true;
  return (new Date() - new Date(dateStr + "T00:00:00")) / 86400000 <= days;
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}
async function resizeImageFileToBlob(file, maxDim, quality) {
  if (maxDim === undefined || quality === undefined) {
    const tier = PHOTO_QUALITY_TIERS[getPhotoQualityTier()];
    if (maxDim === undefined) maxDim = tier.maxDim;
    if (quality === undefined) quality = tier.quality;
  }
  // Phone cameras store photos with an EXIF orientation tag rather than
  // physically rotating the pixel data -- drawing that straight to a canvas
  // (the old approach here) ignores that tag and can leave the photo sideways
  // or upside down. createImageBitmap with imageOrientation:"from-image"
  // decodes the pixels already rotated the correct way, so the canvas we draw
  // from is right-side-up regardless of how the camera saved it.
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    // Older browsers without the option overload -- falls back to default
    // decoding, which is how this worked before (may not auto-rotate).
    bitmap = await createImageBitmap(file);
  }
  let w = bitmap.width, h = bitmap.height;
  if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
  else if (h >= w && h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}
async function apiUploadPhoto(id, blob, resource = "birds") {
  const fd = new FormData();
  fd.append("file", blob, "photo.jpg");
  const res = await fetch(apiUrl(`/api/${resource}/${id}/photo`), { method: "POST", headers: authHeaders(), body: fd });
  if (!res.ok) throw new Error(`Photo upload failed (${res.status})`);
  return res.json();
}
