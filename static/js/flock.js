// Flock: birds, batches, photos, health logs, processing.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= FLOCK =================
function flockYearsFor(field) {
  if (!field) return [];
  const years = new Set(STATE.birds.filter(b => b[field]).map(b => b[field].slice(0, 4)));
  return [...years].sort().reverse();
}

function applyFlockFilters(birds) {
  return birds.filter(b => {
    if (flockFilters.status && b.status !== flockFilters.status) return false;
    if (flockFilters.type && b.type !== flockFilters.type) return false;
    if (flockFilters.location && (b.location || "") !== flockFilters.location) return false;
    if (flockFilters.dateField && flockFilters.year) {
      const val = b[flockFilters.dateField];
      if (!val || val.slice(0, 4) !== flockFilters.year) return false;
    }
    return true;
  });
}

function flockSortValue(rep, mode) {
  // Ascending modes push "no known date" to the end with a fallback that
  // sorts after everything real; "newest" is descending, so it needs the
  // opposite fallback -- otherwise reversing the comparator would also
  // reverse where the undated ones land, putting them first instead of last.
  if (mode === "age") return rep.hatch_date || rep.acquired_date || "9999-99-99";
  if (mode === "newest") return rep.hatch_date || rep.acquired_date || "0000-00-00";
  if (mode === "target") return rep.target_harvest_date || "9999-99-99";
  return (rep.name || "").toLowerCase();
}
function flockSortComparator(mode) {
  // "newest" reuses the same hatch/acquired date as "age" -- just descending
  // instead of ascending, so the most recently started batch or bird lands at
  // the top without needing its own date logic to drift out of sync.
  const dir = mode === "newest" ? -1 : 1;
  return (a, b) => {
    const va = flockSortValue(a, mode), vb = flockSortValue(b, mode);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  };
}

function groupBirds(birds) {
  const ungrouped = [];
  const groups = {};
  birds.forEach(b => {
    if (b.batch_name) {
      (groups[b.batch_name] = groups[b.batch_name] || []).push(b);
    } else {
      ungrouped.push(b);
    }
  });
  return { ungrouped, groups };
}

function summarizeGroup(birds) {
  const counts = {};
  birds.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1; });
  const statusSummary = BIRD_STATUSES.filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(" · ");
  const processed = birds.filter(b => b.status === "Processed");
  const totalWeight = processed.reduce((s, b) => s + (Number(b.harvest_weight) || 0), 0);
  const totalValue = processed.reduce((s, b) => s + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);
  const weighedCount = processed.filter(b => Number(b.harvest_weight) > 0).length;
  const avgWeight = weighedCount > 0 ? totalWeight / weighedCount : 0;
  const first = birds[0];
  // A batch's birds don't all have to share a breed -- a "2026 Layers" batch
  // might be a mix of Rhode Island Reds, Leghorns, and whatever else. Rather
  // than silently showing just whichever bird happened to be first (which
  // used to make a mixed batch look single-breed), list distinct breeds when
  // there are few enough to read at a glance, or say plainly that it's mixed.
  const distinctBreeds = [...new Set(birds.map(b => b.breed).filter(Boolean))];
  const breedLabel = distinctBreeds.length === 0 ? null
    : distinctBreeds.length === 1 ? distinctBreeds[0]
    : distinctBreeds.length <= 3 ? distinctBreeds.join(", ")
    : `${distinctBreeds.length} breeds mixed`;
  return { count: birds.length, statusSummary, totalWeight, totalValue, avgWeight, processedCount: processed.length, breed: breedLabel, type: first.type, hatch_date: first.hatch_date, acquired_date: first.acquired_date, target_harvest_date: first.target_harvest_date };
}

function statusTone(status) {
  return status === "Active" ? "sage" : status === "Processed" ? "rust" : status === "Deceased" ? "danger" : "slate";
}

/** Shared by bird cards and group cards -- computes the border-color/style
 * and pattern-background CSS for a given accent color, or "" if there's no
 * accent at all (falling back to the plain default card border). */
function cardAccentStyle(accent, borderStyle, pattern) {
  if (!accent) return "";
  const patternBg = pattern === "gradient"
    ? `background:linear-gradient(135deg, color-mix(in srgb, ${esc(accent)} 30%, var(--surface)), var(--surface))`
    : pattern === "dots"
    ? `background-color:color-mix(in srgb, ${esc(accent)} 8%, var(--surface));background-image:radial-gradient(color-mix(in srgb, ${esc(accent)} 55%, transparent) 1.5px, transparent 1.5px);background-size:10px 10px`
    : pattern === "stripes"
    ? `background-color:color-mix(in srgb, ${esc(accent)} 8%, var(--surface));background-image:repeating-linear-gradient(45deg, color-mix(in srgb, ${esc(accent)} 25%, transparent), color-mix(in srgb, ${esc(accent)} 25%, transparent) 6px, transparent 6px, transparent 12px)`
    : `background:color-mix(in srgb, ${esc(accent)} 12%, var(--surface))`;
  return `border-color:${esc(accent)};border-style:${esc(borderStyle)};${patternBg}`;
}

function birdCardHtml(b) {
  const displayName = esc(b.name);
  const age = ageFromDate(b.hatch_date || b.acquired_date);
  const statusDetail = b.status === "Processed"
    ? (b.harvest_weight ? weightLabel(b.harvest_weight) : "")
    : b.status === "Deceased"
    ? `${fmtDate(b.death_date)}`
    : "";
  const showCountdown = b.status === "Active" && b.target_harvest_date;
  const weight = Number(b.harvest_weight) || 0;
  const pricePerLb = Number(b.price_per_lb) || 0;
  const meatValue = b.status === "Processed" ? weight * pricePerLb : 0;
  const showRate = b.status === "Processed" && weight > 0 && pricePerLb > 0;
  const accent = b.card_color || null;
  const borderStyle = b.border_style || "solid";
  const pattern = b.card_pattern || "solid";
  const cardStyle = cardAccentStyle(accent, borderStyle, pattern);
  const nameHtml = accent
    ? `<div class="flock-card-name-ribbon" style="background:color-mix(in srgb, ${esc(accent)} 55%, var(--surface))"><div class="flock-card-name">${displayName}</div></div>`
    : `<div class="flock-card-name">${displayName}</div>`;
  return `<div class="flock-card${accent ? " custom-color" : ""}${selectedBirdIds.has(b.id) ? " card-selected" : ""}${(!b.status || b.status === "Active") ? " no-status-badge" : ""}" data-edit="${b.id}" data-id="${b.id}" style="${cardStyle}">
    <div class="flock-card-photo">
      ${selectionState.birds.mode ? `<input type="checkbox" class="flock-card-check bird-check" data-id="${b.id}" ${selectedBirdIds.has(b.id) ? "checked" : ""} onclick="event.stopPropagation()">` : ""}
      ${birdPhotoUrl(b) ? `<img src="${birdPhotoUrl(b)}" style="object-position:${photoPosition(b)};${photoTransformStyle(b)}">` : "🐔"}
      ${b.status && b.status !== "Active" ? `<span class="stamp stamp-lg stamp-on-photo tone-${statusTone(b.status)} flock-card-status-badge">${esc(b.status)}</span>` : ""}
      ${b.status === "Processed" && b.harvest_date ? `<div class="flock-card-harvest-badge">Harvested ${fmtDate(b.harvest_date)}</div>` : ""}
      ${showCountdown ? `<div class="flock-card-countdown-badge">${harvestCountdownHtml(b.target_harvest_date, "stamp-on-photo")}</div>` : ""}
    </div>
    <div class="flock-card-info">
      ${nameHtml}
      ${(b.breed || b.type) ? `<div class="flock-card-breed">${esc(b.breed || b.type)}</div>` : ""}
      <div class="flock-card-sub">${age}${b.gender ? ` · ${b.gender === "Hen" ? "♀" : "♂"} ${b.gender}` : ""}${statusDetail ? " · " + statusDetail : ""}</div>
      ${b.status === "Active" && b.target_harvest_date ? `<div class="flock-card-sub">target ${fmtDate(b.target_harvest_date)}</div>` : ""}
      ${showRate ? `<span class="stamp tone-slate flock-card-weight" style="margin-top:4px">${weightLabel(weight)} @ ${fmtMoney(displayPricePerLb(pricePerLb))}/${getWeightUnit()}</span>` : ""}
      ${meatValue > 0 ? `<span class="stamp stamp-lg tone-sage" style="margin-top:4px">${fmtMoney(meatValue)}</span>` : ""}
    </div>
  </div>`;
}

/** currentOpenBatchName tracks which group (if any) is currently expanded
 * below the grid, purely so its card can show a glowing border -- "this is
 * the one you have open right now" -- distinct from any color customization
 * the group might also have. */
let currentOpenBatchName = null;
/** Whether the currently open batch panel shows every bird in the batch
 * regardless of the outer flock filters (e.g. Status: Active), rather than
 * just the ones matching them. Off by default -- a batch respects the same
 * filter as the rest of the flock grid, same as opening any other view
 * while filtered, with this as the one-tap escape hatch for "no, show me
 * everyone in this batch." Resets whenever a different batch is opened, so
 * it never silently carries over to a batch you didn't toggle it for. */
let batchPanelIgnoreFilters = false;
/** Sort for the bird cards listed inside an open batch panel -- separate
 * from the main flock grid's flockSort, since "by status" or "by dressed
 * weight" only make sense once you're looking at one batch's birds, not the
 * mixed individuals-and-batch-summaries list the main grid sorts. Resets to
 * the default whenever a different batch is opened, matching
 * batchPanelIgnoreFilters, so a sort choice never silently carries over to a
 * batch you didn't pick it for. */
let batchPanelSort = "name"; // "name" | "status" | "processed" | "weight"
const BATCH_SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
  { value: "processed", label: "Processed date" },
  { value: "weight", label: "Dressed weight" },
];
function batchSortSelectHtml(id) {
  return `<select id="${id}">${BATCH_SORT_OPTIONS.map(o => `<option value="${o.value}" ${batchPanelSort === o.value ? "selected" : ""}>Sort: ${o.label}</option>`).join("")}</select>`;
}
function batchSortComparator(mode) {
  if (mode === "status") {
    // Workflow order (Active -> Processed -> ... -> Deceased/Retired), not
    // alphabetical -- groups the birds you still need to act on together,
    // which is the point when a batch is only partially processed.
    return (a, b) => BIRD_STATUSES.indexOf(a.status) - BIRD_STATUSES.indexOf(b.status);
  }
  if (mode === "processed") {
    // Most recently processed first; birds with no harvest date (not yet
    // processed) sort last regardless of which side of the comparison
    // they're on.
    return (a, b) => (b.harvest_date || "0000-00-00").localeCompare(a.harvest_date || "0000-00-00");
  }
  if (mode === "weight") {
    // Heaviest first; unweighed birds (0, null, or never set) sort last.
    return (a, b) => (Number(b.harvest_weight) || -1) - (Number(a.harvest_weight) || -1);
  }
  return (a, b) => (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase());
}

function groupCardHtml(batchName, filteredBirds, totalCount) {
  const s = summarizeGroup(filteredBirds);
  const cover = filteredBirds.find(b => b.photo || pendingPhotoUrls[b.id]);
  const countLabel = totalCount && totalCount !== filteredBirds.length ? `${filteredBirds.length}/${totalCount}` : `${s.count}`;
  const hasActive = filteredBirds.some(b => b.status === "Active");
  const processed = filteredBirds.filter(b => b.status === "Processed" && Number(b.harvest_weight) > 0);
  const processedCount = processed.length;
  const totalWeight = processed.reduce((sum, b) => sum + (Number(b.harvest_weight) || 0), 0);
  const totalValue = processed.reduce((sum, b) => sum + (Number(b.harvest_weight) || 0) * (Number(b.price_per_lb) || 0), 0);
  const avgPricePerLb = totalWeight > 0 ? totalValue / totalWeight : 0;
  // Average dressed weight per bird -- what actually lets one batch be
  // compared against another (a batch of 20 at 4.2 lb average vs. a batch of
  // 8 at 5.6 lb tells you something a bare total can't, since totals scale
  // with however many birds happened to be processed).
  const avgWeight = processedCount > 0 ? totalWeight / processedCount : 0;
  // The group card's own look mirrors whatever styling the birds inside it
  // actually share -- if they were all colored via "Apply to whole batch,"
  // the collapsed card matches; if they're mixed (or never styled), it just
  // uses the same plain default border every other card gets, rather than
  // a fixed dashed one that didn't reflect anything about the group itself.
  const sharedOf = (field, fallback) => {
    const vals = new Set(filteredBirds.map(b => b[field] || null));
    return vals.size === 1 && [...vals][0] ? [...vals][0] : fallback;
  };
  const accent = sharedOf("card_color", null);
  const borderStyle = sharedOf("border_style", "solid");
  const pattern = sharedOf("card_pattern", "solid");
  const cardStyle = cardAccentStyle(accent, borderStyle, pattern);
  const isOpen = currentOpenBatchName === batchName;
  const nameHtml = accent
    ? `<div class="flock-card-name-ribbon" style="background:color-mix(in srgb, ${esc(accent)} 55%, var(--surface))"><div class="flock-card-name">${esc(batchName)}</div></div>`
    : `<div class="flock-card-name">${esc(batchName)}</div>`;
  return `<div class="flock-card flock-card-group${accent ? " custom-color" : ""}${isOpen ? " flock-card-group-open" : ""}" data-open-batch="${esc(batchName)}" style="${cardStyle}">
    <div class="flock-card-photo">
      ${cover ? `<img src="${birdPhotoUrl(cover)}" style="object-position:${photoPosition(cover)};${photoTransformStyle(cover)}">` : "🐣"}
      <span class="stamp stamp-lg stamp-on-photo tone-slate flock-card-status-badge">Batch</span>
      <div class="flock-group-badge"><span class="stamp stamp-lg stamp-on-photo tone-gold">${countLabel} bird${(totalCount || s.count) !== 1 ? "s" : ""}</span></div>
    </div>
    <div class="flock-card-info">
      ${nameHtml}
      <div class="flock-card-sub">${s.statusSummary}${totalCount && totalCount !== filteredBirds.length ? ` · ${totalCount} in batch` : ""}</div>
      ${hasActive && s.target_harvest_date ? `<div style="margin-top:2px">${harvestCountdownHtml(s.target_harvest_date)}</div>` : ""}
      ${processedCount > 0 ? `
        <span class="stamp tone-slate flock-card-weight" style="align-self:flex-start;margin-top:4px">${weightLabel(avgWeight)} avg · ${displayWeight(totalWeight)} ${getWeightUnit()} total</span>
        <span class="stamp tone-rust" style="align-self:flex-start;margin-top:4px">${processedCount} Processed</span>
        ${totalValue > 0 ? `<span class="stamp stamp-lg tone-sage" style="align-self:flex-start;margin-top:4px">${fmtMoney(totalValue)}</span>` : ""}
      ` : ""}
    </div>
  </div>`;
}

