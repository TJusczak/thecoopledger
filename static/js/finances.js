// Finances: expenses, income, reports.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= EXPENSES =================
const EXPENSE_FOR_TYPES = ["All Birds", "Layers Only", "Meat Birds Only"];
// Weight is stored canonically in lb; the coop's weight toggle decides how it
// is shown. "kg" is deliberately NOT an option here -- picking a weight unit
// per item is what let a 20 kg bag get summed as "20" against a 50 lb bag's
// "50". The lb option renders with whatever label the toggle is set to.
const EXPENSE_UNITS = ["lb", "cu ft", "bag", "bale", "gallon", "unit", "eggs"];
function isWeightUnit(u) { return u === "lb" || u === "kg"; }
/** How a unit is labeled in the UI: weights follow the toggle, others are literal. */
function unitLabel(u) { return isWeightUnit(u) ? getWeightUnit() : (u || ""); }
/** A stored quantity shown in the user's units: weights convert, others don't. */
function displayQty(qty, unit) {
  if (qty == null || qty === "") return "";
  return isWeightUnit(unit) ? displayWeight(qty) : String(+Number(qty).toFixed(2));
}
/** Quantity label for an expense card: "100 lb" normally, or "50 lb x 2" when
 * the expense covers several identical items (e.g. two feed bags bought in
 * one entry). itemCount is purely a display breakdown of the same total --
 * every calculation elsewhere already uses the stored total and is unaffected
 * either way. Division happens on the DISPLAY value (post kg/lb conversion),
 * not the raw stored one, so the per-item figure is never a raw/converted mix. */
function quantityWithCountLabel(qty, unit, itemCount) {
  const totalLabel = `${displayQty(qty, unit)} ${unitLabel(unit)}`;
  if (!itemCount || itemCount <= 1) return totalLabel;
  const totalDisplay = isWeightUnit(unit) ? Number(displayWeight(qty)) : Number(qty);
  if (!(totalDisplay > 0)) return totalLabel;
  const perItem = +(totalDisplay / itemCount).toFixed(2);
  return `${perItem} ${unitLabel(unit)} × ${itemCount} (${totalLabel} total)`;
}
/** A quantity the user typed converted back to storage units (lb for weights). */
function parseQtyInput(val, unit) {
  if (val === "" || val == null) return null;
  return isWeightUnit(unit) ? parseWeightInput(val) : Number(val);
}
/** Unit <option> list, labeling the weight unit per the toggle. */
function unitOptionsHtml(selected) {
  return EXPENSE_UNITS.map(u => `<option value="${u}" ${selected === u || (isWeightUnit(selected) && u === "lb") ? "selected" : ""}>${unitLabel(u)}</option>`).join("");
}
const QUANTITY_CATEGORIES = new Set(["Layer Feed", "Meat Feed", "Treats", "Bedding"]); // categories where "how much did I buy" is worth tracking

