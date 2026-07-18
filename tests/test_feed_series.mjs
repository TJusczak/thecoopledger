// Regression tests for feedBeddingCumulativeSeries (static/app.js).
//
// Run with:  node tests/test_feed_series.mjs
//
// No test framework -- the app ships a single vanilla-JS bundle, so a
// dependency-free node script that extracts the function and asserts against
// it is the lightest thing that actually guards the behavior. Covers the bug
// where the cumulative total came out different at 7 / 30 / 90-day ranges and
// where a week-labeled bucket could plot usage before a bag was opened.

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

// Minimal globals the function relies on.
globalThis.localDateStr = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
globalThis.STATUS_USED_FRACTION = { "Full": 0, "3/4": 0.25, "1/2": 0.5, "1/4": 0.75, "Empty": 1 };
globalThis.todayStr = () => "2026-07-15";

// Freeze "now" so withinRange / addDays are deterministic.
const RealDate = Date;
const FIXED = new RealDate("2026-07-15T12:00:00").getTime();
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};

for (const fn of ["withinRange", "weekStart", "addDays"]) {
  (0, eval)(grab(fn).replace(/^function /, `globalThis.${fn}=function `));
}
(0, eval)(grab("feedBeddingCumulativeSeries").replace(/^function /, "globalThis.feedBeddingCumulativeSeries=function "));

const F = feedBeddingCumulativeSeries;
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// --- The reported bug: one 50 lb bag, opened 06/25, emptied 07/15 (21 days) ---
const bag = [{ category: "Meat Feed", quantity: 50, status: "Empty", opened_at: "2026-06-25", date_emptied: "2026-07-15" }];

// Every range must end at the SAME true total (the whole bag = 50).
for (const days of [7, 30, 90, null]) {
  const r = F(bag, days);
  ok(approx(r.meat.at(-1), 50), `range ${days}: final total should be 50, got ${r.meat.at(-1)}`);
}

// 7-day window must START already including the ~15 days consumed before it,
// not restart at one day's worth.
const r7 = F(bag, 7);
ok(approx(r7.meat[0], 15 * 50 / 21), `7-day first point should be ~35.71 (15 prior days), got ${r7.meat[0]}`);

// No point may exist before the bag was opened (the old week-bucket artifact).
const r90 = F(bag, 90);
ok(r90.labels[0] === "06-25", `90-day first label should be 06-25 (open date), got ${r90.labels[0]}`);
ok(r90.meat.every(v => v >= 0), "no negative values");

// --- Conservation: two bags total 100 ---
const two = [
  { category: "Meat Feed", quantity: 50, status: "Empty", opened_at: "2026-06-01", date_emptied: "2026-06-20" },
  { category: "Meat Feed", quantity: 50, status: "Empty", opened_at: "2026-06-21", date_emptied: "2026-07-10" },
];
ok(approx(F(two, null).meat.at(-1), 100), "two bags conserve to 100");

// --- Legacy bag (no opened_at) single-steps on its emptied day ---
const legacy = [{ category: "Layer Feed", quantity: 40, status: "Empty", date_emptied: "2026-07-10" }];
ok(approx(F(legacy, null).layer.at(-1), 40), "legacy bag totals 40");

// --- Open partial bag adds only to today ---
const partial = [
  { category: "Meat Feed", quantity: 50, status: "Empty", opened_at: "2026-06-25", date_emptied: "2026-07-10" },
  { category: "Meat Feed", quantity: 50, status: "1/2", opened_at: "2026-07-11" },
];
const rp = F(partial, null);
ok(approx(rp.meat.at(-1), 75), `emptied 50 + half-open 25 = 75, got ${rp.meat.at(-1)}`);
ok(approx(rp.meat.at(-2), 50), "partial estimate lands only on today, not the day before");

// --- Empty input ---
const re = F([], 30);
ok(re.labels.length === 0, "empty supplies -> empty series");

// --- Shared-axis mode: feed aligns to a caller-provided bucket axis ---
// allBucketsInRange and weekStart are needed for the axis; pull them in.
for (const fn of ["localDateStr"]) { /* already defined above */ }
(0, eval)(grab("bucketLabel").replace(/^function /, "globalThis.bucketLabel=function "));
(0, eval)(grab("pickBucketMode").replace(/^function /, "globalThis.pickBucketMode=function "));
(0, eval)(grab("allBucketsInRange").replace(/^function /, "globalThis.allBucketsInRange=function "));
// allBucketsInRange references STATE for the all-time case; give it a stub.
globalThis.STATE = { birds: [] };

// Same bag, viewed through a shared 30-day axis: the series must have exactly
// one value per shared bucket, and still reach the true total (50) on the last.
const axis = allBucketsInRange(pickBucketMode(30), 30);
const shared = F(bag, 30, axis);
ok(shared.layer.length === axis.length && shared.meat.length === axis.length,
  `shared-axis series length (${shared.meat.length}) must equal axis length (${axis.length})`);
ok(shared.labels.length === axis.length, "shared-axis labels match the provided axis");
ok(approx(shared.meat.at(-1), 50), `shared-axis final still 50, got ${shared.meat.at(-1)}`);