const FLOCK_SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "name", label: "Name" },
  { value: "age", label: "Oldest first" },
  { value: "target", label: "Target harvest" },
];

function flockSortSelectHtml(id) {
  return `<select id="${id}">${FLOCK_SORT_OPTIONS.map(o => `<option value="${o.value}" ${flockSort === o.value ? "selected" : ""}>Sort: ${o.label}</option>`).join("")}</select>`;
}

let flockSubTab = "birds";
function renderFlockHub() {
  const el = document.getElementById("panel-flock");
  const subs = [{ id: "birds", label: "Birds" }, { id: "notes", label: "Notes" }, { id: "health", label: "Health" }];
  el.innerHTML = `
    <div class="range-select sub-nav-fixed" id="flockSubNav">
      ${subs.map(s => `<button class="range-btn ${flockSubTab === s.id ? "active" : ""}" data-flocksub="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div id="flockSubContent"></div>
  `;
  el.querySelectorAll("[data-flocksub]").forEach(b => b.addEventListener("click", () => { flockSubTab = b.dataset.flocksub; renderFlockHub(); }));
  if (flockSubTab === "birds") renderFlockBirds();
  else if (flockSubTab === "notes") renderNotesSection();
  else if (flockSubTab === "health") renderFlockHealthSection();
}

function renderFlockBirds() {
  const el = document.getElementById("flockSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const allBirds = [...STATE.birds];
  const filtered = applyFlockFilters(allBirds).sort(flockSortComparator(flockSort));
  const years = flockYearsFor(flockFilters.dateField);
  // Type/date-range filters are for digging up specific individuals, so they
  // still flatten to a plain grid. Status alone (including the "Active"
  // default) stays grouped/sectioned -- that's what keeps a years-old flock
  // list from turning into an endless scroll: processed/deceased birds and
  // fully-wound-down batches just drop out of view by default. Broadening the
  // Status filter to "All statuses" (or a specific status) brings them back,
  // still grouped, so there's one mechanism for this rather than a separate
  // archive view duplicating it.
  const forcesFlatView = flockFilters.type || flockFilters.location || (flockFilters.dateField && flockFilters.year);
  const nonDefaultFilterCount = (flockFilters.status !== "Active" ? 1 : 0) + (flockFilters.type ? 1 : 0) + (flockFilters.location ? 1 : 0) + (flockFilters.dateField && flockFilters.year ? 1 : 0);

  const totalByBatch = {};
  STATE.birds.forEach(b => { if (b.batch_name) totalByBatch[b.batch_name] = (totalByBatch[b.batch_name] || 0) + 1; });

  let bodyHtml;
  if (filtered.length === 0) {
    bodyHtml = `<div class="card"><div class="empty">${STATE.birds.length === 0 ? "No birds yet — add your first one." : "No birds match these filters."}</div></div><div id="birdFormHost"></div>`;
  } else if (forcesFlatView) {
    bodyHtml = `<div class="${flockGridClass()}">${filtered.map(b => birdCardHtml(b)).join("")}</div><div id="birdFormHost"></div>`;
  } else {
    const { ungrouped, groups } = groupBirds(filtered);
    const isMeat = (b) => b.type === "Meat";
    const items = [];
    ungrouped.forEach(b => items.push({ isMeat: isMeat(b), rep: b, html: birdCardHtml(b) }));
    Object.keys(groups).forEach(name => {
      // `groups[name]` is status-filtered (e.g. Active-only by default) --
      // right for deciding whether this batch shows up at all (a batch with
      // zero birds matching the filter has no entry here and correctly drops
      // out of view). But the card's own numbers -- status breakdown, average
      // and total dressed weight, value -- need the batch's FULL history: a
      // batch with 8 active and 12 already-processed birds should still show
      // "51 lb total" while you're looking at the active flock, not silently
      // read zero because those 12 got filtered out upstream.
      const fullBatchBirds = STATE.birds.filter(b => b.batch_name === name);
      const rep = { ...summarizeGroup(fullBatchBirds), name };
      items.push({ isMeat: isMeat(fullBatchBirds[0]), rep, html: groupCardHtml(name, fullBatchBirds, totalByBatch[name]) });
    });
    items.sort((a, b) => flockSortComparator(flockSort)(a.rep, b.rep));
    const layerItems = items.filter(it => !it.isMeat);
    const meatItems = items.filter(it => it.isMeat);
    // The open batch's panel mounts as a full-width row directly under its
    // own card -- grid-column:1/-1 breaks the mount point out of the grid's
    // columns so it spans the row and pushes whatever comes after it down a
    // row, rather than opening in one shared spot at the very bottom of the
    // whole list, disconnected from the card that was actually tapped.
    let batchSlotPlaced = false;
    const withBatchSlot = (list) => list.map(it => {
      if (!batchSlotPlaced && currentOpenBatchName && it.rep && it.rep.name === currentOpenBatchName) {
        batchSlotPlaced = true;
        return it.html + `<div id="birdFormHost" style="grid-column:1/-1"></div>`;
      }
      return it.html;
    }).join("");
    bodyHtml = ""
      + (layerItems.length ? `<div class="flock-section-header">${BIRD_TYPE_ICONS.layer.emoji} Layers</div><div class="${flockGridClass()}">${withBatchSlot(layerItems)}</div>` : "")
      + (meatItems.length ? `<div class="flock-section-header">${BIRD_TYPE_ICONS.meat.emoji} Meat birds</div><div class="${flockGridClass()}">${withBatchSlot(meatItems)}</div>` : "");
    // No batch open, or the open one isn't among the currently filtered
    // items (e.g. filters changed out from under it) -- same fallback spot
    // as before, so showBatchPanel always has somewhere to mount.
    if (!batchSlotPlaced) bodyHtml += `<div id="birdFormHost"></div>`;
  }

  el.innerHTML = `
    <div class="toolbar">
      <div class="dim">${filtered.length} of ${STATE.birds.length} bird${STATE.birds.length !== 1 ? "s" : ""} shown${flockFilters.status === "Active" && nonDefaultFilterCount === 0 ? " (active only)" : ""}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${flockViewControlHtml()}
        ${flockSortSelectHtml("flockSortSelect")}
        <button class="btn ghost small" id="toggleFlockFilters">Filters${nonDefaultFilterCount ? ` (${nonDefaultFilterCount})` : ""} ${flockFiltersOpen ? "▾" : "▸"}</button>
        <button class="btn ${selectionState.birds.mode ? "btn-close" : "ghost"} small" id="toggleBirdSelectMode">${selectionState.birds.mode ? "✕ Cancel selection" : "☑ Select"}</button>
        <button class="btn" id="newBatchBtn">+ Add batch</button>
        <button class="btn" id="newBirdBtn">+ Add bird</button>
      </div>
    </div>

    ${flockFiltersOpen ? `
    <div class="form-block" style="padding:12px 16px">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        <label class="field"><span>Status</span><select id="filterStatus"><option value="">All statuses</option>${BIRD_STATUSES.map(s => `<option value="${s}" ${flockFilters.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label class="field"><span>Type</span><select id="filterType"><option value="">All types</option>${BIRD_TYPES.map(t => `<option value="${t}" ${flockFilters.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field"><span>Location</span><select id="filterLocation"><option value="">All locations</option>${getBeddingAreas().map(a => `<option value="${esc(a)}" ${flockFilters.location === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
        <label class="field"><span>Filter by</span><select id="filterDateField">${FLOCK_DATE_FIELDS.map(f => `<option value="${f.value}" ${flockFilters.dateField === f.value ? "selected" : ""}>${f.label}</option>`).join("")}</select></label>
        <label class="field"><span>Year</span><select id="filterYear" ${!flockFilters.dateField ? "disabled" : ""}><option value="">All years</option>${years.map(y => `<option value="${y}" ${flockFilters.year === y ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost small" id="clearFilters">Show everyone (clear filters)</button>
      </div>
      ${forcesFlatView ? `<div class="dim" style="font-size:11px;margin-top:8px">Type/date filters show everyone as individual cards instead of grouped batches, so nothing's hidden inside a collapsed group.</div>` : ""}
    </div>
    ` : ""}

    ${selectedBirdIds.size > 0 ? `
      <div class="form-block" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-color:var(--rust)">
        <div><strong style="color:var(--text)">${selectedBirdIds.size}</strong> selected</div>
        <div style="display:flex;gap:8px">
          <button class="btn ghost small" id="bulkEditBtn">Bulk edit</button>
          <button class="btn btn-close small" id="bulkDeleteBtn">Delete selected</button>
          <button class="btn ghost small" id="clearSelection">Clear selection</button>
        </div>
      </div>
    ` : ""}

    ${bodyHtml}
    ${selectionState.birds.mode ? `
    <div class="floating-selection-spacer"></div>
    <div class="floating-selection-bar">
      <div class="floating-selection-inner">
        <span>${selectedBirdIds.size > 0 ? `<strong style="color:var(--text)">${selectedBirdIds.size}</strong> selected` : "Tap birds to select"}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${selectedBirdIds.size > 0 ? `<button class="btn ghost small" id="floatingBulkEdit">Bulk edit</button><button class="btn btn-close small" id="floatingBulkDelete">Delete</button>` : ""}
          <button class="btn btn-close small" id="floatingCancelSelect">✕ Cancel</button>
        </div>
      </div>
    </div>
    ` : ""}
  `;

  document.getElementById("flockViewGrid").addEventListener("click", () => { setFlockView("grid"); renderFlockBirds(); });
  document.getElementById("flockViewList").addEventListener("click", () => { setFlockView("list"); renderFlockBirds(); });
  el.querySelectorAll("[data-flock-density]").forEach(b => b.addEventListener("click", () => { setFlockDensity(b.dataset.flockDensity); renderFlockBirds(); }));
  document.getElementById("flockSortSelect").addEventListener("change", (e) => { flockSort = e.target.value; renderFlockBirds(); });
  document.getElementById("toggleFlockFilters").addEventListener("click", () => { flockFiltersOpen = !flockFiltersOpen; renderFlockBirds(); });
  document.getElementById("newBirdBtn").addEventListener("click", () => showBirdForm(null));
  document.getElementById("toggleBirdSelectMode").addEventListener("click", () => {
    selectionState.birds.mode = !selectionState.birds.mode;
    if (!selectionState.birds.mode) selectedBirdIds.clear();
    renderFlockBirds();
  });
  document.getElementById("newBatchBtn").addEventListener("click", () => showBulkForm());
  wireFlockCardHandlers(el);

  const filterStatusEl = document.getElementById("filterStatus");
  if (filterStatusEl) filterStatusEl.addEventListener("change", (e) => { flockFilters.status = e.target.value; renderFlockBirds(); });
  const filterTypeEl = document.getElementById("filterType");
  if (filterTypeEl) filterTypeEl.addEventListener("change", (e) => { flockFilters.type = e.target.value; renderFlockBirds(); });
  const filterLocationEl = document.getElementById("filterLocation");
  if (filterLocationEl) filterLocationEl.addEventListener("change", (e) => { flockFilters.location = e.target.value; renderFlockBirds(); });
  const filterDateFieldEl = document.getElementById("filterDateField");
  if (filterDateFieldEl) filterDateFieldEl.addEventListener("change", (e) => { flockFilters.dateField = e.target.value; flockFilters.year = ""; renderFlockBirds(); });
  const filterYearEl = document.getElementById("filterYear");
  if (filterYearEl) filterYearEl.addEventListener("change", (e) => { flockFilters.year = e.target.value; renderFlockBirds(); });
  const clearBtn = document.getElementById("clearFilters");
  if (clearBtn) clearBtn.addEventListener("click", () => { flockFilters = { status: "", type: "", location: "", dateField: "", year: "" }; renderFlockBirds(); });

  el.querySelectorAll(".bird-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedBirdIds.add(cb.dataset.id); else selectedBirdIds.delete(cb.dataset.id);
    renderFlockBirds();
  }));
  const clearSelBtn = document.getElementById("clearSelection");
  if (clearSelBtn) clearSelBtn.addEventListener("click", () => { selectedBirdIds.clear(); renderFlockBirds(); });
  const bulkEditBtn = document.getElementById("bulkEditBtn");
  if (bulkEditBtn) bulkEditBtn.addEventListener("click", () => showBulkEditForm());
  const runBulkDeleteBirds = async () => {
    const count = selectedBirdIds.size;
    if (!(await showConfirmDialog(`Delete ${count} selected bird${count !== 1 ? "s" : ""}? This can't be undone.`))) return;
    await localBulkDeleteBirds([...selectedBirdIds], currentCoopId);
    showToast(`${count} bird${count !== 1 ? "s" : ""} deleted`, "delete");
    selectedBirdIds.clear();
    refreshAndRender();
  };
  const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
  if (bulkDeleteBtn) bulkDeleteBtn.addEventListener("click", runBulkDeleteBirds);

  // Floating mobile bar: mirrors the toggle/bulk-edit/bulk-delete buttons
  // above so selection can be exited (or acted on) without scrolling back to
  // the top of a long flock list -- the actual friction being fixed here.
  const floatingCancel = document.getElementById("floatingCancelSelect");
  if (floatingCancel) floatingCancel.addEventListener("click", () => {
    selectionState.birds.mode = false;
    selectedBirdIds.clear();
    renderFlockBirds();
  });
  const floatingBulkEdit = document.getElementById("floatingBulkEdit");
  if (floatingBulkEdit) floatingBulkEdit.addEventListener("click", () => showBulkEditForm());
  const floatingBulkDelete = document.getElementById("floatingBulkDelete");
  if (floatingBulkDelete) floatingBulkDelete.addEventListener("click", runBulkDeleteBirds);

  if (currentOpenBatchName) showBatchPanel(currentOpenBatchName);
}

/** Individual birds that left Active status on their own (not part of a batch), plus batches where every member has left Active status. */


/** Shared click wiring for both the active grid and the archive grid. */
function wireFlockCardHandlers(el) {
  wireCardSelection(
    el.querySelectorAll("[data-edit]"),
    selectedBirdIds,
    "birds",
    () => [...el.querySelectorAll("[data-edit]")].map(c => c.dataset.id),
    (id) => showBirdForm(STATE.birds.find(x => x.id === id)),
    renderFlockBirds
  );
  el.querySelectorAll("[data-open-batch]").forEach(card => card.addEventListener("click", () => {
    // Toggle, not just open -- tapping the batch card that's already expanded
    // collapses it again, so the card behaves like the disclosure control it
    // looks like. (Previously it re-opened the same panel, and the only way
    // to close was the ✕ inside it.)
    const name = card.dataset.openBatch;
    if (currentOpenBatchName !== name) { batchPanelIgnoreFilters = false; batchPanelSort = "name"; }
    currentOpenBatchName = (currentOpenBatchName === name) ? null : name;
    renderFlockBirds();
  }));
}

function showBatchPanel(batchName) {
  const host = document.getElementById("birdFormHost");
  // Stats (status breakdown, avg/total weight, value) always reflect the
  // FULL batch regardless of filtering -- a batch with 8 active and 12
  // already-processed birds should still show its true totals while you're
  // looking at the active flock, not read zero because the processed ones
  // got filtered out. Which birds actually LIST as cards below, though,
  // follows the same filter as the rest of the flock grid by default (status,
  // type, location, date) -- opening a batch while filtered to Active
  // shouldn't suddenly show every status again, which was the inconsistency
  // this was built to fix. batchPanelIgnoreFilters is the one-tap escape
  // hatch for when you specifically want to see everyone in the batch.
  const fullBatchBirds = STATE.birds.filter(b => b.batch_name === batchName);
  const visibleBirds = (batchPanelIgnoreFilters ? fullBatchBirds : applyFlockFilters(fullBatchBirds))
    .slice().sort(batchSortComparator(batchPanelSort));
  const hiddenCount = fullBatchBirds.length - visibleBirds.length;
  const batchIds = visibleBirds.map(b => b.id);
  const selectedInBatch = batchIds.filter(id => selectedBirdIds.has(id));
  const allSelected = selectedInBatch.length === batchIds.length && batchIds.length > 0;
  const s = summarizeGroup(fullBatchBirds);

  host.innerHTML = `
    <div class="form-block">
      <div class="form-head"><span>${esc(batchName)} -- ${fullBatchBirds.length} birds</span><button class="icon-btn icon-btn-close" id="closeBatchPanel">✕</button></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        <div class="dim" style="font-size:12px">${esc(s.statusSummary)}${s.breed ? ` · ${esc(s.breed)}` : ""}${s.avgWeight > 0 ? ` · ${weightLabel(s.avgWeight)} avg dressed` : ""}${s.processedCount > 0 && s.totalValue > 0 ? ` · ${fmtMoney(s.totalValue)} value` : ""}</div>
        <button class="btn ghost small" id="openBatchEdit" style="margin-left:auto">✎ Edit group</button>
      </div>
      ${hiddenCount > 0 || batchPanelIgnoreFilters ? `
      <div class="dim" style="font-size:12px;margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${batchPanelIgnoreFilters
          ? `Showing all ${fullBatchBirds.length} birds in this batch, ignoring the flock filters.`
          : `Showing ${visibleBirds.length} of ${fullBatchBirds.length} birds, matching the flock filters.`}
        <button class="btn ghost small" id="toggleBatchFilters" style="padding:2px 8px">${batchPanelIgnoreFilters ? "Show filtered only" : `Show all ${fullBatchBirds.length}`}</button>
      </div>
      ` : ""}

      <div class="toolbar" style="margin-bottom:10px">
        <button class="btn ghost small" id="selectAllInBatch" ${batchIds.length === 0 ? "disabled" : ""}>${allSelected ? "☑" : "☐"} Select all ${batchPanelIgnoreFilters || hiddenCount === 0 ? "in batch" : "shown"}</button>
        <div style="display:flex;align-items:center;gap:8px">
          ${selectedInBatch.length > 0 ? `<div class="dim">${selectedInBatch.length} of ${batchIds.length} selected</div>` : ""}
          ${batchSortSelectHtml("batchSortSelect")}
        </div>
      </div>
      ${selectedInBatch.length > 0 ? `
      <div class="form-block" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-color:var(--rust)">
        <div><strong style="color:var(--text)">${selectedInBatch.length}</strong> selected</div>
        <div style="display:flex;gap:8px">
          <button class="btn ghost small" id="batchBulkEditBtn">Bulk edit</button>
          <button class="btn btn-close small" id="batchBulkDeleteBtn">Delete selected</button>
        </div>
      </div>
      ` : ""}

      ${visibleBirds.length === 0 ? `<div class="empty">No birds in this batch match the current flock filters.</div>` : `<div class="${flockGridClass()}">${visibleBirds.map(b => birdCardHtml(b)).join("")}</div>`}
    </div>
  `;
  const close = () => { currentOpenBatchName = null; renderFlockBirds(); };
  document.getElementById("closeBatchPanel").addEventListener("click", close);
  document.getElementById("openBatchEdit").addEventListener("click", () => openBatchEditModal(batchName));
  const toggleFiltersBtn = document.getElementById("toggleBatchFilters");
  if (toggleFiltersBtn) toggleFiltersBtn.addEventListener("click", () => {
    batchPanelIgnoreFilters = !batchPanelIgnoreFilters;
    renderFlockBirds(); // same reasoning as selectAllInBatch below -- keeps the outer page (floating bar, etc.) in sync too
  });
  document.getElementById("batchSortSelect").addEventListener("change", (e) => {
    batchPanelSort = e.target.value;
    renderFlockBirds(); // same reasoning as the other in-panel controls -- keeps the outer page in sync too
  });
  document.getElementById("selectAllInBatch").addEventListener("click", () => {
    if (allSelected) batchIds.forEach(id => selectedBirdIds.delete(id));
    else batchIds.forEach(id => selectedBirdIds.add(id));
    // A selection changed inside the batch panel, so the OUTER page needs to
    // redraw too -- that's where the floating selection bar lives. Calling
    // renderFlockBirds (rather than just showBatchPanel again) does both: it
    // rebuilds the page wrapper, and re-invokes showBatchPanel for us at its
    // own tail since currentOpenBatchName is still set. Previously this only
    // refreshed the panel's own content, so the floating bar wouldn't appear
    // (or its "N selected" count wouldn't update) until something else
    // triggered a full page render, like closing the panel.
    renderFlockBirds();
  });
  const batchBulkEditBtn = document.getElementById("batchBulkEditBtn");
  if (batchBulkEditBtn) batchBulkEditBtn.addEventListener("click", () => showBulkEditForm());
  const batchBulkDeleteBtn = document.getElementById("batchBulkDeleteBtn");
  if (batchBulkDeleteBtn) batchBulkDeleteBtn.addEventListener("click", async () => {
    const n = selectedInBatch.length;
    if (!(await showConfirmDialog(`Delete ${n} selected bird${n !== 1 ? "s" : ""}? This can't be undone.`))) return;
    await localBulkDeleteBirds(selectedInBatch, currentCoopId);
    showToast(`${n} bird${n !== 1 ? "s" : ""} deleted`, "delete");
    selectedInBatch.forEach(id => selectedBirdIds.delete(id));
    refreshAndRender();
  });
  host.querySelectorAll(".bird-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedBirdIds.add(cb.dataset.id); else selectedBirdIds.delete(cb.dataset.id);
    renderFlockBirds(); // same reasoning as selectAllInBatch above
  }));
  wireCardSelection(
    host.querySelectorAll("[data-edit]"),
    selectedBirdIds,
    "birds",
    () => visibleBirds.map(b => b.id),
    (id) => showBirdForm(STATE.birds.find(x => x.id === id)),
    renderFlockBirds // long-pressing a card inside an open batch panel now
    // correctly shows the floating selection bar right away, instead of only
    // after the panel is closed.
  );
  host.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!(await showConfirmDialog("Delete this bird? This can't be undone."))) return;
    await localBirdDelete(b.dataset.del, currentCoopId);
    showToast("Bird deleted", "delete");
    refreshAndRender();
  }));
}

