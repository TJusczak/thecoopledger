// Overview dashboard: stats, feed engine, charts, alerts.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= DASHBOARD =================
/** Feed and bedding "used" is measured from supplies that hit Empty within a
 * date range -- a bag going empty is the closest thing to a real
 * consumption-completed event the data has (as opposed to purchase date,
 * which only tells you when something was bought, not when it ran out).
 * A bag bought in one period and finished in a later one attributes its
 * full quantity to whichever period it was actually finished in. */
function feedBeddingUsageInRange(supplies, days) {
  const emptied = supplies.filter(s => s.date_emptied && withinRange(s.date_emptied, days));
  const sumFor = (cat) => emptied.filter(s => s.category === cat).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  // Bags that are open right now but not yet fully emptied contribute their
  // partial consumption too -- otherwise feed genuinely being eaten from an
  // open bag would show as zero "used" until someone finally drags the
  // status slider all the way down, which could lag reality by weeks.
  const activeSum = (cat) => supplies.filter(s => s.category === cat && !s.date_emptied)
    .reduce((sum, s) => sum + (Number(s.quantity) || 0) * (STATUS_USED_FRACTION[s.status] ?? 0), 0);
  return {
    layerFeedLbs: sumFor("Layer Feed") + activeSum("Layer Feed"),
    meatFeedLbs: sumFor("Meat Feed") + activeSum("Meat Feed"),
    beddingCuFt: sumFor("Bedding") + activeSum("Bedding"),
  };
}
/** Same idea, but a running cumulative total rather than a per-bucket sum --
 * feed/bedding usage is inherently sporadic (a bag can sit at Full for
 * weeks and then suddenly get marked Empty), so summing per-bucket would
 * mostly show zero with occasional spikes, which reads as "nothing's being
 * used" during the gaps even though birds are eating from it the whole
 * time. A running total that steps up on each real event and holds flat
 * between them is the honest picture -- same pattern as the existing
 * cumulative meat chart, which has the identical sporadic-event shape. */
const STATUS_USED_FRACTION = { "Full": 0, "3/4": 0.25, "1/2": 0.5, "1/4": 0.75, "Empty": 1 };

// ---- Monthly daily-series helpers (dashboard month view) ----
// The dashboard shows one calendar month at a time, broken down by day, with
// an optional dotted overlay of another month for comparison. Everything here
// returns a per-day array of length = days-in-month, indexed day 1..N, so two
// months of different lengths still overlay cleanly (a 30-day month just has
// no day-31 point). These are PER-DAY amounts (not cumulative) -- "how much
// that day" -- which is the honest shape for a month view, unlike the
// ever-rising cumulative charts that belong on the All-Time page.

function daysInMonthKey(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0).getDate(); // day 0 of next month = last day of this one
}
/** "2026-07-05" -> day-of-month index 5 if it's in `key`, else -1. */
function dayInMonth(dateStr, key) {
  return (dateStr && dateStr.slice(0, 7) === key) ? Number(dateStr.slice(8, 10)) : -1;
}

/** Eggs collected per day for a month. */
function eggsDailyForMonth(key) {
  const arr = Array(daysInMonthKey(key)).fill(0);
  STATE.eggs.forEach(e => { const d = dayInMonth(e.date, key); if (d > 0) arr[d - 1] += Number(e.count) || 0; });
  return arr;
}

/** Total spend per day for a month (expenses only, not income). */
function spendDailyForMonth(key, categories) {
  // categories: null/empty Set means "all"; otherwise a Set of category
  // names to include -- lets the money chart's pills be multi-select.
  const arr = Array(daysInMonthKey(key)).fill(0);
  const filterActive = categories && categories.size > 0;
  STATE.expenses.forEach(x => {
    if (x.entry_type === "income") return;
    if (filterActive && !categories.has(x.category)) return;
    const d = dayInMonth(x.date, key);
    if (d > 0) arr[d - 1] += Number(x.amount) || 0;
  });
  return arr;
}

/** Dressed weight (lb) processed per day for a month, by harvest date. */
function meatDailyForMonth(key) {
  const arr = Array(daysInMonthKey(key)).fill(0);
  STATE.birds.forEach(b => {
    if (b.status !== "Processed" || !b.harvest_date) return;
    const d = dayInMonth(b.harvest_date, key);
    if (d > 0) arr[d - 1] += Number(b.harvest_weight) || 0;
  });
  return arr;
}
/** Count of birds processed in a month (for the "N birds -> X lb" readout). */
function birdsProcessedInMonth(key) {
  return STATE.birds.filter(b => b.status === "Processed" && b.harvest_date && monthKeyOf(b.harvest_date) === key).length;
}

// ---- Money mega-chart series (spend / income / net, per day of a month) ----
// Income "value" model: egg value = eggs collected x price; meat value =
// dressed weight x price; plus other income entries (bird sales, etc.). Egg/
// meat SALE income entries are excluded because that money is already captured
// in egg/meat value -- selling an egg doesn't add value beyond having produced
// it. This makes "income" a clean "what the operation produced/earned."

/** Egg value produced per day in a month (count x price on collection days). */
function eggValueDailyForMonth(key) {
  const arr = Array(daysInMonthKey(key)).fill(0);
  const eggFallback = Number(getCoopDefaults().eggPrice) || 0;
  STATE.eggs.forEach(e => { const dm = dayInMonth(e.date, key); if (dm > 0) arr[dm - 1] += (Number(e.count) || 0) * (Number(e.price_per_egg) || eggFallback); });
  return arr;
}
/** Meat value produced per day in a month (weight x price on harvest days). */
function meatValueDailyForMonth(key) {
  const arr = Array(daysInMonthKey(key)).fill(0);
  const meatFallback = Number(getCoopDefaults().pricePerLb) || 0;
  STATE.birds.forEach(b => {
    if (b.status !== "Processed" || !b.harvest_date) return;
    const dm = dayInMonth(b.harvest_date, key);
    if (dm > 0) arr[dm - 1] += (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || meatFallback);
  });
  return arr;
}
/** Other-income (non egg/meat sale) per day for a month, filtered to a Set
 * of categories (or null/empty Set for all). */
function otherIncomeDailyForMonth(key, categories) {
  const arr = Array(daysInMonthKey(key)).fill(0);
  const filterActive = categories && categories.size > 0;
  STATE.expenses.forEach(x => {
    if (x.entry_type !== "income") return;
    if (x.category === "Egg Sale" || x.category === "Meat Sale") return; // already in egg/meat value
    if (filterActive && !categories.has(x.category)) return;
    const dm = dayInMonth(x.date, key);
    if (dm > 0) arr[dm - 1] += Number(x.amount) || 0;
  });
  return arr;
}

/** Total income value per day for a month, optionally filtered to a Set of
 * sources ("Egg value", "Meat value", and/or other-income categories). An
 * empty/null Set means all sources combined. */
function incomeDailyForMonth(key, sources) {
  const n = daysInMonthKey(key);
  const wantAll = !sources || sources.size === 0;
  const egg = (wantAll || sources.has("Egg value")) ? eggValueDailyForMonth(key) : Array(n).fill(0);
  const meat = (wantAll || sources.has("Meat value")) ? meatValueDailyForMonth(key) : Array(n).fill(0);
  // "Egg value"/"Meat value" are synthetic source names, not real expense
  // categories, so passing the Set straight through here is safe -- they
  // simply never match any real x.category and are harmlessly ignored.
  const other = otherIncomeDailyForMonth(key, wantAll ? null : sources);
  return Array.from({ length: n }, (_, i) => egg[i] + meat[i] + other[i]);
}

/** Income sources present (for the income-mode pills): egg/meat value if any
 * eggs/meat exist, plus each non-sale income category actually logged. */
function incomeSourcesPresent() {
  const out = [];
  if (STATE.eggs.some(e => (Number(e.count) || 0) > 0)) out.push("Egg value");
  if (STATE.birds.some(b => b.status === "Processed" && b.harvest_date)) out.push("Meat value");
  const cats = new Set();
  STATE.expenses.forEach(x => { if (x.entry_type === "income" && x.category && x.category !== "Egg Sale" && x.category !== "Meat Sale") cats.add(x.category); });
  INCOME_CATEGORIES.forEach(c => { if (cats.has(c)) out.push(c); });
  return out;
}

/** Icon spec for an income source (for pills), matching value-source bars. */
function incomeSourceIcon(source) {
  if (source === "Egg value") return BIRD_TYPE_ICONS.layer;
  if (source === "Meat value") return BIRD_TYPE_ICONS.meat;
  return INCOME_ICONS[source] || INCOME_ICONS["Other Income"];
}

/** Cumulative feed used (lb) through each day of a month -- a running total,
 * not a per-day amount. Feed usage is estimated from bag open/empty dates, so
 * a per-day line drops to 0 between bags and reads as "no feed used" even
 * though birds are eating the whole time. A within-month running total climbs
 * on consumption and holds flat between it, which is the honest shape.
 *
 * Emptied bags contribute their open->emptied ramp (spread across the days
 * they were in use). A bag that's currently OPEN but not yet emptied has no
 * per-day history -- we only know how much is gone RIGHT NOW (its status
 * slider) -- so its used portion is added as a single step on today's date,
 * the only date we can honestly attribute it to. That's also what makes a
 * "used 3/4 of a bag this month" case actually show up, instead of staying
 * invisible until the bag is finally marked empty. */
/** How a bag's consumption is spread over time: {start, spanDays, perDay}, or
 * null if nothing has been consumed yet.
 *
 * Birds eat a bit every day, so a bag's contents are spread evenly across the
 * days it was actually in use -- never dumped on a single date.
 *  - EMPTIED bag: its full quantity spread over opened_at -> date_emptied.
 *  - OPEN bag: the portion used so far (from its status) spread over
 *    opened_at -> today. This is the honest reading: if you opened a bag on
 *    the 15th and marked it 3/4 full on the 18th, that quarter was eaten
 *    across those four days, not all at once on the 18th.
 * A bag with no opened_at can only be attributed to a single day (the emptied
 * date, or today for an open bag), since there's no window to spread over. */
function bagRamp(s, today) {
  const qty = Number(s.quantity) || 0;
  if (!(qty > 0)) return null;
  if (s.date_emptied) {
    const end = s.date_emptied;
    const start = s.opened_at && s.opened_at < end ? s.opened_at : null;
    if (!start) return { start: end, spanDays: 1, perDay: qty };
    // The window is HALF-OPEN: [opened_at, date_emptied). The emptied date is
    // when the bag was recorded gone, so the feed was eaten on the days
    // leading up to it. Counting that day too would double up with a
    // replacement bag opened the same day -- the handoff day would show two
    // full rations (one from each bag) and spike the chart.
    const diff = Math.round((new Date(end + "T00:00:00") - new Date(start + "T00:00:00")) / 86400000);
    const spanDays = Math.max(1, diff); // opened and emptied same day -> one day
    return { start, spanDays, perDay: qty / spanDays };
  }
  const usedNow = qty * (STATUS_USED_FRACTION[s.status] ?? 0);
  if (!(usedNow > 0)) return null; // still full -- nothing eaten yet
  const start = s.opened_at && s.opened_at < today ? s.opened_at : null;
  if (!start) return { start: today, spanDays: 1, perDay: usedNow };
  const spanDays = Math.round((new Date(today + "T00:00:00") - new Date(start + "T00:00:00")) / 86400000) + 1;
  return { start, spanDays, perDay: usedNow / spanDays };
}

function feedCumulativeForMonth(key, feedType = "both") {
  const n = daysInMonthKey(key);
  const perDay = Array(n).fill(0);
  const today = todayStr();
  const cats = feedType === "layer" ? ["Layer Feed"] : feedType === "meat" ? ["Meat Feed"] : ["Layer Feed", "Meat Feed"];
  STATE.supplies.filter(s => cats.includes(s.category)).forEach(s => {
    const ramp = bagRamp(s, today);
    if (!ramp) return;
    for (let i = 0; i < ramp.spanDays; i++) {
      const d = dayInMonth(addDays(ramp.start, i), key);
      if (d > 0) perDay[d - 1] += ramp.perDay;
    }
  });
  // Turn per-day into a within-month running total.
  let run = 0;
  return perDay.map(v => (run += v));
}

/** Ranked proportion bars with icons -- shared by spend and income breakdowns
 * on the All-Time and Year Review pages. `rows` is [{label, amount, emoji,
 * from, to}] (already the caller's choice of icon/colors); renders highest
 * first with a percent, a gradient bar, and a grand total. */
function proportionBarsHtml(rows, { title, totalLabel, bare = false }) {
  const entries = rows.filter(r => r.amount > 0).sort((a, b) => b.amount - a.amount);
  const wrap = (inner) => bare ? `<div class="bars-bare">${inner}</div>` : `<div class="card">${inner}</div>`;
  if (!entries.length) return wrap(`<div class="card-title">${esc(title)}</div><div class="empty">Nothing logged.</div>`);
  const grand = entries.reduce((sum, r) => sum + r.amount, 0);
  return wrap(`
    <div class="card-title" style="margin-bottom:10px">${esc(title)}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${entries.map(r => {
        const pct = grand > 0 ? (r.amount / grand) * 100 : 0;
        return `<div class="cat-bar-row">
          <div class="cat-bar-head">
            <span class="cat-bar-label">${r.emoji} ${esc(r.label)}</span>
            <span class="cat-bar-amt">${fmtMoney(r.amount)} <span class="dim">(${pct.toFixed(0)}%)</span></span>
          </div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct.toFixed(1)}%;background:linear-gradient(90deg, ${r.from}, ${r.to})"></div></div>
        </div>`;
      }).join("")}
    </div>
    <div class="cat-bar-total">${esc(totalLabel)}: <strong>${fmtMoney(grand)}</strong></div>`);
}

/** Spend-by-category bars (wraps proportionBarsHtml with category icons). */
function spendCategoryBarsHtml(catTotals, opts) {
  const rows = Object.entries(catTotals).map(([cat, amt]) => {
    const spec = CATEGORY_ICONS[cat] || CATEGORY_ICONS["Other"];
    return { label: cat, amount: amt, emoji: spec.emoji, from: spec.from, to: spec.to };
  });
  return proportionBarsHtml(rows, opts);
}

/** Value-by-source bars: egg value + meat value (estimated, at their prices)
 * plus any other income categories (bird sales, other income) actually logged.
 * Answers "where does my value come from," mirroring the spend breakdown. */
function valueSourceBarsHtml({ eggValue, meatValue, otherIncomeByCat }, opts) {
  const rows = [
    { label: "Egg value", amount: eggValue || 0, emoji: BIRD_TYPE_ICONS.layer.emoji, from: BIRD_TYPE_ICONS.layer.from, to: BIRD_TYPE_ICONS.layer.to },
    { label: "Meat value", amount: meatValue || 0, emoji: BIRD_TYPE_ICONS.meat.emoji, from: BIRD_TYPE_ICONS.meat.from, to: BIRD_TYPE_ICONS.meat.to },
  ];
  Object.entries(otherIncomeByCat || {}).forEach(([cat, amt]) => {
    const spec = INCOME_ICONS[cat] || INCOME_ICONS["Other Income"];
    rows.push({ label: cat, amount: amt, emoji: spec.emoji, from: spec.from, to: spec.to });
  });
  return proportionBarsHtml(rows, opts);
}

/** Value-by-source breakdown for a date window: estimated egg value, estimated
 * meat value, and actual "other" income (bird sales, other income) logged.
 * Egg/meat sale income is NOT added separately -- it's already reflected in the
 * egg/meat value estimates, so counting it again would double it. */
function valueBreakdownIn(inWindow) {
  const d = getCoopDefaults();
  const eggFallback = Number(d.eggPrice) || 0, meatFallback = Number(d.pricePerLb) || 0;
  let eggValue = 0, meatValue = 0;
  STATE.eggs.forEach(e => { if (inWindow(e.date)) eggValue += (Number(e.count) || 0) * (Number(e.price_per_egg) || eggFallback); });
  STATE.birds.forEach(b => {
    if (b.status === "Processed" && b.harvest_date && inWindow(b.harvest_date)) {
      meatValue += (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || meatFallback);
    }
  });
  const otherIncomeByCat = {};
  STATE.expenses.forEach(x => {
    if (x.entry_type !== "income" || !inWindow(x.date)) return;
    // Egg/meat sales already counted in the value estimates above; only the
    // OTHER income categories (bird sales, misc) add new value here.
    if (x.category === "Egg Sale" || x.category === "Meat Sale") return;
    const cat = x.category || "Other Income";
    otherIncomeByCat[cat] = (otherIncomeByCat[cat] || 0) + (Number(x.amount) || 0);
  });
  return { eggValue, meatValue, otherIncomeByCat };
}

/** {category: dollars} of expenses in a month, for the dashboard breakdown. */
function spendCatTotalsForMonth(key) {
  const totals = {};
  STATE.expenses.forEach(x => {
    if (x.entry_type === "income" || monthKeyOf(x.date) !== key) return;
    const cat = x.category || "Other";
    totals[cat] = (totals[cat] || 0) + (Number(x.amount) || 0);
  });
  return totals;
}

/** Spend categories that actually have expenses, for the category pill picker. */
function spendCategoriesPresent() {
  const set = new Set();
  STATE.expenses.forEach(x => { if (x.entry_type !== "income" && x.category) set.add(x.category); });
  return EXPENSE_CATEGORIES.filter(c => set.has(c));
}

/** How many days of a month have actually elapsed -- the full month for a past
 * month, days-so-far for the current month. Used as the honest denominator for
 * "average per day" (dividing this month's eggs by 31 on the 5th would lie). */
function elapsedDaysInMonth(key) {
  const today = todayStr();
  if (key === monthKeyOf(today)) return Number(today.slice(8, 10)); // day-of-month so far
  if (key > monthKeyOf(today)) return 0; // a future month hasn't started
  return daysInMonthKey(key); // a past month is fully elapsed
}

/** Average eggs per day for a month (total ÷ elapsed days). */
function avgEggsPerDay(key) {
  const total = sum(eggsDailyForMonth(key));
  const days = elapsedDaysInMonth(key);
  return days > 0 ? total / days : 0;
}

/** Lbs of a single feed bag consumed within a date window, using the same
 * open->emptied ramp the charts use. `inWindow(dateStr)` decides which days
 * count -- pass a month test, a year test, or `() => true` for all-time. */
function feedBagLbsUsed(s, inWindow) {
  const ramp = bagRamp(s, todayStr());
  if (!ramp) return 0;
  let lbs = 0;
  for (let i = 0; i < ramp.spanDays; i++) if (inWindow(addDays(ramp.start, i))) lbs += ramp.perDay;
  return lbs;
}

/** Cost of the feed of one category actually EATEN in a window, and the priced
 * lbs behind it. Only bags with a real cost contribute dollars (and only their
 * lbs count toward the priced total), so the figure is honest about what it
 * knows -- unpriced feed is excluded rather than guessed. */
function pricedFeedConsumed(category, inWindow) {
  let cost = 0, lbs = 0;
  STATE.supplies.filter(s => s.category === category).forEach(s => {
    const qty = Number(s.quantity) || 0;
    const c = Number(s.cost);
    if (!(qty > 0) || !(c > 0)) return;
    const used = feedBagLbsUsed(s, inWindow);
    if (used > 0) { cost += used * (c / qty); lbs += used; }
  });
  return { cost, lbs };
}

/** True layer-feed cost per dozen eggs in a window: cost of layer feed eaten
 * (each bag's lbs x its real cost/lb) / dozens collected. Null when there's no
 * priced feed eaten or no eggs -- never a misleading 0. */
/** The two headline feed-cost figures -- layer cost per dozen eggs and meat
 * feed cost per lb of meat -- rendered as a prominent pair of cards. These
 * live only on Year Review and All-Time: over a year or the whole history they
 * give a true cost-to-produce, whereas a single month is misleading (meat
 * birds eat for months then get harvested in one, so a monthly meat cost/lb
 * swings wildly). `scopeLabel` is appended to each caption (e.g. a year or
 * "all time"). Returns "" when neither figure has data. */
// Stashed by the most recent feedCostHeadlineHtml() render, read by the
// audit-modal click handler below. Only one of these cards is ever visible
// at a time (Year Review and All-Time are different tabs), so "last
// rendered" is all the state this needs -- no per-instance ids required.
let lastCostBreakdowns = { dozen: null, meat: null, scopeLabel: "" };

function feedCostHeadlineHtml(dozenBreakdown, meatBreakdown, scopeLabel) {
  const cpDozen = dozenBreakdown ? dozenBreakdown.result : null;
  const cpLbMeat = meatBreakdown ? meatBreakdown.result : null;
  if (cpDozen == null && cpLbMeat == null) return "";
  lastCostBreakdowns = { dozen: dozenBreakdown, meat: meatBreakdown, scopeLabel };
  const scope = scopeLabel ? ` <span class="dim" style="font-weight:400">· ${esc(scopeLabel)}</span>` : "";
  const card = (kind, emoji, from, to, value, caption) => `
    <div class="cost-headline cost-headline-tappable" data-cost-breakdown="${kind}" role="button" tabindex="0" title="See how this number was calculated">
      <div class="cost-headline-icon" style="background:linear-gradient(135deg, ${from}, ${to})">${emoji}</div>
      <div class="cost-headline-body">
        <div class="cost-headline-value">${value}</div>
        <div class="cost-headline-caption">${caption}${scope}</div>
      </div>
      <div class="cost-headline-peek" title="Tap to see the numbers behind this">🔍</div>
    </div>`;
  const cards = [];
  if (cpDozen != null) cards.push(card("dozen", BIRD_TYPE_ICONS.layer.emoji, BIRD_TYPE_ICONS.layer.from, BIRD_TYPE_ICONS.layer.to, `${fmtMoney(cpDozen)}<span class="cost-headline-unit">/dozen eggs</span>`, "Feed + supplement cost to produce eggs"));
  if (cpLbMeat != null) cards.push(card("meat", BIRD_TYPE_ICONS.meat.emoji, BIRD_TYPE_ICONS.meat.from, BIRD_TYPE_ICONS.meat.to, `${fmtMoney(displayPricePerLb(cpLbMeat))}<span class="cost-headline-unit">/${getWeightUnit()} meat</span>`, "Feed + chick cost to produce meat"));
  return `<div class="cost-headline-grid">${cards.join("")}</div>`;
}

/** Full breakdown behind the cost-per-dozen figure -- every number that went
 * into it, not just the result, for the "peek behind the curtain" audit
 * modal. costPerDozenIn is a thin wrapper around this so the modal can never
 * show different math than what actually produced the headline number. */