function yearsFromDates(items, field) {
  const years = new Set(items.filter(i => i[field]).map(i => i[field].slice(0, 4)));
  return [...years].sort().reverse();
}

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthKeyOf(dateStr) { return dateStr ? dateStr.slice(0, 7) : null; }
function shiftMonthKey(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabelOf(key) {
  const d = new Date(`${key}-01T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function allExpenseMonthKeys() {
  const keys = new Set(STATE.expenses.map(x => monthKeyOf(x.date)).filter(Boolean));
  keys.add(monthKeyOf(todayStr()));
  return [...keys].sort();
}

function expenseYearKeys() {
  const keys = new Set(STATE.expenses.map(x => x.date.slice(0, 4)));
  keys.add(String(new Date().getFullYear()));
  return [...keys].sort();
}

/** Snapshot the wash-out price at the moment a sale is saved, using only
 * eggs/meat collected on or before the sale's own date -- once saved, this
 * is locked in and won't shift later just because more got collected
 * afterward. Only meaningful for Egg Sale / Meat Sale income entries. */
function computeWashoutSnapshotPrice(category, entryDate) {
  const defaults = getCoopDefaults();
  if (category === "Egg Sale") {
    return weightedAvgEggPrice(STATE.eggs.filter(e => e.date <= entryDate), Number(defaults.eggPrice) || 0);
  }
  if (category === "Meat Sale") {
    return weightedAvgMeatPrice(STATE.birds.filter(b => b.status === "Processed" && b.harvest_date && b.harvest_date <= entryDate), Number(defaults.pricePerLb) || 0);
  }
  return null;
}
function renderExpenses() {
  const el = document.getElementById("panel-expenses");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }

  let scopedExpenses, navHtml, periodLabel, scopeTest;

  if (expenseScope === "all") {
    scopedExpenses = STATE.expenses;
    periodLabel = "All time";
    navHtml = "";
    scopeTest = () => true;
  } else if (expenseScope === "year") {
    const years = expenseYearKeys();
    const minYear = Number(years[0]), maxYear = Number(years[years.length - 1]);
    if (!expenseYearKey || !years.includes(expenseYearKey)) expenseYearKey = String(new Date().getFullYear());
    if (expenseRangeMode) {
      if (!expenseYearKeyTo || !years.includes(expenseYearKeyTo)) expenseYearKeyTo = expenseYearKey;
      const fromY = Math.min(Number(expenseYearKey), Number(expenseYearKeyTo));
      const toY = Math.max(Number(expenseYearKey), Number(expenseYearKeyTo));
      scopedExpenses = STATE.expenses.filter(x => { const y = Number(x.date.slice(0, 4)); return y >= fromY && y <= toY; });
      periodLabel = fromY === toY ? String(fromY) : `${fromY}–${toY}`;
      scopeTest = (d) => { const y = Number((d || "").slice(0, 4)); return y >= fromY && y <= toY; };
      navHtml = `
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <button class="icon-btn icon-btn-period" id="prevPeriod" ${fromY <= minYear ? "disabled" : ""} style="font-size:18px">‹</button>
          <span class="dim" style="font-size:12px">From</span>
          <select class="period-select" id="rangeFromYear">${years.map(y => `<option value="${y}" ${Number(y) === fromY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <span class="dim" style="font-size:12px">to</span>
          <select class="period-select" id="rangeToYear">${years.map(y => `<option value="${y}" ${Number(y) === toY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <button class="icon-btn icon-btn-period" id="nextPeriod" ${toY >= maxYear ? "disabled" : ""} style="font-size:18px">›</button>
        </div>`;
    } else {
      const y = Number(expenseYearKey);
      scopedExpenses = STATE.expenses.filter(x => x.date.slice(0, 4) === expenseYearKey);
      periodLabel = expenseYearKey;
      scopeTest = (d) => (d || "").slice(0, 4) === expenseYearKey;
      navHtml = `
        <div style="display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
          <button class="icon-btn icon-btn-period" id="prevPeriod" ${y <= minYear ? "disabled" : ""} style="font-size:20px">‹</button>
          <select class="period-select" id="jumpPeriod">${years.map(y2 => `<option value="${y2}" ${y2 === expenseYearKey ? "selected" : ""}>${y2}</option>`).join("")}</select>
          <button class="icon-btn icon-btn-period" id="nextPeriod" ${y >= maxYear ? "disabled" : ""} style="font-size:20px">›</button>
        </div>`;
    }
  } else {
    const monthKeys = allExpenseMonthKeys();
    const minKey = monthKeys[0], maxKey = monthKeys[monthKeys.length - 1];
    const yearsForMonth = expenseYearKeys();
    if (!expenseMonthKey || !monthKeys.includes(expenseMonthKey)) expenseMonthKey = monthKeyOf(todayStr());
    if (expenseRangeMode) {
      if (!expenseMonthKeyTo) expenseMonthKeyTo = expenseMonthKey;
      const fromKey = expenseMonthKey <= expenseMonthKeyTo ? expenseMonthKey : expenseMonthKeyTo;
      const toKey = expenseMonthKey <= expenseMonthKeyTo ? expenseMonthKeyTo : expenseMonthKey;
      scopedExpenses = STATE.expenses.filter(x => { const k = monthKeyOf(x.date); return k >= fromKey && k <= toKey; });
      periodLabel = fromKey === toKey ? monthLabelOf(fromKey) : `${monthLabelOf(fromKey)} – ${monthLabelOf(toKey)}`;
      scopeTest = (d) => { const k = monthKeyOf(d); return k >= fromKey && k <= toKey; };
      const [fromY, fromM] = fromKey.split("-");
      const [toY, toM] = toKey.split("-");
      const monthOptions = (selectedM) => MONTH_NAMES_SHORT.map((name, i) => `<option value="${String(i + 1).padStart(2, "0")}" ${String(i + 1).padStart(2, "0") === selectedM ? "selected" : ""}>${name}</option>`).join("");
      navHtml = `
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <button class="icon-btn icon-btn-period" id="prevPeriod" ${fromKey <= minKey ? "disabled" : ""} style="font-size:18px">‹</button>
          <span class="dim" style="font-size:12px">From</span>
          <select class="period-select" id="rangeFromMonth">${monthOptions(fromM)}</select>
          <select class="period-select" id="rangeFromYear">${yearsForMonth.map(y => `<option value="${y}" ${y === fromY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <span class="dim" style="font-size:12px">to</span>
          <select class="period-select" id="rangeToMonth">${monthOptions(toM)}</select>
          <select class="period-select" id="rangeToYear">${yearsForMonth.map(y => `<option value="${y}" ${y === toY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <button class="icon-btn icon-btn-period" id="nextPeriod" ${toKey >= maxKey ? "disabled" : ""} style="font-size:18px">›</button>
        </div>`;
    } else {
      const [curY, curM] = expenseMonthKey.split("-");
      scopedExpenses = STATE.expenses.filter(x => monthKeyOf(x.date) === expenseMonthKey);
      periodLabel = monthLabelOf(expenseMonthKey);
      scopeTest = (d) => monthKeyOf(d) === expenseMonthKey;
      navHtml = `
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <button class="icon-btn icon-btn-period" id="prevPeriod" ${expenseMonthKey <= minKey ? "disabled" : ""} style="font-size:20px">‹</button>
          <select class="period-select" id="jumpMonth">${MONTH_NAMES_SHORT.map((name, i) => `<option value="${String(i + 1).padStart(2, "0")}" ${String(i + 1).padStart(2, "0") === curM ? "selected" : ""}>${name}</option>`).join("")}</select>
          <select class="period-select" id="jumpYear">${yearsForMonth.map(y => `<option value="${y}" ${y === curY ? "selected" : ""}>${y}</option>`).join("")}</select>
          <button class="icon-btn icon-btn-period" id="nextPeriod" ${expenseMonthKey >= maxKey ? "disabled" : ""} style="font-size:20px">›</button>
        </div>`;
    }
  }

  // Category totals for the whole scoped period, regardless of the active
  // category filter -- tapping one both shows its total and filters the list.
  // Categories never mix income and expense (their names don't overlap), so
  // each category's own total is safe to show as a plain positive amount --
  // it's only the OVERALL summary that needs to distinguish direction.
  const categoryTotals = {};
  const categoryQuantities = {}; // { category: { unit: totalQty } } -- quantities only sum cleanly within the same unit
  scopedExpenses.forEach(x => {
    categoryTotals[x.category] = (categoryTotals[x.category] || 0) + (Number(x.amount) || 0);
    if (x.quantity && x.unit) {
      categoryQuantities[x.category] = categoryQuantities[x.category] || {};
      categoryQuantities[x.category][x.unit] = (categoryQuantities[x.category][x.unit] || 0) + Number(x.quantity);
    }
  });
  const totalSpent = scopedExpenses.filter(x => x.entry_type !== "income").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const totalEarned = scopedExpenses.filter(x => x.entry_type === "income").reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const netForPeriod = totalEarned - totalSpent;
  const sortedCats = Object.keys(categoryTotals).sort((a, b) => categoryTotals[b] - categoryTotals[a]);
  const quantityLabel = (cat) => {
    const q = categoryQuantities[cat];
    if (!q) return "";
    return " · " + Object.entries(q).map(([unit, total]) => `${total} ${unit}`).join(", ");
  };

  const filteredExpenses = scopedExpenses.filter(x => !expenseFilters.category || x.category === expenseFilters.category);
  const sorted = [...filteredExpenses].sort((a, b) => a.date.localeCompare(b.date));

  // Optional read-only "value produced" references (egg collections, processed
  // birds) interleaved by date -- opt-in via showValueRefs, and only when no
  // category filter is active (they don't belong to any expense category, so
  // showing them while filtered to e.g. "Bedding" would be confusing). These
  // never feed into totalSpent/totalEarned/categoryTotals above, and they
  // don't move the running balance below either -- they're display-only
  // pointers back to the real egg/bird record, the one and only place that
  // data is ever created or edited.
  const valueRefRows = [];
  if (showValueRefs && !expenseFilters.category) {
    const d = getCoopDefaults();
    const eggFallback = Number(d.eggPrice) || 0, meatFallback = Number(d.pricePerLb) || 0;
    STATE.eggs.forEach(e => {
      if (!e.date || !scopeTest(e.date)) return;
      const count = Number(e.count) || 0;
      if (count <= 0) return;
      valueRefRows.push({
        kind: "egg", date: e.date, sourceId: e.id,
        amount: count * (Number(e.price_per_egg) || eggFallback),
        label: `${count} egg${count !== 1 ? "s" : ""} collected`,
      });
    });
    STATE.birds.forEach(b => {
      if (b.status !== "Processed" || !b.harvest_date || !scopeTest(b.harvest_date)) return;
      const weight = Number(b.harvest_weight) || 0;
      if (weight <= 0) return;
      valueRefRows.push({
        kind: "meat", date: b.harvest_date, sourceId: b.id,
        amount: weight * (Number(b.price_per_lb) || meatFallback),
        label: `${b.name ? b.name + " processed" : "Bird processed"} — ${weightLabel(weight)}`,
      });
    });
    STATE.birds.forEach(b => {
      if (!b.sold_date || !scopeTest(b.sold_date) || !(Number(b.sold_amount) > 0)) return;
      valueRefRows.push({
        kind: "sold", date: b.sold_date, sourceId: b.id,
        amount: Number(b.sold_amount),
        label: `${b.name ? b.name + " sold" : "Bird sold"}`,
      });
    });
  }

  // One chronological list for display. Real entries step the running balance
  // forward exactly as before; a value reference just carries that running
  // figure along for context at its position, without being counted as a
  // change to it -- it isn't money moving, so it shouldn't look like it is.
  const combined = [
    ...sorted.map(x => ({ real: x, date: x.date })),
    ...valueRefRows.map(r => ({ ref: r, date: r.date })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const rows = combined.map(item => {
    if (item.real) { running += (item.real.entry_type === "income" ? 1 : -1) * (Number(item.real.amount) || 0); return { x: item.real, running, isRef: false }; }
    return { ref: item.ref, running, isRef: true };
  });

  el.innerHTML = `
    <div class="range-select" style="margin-bottom:10px;justify-content:center">
      <button class="range-btn ${expenseScope === "month" ? "active" : ""}" data-scope="month">Month</button>
      <button class="range-btn ${expenseScope === "year" ? "active" : ""}" data-scope="year">Year</button>
      <button class="range-btn ${expenseScope === "all" ? "active" : ""}" data-scope="all">All</button>
      ${expenseScope !== "all" ? `<button class="range-btn ${expenseRangeMode ? "active" : ""}" id="toggleRangeMode">↔ Range</button>` : ""}
    </div>

    ${navHtml}

    <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-bottom:12px">
      ${sortedCats.map(cat => `<button class="pill-btn ${expenseFilters.category === cat ? "range-btn active" : ""}" data-cat-pill="${esc(cat)}">${(CATEGORY_ICONS[cat] || CATEGORY_ICONS["Other"]).emoji} ${esc(cat)}: ${fmtMoney(categoryTotals[cat])}${quantityLabel(cat)}</button>`).join("")}
    </div>
    ${sortedCats.length > 0 ? `
    <div class="dim" style="text-align:center;font-size:11px;margin-bottom:4px">${esc(periodLabel)}</div>
    <div class="card" style="margin-bottom:14px;display:flex;text-align:center;padding:10px 4px">
      <div style="flex:1">
        <div class="dim" style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.03em">Spent</div>
        <div style="font-weight:700;font-size:16px;font-family:'JetBrains Mono',monospace">${fmtMoney(totalSpent)}</div>
      </div>
      <div style="flex:1;border-left:1px solid var(--border)">
        <div class="dim" style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.03em">Income</div>
        <div style="font-weight:700;font-size:16px;font-family:'JetBrains Mono',monospace;${totalEarned > 0 ? "color:var(--sage)" : ""}">${fmtMoney(totalEarned)}</div>
      </div>
      <div style="flex:1;border-left:1px solid var(--border)">
        <div class="dim" style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.03em">Net</div>
        <div style="font-weight:700;font-size:16px;font-family:'JetBrains Mono',monospace;${netForPeriod >= 0 ? "color:var(--sage)" : "color:var(--danger)"}">${netForPeriod >= 0 ? "+" : ""}${fmtMoney(netForPeriod)}</div>
      </div>
    </div>
    ` : ""}

    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${rows.length} entr${rows.length !== 1 ? "ies" : "y"}${expenseFilters.category ? ` in ${esc(expenseFilters.category)}` : ""}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost small ${showValueRefs ? "range-btn active" : ""}" id="toggleValueRefs" title="Also show eggs collected and birds processed, as read-only references">🔗 Value produced</button>
        ${selectModeButtonHtml("expenses", "toggleExpenseSelectMode")}
        <button class="btn" id="toggleExpenseForm">+ Add entry</button>
      </div>
    </div>

    ${bulkDeleteBarHtml(selectedExpenseIds)}

    ${rows.length === 0 ? `<div class="card"><div class="empty">No entries logged${expenseFilters.category ? ` for ${esc(expenseFilters.category)}` : ""} in ${esc(periodLabel)}.</div></div>` : (() => {
      const visibleRows = [...rows].reverse().slice(0, expensesVisibleCount);
      return `
    <div class="list-stack list-stack-timeline">
      ${visibleRows.map((row) => {
        if (row.isRef) {
          // Read-only pointer back to an egg or bird record -- no checkbox
          // (nothing here to bulk-select or delete), no running-balance badge
          // (it isn't a real transaction, so it doesn't move the balance;
          // showing one anyway would look like it did), and a dashed outline
          // plus link icon in place of a category tile as the "this wasn't
          // added directly here" marker.
          const r = row.ref;
          const spec = r.kind === "egg" ? BIRD_TYPE_ICONS.layer : r.kind === "sold" ? { emoji: "💵", from: "#D4A017", to: "#A67C0A" } : BIRD_TYPE_ICONS.meat;
          return `
        <div class="list-card expense-row value-ref-row" data-open-ref="${r.kind}:${esc(r.sourceId)}" style="cursor:pointer">
          <div class="value-ref-badge" title="Read-only -- edit this at the source">🔗</div>
          <div class="cat-icon" style="background:linear-gradient(145deg, ${spec.from}, ${spec.to})"><span>${spec.emoji}</span></div>
          <div class="list-card-main">
            <div class="expense-row-title"><span class="expense-cat-name">${esc(r.label)}</span></div>
            <div class="list-card-desc dim">${fmtDate(r.date)} · not logged here -- tap to open</div>
          </div>
          <div class="list-card-side list-card-side-amount">
            ${moneyFigureHtml(r.amount, "income")}
          </div>
        </div>`;
        }
        const x = row.x, running = row.running;
        const isIncome = x.entry_type === "income";
        return `
        <div class="list-card expense-row${selectedExpenseIds.has(x.id) ? " card-selected" : ""}" data-edit="${x.id}" data-id="${x.id}" style="cursor:pointer">
          ${selectionState.expenses.mode ? `<input type="checkbox" class="list-card-check expense-check" data-id="${x.id}" ${selectedExpenseIds.has(x.id) ? "checked" : ""} onclick="event.stopPropagation()">` : ""}
          <div class="timeline-total" style="${running >= 0 ? "color:var(--sage);border-color:var(--sage)" : "color:var(--danger);border-color:var(--danger)"}">${running >= 0 ? "+" : ""}${fmtMoney(running)}</div>
          ${categoryIconTile(x.category, isIncome)}
          <div class="list-card-main">
            <div class="expense-row-title">
              <span class="expense-cat-name">${esc(x.category)}</span>
              ${!isIncome && x.for_type && x.for_type !== "All Birds" ? audienceTile(x.for_type) : ""}
            </div>
            <div class="list-card-desc dim">${fmtDate(x.date)}${x.quantity ? ` · ${quantityWithCountLabel(x.quantity, x.unit, x.item_count)}` : ""}${x.description ? " · " + esc(x.description) : ""}</div>
            ${isIncome && QUANTITY_RELEVANT_INCOME.has(x.category) ? (() => { const rate = saleRateLabel(x.amount, x.quantity, x.category); return rate ? `<div class="list-card-desc dim">${rate}</div>` : ""; })() : ""}
          </div>
          <div class="list-card-side list-card-side-amount">
            ${moneyFigureHtml(x.amount, isIncome ? "income" : "expense")}
          </div>
        </div>`;
      }).join("")}
    </div>
    ${loadMoreButtonHtml(rows.length, expensesVisibleCount)}`;
    })()}
  `;

  el.querySelectorAll("[data-scope]").forEach(b => b.addEventListener("click", () => {
    expenseScope = b.dataset.scope;
    expenseFilters.category = ""; // a category pill from one scope wouldn't necessarily make sense in another
    expensesVisibleCount = PAGE_SIZE;
    renderExpenses();
  }));
  const rangeToggleBtn = document.getElementById("toggleRangeMode");
  if (rangeToggleBtn) rangeToggleBtn.addEventListener("click", () => {
    expenseRangeMode = !expenseRangeMode;
    if (expenseRangeMode) { expenseYearKeyTo = expenseYearKey; expenseMonthKeyTo = expenseMonthKey; }
    expensesVisibleCount = PAGE_SIZE;
    renderExpenses();
  });
  el.querySelectorAll("[data-cat-pill]").forEach(b => b.addEventListener("click", () => {
    const cat = b.dataset.catPill;
    expenseFilters.category = expenseFilters.category === cat ? "" : cat; // tap again to clear
    expensesVisibleCount = PAGE_SIZE;
    renderExpenses();
  }));
  document.getElementById("toggleExpenseForm").addEventListener("click", () => openExpenseModal(null));
  const valueRefsToggle = document.getElementById("toggleValueRefs");
  if (valueRefsToggle) valueRefsToggle.addEventListener("click", () => {
    showValueRefs = !showValueRefs;
    localStorage.setItem(SHOW_VALUE_REFS_KEY, showValueRefs ? "1" : "0");
    renderExpenses();
  });
  // A reference row opens the real record it points to -- the SAME edit form
  // used everywhere else in the app for that egg log or bird -- rather than
  // anything on the finance page, since editing only ever happens at the
  // source. Deliberately not run through wireCardSelection: that wiring looks
  // up [data-edit] ids in STATE.expenses, which a reference row's id (an egg
  // or bird id) would not be found in.
  el.querySelectorAll("[data-open-ref]").forEach(row => row.addEventListener("click", () => {
    const [kind, id] = row.dataset.openRef.split(":");
    if (kind === "egg") {
      const egg = STATE.eggs.find(e => e.id === id);
      if (egg) openEggModal(egg);
    } else if (kind === "meat" || kind === "sold") {
      const bird = STATE.birds.find(b => b.id === id);
      if (bird) showBirdForm(bird);
    }
  }));
  const shiftPeriod = (delta) => {
    if (expenseScope === "year") {
      if (expenseRangeMode) {
        const fromY = Math.min(Number(expenseYearKey), Number(expenseYearKeyTo));
        const toY = Math.max(Number(expenseYearKey), Number(expenseYearKeyTo));
        expenseYearKey = String(fromY + delta);
        expenseYearKeyTo = String(toY + delta);
      } else {
        expenseYearKey = String(Number(expenseYearKey) + delta);
      }
    } else {
      if (expenseRangeMode) {
        const fromKey = expenseMonthKey <= expenseMonthKeyTo ? expenseMonthKey : expenseMonthKeyTo;
        const toKey = expenseMonthKey <= expenseMonthKeyTo ? expenseMonthKeyTo : expenseMonthKey;
        expenseMonthKey = shiftMonthKey(fromKey, delta);
        expenseMonthKeyTo = shiftMonthKey(toKey, delta);
      } else {
        expenseMonthKey = shiftMonthKey(expenseMonthKey, delta);
      }
    }
    expensesVisibleCount = PAGE_SIZE;
    renderExpenses();
  };
  const prevBtn = document.getElementById("prevPeriod");
  if (prevBtn) prevBtn.addEventListener("click", () => shiftPeriod(-1));
  const nextBtn = document.getElementById("nextPeriod");
  if (nextBtn) nextBtn.addEventListener("click", () => shiftPeriod(1));

  // Year scope, single point
  const jumpEl = document.getElementById("jumpPeriod");
  if (jumpEl) jumpEl.addEventListener("change", (e) => { expenseYearKey = e.target.value; expensesVisibleCount = PAGE_SIZE; renderExpenses(); });

  // Month scope, single point -- split Year+Month dropdowns recombine into one key
  const jumpYearEl = document.getElementById("jumpYear");
  const jumpMonthEl = document.getElementById("jumpMonth");
  if (jumpYearEl && jumpMonthEl) {
    const recombine = () => { expenseMonthKey = `${jumpYearEl.value}-${jumpMonthEl.value}`; expensesVisibleCount = PAGE_SIZE; renderExpenses(); };
    jumpYearEl.addEventListener("change", recombine);
    jumpMonthEl.addEventListener("change", recombine);
  }

  // Range mode -- these element IDs are shared between year-scope and
  // month-scope range markup, but only one of the two ever renders at once.
  const rangeFromYearEl = document.getElementById("rangeFromYear");
  const rangeToYearEl = document.getElementById("rangeToYear");
  const rangeFromMonthEl = document.getElementById("rangeFromMonth");
  const rangeToMonthEl = document.getElementById("rangeToMonth");
  if (rangeFromYearEl && rangeFromMonthEl) {
    const recombineFrom = () => { expenseMonthKey = `${rangeFromYearEl.value}-${rangeFromMonthEl.value}`; expensesVisibleCount = PAGE_SIZE; renderExpenses(); };
    const recombineTo = () => { expenseMonthKeyTo = `${rangeToYearEl.value}-${rangeToMonthEl.value}`; expensesVisibleCount = PAGE_SIZE; renderExpenses(); };
    rangeFromYearEl.addEventListener("change", recombineFrom);
    rangeFromMonthEl.addEventListener("change", recombineFrom);
    rangeToYearEl.addEventListener("change", recombineTo);
    rangeToMonthEl.addEventListener("change", recombineTo);
  } else if (rangeFromYearEl) {
    rangeFromYearEl.addEventListener("change", (e) => { expenseYearKey = e.target.value; expensesVisibleCount = PAGE_SIZE; renderExpenses(); });
    rangeToYearEl.addEventListener("change", (e) => { expenseYearKeyTo = e.target.value; expensesVisibleCount = PAGE_SIZE; renderExpenses(); });
  }
  const loadMoreEl = document.getElementById("loadMoreBtn");
  if (loadMoreEl) loadMoreEl.addEventListener("click", () => { expensesVisibleCount += PAGE_SIZE; renderExpenses(); });
  el.querySelectorAll(".expense-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedExpenseIds.add(cb.dataset.id); else selectedExpenseIds.delete(cb.dataset.id);
    renderExpenses();
  }));
  wireCardSelection(
    el.querySelectorAll("[data-edit]"),
    selectedExpenseIds,
    "expenses",
    () => [...el.querySelectorAll("[data-edit]")].map(c => c.dataset.id),
    (id) => openExpenseModal(STATE.expenses.find(x => x.id === id)),
    renderExpenses
  );
  document.getElementById("toggleExpenseSelectMode").addEventListener("click", () => {
    selectionState.expenses.mode = !selectionState.expenses.mode;
    if (!selectionState.expenses.mode) selectedExpenseIds.clear();
    renderExpenses();
  });
  wireBulkDeleteBar(selectedExpenseIds, "expenses", "entry", async () => { STATE.expenses = await localGetAll("expenses", currentCoopId); }, renderExpenses, "entries");
}

const QUANTITY_RELEVANT_INCOME = new Set(["Egg Sale", "Meat Sale"]); // the only income categories where "how many/how much" feeds back into the Coop tab's value-produced estimate

/** "= $0.70/egg" style label for an Egg Sale or Meat Sale income entry --
 * shared by the live form display (as you type amount/quantity) and the
 * saved card (from the stored values), so the math lives in one place. */
function saleRateLabel(amount, qty, category) {
  const a = Number(amount) || 0;
  const q = Number(qty) || 0;
  if (a <= 0 || q <= 0) return "";
  const unit = category === "Meat Sale" ? "/lb" : "/egg";
  return `= ${fmtMoney(a / q)}${unit}`;
}

function expenseFormHtml(editing) {
  const catValue = editing ? editing.category : (pendingExpenseCategory || (expenseFormEntryType === "income" ? INCOME_CATEGORIES[0] : EXPENSE_CATEGORIES[0]));
  const showQuantityFields = expenseFormEntryType === "income" ? QUANTITY_RELEVANT_INCOME.has(catValue) : QUANTITY_CATEGORIES.has(catValue);
  return `
    <div class="form-head">${editing ? "Edit entry" : "Log an entry"}</div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button type="button" class="btn ${expenseFormEntryType === "expense" ? "btn-close" : "ghost"} small" id="entryTypeExpense">💸 Expense</button>
      <button type="button" class="btn ${expenseFormEntryType === "income" ? "btn-confirm" : "ghost"} small" id="entryTypeIncome">💰 Income</button>
    </div>

    <div style="${FORM_SECTION_HEAD}">Details</div>
    <div class="grid-form">
      <label class="field"><span>Date</span><input type="date" id="x_date" value="${editing ? editing.date : todayStr()}"></label>
      <label class="field"><span>Category</span><select id="x_cat">${(expenseFormEntryType === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(c => `<option ${(editing ? editing.category === c : pendingExpenseCategory === c) ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field"><span>Description</span><input id="x_desc" placeholder="${expenseFormEntryType === "income" ? "e.g. Sold to neighbor" : "e.g. 50lb layer feed, or Heat lamp"}" value="${editing ? esc(editing.description || "") : ""}"></label>
      ${expenseFormEntryType === "expense" ? `<label class="field"><span>Applies to</span><select id="x_for">${EXPENSE_FOR_TYPES.map(t => `<option ${editing ? (editing.for_type === t ? "selected" : "") : (t === "All Birds" ? "selected" : "")}>${t}</option>`).join("")}</select></label>` : ""}
    </div>

    <div style="${FORM_SECTION_HEAD}">Amount & Quantity</div>
    <div class="grid-form">
      <label class="field"><span>Amount ($, total)</span><input type="number" step="0.01" id="x_amount" value="${editing ? editing.amount : ""}"></label>
      ${showQuantityFields ? `<label class="field"><span>Quantity${expenseFormEntryType === "income" ? "" : " (per bag/item)"}</span><input type="number" step="0.01" id="x_qty" placeholder="e.g. 50" value="${editing && editing.quantity != null ? displayQty(editing.quantity, editing.unit) : ""}"></label>` : ""}
      ${showQuantityFields ? `<label class="field"><span>Unit</span><select id="x_unit"><option value="">—</option>${unitOptionsHtml(editing && editing.unit)}</select></label>` : ""}
      ${showQuantityFields && !editing && expenseFormEntryType === "expense" ? `<label class="field"><span>Number of bags/items</span><input type="number" min="1" max="200" step="1" id="x_count" value="1"></label>` : ""}
    </div>
    ${showQuantityFields && expenseFormEntryType === "income" ? `<div class="dim" id="x_rate_display" style="font-size:12px;margin-top:4px">${saleRateLabel(editing ? editing.amount : null, editing ? editing.quantity : null, catValue)}</div>` : ""}
    <div class="note-box" style="margin-top:10px">${expenseFormEntryType === "income"
      ? `For Egg Sale or Meat Sale specifically, fill in the quantity (eggs or lbs) -- this lets the app subtract that amount from the estimated "value produced" on the Coop tab, so a sale doesn't get counted twice: once as an estimate when collected, and again as real income here.`
      : showQuantityFields
      ? `Layer Feed and Meat Feed are separate categories now, so the cost-per-dozen and cost-per-lb estimates on the Coop tab stay accurate without needing a flock tag. "Applies to" still matters for shared costs like Bedding or Equipment.${!editing ? " Buying more than one bag at once? Set the count, and the total amount here covers all of them -- each still becomes its own separate, independently trackable item in the Supply tab's inventory." : ""}`
      : `This category doesn't track quantity/unit or inventory -- the amount here is simply the total cost. Use the description for specifics, like "Heat lamp" or "Coop hinges."`}</div>
    ${showQuantityFields && !editing && expenseFormEntryType === "expense" ? `<div id="productPickerHost">${renderProductPickerRow(catValue)}</div>` : ""}
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveExpense">${editing ? "✓ Save changes" : "+ Add entry"}</button>
    </div>
  `;
}

/** Wires the expense form. The entry-type toggle and category change both
 * affect which fields show (Applies-to only for expenses, the product
 * picker only for quantity-tracked expense categories, etc) -- rather than
 * closing and reopening the modal for that, refreshModalContent() rebuilds
 * just the form in place and this re-wires the fresh copy, the same way
 * wireProductPicker already refreshes just its own row without touching
 * the form around it. */
function wireExpenseFormModal(editing) {
  applyFeedUnitLock("x_cat", "x_unit", expenseFormEntryType === "income" ? INCOME_UNIT_LOCKS : UNIT_LOCKS);
  const refreshForm = () => { refreshModalContent(expenseFormHtml(editing)); wireExpenseFormModal(editing); };
  document.getElementById("entryTypeExpense").addEventListener("click", () => { expenseFormEntryType = "expense"; pendingExpenseCategory = null; refreshForm(); });
  document.getElementById("entryTypeIncome").addEventListener("click", () => { expenseFormEntryType = "income"; pendingExpenseCategory = null; refreshForm(); });
  document.getElementById("x_cat").addEventListener("change", (e) => { pendingExpenseCategory = e.target.value; refreshForm(); });
  const rateDisplay = document.getElementById("x_rate_display");
  if (rateDisplay) {
    const updateRate = () => {
      rateDisplay.textContent = saleRateLabel(document.getElementById("x_amount").value, document.getElementById("x_qty").value, document.getElementById("x_cat").value);
    };
    document.getElementById("x_amount").addEventListener("input", updateRate);
    document.getElementById("x_qty").addEventListener("input", updateRate);
  }
  const productPickerHost = document.getElementById("productPickerHost");
  if (productPickerHost) wireProductPicker(productPickerHost, { categoryFieldId: "x_cat", brandFieldId: "x_desc", qtyFieldId: "x_qty", unitFieldId: "x_unit", rerenderFn: refreshForm });

  document.getElementById("saveExpense").addEventListener("click", async () => {
    const amount = document.getElementById("x_amount").value;
    if (!amount) return;
    const category = document.getElementById("x_cat").value;
    const unitEl = document.getElementById("x_unit");
    const unit = unitEl ? (unitEl.value || null) : null;
    // Quantity is typed in the toggle unit; store canonically (lb for weights)
    // since this value becomes the supply bag's quantity.
    const qtyEl = document.getElementById("x_qty");
    const perItemQty = qtyEl ? (parseQtyInput(qtyEl.value, unit) ?? "") : "";
    const description = document.getElementById("x_desc").value;
    const date = document.getElementById("x_date").value;
    const countEl = document.getElementById("x_count");
    const count = countEl ? Math.max(1, Number(countEl.value) || 1) : 1;
    if (count > 200) { alert("That's a lot of separate bags for one entry — try 200 or fewer at a time"); return; }
    // The expense's own quantity is the TOTAL across all bags (for accurate
    // category aggregation elsewhere); the inventory gets `count` separate
    // per-bag items instead, so each is trackable on its own.
    const totalQty = perItemQty ? Number(perItemQty) * count : null;
    const forTypeEl = document.getElementById("x_for");
    const washoutUnitPrice = (expenseFormEntryType === "income" && (category === "Egg Sale" || category === "Meat Sale"))
      ? computeWashoutSnapshotPrice(category, date)
      : null;
    // item_count is kept alongside the total quantity purely for display (so
    // a finance card can show "50 lb x 2" instead of a flattened "100 lb"); it
    // is never used in any calculation, which all correctly use the total.
    const payload = { coop_id: currentCoopId, date, category, for_type: forTypeEl ? forTypeEl.value : null, description, amount: Number(amount), quantity: totalQty, unit, entry_type: expenseFormEntryType, washout_unit_price: washoutUnitPrice, item_count: count > 1 ? count : null };
    if (editing) {
      await localExpenseUpdate(editing.id, payload);
      showToast(expenseFormEntryType === "income" ? "Income updated" : "Expense updated", "update");
    } else {
      const created = await localExpenseCreate(payload, { suppressUndo: true });
      showToast(expenseFormEntryType === "income" ? "Income added" : "Expense added", "create");
      const undoOps = [{ resource: "expenses", id: created.id, before: null, after: created }];
      // A new purchase with a quantity, in a trackable category, becomes
      // fresh "Full" item(s) in the Supply tab's inventory automatically --
      // Supplies are local-first too now, so this works offline the same as
      // the expense itself. Counted as part of the SAME action as the
      // expense -- undoing "logged this purchase" should remove the
      // inventory it created too, not leave orphaned bags behind.
      if (perItemQty && QUANTITY_CATEGORIES.has(category)) {
        const selectedProduct = selectedProductId ? STATE.supplyProducts.find(p => p.id === selectedProductId) : null;
        if (selectedProductId) {
          const productBefore = selectedProduct;
          const productAfter = await localSupplyProductUpdate(selectedProductId, { last_used_at: todayStr() }, { suppressUndo: true });
          undoOps.push({ resource: "supply_products", id: selectedProductId, before: productBefore, after: productAfter });
        }
        // Split the expense's total across the bags it created, so each bag
        // carries its own cost. That per-bag cost divided by its quantity is
        // the cost per lb, which is what makes a true "feed cost per dozen"
        // (feed actually eaten x its real cost) possible. The user can still
        // override any bag's cost later in the supply edit form.
        const perBagCost = count > 0 ? (Number(created.amount) || 0) / count : null;
        const createdSupplies = await localBulkCreate("supplies", Array.from({ length: count }, () => ({
          coop_id: currentCoopId, category, description: (selectedProduct && selectedProduct.default_description) || description || category, brand: selectedProduct ? selectedProduct.brand : null,
          quantity: Number(perItemQty), unit, status: "Full", date_added: date, source_expense_id: created.id,
          product_id: selectedProductId || null, cost: perBagCost,
        })), { suppressUndo: true });
        undoOps.push(...createdSupplies.map(s => ({ resource: "supplies", id: s.id, before: null, after: s })));
        showToast(count > 1 ? `${count} items added to inventory` : `Added to inventory: ${description || category}`, "create");
      }
      pushUndoAction(`Added ${expenseFormEntryType === "income" ? "income" : "expense"}: ${category}${undoOps.length > 1 ? ` (+ ${undoOps.length - 1} inventory item${undoOps.length - 1 !== 1 ? "s" : ""})` : ""}`, undoOps);
    }
    closeModal();
    refreshAndRender();
  });
}

function openExpenseModal(editing) {
  editingExpenseId = editing ? editing.id : null;
  expenseFormEntryType = editing ? (editing.entry_type === "income" ? "income" : "expense") : "expense";
  pendingExpenseCategory = null;
  selectedProductId = null;
  editingProductId = null;
  newProductFormOpen = false;
  openModal(
    expenseFormHtml(editing),
    () => { editingExpenseId = null; pendingExpenseCategory = null; selectedProductId = null; editingProductId = null; newProductFormOpen = false; },
    editing ? () => confirmAndDelete(
      editing.entry_type === "income" ? "Delete this income entry? This can't be undone." : "Delete this expense entry? This can't be undone.",
      () => localExpenseDelete(editing.id, currentCoopId),
      editing.entry_type === "income" ? "Income deleted" : "Expense deleted",
      refreshAndRender
    ) : null
  );
  wireExpenseFormModal(editing);
}

