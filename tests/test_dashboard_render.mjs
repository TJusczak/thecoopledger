// Regression test for the Overview dashboard's conditionally-rendered
// blocks (static/app.js). These are IIFEs embedded in a template literal --
// `node --check` only validates syntax, so a local variable accidentally
// deleted during an edit (while its usage elsewhere in the same block
// survives) is invisible to it. That exact bug shipped twice in the same
// function this session: once caught before release (anyToday/anyOverdue),
// once not (STATUS_TEXT), which took the whole Overview page down for
// anyone with an actual "running low" alert -- a code path this project's
// own test data never happened to exercise.
//
// Run with: node tests/test_dashboard_render.mjs
//
// This doesn't try to render the whole page (that needs a real DOM and a
// lot of unrelated mocking) -- it extracts the specific IIFEs that have
// broken before and executes them directly with the data shape that
// triggers each conditional branch, so a future edit that silently drops a
// variable those branches depend on fails loudly here instead of shipping.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "static", "app.js"), "utf8");

function extractIife(startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`start marker not found: ${startMarker}`);
  const iifeStart = src.lastIndexOf("(() => {", start);
  let depth = 0, i = src.indexOf("{", iifeStart);
  const bodyStart = i + 1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { i = j; break; } }
  }
  return src.slice(bodyStart, i);
}
function grab(name) {
  const s = src.indexOf(`function ${name}(`);
  if (s < 0) return null;
  let pd = 0, i = src.indexOf("(", s);
  for (; i < src.length; i++) { if (src[i] === "(") pd++; else if (src[i] === ")" && --pd === 0) break; }
  let d = 0, b = src.indexOf("{", i);
  for (let j = b; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) return src.slice(s, j + 1); }
}

globalThis.esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
globalThis.getMutedAlertCategories = () => [];
globalThis.hatchNextEventInfo = () => ({ isToday: false, overdue: false, label: "hatch", daysUntil: 5, daysOverdue: 0 });
["lowSupplyCategories"].forEach(n => { (0, eval)(grab(n).replace(/^function /, `globalThis.${n}=function `)); });

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ---- The Alerts card, with an actual active "running low" alert ----
// (the exact scenario that was broken -- every prior smoke test used empty
// supplies/hatches, so this specific branch never actually ran until now)
{
  globalThis.STATE = { supplies: [{ category: "Meat Feed", status: "Empty", date_emptied: null }], hatches: [] };
  const body = extractIife("const muted = getMutedAlertCategories();");
  const fn = new Function(body);
  let html;
  try { html = fn(); } catch (err) { assert.fail(`Alerts card threw with an active low-supply alert: ${err.message}`); }
  ok(html.includes("Meat Feed"), "low-supply alert should render the category name");
  ok(html.includes("out") || html.includes("left"), "low-supply alert should render a status word (out/left), not a raw status code or undefined");
  ok(!html.includes("undefined"), "rendered alert HTML should never contain the literal string 'undefined'");
}

// ---- The same card, with an active hatching clutch ----
{
  globalThis.STATE = { supplies: [], hatches: [{ breed: "Orpington", date_started: "2026-08-05", status: "Incubating", egg_count: 12 }] };
  const body = extractIife("const muted = getMutedAlertCategories();");
  const fn = new Function(body);
  let html;
  try { html = fn(); } catch (err) { assert.fail(`Alerts card threw with an active clutch: ${err.message}`); }
  ok(html.includes("Orpington"), "active clutch should render its breed");
  ok(!html.includes("undefined"), "rendered clutch HTML should never contain the literal string 'undefined'");
}

// ---- The Flock panel's Hatching subhead (folded in this session) ----
{
  const fnBody = extractIife("const flockBody = statPanelHero");
  ["statPanel", "statPanelHero", "statPanelHeroPair", "statPanelRow", "statPanelRows", "statPanelSubhead"].forEach(n => {
    (0, eval)(grab(n).replace(/^function /, `globalThis.${n}=function `));
  });
  globalThis.getWeightUnit = () => "lb";
  globalThis.displayWeight = (n) => (Number(n) || 0).toFixed(1);
  globalThis.fmtMoney = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  globalThis.weightLabel = (n) => `${n.toFixed(1)} lb`;
  globalThis.BIRD_TYPE_ICONS = { layer: { emoji: "🥚" }, meat: { emoji: "🍗" } };
  globalThis.deltaChipHtml = () => "";
  globalThis.deltaChipHtmlAbs = () => "";
  globalThis.feedTotalForMonth = () => 12.5;
  globalThis.beddingTotalForMonth = () => 8.2;
  globalThis.monthOverMonthCompare = () => ({ cur: 0, prev: 0 });
  globalThis.rawValueBetween = () => 0;
  globalThis.spendBetween = () => 0;
  globalThis.netBetween = () => 0;

  const s = { active: 6, layers: 6, meatActive: 0, lossesThisMonth: 0, processedThisMonth: 0, incomeMonth: 42.5, eggsThisMonth: 6, eggTotalValueMonth: 2.4, weightThisMonth: 0, meatTotalValueMonth: 0, thisMonth: 30, netMonth: 12.5 };
  const ys = { chicksHatched: 3, hatchLoss: 1, hatchClear: 0, hatchQuit: 0, hatchFailed: 1 };
  const tr = { flockW: [3, 3, 4, 4, 5] };
  const fn = new Function("s", "ys", "currentYear", "selectedMonthKey", "tr", fnBody);
  let html;
  try { html = fn(s, ys, "2026", "2026-08", tr); } catch (err) { assert.fail(`Flock panel with hatching subhead threw: ${err.message}`); }
  ok(html.includes("Hatching (2026)"), "hatching subhead should be present and year-labeled");
  ok(html.includes("Chicks hatched"), "hatching row labels should be present");
  ok(!html.includes("undefined"), "rendered Flock panel HTML should never contain the literal string 'undefined'");
}

console.log(`✓ dashboard render: ${passed} assertions passed`);