function costPerDozenBreakdown(eggCount, inWindow) {
  const { cost: feedCost, lbs: feedLbs } = pricedFeedConsumed("Layer Feed", inWindow);
  // Layer supplements (oyster shell, grit) are things ONLY layers ingest that
  // help produce eggs, so they belong in cost-per-egg. Unlike feed they're not
  // consumption-tracked (no bags/ramp) -- we just use the expenses in the
  // window, which the user opted into for simplicity. Bedding, treats, and
  // shelter costs are deliberately excluded: bedding/building are shelter, and
  // treats get shared with meat birds, so neither cleanly attributes to eggs.
  const supplementExpenses = STATE.expenses.filter(x => x.entry_type !== "income" && x.category === "Layer Supplements" && inWindow(x.date));
  const supplementCost = supplementExpenses.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const dozens = eggCount / 12;
  // Need at least priced feed consumed to anchor the figure; supplements add
  // on top. (Supplements alone, with no feed cost data, would be an odd
  // partial.)
  const result = (eggCount > 0 && feedLbs > 0) ? (feedCost + supplementCost) / dozens : null;
  return { eggCount, dozens, feedLbs, feedCost, supplementCost, supplementExpenses, result };
}
function costPerDozenIn(eggCount, inWindow) {
  return costPerDozenBreakdown(eggCount, inWindow).result;
}

/** Full breakdown behind the cost-per-lb-meat figure -- every number that
 * went into it (feed, and each contributing bird's own acquisition cost),
 * for the audit modal. costPerLbMeatIn is a thin wrapper around this, same
 * reasoning as costPerDozenIn above. */
/** Groups a flat list of birds by batch_name, for a scannable "N batches"
 * summary instead of a flat wall of individual rows -- All-Time especially
 * could have hundreds of contributing birds across years of batches, and a
 * flat list that long isn't really auditable, just a long scroll. Birds with
 * no batch (added individually) are bucketed together under one heading.
 * Sorted biggest-cost-first, since that's the natural order for spot-
 * checking a total: the largest contributors are the most worth verifying. */
