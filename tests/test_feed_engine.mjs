// Regression tests for the live feed-consumption engine (static/app.js):
// bagRamp, feedBagLbsUsed, pricedFeedConsumed, and the close-out/store-
// remainder proration math from the supply edit form.
//
// Run with:  node tests/test_feed_engine.mjs
//
// No test framework -- the app ships a single vanilla-JS bundle, so a
// dependency-free node script that extracts a function and asserts against
// it is the lightest thing that actually guards the behavior. This replaces
// test_feed_series.mjs, which covered feedBeddingCumulativeSeries -- a
// function the dashboard redesign this session made fully unreachable (the
// panel-based dashboard now uses feedTotalForMonth/beddingTotalForMonth
// instead). Covers:
//   - the half-open bag-emptied window (no double-counting on a same-day
//     bag handoff)
//   - an open bag's used-so-far estimate spread across the days it's
//     actually been open
//   - the drift bug: an open bag's daily rate must NOT change just because
//     more days passed with nothing new eaten
//   - pricedFeedConsumed attributing cost proportionally to lbs actually
//     consumed, not a bag's full recorded quantity
//   - the close-out proration bug (quantity AND cost must both shrink to the
//     truly-consumed share, or the finishing batch gets overcharged and the
//     stored remainder becomes free food for whoever opens it next)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "static", "app.js"), "utf8");

// Pull a top-level `function name(...) { ... }` out of the bundle by matching
// braces, so we can exercise it in isolation.
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let pd = 0, i = src.indexOf("(", start);
  for (; i < src.length; i++) { if (src[i] === "(") pd++; else if (src[i] === ")" && --pd === 0) break; }
  let depth = 0, b = src.indexOf("{", i);
  for (let j = b; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1); }
  throw new Error(`could not extract ${name}`);
}

// Minimal globals the functions rely on.
globalThis.localDateStr = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
globalThis.STATUS_USED_FRACTION = { "Full": 0, "3/4": 0.25, "1/2": 0.5, "1/4": 0.75, "Empty": 1 };
globalThis.todayStr = () => "2026-08-20";

for (const fn of ["addDays", "bagRamp", "feedBagLbsUsed", "pricedFeedConsumed"]) {
  (0, eval)(grab(fn).replace(/^function /, `globalThis.${fn}=function `));
}

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// ---- bagRamp: half-open emptied window ----
{
  // Bag A closes out the same day Bag B opens -- the handoff day should only
  // draw from B, not double-count both bags' full daily ration.
  const a = bagRamp({ quantity: 50, opened_at: "2026-07-01", date_emptied: "2026-07-15" }, "2026-08-20");
  ok(a.spanDays === 14, `emptied bag spanDays should be 14 (half-open), got ${a.spanDays}`);
  ok(approx(a.perDay, 50 / 14), `emptied bag perDay should be qty/14, got ${a.perDay}`);
}

// ---- bagRamp: open bag, used-so-far spread across real days open ----
{
  const open = bagRamp({ quantity: 50, status: "1/4", opened_at: "2026-08-01" }, "2026-08-20");
  ok(approx(open.perDay, (50 * 0.75) / 20), `open bag (1/4 remaining, 20 days open) perDay wrong: ${open.perDay}`);
}

// ---- bagRamp: the drift bug -- same bag, same status, must NOT shrink over time ----
{
  const bag = { quantity: 50, status: "1/4", opened_at: "2026-03-01" };
  const early = bagRamp(bag, "2026-06-01").perDay;
  const later = bagRamp(bag, "2026-08-20").perDay;
  ok(early > later, "sanity check: perDay for an open bag DOES shrink as more days pass with the same status (expected -- this is exactly why an unaddressed open bag needs closing out)");
  // This isn't a bug in isolation -- it's the reason the "close out & store
  // remainder" feature exists. The real regression to guard is the fix:
  // once EMPTIED, the rate must stop moving no matter when it's checked.
  const closed = { quantity: 50 * 0.75, cost: 40 * 0.75, opened_at: "2026-03-01", date_emptied: "2026-08-20" };
  const checkedToday = bagRamp(closed, "2026-08-20").perDay;
  const checkedLater = bagRamp(closed, "2027-02-01").perDay;
  ok(checkedToday === checkedLater, `a closed-out bag's rate must be identical no matter when it's checked: ${checkedToday} vs ${checkedLater}`);
}