// The 90-day shared axis must start before the bag opened (full window shown),
// with a flat 0 leading stretch rather than starting at the first data point.
const axis90 = allBucketsInRange(pickBucketMode(90), 90);
const shared90 = F(bag, 90, axis90);
ok(shared90.meat.length === axis90.length, "90-day shared-axis spans full window");
ok(shared90.meat[0] === 0 || shared90.meat[0] < shared90.meat.at(-1),
  "90-day shared axis starts at/near zero (flat leading stretch), not mid-line");
ok(approx(shared90.meat.at(-1), 50), "90-day shared-axis also reaches 50");

console.log(`\u2713 feed series: ${passed} assertions passed`);

// ---------------------------------------------------------------------------
// bagRamp / feedCumulativeForMonth: an OPEN bag's usage must be spread across
// the days since it was opened, not dumped on today.
//
// Regression: a bag opened on the 15th and marked 3/4 full on the 18th used to
// show a flat line for the 15th-17th and then a single jump on the 18th, which
// reads as "no feed eaten for three days." Birds eat daily, so the quarter that
// disappeared belongs spread over those four days.
// ---------------------------------------------------------------------------
globalThis.localDateStr = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
globalThis.STATUS_USED_FRACTION = { "Full": 0, "3/4": 0.25, "1/2": 0.5, "1/4": 0.75, "Empty": 1 };
globalThis.todayStr = () => "2026-07-18";
(0, eval)(grab("addDays").replace(/^function /, "globalThis.addDays=function "));
(0, eval)(grab("daysInMonthKey").replace(/^function /, "globalThis.daysInMonthKey=function "));
(0, eval)(grab("dayInMonth").replace(/^function /, "globalThis.dayInMonth=function "));
(0, eval)(grab("bagRamp").replace(/^function /, "globalThis.bagRamp=function "));
(0, eval)(grab("feedCumulativeForMonth").replace(/^function /, "globalThis.feedCumulativeForMonth=function "));

// A 50 lb bag opened on the 15th, marked 3/4 full (so 1/4 = 12.5 lb eaten) on
// the 18th: 12.5 lb over 4 days = 3.125 lb/day.
const openBag = { category: "Meat Feed", quantity: 50, status: "3/4", opened_at: "2026-07-15" };
const ramp = bagRamp(openBag, "2026-07-18");
ok(ramp.spanDays === 4, `open bag spans opened_at..today (4 days), got ${ramp.spanDays}`);
ok(approx(ramp.perDay, 3.125), `open bag spreads 12.5 lb over 4 days, got ${ramp.perDay}/day`);

globalThis.STATE = { supplies: [openBag] };
const openSeries = feedCumulativeForMonth("2026-07", "meat");
ok(approx(openSeries[14], 3.125), `day 15 shows the first day's share, got ${openSeries[14]}`);
ok(approx(openSeries[15], 6.25), `day 16 keeps climbing, got ${openSeries[15]}`);
ok(approx(openSeries[16], 9.375), `day 17 keeps climbing, got ${openSeries[16]}`);
ok(approx(openSeries[17], 12.5), `day 18 reaches the full used-so-far, got ${openSeries[17]}`);
ok(openSeries[15] > openSeries[14] && openSeries[16] > openSeries[15],
  "open bag climbs every day rather than staying flat then jumping");

// A bag still marked Full has eaten nothing yet -- no phantom usage.
ok(bagRamp({ category: "Meat Feed", quantity: 50, status: "Full", opened_at: "2026-07-15" }, "2026-07-18") === null,
  "a Full bag contributes no consumption");

// An emptied bag spreads across a HALF-OPEN window [opened, emptied): the
// emptied date is when it was recorded gone, so the feed was eaten in the days
// before it. Jul 1 -> Jul 15 is therefore 14 days, not 15.
const emptied = bagRamp({ category: "Meat Feed", quantity: 50, status: "Empty", opened_at: "2026-07-01", date_emptied: "2026-07-15" }, "2026-07-18");
ok(emptied.spanDays === 14 && approx(emptied.perDay, 50 / 14), `emptied bag ramps over [opened, emptied), got ${emptied.spanDays} days`);

// Opened and emptied on the same day still gets one day rather than zero.
const sameDay = bagRamp({ category: "Meat Feed", quantity: 40, status: "Empty", opened_at: "2026-07-05", date_emptied: "2026-07-05" }, "2026-07-18");
ok(sameDay.spanDays === 1 && approx(sameDay.perDay, 40), "same-day open/empty collapses to a single day");

// Regression: a bag emptied the same day its replacement is opened must not
// give that day two full rations. Previously both windows covered the handoff
// date and the chart showed a doubled step there.
globalThis.STATE = { supplies: [
  { category: "Meat Feed", quantity: 50, status: "Empty", opened_at: "2026-07-01", date_emptied: "2026-07-15" },
  { category: "Meat Feed", quantity: 50, status: "3/4", opened_at: "2026-07-15" },
] };
const handoff = feedCumulativeForMonth("2026-07", "meat");
const stepOn = (day) => handoff[day - 1] - handoff[day - 2];
ok(approx(stepOn(14), 50 / 14), `day 14 draws only from the old bag, got ${stepOn(14)}`);
ok(approx(stepOn(15), 12.5 / 4), `handoff day draws only from the new bag, got ${stepOn(15)}`);
ok(stepOn(15) < stepOn(14) * 1.5, "handoff day is a normal ration, not a doubled spike");
ok(approx(handoff[13], 50), `the old bag's full quantity is still attributed, got ${handoff[13]}`);

console.log(`\u2713 open-bag ramp: assertions passed`);