function groupBirdsByBatch(birds) {
  const groups = new Map();
  birds.forEach(b => {
    const key = b.batch_name || "__none__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  });
  return [...groups.entries()].map(([key, groupBirds]) => ({
    batchName: key === "__none__" ? null : key,
    birds: groupBirds,
    processedCount: groupBirds.filter(b => b.status === "Processed").length,
    deceasedCount: groupBirds.filter(b => b.status === "Deceased").length,
    totalCost: groupBirds.reduce((s, b) => s + (Number(b.acquisition_cost) || 0), 0),
  })).sort((a, b) => b.totalCost - a.totalCost);
}

function costPerLbMeatBreakdown(meatWeightLb, inWindow) {
  const { cost: feedCost, lbs: feedLbs } = pricedFeedConsumed("Meat Feed", inWindow);
  // A bird that died before reaching slaughter weight still cost what it
  // cost -- that money didn't come back. Leaving mortality out would
  // understate the true cost of the meat that DID make it: if 3 of 25 chicks
  // die, the survivors' meat is what that batch's money actually bought, and
  // true cost-per-lb has to carry the loss, not pretend it didn't happen.
  // Gated on death_date the same way a processed bird is gated on
  // harvest_date -- the loss belongs to whichever period it happened in.
  // Restricted to Meat/Dual Purpose types: a dead Layer was never headed for
  // the table, so its loss has nothing to do with the cost of meat. No
  // double-counting risk either way -- a bird is never both Processed and
  // Deceased at once.
  const contributingBirds = STATE.birds.filter(b => (
    (b.status === "Processed" && b.harvest_date && inWindow(b.harvest_date)) ||
    (b.status === "Deceased" && (b.type === "Meat" || b.type === "Dual Purpose") && b.death_date && inWindow(b.death_date))
  ));
  const chickCost = contributingBirds.reduce((s, b) => s + (Number(b.acquisition_cost) || 0), 0);
  const processedBirds = contributingBirds.filter(b => b.status === "Processed");
  const deceasedBirds = contributingBirds.filter(b => b.status === "Deceased");
  const result = (meatWeightLb > 0 && feedLbs > 0) ? (feedCost + chickCost) / meatWeightLb : null;
  return { meatWeightLb, feedLbs, feedCost, chickCost, processedBirds, deceasedBirds, result };
}
function costPerLbMeatIn(meatWeightLb, inWindow) {
  return costPerLbMeatBreakdown(meatWeightLb, inWindow).result;
}

/** "Peek behind the curtain" for a cost-headline card: every number that
 * went into the figure, laid out as a plain worked calculation -- the exact
 * same values costPerDozenBreakdown/costPerLbMeatBreakdown computed, so this
 * can never show something that doesn't match the headline it explains. */
/** Cost, weight, and value as three equally-weighted chips, not one primary
 * number with the others as an afterthought -- used for both an individual
 * bird's row and a batch's totals, so the two read the same way at a glance.
 * weightText/valueText are pre-formatted ("—" for a bird that never got
 * processed, since a literal $0.00 would misleadingly look like a real
 * recorded zero rather than "this never happened"). compact shrinks the
 * chips for the batch-summary use, which sits inside a <summary> alongside
 * the batch name and needs to stay lower-profile than a full bird row. */
function costMetricsRowHtml(cost, weightText, valueText, opts) {
  opts = opts || {};
  const compact = opts.compact ? " cost-metrics-row-compact" : "";
  return `<div class="cost-metrics-row${compact}">
    <div class="cost-metric tone-rust"><div class="cost-metric-label">Cost</div><div class="cost-metric-value">${fmtMoney(cost)}</div></div>
    <div class="cost-metric"><div class="cost-metric-label">Weight</div><div class="cost-metric-value">${weightText}</div></div>
    <div class="cost-metric tone-sage"><div class="cost-metric-label">Value</div><div class="cost-metric-value">${valueText}</div></div>
  </div>`;
}

function openCostBreakdownModal(kind) {
  const { dozen, meat, scopeLabel } = lastCostBreakdowns;
  const row = (label, value, tone) => `<div class="stat-panel-row"><span class="stat-panel-row-label">${label}</span><span class="stat-panel-row-value${tone ? " tone-" + tone : ""}">${value}</span></div>`;
  const scope = scopeLabel ? ` — ${esc(String(scopeLabel))}` : "";
  let title, rowsHtml, formulaHtml, listHtml = "";

  if (kind === "dozen" && dozen) {
    title = `🥚 Cost per dozen eggs${scope}`;
    rowsHtml = row("Layer feed consumed", `${displayWeight(dozen.feedLbs)} ${getWeightUnit()}`)
      + row("Layer feed cost", fmtMoney(dozen.feedCost))
      + row("Layer Supplements expenses", fmtMoney(dozen.supplementCost))
      + row("Eggs collected", dozen.eggCount)
      + row("÷ Dozens", dozen.dozens.toFixed(2));
    formulaHtml = `(${fmtMoney(dozen.feedCost)} feed + ${fmtMoney(dozen.supplementCost)} supplements) ÷ ${dozen.dozens.toFixed(2)} dozen = <strong style="color:var(--text)">${fmtMoney(dozen.result)}/dozen</strong>`;
    if (dozen.supplementExpenses.length) {
      listHtml = `<div class="stat-panel-subhead">Supplement expenses</div><div class="stat-panel-rows">${dozen.supplementExpenses.map(x => row(`${fmtDate(x.date)}${x.description ? " · " + esc(x.description) : ""}`, fmtMoney(x.amount))).join("")}</div>`;
    }
  } else if (kind === "meat" && meat) {
    title = `🍗 Cost per ${getWeightUnit()} of meat${scope}`;
    const chickCount = meat.processedBirds.length + meat.deceasedBirds.length;
    rowsHtml = row("Meat feed consumed", `${displayWeight(meat.feedLbs)} ${getWeightUnit()}`)
      + row("Meat feed cost", fmtMoney(meat.feedCost))
      + row("Birds processed", meat.processedBirds.length)
      + row("Birds lost before processing", meat.deceasedBirds.length, meat.deceasedBirds.length > 0 ? "rust" : "")
      + row("Total acquisition cost", fmtMoney(meat.chickCost))
      + row("÷ Dressed weight", `${displayWeight(meat.meatWeightLb)} ${getWeightUnit()}`);
    formulaHtml = `(${fmtMoney(meat.feedCost)} feed + ${fmtMoney(meat.chickCost)} chick cost) ÷ ${displayWeight(meat.meatWeightLb)} ${getWeightUnit()} = <strong style="color:var(--text)">${fmtMoney(displayPricePerLb(meat.result))}/${getWeightUnit()}</strong>`;
    if (chickCount > 0) {
      // Only meaningful in a single-year view -- All-Time has no year
      // boundary for a bird's growing/processing dates to fall on either
      // side of, so flagging there would just be noise. A bird can only
      // span FORWARD (acquired in an earlier year than it was processed or
      // lost), never the reverse -- you can't harvest a bird before it
      // existed -- so the direction is always "started {startYear}, counted
      // here in {endYear}."
      const isYearScope = /^\d{4}$/.test(String(scopeLabel || ""));
      const spanInfo = (b) => {
        if (!isYearScope) return null;
        const startDate = b.acquired_date || b.hatch_date;
        const endDate = b.status === "Processed" ? b.harvest_date : b.death_date;
        if (!startDate || !endDate) return null;
        const startYear = startDate.slice(0, 4), endYear = endDate.slice(0, 4);
        return startYear !== endYear ? { startYear, endYear } : null;
      };
      const birdRow = (b) => {
        const span = spanInfo(b);
        const nameLabel = span
          ? `⚠️ ${esc(b.name || "(unnamed)")} <span class="dim" style="font-weight:400">— started ${span.startYear}</span>`
          : esc(b.name || "(unnamed)");
        const weight = Number(b.harvest_weight) || 0;
        const value = weight * (Number(b.price_per_lb) || 0);
        // Only a Processed bird has a dressed weight and value -- a Deceased
        // one never got that far, so "—" rather than a literal $0.00, which
        // would misleadingly read as "worth nothing" instead of "never
        // weighed."
        const weightText = b.status === "Processed" && weight > 0 ? weightLabel(weight) : "—";
        const valueText = b.status === "Processed" && weight > 0 ? fmtMoney(value) : "—";
        const lostNote = b.status === "Deceased" ? ` <span class="dim" style="font-size:11px;font-weight:400">— lost before processing</span>` : "";
        return `<div class="cost-bird-block">
          <div class="cost-bird-name">${nameLabel}${lostNote}</div>
          ${costMetricsRowHtml(b.acquisition_cost || 0, weightText, valueText)}
        </div>`;
      };
      const groups = groupBirdsByBatch([...meat.processedBirds, ...meat.deceasedBirds]);
      const anySpanning = isYearScope && groups.some(g => g.birds.some(b => spanInfo(b)));
      const groupHtml = groups.map(g => {
        const label = g.batchName ? esc(g.batchName) : "Individually added";
        const countLabel = [g.processedCount ? `${g.processedCount} processed` : null, g.deceasedCount ? `${g.deceasedCount} lost` : null].filter(Boolean).join(" · ");
        const groupSpans = g.birds.some(b => spanInfo(b));
        // Batch totals get the SAME three-chip treatment as an individual
        // bird, living inside <summary> itself so they're visible whether
        // the batch is expanded or not -- only the individual bird list
        // underneath is what actually collapses.
        const groupWeight = g.birds.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
        const groupValue = g.birds.reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);
        return `<details class="cost-breakdown-batch">
          <summary>
            <div class="cost-breakdown-batch-head">
              <span class="cost-breakdown-batch-name">${groupSpans ? "⚠️ " : ""}${label}</span>
              <span class="cost-breakdown-batch-count dim">${countLabel}</span>
            </div>
            ${costMetricsRowHtml(g.totalCost, groupWeight > 0 ? weightLabel(groupWeight) : "—", groupWeight > 0 ? fmtMoney(groupValue) : "—", { compact: true })}
          </summary>
          <div class="cost-bird-list">${g.birds.map(birdRow).join("")}</div>
        </details>`;
      }).join("");
      listHtml = `<div class="stat-panel-subhead">Birds counted (${chickCount}, ${groups.length} batch${groups.length !== 1 ? "es" : ""}) -- tap a batch to see its birds</div>
        ${anySpanning ? `<div class="dim" style="font-size:11px;margin-bottom:8px">⚠️ marks a bird acquired in an earlier year than it was processed or lost. The numbers above are correct -- its feed cost is still split by the days it actually ate in each year -- but its acquisition cost and weight only count here, in ${esc(String(scopeLabel))}, not in the year it started.</div>` : ""}
        <div style="max-height:400px;overflow-y:auto">${groupHtml}</div>`;
    }
  } else {
    return; // stale click after a re-render with nothing to show -- nothing to open
  }

  openModal(`
    <div class="form-head">${title}</div>
    <div class="dim" style="font-size:12px;margin-bottom:12px">Every number behind this figure, exactly as used -- editing any of the underlying eggs, birds, or expenses will change it.</div>
    <div class="stat-panel-rows">${rowsHtml}</div>
    <div class="note-box" style="margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:12px">${formulaHtml}</div>
    ${listHtml}
  `);
}

/** Which of Layer Feed / Meat Feed / Bedding are actually running low right
 * now -- "low" means the best (fullest) currently-active supply item for
 * that category is down to 1/4 or Empty, i.e. there's no fuller backup
 * bag waiting. A near-empty bag with a full one behind it isn't urgent. */
/** Every dated thing that's happened (past) or is coming up (future),
 * pulled from every table that has one -- the data behind "look back and
 * see what happened on any given day." Each event is { date, icon, title,
 * detail, tone }. Kept as two separate lists rather than one blended,
 * sorted list -- "already happened" and "hasn't happened yet" read as
 * different kinds of information, and mixing them would make the list
 * harder to scan, not easier. Past sorts newest first; future sorts
 * soonest first, since that's the order each is actually useful in. */
/** "Sep 15, 2026 · in 25d" (or "· overdue 3d", "· today") -- a future
 * event's detail line. Same relative-day wording already used by the
 * bedding freshness card, so "in Nd" means the same thing everywhere in
 * the app, not a second convention for the calendar specifically. */
function relativeDayLabel(dateStr, todayKey) {
  const days = Math.round((new Date(dateStr + "T00:00:00") - new Date(todayKey + "T00:00:00")) / 86400000);
  if (days < 0) return `overdue ${-days}d`;
  if (days === 0) return "today";
  return `in ${days}d`;
}
function allCalendarEvents() {
  const past = [], future = [];
  const todayKey = todayStr();

  STATE.birds.forEach(b => {
    const label = b.name || "(unnamed bird)";
    const typeIcon = BIRD_TYPE_ICONS[b.type === "Meat" ? "meat" : "layer"].emoji;
    // Batched birds share a groupKey (their batch name); an individually
    // added bird gets a key unique to itself, so it never collapses into a
    // group of its own -- there's nothing to group it WITH.
    const batchKey = b.batch_name ? `batch:${b.batch_name}` : `individual:${b.id}`;
    const src = { sourceType: "bird", sourceId: b.id };
    if (b.acquired_date) past.push({ date: b.acquired_date, icon: typeIcon, title: `${label} acquired`, tone: "sage", kind: "acquired", groupKey: `acquired:${batchKey}`, groupLabel: `birds acquired${b.batch_name ? ` (${b.batch_name})` : ""}`, ...src });
    else if (b.hatch_date) past.push({ date: b.hatch_date, icon: "🐣", title: `${label} hatched`, tone: "sage", kind: "hatched", groupKey: `hatched:${batchKey}`, groupLabel: "birds hatched", ...src });
    if (b.harvest_date) past.push({ date: b.harvest_date, icon: "🍗", title: `${label} processed`, detail: b.harvest_weight ? weightLabel(b.harvest_weight) : "", tone: "rust", kind: "processed", groupKey: `processed:${batchKey}`, groupLabel: `birds processed${b.batch_name ? ` (${b.batch_name})` : ""}`, ...src });
    if (b.death_date) past.push({ date: b.death_date, icon: "💔", title: `${label} lost`, detail: b.death_cause || "", tone: "rust", kind: "lost", groupKey: `lost:${batchKey}`, groupLabel: "birds lost", ...src });
    if (b.sold_date) past.push({ date: b.sold_date, icon: "💵", title: `${label} sold`, tone: "gold", kind: "sold", groupKey: `sold:${batchKey}`, groupLabel: "birds sold", ...src });
    if (b.retired_date) past.push({ date: b.retired_date, icon: "🏡", title: `${label} retired`, tone: "slate", kind: "retired", groupKey: `retired:${batchKey}`, groupLabel: "birds retired", ...src });
    if (b.status === "Active" && b.target_harvest_date && b.target_harvest_date >= todayKey) {
      future.push({ date: b.target_harvest_date, icon: "🎯", title: `${label} target harvest`, detail: relativeDayLabel(b.target_harvest_date, todayKey), tone: "gold", kind: "target", groupKey: `target:${batchKey}`, groupLabel: `birds with this target harvest date${b.batch_name ? ` (${b.batch_name})` : ""}`, ...src });
    }
  });

  STATE.eggs.forEach(e => {
    if (e.date) past.push({ date: e.date, icon: "🥚", title: `${Math.round(Number(e.count) || 0)} egg${Math.round(Number(e.count) || 0) !== 1 ? "s" : ""} collected`, tone: "sage", kind: "eggs", groupKey: "eggs", groupLabel: "egg collections", sourceType: "egg", sourceId: e.id });
  });

  STATE.expenses.forEach(x => {
    const isIncome = x.entry_type === "income";
    past.push({ date: x.date, icon: isIncome ? "💰" : "💸", title: `${isIncome ? "Income" : "Expense"}: ${x.category}`, detail: fmtMoney(x.amount), tone: isIncome ? "sage" : "rust", kind: isIncome ? "income" : "expense", groupKey: `${isIncome ? "income" : "expense"}:${x.category}`, groupLabel: `${x.category} ${isIncome ? "income" : "expenses"}`, sourceType: "expense", sourceId: x.id });
  });

  STATE.supplies.forEach(s => {
    if (s.opened_at) past.push({ date: s.opened_at, icon: "📦", title: `${s.category} opened`, detail: s.brand || "", tone: "slate", kind: "opened", groupKey: `opened:${s.category}`, groupLabel: `${s.category} bags opened`, sourceType: "supply", sourceId: s.id });
    if (s.date_emptied) past.push({ date: s.date_emptied, icon: "🗑️", title: `${s.category} emptied`, detail: s.brand || "", tone: "slate", kind: "emptied", groupKey: `emptied:${s.category}`, groupLabel: `${s.category} bags emptied`, sourceType: "supply", sourceId: s.id });
  });

  STATE.bedding.forEach(bd => {
    if (bd.date) past.push({ date: bd.date, icon: "🧹", title: `${bd.area || "Bedding"}: ${bd.entry_type || "logged"}`, tone: "gold", kind: "bedding", groupKey: `bedding:${bd.area}:${bd.entry_type}`, groupLabel: `${bd.area || "Bedding"}: ${bd.entry_type || "logged"}`, sourceType: "bedding", sourceId: bd.id });
  });

  STATE.hatches.forEach(h => {
    if (h.date_started) past.push({ date: h.date_started, icon: "🐣", title: `Hatch started: ${h.breed || "eggs"}`, detail: h.egg_count ? `${Math.round(h.egg_count)} eggs set` : "", tone: "gold", kind: "hatch-started", groupKey: `hatch-started:${h.id}`, groupLabel: "hatches started", sourceType: "hatch", sourceId: h.id });
  });

  STATE.notes.forEach(n => {
    if (n.created_date) past.push({ date: n.created_date, icon: "📝", title: n.title || "Note", tone: "slate", kind: "note", groupKey: `note:${n.id}`, groupLabel: "notes", sourceType: "note", sourceId: n.id });
  });

  // Future: bedding clean-out due, using the same threshold math that
  // already drives the dashboard's freshness dots -- not a new calculation,
  // just this one projected forward into an actual calendar date. No
  // source record to link to -- it's a projection, not a logged event.
  getBeddingAreas().forEach(area => {
    const bs = beddingStatsFor(area);
    const t = getBeddingThresholds(area);
    if (bs.lastCleanout) {
      const daysUntil = t.danger - daysSince(bs.lastCleanout.date);
      const dueDate = addDays(todayKey, daysUntil);
      future.push({ date: dueDate, icon: "🧹", title: `${area}: clean-out due`, detail: relativeDayLabel(dueDate, todayKey), tone: daysUntil < 0 ? "rust" : "gold", kind: "cleanout-due", groupKey: `cleanout-due:${area}`, groupLabel: `${area}: clean-out due` });
    }
  });

  past.sort((a, b) => b.date.localeCompare(a.date));
  future.sort((a, b) => a.date.localeCompare(b.date));
  return { past, future };
}

/** One calendar event as a compact row -- icon, title, optional detail,
 * tone-colored left edge matching the same rust/sage/gold/slate language
 * used everywhere else in the app. */
/** One calendar event as a compact row -- icon, title, optional detail,
 * tone-colored left edge matching the same rust/sage/gold/slate language
 * used everywhere else in the app. Clickable straight through to its real
 * record when it has one (data-cal-source); a projected event like a
 * bedding clean-out due date has no underlying record to open, so it's
 * left as plain, non-clickable text rather than looking tappable and
 * doing nothing. */
function calendarEventRow(e) {
  const clickable = e.sourceType && e.sourceId;
  return `<div class="cal-event-row tone-${e.tone || "slate"}${clickable ? " cal-event-clickable" : ""}" ${clickable ? `data-cal-source="${e.sourceType}" data-cal-id="${esc(e.sourceId)}" role="button" tabindex="0"` : ""}>
    <span class="cal-event-icon">${e.icon}</span>
    <span class="cal-event-body">
      <span class="cal-event-title">${esc(e.title)}</span>
      ${e.detail ? `<span class="cal-event-detail dim">${esc(e.detail)}</span>` : ""}
    </span>
    ${clickable ? `<span class="cal-event-goto dim">›</span>` : ""}
  </div>`;
}
/** Opens the real record behind a calendar event, switching to its home
 * tab/sub-tab first (matching the one existing precedent for this in the
 * app -- a modal opened while its owning tab isn't mounted yet can't find
 * what it needs) and giving that a moment to render before the modal
 * itself opens. */
function openCalendarSource(sourceType, sourceId) {
  const openers = {
    bird: () => { const b = STATE.birds.find(x => x.id === sourceId); if (b) { switchTab("flock"); flockSubTab = "birds"; setTimeout(() => showBirdForm(b), 80); } },
    expense: () => { const x = STATE.expenses.find(x => x.id === sourceId); if (x) { switchTab("expenses"); setTimeout(() => openExpenseModal(x), 80); } },
    supply: () => { const s = STATE.supplies.find(x => x.id === sourceId); if (s) { switchTab("bedding"); supplySubTab = "inventory"; setTimeout(() => openSupplyModal(s), 80); } },
    egg: () => { const e = STATE.eggs.find(x => x.id === sourceId); if (e) { switchTab("eggs"); eggsSubTab = "eggs"; setTimeout(() => openEggModal(e), 80); } },
    bedding: () => { const b = STATE.bedding.find(x => x.id === sourceId); if (b) { switchTab("bedding"); supplySubTab = "freshness"; setTimeout(() => openBeddingModal(b), 80); } },
    hatch: () => { const h = STATE.hatches.find(x => x.id === sourceId); if (h) { switchTab("eggs"); eggsSubTab = "hatching"; setTimeout(() => openHatchModal(h), 80); } },
    note: () => { const n = STATE.notes.find(x => x.id === sourceId); if (n) { switchTab("flock"); flockSubTab = "notes"; setTimeout(() => openNoteModal(n), 80); } },
  };
  const opener = openers[sourceType];
  if (opener) { closeModal(); opener(); }
}
/** Past events for one month, grouped by exact day (newest day first) --
 * a busy day's several events sit under one date header instead of
 * repeating the date on every row. */
/** Groups a flat list of events by groupKey, rendering a lone event as a
 * plain row and a same-day, same-kind cluster (a whole batch added, several
 * bags opened, etc.) as one collapsible summary -- "25 birds acquired
 * (Spring Batch) ▸" -- reusing the same <details> disclosure already
 * established for batches in the cost-breakdown modal, rather than a wall
 * of near-identical rows. A group is never collapsed for just one item;
 * grouping only kicks in once there's actually something to save space on. */
function calendarEventsHtml(events) {
  const groups = new Map();
  events.forEach(e => {
    if (!groups.has(e.groupKey)) groups.set(e.groupKey, []);
    groups.get(e.groupKey).push(e);
  });
  return [...groups.values()].map(group => {
    if (group.length === 1) return calendarEventRow(group[0]);
    const first = group[0];
    return `<details class="cost-breakdown-batch">
      <summary>
        <div class="cost-breakdown-batch-head">
          <span class="cal-event-icon">${first.icon}</span>
          <span class="cost-breakdown-batch-name">${esc(String(group.length))} ${esc(first.groupLabel || "items")}</span>
        </div>
      </summary>
      <div class="cal-event-list-nested">${group.map(calendarEventRow).join("")}</div>
    </details>`;
  }).join("");
}
/** Groups a flat list of events by their exact date, each date rendered as
 * a bold header above its events -- the same treatment for History (newest
 * date first) and Coming Up (soonest date first), so "when is this"
 * always gets a header you can't miss, not text tucked inside a row. */
function calendarGroupedByDateHtml(events, { reverse = false, emptyMessage } = {}) {
  if (!events.length) return `<div class="dim" style="font-size:12px;padding:10px 0">${esc(emptyMessage)}</div>`;
  const byDate = new Map();
  events.forEach(e => {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  });
  let dates = [...byDate.keys()].sort();
  if (reverse) dates.reverse();
  return dates.map(date => `
    <div class="cal-day-group">
      <div class="cal-day-header">${fmtDate(date)}</div>
      ${calendarEventsHtml(byDate.get(date))}
    </div>`).join("");
}
function calendarHistoryForMonth(monthKey) {
  const { past } = allCalendarEvents();
  const monthEvents = past.filter(e => monthKeyOf(e.date) === monthKey);
  return calendarGroupedByDateHtml(monthEvents, { reverse: true, emptyMessage: `Nothing logged in ${monthLabelOf(monthKey)}.` });
}
function calendarModalHtml(selectedMonth) {
  const { future } = allCalendarEvents();
  const months = allCoopMonths();
  return `
    <div class="form-head">📅 Calendar</div>
    <div class="dim" style="font-size:12px;margin-bottom:14px">Everything dated, in one place -- what happened, and what's coming up.</div>

    <div style="${FORM_SECTION_HEAD}">Coming up</div>
    ${calendarGroupedByDateHtml(future, { reverse: false, emptyMessage: "Nothing on the horizon right now." })}

    <div class="toolbar" style="margin-top:8px">
      <div style="${FORM_SECTION_HEAD};margin:0">History</div>
      <select id="calMonthSelect" style="max-width:170px">${monthOptionsGroupedByYear(months, selectedMonth)}</select>
    </div>
    <div id="calHistoryList" style="max-height:400px;overflow-y:auto">${calendarHistoryForMonth(selectedMonth)}</div>
  `;
}
function openCalendarModal() {
  let selectedMonth = monthKeyOf(todayStr());
  const wireClicks = () => {
    document.querySelectorAll("[data-cal-source]").forEach(row => {
      const go = () => openCalendarSource(row.dataset.calSource, row.dataset.calId);
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  };
  openModal(calendarModalHtml(selectedMonth));
  wireClicks();
  document.getElementById("calMonthSelect").addEventListener("change", (e) => {
    selectedMonth = e.target.value;
    document.getElementById("calHistoryList").innerHTML = calendarHistoryForMonth(selectedMonth);
    wireClicks();
  });
}

function lowSupplyCategories(supplies) {
  const STATUS_RANK = { "Full": 4, "3/4": 3, "1/2": 2, "1/4": 1, "Empty": 0 };
  const TONE_FOR_RANK = { 2: "gold", 1: "rust", 0: "danger" };
  const results = [];
  for (const cat of ["Layer Feed", "Meat Feed", "Bedding"]) {
    // Never tracked at all for this category -- nothing to be "out" of if
    // it was never being tracked in the first place. Distinct from "was
    // tracked, now fully consumed," which genuinely is worth a warning.
    if (!supplies.some(s => s.category === cat)) continue;
    const active = supplies.filter(s => s.category === cat && !s.date_emptied);
    if (active.length === 0) { results.push({ category: cat, status: "Empty", tone: "danger" }); continue; }
    const recognized = active.filter(s => s.status in STATUS_RANK);
    if (recognized.length === 0) continue; // unrecognized/missing status on every item -- don't guess, don't alarm
    const best = recognized.reduce((a, b) => STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b : a);
    const rank = STATUS_RANK[best.status];
    if (rank <= 2) results.push({ category: cat, status: best.status, tone: TONE_FOR_RANK[rank] });
  }
  return results;
}

/** Weighted average price across a specific set of egg entries, falling
 * back to the coop's default only when there's nothing logged to average.
 * This is the actual fix for the sale-washout bug: a flat "current default"
 * price silently misstates value whenever eggs were logged at a different
 * price than the default (deliberately, or because the default changed
 * since), so washing out a sale needs to use what those eggs were ACTUALLY
 * logged at, not today's default. */
function weightedAvgEggPrice(eggEntries, fallback) {
  const totalCount = eggEntries.reduce((s, e) => s + (Number(e.count) || 0), 0);
  if (totalCount <= 0) return fallback;
  const totalValue = eggEntries.reduce((s, e) => s + (Number(e.count) || 0) * (Number(e.price_per_egg) || 0), 0);
  return totalValue / totalCount;
}
/** Same idea, for meat -- weighted by dressed weight instead of count. */
function weightedAvgMeatPrice(birdEntries, fallback) {
  const totalWeight = birdEntries.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  if (totalWeight <= 0) return fallback;
  const totalValue = birdEntries.reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);
  return totalValue / totalWeight;
}
/** Bird counts as they stood at the END of a given month -- the historical
 * analog of "Active Birds right now." A bird counts if it had already been
 * acquired or hatched by the end of that month, and hadn't yet left the
 * flock by then either. "Left" means whichever ONE of harvest/death/sold/
 * retired date actually applies to that bird's current status -- a bird is
 * never more than one of those at once. This app doesn't track status
 * history, only where a bird currently stands and the one date that got it
 * there, so a bird that somehow changed status more than once can only be
 * reconstructed from where it ended up, not the path it took there -- an
 * acceptable simplification given nothing else in the data model tracks
 * that either. */
function flockCountsAsOf(monthKey) {
  const endOfMonth = `${monthKey}-${String(daysInMonthKey(monthKey)).padStart(2, "0")}`;
  let active = 0, layers = 0, meatActive = 0;
  STATE.birds.forEach(b => {
    const start = b.acquired_date || b.hatch_date;
    if (!start || start > endOfMonth) return; // didn't exist yet
    const exit = b.harvest_date || b.death_date || b.sold_date || b.retired_date || null;
    if (exit && exit <= endOfMonth) return; // already gone by then
    active++;
    if (b.type === "Layer" || b.type === "Dual Purpose") layers++;
    else if (b.type === "Meat") meatActive++;
  });
  return { active, layers, meatActive };
}

function computeStats(monthKey) {
  monthKey = monthKey || monthKeyOf(todayStr());
  // "Active Birds" for the CURRENT month reads live status, same as always.
  // For any other (historical) month, there's no "status right now" to read
  // -- it's reconstructed from each bird's own acquired/hatch date and
  // whichever exit date applies, via flockCountsAsOf.
  let active, layers, meatActive;
  if (monthKey === monthKeyOf(todayStr())) {
    const activeBirds = STATE.birds.filter(b => b.status === "Active");
    active = activeBirds.length;
    layers = activeBirds.filter(b => b.type === "Layer" || b.type === "Dual Purpose").length;
    meatActive = activeBirds.filter(b => b.type === "Meat").length;
  } else {
    ({ active, layers, meatActive } = flockCountsAsOf(monthKey));
  }
  const processed = STATE.birds.filter(b => b.status === "Processed");
  const totalWeight = processed.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  const totalEggs = STATE.eggs.reduce((s, e) => s + (Number(e.count) || 0), 0);
  const last7 = STATE.eggs.filter(e => withinRange(e.date, 7)).reduce((s, e) => s + (Number(e.count) || 0), 0);
  const last30 = STATE.eggs.filter(e => withinRange(e.date, 30)).reduce((s, e) => s + (Number(e.count) || 0), 0);
  const totalExpenses = STATE.expenses.filter(x => x.entry_type !== "income").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const now = new Date();
  // "This month" now means the SELECTED month (today's, unless the caller
  // passed a different one for historical look-back) -- everything below
  // gated on isThisMonth shifts with it. isThisYear stays tied to the real
  // current year regardless; nothing here generalizes that cross-reference.
  const isThisMonth = (d) => d && monthKeyOf(d) === monthKey;
  const isThisYear = (d) => { const dt = new Date(d + "T00:00:00"); return dt.getFullYear() === now.getFullYear(); };
  const thisMonth = STATE.expenses.filter(x => x.entry_type !== "income" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);

  const eggIncomeOf = (e) => (Number(e.count) || 0) * (Number(e.price_per_egg) || 0);
  const meatIncomeOf = (b) => (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0);
  const rawEggIncomeAll = STATE.eggs.reduce((s, e) => s + eggIncomeOf(e), 0);
  const rawEggIncomeMonth = STATE.eggs.filter(e => isThisMonth(e.date)).reduce((s, e) => s + eggIncomeOf(e), 0);
  const rawMeatIncomeAll = processed.reduce((s, b) => s + meatIncomeOf(b), 0);
  const rawMeatIncomeMonth = processed.filter(b => b.harvest_date && isThisMonth(b.harvest_date)).reduce((s, b) => s + meatIncomeOf(b), 0);

  // A real sale washes out its equivalent from the estimated "value
  // produced" -- using a weighted average of what was ACTUALLY logged for
  // eggs/meat in the relevant scope, not the coop's current default price.
  // The default is only a fallback for when nothing's been logged at all;
  // using it as the wash-out price otherwise silently misstates value
  // whenever someone logs at a price different from the default (deliberately,
  // or because the default has since changed). Without washing out at all,
  // a real sale would be counted twice: once as an estimate when collected,
  // again as real income when sold.
  const defaults = getCoopDefaults();
  const eggPriceAll = weightedAvgEggPrice(STATE.eggs, Number(defaults.eggPrice) || 0);
  const meatPriceAll = weightedAvgMeatPrice(processed, Number(defaults.pricePerLb) || 0);
  const incomeEntries = STATE.expenses.filter(x => x.entry_type === "income");
  // Each sale washes out using its OWN locked-in price, captured once at
  // the moment it was logged -- not a single average recomputed over
  // everything that currently exists. Without this, collecting more eggs
  // later would silently re-price a sale that already happened, using
  // eggs it couldn't possibly have come from. Entries logged before this
  // fix (with no locked-in price yet) fall back to the current weighted
  // average, same as before.
  const washedEggValueAll = incomeEntries.filter(x => x.category === "Egg Sale").reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : eggPriceAll), 0);
  const washedEggValueMonth = incomeEntries.filter(x => x.category === "Egg Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : eggPriceAll), 0);
  const washedMeatValueAll = incomeEntries.filter(x => x.category === "Meat Sale").reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : meatPriceAll), 0);
  const washedMeatValueMonth = incomeEntries.filter(x => x.category === "Meat Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : meatPriceAll), 0);
  const eggIncomeAll = Math.max(0, rawEggIncomeAll - washedEggValueAll);
  const eggIncomeMonth = Math.max(0, rawEggIncomeMonth - washedEggValueMonth);
  const meatIncomeAll = Math.max(0, rawMeatIncomeAll - washedMeatValueAll);
  const meatIncomeMonth = Math.max(0, rawMeatIncomeMonth - washedMeatValueMonth);
  const eggActualIncomeAll = incomeEntries.filter(x => x.category === "Egg Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const eggActualIncomeMonth = incomeEntries.filter(x => x.category === "Egg Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const meatActualIncomeAll = incomeEntries.filter(x => x.category === "Meat Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const meatActualIncomeMonth = incomeEntries.filter(x => x.category === "Meat Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const otherActualIncomeAll = incomeEntries.filter(x => x.category !== "Egg Sale" && x.category !== "Meat Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const otherActualIncomeMonth = incomeEntries.filter(x => x.category !== "Egg Sale" && x.category !== "Meat Sale" && isThisMonth(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const actualIncomeAll = eggActualIncomeAll + meatActualIncomeAll + otherActualIncomeAll;
  const actualIncomeMonth = eggActualIncomeMonth + meatActualIncomeMonth + otherActualIncomeMonth;
  // The true total value of eggs/meat is the leftover estimate for what's
  // still unsold PLUS the real cash for what was sold -- the wash-out only
  // exists to prevent double-counting the sold portion, not to make it
  // disappear from the total.
  const eggTotalValueAll = eggIncomeAll + eggActualIncomeAll;
  const eggTotalValueMonth = eggIncomeMonth + eggActualIncomeMonth;
  const meatTotalValueAll = meatIncomeAll + meatActualIncomeAll;
  const meatTotalValueMonth = meatIncomeMonth + meatActualIncomeMonth;
  // Bird sale value has no washout to do -- unlike eggs/meat (which are an
  // ESTIMATE that might separately get sold for real, needing reconciliation
  // against a second entry), a bird's sold_amount already IS the one real
  // number for what it actually sold for. Nothing else to double-count
  // against.
  const soldBirds = STATE.birds.filter(b => b.sold_date && Number(b.sold_amount) > 0);
  const birdSaleValueAll = soldBirds.reduce((s, b) => s + Number(b.sold_amount), 0);
  const birdSaleValueMonth = soldBirds.filter(b => isThisMonth(b.sold_date)).reduce((s, b) => s + Number(b.sold_amount), 0);
  const incomeAll = eggIncomeAll + meatIncomeAll + birdSaleValueAll + actualIncomeAll;
  const incomeMonth = eggIncomeMonth + meatIncomeMonth + birdSaleValueMonth + actualIncomeMonth;
  const netAll = incomeAll - totalExpenses;
  const netMonth = incomeMonth - thisMonth;

  const deceased = STATE.birds.filter(b => b.status === "Deceased");
  const lossesAll = deceased.length;
  const lossesThisYear = deceased.filter(b => b.death_date && isThisYear(b.death_date)).length;
  const lossesThisMonth = deceased.filter(b => b.death_date && isThisMonth(b.death_date)).length;

  const chicksHatchedAll = STATE.hatchEggs.filter(e => e.status === "Hatched").length;
  const hatchClearAll = STATE.hatchEggs.filter(e => e.status === "Clear").length;
  const hatchQuitAll = STATE.hatchEggs.filter(e => e.status === "Quit").length;
  const hatchFailedAll = STATE.hatchEggs.filter(e => e.status === "Failed to Hatch").length;
  const hatchLossAll = hatchClearAll + hatchQuitAll + hatchFailedAll;
  // Month-scoped, using each egg's own resolved_date (when its outcome
  // actually happened) rather than the clutch's date_started (when it went
  // into the incubator) -- a clutch started in one month often resolves in
  // the next, so the clutch date would misattribute it. Eggs recorded
  // before this field existed fall back to date_started rather than being
  // silently excluded from every month view.
  const hatchDateById = {};
  STATE.hatches.forEach(h => { hatchDateById[h.id] = h.date_started; });
  const hatchEggEffectiveDate = (e) => e.resolved_date || hatchDateById[e.hatch_id] || null;
  const hatchEggsThisMonth = STATE.hatchEggs.filter(e => isThisMonth(hatchEggEffectiveDate(e)));
  const chicksHatchedMonth = hatchEggsThisMonth.filter(e => e.status === "Hatched").length;
  const hatchClearMonth = hatchEggsThisMonth.filter(e => e.status === "Clear").length;
  const hatchQuitMonth = hatchEggsThisMonth.filter(e => e.status === "Quit").length;
  const hatchFailedMonth = hatchEggsThisMonth.filter(e => e.status === "Failed to Hatch").length;
  const hatchLossMonth = hatchClearMonth + hatchQuitMonth + hatchFailedMonth;

  const eggsThisMonth = STATE.eggs.filter(e => isThisMonth(e.date)).reduce((s, e) => s + (Number(e.count) || 0), 0);
  const processedThisMonth = processed.filter(b => b.harvest_date && isThisMonth(b.harvest_date)).length;
  const weightThisMonth = processed.filter(b => b.harvest_date && isThisMonth(b.harvest_date)).reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);

  return { active, layers, meatActive, processed: processed.length, totalWeight, totalEggs, last7, last30, eggsThisMonth, processedThisMonth, weightThisMonth, totalExpenses, thisMonth, eggIncomeAll, eggIncomeMonth, meatIncomeAll, meatIncomeMonth, eggActualIncomeAll, eggActualIncomeMonth, meatActualIncomeAll, meatActualIncomeMonth, eggTotalValueAll, eggTotalValueMonth, meatTotalValueAll, meatTotalValueMonth, birdSaleValueAll, birdSaleValueMonth, incomeAll, incomeMonth, actualIncomeAll, actualIncomeMonth, netAll, netMonth, lossesAll, lossesThisYear, lossesThisMonth, chicksHatchedAll, hatchClearAll, hatchQuitAll, hatchFailedAll, hatchLossAll, chicksHatchedMonth, hatchClearMonth, hatchQuitMonth, hatchFailedMonth, hatchLossMonth };
}

function allCoopYears() {
  const years = new Set();
  STATE.birds.forEach(b => { ["hatch_date", "acquired_date", "harvest_date", "death_date"].forEach(f => { if (b[f]) years.add(b[f].slice(0, 4)); }); });
  STATE.eggs.forEach(e => { if (e.date) years.add(e.date.slice(0, 4)); });
  STATE.expenses.forEach(x => { if (x.date) years.add(x.date.slice(0, 4)); });
  STATE.bedding.forEach(b => { if (b.date) years.add(b.date.slice(0, 4)); });
  return [...years].sort().reverse();
}
/** Every month with at least one dated entry, newest first -- the same
 * "only what actually has data" principle allCoopYears uses, at month
 * grain instead of year. Always includes the current month even with
 * nothing logged yet, so the picker is never empty for a brand-new coop. */
function allCoopMonths() {
  const months = new Set();
  STATE.birds.forEach(b => { ["hatch_date", "acquired_date", "harvest_date", "death_date", "sold_date", "retired_date"].forEach(f => { if (b[f]) months.add(monthKeyOf(b[f])); }); });
  STATE.eggs.forEach(e => { if (e.date) months.add(monthKeyOf(e.date)); });
  STATE.expenses.forEach(x => { if (x.date) months.add(monthKeyOf(x.date)); });
  STATE.bedding.forEach(b => { if (b.date) months.add(monthKeyOf(b.date)); });
  months.add(monthKeyOf(todayStr()));
  return [...months].sort().reverse();
}
/** Delta-chip comparison for the (possibly historical) selected month: sums
 * the month through a cutoff day, against the SAME cutoff day in the month
 * before it -- apples to apples either way. For the current, still-in-
 * progress month, the cutoff is today's day-of-month, so a half-finished
 * month never gets compared to a completed one. For any past, already-
 * complete month, the cutoff is that month's own last day -- the whole
 * month, since there's nothing "in progress" to worry about. sumFn gets an
 * inclusive [from, to] date-string range and returns whatever total the
 * caller is comparing. */
function monthOverMonthCompare(monthKey, sumFn) {
  const isCurrentMonth = monthKey === monthKeyOf(todayStr());
  const cutoffDay = isCurrentMonth ? Number(todayStr().slice(8, 10)) : daysInMonthKey(monthKey);
  const prevKey = shiftMonthKey(monthKey, -1);
  const prevCutoffDay = Math.min(cutoffDay, daysInMonthKey(prevKey));
  const curFrom = `${monthKey}-01`, curTo = addDays(curFrom, cutoffDay - 1);
  const prevFrom = `${prevKey}-01`, prevTo = addDays(prevFrom, prevCutoffDay - 1);
  return { cur: sumFn(curFrom, curTo), prev: sumFn(prevFrom, prevTo) };
}
/** Raw (non-washout-adjusted) value/spend/net over an arbitrary date range,
 * for the dashboard's month-over-month delta chips specifically -- these
 * need an arbitrary partial-month range (e.g. Aug 1-20), not a whole
 * calendar month, which the exact sale-washout logic in computeStats isn't
 * built for. Matches the same precedent computeCardTrends already
 * established for the sparkline/trend data: a plain count x price estimate
 * keeps a trend honest without needing the exact figure, which stays in the
 * headline number (computeStats) where precision actually matters. */
function rawValueBetween(fromDate, toDate) {
  const d = getCoopDefaults();
  const eggFallback = Number(d.eggPrice) || 0, meatFallback = Number(d.pricePerLb) || 0;
  const inRange = (dt) => dt && dt >= fromDate && dt <= toDate;
  const eggVal = STATE.eggs.filter(e => inRange(e.date)).reduce((s, e) => s + (Number(e.count) || 0) * (Number(e.price_per_egg) || eggFallback), 0);
  const meatVal = STATE.birds.filter(b => b.status === "Processed" && inRange(b.harvest_date)).reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || meatFallback), 0);
  const birdSaleVal = STATE.birds.filter(b => b.sold_date && inRange(b.sold_date) && Number(b.sold_amount) > 0).reduce((s, b) => s + Number(b.sold_amount), 0);
  const otherInc = STATE.expenses.filter(x => x.entry_type === "income" && x.category !== "Egg Sale" && x.category !== "Meat Sale" && inRange(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return eggVal + meatVal + birdSaleVal + otherInc;
}
function spendBetween(fromDate, toDate) {
  const inRange = (dt) => dt && dt >= fromDate && dt <= toDate;
  return STATE.expenses.filter(x => x.entry_type !== "income" && inRange(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
}
function netBetween(fromDate, toDate) { return rawValueBetween(fromDate, toDate) - spendBetween(fromDate, toDate); }

/** Per-bucket trend series for the stat cards on Year Review and All-Time.
 * Year Review -> 12 monthly buckets for the selected year; All-Time ->
 * one bucket per calendar year the coop has data, oldest to newest. Every
 * card that represents a summable quantity gets one, so each stat on those
 * pages carries the same at-a-glance shape the dashboard cards do. Values
 * use raw per-entry estimates (count x price, weight x price), matching the
 * dashboard sparklines -- a consistent estimator is what keeps a trend
 * honest; the exact washed-out figure stays in the card's main number. */
function monthlyTrends(year) {
  const z = () => Array(12).fill(0);
  const idx = (d) => (d && d.slice(0, 4) === year) ? (parseInt(d.slice(5, 7), 10) - 1) : -1;
  const out = { eggs: z(), eggValue: z(), meatLb: z(), meatValue: z(), spent: z(), income: z(), losses: z(), newBirds: z(), layerFeed: z(), meatFeed: z(), bedding: z(), cleanouts: z(), chicks: z() };
  const d = getCoopDefaults();
  const eggFallback = Number(d.eggPrice) || 0, meatFallback = Number(d.pricePerLb) || 0;
  STATE.eggs.forEach(e => { const m = idx(e.date); if (m < 0) return; const c = Number(e.count) || 0; out.eggs[m] += c; out.eggValue[m] += c * (Number(e.price_per_egg) || eggFallback); });
  STATE.birds.forEach(b => {
    if (b.status === "Processed") { const m = idx(b.harvest_date); if (m >= 0) { const w = Number(b.harvest_weight) || 0; out.meatLb[m] += w; out.meatValue[m] += w * (Number(b.price_per_lb) || meatFallback); } }
    if (b.status === "Deceased") { const m = idx(b.death_date); if (m >= 0) out.losses[m]++; }
    const acq = b.acquired_date || b.hatch_date; const m = idx(acq); if (m >= 0) out.newBirds[m]++;
  });
  STATE.expenses.forEach(x => { const m = idx(x.date); if (m < 0) return; if (x.entry_type === "income") out.income[m] += Number(x.amount) || 0; else out.spent[m] += Number(x.amount) || 0; });
  STATE.supplies.forEach(s => { if (!s.date_emptied) return; const m = idx(s.date_emptied); if (m < 0) return; const q = Number(s.quantity) || 0; if (s.category === "Layer Feed") out.layerFeed[m] += q; else if (s.category === "Meat Feed") out.meatFeed[m] += q; else if (s.category === "Bedding") out.bedding[m] += q; });
  STATE.bedding.forEach(b => { if (b.entry_type !== "Full Clean-out") return; const m = idx(b.date); if (m >= 0) out.cleanouts[m]++; });
  const hatchMonth = {}; STATE.hatches.forEach(h => { hatchMonth[h.id] = idx(h.date_started); });
  STATE.hatchEggs.forEach(e => { const m = hatchMonth[e.hatch_id]; if (m >= 0 && e.status === "Hatched") out.chicks[m]++; });
  out.value = out.eggValue.map((v, i) => v + out.meatValue[i] + out.income[i]);
  // Running total, matching the dashboard's net sparkline: a per-bucket net
  // just showed which periods carried a big purchase, whereas the card is
  // really asking about trajectory -- am I climbing back or still sinking?
  out.net = (() => { let r = 0; return out.value.map((v, i) => (r += v - out.spent[i])); })();
  return out;
}

function yearlyTrends() {
  const years = allCoopYears(); // ascending, only years with data
  if (years.length === 0) return { years: [] };
  const pos = {}; years.forEach((y, i) => pos[y] = i);
  const z = () => Array(years.length).fill(0);
  const yr = (d) => (d && pos[d.slice(0, 4)] !== undefined) ? pos[d.slice(0, 4)] : -1;
  const out = { years, eggs: z(), eggValue: z(), meatLb: z(), meatValue: z(), spent: z(), income: z(), losses: z(), newBirds: z(), layerFeed: z(), meatFeed: z(), bedding: z(), cleanouts: z(), chicks: z() };
  const d = getCoopDefaults();
  const eggFallback = Number(d.eggPrice) || 0, meatFallback = Number(d.pricePerLb) || 0;
  STATE.eggs.forEach(e => { const i = yr(e.date); if (i < 0) return; const c = Number(e.count) || 0; out.eggs[i] += c; out.eggValue[i] += c * (Number(e.price_per_egg) || eggFallback); });
  STATE.birds.forEach(b => {
    if (b.status === "Processed") { const i = yr(b.harvest_date); if (i >= 0) { const w = Number(b.harvest_weight) || 0; out.meatLb[i] += w; out.meatValue[i] += w * (Number(b.price_per_lb) || meatFallback); } }
    if (b.status === "Deceased") { const i = yr(b.death_date); if (i >= 0) out.losses[i]++; }
    const i = yr(b.acquired_date || b.hatch_date); if (i >= 0) out.newBirds[i]++;
  });
  STATE.expenses.forEach(x => { const i = yr(x.date); if (i < 0) return; if (x.entry_type === "income") out.income[i] += Number(x.amount) || 0; else out.spent[i] += Number(x.amount) || 0; });
  STATE.supplies.forEach(s => { if (!s.date_emptied) return; const i = yr(s.date_emptied); if (i < 0) return; const q = Number(s.quantity) || 0; if (s.category === "Layer Feed") out.layerFeed[i] += q; else if (s.category === "Meat Feed") out.meatFeed[i] += q; else if (s.category === "Bedding") out.bedding[i] += q; });
  STATE.bedding.forEach(b => { if (b.entry_type !== "Full Clean-out") return; const i = yr(b.date); if (i >= 0) out.cleanouts[i]++; });
  const hatchYear = {}; STATE.hatches.forEach(h => { hatchYear[h.id] = yr(h.date_started); });
  STATE.hatchEggs.forEach(e => { const i = hatchYear[e.hatch_id]; if (i >= 0 && e.status === "Hatched") out.chicks[i]++; });
  out.value = out.eggValue.map((v, i) => v + out.meatValue[i] + out.income[i]);
  // Running total, matching the dashboard's net sparkline: a per-bucket net
  // just showed which periods carried a big purchase, whereas the card is
  // really asking about trajectory -- am I climbing back or still sinking?
  out.net = (() => { let r = 0; return out.value.map((v, i) => (r += v - out.spent[i])); })();
  return out;
}

function computeYearStats(year) {
  const inYear = (d) => d && d.slice(0, 4) === year;

  const eggsInYear = STATE.eggs.filter(e => inYear(e.date));
  const eggCount = eggsInYear.reduce((s, e) => s + (Number(e.count) || 0), 0);
  const rawEggValue = eggsInYear.reduce((s, e) => s + (Number(e.count) || 0) * (Number(e.price_per_egg) || 0), 0);

  const expensesInYear = STATE.expenses.filter(x => inYear(x.date));
  const trueExpensesInYear = expensesInYear.filter(x => x.entry_type !== "income");
  const incomeInYear = expensesInYear.filter(x => x.entry_type === "income");
  const totalExpenses = trueExpensesInYear.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const categoryBreakdown = {};
  trueExpensesInYear.forEach(x => { categoryBreakdown[x.category] = (categoryBreakdown[x.category] || 0) + (Number(x.amount) || 0); });

  const processedInYear = STATE.birds.filter(b => b.status === "Processed" && inYear(b.harvest_date));
  const processedWeight = processedInYear.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  const rawMeatValue = processedInYear.reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);

  // Same wash-out reasoning as the Coop tab's all-time figures: a real sale
  // washes out using its OWN locked-in price from the moment it was logged,
  // not a recomputed average -- so collecting more eggs/meat later in the
  // year can't reach back and re-price a sale that already happened.
  // Entries logged before this fix fall back to this year's weighted average.
  const defaults = getCoopDefaults();
  const eggPriceFallback = weightedAvgEggPrice(eggsInYear, Number(defaults.eggPrice) || 0);
  const meatPriceFallback = weightedAvgMeatPrice(processedInYear, Number(defaults.pricePerLb) || 0);
  const washedEggValue = incomeInYear.filter(x => x.category === "Egg Sale").reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : eggPriceFallback), 0);
  const washedMeatValue = incomeInYear.filter(x => x.category === "Meat Sale").reduce((s, x) => s + (Number(x.quantity) || 0) * (x.washout_unit_price != null ? Number(x.washout_unit_price) : meatPriceFallback), 0);
  const eggValue = Math.max(0, rawEggValue - washedEggValue);
  const meatValue = Math.max(0, rawMeatValue - washedMeatValue);
  const eggActualIncome = incomeInYear.filter(x => x.category === "Egg Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const meatActualIncome = incomeInYear.filter(x => x.category === "Meat Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const otherActualIncome = incomeInYear.filter(x => x.category !== "Egg Sale" && x.category !== "Meat Sale").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const actualIncome = eggActualIncome + meatActualIncome + otherActualIncome;
  const eggTotalValue = eggValue + eggActualIncome;
  const meatTotalValue = meatValue + meatActualIncome;

  const lossesInYear = STATE.birds.filter(b => b.status === "Deceased" && inYear(b.death_date)).length;
  const newBirdIds = new Set();
  const newLayerBirds = new Set(), newMeatBirds = new Set();
  STATE.birds.forEach(b => {
    if (inYear(b.acquired_date) || (inYear(b.hatch_date) && !b.acquired_date)) {
      newBirdIds.add(b.id);
      (b.type === "Meat" ? newMeatBirds : newLayerBirds).add(b.id);
    }
  });

  // Scoped by when each clutch started (individual outcomes don't carry
  // their own date, only the clutch does) -- a clutch spanning New Year's
  // counts toward the year it was set, not necessarily the year it hatched.
  const hatchesInYear = STATE.hatches.filter(h => inYear(h.date_started));
  const hatchesInYearIds = new Set(hatchesInYear.map(h => h.id));
  const hatchEggsInYear = STATE.hatchEggs.filter(e => hatchesInYearIds.has(e.hatch_id));
  const chicksHatched = hatchEggsInYear.filter(e => e.status === "Hatched").length;
  const hatchClear = hatchEggsInYear.filter(e => e.status === "Clear").length;
  const hatchQuit = hatchEggsInYear.filter(e => e.status === "Quit").length;
  const hatchFailed = hatchEggsInYear.filter(e => e.status === "Failed to Hatch").length;
  const hatchLoss = hatchClear + hatchQuit + hatchFailed;

  const cleanoutsInYear = STATE.bedding.filter(b => b.entry_type === "Full Clean-out" && inYear(b.date));
  const cleanoutsByArea = {};
  cleanoutsInYear.forEach(b => { cleanoutsByArea[b.area] = (cleanoutsByArea[b.area] || 0) + 1; });

  // Same reasoning as computeStats: a bird's sold_amount is already the one
  // real number for what it sold for, so there's no washout to reconcile
  // against the way eggs/meat need.
  const birdSaleValue = STATE.birds.filter(b => b.sold_date && inYear(b.sold_date) && Number(b.sold_amount) > 0).reduce((s, b) => s + Number(b.sold_amount), 0);
  const income = eggValue + meatValue + birdSaleValue + actualIncome;
  const net = income - totalExpenses;


  const suppliesEmptiedInYear = STATE.supplies.filter(s => s.date_emptied && inYear(s.date_emptied));
  let layerFeedLbs = suppliesEmptiedInYear.filter(s => s.category === "Layer Feed").reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  let meatFeedLbs = suppliesEmptiedInYear.filter(s => s.category === "Meat Feed").reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  let beddingCuFt = suppliesEmptiedInYear.filter(s => s.category === "Bedding").reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  // Only for the current year -- a bag that's currently 3/4 used but not
  // yet emptied genuinely belongs to "this year" if today is in this year,
  // the same reasoning the All-Time page already uses. For a past year this
  // wouldn't make sense (today's in-progress status isn't part of history),
  // so past years stay confirmed-emptied-only as before.
  if (year === String(new Date().getFullYear())) {
    const activeSum = (cat) => STATE.supplies.filter(s => s.category === cat && !s.date_emptied)
      .reduce((sum, s) => sum + (Number(s.quantity) || 0) * (STATUS_USED_FRACTION[s.status] ?? 0), 0);
    layerFeedLbs += activeSum("Layer Feed");
    meatFeedLbs += activeSum("Meat Feed");
    beddingCuFt += activeSum("Bedding");
  }

  return { eggCount, eggValue, totalExpenses, categoryBreakdown, processedCount: processedInYear.length, processedWeight, meatValue, birdSaleValue, lossesInYear, newBirds: newBirdIds.size, newLayerBirds: newLayerBirds.size, newMeatBirds: newMeatBirds.size, cleanoutsByArea, income, net, actualIncome, eggActualIncome, meatActualIncome, eggTotalValue, meatTotalValue, layerFeedLbs, meatFeedLbs, beddingCuFt, chicksHatched, hatchClear, hatchQuit, hatchFailed, hatchLoss };
}

function renderYearReviewSection() {
  const el = document.getElementById("coopSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const years = allCoopYears();
  if (years.length === 0) { el.innerHTML = `<div class="card"><div class="empty">No dated entries yet — log some eggs, expenses, or birds first.</div></div>`; return; }
  const currentYear = String(new Date().getFullYear());
  const selectedYear = years.includes(reviewYear) ? reviewYear : (years.includes(currentYear) ? currentYear : years[0]);
  reviewYear = selectedYear;
  const s = computeYearStats(selectedYear);
  const tm = monthlyTrends(selectedYear); // per-month series for the card sparklines
  // Prior year's stats for year-over-year deltas, but only when we actually
  // have data for that year (a coop's first year has nothing to compare to).
  const prevYear = String(Number(selectedYear) - 1);
  const hasPrev = years.includes(prevYear);
  const sp = hasPrev ? computeYearStats(prevYear) : null;
  // A delta chip comparing this year's value to last year's, labeled with the
  // actual year. goodUp=false for things where more is worse (losses, spend).
  const yoy = (cur, prev, goodUp = true) => hasPrev ? deltaChipHtml(cur, prev, { goodUp, label: prevYear }) : "";
  const yoyAbs = (cur, prev, goodUp = true) => hasPrev ? deltaChipHtmlAbs(cur, prev, { goodUp, label: prevYear }) : "";

  el.innerHTML = `
    <div class="toolbar">
      <div class="card-title" style="margin:0">Year in review</div>
      <select id="reviewYearSelect" style="max-width:140px">${years.map(y => `<option value="${y}" ${y === selectedYear ? "selected" : ""}>${y}</option>`).join("")}</select>
    </div>

    <div class="grid-stats-2" style="margin-bottom:16px">
      ${statPanel("sage", "🪶", "Flock",
        statPanelHero("New Birds This Year", s.newBirds, { chip: yoy(s.newBirds, sp && sp.newBirds) })
        + statPanelRows(
          statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} New layers`, s.newLayerBirds)
          + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} New meat birds`, s.newMeatBirds)
          + statPanelRow("Processed this year", s.processedCount)
          + statPanelRow("Losses this year", s.lossesInYear, s.lossesInYear > 0 ? "rust" : "")
        )
        + statPanelSubhead("🌾 Feed & Bedding")
        + statPanelRows(
          statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} Layer feed used`, `${displayWeight(s.layerFeedLbs)} ${getWeightUnit()}`)
          + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} Meat feed used`, `${displayWeight(s.meatFeedLbs)} ${getWeightUnit()}`)
          + statPanelRow("Bedding used", `${s.beddingCuFt.toFixed(1)} cu ft`)
        )
        + statPanelSubhead("🐣 Hatching")
        + statPanelRows(
          statPanelRow("Chicks hatched", s.chicksHatched)
          + statPanelRow("Lost from hatching", s.hatchLoss, s.hatchLoss > 0 ? "rust" : "")
          + statPanelRow("Clear · Quit · Failed", `${s.hatchClear} · ${s.hatchQuit} · ${s.hatchFailed}`)
        ), "flock"
      )}
      ${statPanel("gold", "💲", "Value",
        statPanelHero("Value Produced", fmtMoney(s.income), { chip: yoy(s.income, sp && sp.income) })
        + statPanelRows(
          statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} Eggs collected`, s.eggCount)
          + statPanelRow("Income from eggs", fmtMoney(s.eggTotalValue))
          + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} Meat processed`, s.processedWeight > 0 ? `${displayWeight(s.processedWeight)} ${getWeightUnit()}` : "—")
          + statPanelRow("Income from meat", fmtMoney(s.meatTotalValue))
          + statPanelRow("Avg weight / bird", s.processedCount > 0 ? weightLabel(s.processedWeight / s.processedCount) : "—")
        )
        + statPanelSubhead("💵 Finances")
        + statPanelHeroPair(
          statPanelHero("Spent", fmtMoney(s.totalExpenses), { chip: yoy(s.totalExpenses, sp && sp.totalExpenses, false) }),
          statPanelHero(`Net for ${selectedYear}`, fmtMoney(s.net), { chip: yoyAbs(s.net, sp && sp.net), valueTone: s.net >= 0 ? "sage" : "rust" })
        ), "expenses"
      )}
    </div>

    ${(() => {
      const yearTest = (d) => d && d.slice(0, 4) === selectedYear;
      const dozenBreakdown = costPerDozenBreakdown(s.eggCount, yearTest);
      const meatBreakdown = costPerLbMeatBreakdown(s.processedWeight, yearTest);
      const cards = feedCostHeadlineHtml(dozenBreakdown, meatBreakdown, selectedYear);
      if (!cards) return "";
      return `<div style="margin-bottom:16px">${cards}
        <div class="dim" style="font-size:11px;margin-top:8px">Based on feed actually consumed this year, valued at each bag's cost.</div>
      </div>`;
    })()}

    <div class="chart-grid chart-grid-stretch" style="margin-top:16px">
      <div class="card"><div class="chart-head chart-head-grow">
        ${reviewProduceType === "meat"
          ? `<div class="card-title">🍗 Meat by month, ${getWeightUnit()} — ${selectedYear}${hasPrev ? ` vs ${prevYear}` : ""}</div>`
          : `<div class="card-title">🥚 Eggs by month — ${selectedYear}${hasPrev ? ` vs ${prevYear}` : ""}</div>`}
        <div class="pill-row" id="reviewProduceType">
          ${[["eggs", `${BIRD_TYPE_ICONS.layer.emoji} Eggs`], ["meat", `${BIRD_TYPE_ICONS.meat.emoji} Meat`]].map(([v, label]) => `<button class="pill-btn ${reviewProduceType === v ? "range-btn active" : ""}" data-produce-type="${v}">${label}</button>`).join("")}
        </div>
      </div><div class="chart-box"><canvas id="reviewProduceChart"></canvas></div></div>
      <div class="card"><div class="chart-head chart-head-grow">
        <div class="card-title">🌾 Feed by month${reviewFeedType === "layer" ? " — layer" : reviewFeedType === "meat" ? " — meat" : ""} (${getWeightUnit()}) — ${selectedYear}${hasPrev ? ` vs ${prevYear}` : ""}</div>
        <div class="pill-row" id="reviewFeedType">
          ${[["both", "Both"], ["layer", `${BIRD_TYPE_ICONS.layer.emoji} Layer`], ["meat", `${BIRD_TYPE_ICONS.meat.emoji} Meat`]].map(([v, label]) => `<button class="pill-btn ${reviewFeedType === v ? "range-btn active" : ""}" data-feed-type="${v}">${label}</button>`).join("")}
        </div>
      </div><div class="chart-box"><canvas id="reviewFeedChart"></canvas></div></div>
      <div class="card" style="grid-column:1/-1"><div class="chart-head chart-head-grow"><div class="money-mega-head"><div class="card-title">${reviewMoneyMode === "income" ? "💰 Income / value" : reviewMoneyMode === "net" ? "⚖️ Net" : "💵 Spend"} by month — ${selectedYear}${hasPrev ? ` vs ${prevYear}` : ""}${reviewMoneyMode === "spend" && reviewSpendPill.size ? ` · ${esc(pillLabel(reviewSpendPill))}` : reviewMoneyMode === "income" && reviewIncomePill.size ? ` · ${esc(pillLabel(reviewIncomePill))}` : ""}</div>
        <div class="pill-row money-mode-pills" id="reviewMoneyMode">
          ${[["spend", "💵 Spend"], ["income", "💰 Income"], ["net", "⚖️ Net"]].map(([v, label]) => `<button class="pill-btn ${reviewMoneyMode === v ? "range-btn active" : ""}" data-money-mode="${v}">${label}</button>`).join("")}
        </div></div>
        ${reviewMoneyMode === "spend" ? `<div class="pill-row" id="reviewSpendPills">
          <button class="pill-btn ${reviewSpendPill.size === 0 ? "range-btn active" : ""}" data-spend-pill="">All</button>
          ${spendCategoriesPresent().map(c => `<button class="pill-btn ${reviewSpendPill.has(c) ? "range-btn active" : ""}" data-spend-pill="${esc(c)}">${(CATEGORY_ICONS[c] || CATEGORY_ICONS["Other"]).emoji} ${esc(c)}</button>`).join("")}
        </div>` : reviewMoneyMode === "income" ? `<div class="pill-row" id="reviewIncomePills">
          <button class="pill-btn ${reviewIncomePill.size === 0 ? "range-btn active" : ""}" data-income-pill="">All</button>
          ${incomeSourcesPresent().map(src => { const ic = incomeSourceIcon(src); return `<button class="pill-btn ${reviewIncomePill.has(src) ? "range-btn active" : ""}" data-income-pill="${esc(src)}">${ic.emoji} ${esc(src)}</button>`; }).join("")}
        </div>` : ""}
      </div><div class="chart-box"><canvas id="reviewExpenseChart"></canvas></div>
        ${(() => {
          const inYearTest = (d) => d && d.slice(0, 4) === selectedYear;
          const spendBars = () => spendCategoryBarsHtml(s.categoryBreakdown, { title: "Where it went", totalLabel: `Total spent in ${selectedYear}`, bare: true });
          const valueBars = () => valueSourceBarsHtml(valueBreakdownIn(inYearTest), { title: "Where it came from", totalLabel: `Total value in ${selectedYear}`, bare: true });
          if (reviewMoneyMode === "spend") return `<div class="money-breakdown">${spendBars()}</div>`;
          if (reviewMoneyMode === "income") return `<div class="money-breakdown">${valueBars()}</div>`;
          return `<div class="money-breakdown money-breakdown-2">${valueBars()}${spendBars()}</div>`;
        })()}
      </div>
    </div>
  `;
  document.getElementById("reviewYearSelect").addEventListener("change", (e) => { reviewYear = e.target.value; renderYearReviewSection(); });
  const moneyModeToggle = document.getElementById("reviewMoneyMode");
  if (moneyModeToggle) moneyModeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-money-mode]");
    if (!btn) return;
    reviewMoneyMode = btn.dataset.moneyMode;
    renderYearReviewSection();
  });
  const reviewSpendPillsEl = document.getElementById("reviewSpendPills");
  if (reviewSpendPillsEl) reviewSpendPillsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-spend-pill]");
    if (!btn) return;
    togglePillSelection(reviewSpendPill, btn.dataset.spendPill);
    renderYearReviewSection();
  });
  const reviewIncomePillsEl = document.getElementById("reviewIncomePills");
  if (reviewIncomePillsEl) reviewIncomePillsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-income-pill]");
    if (!btn) return;
    togglePillSelection(reviewIncomePill, btn.dataset.incomePill);
    renderYearReviewSection();
  });
  const reviewProduceToggle = document.getElementById("reviewProduceType");
  if (reviewProduceToggle) reviewProduceToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-produce-type]");
    if (!btn) return;
    reviewProduceType = btn.dataset.produceType;
    renderYearReviewSection();
  });
  const reviewFeedToggle = document.getElementById("reviewFeedType");
  if (reviewFeedToggle) reviewFeedToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-feed-type]");
    if (!btn) return;
    reviewFeedType = btn.dataset.feedType;
    renderYearReviewSection();
  });
  wireStatPanelGoto(el);
  wireCostBreakdownCards(el);
  drawYearReviewCharts(selectedYear);
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Same gold-serif convention across every dense form (bird, supply, expense)
 * -- grouping fields into named sections instead of one long undifferentiated
 * grid, so a form with a dozen fields reads as a handful of small decisions
 * rather than one big one. */