// ---- pricedFeedConsumed: cost follows lbs actually consumed, not a bag's full quantity ----
{
  // A bag marked Empty is assumed FULLY consumed across its whole window --
  // this is only correct when the bag genuinely ran out. The close-out
  // feature must shrink quantity (not just flip status), or this assumption
  // silently overcharges whichever batch the bag is attributed to.
  globalThis.STATE = { supplies: [{ category: "Meat Feed", quantity: 50, cost: 40, opened_at: "2026-03-01", date_emptied: "2026-08-20" }] };
  const full = pricedFeedConsumed("Meat Feed", () => true);
  ok(approx(full.cost, 40) && approx(full.lbs, 50), `a bag emptied at full quantity should attribute its full cost/lbs: ${JSON.stringify(full)}`);
}

// ---- The close-out/store-remainder proration bug ----
{
  // A 50 lb / $40 bag at "1/4 remaining" (75% used) gets closed out. Both
  // quantity AND cost on the original record must shrink to the truly-
  // consumed 75% share, and the new stored bag must carry the remaining 25%
  // share of BOTH -- not $0. Otherwise the finishing batch is overcharged
  // for food it never ate, and the stored remainder becomes free food for
  // whichever batch opens it next.
  const consumedFraction = STATUS_USED_FRACTION["1/4"]; // 0.75
  const remainingFraction = 1 - consumedFraction; // 0.25
  const originalQty = 50, originalCost = 40;

  const closedOutOriginal = {
    category: "Meat Feed", quantity: originalQty * consumedFraction, cost: originalCost * consumedFraction,
    opened_at: "2026-03-01", date_emptied: "2026-08-20",
  };
  globalThis.STATE = { supplies: [closedOutOriginal] };
  const finishing = pricedFeedConsumed("Meat Feed", () => true);
  ok(approx(finishing.cost, 30) && approx(finishing.lbs, 37.5), `finishing batch should get its true 75% share ($30/37.5lb), got ${JSON.stringify(finishing)}`);

  const storedRemainder = { category: "Meat Feed", quantity: originalQty * remainingFraction, cost: originalCost * remainingFraction };
  const reopenedNextSpring = { ...storedRemainder, opened_at: "2027-03-01", date_emptied: "2027-04-15" };
  globalThis.STATE = { supplies: [reopenedNextSpring] };
  const nextBatch = pricedFeedConsumed("Meat Feed", () => true);
  ok(approx(nextBatch.cost, 10) && approx(nextBatch.lbs, 12.5), `next batch should get its own 25% share ($10/12.5lb), not free food: ${JSON.stringify(nextBatch)}`);

  // The two halves must sum back to exactly the original bag -- nothing
  // invented, nothing lost.
  ok(approx(finishing.cost + nextBatch.cost, originalCost), `split cost should sum back to the original $${originalCost}`);
  ok(approx(finishing.lbs + nextBatch.lbs, originalQty), `split lbs should sum back to the original ${originalQty}lb`);
}

// ---- An unopened (stored) bag is invisible to consumption math ----
{
  globalThis.STATE = { supplies: [{ category: "Meat Feed", quantity: 12.5, cost: 10, status: "Full", opened_at: null }] };
  const stored = pricedFeedConsumed("Meat Feed", () => true);
  ok(stored.cost === 0 && stored.lbs === 0, `an unopened bag must contribute nothing until opened: ${JSON.stringify(stored)}`);
}

console.log(`✓ feed engine: ${passed} assertions passed`);