/** The batch-wide editor (photo, location, styling, delete-the-whole-batch)
 * -- split out from showBatchPanel above into its own explicit modal, so
 * opening a group to browse its birds and deliberately editing the whole
 * group's shared properties are two distinct actions instead of the same
 * tap always surfacing both at once. */
function batchEditModalHtml(batchName) {
  const birds = STATE.birds.filter(b => b.batch_name === batchName);
  const cover = birds.find(b => b.photo || pendingPhotoUrls[b.id]);
  // If every bird in the batch already shares the same value, reflect that
  // in the form instead of a hardcoded default -- so reopening this shows
  // what's actually applied, not a reset-looking blank state.
  const sharedValue = (field, fallback) => {
    const vals = new Set(birds.map(b => b[field] || null));
    return vals.size === 1 && [...vals][0] ? [...vals][0] : fallback;
  };
  const sharedColor = sharedValue("card_color", "#5A4B3C");
  const sharedBorderStyle = sharedValue("border_style", "solid");
  const sharedPattern = sharedValue("card_pattern", "solid");
  const sharedLocation = sharedValue("location", "");
  return `
    <div class="form-head">Edit group -- ${esc(batchName)}</div>
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <div style="width:64px;height:64px;border-radius:8px;overflow:hidden;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;font-size:26px;flex:0 0 auto">
        ${cover ? `<img src="${birdPhotoUrl(cover)}" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(cover)};${photoTransformStyle(cover)}">` : "🐣"}
      </div>
      <div style="flex:1;min-width:180px">
        <label class="field"><span>Set group photo (applies to every bird in this batch)</span><input type="file" id="batchPhotoInput" accept="image/*"></label>
        ${cover ? `<button class="btn ghost small" id="repositionBatchPhoto" style="margin-top:8px">↔ Reposition (applies to whole batch)</button>` : ""}
      </div>
    </div>

    <div class="form-block" style="margin-bottom:14px">
      <div class="dim" style="font-size:12px;margin-bottom:8px">Batch name -- renames every bird in this group</div>
      <label class="field"><span>Name</span><input id="batch_rename" value="${esc(batchName)}"></label>
      <button class="btn ghost small" id="applyBatchRename" style="margin-top:10px">Rename batch</button>
    </div>

    <div class="form-block" style="margin-bottom:14px">
      <div class="dim" style="font-size:12px;margin-bottom:8px">Group location -- applies to every bird in this batch</div>
      <label class="field"><span>Location</span><select id="batch_location"><option value="">(unspecified)</option>${getBeddingAreas().map(a => `<option value="${esc(a)}" ${sharedLocation === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
      <button class="btn ghost small" id="applyBatchLocation" style="margin-top:10px">Apply to whole batch</button>
    </div>

    ${(() => {
      // Backfill for a batch that predates this feature (or was created
      // without a price): only offered while NONE of its birds have a cost
      // on file yet, so this can't silently double up or clobber whatever's
      // already there from the create-batch flow or an individual edit.
      const alreadyCosted = birds.filter(b => b.acquisition_cost > 0);
      if (alreadyCosted.length > 0) {
        const total = alreadyCosted.reduce((s, b) => s + (Number(b.acquisition_cost) || 0), 0);
        return `<div class="form-block" style="margin-bottom:14px">
          <div class="dim" style="font-size:12px">Acquisition cost already recorded: ${fmtMoney(total)} total across ${alreadyCosted.length} of ${birds.length} bird${birds.length !== 1 ? "s" : ""}. Edit an individual bird to adjust its own share.</div>
        </div>`;
      }
      return `<div class="form-block" style="margin-bottom:14px">
        <div class="dim" style="font-size:12px;margin-bottom:8px">Acquisition cost -- not yet recorded for this batch. Splits evenly and logs a Birds/Chicks expense, same as entering it when the batch was created.</div>
        <label class="field"><span>Total price for the batch</span><input type="number" step="0.01" min="0" id="batch_acq_price" placeholder="e.g. 75.00"></label>
        <button class="btn ghost small" id="applyBatchCost" style="margin-top:10px">Apply to whole batch</button>
      </div>`;
    })()}

    <div class="form-block" style="margin-bottom:14px">
      <div class="dim" style="font-size:12px;margin-bottom:8px">Group card styling -- applies to every bird in this batch</div>
      <div class="grid-form">
        <label class="field"><span>Card color</span><input type="color" id="batch_color" value="${sharedColor}" style="width:60px;height:38px;padding:2px;cursor:pointer"></label>
        <label class="field"><span>Border style</span><select id="batch_border_style">${["solid", "dashed", "dotted"].map(s => `<option value="${s}" ${sharedBorderStyle === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
        <label class="field"><span>Background</span><select id="batch_pattern">${[["solid", "Solid tint"], ["gradient", "Gradient"], ["dots", "Dots"], ["stripes", "Stripes"]].map(([v, l]) => `<option value="${v}" ${sharedPattern === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost small" id="applyBatchStyle">Apply to whole batch</button>
        <button class="btn ghost small" id="clearBatchStyle">Clear styling from whole batch</button>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn btn-close small" id="deleteBatchBtn">🗑 Delete entire batch</button>
      <button class="btn ghost small" id="closeBatchEditModal" style="margin-left:auto">Done</button>
    </div>
  `;
}

function wireBatchEditModal(batchName) {
  const birds = STATE.birds.filter(b => b.batch_name === batchName);
  const refresh = () => { refreshModalContent(batchEditModalHtml(batchName)); wireBatchEditModal(batchName); };
  document.getElementById("closeBatchEditModal").addEventListener("click", () => closeModal());
  const applyBatchRenameBtn = document.getElementById("applyBatchRename");
  if (applyBatchRenameBtn) applyBatchRenameBtn.addEventListener("click", async () => {
    const newName = document.getElementById("batch_rename").value.trim();
    if (!newName) { showToast("Enter a name first", "update"); return; }
    if (newName === batchName) return; // unchanged, nothing to do
    // Renaming to a name that's already in use isn't necessarily a mistake --
    // it's a reasonable way to merge two batches that should've been one --
    // but it should be a deliberate choice, not an accidental typo landing
    // on another batch's name, so the confirmation wording changes to say
    // plainly what's about to happen either way.
    const collides = STATE.birds.some(b => b.batch_name === newName);
    const message = collides
      ? `A batch named "${esc(newName)}" already exists. Renaming will merge this batch's ${birds.length} bird${birds.length !== 1 ? "s" : ""} into it -- they'll become one group. Continue?`
      : `Rename this batch (and all ${birds.length} of its birds) to "${esc(newName)}"?`;
    if (!(await showConfirmDialog(message, collides ? "Merge" : "Rename"))) return;
    // A bird created as part of this batch got its own name auto-filled as
    // "{batch name} #N" (old style) or "{batch name}-N" (current) -- if a
    // bird's name is STILL exactly that (nobody's since given it its own
    // name, like "Henrietta"), the rename carries through to it too, since
    // that name was really just standing in for the batch name in the first
    // place. Anything that's been individually customized is left completely
    // alone -- an exact-pattern match is a narrow, safe way to tell "still
    // auto-generated" apart from "somebody named this bird." Always
    // regenerated in the current "-N" style regardless of which one matched,
    // so an older batch naturally migrates the first time it's touched.
    const escaped = batchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const autoNamePattern = new RegExp(`^${escaped}(?: #|-)(\\d+)$`);
    let renamedCount = 0;
    const fieldsFor = (b) => {
      const m = b.name && b.name.match(autoNamePattern);
      if (m) { renamedCount++; return { batch_name: newName, name: `${newName}-${m[1]}` }; }
      return { batch_name: newName };
    };
    await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: fieldsFor(b) })), currentCoopId);
    if (currentOpenBatchName === batchName) currentOpenBatchName = newName;
    const suffix = renamedCount > 0 ? ` -- ${renamedCount} bird${renamedCount !== 1 ? "s'" : "'s"} own name${renamedCount !== 1 ? "s" : ""} updated to match, ${birds.length - renamedCount} left as customized` : "";
    showToast(`${collides ? "Batches merged" : "Batch renamed"}${suffix}`, "update");
    await loadCoopData();
    closeModal();
  });
  document.getElementById("applyBatchLocation").addEventListener("click", async () => {
    const location = document.getElementById("batch_location").value;
    await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: { location: location || null } })), currentCoopId);
    showToast("Batch location applied", "update");
    await loadCoopData();
    refresh();
  });
  const applyBatchCostBtn = document.getElementById("applyBatchCost");
  if (applyBatchCostBtn) applyBatchCostBtn.addEventListener("click", async () => {
    const total = Number(document.getElementById("batch_acq_price").value) || 0;
    if (total <= 0) return;
    // Same pattern as creating a batch with a price -- one linked expense,
    // split evenly, each bird keeping its own share.
    const expense = await localExpenseCreate({
      coop_id: currentCoopId, date: todayStr(), category: "Birds/Chicks",
      description: `${batchName} (${birds.length} birds, added after the fact)`, amount: total, entry_type: "expense",
    });
    const perBird = total / birds.length;
    await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: { acquisition_cost: perBird, source_expense_id: expense.id } })), currentCoopId);
    showToast("Batch acquisition cost applied", "update");
    await loadCoopData();
    refresh();
  });
  document.getElementById("applyBatchStyle").addEventListener("click", async () => {
    const updates = {
      card_color: document.getElementById("batch_color").value,
      border_style: document.getElementById("batch_border_style").value,
      card_pattern: document.getElementById("batch_pattern").value,
    };
    await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: updates })), currentCoopId);
    showToast("Batch styling applied", "update");
    await loadCoopData();
    refresh();
  });
  document.getElementById("clearBatchStyle").addEventListener("click", async () => {
    await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: { card_color: null, border_style: null, card_pattern: null } })), currentCoopId);
    showToast("Batch styling cleared", "update");
    await loadCoopData();
    refresh();
  });
  document.getElementById("deleteBatchBtn").addEventListener("click", async () => {
    if (!(await showConfirmDialog(`Delete the entire "${batchName}" batch -- all ${birds.length} birds? This can't be undone.`))) return;
    await localBulkDeleteBirds(birds.map(x => x.id), currentCoopId);
    showToast(`"${batchName}" batch deleted`, "delete");
    closeModal();
    currentOpenBatchName = null;
    document.getElementById("birdFormHost").innerHTML = ""; // the batch panel behind this modal no longer has anything to show
    refreshAndRender();
  });
  document.getElementById("batchPhotoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const blob = await resizeImageFileToBlob(file);
    try {
      const result = await apiUploadPhoto(birds[0].id, blob, "birds");
      await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: { photo: result.photo } })), currentCoopId, { suppressUndo: true });
    } catch (err) {
      await Promise.all(birds.map(b => queuePendingPhoto(b.id, blob)));
      trySyncSoon("birds", currentCoopId);
    }
    showToast("Group photo updated", "update");
    await loadCoopData();
    refresh();
  });
  const repositionBatchBtn = document.getElementById("repositionBatchPhoto");
  if (repositionBatchBtn) repositionBatchBtn.addEventListener("click", () => {
    const cover = birds.find(b => b.photo || pendingPhotoUrls[b.id]);
    if (!cover) return;
    openPhotoRepositionModal(birdPhotoUrl(cover), cover.photo_pos_x ?? 50, cover.photo_pos_y ?? 50, photoZoom(cover), "1/1", async (x, y, zoom) => {
      await localBulkUpdate("birds", birds.map(b => ({ id: b.id, fields: { photo_pos_x: x, photo_pos_y: y, photo_zoom: zoom } })), currentCoopId);
      showToast("Photo position applied to whole batch", "update");
      await loadCoopData();
      refresh();
    });
  });
}