const FORM_SECTION_HEAD = "font-family:'Roboto Slab',serif;font-weight:700;font-size:12px;color:var(--gold);letter-spacing:0.3px;text-transform:uppercase;margin:16px 0 6px";
function monthlyBuckets(items, year, valueFn) {
  const arr = new Array(12).fill(0);
  items.forEach(it => {
    if (it.date && it.date.slice(0, 4) === year) {
      const m = parseInt(it.date.slice(5, 7), 10) - 1;
      if (m >= 0 && m < 12) arr[m] += valueFn(it);
    }
  });
  return arr;
}

let reviewCharts = {};

/** Feed consumed (lb) per month across a year, by feed type. Uses the same
 * bag ramp as everywhere else, so a bag spanning a month boundary splits by
 * the days it was actually eaten in each. Per-month totals (not cumulative):
 * birds eat every month, so each bucket is meaningfully non-zero. */
function feedMonthlyForYear(year, feedType = "both") {
  const arr = new Array(12).fill(0);
  const today = todayStr();
  const cats = feedType === "layer" ? ["Layer Feed"] : feedType === "meat" ? ["Meat Feed"] : ["Layer Feed", "Meat Feed"];
  STATE.supplies.filter(s => cats.includes(s.category)).forEach(s => {
    const ramp = bagRamp(s, today);
    if (!ramp) return;
    for (let i = 0; i < ramp.spanDays; i++) {
      const day = addDays(ramp.start, i);
      if (day.slice(0, 4) !== year) continue;
      const m = parseInt(day.slice(5, 7), 10) - 1;
      if (m >= 0 && m < 12) arr[m] += ramp.perDay;
    }
  });
  return arr;
}

