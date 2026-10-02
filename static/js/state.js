// Shared application state, constants and defaults.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

const COOP_KEY = "coopLedgerCurrentCoop";
const PAGE_SIZE = 100; // "load more" page size for the Eggs/Expenses/Archive lists
const STATE = { coops: [], birds: [], eggs: [], expenses: [], bedding: [], birdLogs: [], notes: [], supplies: [], hatches: [], hatchEggs: [], birdPhotos: [], activityLog: [], supplyProducts: [] };
let currentCoopId = null;
let activeTab = "dashboard";
// Dashboard month view: which month is shown, which month overlays it for
// comparison, and (for the spend chart) which category is isolated. Default to
// the current month vs the previous month.
let dashMonthKey = null;       // set on first render to current month
let dashCompareKey = null;     // set to previous month
let dashFeedType = "both";     // dashboard feed chart: "layer" | "meat" | "both"
let dashProduceType = "eggs";  // combined produce card: "eggs" | "meat" (eggs default -- daily data; meat only a few months/yr)
let reviewMoneyMode = "net";   // Year Review money chart -- net first, same as the dashboard: "spend" | "income" | "net"
// Dashboard "money" mega-chart: mode (spend/income/net) plus which pill is
// selected within spend and income modes (null = all).
let dashMoneyMode = "net";
let dashSpendPill = new Set();   // EXPENSE_CATEGORIES values selected; empty = all
let dashIncomePill = new Set();  // "Egg value" | "Meat value" | income categories selected; empty = all
// Year Review mega-chart pill selection (mode reuses reviewMoneyMode).
let reviewSpendPill = new Set();
let reviewIncomePill = new Set();
/** Toggles a multi-select pill Set in place: clicking "All" (empty value)
 * clears the selection back to "show everyone"; clicking a specific pill
 * adds it if not already selected, removes it if it is -- so tapping Layer
 * Feed then Meat Feed shows both together, and tapping either one again
 * drops just that one back out, leaving the other still selected. */
function togglePillSelection(set, value) {
  if (!value) { set.clear(); return; }
  if (set.has(value)) set.delete(value);
  else set.add(value);
}
/** Readable label for a chart title: "" when empty (All), the one name when
 * a single pill is selected, or a comma-joined list for multiple. */
function pillLabel(set) {
  return set.size ? [...set].join(", ") : "";
}
let reviewProduceType = "eggs"; // Year Review produce card: "eggs" | "meat"
let reviewFeedType = "both";    // Year Review feed card: "layer" | "meat" | "both"
let charts = {};

const BIRD_TYPES = ["Layer", "Meat", "Dual Purpose"];
const BIRD_STATUSES = ["Active", "Processed", "Sold", "Deceased", "Retired"];
const EXPENSE_CATEGORIES = ["Layer Feed", "Layer Supplements", "Meat Feed", "Treats", "Bedding", "Building Materials", "Equipment", "Birds/Chicks", "Medical/Health", "Other"];

// Emoji + a two-stop gradient per category, so each finance row leads with a
// small colored icon tile instead of a text stamp -- readable at a glance and
// far more compact, leaving the row's width for the actual description. The two
// hex stops give the tile a slight top-lit gradient for depth. Colors follow
// the category's meaning (feed golds, meat rust, bedding autumn, etc.).
// Icons for non-egg/meat income sources, for the value-by-source breakdown.
const INCOME_ICONS = {
  "Bird Sale":    { emoji: "🐔", from: "#C9A05B", to: "#9A7238" },
  "Other Income": { emoji: "💰", from: "#9DAE68", to: "#6E7E45" },
  "Egg Sale":     { emoji: "🥚", from: "#E4B62C", to: "#B4860E" },
  "Meat Sale":    { emoji: "🍗", from: "#D0623C", to: "#9E3E20" },
};