function openBatchEditModal(batchName) {
  openModal(batchEditModalHtml(batchName), () => {
    // Whatever changed in here (photo, location, styling) should be
    // reflected in BOTH the expanded panel underneath AND the collapsed
    // group card in the main grid once this closes -- a full re-render
    // covers both, since renderFlockBirds re-opens the panel itself when
    // currentOpenBatchName is set.
    if (document.getElementById("birdFormHost")) renderFlockBirds();
  });
  wireBatchEditModal(batchName);
}

function renderFlockHealthSection() {
  const el = document.getElementById("flockSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const birdById = new Map(STATE.birds.map(b => [b.id, b]));
  const birdNameOf = (id) => { const b = birdById.get(id); return b ? b.name : "(deleted bird)"; };
  // A log belongs to an "active" bird only if that bird still exists and is
  // Active -- entries for processed, deceased, or deleted birds fall out of
  // the default view. The count of what's hidden is shown so it's never a
  // mystery why an old entry isn't there.
  const isActiveBirdsLog = (l) => { const b = birdById.get(l.bird_id); return b && b.status === "Active"; };
  const allLogs = [...STATE.birdLogs].sort((a, b) => b.date.localeCompare(a.date));
  const hiddenCount = allLogs.filter(l => !isActiveBirdsLog(l)).length;
  const logs = healthLogScope === "active" ? allLogs.filter(isActiveBirdsLog) : allLogs;
  el.innerHTML = `
    <div class="form-block">
      <div class="form-head"><span>Flock health &amp; notes log</span></div>
      <div class="dim" style="font-size:12px;margin-bottom:10px">Every log entry, most recent first. Add or remove entries from an individual bird's edit screen.</div>
      <div class="range-select" style="margin-bottom:12px">
        <button class="range-btn ${healthLogScope === "active" ? "active" : ""}" data-health-scope="active">Active birds</button>
        <button class="range-btn ${healthLogScope === "all" ? "active" : ""}" data-health-scope="all">All birds${hiddenCount ? ` (+${hiddenCount})` : ""}</button>
      </div>
      ${logs.length === 0 ? `<div class="empty">${healthLogScope === "active" && hiddenCount ? "No log entries for active birds. Tap “All birds” to see entries for processed or past birds." : "No log entries yet."}</div>` : `
      <div style="display:flex;flex-direction:column;gap:8px;max-height:520px;overflow-y:auto">
        ${logs.map(l => { const b = birdById.get(l.bird_id); const inactive = !b || b.status !== "Active"; return `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:start;font-size:13px;border-bottom:1px solid #5A4B3C30;padding-bottom:8px">
            <div>
              <span class="mono dim" style="font-size:11px">${fmtDate(l.date)}</span>
              <span class="stamp tone-${inactive ? "rust" : "slate"}" style="margin-left:6px">${esc(birdNameOf(l.bird_id))}${b && b.status && b.status !== "Active" ? ` · ${esc(b.status)}` : ""}</span>
              <div style="margin-top:4px">${esc(l.note)}</div>
            </div>
            <button class="icon-btn" data-del-flock-log="${l.id}">🗑</button>
          </div>`; }).join("")}
      </div>`}
    </div>
  `;
  el.querySelectorAll("[data-health-scope]").forEach(b => b.addEventListener("click", () => {
    healthLogScope = b.dataset.healthScope;
    renderFlockHealthSection();
  }));
  el.querySelectorAll("[data-del-flock-log]").forEach(b => b.addEventListener("click", async () => {
    await localBirdLogDelete(b.dataset.delFlockLog, currentCoopId);
    STATE.birdLogs = await localGetAll("bird_logs", currentCoopId);
    renderFlockHealthSection();
  }));
}

function showBulkEditForm() {
  const count = selectedBirdIds.size;
  const html = `
    <div class="form-head">Bulk edit ${count} bird${count !== 1 ? "s" : ""}</div>
    <div class="note-box" style="margin-bottom:12px">Leave a field blank to leave it unchanged on all selected birds. Only fields you fill in get applied.</div>
    <div class="grid-form">
      <label class="field"><span>Type</span><select id="be_type"><option value="">(no change)</option>${BIRD_TYPES.map(t => `<option value="${t}">${t}</option>`).join("")}</select></label>
      <label class="field"><span>Gender</span><select id="be_gender"><option value="">(no change)</option><option value="Hen">Hen</option><option value="Rooster">Rooster</option></select></label>
      <label class="field"><span>Status</span><select id="be_status"><option value="">(no change)</option>${BIRD_STATUSES.map(s => `<option value="${s}">${s}</option>`).join("")}</select></label>
      <label class="field"><span>Location</span><select id="be_location"><option value="">(no change)</option>${getBeddingAreas().map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select></label>
      <label class="field"><span>Hatch date</span><input type="date" id="be_hatch"></label>
      <label class="field"><span>Acquired date</span><input type="date" id="be_acquired"></label>
      <label class="field"><span>Target harvest date</span><input type="date" id="be_target"></label>
    </div>
    <label class="field"><span>Batch name</span><input id="be_batch" placeholder="(no change) e.g. Spring Cornish Cross"></label>
    <label class="field" style="display:flex;flex-direction:row;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="be_remove_batch" style="width:auto"><span>Remove from batch (clears it, ignoring anything typed above)</span></label>
    <div class="dim" style="font-size:11px;margin:12px 0 4px">If setting Status to Processed, these fill in the harvest record:</div>
    <div class="grid-form">
      <label class="field"><span>Harvest date</span><input type="date" id="be_harvest_date"></label>
      ${weightEntryFieldHtml("be_harvest_weight", null, "Harvest weight (each)")}
      <label class="field"><span>Store-equivalent value per ${getWeightUnit()} ($)</span><input type="number" step="0.01" id="be_price" placeholder="(no change)"></label>
    </div>
    <div class="dim" style="font-size:11px;margin:12px 0 4px">If setting Status to Deceased, these fill in the loss record:</div>
    <div class="grid-form">
      <label class="field"><span>Death date</span><input type="date" id="be_death_date"></label>
      <label class="field"><span>Cause</span><input id="be_death_cause" placeholder="(no change)"></label>
    </div>
    <div class="dim" style="font-size:11px;margin:12px 0 4px">Card styling:</div>
    <div class="grid-form">
      <label class="field"><span>Border style</span><select id="be_border_style"><option value="">(no change)</option>${["solid", "dashed", "dotted"].map(s => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
      <label class="field"><span>Background</span><select id="be_pattern"><option value="">(no change)</option>${[["solid", "Solid tint"], ["gradient", "Gradient"], ["dots", "Dots"], ["stripes", "Stripes"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
    </div>
    <label class="field" style="display:flex;flex-direction:row;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="be_set_color" style="width:auto"><span>Set card color</span></label>
    <label class="field" style="margin-top:6px"><span>Card color</span><input type="color" id="be_color" value="#5A4B3C" style="width:60px;height:38px;padding:2px;cursor:pointer"></label>
    <div class="modal-actions"><button class="btn btn-confirm" id="saveBulkEdit">✓ Apply to ${count} bird${count !== 1 ? "s" : ""}</button></div>
  `;
  openModal(html);
  document.getElementById("saveBulkEdit").addEventListener("click", async () => {
    const updates = {};
    const type = document.getElementById("be_type").value;
    const gender = document.getElementById("be_gender").value;
    const status = document.getElementById("be_status").value;
    const location = document.getElementById("be_location").value;
    const hatchDate = document.getElementById("be_hatch").value;
    const acquiredDate = document.getElementById("be_acquired").value;
    const batch = document.getElementById("be_batch").value;
    const removeBatch = document.getElementById("be_remove_batch").checked;
    const target = document.getElementById("be_target").value;
    const harvestDate = document.getElementById("be_harvest_date").value;
    // null means the field(s) were left blank -- "no change" here, unlike the
    // single-bird form where blank commonly means an explicit weight of 0.
    const harvestWeight = readWeightEntryField("be_harvest_weight");
    const price = document.getElementById("be_price").value;
    const deathDate = document.getElementById("be_death_date").value;
    const deathCause = document.getElementById("be_death_cause").value;
    const borderStyle = document.getElementById("be_border_style").value;
    const pattern = document.getElementById("be_pattern").value;
    const setColor = document.getElementById("be_set_color").checked;
    if (type) updates.type = type;
    if (gender) updates.gender = gender;
    if (status) updates.status = status;
    if (location) updates.location = location;
    if (hatchDate) updates.hatch_date = hatchDate;
    if (acquiredDate) updates.acquired_date = acquiredDate;
    // Typing a name is unambiguous, so it applies on its own -- same as every
    // other field in this form. The checkbox is only needed for the one
    // genuinely ambiguous case: an empty field could mean "didn't touch this"
    // or "take them out of their batch," so removal needs an explicit signal.
    const batchTrimmed = batch.trim();
    if (batchTrimmed) updates.batch_name = batchTrimmed;
    else if (removeBatch) updates.batch_name = null;
    if (target) updates.target_harvest_date = target;
    // Layers don't have a harvest date -- clear it out unless this same
    // bulk edit is also explicitly setting a new one.
    if (type === "Layer" && !target) updates.target_harvest_date = null;
    if (harvestDate) updates.harvest_date = harvestDate;
    if (harvestWeight) updates.harvest_weight = harvestWeight;
    if (price) updates.price_per_lb = parsePricePerLbInput(price);
    if (deathDate) updates.death_date = deathDate;
    if (deathCause) updates.death_cause = deathCause;
    if (borderStyle) updates.border_style = borderStyle;
    if (pattern) updates.card_pattern = pattern;
    if (setColor) updates.card_color = document.getElementById("be_color").value;
    if (Object.keys(updates).length === 0) { closeModal(); return; }
    const n = selectedBirdIds.size;
    await localBulkUpdate("birds", [...selectedBirdIds].map(id => ({ id, fields: updates })), currentCoopId);
    showToast(`${n} bird${n !== 1 ? "s" : ""} updated`, "update");
    selectedBirdIds.clear();
    closeModal();
    refreshAndRender();
  });
}

function renderBirdLogSection(birdId) {
  const host = document.getElementById("birdLogSection");
  if (!host) return;
  const logs = STATE.birdLogs.filter(l => l.bird_id === birdId).sort((a, b) => b.date.localeCompare(a.date));
  host.innerHTML = `
    <div style="border-top:1px solid var(--border);padding-top:14px">
      <div class="form-head" style="margin-bottom:8px"><span>Health &amp; notes log</span></div>
      <div class="grid-form" style="grid-template-columns:140px 1fr auto">
        <label class="field"><span>Date</span><input type="date" id="log_date" value="${todayStr()}"></label>
        <label class="field"><span>Entry</span><input id="log_note" placeholder="e.g. treated for mites, limping on left leg"></label>
        <div style="align-self:end"><button class="btn small" id="addLogEntry">+ Add</button></div>
      </div>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
        ${logs.length === 0 ? `<div class="dim" style="font-size:12px">No log entries yet.</div>` : logs.map(l => `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:start;font-size:13px;border-bottom:1px solid #5A4B3C30;padding-bottom:8px">
            <div><span class="mono dim" style="font-size:11px">${fmtDate(l.date)}</span><div>${esc(l.note)}</div></div>
            <button class="icon-btn" data-del-log="${l.id}">🗑</button>
          </div>`).join("")}
      </div>
    </div>
  `;
  document.getElementById("addLogEntry").addEventListener("click", async () => {
    const note = document.getElementById("log_note").value.trim();
    if (!note) return;
    await localBirdLogCreate({ coop_id: currentCoopId, bird_id: birdId, date: document.getElementById("log_date").value, note });
    STATE.birdLogs = await localGetAll("bird_logs", currentCoopId);
    renderBirdLogSection(birdId);
  });
  host.querySelectorAll("[data-del-log]").forEach(b => b.addEventListener("click", async () => {
    await localBirdLogDelete(b.dataset.delLog, currentCoopId);
    STATE.birdLogs = await localGetAll("bird_logs", currentCoopId);
    renderBirdLogSection(birdId);
  }));
}

/** Add-to-timeline flow for a bird's photo history: file, date taken
 * (defaults today), and a stage (auto-suggested from age at that date,
 * re-suggested live if the date changes, always overridable by hand). */
function openAddHistoryPhotoModal(bird, onDone) {
  const today = todayStr();
  const html = `
    <div class="form-head">Add photos to ${esc(bird.name) || "this bird"}'s timeline</div>
    <label class="field"><span>Photos</span><input type="file" id="hp_file" accept="image/*" multiple></label>
    <div class="dim" style="font-size:11px;margin-top:-8px">Pick more than one to add them all at once, sharing the same date and stage below -- handy for a batch taken the same day.</div>
    <label class="field"><span>Date taken</span><input type="date" id="hp_date" value="${today}"></label>
    <label class="field"><span>Stage</span><select id="hp_stage">
      <option value="">Unspecified</option>
      ${BIRD_STAGES.map(s => `<option value="${s}" ${s === suggestStage(bird.hatch_date, today) ? "selected" : ""}>${s}</option>`).join("")}
    </select></label>
    ${!bird.hatch_date ? `<div class="dim" style="font-size:11px;margin-top:-8px">Set a hatch date on this bird for the stage to auto-suggest by age.</div>` : ""}
    <div id="hp_progress" class="dim" style="font-size:12px;margin-top:8px"></div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="hp_save">+ Add photo</button>
    </div>
  `;
  openModal(html, null, null, onDone);
  document.getElementById("hp_date").addEventListener("change", (e) => {
    if (!bird.hatch_date) return;
    document.getElementById("hp_stage").value = suggestStage(bird.hatch_date, e.target.value);
  });
  document.getElementById("hp_file").addEventListener("change", (e) => {
    const n = e.target.files.length;
    document.getElementById("hp_save").textContent = n > 1 ? `+ Add ${n} photos` : "+ Add photo";
  });
  document.getElementById("hp_save").addEventListener("click", async () => {
    const files = [...document.getElementById("hp_file").files];
    if (files.length === 0) { showToast("Pick a photo first", "delete"); return; }
    const dateTaken = document.getElementById("hp_date").value || today;
    const stage = document.getElementById("hp_stage").value || null;
    const saveBtn = document.getElementById("hp_save");
    const progressEl = document.getElementById("hp_progress");
    // Checked before anything is created below -- this is genuinely this
    // bird's first-ever photo (no current main, no existing library
    // entries) only if both are true right now, before this upload adds any.
    const isBirdsFirstEverPhoto = !bird.photo && STATE.birdPhotos.filter(p => p.bird_id === bird.id).length === 0;
    saveBtn.disabled = true;
    const validBlobs = [];
    for (let i = 0; i < files.length; i++) {
      if (files.length > 1) progressEl.textContent = `Reading photo ${i + 1} of ${files.length}...`;
      try {
        validBlobs.push(await resizeImageFileToBlob(files[i]));
      } catch (err) {
        console.error(`Couldn't read ${files[i].name}:`, err); // skip this one, keep going with the rest of the batch rather than losing everything to one bad file
      }
    }
    if (validBlobs.length === 0) {
      saveBtn.disabled = false;
      progressEl.textContent = "";
      alert("Couldn't read any of those images -- try a different file.");
      return;
    }
    progressEl.textContent = validBlobs.length > 1 ? "Saving..." : "";
    const payloads = validBlobs.map(() => ({ coop_id: currentCoopId, bird_id: bird.id, photo: null, date_taken: dateTaken, stage, photo_pos_x: 50, photo_pos_y: 50, photo_zoom: 1 }));
    const created = await localBulkCreate("bird_photos", payloads);
    for (let i = 0; i < created.length; i++) await queuePendingBirdHistoryPhoto(created[i].id, validBlobs[i]);
    if (isBirdsFirstEverPhoto && created.length > 0) await setBirdMainPhotoFromHistoryEntry(created[0], bird.id);
    await refreshPendingBirdHistoryPhotoUrls();
    STATE.birdPhotos = await localGetAll("bird_photos", currentCoopId);
    saveBtn.disabled = false;
    progressEl.textContent = "";
    showToast(validBlobs.length > 1 ? `${validBlobs.length} photos added to timeline` : "Photo added to timeline", "create");
    onDone();
  });
}

/** Options for an existing timeline photo: view it with its age at that
 * date, edit date/stage, reposition its crop, delete it, or promote it to
 * be the bird's current photo (the one shown on cards everywhere). */
/** Copies a history entry's photo (and crop) onto the bird as its current
 * main photo -- handles both an already-uploaded entry (just copy the
 * reference) and one still mid-upload (grabs the same local blob and
 * queues it as the bird's own photo too, from the same source). Shared
 * between the "set as current" button and auto-promoting a bird's very
 * first-ever photo. Returns false only if the photo is still queued and
 * its blob genuinely isn't available yet (caller should ask to retry). */
async function setBirdMainPhotoFromHistoryEntry(photo, birdId) {
  // Re-fetch the current state of this entry rather than trusting the
  // caller's snapshot -- it may have already finished uploading in the
  // background since that snapshot was taken, especially when called
  // immediately after a fresh upload.
  const current = STATE.birdPhotos.find(p => p.id === photo.id) || photo;
  if (current.photo) {
    // Already uploaded -- just copy the reference and its crop over.
    await localBirdUpdate(birdId, { photo: current.photo, photo_pos_x: current.photo_pos_x, photo_pos_y: current.photo_pos_y, photo_zoom: current.photo_zoom, main_bird_photo_id: current.id });
  } else {
    // Still queued locally (added moments ago, hasn't synced yet) --
    // grab that same local blob and queue it as the bird's own current
    // photo too, rather than copying a reference that doesn't exist yet.
    // This ends up as a genuinely separate upload of the same image data
    // (the two will get different filenames once both finish syncing),
    // which is exactly why main_bird_photo_id -- not a file-path match --
    // is what keeps this entry linked as main afterward.
    const db = await openLocalDb();
    const tx = db.transaction(["pending_bird_history_photos"], "readonly");
    const pending = await idbRequest(tx.objectStore("pending_bird_history_photos").get(current.id));
    if (!pending || !pending.blob) {
      // The upload may have finished in the very short window between
      // the STATE check above and this one -- the pending-queue entry
      // gets cleared right after a successful upload, so "not pending
      // anymore" can mean "already done," not just "not ready." Check
      // the database directly (bypassing potentially-stale in-memory
      // STATE) before concluding there's genuinely nothing to use yet.
      const fresh = await localGetOne("bird_photos", current.id);
      if (fresh && fresh.photo) {
        await localBirdUpdate(birdId, { photo: fresh.photo, photo_pos_x: fresh.photo_pos_x, photo_pos_y: fresh.photo_pos_y, photo_zoom: fresh.photo_zoom, main_bird_photo_id: fresh.id });
        STATE.birds = await localGetAll("birds", currentCoopId);
        return true;
      }
      return false;
    }
    await localBirdUpdate(birdId, { photo_pos_x: current.photo_pos_x, photo_pos_y: current.photo_pos_y, photo_zoom: current.photo_zoom, main_bird_photo_id: current.id });
    await queuePendingPhoto(birdId, pending.blob);
    await refreshPendingPhotoUrls();
  }
  STATE.birds = await localGetAll("birds", currentCoopId);
  return true;
}

function openHistoryPhotoOptionsModal(photo, bird, onDone) {
  const ageLabel = photo.date_taken && bird.hatch_date ? ageAtDate(bird.hatch_date, photo.date_taken) : null;
  const html = `
    <div class="form-head">Timeline photo</div>
    <div id="hpo_photo_thumb" title="Tap to view full size" style="width:140px;height:140px;border-radius:10px;overflow:hidden;margin:0 auto 10px;border:1px solid var(--border);cursor:zoom-in">
      <img src="${birdHistoryPhotoUrl(photo)}" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(photo)};${photoTransformStyle(photo)}">
    </div>
    ${ageLabel ? `<div class="dim" style="font-size:12px;text-align:center;margin-bottom:14px">${esc(ageLabel)}</div>` : ""}
    <label class="field"><span>Date taken</span><input type="date" id="hpo_date" value="${photo.date_taken || ""}"></label>
    <label class="field"><span>Stage</span><select id="hpo_stage">
      <option value="">Unspecified</option>
      ${BIRD_STAGES.map(s => `<option value="${s}" ${photo.stage === s ? "selected" : ""}>${s}</option>`).join("")}
    </select></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn ghost small" id="hpo_reposition">↔ Reposition</button>
      <button class="btn ghost small" id="hpo_set_current">⭐ Set as current photo</button>
      <button class="btn btn-close small" id="hpo_delete">🗑 Delete</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="hpo_save">✓ Save changes</button>
    </div>
  `;
  openModal(html, null, null, onDone);
  // Same behavior as the bird's main photo in the edit form: tapping the
  // thumbnail opens it full size. Reposition stays on its own button below.
  document.getElementById("hpo_photo_thumb").addEventListener("click", () => showPhotoLightbox(birdHistoryPhotoUrl(photo)));
  document.getElementById("hpo_delete").addEventListener("click", async () => {
    if (!(await showConfirmDialog("Delete this timeline photo? This can't be undone."))) return;
    await localBulkDelete("bird_photos", [photo.id], currentCoopId);
    STATE.birdPhotos = await localGetAll("bird_photos", currentCoopId);
    const currentBird = STATE.birds.find(b => b.id === bird.id);
    const noEntriesLeft = !STATE.birdPhotos.some(p => p.bird_id === bird.id);
    const wasLinked = currentBird && (
      currentBird.main_bird_photo_id ? currentBird.main_bird_photo_id === photo.id
      : (currentBird.photo && photo.photo && currentBird.photo === photo.photo)
    );
    if (wasLinked || noEntriesLeft) {
      // Either this was the specifically-linked entry, or the history is
      // now completely empty -- an empty library can't have a main photo,
      // regardless of whether the ID/file-path match above succeeded, so
      // this is a direct safety net against the two ever drifting apart.
      // Also clear any queued local upload for the bird's own photo and
      // refresh the cached blob-URL map -- birdPhotoUrl() checks that
      // cache before the (now-null) photo field, so without this the old
      // image would keep displaying despite the data being correctly
      // cleared.
      await localBirdUpdate(bird.id, { photo: null, main_bird_photo_id: null });
      await clearPendingPhoto(bird.id);
      await refreshPendingPhotoUrls();
      STATE.birds = await localGetAll("birds", currentCoopId);
    }
    showToast("Timeline photo deleted", "delete");
    onDone();
  });
  document.getElementById("hpo_save").addEventListener("click", async () => {
    const dateTaken = document.getElementById("hpo_date").value || null;
    const stage = document.getElementById("hpo_stage").value || null;
    await localBirdPhotoUpdate(photo.id, { date_taken: dateTaken, stage });
    STATE.birdPhotos = await localGetAll("bird_photos", currentCoopId);
    showToast("Timeline photo updated", "update");
    onDone();
  });
  document.getElementById("hpo_reposition").addEventListener("click", () => {
    openPhotoRepositionModal(birdHistoryPhotoUrl(photo), photo.photo_pos_x ?? 50, photo.photo_pos_y ?? 50, photoZoom(photo), "1/1", async (x, y, zoom) => {
      await localBirdPhotoUpdate(photo.id, { photo_pos_x: x, photo_pos_y: y, photo_zoom: zoom });
      // This entry might also be the one currently linked as the bird's
      // main photo -- if so, keep its crop in sync too, since there's no
      // separate "reposition the main photo" control anymore. Matched by
      // main_bird_photo_id, not file path -- a photo that was still
      // uploading when it got set as current ends up as a genuinely
      // different file than the bird's own copy, so file-path matching
      // can't be relied on there. Falls back to the old file-path check
      // only for a bird that hasn't been backfilled to the new field yet.
      const currentBird = STATE.birds.find(b => b.id === bird.id);
      const isLinked = currentBird && (
        currentBird.main_bird_photo_id ? currentBird.main_bird_photo_id === photo.id
        : (currentBird.photo && photo.photo && currentBird.photo === photo.photo)
      );
      if (isLinked) {
        await localBirdUpdate(bird.id, { photo_pos_x: x, photo_pos_y: y, photo_zoom: zoom, main_bird_photo_id: photo.id });
        STATE.birds = await localGetAll("birds", currentCoopId);
      }
      STATE.birdPhotos = await localGetAll("bird_photos", currentCoopId);
      showToast("Photo position updated", "update");
      onDone();
    });
  });

  document.getElementById("hpo_set_current").addEventListener("click", async () => {
    const ok = await setBirdMainPhotoFromHistoryEntry(photo, bird.id);
    if (!ok) {
      showToast("This photo hasn't finished saving yet -- try again in a moment", "delete");
      return;
    }
    STATE.birds = await localGetAll("birds", currentCoopId);
    showToast(`Set as ${esc(bird.name) || "the bird's"} current photo`, "update");
    onDone();
  });
}

/** A scrollable, chronological gallery of a bird's full photo history --
 * the "see how they've grown" view. Each photo is clickable through to the
 * same edit/reposition/delete/set-as-current options as the form's strip. */
/** Swipeable/clickable viewer for all photos taken on one specific day --
 * reached by tapping a multi-photo stack in the timeline. Arrow buttons and
 * touch swipe both work; re-renders in place rather than reopening the
 * modal each time, so navigating feels instant. */
function openDayPhotosModal(dateTaken, bird, onDone) {
  let idx = 0;
  const getPhotos = () => STATE.birdPhotos.filter(p => p.bird_id === bird.id && p.date_taken === dateTaken).sort((a, b) => a.id.localeCompare(b.id));
  let touchStartX = null;

  function render(firstOpen) {
    const photos = getPhotos();
    if (photos.length === 0) { onDone(); return; } // the last one here got deleted -- nothing left to show
    idx = Math.max(0, Math.min(idx, photos.length - 1));
    const p = photos[idx];
    const ageLabel = p.date_taken && bird.hatch_date ? ageAtDate(bird.hatch_date, p.date_taken) : null;
    const url = birdHistoryPhotoUrl(p);
    const html = `
      <div class="form-head">${esc(fmtDate(dateTaken))}${photos.length > 1 ? ` · ${idx + 1} of ${photos.length}` : ""}</div>
      ${ageLabel ? `<div class="dim" style="font-size:12px;margin:-8px 0 12px">${esc(ageLabel)}</div>` : ""}
      <div id="dp_stage_area" style="position:relative">
        <div style="width:100%;aspect-ratio:1/1;border-radius:10px;overflow:hidden;border:1px solid var(--border)">
          ${url ? `<img src="${url}" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(p)};${photoTransformStyle(p)}">` : `<div style="width:100%;height:100%;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;font-size:32px">🐔</div>`}
        </div>
        ${photos.length > 1 ? `
          <button id="dp_prev" class="icon-btn" style="position:absolute;left:8px;top:50%;transform:translateY(-50%);background:rgba(20,16,13,0.6);color:#F2E9DC;font-size:20px">‹</button>
          <button id="dp_next" class="icon-btn" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:rgba(20,16,13,0.6);color:#F2E9DC;font-size:20px">›</button>
        ` : ""}
      </div>
      ${photos.length > 1 ? `<div style="display:flex;justify-content:center;gap:5px;margin-top:10px">${photos.map((_, i) => `<div style="width:6px;height:6px;border-radius:50%;background:${i === idx ? "var(--gold)" : "var(--border)"}"></div>`).join("")}</div>` : ""}
      ${p.stage ? `<div style="text-align:center;margin-top:10px"><span class="stamp tone-slate">${esc(p.stage)}</span></div>` : ""}
      <div class="modal-actions">
        <button class="btn ghost small" id="dp_edit">✎ Edit this photo</button>
      </div>
    `;
    if (firstOpen) openModal(html, null, null, onDone);
    else refreshModalContent(html);

    const prevBtn = document.getElementById("dp_prev");
    const nextBtn = document.getElementById("dp_next");
    if (prevBtn) prevBtn.addEventListener("click", () => { idx = (idx - 1 + photos.length) % photos.length; render(false); });
    if (nextBtn) nextBtn.addEventListener("click", () => { idx = (idx + 1) % photos.length; render(false); });
    document.getElementById("dp_edit").addEventListener("click", () => {
      openHistoryPhotoOptionsModal(p, bird, () => { idx = Math.min(idx, getPhotos().length - 1); render(true); });
    });
    if (photos.length > 1) {
      const stage = document.getElementById("dp_stage_area");
      stage.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
      stage.addEventListener("touchend", (e) => {
        if (touchStartX === null) return;
        const dx = e.changedTouches[0].clientX - touchStartX;
        touchStartX = null;
        if (Math.abs(dx) < 40) return; // too small to count as an intentional swipe
        idx = dx < 0 ? (idx + 1) % photos.length : (idx - 1 + photos.length) % photos.length;
        render(false);
      });
    }
  }
  render(true);
}

/** A single timeline entry for one day -- a plain thumbnail if only one
 * photo was taken that day, or a small stack (a couple of offset cards
 * peeking out behind the top one, plus a count badge) if there's more than
 * one, so a whole batch added at once collapses to a single row instead of
 * stretching the timeline out. */
function dayGroupThumbHtml(dateTaken, photosOnDay, bird) {
  const top = photosOnDay[0];
  const ageLabel = dateTaken && bird.hatch_date ? ageAtDate(bird.hatch_date, dateTaken) : null;
  const url = birdHistoryPhotoUrl(top);
  const isStack = photosOnDay.length > 1;
  const topImgHtml = url
    ? `<img src="${url}" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(top)};${photoTransformStyle(top)}">`
    : `<div style="width:100%;height:100%;background:var(--surface-raised);display:flex;align-items:center;justify-content:center;font-size:32px">🐔</div>`;
  return `
    <div class="thumb-clickable" data-day-group="${esc(dateTaken || "")}" style="cursor:pointer">
      <div style="position:relative;width:100%;aspect-ratio:1/1">
        ${isStack ? `
          <div style="position:absolute;inset:0;transform:rotate(5deg) scale(0.95);border-radius:10px;border:1px solid var(--border);background:var(--surface-raised)"></div>
          <div style="position:absolute;inset:0;transform:rotate(-4deg) scale(0.97);border-radius:10px;border:1px solid var(--border);background:var(--surface-raised)"></div>
        ` : ""}
        <div style="position:absolute;inset:0;border-radius:10px;overflow:hidden;border:1px solid var(--border)">${topImgHtml}</div>
        ${isStack ? `<div style="position:absolute;top:6px;right:6px;background:rgba(20,16,13,0.75);color:#F2E9DC;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">📷 ${photosOnDay.length}</div>` : ""}
      </div>
      <div style="margin-top:6px">
        <div style="font-size:13px">${dateTaken ? esc(fmtDate(dateTaken)) : "No date"}</div>
        ${ageLabel ? `<div style="font-size:11px;color:var(--text-dim);margin-top:1px">${esc(ageLabel)}</div>` : ""}
        ${top.stage ? `<div style="margin-top:4px"><span class="stamp tone-slate">${esc(top.stage)}</span></div>` : ""}
      </div>
    </div>`;
}