/** 12-month array of money for a year, honoring mode (spend/income/net) and an
 * optional pill. Income value = egg value + meat value + other income (egg/
 * meat sales washed out); net = income − spend. Mirrors the dashboard's daily
 * money series but bucketed by month. */
function moneyMonthlyForYear(year, mode, pill) {
  const eggFallback = Number(getCoopDefaults().eggPrice) || 0, meatFallback = Number(getCoopDefaults().pricePerLb) || 0;
  const eggVal = monthlyBuckets(STATE.eggs.map(e => ({ date: e.date, v: (Number(e.count) || 0) * (Number(e.price_per_egg) || eggFallback) })), year, it => it.v);
  const meatVal = monthlyBuckets(STATE.birds.filter(b => b.status === "Processed" && b.harvest_date).map(b => ({ date: b.harvest_date, v: (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || meatFallback) })), year, it => it.v);
  // cats: null/empty Set means "all"; otherwise a Set of names to include --
  // lets a chart's pills be multi-select (tap Layer Feed and Meat Feed, get
  // both together) rather than only "all" or "exactly one."
  const otherIncome = (cats) => { const active = cats && cats.size > 0; return monthlyBuckets(STATE.expenses.filter(x => x.entry_type === "income" && x.category !== "Egg Sale" && x.category !== "Meat Sale" && (!active || cats.has(x.category))), year, x => Number(x.amount) || 0); };
  const spend = (cats) => { const active = cats && cats.size > 0; return monthlyBuckets(STATE.expenses.filter(x => x.entry_type !== "income" && (!active || cats.has(x.category))), year, x => Number(x.amount) || 0); };
  const add = (...arrs) => arrs[0].map((_, i) => arrs.reduce((s, a) => s + a[i], 0));

  // Cumulative across the year for income and net, matching the dashboard --
  // but NOT for spend: a running total answers "how much have I spent so
  // far," while the point of a monthly spend chart is "did feed cost more in
  // March than April," which only a per-month (non-cumulative) bar answers.
  const runningTotal = (arr) => { let r = 0; return arr.map(v => (r += v)); };
  if (mode === "spend") return spend(pill);
  if (mode === "income") {
    const active = pill && pill.size > 0;
    const wantEgg = !active || pill.has("Egg value");
    const wantMeat = !active || pill.has("Meat value");
    const zeros = eggVal.map(() => 0);
    // "Egg value"/"Meat value" are synthetic source names, not real expense
    // categories -- passing the raw Set into otherIncome() is safe, they
    // simply never match any x.category and are harmlessly ignored there.
    return runningTotal(add(wantEgg ? eggVal : zeros, wantMeat ? meatVal : zeros, otherIncome(active ? pill : null)));
  }
  // net = running total of (income value − spend) across the months, so the
  // line ends at the year's net and a zero-crossing marks break-even.
  const income = add(eggVal, meatVal, otherIncome(null));
  const sp = spend(null);
  let run = 0;
  return income.map((v, i) => (run += v - sp[i]));
}
/** Per-month spend broken out by category, for the "All" stacked-bar view --
 * one dataset per category actually spent in that year (categories with
 * nothing spent are left out rather than cluttering the legend with empty
 * ones), each colored to match its icon tile everywhere else in the app. */
function spendCategoryMonthlyForYear(year) {
  const cats = [...new Set(STATE.expenses.filter(x => x.entry_type !== "income" && x.date && x.date.slice(0, 4) === year).map(x => x.category))];
  return cats.map(cat => ({
    category: cat,
    color: (CATEGORY_ICONS[cat] || CATEGORY_ICONS["Other"]).from,
    data: monthlyBuckets(STATE.expenses.filter(x => x.entry_type !== "income" && x.category === cat), year, x => Number(x.amount) || 0),
  })).filter(d => d.data.some(v => v > 0));
}
/** Per-month income broken out by source, for the "All" stacked-bar view --
 * Egg value / Meat value (if produced that year) plus each other-income
 * category actually logged, each colored to match incomeSourceIcon's spec
 * used for the pills, so a bar segment's color always matches its pill. */
function incomeSourceMonthlyForYear(year) {
  const eggFallback = Number(getCoopDefaults().eggPrice) || 0, meatFallback = Number(getCoopDefaults().pricePerLb) || 0;
  const out = [];
  const eggData = monthlyBuckets(STATE.eggs.map(e => ({ date: e.date, v: (Number(e.count) || 0) * (Number(e.price_per_egg) || eggFallback) })), year, it => it.v);
  if (eggData.some(v => v > 0)) out.push({ source: "Egg value", color: incomeSourceIcon("Egg value").from, data: eggData });
  const meatData = monthlyBuckets(STATE.birds.filter(b => b.status === "Processed" && b.harvest_date).map(b => ({ date: b.harvest_date, v: (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || meatFallback) })), year, it => it.v);
  if (meatData.some(v => v > 0)) out.push({ source: "Meat value", color: incomeSourceIcon("Meat value").from, data: meatData });
  const otherCats = [...new Set(STATE.expenses.filter(x => x.entry_type === "income" && x.category !== "Egg Sale" && x.category !== "Meat Sale" && x.date && x.date.slice(0, 4) === year).map(x => x.category))];
  otherCats.forEach(cat => {
    const data = monthlyBuckets(STATE.expenses.filter(x => x.entry_type === "income" && x.category === cat), year, x => Number(x.amount) || 0);
    if (data.some(v => v > 0)) out.push({ source: cat, color: incomeSourceIcon(cat).from, data });
  });
  return out;
}
/** Raw (non-cumulative) per-month income and spend totals, all sources and
 * categories combined -- the context bars behind the Net chart's running-
 * total line, so "did I net positive this specific month" is visible
 * alongside "where does my running balance stand." */
function incomeSpendMonthlyForYear(year) {
  const eggFallback = Number(getCoopDefaults().eggPrice) || 0, meatFallback = Number(getCoopDefaults().pricePerLb) || 0;
  const eggVal = monthlyBuckets(STATE.eggs.map(e => ({ date: e.date, v: (Number(e.count) || 0) * (Number(e.price_per_egg) || eggFallback) })), year, it => it.v);
  const meatVal = monthlyBuckets(STATE.birds.filter(b => b.status === "Processed" && b.harvest_date).map(b => ({ date: b.harvest_date, v: (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || meatFallback) })), year, it => it.v);
  const otherInc = monthlyBuckets(STATE.expenses.filter(x => x.entry_type === "income" && x.category !== "Egg Sale" && x.category !== "Meat Sale"), year, x => Number(x.amount) || 0);
  const income = eggVal.map((v, i) => v + meatVal[i] + otherInc[i]);
  const spend = monthlyBuckets(STATE.expenses.filter(x => x.entry_type !== "income"), year, x => Number(x.amount) || 0);
  return { income, spend };
}