const CATEGORY_ICONS = {
  "Layer Feed":         { emoji: "🌾", from: "#E4B62C", to: "#B4860E" }, // yellow/gold
  "Layer Supplements":  { emoji: "🦪", from: "#C9CBD4", to: "#9195A6" }, // pale shell/calcium -- oyster shell, grit
  "Meat Feed":          { emoji: "🌾", from: "#D0623C", to: "#9E3E20" }, // meat red
  "Treats":             { emoji: "🌻", from: "#9DAE68", to: "#6E7E45" }, // green
  "Bedding":            { emoji: "🍂", from: "#D08A3C", to: "#A85E22" }, // rust/orange
  "Building Materials": { emoji: "🔨", from: "#8C8074", to: "#5E544A" }, // grey/brown
  "Equipment":          { emoji: "📦", from: "#9A7B54", to: "#6E5233" }, // brown
  "Birds/Chicks":       { emoji: "🐤", from: "#E4E7EC", to: "#AEB4BE" }, // silvery/white -- distinct from gold layer feed
  "Medical/Health":     { emoji: "🩺", from: "#8AA0B4", to: "#5E7488" }, // slate blue
  "Other":              { emoji: "🏷️", from: "#6E6258", to: "#463E38" }, // dark slate/brown
  // Income categories reuse a neutral sage tile -- income rows don't need a
  // spending-category icon, but should still render something rather than break.
  "_income":            { emoji: "💰", from: "#9DAE68", to: "#6E7E45" },
};

/** A rounded, gradient icon tile for a finance category. Falls back to the
 * "Other" tile for any unmapped/custom category so a row never renders blank. */
function categoryIconTile(category, isIncome) {
  const spec = isIncome ? CATEGORY_ICONS["_income"] : (CATEGORY_ICONS[category] || CATEGORY_ICONS["Other"]);
  return `<div class="cat-icon" title="${esc(category || "")}" style="background:linear-gradient(145deg, ${spec.from}, ${spec.to})"><span>${spec.emoji}</span></div>`;
}

// Shared bird-type visual language: layers = egg on gold, meat = drumstick on
// rust. Used for the finance "applies to" tiles, the flock group headers, and
// the dashboard's active-birds breakdown, so the same two symbols mean the
// same thing everywhere in the app.
const BIRD_TYPE_ICONS = {
  layer: { emoji: "🥚", from: "#E4B62C", to: "#B4860E" },
  meat:  { emoji: "🍗", from: "#D0623C", to: "#9E3E20" },
};

/** Small egg/meat tile for an expense's audience ("Layers Only" / "Meat Birds
 * Only"). Only rendered for targeted expenses -- an all-birds expense shows
 * nothing, so the tile that IS shown carries real meaning at a glance. */
function audienceTile(forType) {
  const spec = forType === "Meat Birds Only" ? BIRD_TYPE_ICONS.meat : BIRD_TYPE_ICONS.layer;
  return `<span class="audience-tile" title="${esc(forType)}" style="background:linear-gradient(145deg, ${spec.from}, ${spec.to})">${spec.emoji}</span>`;
}
const INCOME_CATEGORIES = ["Egg Sale", "Meat Sale", "Bird Sale", "Other Income"];
// Egg Sale and Meat Sale get their quantity/unit locked, same idea as feed
// categories -- this is what lets the wash-out math work out how many eggs
// or lbs of meat a sale represents, not just its dollar amount.
const INCOME_UNIT_LOCKS = { "Egg Sale": "eggs", "Meat Sale": "lb" };
const BEDDING_AREAS = ["Coop Floor", "Nesting Boxes", "Run"];
const BEDDING_MATERIALS = ["Pine Shavings", "Straw", "Sand", "Hemp Bedding", "Deep Litter (mixed)", "Other"];
const BEDDING_TYPES = ["Top-off", "Churn", "Top-off + Churn", "Full Clean-out"];
const FLOCK_DATE_FIELDS = [
  { label: "Any date", value: "" },
  { label: "Acquired", value: "acquired_date" },
  { label: "Hatched", value: "hatch_date" },
  { label: "Harvested", value: "harvest_date" },
  { label: "Lost", value: "death_date" },
];
let flockFilters = { status: "Active", type: "", dateField: "", year: "", location: "" };
let flockFiltersOpen = false;
let flockSort = "newest"; // "newest" | "name" | "age" | "target"
// Health log scope. Defaults to active birds only -- once a bird is
// processed or lost, its old health notes are history that would otherwise
// pile up at the bottom of the list and bury the entries you'd actually act
// on. "all" brings them back when you want the full record.
let healthLogScope = "active"; // "active" | "all"
// Per-device, not synced -- the right density on a phone isn't the right
// density on a desktop, so this is a device preference the way photo
// quality is. "grid" + "cozy" reproduces the layout that existed before.
const FLOCK_VIEW_KEY = "coop_flock_view";
const FLOCK_DENSITY_KEY = "coop_flock_density";
function getFlockView() { return localStorage.getItem(FLOCK_VIEW_KEY) === "list" ? "list" : "grid"; }
function setFlockView(v) { localStorage.setItem(FLOCK_VIEW_KEY, v === "list" ? "list" : "grid"); }
function getFlockDensity() {
  const d = localStorage.getItem(FLOCK_DENSITY_KEY);
  return ["comfortable", "cozy", "compact"].includes(d) ? d : "cozy";
}
function setFlockDensity(d) { localStorage.setItem(FLOCK_DENSITY_KEY, d); }
/** The class list every .flock-grid gets, so the main grid, the filtered
 * flat grid, and the grid inside an expanded batch panel all honor the
 * same preference from one place. */