function openBirdTimelineModal(bird, onBack) {
  const photos = STATE.birdPhotos.filter(p => p.bird_id === bird.id).sort((a, b) => (a.date_taken || "").localeCompare(b.date_taken || ""));
  // Group into one entry per day (for stacking), then those day-groups into
  // year sections -- a photo with no date at all gets its own "Undated" bucket.
  const dayGroups = [];
  for (const p of photos) {
    const last = dayGroups[dayGroups.length - 1];
    if (last && last.date === p.date_taken) last.photos.push(p);
    else dayGroups.push({ date: p.date_taken, photos: [p] });
  }
  const yearOf = (dateStr) => dateStr ? dateStr.slice(0, 4) : "Undated";
  const yearSections = [];
  for (const g of dayGroups) {
    const y = yearOf(g.date);
    const last = yearSections[yearSections.length - 1];
    if (last && last.year === y) last.groups.push(g);
    else yearSections.push({ year: y, groups: [g] });
  }
  const html = `
    <div class="form-head">${esc(bird.name) || "Bird"}'s timeline</div>
    <div class="dim" style="font-size:12px;margin:-8px 0 14px">${photos.length} photo${photos.length !== 1 ? "s" : ""} so far. Tap a photo (or a stack) to look closer.</div>
    ${yearSections.map((section, i) => {
      const isOpen = i === yearSections.length - 1; // only the most recent year starts expanded
      return `
      <button type="button" class="flock-section-header timeline-year-toggle" data-year-toggle="${esc(section.year)}" style="margin:14px 0 8px;display:flex;align-items:center;gap:6px;width:100%;background:none;border:none;cursor:pointer;padding:0;text-align:left;color:var(--text)">
        <span class="timeline-year-arrow" style="display:inline-block;transition:transform 0.15s ease;transform:rotate(${isOpen ? "90" : "0"}deg)">▸</span>
        <span>${esc(section.year)}</span>
        <span class="dim" style="font-weight:400;font-size:11px">${section.groups.reduce((n, g) => n + g.photos.length, 0)} photo${section.groups.reduce((n, g) => n + g.photos.length, 0) !== 1 ? "s" : ""}</span>
      </button>
      <div class="timeline-year-body" data-year-body="${esc(section.year)}" style="display:${isOpen ? "grid" : "none"};grid-template-columns:repeat(auto-fill, minmax(120px, 1fr));gap:14px">
        ${section.groups.map(g => dayGroupThumbHtml(g.date, g.photos, bird)).join("")}
      </div>
    `;
    }).join("")}
  `;
  // onBack (the normal path, opened from the bird form) keeps the overlay
  // open on Escape/X, swapping straight back to the form -- only the
  // standalone fallback with no parent to return to is a true close.
  if (onBack) openModal(html, null, null, onBack);
  else openModal(html, () => { if (activeTab === "flock") renderFlockHub(); });
  document.querySelectorAll("[data-year-toggle]").forEach(btn => btn.addEventListener("click", () => {
    const year = btn.dataset.yearToggle;
    const body = document.querySelector(`[data-year-body="${CSS.escape(year)}"]`);
    const arrow = btn.querySelector(".timeline-year-arrow");
    const nowOpen = body.style.display === "none";
    body.style.display = nowOpen ? "grid" : "none";
    arrow.style.transform = `rotate(${nowOpen ? "90" : "0"}deg)`;
  }));
  document.querySelectorAll("[data-day-group]").forEach(el => el.addEventListener("click", () => {
    const dateTaken = el.dataset.dayGroup || null;
    const photosOnDay = STATE.birdPhotos.filter(p => p.bird_id === bird.id && (p.date_taken || null) === dateTaken);
    if (photosOnDay.length === 1) {
      openHistoryPhotoOptionsModal(photosOnDay[0], bird, () => openBirdTimelineModal(bird, onBack));
    } else {
      openDayPhotosModal(dateTaken, bird, () => openBirdTimelineModal(bird, onBack));
    }
  }));
}