function drawYearReviewCharts(year) {
  Object.values(reviewCharts).forEach(c => c && c.destroy());
  const s = computeYearStats(year);
  const lastYear = String(Number(year) - 1);
  const hasPrev = allCoopYears().includes(lastYear);
  // Dotted last-year overlay, matching the dashboard's month-comparison style,
  // so each monthly chart shows this year solid vs last year dotted.
  const prevDash = (color) => ({ borderColor: color, borderDash: [4, 4], backgroundColor: "transparent", pointRadius: 0, tension: 0.25, fill: false });
  const withPrev = (mainDs, prevData, prevColor) => hasPrev
    ? [mainDs, { label: lastYear, data: prevData, ...prevDash(prevColor) }]
    : [mainDs];

  // ---- Produce: eggs (line) or meat (bars), toggled -- mirrors the dashboard
  const produceEl = document.getElementById("reviewProduceChart");
  if (produceEl) {
    if (reviewProduceType === "meat") {
      const meatItems = STATE.birds.filter(b => b.status === "Processed" && b.harvest_date).map(b => ({ date: b.harvest_date, weight: Number(b.harvest_weight) || 0 }));
      const meatMonthly = monthlyBuckets(meatItems, year, (it) => it.weight);
      const meatPrev = hasPrev ? monthlyBuckets(meatItems, lastYear, (it) => it.weight) : null;
      const ds = [{ label: year, data: meatMonthly, backgroundColor: "#C1502E", borderColor: "#C1502E", type: "bar" }];
      if (hasPrev) ds.push({ label: lastYear, data: meatPrev, ...prevDash("#C7B9A6"), type: "line" });
      reviewCharts.produce = new Chart(produceEl, {
        data: { labels: MONTH_LABELS, datasets: ds },
        options: yearChartOpts(hasPrev, (v) => `${displayWeight(v)} ${getWeightUnit()}`)
      });
    } else {
      const eggMonthly = monthlyBuckets(STATE.eggs, year, e => Number(e.count) || 0);
      const eggPrev = hasPrev ? monthlyBuckets(STATE.eggs, lastYear, e => Number(e.count) || 0) : null;
      reviewCharts.produce = new Chart(produceEl, {
        type: "line",
        data: { labels: MONTH_LABELS, datasets: withPrev({ label: year, data: eggMonthly, borderColor: "#D4A017", backgroundColor: "#D4A01733", tension: 0.25, pointRadius: 2, fill: true }, eggPrev, "#C7B9A6") },
        options: yearChartOpts(hasPrev)
      });
    }
  }

  // ---- Feed by month, by type -- same toggle and colors as the dashboard ----
  const feedEl = document.getElementById("reviewFeedChart");
  if (feedEl) {
    const feedMonthly = feedMonthlyForYear(year, reviewFeedType).map(weightNum);
    const feedPrev = hasPrev ? feedMonthlyForYear(lastYear, reviewFeedType).map(weightNum) : null;
    const fc = reviewFeedType === "layer" ? "#D4A017" : reviewFeedType === "meat" ? "#C1502E" : "#7A8FA6";
    reviewCharts.feed = new Chart(feedEl, {
      type: "line",
      data: { labels: MONTH_LABELS, datasets: withPrev({ label: year, data: feedMonthly, borderColor: fc, backgroundColor: fc + "33", tension: 0.25, pointRadius: 2, fill: true }, feedPrev, "#C7B9A6") },
      options: yearChartOpts(hasPrev, (v) => `${v.toFixed(1)} ${getWeightUnit()}`)
    });
  }

  // Money mega chart. Income and Net stay cumulative line charts, matching
  // the dashboard's running-total convention. Spend is different on purpose:
  // a bar chart, per month rather than running, and stacked by category when
  // viewing "All" -- a running total only answers "how much so far," while a
  // monthly bar answers "did feed cost more in March than April," which is
  // the actual question a spend-over-the-year chart exists to answer.
  if (reviewMoneyMode === "spend") {
    const moneyOpts = yearChartOpts(hasPrev, (v) => fmtMoney(v));
    moneyOpts.scales.x.stacked = true;
    moneyOpts.scales.y.stacked = true;
    // One stacked bar per category, always -- selecting one or more pills
    // just narrows WHICH categories participate in the stack (tap Layer Feed
    // and Meat Feed, see both as separate colored segments in each month's
    // bar); "All" is the same code path with nothing filtered out.
    let cats = spendCategoryMonthlyForYear(year);
    if (reviewSpendPill.size > 0) cats = cats.filter(c => reviewSpendPill.has(c.category));
    const datasets = cats.length
      ? cats.map(c => ({ label: c.category, data: c.data, backgroundColor: c.color, borderRadius: 2 }))
      : [{ label: year, data: Array(12).fill(0), backgroundColor: "#B84C3E", borderRadius: 3 }];
    // The legend is how a stacked bar's colors get identified back to
    // category names -- always shown here, unlike the single-line charts
    // below where it's only worth the space when comparing two years.
    moneyOpts.plugins.legend = { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } };
    if (hasPrev) datasets.push({ type: "line", label: lastYear, data: moneyMonthlyForYear(lastYear, "spend", reviewSpendPill), ...prevDash("#C7B9A6") });
    reviewCharts.expenses = new Chart(document.getElementById("reviewExpenseChart"), {
      type: "bar",
      data: { labels: MONTH_LABELS, datasets },
      options: moneyOpts
    });
  } else if (reviewMoneyMode === "income") {
    const moneyOpts = yearChartOpts(hasPrev, (v) => fmtMoney(v));
    moneyOpts.scales.x.stacked = true;
    moneyOpts.scales.y.stacked = true;
    // Same multi-select-stack pattern as Spend, just by income source
    // (Egg value, Meat value, other income categories) instead of category.
    let srcs = incomeSourceMonthlyForYear(year);
    if (reviewIncomePill.size > 0) srcs = srcs.filter(s => reviewIncomePill.has(s.source));
    const datasets = srcs.length
      ? srcs.map(s => ({ label: s.source, data: s.data, backgroundColor: s.color, borderRadius: 2 }))
      : [{ label: year, data: Array(12).fill(0), backgroundColor: "#8A9A5B", borderRadius: 3 }];
    moneyOpts.plugins.legend = { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } };
    if (hasPrev) {
      let prevSrcs = incomeSourceMonthlyForYear(lastYear);
      if (reviewIncomePill.size > 0) prevSrcs = prevSrcs.filter(s => reviewIncomePill.has(s.source));
      const prevTotal = Array(12).fill(0).map((_, i) => prevSrcs.reduce((sum, s) => sum + s.data[i], 0));
      datasets.push({ type: "line", label: lastYear, data: prevTotal, ...prevDash("#C7B9A6") });
    }
    reviewCharts.expenses = new Chart(document.getElementById("reviewExpenseChart"), {
      type: "bar",
      data: { labels: MONTH_LABELS, datasets },
      options: moneyOpts
    });
  } else {
    // Net: income and spend as per-month diverging bars (income up, spend
    // down -- so a month's balance is visible as the gap between them),
    // with the running Net balance threaded through as a line. The two live
    // on separate scales (left: per-month magnitude, right: cumulative
    // balance) since a whole year's running total and one month's spend can
    // be wildly different sizes -- sharing one axis would flatten the bars
    // to nothing by December.
    const { income, spend } = incomeSpendMonthlyForYear(year);
    const netLine = moneyMonthlyForYear(year, "net", null);
    const moneyOpts = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(Math.abs(ctx.parsed.y))}` } },
      },
      scales: {
        x: { stacked: true, ticks: { color: "#C7B9A6", font: { size: 10 }, maxRotation: 0 }, grid: { color: "#5A4B3C40" } },
        y: { position: "left", ticks: { color: "#C7B9A6", font: { size: 10 }, callback: (v) => fmtMoney(Math.abs(v)) }, grid: { color: "#5A4B3C40" } },
        y1: { position: "right", ticks: { color: "#D4A017", font: { size: 10 } }, grid: { display: false } },
      }
    };
    const datasets = [
      { type: "bar", label: "Income", data: income, backgroundColor: "#8A9A5B", borderRadius: 2, yAxisID: "y" },
      { type: "bar", label: "Spend", data: spend.map(v => -v), backgroundColor: "#B84C3E", borderRadius: 2, yAxisID: "y" },
      {
        type: "line", label: "Net balance", data: netLine, borderWidth: 2,
        backgroundColor: "transparent", tension: 0.25, pointRadius: 2, fill: false, yAxisID: "y1",
        // Gold above zero / rust below -- distinct from the green/red bars
        // so the line reads as its own thing threading through, not a third
        // bar color, while still marking the zero-crossing (the month the
        // running balance flipped) the same way it always has.
        borderColor: "#D4A017",
        segment: { borderColor: (ctx) => (ctx.p1.parsed.y != null && ctx.p1.parsed.y < 0 ? "#B84C3E" : "#D4A017") },
      },
    ];
    reviewCharts.expenses = new Chart(document.getElementById("reviewExpenseChart"), {
      type: "bar",
      data: { labels: MONTH_LABELS, datasets },
      options: moneyOpts
    });
  }

}

/** Year Review monthly chart options: legend shown only when a prior-year
 * overlay is present, x-axis is the 12 month labels. */
function yearChartOpts(showLegend, yFormatter) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: showLegend ? { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } } : { display: false },
      tooltip: { callbacks: yFormatter ? { label: (ctx) => `${ctx.dataset.label}: ${yFormatter(ctx.parsed.y)}` } : undefined },
    },
    scales: {
      x: { ticks: { color: "#C7B9A6", font: { size: 10 }, maxRotation: 0 }, grid: { color: "#5A4B3C40" } },
      y: { ticks: { color: "#C7B9A6", font: { size: 10 } }, grid: { color: "#5A4B3C40" }, beginAtZero: true }
    }
  };
}

function beddingStatsFor(area) {
  const entries = STATE.bedding.filter(b => b.area === area);
  const cleanouts = entries.filter(b => b.entry_type === "Full Clean-out").sort((a, b) => b.date.localeCompare(a.date));
  const lastCleanout = cleanouts[0] || null;
  const topoffsSince = entries.filter(b => (b.entry_type === "Top-off" || b.entry_type === "Top-off + Churn" || b.entry_type === "Top-off / Churn") && (!lastCleanout || b.date > lastCleanout.date)).length;
  const lastActivity = entries.length ? entries.reduce((latest, e) => (!latest || e.date > latest.date) ? e : latest, null) : null;
  // A top-off-only visit doesn't accomplish the actual churning task, so it
  // shouldn't be able to satisfy the churn-due countdown on its own -- only
  // entries where churning genuinely happened count here. A full clean-out
  // obviously also resets it, since fresh bedding has nothing to churn yet.
  // "Top-off / Churn" (the old combined label, before this split existed)
  // is included too, so existing history keeps counting the same way it
  // always did rather than suddenly looking overdue the moment this ships.
  const churnEntries = entries.filter(b => b.entry_type === "Churn" || b.entry_type === "Top-off + Churn" || b.entry_type === "Full Clean-out" || b.entry_type === "Top-off / Churn");
  const lastChurn = churnEntries.length ? churnEntries.reduce((latest, e) => (!latest || e.date > latest.date) ? e : latest, null) : null;
  return { lastCleanout, topoffsSince, lastActivity, lastChurn };
}

function getCoopSettings() {
  const coop = STATE.coops.find(c => c.id === currentCoopId);
  if (!coop || !coop.settings) return {};
  try { return JSON.parse(coop.settings); } catch { return {}; }
}
const LB_TO_KG = 0.45359237;
/** Supply-alert categories the person has muted for this coop (e.g. Meat
 * Feed while there are no meat birds this season) -- stored the same way as
 * weight_unit, in the coop's settings JSON. */
function getMutedAlertCategories() {
  const m = getCoopSettings().muted_alert_categories;
  return Array.isArray(m) ? m : [];
}
function getWeightUnit() {
  return getCoopSettings().weight_unit === "kg" ? "kg" : "lb"; // lb is the default/canonical storage unit
}
/** Converts a weight stored internally in lb to the user's preferred
 * display unit, rounded sensibly for display. Returns "" for empty input
 * so it's safe to drop straight into a form field's value. */
function displayWeight(lbValue) {
  if (lbValue == null || lbValue === "") return "";
  const n = Number(lbValue);
  if (isNaN(n)) return "";
  return getWeightUnit() === "kg" ? String(+(n * LB_TO_KG).toFixed(2)) : String(+n.toFixed(2));
}
/** Weight as read-only display text, honoring the same lb+oz convention as
 * weightEntryFieldHtml -- "5 lb 15 oz" in lb mode (how a kitchen scale reads
 * out), a plain decimal ("2.69 kg") in kg mode. Used anywhere a weight shows
 * as a label rather than an editable field (flock cards, list rows). */
function weightLabel(lbValue) {
  if (lbValue == null || lbValue === "") return "";
  if (getWeightUnit() !== "lb") return `${displayWeight(lbValue)} ${getWeightUnit()}`;
  const { lb, oz } = lbToLbOz(lbValue);
  if (lb == null) return "";
  return oz > 0 ? `${lb} lb ${oz} oz` : `${lb} lb`;
}
/** Converts a value the user typed (in their preferred unit) back to lb
 * for storage -- the inverse of displayWeight. Returns null for empty
 * input so it's safe to drop straight into a payload's numeric field. */
function parseWeightInput(displayValue) {
  if (displayValue === "" || displayValue == null) return null;
  const n = Number(displayValue);
  if (isNaN(n)) return null;
  return getWeightUnit() === "kg" ? n / LB_TO_KG : n;
}
/** Splits a lb-stored weight into whole pounds + ounces, the way a kitchen
 * scale actually reads out (5 lb 15 oz), rather than the decimal pounds
 * (5.9375) a scale never shows. Only meaningful when displaying in lb --
 * metric scales read decimal kg or grams, not a kg+g split, so callers only
 * use this when getWeightUnit() === "lb". Returns nulls for empty input. */
function lbToLbOz(lbValue) {
  if (lbValue == null || lbValue === "") return { lb: null, oz: null };
  const n = Number(lbValue);
  if (isNaN(n) || n < 0) return { lb: null, oz: null };
  const wholeLb = Math.floor(n);
  // Round ounces rather than floor, so 5.9999 lb doesn't display as "5 lb 15
  // oz" and silently drop a sliver of weight -- round-half-up to 16 carries
  // into the next pound cleanly (e.g. 5.99999 -> 6 lb 0 oz).
  let oz = Math.round((n - wholeLb) * 16);
  let lb = wholeLb;
  if (oz === 16) { oz = 0; lb += 1; }
  return { lb, oz };
}
/** The inverse of lbToLbOz: whole pounds + ounces typed by the user, back to
 * the decimal-lb value the app stores everywhere. Either field can be blank
 * (treated as 0) so entering just "5 lb" or just "15 oz" both work. Returns
 * null if both are blank, same empty-input contract as parseWeightInput. */
function lbOzToLb(lbPart, ozPart) {
  const lb = lbPart === "" || lbPart == null ? 0 : Number(lbPart);
  const oz = ozPart === "" || ozPart == null ? 0 : Number(ozPart);
  if ((lbPart === "" || lbPart == null) && (ozPart === "" || ozPart == null)) return null;
  if (isNaN(lb) || isNaN(oz)) return null;
  return lb + oz / 16;
}
/** Renders a weight entry field: lb+oz side by side when the coop's weight
 * unit is lb (matching how a kitchen/postal scale reads out -- "5 lb 15 oz",
 * never "5.9375 lb"), or a single decimal field for kg, since metric scales
 * read decimal kg/g rather than a kg+g split. `idBase` is used as the prefix
 * for the field's input id(s); `existingLbValue` is the stored canonical lb
 * value (or null/empty for a new record). */
function weightEntryFieldHtml(idBase, existingLbValue, label) {
  if (getWeightUnit() !== "lb") {
    return `<label class="field"><span>${esc(label)} (${getWeightUnit()})</span><input type="number" step="0.1" id="${idBase}" value="${displayWeight(existingLbValue)}"></label>`;
  }
  const split = lbToLbOz(existingLbValue);
  return `<label class="field"><span>${esc(label)} (lb, oz)</span>
    <div style="display:flex;gap:6px;align-items:center">
      <input type="number" step="1" min="0" id="${idBase}_lb" value="${split.lb ?? ""}" placeholder="lb" style="width:0;flex:1">
      <span class="dim" style="font-size:12px">lb</span>
      <input type="number" step="1" min="0" max="15" id="${idBase}_oz" value="${split.oz ?? ""}" placeholder="oz" style="width:0;flex:1">
      <span class="dim" style="font-size:12px">oz</span>
    </div>
  </label>`;
}
/** Reads a field rendered by weightEntryFieldHtml back into a canonical lb
 * value -- the counterpart to that function, so the two never drift apart on
 * which unit mode is active. */
function readWeightEntryField(idBase) {
  if (getWeightUnit() !== "lb") {
    const el = document.getElementById(idBase);
    return el ? parseWeightInput(el.value) : null;
  }
  const lbEl = document.getElementById(`${idBase}_lb`);
  const ozEl = document.getElementById(`${idBase}_oz`);
  if (!lbEl && !ozEl) return null;
  return lbOzToLb(lbEl ? lbEl.value : "", ozEl ? ozEl.value : "");
}
/** True if a weightEntryFieldHtml field is actually in the DOM, in whichever
 * shape the current unit mode rendered it -- lets a save handler tell "field
 * wasn't shown at all" (leave the stored value alone) apart from "field was
 * shown but left blank" (readWeightEntryField already returns null for that). */
function weightFieldPresent(idBase) {
  return !!(document.getElementById(idBase) || document.getElementById(`${idBase}_lb`) || document.getElementById(`${idBase}_oz`));
}
/** Converts a stored $/lb rate to the user's preferred unit's equivalent
 * rate for display -- the INVERSE of the weight conversion, since a rate
 * scales the opposite way from a plain quantity. $5/lb is about $11.02/kg
 * (dividing by the lb-to-kg factor), not $2.27/kg -- a kg costs more
 * because it's the bigger unit, not less. */
/** Numeric form of displayWeight, for chart series data (displayWeight returns
 * a string, which Chart.js would treat as a category rather than a value). */
function weightNum(lbValue) {
  const n = Number(lbValue) || 0;
  return getWeightUnit() === "kg" ? +(n * LB_TO_KG).toFixed(2) : +n.toFixed(2);
}

function displayPricePerLb(dollarsPerLb) {
  if (dollarsPerLb == null || dollarsPerLb === "") return "";
  const n = Number(dollarsPerLb);
  if (isNaN(n)) return "";
  return getWeightUnit() === "kg" ? String(+(n / LB_TO_KG).toFixed(2)) : String(+n.toFixed(2));
}
/** Converts a $/kg (or $/lb) value the user typed back to $/lb for
 * storage -- the inverse of displayPricePerLb. */
function parsePricePerLbInput(displayValue) {
  if (displayValue === "" || displayValue == null) return null;
  const n = Number(displayValue);
  if (isNaN(n)) return null;
  return getWeightUnit() === "kg" ? n * LB_TO_KG : n;
}
function getBeddingAreas() {
  const s = getCoopSettings();
  return (s.bedding_areas && s.bedding_areas.length) ? s.bedding_areas : Object.keys(DEFAULT_BEDDING_THRESHOLDS);
}
function getBeddingThresholds(area) {
  const s = getCoopSettings();
  const t = (s.bedding_thresholds && s.bedding_thresholds[area]) || DEFAULT_BEDDING_THRESHOLDS[area] || { warn: 120, danger: 180 };
  return { warn: t.warn, danger: t.danger, churn: t.churn || 7 };
}

function cleanoutTone(days, area) {
  const t = getBeddingThresholds(area);
  if (days === null) return { tone: "slate", label: "No clean-out logged" };
  if (days > t.danger) return { tone: "danger", label: `${days}d since clean-out — overdue` };
  if (days > t.warn) return { tone: "gold", label: `${days}d since clean-out` };
  return { tone: "sage", label: `${days}d since clean-out` };
}

/** Tiny inline trend line for a stat card -- last 8 weeks, weekly buckets.
 * Deliberately axis-less and label-less: it's an at-a-glance shape ("rising,
 * falling, steady"), not a chart -- the real charts with the range toggle
 * live further down the same page. A flat baseline renders when everything
 * is zero so the card doesn't jump in height for a brand-new coop. */
/** One "hero" metric inside a stat panel: a label, a big mono value, an
 * optional delta chip, and an optional sparkline. Shared by the single-hero
 * and side-by-side paired-hero panel shapes. */
function statPanelHero(label, value, opts) {
  opts = opts || {};
  const chip = opts.chip || "";
  const valueTone = opts.valueTone ? ` tone-${opts.valueTone}` : "";
  return `<div class="stat-panel-hero">
    <div class="stat-panel-hero-label">${esc(label)}</div>
    <div class="stat-panel-hero-value-row"><div class="stat-panel-hero-value${valueTone}">${value}</div>${chip}</div>
  </div>`;
}
/** Two heroes side by side (e.g. Spent vs Net) -- both equally primary. */
function statPanelHeroPair(heroAHtml, heroBHtml) {
  return `<div class="stat-panel-hero-pair">${heroAHtml}${heroBHtml}</div>`;
}
/** One secondary row inside a panel: a label (an emoji prefix reads as an
 * icon) and a value, right-aligned in the same mono font the hero uses so a
 * panel's numbers all sit in one visual column. `tone` colors a value worth
 * flagging (e.g. "rust" for losses) -- used sparingly, not on every row, so
 * color stays a signal instead of becoming visual noise. */
function statPanelRow(label, value, tone) {
  tone = tone || "";
  return `<div class="stat-panel-row"><span class="stat-panel-row-label">${label}</span><span class="stat-panel-row-value${tone ? " tone-" + tone : ""}">${value}</span></div>`;
}
/** Wraps a run of statPanelRow() calls in the shared rows container. Call
 * once per contiguous group of rows -- a panel with a subhead partway down
 * needs two separate row groups, not one. */
function statPanelRows(rowsHtml) {
  return rowsHtml ? `<div class="stat-panel-rows">${rowsHtml}</div>` : "";
}
/** A small divider label for a secondary topic living in the same card as a
 * primary one -- e.g. "Feed & Bedding" beneath a card whose main hero is
 * Active Birds. Reads as "a new section starts here" without competing with
 * the card's own header for attention. */
function statPanelSubhead(label) {
  return `<div class="stat-panel-subhead">${esc(label)}</div>`;
}
/** A full panel: header + a pre-assembled body (any mix of statPanelHero,
 * statPanelHeroPair, statPanelRows, and statPanelSubhead calls, concatenated
 * by the caller in the order they should appear). `goto` makes the header
 * tappable, jumping to the tab this panel's numbers live in -- restores the
 * old individual stat cards' tap-through in the one place a panel bundling
 * several metrics still has an unambiguous single home tab. */
function statPanel(tone, icon, title, bodyHtml, goto) {
  return `<div class="stat-panel tone-${tone}">
    <div class="stat-panel-header${goto ? " stat-panel-header-tappable" : ""}" ${goto ? `data-goto-tab="${goto}" role="button" tabindex="0" title="Open ${goto}"` : ""}>${icon} ${esc(title)}</div>
    ${bodyHtml}
  </div>`;
}

function deltaChipHtml(current, previous, { goodUp = true, label = "last month" } = {}) {
  if (!(previous > 0)) {
    // No meaningful baseline to compare against (zero, or a metric that
    // legitimately started at nothing) -- but if there's real activity NOW,
    // say so rather than showing nothing at all just because there was
    // nothing to divide by.
    if (current > 0) return `<span class="delta-chip tone-gold">✦ new vs ${label}</span>`;
    return "";
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  if (Math.abs(pct) < 1) return `<span class="delta-chip tone-slate">≈ ${label}</span>`;
  const up = pct > 0;
  const tone = up === goodUp ? "sage" : "rust";
  return `<span class="delta-chip tone-${tone}">${up ? "▲" : "▼"} ${Math.abs(pct)}% vs ${label}</span>`;
}
/** Absolute-dollar delta chip, for a figure that can legitimately be
 * negative (Net: a month or year can genuinely net a loss). A percentage
 * comparison isn't well-defined when the baseline can be zero or negative --
 * dividing by a negative flips the sign, so an improvement from a loss to a
 * profit would misleadingly read as a negative percentage. A plain dollar
 * difference has no such problem: it's unambiguous regardless of either
 * side's sign. */
function deltaChipHtmlAbs(current, previous, { goodUp = true, label = "last month" } = {}) {
  const diff = current - previous;
  if (Math.abs(diff) < 0.005) return `<span class="delta-chip tone-slate">≈ ${label}</span>`;
  const up = diff > 0;
  const tone = up === goodUp ? "sage" : "rust";
  return `<span class="delta-chip tone-${tone}">${up ? "▲" : "▼"} ${fmtMoney(Math.abs(diff))} vs ${label}</span>`;
}

/** Weekly trend series (oldest -> newest, 8 buckets) and month-over-month
 * deltas for the overview cards. Trend values use the raw per-entry
 * estimates (count x price, weight x price) on BOTH sides of every
 * comparison -- skipping the sale-washout machinery on purpose, since a
 * consistent estimator is what makes a trend/delta honest, and the exact
 * washed-out accounting already lives in the card's main number. */
function computeCardTrends() {
  const WEEKS = 8;
  const today = new Date(todayStr() + "T00:00:00");
  const bucketOf = (dateStr) => {
    if (!dateStr) return -1;
    const days = Math.floor((today - new Date(dateStr.slice(0, 10) + "T00:00:00")) / 86400000);
    if (days < 0 || days >= WEEKS * 7) return -1;
    return WEEKS - 1 - Math.floor(days / 7); // oldest bucket first
  };
  const zeros = () => Array(WEEKS).fill(0);
  const d = getCoopDefaults();
  const eggPriceFallback = Number(d.eggPrice) || 0;
  const meatPriceFallback = Number(d.pricePerLb) || 0;

  const eggsW = zeros(), valueW = zeros(), spentW = zeros(), meatLbW = zeros(), lossesW = zeros();
  STATE.eggs.forEach(e => {
    const b = bucketOf(e.date);
    if (b < 0) return;
    const count = Number(e.count) || 0;
    eggsW[b] += count;
    valueW[b] += count * (Number(e.price_per_egg) || eggPriceFallback);
  });
  STATE.birds.forEach(bird => {
    if (bird.status !== "Processed" || !bird.harvest_date) return;
    const b = bucketOf(bird.harvest_date);
    if (b < 0) return;
    const wt = Number(bird.harvest_weight) || 0;
    meatLbW[b] += wt;
    valueW[b] += wt * (Number(bird.price_per_lb) || meatPriceFallback);
  });
  STATE.birds.forEach(bird => {
    if (bird.status !== "Deceased" || !bird.death_date) return;
    const b = bucketOf(bird.death_date);
    if (b >= 0) lossesW[b] += 1;
  });
  STATE.expenses.forEach(x => {
    if (x.entry_type === "income") return;
    const b = bucketOf(x.date);
    if (b >= 0) spentW[b] += Number(x.amount) || 0;
  });
  // Net is a RUNNING total across the 8 weeks, not a per-week figure. As a
  // per-week value it mostly showed when transactions happened -- a feed
  // purchase dropped one week hard negative, egg weeks pushed it back up --
  // which is timing noise, not a trend. A running total answers the question
  // the card is actually for: am I still sinking, or has income started to
  // outweigh spending and pulled the line back upward?
  const netW = (() => {
    let run = 0;
    return valueW.map((v, i) => (run += v - spentW[i]));
  })();

  // Flock size at the end of each weekly bucket.
  const flockW = zeros();
  for (let i = 0; i < WEEKS; i++) {
    const end = new Date(today); end.setDate(end.getDate() - (WEEKS - 1 - i) * 7);
    const endStr = end.toISOString().slice(0, 10);
    flockW[i] = STATE.birds.filter(bird => {
      const acq = bird.acquired_date || bird.hatch_date;
      if (!acq || acq > endStr) return false;
      const left = bird.status === "Processed" ? bird.harvest_date : bird.status === "Deceased" ? bird.death_date : null;
      return !(left && left <= endStr);
    }).length;
  }

  // Month-to-date vs the same day-count into last month.
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const curStart = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevDaysInMonth = new Date(prevMonthDate.getFullYear(), prevMonthDate.getMonth() + 1, 0).getDate();
  const cmpDay = Math.min(now.getDate(), prevDaysInMonth);
  const prevStart = `${prevMonthDate.getFullYear()}-${pad2(prevMonthDate.getMonth() + 1)}-01`;
  const prevEnd = `${prevMonthDate.getFullYear()}-${pad2(prevMonthDate.getMonth() + 1)}-${pad2(cmpDay)}`;
  const todayS = todayStr();
  const inCur = (ds) => ds && ds >= curStart && ds <= todayS;
  const inPrev = (ds) => ds && ds >= prevStart && ds <= prevEnd;

  const sumEggs = (test) => STATE.eggs.filter(e => test(e.date)).reduce((s, e) => s + (Number(e.count) || 0), 0);
  const sumEggValue = (test) => STATE.eggs.filter(e => test(e.date)).reduce((s, e) => s + (Number(e.count) || 0) * (Number(e.price_per_egg) || eggPriceFallback), 0);
  const sumMeatValue = (test) => STATE.birds.filter(b => b.status === "Processed" && test(b.harvest_date)).reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || meatPriceFallback), 0);
  const sumMeatLb = (test) => STATE.birds.filter(b => b.status === "Processed" && test(b.harvest_date)).reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  const sumSpent = (test) => STATE.expenses.filter(x => x.entry_type !== "income" && test(x.date)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const sumLosses = (test) => STATE.birds.filter(b => b.status === "Deceased" && test(b.death_date)).length;

  const cur = { eggs: sumEggs(inCur), value: sumEggValue(inCur) + sumMeatValue(inCur), meatLb: sumMeatLb(inCur), spent: sumSpent(inCur), losses: sumLosses(inCur) };
  const prev = { eggs: sumEggs(inPrev), value: sumEggValue(inPrev) + sumMeatValue(inPrev), meatLb: sumMeatLb(inPrev), spent: sumSpent(inPrev), losses: sumLosses(inPrev) };
  cur.net = cur.value - cur.spent;
  prev.net = prev.value - prev.spent;

  return { eggsW, valueW, spentW, netW, meatLbW, lossesW, flockW, cur, prev };
}

let coopSubTab = "overview";
function renderCoopHub() {
  const el = document.getElementById("panel-dashboard");
  const subs = [{ id: "overview", label: "Overview" }, { id: "review", label: "Year Review" }, { id: "alltime", label: "All-Time Stats" }];
  el.innerHTML = `
    <div class="range-select sub-nav-fixed" id="coopSubNav">
      ${subs.map(s => `<button class="range-btn ${coopSubTab === s.id ? "active" : ""}" data-coopsub="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div id="coopSubContent"></div>
  `;
  el.querySelectorAll("[data-coopsub]").forEach(b => b.addEventListener("click", () => { coopSubTab = b.dataset.coopsub; renderCoopHub(); }));
  if (coopSubTab === "overview") renderCoopOverview();
  else if (coopSubTab === "review") renderYearReviewSection();
  else if (coopSubTab === "alltime") renderAllTimeStatsSection();
}

function renderCoopOverview() {
  const el = document.getElementById("coopSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const months = allCoopMonths();
  const thisMonthKey = monthKeyOf(todayStr());
  const selectedMonthKey = months.includes(dashSelectedMonth) ? dashSelectedMonth : thisMonthKey;
  dashSelectedMonth = selectedMonthKey;
  const isCurrentMonth = selectedMonthKey === thisMonthKey;
  const s = computeStats(selectedMonthKey);
  const tr = computeCardTrends();
  el.innerHTML = `
    <div class="toolbar" style="${isCurrentMonth ? "" : "border-left:3px solid var(--gold);padding-left:10px"}">
      <div class="card-title" style="margin:0">Overview — ${esc(monthLabelOf(selectedMonthKey))}</div>
      <div style="display:flex;align-items:center;gap:8px">
        ${isCurrentMonth ? "" : `<button class="btn ghost small" id="dashBackToTodayBtn" title="Back to the current month">📅 Today</button>`}
        <select id="dashOverviewMonthSelect" style="max-width:170px">${monthOptionsGroupedByYear(months, selectedMonthKey)}</select>
      </div>
    </div>
    <div class="section-gap">
      <div class="grid-stats-2">
        ${(() => {
          const flockBody = statPanelHero("Active Birds", s.active, {
            chip: deltaChipHtml(tr.flockW[tr.flockW.length - 1], tr.flockW[tr.flockW.length - 5]),
          }) + statPanelRows(
            statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} Layers`, s.layers)
            + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} Meat birds`, s.meatActive)
            + statPanelRow("Losses", s.lossesThisMonth, s.lossesThisMonth > 0 ? "rust" : "")
            + statPanelRow("Processed", s.processedThisMonth)
          )
          + statPanelSubhead("🌾 Feed & Bedding") + statPanelRows(
            statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} Layer feed used`, `${displayWeight(feedTotalForMonth(selectedMonthKey, "layer"))} ${getWeightUnit()}`)
            + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} Meat feed used`, `${displayWeight(feedTotalForMonth(selectedMonthKey, "meat"))} ${getWeightUnit()}`)
            + statPanelRow("Bedding used", `${beddingTotalForMonth(selectedMonthKey).toFixed(1)} cu ft`)
          )
          // Genuinely scoped to the selected month now, same as every other
          // row here -- each hatch egg's own resolved_date (when its outcome
          // actually happened) makes this possible, rather than the clutch's
          // date_started, which is when it went INTO the incubator, not when
          // any individual egg's fate was decided. Always shown, even at
          // zero, rather than only appearing once you've hatched something --
          // the point is confirming the tracking is there.
          + statPanelSubhead("🐣 Hatching") + statPanelRows(
            statPanelRow("Chicks hatched", s.chicksHatchedMonth)
            + statPanelRow("Lost from hatching", s.hatchLossMonth, s.hatchLossMonth > 0 ? "rust" : "")
            + statPanelRow("Clear · Quit · Failed", `${s.hatchClearMonth} · ${s.hatchQuitMonth} · ${s.hatchFailedMonth}`)
          );
          const valueCompare = monthOverMonthCompare(selectedMonthKey, rawValueBetween);
          const spendCompare = monthOverMonthCompare(selectedMonthKey, spendBetween);
          const netCompare = monthOverMonthCompare(selectedMonthKey, netBetween);
          const valueBody = statPanelHero("Value Produced", fmtMoney(s.incomeMonth), {
            chip: deltaChipHtml(valueCompare.cur, valueCompare.prev),
          }) + statPanelRows(
            statPanelRow(`${BIRD_TYPE_ICONS.layer.emoji} Eggs collected`, s.eggsThisMonth)
            + statPanelRow("Income from eggs", fmtMoney(s.eggTotalValueMonth))
            + statPanelRow(`${BIRD_TYPE_ICONS.meat.emoji} Meat processed`, s.weightThisMonth > 0 ? `${displayWeight(s.weightThisMonth)} ${getWeightUnit()}` : "—")
            + statPanelRow("Income from meat", fmtMoney(s.meatTotalValueMonth))
            + statPanelRow("Avg weight / bird", s.processedThisMonth > 0 ? weightLabel(s.weightThisMonth / s.processedThisMonth) : "—")
          ) + statPanelSubhead("💵 Finances") + statPanelHeroPair(
            statPanelHero("Spent", fmtMoney(s.thisMonth), { chip: deltaChipHtml(spendCompare.cur, spendCompare.prev, { goodUp: false }) }),
            statPanelHero("Net", fmtMoney(s.netMonth), { chip: deltaChipHtmlAbs(netCompare.cur, netCompare.prev), valueTone: s.netMonth >= 0 ? "sage" : "rust" })
          );
          return statPanel("sage", "🪶", "Flock", flockBody, "flock")
            + statPanel("gold", "💲", "Value", valueBody, "expenses");
        })()}
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">Bedding freshness</div>
        <div class="bedding-fresh-list">
          ${getBeddingAreas().map(area => {
            const bs = beddingStatsFor(area);
            const t = getBeddingThresholds(area);
            const daysSinceCleanout = bs.lastCleanout ? daysSince(bs.lastCleanout.date) : null;
            const daysSinceChurn = bs.lastChurn ? daysSince(bs.lastChurn.date) : null;
            const cleanoutToneInfo = cleanoutTone(daysSinceCleanout, area);
            const daysUntilCleanout = daysSinceCleanout !== null ? t.danger - daysSinceCleanout : null;
            const daysUntilChurn = daysSinceChurn !== null ? t.churn - daysSinceChurn : null;
            // Worst of the two schedules drives the row's status dot, so a
            // glance down the list shows what needs attention.
            const cleanoutState = daysUntilCleanout === null ? 0 : daysUntilCleanout < 0 ? 2 : daysUntilCleanout === 0 ? 1 : (cleanoutToneInfo.tone === "gold" ? 1 : 0);
            const churnState = daysUntilChurn === null ? 0 : daysUntilChurn < 0 ? 2 : daysUntilChurn === 0 ? 1 : 0;
            const worst = Math.max(cleanoutState, churnState);
            const dotTone = worst === 2 ? "danger" : worst === 1 ? "gold" : "sage";
            // Compact captions: clean-out is the headline, churn a secondary note.
            const cleanoutTxt = daysUntilCleanout === null ? "no clean-out logged"
              : daysUntilCleanout < 0 ? `clean-out overdue ${-daysUntilCleanout}d`
              : daysUntilCleanout === 0 ? "clean-out due today"
              : `clean-out in ${daysUntilCleanout}d`;
            const churnTxt = daysUntilChurn === null ? "" 
              : daysUntilChurn < 0 ? ` · churn overdue ${-daysUntilChurn}d`
              : daysUntilChurn === 0 ? " · churn due today"
              : ` · churn in ${daysUntilChurn}d`;
            return `<div class="bedding-fresh-row">
              <span class="status-dot tone-${dotTone}" title="${dotTone === "danger" ? "Overdue" : dotTone === "gold" ? "Due soon" : "OK"}"></span>
              <span class="bedding-fresh-area">${esc(area)}</span>
              <span class="bedding-fresh-info dim">${cleanoutTxt}${churnTxt}</span>
            </div>`;
          }).join("")}
        </div>
        <div class="dim" style="font-size:11px;margin-top:10px">Thresholds are per-area and adjustable in the <strong style="color:var(--text)">Settings</strong> tab.</div>
      </div>

      ${(() => {
        const muted = getMutedAlertCategories();
        const allLow = lowSupplyCategories(STATE.supplies);
        const low = allLow.filter(l => !muted.includes(l.category));
        const mutedActive = allLow.filter(l => muted.includes(l.category));
        const activeClutches = STATE.hatches.filter(h => h.status !== "Complete").sort((a, b) => a.date_started.localeCompare(b.date_started));
        const anyToday = activeClutches.some(h => hatchNextEventInfo(h.date_started).isToday);
        const anyOverdue = activeClutches.some(h => hatchNextEventInfo(h.date_started).overdue);
        const anySevereSupply = low.some(l => l.tone === "danger");
        const borderColor = (anySevereSupply || anyOverdue) ? "var(--danger)" : (low.length || anyToday) ? "var(--gold)" : "var(--border)";
        const STATUS_TEXT = { "1/2": "1/2 left", "1/4": "1/4 left", "Empty": "out" };
        const sectionHeaderStyle = "font-size:13px;border-bottom:2px dotted var(--border);padding-bottom:4px;margin-top:12px";
        return `<div class="card" style="border-color:${borderColor};margin-top:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div class="card-title" style="margin:0">🔔 Alerts</div>
            <button class="btn ghost small" id="openCalendarBtn">📅 Calendar</button>
          </div>
          ${low.length ? `
          <div class="flock-section-header" style="${sectionHeaderStyle};margin-top:0">⚠️ Running low</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            ${low.map(l => `<span class="stamp tone-${l.tone} stamp-mutable">${esc(l.category)} -- ${STATUS_TEXT[l.status] || l.status}<button class="stamp-mute-btn" data-mute-alert="${esc(l.category)}" title="Don't show this alert for now">✕</button></span>`).join("")}
          </div>
          ` : ""}
          ${mutedActive.length ? `<div class="dim" style="font-size:11px;margin-top:8px">Muted: ${mutedActive.map(l => esc(l.category)).join(", ")} -- turn back on in Settings → App</div>` : ""}
          ${activeClutches.length ? `
          <div class="flock-section-header" style="${sectionHeaderStyle}">🐣 Hatching</div>
          <div style="display:flex;flex-direction:column;gap:4px;margin-top:8px">
            ${activeClutches.map(h => {
              const info = hatchNextEventInfo(h.date_started);
              const breed = esc(h.breed) || "Mixed";
              const eggCount = Number(h.egg_count) || 0;
              let statusHtml;
              if (info.overdue) {
                statusHtml = `<span class="stamp tone-danger">Overdue ${info.daysOverdue}d</span>`;
              } else if (info.isToday) {
                statusHtml = `<span class="stamp stamp-lg tone-gold">🔦 Today -- ${esc(info.label)}</span>`;
              } else {
                statusHtml = `<span class="dim" style="font-size:12px">${esc(info.label)} in ${info.daysUntil}d</span>`;
              }
              return `<div data-goto-hatching="1" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;cursor:pointer;${info.isToday ? "background:color-mix(in srgb, var(--gold) 16%, transparent)" : ""}">
                <div style="font-size:13px">${breed} · ${eggCount} egg${eggCount !== 1 ? "s" : ""}</div>
                ${statusHtml}
              </div>`;
            }).join("")}
          </div>
          ` : ""}
        </div>`;
      })()}

      ${(() => {
        // Initialize the month view on first render: this month vs last month.
        const thisMonth = monthKeyOf(todayStr());
        if (!dashMonthKey) dashMonthKey = thisMonth;
        if (!dashCompareKey) dashCompareKey = shiftMonthKey(thisMonth, -1);
        const monthOptions = allCoopMonths();
        return `
        <div class="month-picker">
          <div class="month-picker-row">
            <label class="month-field"><span>Showing</span>
              <select id="dashMonthSelect">${monthOptionsGroupedByYear(monthOptions, dashMonthKey)}</select>
            </label>
            <label class="month-field"><span>Compare to</span>
              <select id="dashCompareSelect">
                <option value="">— none —</option>
                ${monthOptionsGroupedByYear(monthOptions.filter(k => k !== dashMonthKey), dashCompareKey)}
              </select>
            </label>
          </div>
          <div class="dim" style="font-size:11px;margin-top:6px">Each chart shows ${monthLabelOf(dashMonthKey)} by day${dashCompareKey ? `, with ${monthLabelOf(dashCompareKey)} as a dotted overlay for comparison` : ""}. All-time cumulative totals live on the <strong style="color:var(--text)">All-Time</strong> page.</div>
        </div>

        <div class="chart-grid chart-grid-stretch">
          <div class="card"><div class="chart-head chart-head-grow">
            ${dashProduceType === "meat" ? `<div class="card-title">🍗 Meat processed (${getWeightUnit()})</div>${dashTotalBlock(sum(meatDailyForMonth(dashMonthKey)), dashCompareKey ? sum(meatDailyForMonth(dashCompareKey)) : 0, (v) => `${displayWeight(v)} ${getWeightUnit()}`)}${(() => {
              const shownBirds = birdsProcessedInMonth(dashMonthKey);
              const compBirds = dashCompareKey ? birdsProcessedInMonth(dashCompareKey) : null;
              if (!shownBirds && !compBirds) return `<div class="dash-substat">no birds processed this month</div>`;
              const shownTxt = shownBirds ? `${shownBirds} bird${shownBirds === 1 ? "" : "s"} processed` : "no birds processed";
              return `<div class="dash-substat">${shownTxt}${compBirds !== null ? ` · ${compBirds} in ${monthLabelShort(dashCompareKey)}` : ""}</div>`;
            })()}` : `<div class="card-title">🥚 Eggs collected</div>${dashTotalBlock(sum(eggsDailyForMonth(dashMonthKey)), dashCompareKey ? sum(eggsDailyForMonth(dashCompareKey)) : 0, (v) => `${Math.round(v)} egg${Math.round(v) === 1 ? "" : "s"}`)}${(() => {
              const avg = avgEggsPerDay(dashMonthKey);
              return avg > 0 ? `<div class="dash-substat">${avg.toFixed(1)}/day avg</div>` : "";
            })()}`}
            <div class="pill-row" id="dashProduceType">
              ${[["eggs", `${BIRD_TYPE_ICONS.layer.emoji} Eggs`], ["meat", `${BIRD_TYPE_ICONS.meat.emoji} Meat`]].map(([v, label]) => `<button class="pill-btn ${dashProduceType === v ? "range-btn active" : ""}" data-produce-type="${v}">${label}</button>`).join("")}
            </div>
          </div><div class="chart-box"><canvas id="dashProduceChart"></canvas></div></div>
          <div class="card"><div class="chart-head chart-head-grow"><div class="card-title">🌾 Feed used, month-to-date${dashFeedType === "layer" ? " — layer" : dashFeedType === "meat" ? " — meat" : ""} (${getWeightUnit()})</div>${dashTotalBlock(weightNum(feedTotalForMonth(dashMonthKey, dashFeedType)), dashCompareKey ? weightNum(feedTotalForMonth(dashCompareKey, dashFeedType)) : 0, (v) => `${v.toFixed(1)} ${getWeightUnit()}`, { invertColors: true })}
            <div class="pill-row" id="dashFeedType">
              ${[["both", "Both"], ["layer", `${BIRD_TYPE_ICONS.layer.emoji} Layer`], ["meat", `${BIRD_TYPE_ICONS.meat.emoji} Meat`]].map(([v, label]) => `<button class="pill-btn ${dashFeedType === v ? "range-btn active" : ""}" data-feed-type="${v}">${label}</button>`).join("")}
            </div>
          </div><div class="chart-box"><canvas id="dashFeedChart"></canvas></div></div>
          <div class="card" style="grid-column:1/-1">
            <div class="chart-head chart-head-grow">
              <div class="money-mega-head">
                <div class="card-title">${dashMoneyMode === "income" ? "💰 Income / value" : dashMoneyMode === "net" ? "⚖️ Net (value − spend)" : "💵 Spending"}${dashMoneyMode === "spend" && dashSpendPill.size ? ` — ${esc(pillLabel(dashSpendPill))}` : dashMoneyMode === "income" && dashIncomePill.size ? ` — ${esc(pillLabel(dashIncomePill))}` : ""}</div>
                <div class="pill-row money-mode-pills" id="dashMoneyMode">
                  ${[["spend", "💵 Spend"], ["income", "💰 Income"], ["net", "⚖️ Net"]].map(([v, label]) => `<button class="pill-btn ${dashMoneyMode === v ? "range-btn active" : ""}" data-money-mode="${v}">${label}</button>`).join("")}
                </div>
              </div>
              ${(() => {
                const shown = dashMoneySeriesTotal(dashMonthKey);
                const comp = dashCompareKey ? dashMoneySeriesTotal(dashCompareKey) : 0;
                // Spend: less is good (invert). Income/net: more is good.
                return dashTotalBlock(shown, comp, (v) => fmtMoney(v), { invertColors: dashMoneyMode === "spend" });
              })()}
              ${dashMoneyMode === "spend" ? `<div class="pill-row" id="dashSpendPills">
                <button class="pill-btn ${dashSpendPill.size === 0 ? "range-btn active" : ""}" data-spend-pill="">All</button>
                ${spendCategoriesPresent().map(c => `<button class="pill-btn ${dashSpendPill.has(c) ? "range-btn active" : ""}" data-spend-pill="${esc(c)}">${(CATEGORY_ICONS[c] || CATEGORY_ICONS["Other"]).emoji} ${esc(c)}</button>`).join("")}
              </div>` : dashMoneyMode === "income" ? `<div class="pill-row" id="dashIncomePills">
                <button class="pill-btn ${dashIncomePill.size === 0 ? "range-btn active" : ""}" data-income-pill="">All</button>
                ${incomeSourcesPresent().map(src => { const ic = incomeSourceIcon(src); return `<button class="pill-btn ${dashIncomePill.has(src) ? "range-btn active" : ""}" data-income-pill="${esc(src)}">${ic.emoji} ${esc(src)}</button>`; }).join("")}
              </div>` : `<div class="dash-substat">Value produced minus money spent, per day</div>`}
            </div>
            <div class="chart-box"><canvas id="dashMoneyChart"></canvas></div>
            ${(() => {
              // Breakdown beneath the chart, matching the current mode: where
              // the money went (spend) or where the value came from (income).
              // Net shows both side by side -- out vs in for the month.
              const inMonth = (d) => monthKeyOf(d) === dashMonthKey;
              const spendBars = () => spendCategoryBarsHtml(spendCatTotalsForMonth(dashMonthKey), { title: "Where it went", totalLabel: "Total spent", bare: true });
              const valueBars = () => valueSourceBarsHtml(valueBreakdownIn(inMonth), { title: "Where it came from", totalLabel: "Total value", bare: true });
              if (dashMoneyMode === "spend") return `<div class="money-breakdown">${spendBars()}</div>`;
              if (dashMoneyMode === "income") return `<div class="money-breakdown">${valueBars()}</div>`;
              return `<div class="money-breakdown money-breakdown-2">${valueBars()}${spendBars()}</div>`;
            })()}
          </div>
        </div>`;
      })()}
    </div>
  `;
  const monthSel = document.getElementById("dashMonthSelect");
  if (monthSel) monthSel.addEventListener("change", (e) => {
    dashMonthKey = e.target.value;
    // Keep comparison valid: if it now equals the shown month, clear it.
    if (dashCompareKey === dashMonthKey) dashCompareKey = null;
    renderCoopOverview();
  });
  const compareSel = document.getElementById("dashCompareSelect");
  if (compareSel) compareSel.addEventListener("change", (e) => { dashCompareKey = e.target.value || null; renderCoopOverview(); });
  const moneyMode = document.getElementById("dashMoneyMode");
  if (moneyMode) moneyMode.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-money-mode]");
    if (!btn) return;
    dashMoneyMode = btn.dataset.moneyMode;
    renderCoopOverview();
  });
  const spendPills = document.getElementById("dashSpendPills");
  if (spendPills) spendPills.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-spend-pill]");
    if (!btn) return;
    togglePillSelection(dashSpendPill, btn.dataset.spendPill);
    renderCoopOverview();
  });
  const incomePills = document.getElementById("dashIncomePills");
  if (incomePills) incomePills.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-income-pill]");
    if (!btn) return;
    togglePillSelection(dashIncomePill, btn.dataset.incomePill);
    renderCoopOverview();
  });
  const feedTypeToggle = document.getElementById("dashFeedType");
  if (feedTypeToggle) feedTypeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-feed-type]");
    if (!btn) return;
    dashFeedType = btn.dataset.feedType;
    renderCoopOverview();
  });
  const produceToggle = document.getElementById("dashProduceType");
  if (produceToggle) produceToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-produce-type]");
    if (!btn) return;
    dashProduceType = btn.dataset.produceType;
    renderCoopOverview();
  });
  el.querySelectorAll("[data-goto-hatching]").forEach(row => row.addEventListener("click", () => {
    switchTab("eggs");
    eggsSubTab = "hatching";
    renderEggsHub();
  }));
  el.querySelectorAll("[data-mute-alert]").forEach(btn => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const category = btn.dataset.muteAlert;
    const settings = getCoopSettings();
    const muted = new Set(getMutedAlertCategories());
    muted.add(category);
    settings.muted_alert_categories = [...muted];
    await localCoopUpdate(currentCoopId, { settings: JSON.stringify(settings) });
    await loadCoops();
    showToast(`${category} alerts muted`, "update");
    renderCoopOverview();
  }));
  const openCalendarBtn = document.getElementById("openCalendarBtn");
  if (openCalendarBtn) openCalendarBtn.addEventListener("click", openCalendarModal);
  wireStatPanelGoto(el);
  document.getElementById("dashOverviewMonthSelect").addEventListener("change", (e) => {
    dashSelectedMonth = e.target.value;
    renderCoopOverview();
  });
  const backToTodayBtn = document.getElementById("dashBackToTodayBtn");
  if (backToTodayBtn) backToTodayBtn.addEventListener("click", () => {
    dashSelectedMonth = null; // renderCoopOverview resolves null back to the real current month
    renderCoopOverview();
  });
  drawDashboardCharts();
}
/** Stat card/panel tap-through: each tappable card or panel header opens the
 * tab its numbers live on (switchTab lands on that tab's first sub-tab and
 * renders it). Enter/Space too, since they carry role="button". Shared by
 * the Dashboard, Year Review, and All-Time -- each renders its own set of
 * [data-goto-tab] elements via statCard()/statPanel(), but the actual click
 * wiring only needs to happen once per render, from whichever page called it. */