/** List/Grid toggle plus, in grid mode, a density stepper. Deliberately
 * three named density tiers rather than a 1-to-5 column slider: the useful
 * column count depends on viewport width (5-up is fine on a desktop and
 * unreadable on a phone), so picking a *density* and letting the grid
 * auto-fill to fit gives the right answer on every screen instead of the
 * same wrong one everywhere. */
function flockViewControlHtml() {
  const view = getFlockView();
  const d = getFlockDensity();
  const densities = [
    { id: "comfortable", label: "Large", title: "Fewer, larger cards" },
    { id: "cozy", label: "Medium", title: "Default size" },
    { id: "compact", label: "Small", title: "More, smaller cards" },
  ];
  return `
    <div class="range-select" style="margin:0;gap:4px">
      <button class="range-btn ${view === "grid" ? "active" : ""}" id="flockViewGrid" title="Grid view">▦</button>
      <button class="range-btn ${view === "list" ? "active" : ""}" id="flockViewList" title="List view">☰</button>
    </div>
    ${view === "grid" ? `
    <div class="range-select" style="margin:0;gap:4px">
      ${densities.map(x => `<button class="range-btn ${d === x.id ? "active" : ""}" data-flock-density="${x.id}" title="${x.title}">${x.label}</button>`).join("")}
    </div>` : ""}
  `;
}

function flockGridClass() {
  const view = getFlockView();
  if (view === "list") return "flock-grid view-list";
  const d = getFlockDensity();
  return `flock-grid${d === "cozy" ? "" : ` density-${d}`}`; // cozy == the default grid, no extra class
}
let selectedBirdIds = new Set();
let selectedSupplyIds = new Set();

const selectionState = {
  birds: { mode: false, lastClicked: null },
  supplies: { mode: false, lastClicked: null },
  eggs: { mode: false, lastClicked: null },
  notes: { mode: false, lastClicked: null },
  expenses: { mode: false, lastClicked: null },
  products: { mode: false, lastClicked: null },
  bedding: { mode: false, lastClicked: null },
};
let selectedEggIds = new Set();
let selectedNoteIds = new Set();
let selectedExpenseIds = new Set();
let selectedProductIds = new Set();
let selectedBeddingIds = new Set();

/** "☑ Select" / "✕ Cancel selection" toggle button, shared markup for every
 * simple list that only needs bulk delete (birds/supplies have their own
 * richer version with bulk-edit too). */
function selectModeButtonHtml(stateKey, btnId) {
  const active = selectionState[stateKey].mode;
  return `<button class="btn ${active ? "btn-close" : "ghost"} small" id="${btnId}">${active ? "✕ Cancel selection" : "☑ Select"}</button>`;
}
/** The "N selected / Delete selected / Clear" bar itself. */
function bulkDeleteBarHtml(idsSet) {
  if (idsSet.size === 0) return "";
  return `
    <div class="form-block" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-color:var(--rust);margin-bottom:12px">
      <div><strong style="color:var(--text)">${idsSet.size}</strong> selected</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-close small" id="bulkDeleteSelectedBtn">Delete selected</button>
        <button class="btn ghost small" id="clearSelectedBtn">Clear</button>
      </div>
    </div>
  `;
}
/** Wires the two buttons bulkDeleteBarHtml renders. refreshState reloads
 * whatever slice of STATE this list reads from (e.g. STATE.eggs); renderFn
 * re-renders the list itself afterward. */