function showBirdForm(bird) {
  const isEdit = !!bird;
  let pendingPhotoBlob = null;   // a newly-picked file, resized, waiting to be uploaded on save
  let photoRemoved = false;      // user asked to remove the existing photo
  let previewUrl = bird ? birdPhotoUrl(bird) : null;
  let historySelectMode = false; // whether the photo history strip is in multi-select mode
  let selectedHistoryIds = new Set();

  let formState = bird ? { ...bird } : {
    name: "", breed: "", type: "Layer", gender: "", hatch_date: "", acquired_date: "", status: "Active",
    target_harvest_date: "", harvest_date: "", harvest_weight: "", notes: "", photo: null,
    price_per_lb: getCoopDefaults().pricePerLb, death_date: "", death_cause: "", card_color: "", border_style: "", card_pattern: "", location: "", batch_name: "",
  };

  // Reads whatever's currently in the DOM (for fields that exist) and falls
  // back to the last known state for anything hidden by the conditional
  // sections below -- so switching Status/Type to reveal/hide fields never
  // silently discards something you already typed elsewhere in the form.
  function readCurrentValues() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    return {
      ...formState,
      name: val("f_name") ?? formState.name,
      breed: val("f_breed") ?? formState.breed,
      type: val("f_type") ?? formState.type,
      gender: val("f_gender") ?? formState.gender,
      location: val("f_location") ?? formState.location,
      status: val("f_status") ?? formState.status,
      batch_name: val("f_batch") ?? formState.batch_name,
      hatch_date: val("f_hatch") ?? formState.hatch_date,
      acquired_date: val("f_acquired") ?? formState.acquired_date,
      target_harvest_date: val("f_target") ?? formState.target_harvest_date,
      harvest_date: val("f_hdate") ?? formState.harvest_date,
      harvest_weight: weightFieldPresent("f_weight") ? readWeightEntryField("f_weight") : formState.harvest_weight,
      price_per_lb: val("f_price") != null ? parsePricePerLbInput(val("f_price")) : formState.price_per_lb,
      acquisition_cost: val("f_acq_cost") != null ? (val("f_acq_cost") === "" ? null : Number(val("f_acq_cost"))) : formState.acquisition_cost,
      death_date: val("f_death_date") ?? formState.death_date,
      death_cause: val("f_death_cause") ?? formState.death_cause,
      sold_date: val("f_sold_date") ?? formState.sold_date,
      sold_amount: val("f_sold_amount") != null ? (val("f_sold_amount") === "" ? null : Number(val("f_sold_amount"))) : formState.sold_amount,
      retired_date: val("f_retired_date") ?? formState.retired_date,
      card_color: val("f_color") ?? formState.card_color,
      border_style: val("f_border_style") ?? formState.border_style,
      card_pattern: val("f_pattern") ?? formState.card_pattern,
      notes: val("f_notes") ?? formState.notes,
    };
  }

  function render(firstOpen) {
    if (firstOpen && bird) {
      // Pick up any changes made elsewhere while this form was open one
      // level down (e.g. "set as current" or deleting a photo from the
      // history modal) -- without this, the preview only ever refreshed
      // on a genuine close+reopen, since formState/previewUrl otherwise
      // keep using the snapshot captured when the form first opened.
      const fresh = STATE.birds.find(b => b.id === bird.id);
      if (fresh) {
        formState = { ...fresh };
        previewUrl = birdPhotoUrl(fresh);
        pendingPhotoBlob = null;
        photoRemoved = false;
      }
    }
    const f = formState;
    const showTarget = f.status === "Active" && (f.type === "Meat" || f.type === "Dual Purpose");
    const showProcessed = f.status === "Processed";
    const showLoss = f.status === "Deceased";
    const showSold = f.status === "Sold";
    const showRetired = f.status === "Retired";

    const html = `
      <div class="form-head">${isEdit ? "Edit bird" : "New bird"}</div>
      ${isEdit ? `<div class="dim" style="font-size:12px;margin:-8px 0 14px">${ageFromDate(f.hatch_date || f.acquired_date)}${f.hatch_date ? ` (hatched ${fmtDate(f.hatch_date)})` : f.acquired_date ? ` (acquired ${fmtDate(f.acquired_date)})` : ""}</div>` : ""}

      ${!isEdit ? `
      <div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:14px">
        <div id="photoPreview" style="width:84px;height:84px;border-radius:8px;overflow:hidden">${previewUrl ? `<img src="${previewUrl}" data-view-photo="${esc(previewUrl)}" class="thumb-clickable" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(formState)};${photoTransformStyle(formState)}border:1px solid var(--border);cursor:zoom-in" >` : `<div style="width:84px;height:84px;border-radius:8px;background:var(--bg);border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;font-size:28px">🐔</div>`}</div>
        <div>
          <label class="field"><span>Photo (optional)</span><input type="file" id="f_photo" accept="image/*"></label>
          <div class="dim" style="font-size:11px;margin-top:4px">More photos, repositioning, and switching the main one can all be managed from Photo history once this bird is saved.</div>
        </div>
      </div>
      ` : `
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:14px">
        <div id="photoPreview" style="width:84px;height:84px;border-radius:8px;overflow:hidden">${previewUrl ? `<img src="${previewUrl}" data-view-photo="${esc(previewUrl)}" class="thumb-clickable" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(formState)};${photoTransformStyle(formState)}border:1px solid var(--border);cursor:zoom-in" >` : `<div style="width:84px;height:84px;border-radius:8px;background:var(--bg);border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;font-size:28px">🐔</div>`}</div>
        <div class="dim" style="font-size:12px">${previewUrl ? "This is the current main photo. Manage it, and add more, in Photo history below." : "No main photo yet — add one in Photo history below and it'll automatically become the main photo."}</div>
      </div>

      <div class="form-block" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <div class="form-head" style="font-size:13px;margin:0">📸 Photo history</div>
          ${STATE.birdPhotos.filter(p => p.bird_id === bird.id).length > 0 ? (historySelectMode ? `
            <div style="display:flex;gap:6px">
              <button class="btn btn-close small" id="deleteSelectedHistoryBtn"${selectedHistoryIds.size === 0 ? " disabled" : ""}>🗑 Delete${selectedHistoryIds.size > 0 ? ` (${selectedHistoryIds.size})` : ""}</button>
              <button class="btn ghost small" id="cancelHistorySelectBtn">Cancel</button>
            </div>
          ` : `<button class="btn ghost small" id="startHistorySelectBtn">☑ Select</button>`) : ""}
        </div>
        <div class="dim" style="font-size:11px;margin-bottom:8px">${historySelectMode ? "Tap photos to select them, then delete." : `Every photo of ${esc(f.name) || "this bird"}, in one place — as a chick, a few months in, fully grown. Tap a photo to reposition it, edit its date or stage, set it as the main photo, or delete it.`}</div>
        <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px">
          ${!historySelectMode ? `<button class="btn ghost small" id="addHistoryPhotoBtn" style="flex:0 0 auto;height:64px;width:64px;border-radius:8px;font-size:22px;padding:0">+</button>` : ""}
          ${birdPhotoHistoryThumbsHtml(bird.id, historySelectMode, selectedHistoryIds)}
        </div>
        ${!historySelectMode && STATE.birdPhotos.filter(p => p.bird_id === bird.id).length > 1 ? `<button class="btn ghost small" id="viewTimelineBtn" style="margin-top:8px">🕐 View timeline</button>` : ""}
      </div>
      `}

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px">
        <div>
          <label class="field"><span>Card color</span><input type="color" id="f_color" value="${esc(f.card_color || "#5A4B3C")}" style="width:60px;height:38px;padding:2px;cursor:pointer"></label>
          ${f.card_color ? `<button class="btn ghost small" id="clearColor" style="margin-top:6px">Clear color</button>` : ""}
        </div>
        <label class="field"><span>Border style</span><select id="f_border_style">${["solid", "dashed", "dotted"].map(s => `<option value="${s}" ${(f.border_style || "solid") === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
        <label class="field"><span>Background</span><select id="f_pattern">${[["solid", "Solid tint"], ["gradient", "Gradient"], ["dots", "Dots"], ["stripes", "Stripes"]].map(([v, l]) => `<option value="${v}" ${(f.card_pattern || "solid") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>

      <div style="${FORM_SECTION_HEAD}">Identity</div>
      <div class="grid-form">
        <label class="field"><span>Name</span><input id="f_name" value="${esc(f.name)}" placeholder="e.g. Nugget"></label>
        <label class="field"><span>Breed</span><input id="f_breed" value="${esc(f.breed)}" placeholder="e.g. Rhode Island Red"></label>
        <label class="field"><span>Type</span><select id="f_type">${BIRD_TYPES.map(t => `<option ${f.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field"><span>Gender</span><select id="f_gender">${["", "Hen", "Rooster"].map(g => `<option value="${g}" ${(f.gender || "") === g ? "selected" : ""}>${g || "Unknown"}</option>`).join("")}</select></label>
      </div>

      <div style="${FORM_SECTION_HEAD}">Status & organization</div>
      <div class="grid-form">
        <label class="field"><span>Status</span><select id="f_status">${BIRD_STATUSES.map(s => `<option ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label class="field"><span>Location</span><select id="f_location"><option value="">(unspecified)</option>${getBeddingAreas().map(a => `<option value="${esc(a)}" ${f.location === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
        <label class="field"><span>Batch</span><input id="f_batch" value="${esc(f.batch_name || "")}" placeholder="(not in a batch)"></label>
      </div>

      <div style="${FORM_SECTION_HEAD}">Timeline</div>
      <div class="grid-form">
        <label class="field"><span>Hatch date</span><input type="date" id="f_hatch" value="${f.hatch_date || ""}"></label>
        <label class="field"><span>Acquired date</span><input type="date" id="f_acquired" value="${f.acquired_date || ""}"></label>
        ${showTarget ? `<label class="field"><span>Target harvest date</span><input type="date" id="f_target" value="${f.target_harvest_date || ""}"></label>` : ""}
        ${isEdit
          ? `<label class="field"><span>Acquisition cost${f.source_expense_id ? " (from its expense)" : ""}</span><input type="number" step="0.01" min="0" id="f_acq_cost" value="${f.acquisition_cost != null ? f.acquisition_cost : ""}" placeholder="e.g. 3.00"></label>`
          : `<label class="field"><span>Acquisition cost (optional)</span><input type="number" step="0.01" min="0" id="f_acq_cost" placeholder="e.g. 3.00"></label>`}
      </div>
      ${!isEdit ? `<div class="dim" style="font-size:11px;margin:-8px 0 0">Logged as a Birds/Chicks expense automatically. For a group, use "Add a batch" instead so the cost splits across everyone.</div>` : ""}

      ${showProcessed ? `
      <div style="${FORM_SECTION_HEAD}">🍗 Processing</div>
      <div class="grid-form">
        <label class="field"><span>Harvest date</span><input type="date" id="f_hdate" value="${f.harvest_date || ""}"></label>
        ${weightEntryFieldHtml("f_weight", f.harvest_weight, "Dressed Weight")}
        <label class="field"><span>Value per ${getWeightUnit()}</span><input type="number" step="0.01" id="f_price" value="${displayPricePerLb(f.price_per_lb)}" placeholder="e.g. 5.00"></label>
      </div>
      ` : ""}

      ${showLoss ? `
      <div style="${FORM_SECTION_HEAD}">Loss</div>
      <div class="grid-form">
        <label class="field"><span>Date of loss</span><input type="date" id="f_death_date" value="${f.death_date || ""}"></label>
        <label class="field"><span>Cause of loss</span><input id="f_death_cause" value="${esc(f.death_cause)}" placeholder="e.g. predator, illness"></label>
      </div>
      ` : ""}

      ${showSold ? `
      <div style="${FORM_SECTION_HEAD}">Sold</div>
      <div class="grid-form">
        <label class="field"><span>Date sold</span><input type="date" id="f_sold_date" value="${f.sold_date || ""}"></label>
        <label class="field"><span>Sold for</span><input type="number" step="0.01" min="0" id="f_sold_amount" value="${f.sold_amount != null ? f.sold_amount : ""}" placeholder="e.g. 25.00"></label>
      </div>
      <div class="dim" style="font-size:11px;margin:-8px 0 0">Counted in Value Produced and the income charts, same as meat processing -- see it on the Finance tab as a linked reference, tap it there to come straight back to this bird.</div>
      ` : ""}

      ${showRetired ? `
      <div style="${FORM_SECTION_HEAD}">Retired</div>
      <div class="grid-form">
        <label class="field"><span>Date retired</span><input type="date" id="f_retired_date" value="${f.retired_date || ""}"></label>
      </div>
      ` : ""}

      <div style="margin-top:12px"><label class="field"><span>Notes</span><textarea id="f_notes">${esc(f.notes)}</textarea></label></div>
      <div id="birdLogSection" style="margin-top:16px"></div>
      <div class="modal-actions"><button class="btn btn-confirm" id="saveBird">✓ Save</button></div>
    `;

    if (firstOpen) {
      openModal(html, () => { if (activeTab === "flock") renderFlockHub(); }, isEdit ? () => confirmAndDelete(
        "Delete this bird? This can't be undone.",
        () => localBirdDelete(bird.id, currentCoopId),
        "Bird deleted",
        refreshAndRender
      ) : null, null, "modal-panel-large");
    } else {
      refreshModalContent(html);
    }

    if (isEdit) renderBirdLogSection(bird.id);
    else document.getElementById("birdLogSection").innerHTML = `<div class="dim" style="font-size:12px">Save this bird first to start a health/notes log for it.</div>`;

    document.getElementById("photoPreview").addEventListener("click", (e) => {
      const url = e.target.dataset ? e.target.dataset.viewPhoto : null;
      if (!url) return;
      formState = readCurrentValues(); // capture every field now, before the lightbox (and possibly the crop modal after it) replaces this form's DOM
      showPhotoLightbox(url, {
        x: formState.photo_pos_x ?? 50, y: formState.photo_pos_y ?? 50, zoom: photoZoom(formState), aspectRatio: "1/1", closeAfterSave: false,
        onSave: async (x, y, zoom) => { formState.photo_pos_x = x; formState.photo_pos_y = y; formState.photo_zoom = zoom; render(false); },
      });
    });

    document.getElementById("f_type").addEventListener("change", (e) => {
      formState = readCurrentValues();
      formState.type = e.target.value;
      if (formState.type === "Layer") formState.target_harvest_date = "";
      render(false);
    });
    document.getElementById("f_status").addEventListener("change", (e) => { formState = readCurrentValues(); formState.status = e.target.value; render(false); });

    const photoInput = document.getElementById("f_photo");
    if (photoInput) photoInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        pendingPhotoBlob = await resizeImageFileToBlob(file);
        photoRemoved = false;
        previewUrl = URL.createObjectURL(pendingPhotoBlob);
        formState = readCurrentValues();
        formState.photo_pos_x = 50; // a freshly-picked photo has no meaningful prior crop
        formState.photo_pos_y = 50;
        render(false);
      } catch (err) {
        alert("Couldn't read that image: " + err.message);
      }
    });
    const addHistoryBtn = document.getElementById("addHistoryPhotoBtn");
    if (addHistoryBtn) addHistoryBtn.addEventListener("click", () => {
      formState = readCurrentValues();
      openAddHistoryPhotoModal(formState, () => render(true));
    });
    const startSelectBtn = document.getElementById("startHistorySelectBtn");
    if (startSelectBtn) startSelectBtn.addEventListener("click", () => {
      historySelectMode = true;
      selectedHistoryIds = new Set();
      formState = readCurrentValues();
      render(false);
    });
    const cancelSelectBtn = document.getElementById("cancelHistorySelectBtn");
    if (cancelSelectBtn) cancelSelectBtn.addEventListener("click", () => {
      historySelectMode = false;
      selectedHistoryIds = new Set();
      formState = readCurrentValues();
      render(false);
    });
    const deleteSelectedBtn = document.getElementById("deleteSelectedHistoryBtn");
    if (deleteSelectedBtn) deleteSelectedBtn.addEventListener("click", async () => {
      if (selectedHistoryIds.size === 0) return;
      const n = selectedHistoryIds.size;
      if (!(await showConfirmDialog(`Delete ${n} photo${n > 1 ? "s" : ""} from ${esc(formState.name) || "this bird"}'s history? This can't be undone.`))) return;
      const idsToDelete = [...selectedHistoryIds];
      const deletedPhotos = STATE.birdPhotos.filter(p => idsToDelete.includes(p.id));
      await localBulkDelete("bird_photos", idsToDelete, currentCoopId);
      STATE.birdPhotos = await localGetAll("bird_photos", currentCoopId);
      // If the entry currently linked as the main photo is among the ones
      // just deleted, clear that link too -- same reasoning as the
      // single-photo delete: nothing left to point at. Also a direct
      // safety net for an empty history in general: however the two might
      // have gotten out of sync, a bird with zero live history entries
      // shouldn't be left with a main photo still pointing at something.
      const currentBird = STATE.birds.find(b => b.id === bird.id);
      const linkedId = currentBird?.main_bird_photo_id;
      const noEntriesLeft = !STATE.birdPhotos.some(p => p.bird_id === bird.id);
      const linkWasDeleted = currentBird && (
        linkedId ? idsToDelete.includes(linkedId)
        : deletedPhotos.some(p => p.photo && currentBird.photo && p.photo === currentBird.photo)
      );
      if (linkWasDeleted || noEntriesLeft) {
        await localBirdUpdate(bird.id, { photo: null, main_bird_photo_id: null });
        await clearPendingPhoto(bird.id);
        await refreshPendingPhotoUrls();
      }
      STATE.birds = await localGetAll("birds", currentCoopId);
      showToast(`${n} photo${n > 1 ? "s" : ""} deleted`, "delete");
      historySelectMode = false;
      selectedHistoryIds = new Set();
      render(true);
    });
    document.querySelectorAll("[data-history-photo]").forEach(el => el.addEventListener("click", () => {
      if (historySelectMode) {
        const id = el.dataset.historyPhoto;
        if (selectedHistoryIds.has(id)) selectedHistoryIds.delete(id);
        else selectedHistoryIds.add(id);
        formState = readCurrentValues();
        render(false);
        return;
      }
      formState = readCurrentValues();
      const photo = STATE.birdPhotos.find(p => p.id === el.dataset.historyPhoto);
      openHistoryPhotoOptionsModal(photo, formState, () => render(true));
    }));
    const viewTimelineBtn = document.getElementById("viewTimelineBtn");
    if (viewTimelineBtn) viewTimelineBtn.addEventListener("click", () => {
      formState = readCurrentValues();
      openBirdTimelineModal(formState, () => render(true));
    });
    const clearColorBtn = document.getElementById("clearColor");
    if (clearColorBtn) clearColorBtn.addEventListener("click", () => {
      formState = readCurrentValues();
      formState.card_color = "";
      render(false);
    });

    document.getElementById("saveBird").addEventListener("click", async () => {
      const current = readCurrentValues();
      const payload = {
        coop_id: currentCoopId,
        name: current.name.trim(),
        breed: current.breed,
        type: current.type,
        gender: current.gender || null,
        photo_pos_x: current.photo_pos_x ?? 50,
        photo_pos_y: current.photo_pos_y ?? 50,
        photo_zoom: current.photo_zoom ?? 1,
        status: current.status,
        hatch_date: current.hatch_date,
        acquired_date: current.acquired_date,
        target_harvest_date: current.target_harvest_date,
        harvest_date: current.harvest_date,
        harvest_weight: current.harvest_weight ? Number(current.harvest_weight) : null,
        price_per_lb: current.price_per_lb ? Number(current.price_per_lb) : null,
        death_date: current.death_date,
        death_cause: current.death_cause,
        card_color: current.card_color || null,
        border_style: current.border_style || null,
        card_pattern: current.card_pattern || null,
        location: current.location || null,
        batch_name: (current.batch_name || "").trim() || null,
        notes: current.notes,
        acquisition_cost: current.acquisition_cost,
        source_expense_id: isEdit ? bird.source_expense_id : null,
        sold_date: current.sold_date,
        sold_amount: current.sold_amount,
        retired_date: current.retired_date,
      };
      if (!payload.name) return;
      let birdId = isEdit ? bird.id : null;
      if (isEdit) {
        await localBirdUpdate(birdId, payload);
      } else {
        // A price entered on a brand-new bird logs its own Birds/Chicks
        // expense automatically -- same idea as the batch form, just for
        // one bird. Editing an existing bird never does this (see above),
        // so correcting a typo later can't spawn a duplicate expense.
        if (payload.acquisition_cost > 0) {
          const expense = await localExpenseCreate({
            coop_id: currentCoopId, date: payload.acquired_date || todayStr(), category: "Birds/Chicks",
            description: payload.name, amount: payload.acquisition_cost, entry_type: "expense",
          }, { suppressUndo: true });
          payload.source_expense_id = expense.id;
        }
        const created = await localBirdCreate(payload);
        birdId = created.id;
      }
      if (pendingPhotoBlob) {
        // Queued locally, not uploaded directly -- works the same whether
        // online or off. It uploads as soon as a connection is available
        // (right away if we already have one), same timing as everything
        // else in the outbox.
        await queuePendingPhoto(birdId, pendingPhotoBlob);
        trySyncSoon("birds", currentCoopId);
      } else if (photoRemoved && isEdit) {
        // Clearing the reference locally works offline immediately; the
        // orphaned file on the server gets cleaned up next time this bird's
        // update actually reaches it. Not worth a whole separate removal
        // queue for how rarely this happens. suppressUndo since the save
        // just above already pushed one undo entry for this edit -- a
        // second one here would look like two separate actions for what
        // was one save. (Undo won't restore a removed photo either way,
        // since photos are separately-queued blobs, not part of the JSON
        // snapshot undo operates on.)
        await localBirdUpdate(birdId, { photo: null }, { suppressUndo: true });
      }
      await refreshPendingPhotoUrls();
      showToast(isEdit ? `${payload.name} updated` : `${payload.name} added`, isEdit ? "update" : "create");
      closeModal();
      refreshAndRender();
    });
  }

  render(true);
}

function showBulkForm() {
  const today = todayStr();
  const defaultHatch = addDays(today, -7); // chicks are typically ~1 week old at pickup; adjust if known exactly
  const defaultTarget = addDays(defaultHatch, 42);
  const html = `
    <div class="form-head">Add a batch</div>
    <div class="grid-form">
      <label class="field"><span>How many birds</span><input type="number" id="k_count" min="1" max="200" value="25"></label>
      <label class="field"><span>Batch name</span><input id="k_batch" placeholder="e.g. July Cornish Cross"></label>
      <label class="field"><span>Type</span><select id="k_type">${BIRD_TYPES.map(t => `<option ${t === "Meat" ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="field"><span>Breed</span><input id="k_breed" placeholder="e.g. Cornish Cross"></label>
      <label class="field"><span>Hatch date</span><input type="date" id="k_hatch" value="${defaultHatch}"></label>
      <label class="field"><span>Acquired date</span><input type="date" id="k_acquired" value="${today}"></label>
      <label class="field"><span>Target harvest date</span><input type="date" id="k_target" value="${defaultTarget}"></label>
      <label class="field"><span>Total price for the batch (optional)</span><input type="number" step="0.01" min="0" id="k_price" placeholder="e.g. 75.00"></label>
    </div>
    <div class="note-box" style="margin-top:10px">Each bird gets its own record — named "Batch name #1", "#2", and so on — so you can still log an individual dressed weight for each one at processing time. This just saves you from typing the shared details over and over. Hatch date defaults to a week before pickup (typical for chick delivery) — adjust it if the hatchery told you the actual date. Target harvest defaults to 6 weeks from hatch (ignored for Layer, which has no harvest date) — adjust it if your breed runs longer. A total price is split evenly across the batch and logged as one Birds/Chicks expense -- each bird then carries its own share, so meat birds' cost per lb includes what they cost to start, not just what they ate.</div>
    <div style="margin-top:12px"><label class="field"><span>Notes</span><textarea id="k_notes" placeholder="optional"></textarea></label></div>
    <div style="margin-top:12px"><label class="field"><span>Group photo (optional, applied to every bird in the batch)</span><input type="file" id="k_photo" accept="image/*"></label></div>
    <div class="modal-actions"><button class="btn btn-confirm" id="saveBulk">✓ Create batch</button></div>
  `;
  openModal(html);
  let targetTouched = false;
  document.getElementById("k_hatch").addEventListener("change", (e) => {
    if (!targetTouched) document.getElementById("k_target").value = addDays(e.target.value, 42);
  });
  document.getElementById("k_target").addEventListener("input", () => { targetTouched = true; });
  document.getElementById("saveBulk").addEventListener("click", async () => {
    const count = Number(document.getElementById("k_count").value);
    if (!count || count < 1) return;
    if (count > 200) { alert("That's a lot of birds for one batch — try 200 or fewer at a time"); return; }
    const batchName = document.getElementById("k_batch").value.trim() || `Batch ${todayStr()}`;
    const type = document.getElementById("k_type").value;
    const acquiredDate = document.getElementById("k_acquired").value;
    // A total price is split evenly across the batch and logged as one
    // Birds/Chicks expense -- mirrors how buying a bag of feed auto-creates
    // its own linked inventory item. Each bird keeps its own share
    // (source_expense_id points back to it) so meat birds' cost per lb can
    // include what they cost to start, not just what they ate, and so a
    // partially-processed batch only counts the share of the birds actually
    // turned into meat so far.
    const totalPrice = Number(document.getElementById("k_price").value) || 0;
    let sourceExpenseId = null, perBirdCost = null;
    if (totalPrice > 0) {
      const expense = await localExpenseCreate({
        coop_id: currentCoopId, date: acquiredDate, category: "Birds/Chicks",
        description: `${batchName} (${count} birds)`, amount: totalPrice, entry_type: "expense",
      }, { suppressUndo: true });
      sourceExpenseId = expense.id;
      perBirdCost = totalPrice / count;
    }
    const shared = {
      coop_id: currentCoopId,
      breed: document.getElementById("k_breed").value,
      type,
      status: "Active",
      hatch_date: document.getElementById("k_hatch").value,
      acquired_date: acquiredDate,
      target_harvest_date: type === "Layer" ? null : document.getElementById("k_target").value,
      batch_name: batchName,
      notes: document.getElementById("k_notes").value,
      acquisition_cost: perBirdCost,
      source_expense_id: sourceExpenseId,
    };
    const created = await localBulkCreate("birds", Array.from({ length: count }, (_, i) => ({ ...shared, name: `${batchName}-${i + 1}` })));
    const photoFile = document.getElementById("k_photo").files[0];
    if (photoFile) {
      const blob = await resizeImageFileToBlob(photoFile);
      try {
        // One upload, shared by the whole batch -- a group of 25 birds
        // with the same photo used to mean 25 separate copies of the
        // identical image on the server.
        const result = await apiUploadPhoto(created[0].id, blob, "birds");
        await localBulkUpdate("birds", created.map(b => ({ id: b.id, fields: { photo: result.photo } })), currentCoopId, { suppressUndo: true });
        STATE.birds = await localGetAll("birds", currentCoopId);
      } catch (err) {
        // Offline (or local-only, with no server to share a reference
        // against at all) -- fall back to each bird queueing its own copy
        // of the blob, so this still works without a connection.
        await Promise.all(created.map(b => queuePendingPhoto(b.id, blob)));
        trySyncSoon("birds", currentCoopId);
      }
    }
    showToast(`${count} bird batch added`, "create");
    closeModal();
    refreshAndRender();
  });
}

