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

console.log(`\u2713 feed series: ${passed} assertions passed`);