function wireStatPanelGoto(el) {
  el.querySelectorAll("[data-goto-tab]").forEach(card => {
    const go = () => switchTab(card.dataset.gotoTab);
    card.addEventListener("click", go);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
/** Tap-through for the cost-per-dozen / cost-per-lb-meat headline cards --
 * opens the "peek behind the curtain" breakdown modal for whichever one was
 * tapped. Only present on Year Review and All-Time. */
function wireCostBreakdownCards(el) {
  el.querySelectorAll("[data-cost-breakdown]").forEach(card => {
    const open = () => openCostBreakdownModal(card.dataset.costBreakdown);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
/** Feed used total for a month: the last value of its cumulative series, which
 * is the month-to-date total for the current month and the full-month total
 * for a past month (and correctly includes an open bag's used-so-far portion). */
function feedTotalForMonth(key, feedType = "both") {
  const series = feedCumulativeForMonth(key, feedType);
  return series.length ? series[series.length - 1] : 0;
}
/** Bedding used (cu ft), month-to-date -- same bag-ramp accuracy as feed
 * (a bag's usage spread across the days it was actually open, an open bag's
 * used-so-far portion counted as of today), just for the Bedding category. */
function beddingTotalForMonth(key) {
  const n = daysInMonthKey(key);
  const perDay = Array(n).fill(0);
  const today = todayStr();
  STATE.supplies.filter(s => s.category === "Bedding").forEach(s => {
    const ramp = bagRamp(s, today);
    if (!ramp) return;
    for (let i = 0; i < ramp.spanDays; i++) {
      const d = dayInMonth(addDays(ramp.start, i), key);
      if (d > 0) perDay[d - 1] += ramp.perDay;
    }
  });
  return perDay.reduce((a, b) => a + b, 0);
}

/** A clean "this month vs comparison" total for a dashboard card header.
 * `fmt` formats the raw number (eggs → plain count, feed → "X lb", spend →
 * money). Shows the shown-month total prominently, the comparison-month total
 * dim beside it, and a small up/down delta so you don't have to subtract in
 * your head. When there's no comparison month, just the one total. */
function dashTotalBlock(shownTotal, compareTotal, fmt, { invertColors = false } = {}) {
  const main = `<span class="dash-total-main">${fmt(shownTotal)}</span>`;
  if (dashCompareKey == null) return `<div class="dash-total">${main}</div>`;
  const diff = shownTotal - compareTotal;
  // For spend, up is "bad" (red) and down is "good" (green); for eggs/feed
  // it's neutral -- we just color the direction, not judge it, except spend.
  const good = invertColors ? diff < 0 : diff > 0;
  const cls = diff === 0 ? "flat" : good ? "up-good" : "up-bad";
  const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "–";
  const deltaLabel = diff === 0 ? "same as" : `${arrow} ${fmt(Math.abs(diff))} vs`;
  return `<div class="dash-total">
    ${main}
    <span class="dash-total-compare"><span class="dash-delta ${cls}">${deltaLabel}</span> ${fmt(compareTotal)} <span class="dim">(${monthLabelShort(dashCompareKey)})</span></span>
  </div>`;
}
function monthLabelShort(key) {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_NAMES_SHORT[m - 1]} ${y}`;
}
/** Just the month name, no year -- for an <option> living inside an
 * <optgroup> already labeled with the year, so the year isn't repeated on
 * every single line. */
function monthNameOnly(key) {
  const [, m] = key.split("-").map(Number);
  return MONTH_NAMES_SHORT[m - 1];
}
/** <option>/<optgroup> markup for a list of month keys, grouped by year --
 * newest year first, newest month first within each year. A flat list gets
 * long to scroll after a couple years of use; grouping solves that without
 * adding a second cascading dropdown (which would need its own state, its
 * own "does this year have this month" edge cases, and a way to keep the
 * two controls in sync) -- one control, same data, just organized. */
function monthOptionsGroupedByYear(monthKeys, selected) {
  const byYear = new Map();
  monthKeys.forEach(k => {
    const y = k.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(k);
  });
  return [...byYear.keys()].sort().reverse().map(y => {
    const opts = byYear.get(y).map(k => `<option value="${k}" ${k === selected ? "selected" : ""}>${monthNameOnly(k)}</option>`).join("");
    return `<optgroup label="${y}">${opts}</optgroup>`;
  }).join("");
}

/** Draws the three dashboard month charts (eggs, feed, spend), each showing the
 * selected month by day with an optional dotted overlay of the comparison
 * month. Comparison uses day-of-month alignment so different-length months
 * still line up. */
/** Per-day money series for the dashboard mega chart, honoring the current
 * mode (spend/income/net) and any selected pill. Net = income value − spend. */
/** Running total through the month for whichever mode is selected. All three
 * are cumulative so the line always answers "where do I stand so far", and the
 * endpoint always equals the headline figure. Per-day values were only really
 * showing when transactions happened. */
function dashMoneySeries(key) {
  const runningTotal = (arr) => { let r = 0; return arr.map(v => (r += v)); };
  if (dashMoneyMode === "income") return runningTotal(incomeDailyForMonth(key, dashIncomePill));
  if (dashMoneyMode === "net") {
    // Net is a RUNNING total through the month: start at 0, each day add that
    // day's income and subtract that day's spend. The line's endpoint equals
    // the month's net total, and a zero-crossing marks the day the month got
    // back to break-even -- unlike isolated per-day values, which jump around
    // and never match the headline total.
    const inc = incomeDailyForMonth(key, null);
    const spend = spendDailyForMonth(key, null);
    let run = 0;
    return inc.map((v, i) => (run += v - spend[i]));
  }
  return runningTotal(spendDailyForMonth(key, dashSpendPill));
}
/** Every mode is a running total now, so the headline is simply where the line
 * ends. */
function dashMoneySeriesTotal(key) {
  const series = dashMoneySeries(key);
  return series.length ? series[series.length - 1] : 0;
}

function drawDashboardCharts() {
  Object.values(charts).forEach(c => c && c.destroy());
  const shownDays = daysInMonthKey(dashMonthKey);
  const labels = Array.from({ length: shownDays }, (_, i) => String(i + 1)); // "1".."31"
  const compareOn = !!dashCompareKey;

  // A comparison series is padded/truncated to the shown month's length so the
  // overlay aligns by day-of-month (day 5 over day 5), even across 28 vs 31.
  const alignCompare = (arr) => labels.map((_, i) => (i < arr.length ? arr[i] : null));

  const mainLabel = monthLabelOf(dashMonthKey);
  const compLabel = compareOn ? monthLabelOf(dashCompareKey) : "";
  const dashLine = (color) => ({ borderColor: color, borderDash: [4, 4], backgroundColor: "transparent", pointRadius: 0, tension: 0.25 });

  // ---- Produce: eggs (line) or meat (bars), toggled ----
  const produceEl = document.getElementById("dashProduceChart");
  if (produceEl) {
    if (dashProduceType === "meat") {
      const meatMain = meatDailyForMonth(dashMonthKey);
      const meatDatasets = [{ label: mainLabel, data: meatMain, backgroundColor: "#C1502E", borderColor: "#C1502E", type: "bar" }];
      if (compareOn) meatDatasets.push({ label: compLabel, data: alignCompare(meatDailyForMonth(dashCompareKey)), ...dashLine("#C7B9A6"), type: "line" });
      charts.dashProduce = new Chart(produceEl, {
        data: { labels, datasets: meatDatasets },
        options: monthChartOpts(compareOn, (v) => `${displayWeight(v)} ${getWeightUnit()}`),
      });
    } else {
      const eggMain = eggsDailyForMonth(dashMonthKey);
      const eggDatasets = [{ label: mainLabel, data: eggMain, borderColor: "#D4A017", backgroundColor: "#D4A01733", tension: 0.25, pointRadius: 2, fill: true }];
      if (compareOn) eggDatasets.push({ label: compLabel, data: alignCompare(eggsDailyForMonth(dashCompareKey)), ...dashLine("#C7B9A6") });
      charts.dashProduce = new Chart(produceEl, {
        type: "line", data: { labels, datasets: eggDatasets },
        options: monthChartOpts(compareOn),
      });
    }
  }

  // ---- Feed (cumulative within the month) ----
  // Series converted to the display unit so the axis matches the label.
  const feedMain = feedCumulativeForMonth(dashMonthKey, dashFeedType).map(weightNum);
  // For the CURRENT month, don't draw a flat line stretching to the end of the
  // month past today -- cut the series off at today so it doesn't imply "no
  // more feed forecast." Past months show the whole month.
  const isCurrentMonth = dashMonthKey === monthKeyOf(todayStr());
  const todayDom = Number(todayStr().slice(8, 10));
  const truncateToToday = (arr) => isCurrentMonth ? arr.map((v, i) => (i < todayDom ? v : null)) : arr;
  // Distinct color per feed type: layer gold, meat rust, and Both its own
  // slate -- previously Both reused the meat rust, which read as "meat feed."
  const feedColor = dashFeedType === "layer" ? "#D4A017" : dashFeedType === "meat" ? "#C1502E" : "#7A8FA6";
  const feedFill = dashFeedType === "layer" ? "#D4A01733" : dashFeedType === "meat" ? "#C1502E33" : "#7A8FA633";
  const feedDatasets = [{ label: mainLabel, data: truncateToToday(feedMain), borderColor: feedColor, backgroundColor: feedFill, tension: 0.2, pointRadius: 2, fill: true, spanGaps: false }];
  if (compareOn) feedDatasets.push({ label: compLabel, data: alignCompare(feedCumulativeForMonth(dashCompareKey, dashFeedType).map(weightNum)), ...dashLine("#C7B9A6") });
  charts.dashFeed = new Chart(document.getElementById("dashFeedChart"), {
    type: "line", data: { labels, datasets: feedDatasets },
    options: monthChartOpts(compareOn, (v) => `${v.toFixed(2)} ${getWeightUnit()}`),
  });

  // ---- Money mega chart (spend / income / net) ----
  const moneyEl = document.getElementById("dashMoneyChart");
  if (moneyEl) {
    let moneyMain = dashMoneySeries(dashMonthKey);
    const isNet = dashMoneyMode === "net";
    // Every mode is a running total now, and none of them should draw a flat
    // line from today to month-end -- that would imply the rest of the month
    // is already known. Cut the current month off at today, same as feed.
    if (dashMonthKey === monthKeyOf(todayStr())) {
      const todayD = Number(todayStr().slice(8, 10));
      moneyMain = moneyMain.map((v, i) => (i < todayD ? v : null));
    }
    // Color: spend slate, income sage, net split by sign per segment (green
    // above zero, red below) via a segment callback that looks at each point.
    const baseColor = dashMoneyMode === "income" ? "#8A9A5B" : dashMoneyMode === "spend" ? "#B84C3E" : "#D4A017";
    const mainDs = {
      label: mainLabel, data: moneyMain, borderColor: baseColor, backgroundColor: baseColor + "22",
      tension: 0.2, pointRadius: 2, fill: !isNet, spanGaps: false,
    };
    if (isNet) {
      // Per-segment coloring: a segment is green if it ends non-negative, red
      // if it ends negative -- so the line visibly flips color as it crosses
      // zero between two days.
      mainDs.borderColor = "#8A9A5B";
      mainDs.segment = {
        borderColor: (ctx) => (ctx.p1.parsed.y != null && ctx.p1.parsed.y < 0 ? "#B84C3E" : "#8A9A5B"),
      };
      mainDs.fill = false;
    }
    const moneyDatasets = [mainDs];
    if (compareOn) moneyDatasets.push({ label: compLabel, data: alignCompare(dashMoneySeries(dashCompareKey)), ...dashLine("#C7B9A6") });
    const opts = monthChartOpts(compareOn, (v) => fmtMoney(v));
    if (isNet) opts.scales.y.beginAtZero = false; // let it show negative territory
    charts.dashMoney = new Chart(moneyEl, {
      type: "line", data: { labels, datasets: moneyDatasets }, options: opts,
    });
  }
}

/** Chart options for the month view: legend shown only when comparing, x-axis
 * labeled by day-of-month. */
function monthChartOpts(showLegend, yFormatter) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: showLegend ? { position: "bottom", labels: { color: "#C7B9A6", font: { size: 11 }, boxWidth: 12 } } : { display: false },
      tooltip: { callbacks: yFormatter ? { label: (ctx) => `${ctx.dataset.label}: ${yFormatter(ctx.parsed.y)}` } : undefined },
    },
    scales: {
      x: { ticks: { color: "#C7B9A6", font: { size: 10 }, autoSkip: true, maxTicksLimit: 10, maxRotation: 0 }, grid: { color: "#5A4B3C40" }, title: { display: true, text: "Day of month", color: "#8A7A68", font: { size: 9 } } },
      y: { ticks: { color: "#C7B9A6", font: { size: 10 } }, grid: { color: "#5A4B3C40" }, beginAtZero: true }
    }
  };
}

function loadMoreButtonHtml(totalCount, visibleCount, id = "loadMoreBtn") {
  if (totalCount <= visibleCount) return "";
  const remaining = totalCount - visibleCount;
  return `<div style="text-align:center;margin-top:14px"><button class="btn ghost" id="${id}">Load ${Math.min(remaining, PAGE_SIZE)} more (${remaining} left)</button></div>`;
}

/** A styled confirm dialog matching the app's look, replacing the native
 * browser confirm() popup. Returns a Promise<boolean> -- true if the person
 * confirmed, false if they cancelled, clicked outside, or pressed Escape. */
/** A simple full-screen viewer for a photo thumbnail -- lets the actual
 * uploaded photo be seen at full size instead of only the small cropped
 * thumbnail used in cards/forms. Dismissible by clicking outside the image,
 * the close button, or Escape. */
/** repositionCtx (optional): { x, y, aspectRatio, onSave } -- when given,
 * shows a reposition button that opens the crop modal and persists
 * immediately on save, since there's no surrounding form here holding this
 * as a pending, not-yet-committed change the way the bird/product forms do. */
function showPhotoLightbox(url, repositionCtx = null) {
  const overlay = document.createElement("div");
  overlay.className = "photo-lightbox-overlay";
  overlay.innerHTML = `
    <img src="${url}" class="photo-lightbox-img" alt="">
    <button class="icon-btn photo-lightbox-close" title="Close">✕</button>
    ${repositionCtx ? `<button class="icon-btn photo-lightbox-reposition" title="Reposition">↔</button>` : ""}
  `;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".photo-lightbox-close").addEventListener("click", close);
  const repositionBtn = overlay.querySelector(".photo-lightbox-reposition");
  if (repositionBtn) repositionBtn.addEventListener("click", () => {
    close();
    openPhotoRepositionModal(url, repositionCtx.x ?? 50, repositionCtx.y ?? 50, repositionCtx.zoom ?? 1, repositionCtx.aspectRatio, async (x, y, zoom) => {
      await repositionCtx.onSave(x, y, zoom);
      if (repositionCtx.closeAfterSave !== false) closeModal();
    });
  });
}

function ensureModalDom() {
  if (document.getElementById("modalOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "modalOverlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" id="modalPanel">
      <button class="modal-delete" id="modalDeleteBtn" aria-label="Delete" title="Delete" style="display:none">🗑</button>
      <button class="modal-close" id="modalCloseBtn" aria-label="Close">✕</button>
      <div id="modalContent"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.getElementById("modalCloseBtn").addEventListener("click", () => closeModal());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.classList.contains("open")) closeModal(); });
}

let modalOnClose = null;
let modalOnBack = null;

/** Renders html into the shared modal/bottom-sheet. onClose (optional) runs
 * once the modal is TRULY closing (backdrop click, Escape, or the X button
 * with no onBack in play, or a form's own Cancel button calling
 * closeModal() itself) -- so cleanup (clearing an editing-id, refreshing a
 * grid behind it) only has to be written once instead of once per
 * dismissal path.
 *
 * onDelete (optional) shows a trash icon in the header, next to the close
 * button, instead of a form having to render its own Delete button in the
 * footer -- keeps the destructive action grouped with "leave this record"
 * rather than sitting next to the primary Save action at the bottom.
 *
 * onBack (optional) is for nested modal flows (e.g. a bird's edit form ->
 * its photo timeline -> a single photo) -- when set, Escape/X/backdrop
 * calls it INSTEAD of actually closing, so the overlay stays visually open
 * the whole time and the content just swaps back to the previous screen,
 * rather than closing all the way out to whatever's behind the modal
 * entirely. Each screen in the chain passes the one below it as onBack. */
let modalContentClearTimeout = null;

/** Searches across the main text-bearing resources for the current coop --
 * birds (name/breed/type), notes (title/body/category), supplies
 * (brand/description/category), and products (brand/category). Case-
 * insensitive substring match, kept deliberately simple (no fuzzy
 * matching or ranking) so results are predictable. */
function performGlobalSearch(query) {
  const q = query.trim().toLowerCase();
  const empty = { birds: [], notes: [], supplies: [], products: [], health: [] };
  if (!q) return empty;
  const has = (...fields) => fields.some(f => (f || "").toLowerCase().includes(q));
  const birdName = (id) => { const b = STATE.birds.find(x => x.id === id); return b ? b.name : ""; };
  return {
    birds: STATE.birds.filter(b => has(b.name, b.breed, b.type)),
    notes: STATE.notes.filter(n => has(n.title, n.body, n.category)),
    supplies: STATE.supplies.filter(s => has(s.brand, s.description, s.category)),
    products: STATE.supplyProducts.filter(p => has(p.brand, p.category, p.description)),
    // Match the note text OR the bird's name -- searching "mites" finds the
    // entry, and searching a bird's name finds all its health history.
    health: STATE.birdLogs.filter(l => has(l.note, birdName(l.bird_id))),
  };
}

function openGlobalSearchModal() {
  if (!currentCoopId) { showToast("Pick a coop first", "delete"); return; }
  const html = `
    <div class="form-head">🔍 Search</div>
    <input type="text" id="globalSearchInput" placeholder="Search birds, health, notes, supplies..." autocomplete="off"
      style="width:100%;padding:11px 12px;font-size:16px;border-radius:8px;border:1px solid var(--border);background:var(--surface-raised);color:var(--text);margin-bottom:14px;box-sizing:border-box">
    <div id="globalSearchResults"></div>
  `;
  // Cap the panel to the *visual* viewport -- the part of the screen the
  // mobile keyboard isn't covering -- so the results list scrolls within
  // the visible area instead of extending down behind the keyboard. The
  // CSS (.modal-search) anchors this modal to the top on mobile for the
  // same reason. Recomputed live as the keyboard opens/closes/resizes.
  const panel = () => document.getElementById("modalPanel");
  const fitToViewport = () => {
    const p = panel();
    if (!p || !window.visualViewport) return;
    p.style.maxHeight = `${Math.round(window.visualViewport.height) - 12}px`;
  };
  if (window.visualViewport) visualViewport.addEventListener("resize", fitToViewport);
  openModal(html, () => {
    if (window.visualViewport) visualViewport.removeEventListener("resize", fitToViewport);
    const p = panel();
    if (p) p.style.maxHeight = ""; // don't leak the cap into the next modal that reuses this panel
  }, null, null, "modal-search");
  fitToViewport();
  const input = document.getElementById("globalSearchInput");
  input.focus();
  const resultsEl = document.getElementById("globalSearchResults");
  let debounceTimer;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderGlobalSearchResults(input.value, resultsEl), 120);
  });
  renderGlobalSearchResults("", resultsEl);
}

function renderGlobalSearchResults(query, resultsEl) {
  const q = query.trim();
  if (!q) {
    resultsEl.innerHTML = `<div class="dim" style="font-size:12px;text-align:center;padding:24px 0">Start typing to search birds, health logs, notes, supplies, and products.</div>`;
    return;
  }
  const { birds, notes, supplies, products, health } = performGlobalSearch(q);
  const total = birds.length + notes.length + supplies.length + products.length + health.length;
  if (total === 0) {
    resultsEl.innerHTML = `<div class="dim" style="font-size:12px;text-align:center;padding:24px 0">No results for "${esc(q)}".</div>`;
    return;
  }
  const MAX_PER_SECTION = 8;
  const section = (label, items, renderItem) => !items.length ? "" : `
    <div class="flock-section-header" style="margin-top:14px">${label} (${items.length})</div>
    <div class="list-stack">${items.slice(0, MAX_PER_SECTION).map(renderItem).join("")}</div>
    ${items.length > MAX_PER_SECTION ? `<div class="dim" style="font-size:11px;margin-top:4px">+ ${items.length - MAX_PER_SECTION} more -- keep typing to narrow it down</div>` : ""}
  `;
  resultsEl.innerHTML = [
    section("🐔 Birds", birds, b => `<div class="list-card" data-search-bird="${b.id}" style="cursor:pointer"><div class="list-card-main"><div style="font-weight:700">${esc(b.name || "Unnamed")}</div><div class="list-card-desc dim">${esc(b.breed || "")}${b.type ? ` · ${esc(b.type)}` : ""}</div></div></div>`),
    section("📝 Notes", notes, n => `<div class="list-card" data-search-note="${n.id}" style="cursor:pointer"><div class="list-card-main"><div style="font-weight:700">${esc(n.title || "Untitled")}</div><div class="list-card-desc dim">${esc(n.category || "")}</div></div></div>`),
    section("🩺 Health log", health, l => { const b = STATE.birds.find(x => x.id === l.bird_id); return `<div class="list-card" data-search-health="${l.bird_id}" style="cursor:pointer"><div class="list-card-main"><div style="font-weight:700">${esc(b ? b.name : "(deleted bird)")}</div><div class="list-card-desc dim">${fmtDate(l.date)} · ${esc((l.note || "").slice(0, 80))}${(l.note || "").length > 80 ? "…" : ""}</div></div></div>`; }),
    section("📦 Supplies", supplies, s => `<div class="list-card" data-search-supply="${s.id}" style="cursor:pointer"><div class="list-card-main"><div style="font-weight:700">${esc(s.brand || s.description || s.category)}</div><div class="list-card-desc dim">${esc(s.category || "")}</div></div></div>`),
    section("🏷️ Products", products, p => `<div class="list-card" data-search-product="${p.id}" style="cursor:pointer"><div class="list-card-main"><div style="font-weight:700">${esc(p.brand || p.category)}</div><div class="list-card-desc dim">${esc(p.category || "")}</div></div></div>`),
  ].join("");

  resultsEl.querySelectorAll("[data-search-bird]").forEach(el => el.addEventListener("click", () => {
    const bird = STATE.birds.find(b => b.id === el.dataset.searchBird);
    if (!bird) return;
    closeModal();
    setTimeout(() => { switchTab("flock"); showBirdForm(bird); }, 80);
  }));
  resultsEl.querySelectorAll("[data-search-note]").forEach(el => el.addEventListener("click", () => {
    const note = STATE.notes.find(n => n.id === el.dataset.searchNote);
    if (!note) return;
    closeModal();
    setTimeout(() => { switchTab("flock"); flockSubTab = "notes"; renderActiveTab(); openNoteModal(note); }, 80);
  }));
  resultsEl.querySelectorAll("[data-search-health]").forEach(el => el.addEventListener("click", () => {
    // Health entries are edited on their bird's screen, so land there --
    // opening the bird whose log matched, same as tapping the bird itself.
    const bird = STATE.birds.find(b => b.id === el.dataset.searchHealth);
    if (!bird) return;
    closeModal();
    setTimeout(() => { switchTab("flock"); showBirdForm(bird); }, 80);
  }));
  resultsEl.querySelectorAll("[data-search-supply]").forEach(el => el.addEventListener("click", () => {
    const supply = STATE.supplies.find(s => s.id === el.dataset.searchSupply);
    if (!supply) return;
    closeModal();
    setTimeout(() => { switchTab("bedding"); openSupplyModal(supply); }, 80);
  }));
  resultsEl.querySelectorAll("[data-search-product]").forEach(el => el.addEventListener("click", () => {
    const product = STATE.supplyProducts.find(p => p.id === el.dataset.searchProduct);
    if (!product) return;
    closeModal();
    setTimeout(() => { switchTab("bedding"); supplySubTab = "products"; renderActiveTab(); openProductModal(product, product.category); }, 80);
  }));
}

function openModal(html, onClose = null, onDelete = null, onBack = null, extraClass = null) {
  ensureModalDom();
  if (modalContentClearTimeout) { clearTimeout(modalContentClearTimeout); modalContentClearTimeout = null; } // cancel any pending clear from a just-closed modal -- we're about to overwrite the content anyway, but the stale timer must not fire later and wipe out THIS modal's content
  modalOnClose = onClose;
  modalOnBack = onBack;
  document.getElementById("modalContent").innerHTML = html;
  document.getElementById("modalPanel").className = "modal-panel" + (extraClass ? ` ${extraClass}` : "");
  document.body.style.overflow = "hidden";
  const overlay = document.getElementById("modalOverlay");
  document.getElementById("modalPanel").scrollTop = 0;
  const deleteBtn = document.getElementById("modalDeleteBtn");
  deleteBtn.style.display = onDelete ? "flex" : "none";
  deleteBtn.onclick = onDelete; // reassigning onclick (not addEventListener) so each open cleanly replaces the previous handler instead of stacking listeners
  // Adding the open class in the same tick as setting innerHTML can skip
  // straight to the end state with no visible transition -- one frame's
  // delay is enough for the browser to register the starting position first.
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function closeModal() {
  if (modalOnBack) { const goBack = modalOnBack; modalOnBack = null; goBack(); return; } // "back" navigation -- overlay stays open, content just swaps; the back screen is responsible for setting its own modalOnBack/onClose again via its own openModal call
  const overlay = document.getElementById("modalOverlay");
  if (!overlay || !overlay.classList.contains("open")) return;
  overlay.classList.remove("open");
  document.body.style.overflow = "";
  const deleteBtn = document.getElementById("modalDeleteBtn");
  if (deleteBtn) { deleteBtn.style.display = "none"; deleteBtn.onclick = null; }
  if (modalOnClose) { modalOnClose(); modalOnClose = null; }
  if (modalContentClearTimeout) clearTimeout(modalContentClearTimeout);
  modalContentClearTimeout = setTimeout(() => { const c = document.getElementById("modalContent"); if (c) c.innerHTML = ""; modalContentClearTimeout = null; }, 320);
}

/** For long-running operations (export, import) where the person needs to
 * see that something is actually happening, not just a frozen screen.
 * Deliberately has no close button while running -- dismissing mid-export
 * or mid-import would leave things in a half-finished, confusing state, so
 * the only way out is for the operation to actually finish (closeModal()
 * called explicitly once it does, or on error). */
let _progressModalUnloadHandler = null;

function openProgressModal(title) {
  ensureModalDom();
  const html = `
    <div class="form-head">${esc(title)}</div>
    <div class="progress-bar-track"><div class="progress-bar-fill" id="progressBarFill" style="width:0%"></div></div>
    <div class="dim" id="progressStatusText" style="margin-top:8px;font-size:12px">Starting...</div>
    <div class="dim" style="margin-top:10px;font-size:11px">Please keep this tab open until this finishes -- closing or reloading partway through can leave things in a confusing, half-finished state.</div>
  `;
  openModal(html);
  const closeBtn = document.getElementById("modalCloseBtn");
  if (closeBtn) closeBtn.style.display = "none";
  // A real guard, not just a suggestion -- the browser's own "are you sure
  // you want to leave" prompt if someone tries to close the tab or reload
  // while this is running, since that's exactly what was landing people on
  // a blank "no coops" screen mid-import.
  _progressModalUnloadHandler = (e) => { e.preventDefault(); e.returnValue = ""; };
  window.addEventListener("beforeunload", _progressModalUnloadHandler);
}
function updateProgressModal(percent, label) {
  const fill = document.getElementById("progressBarFill");
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  const text = document.getElementById("progressStatusText");
  if (text && label) text.textContent = label;
}
function closeProgressModal() {
  const closeBtn = document.getElementById("modalCloseBtn");
  if (closeBtn) closeBtn.style.display = "";
  if (_progressModalUnloadHandler) { window.removeEventListener("beforeunload", _progressModalUnloadHandler); _progressModalUnloadHandler = null; }
  closeModal();
}

/** Updates an already-open modal's content in place -- for a list-style
 * modal (Emptied bags) where an action taken inside it (restore, delete)
 * needs the list to refresh without the whole sheet closing and reopening,
 * which would replay the entrance animation and reset scroll position. */
function refreshModalContent(html) {
  const content = document.getElementById("modalContent");
  if (content) content.innerHTML = html;
}