function wireBulkDeleteBar(idsSet, resource, itemLabel, refreshState, renderFn, itemLabelPlural) {
  const plural = itemLabelPlural || `${itemLabel}s`;
  const delBtn = document.getElementById("bulkDeleteSelectedBtn");
  if (delBtn) delBtn.addEventListener("click", async () => {
    const n = idsSet.size;
    if (!(await showConfirmDialog(`Delete ${n} selected ${n !== 1 ? plural : itemLabel}? This can't be undone.`))) return;
    await localBulkDelete(resource, [...idsSet], currentCoopId);
    showToast(`${n} ${n !== 1 ? plural : itemLabel} deleted`, "delete");
    idsSet.clear();
    await refreshState();
    renderFn();
  });
  const clearBtn = document.getElementById("clearSelectedBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => { idsSet.clear(); renderFn(); });
}

/** Wires selection interaction onto a set of already-rendered cards.
 * cards: NodeList/array of elements, each carrying a data-id.
 * idsSet: the Set tracking selected ids (selectedBirdIds / selectedSupplyIds).
 * stateKey: "birds" | "supplies" -- which entry in selectionState above.
 * orderedIds: () => array of ids in current display order, for shift-click range-select.
 * onOpen: (id) => void -- the normal "open this item" action when not in selection mode.
 * onChange: () => void -- re-render after any selection change. */
function wireCardSelection(cards, idsSet, stateKey, orderedIds, onOpen, onChange) {
  const state = selectionState[stateKey];
  const toggle = (id) => { if (idsSet.has(id)) idsSet.delete(id); else idsSet.add(id); };
  cards.forEach(card => {
    const id = card.dataset.id;
    if (!id) return;
    let pressTimer = null, longPressFired = false, startXY = null;

    card.addEventListener("touchstart", (e) => {
      longPressFired = false;
      const t = e.touches[0];
      startXY = { x: t.clientX, y: t.clientY };
      pressTimer = setTimeout(() => {
        longPressFired = true;
        state.mode = true;
        toggle(id);
        state.lastClicked = id;
        if (navigator.vibrate) navigator.vibrate(12);
        onChange();
      }, 500);
    }, { passive: true });
    card.addEventListener("touchmove", (e) => {
      if (!pressTimer || !startXY) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - startXY.x) > 10 || Math.abs(t.clientY - startXY.y) > 10) { clearTimeout(pressTimer); pressTimer = null; }
    }, { passive: true });
    card.addEventListener("touchend", () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });

    card.addEventListener("click", (e) => {
      if (longPressFired) { longPressFired = false; return; } // the long-press already acted on this tap
      if (e.shiftKey && state.lastClicked) {
        e.preventDefault();
        state.mode = true;
        const order = orderedIds();
        const a = order.indexOf(state.lastClicked), b = order.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) idsSet.add(order[i]);
        } else {
          toggle(id);
        }
        state.lastClicked = id;
        onChange();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        state.mode = true;
        toggle(id);
        state.lastClicked = id;
        onChange();
        return;
      }
      if (state.mode) {
        toggle(id);
        state.lastClicked = id;
        onChange();
        return;
      }
      onOpen(id);
    });
  });
}

let expandedBatches = new Set();
let eggFilters = { year: "" };
let editingEggId = null;
let eggFiltersOpen = false;
let eggsVisibleCount = PAGE_SIZE;
let expenseFilters = { category: "", year: "" };
let expenseMonthKey = null; // "yyyy-MM" of the currently viewed month; null = current month
let editingExpenseId = null;
let expenseFormEntryType = "expense";
let pendingExpenseCategory = null; // persists a new entry's category choice across re-renders (product selection, income/expense toggle) that would otherwise rebuild the dropdown back to its default
let expenseScope = "month"; // "month" | "year" | "all"
// Whether the finance list also shows read-only "value produced" references
// (egg collections, processed birds) interleaved by date -- opt-in, persisted,
// and defaulted off. Eggs especially are usually logged daily, so blending
// them in unconditionally on an All-Time or full-year view would bury the
// actual transactions the page exists to show. Clicking a reference opens the
// real egg/bird record directly; nothing about it is stored here or editable
// here, so there's exactly one place these are ever created or changed.
const SHOW_VALUE_REFS_KEY = "coopLedgerShowValueRefs";
let showValueRefs = localStorage.getItem(SHOW_VALUE_REFS_KEY) !== "0";
let expenseYearKey = null;
let expenseYearKeyTo = null; // "to" end when range mode is active
let expenseMonthKeyTo = null; // "to" end when range mode is active
let expenseRangeMode = false;
let expensesVisibleCount = PAGE_SIZE;
let beddingFilters = { area: "", entryType: "", year: "" };
let editingBeddingId = null;
let beddingFiltersOpen = false;
let selectedProductId = null; // shared by both the direct supply form and the expense form's auto-create flow
let newProductFormOpen = false;
let editingProductId = null;
let newProductCategory = null; // which category "+ Add Product" was clicked for, on the standalone Products page
let pendingProductPhotoBlob = null;
let feedSupplyVisibleCount = PAGE_SIZE;
let beddingSupplyVisibleCount = PAGE_SIZE;
const SUPPLY_STATUSES = ["Full", "3/4", "1/2", "1/4", "Empty"];
const FEED_SUPPLY_CATEGORIES = new Set(["Layer Feed", "Meat Feed", "Treats"]); // Feed section, and also the categories locked to "lb" below
function supplyStatusTone(status) {
  if (status === "Full" || status === "3/4") return "sage";
  if (status === "1/2") return "gold";
  if (status === "1/4") return "rust";
  return "slate"; // Empty
}
/** Category color, separate from the status tone above (which reflects
 * fullness, not type) -- gives each kind of supply its own identity so the
 * inventory grid reads as more than one undifferentiated pile of cards. */
function supplyCategoryTone(category) {
  if (category === "Layer Feed") return "gold";
  if (category === "Meat Feed") return "rust";
  if (category === "Treats") return "sage";
  if (category === "Bedding") return "slate";
  return "slate";
}
function supplyFraction(status) { return { "Full": 1, "3/4": 0.75, "1/2": 0.5, "1/4": 0.25, "Empty": 0 }[status] ?? 1; }
function supplyStampLabel(s) {
  if (!s.quantity) return s.status; // no quantity recorded -- nothing to compute a remaining amount from
  const remaining = s.quantity * supplyFraction(s.status);
  const remainingStr = Number.isInteger(remaining) ? String(remaining) : remaining.toFixed(1);
  const unitStr = s.unit ? ` ${s.unit}` : "";
  if (s.status === "Full") return s.opened_at ? `Opened, ${remainingStr}${unitStr}` : `Full ${remainingStr}${unitStr}`;
  if (s.status === "Empty") return "Empty";
  return `${s.status} ${remainingStr}${unitStr} Left`;
}

/** Feed categories always come in pounds in practice, and bedding materials
 * (shavings, straw, etc.) are conventionally sold and measured by the cubic
 * foot -- locking each category's unit keeps "total used" additions
 * accurate instead of silently mixing units that can't be summed. */
const UNIT_LOCKS = { "Layer Feed": "lb", "Meat Feed": "lb", "Treats": "lb", "Bedding": "cu ft" };
function applyFeedUnitLock(categorySelId, unitSelId, lockMap = UNIT_LOCKS) {
  const catEl = document.getElementById(categorySelId);
  const unitEl = document.getElementById(unitSelId);
  if (!catEl || !unitEl) return;
  const sync = () => {
    const locked = lockMap[catEl.value];
    if (locked) {
      unitEl.value = locked;
      unitEl.disabled = true;
    } else {
      unitEl.disabled = false;
    }
  };
  sync();
  catEl.addEventListener("change", sync);
}
let beddingVisibleCount = PAGE_SIZE;
let reviewYear = null;
/** The month the Overview's Flock/Value panels show -- null means "today's
 * month." Mirrors reviewYear's pattern: validated against the real list of
 * months with data each render, so a stale selection (e.g. the last coop
 * had that month, this one doesn't) can't point at nothing. */
let dashSelectedMonth = null;
const DEFAULT_BEDDING_THRESHOLDS = {
  "Coop Floor": { warn: 120, danger: 180, churn: 7 },
  "Nesting Boxes": { warn: 60, danger: 90, churn: 7 },
  "Run": { warn: 120, danger: 180, churn: 7 },
};

