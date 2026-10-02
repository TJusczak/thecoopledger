// Eggs and hatching.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= EGGS =================
function eggCartonHtml(count) {
  const shown = Math.min(count, 60);
  const dozens = Math.floor(shown / 12);
  const remainder = shown % 12;
  const cartons = [];
  for (let i = 0; i < dozens; i++) cartons.push(12);
  if (remainder > 0) cartons.push(remainder);
  if (cartons.length === 0) return "";
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
    ${cartons.map(n => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--surface-raised);line-height:1.4;font-size:16px">
        <div>${"🥚".repeat(Math.min(n, 6))}</div>
        ${n > 6 ? `<div>${"🥚".repeat(n - 6)}</div>` : ""}
      </div>`).join("")}
    ${count > 60 ? `<div class="dim" style="font-size:11px;align-self:center">+${count - 60} more</div>` : ""}
  </div>`;
}

let eggsSubTab = "eggs";
function renderEggsHub() {
  const el = document.getElementById("panel-eggs");
  const subs = [{ id: "eggs", label: "Eggs" }, { id: "hatching", label: "Hatching" }];
  el.innerHTML = `
    <div class="range-select sub-nav-fixed" id="eggsSubNav">
      ${subs.map(s => `<button class="range-btn ${eggsSubTab === s.id ? "active" : ""}" data-eggssub="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div id="eggsSubContent"></div>
  `;
  el.querySelectorAll("[data-eggssub]").forEach(b => b.addEventListener("click", () => { eggsSubTab = b.dataset.eggssub; renderEggsHub(); }));
  if (eggsSubTab === "eggs") renderEggsMain();
  else if (eggsSubTab === "hatching") renderHatching();
}

/** Standard chicken incubation is 21 days. Phase boundaries here reflect the
 * real process: eggs get turned regularly through day 17 ("setting"), with
 * candling checks around day 7 (spot infertile/"clear" eggs) and day 14
 * (spot "quitters" -- eggs that started developing but died). Day 18 is
 * "lockdown": turning stops, humidity rises, and eggs are left undisturbed
 * through hatch day. Chicks can take a bit longer than exactly 21 days, so
 * day 22+ reads as "overdue" rather than alarming. */
function hatchDayInfo(dateStarted) {
  const daysIn = daysSince(dateStarted);
  const candle1Date = addDays(dateStarted, 7);
  const candle2Date = addDays(dateStarted, 14);
  const lockdownDate = addDays(dateStarted, 18);
  const expectedHatchDate = addDays(dateStarted, 21);
  let phase, tone, milestone;
  if (daysIn < 0) { phase = "Not started yet"; tone = "slate"; }
  else if (daysIn === 0) { phase = "Just set"; tone = "slate"; milestone = `Candling #1 due ${fmtDate(candle1Date)}`; }
  else if (daysIn < 7) { phase = "Incubating — turn eggs regularly"; tone = "slate"; milestone = `Candling #1 due ${fmtDate(candle1Date)}`; }
  else if (daysIn === 7) { phase = "🔦 Candle today — check for fertility"; tone = "gold"; }
  else if (daysIn < 14) { phase = "Incubating — developing"; tone = "slate"; milestone = `Candling #2 due ${fmtDate(candle2Date)}`; }
  else if (daysIn === 14) { phase = "🔦 Candle today — check for quitters"; tone = "gold"; }
  else if (daysIn < 18) { phase = "Incubating — developing"; tone = "slate"; milestone = `Lockdown starts ${fmtDate(lockdownDate)}`; }
  else if (daysIn < 21) { phase = "🔒 Lockdown — stop turning, raise humidity"; tone = "rust"; milestone = `Hatch day ${fmtDate(expectedHatchDate)}`; }
  else if (daysIn === 21) { phase = "🐣 Hatch day!"; tone = "danger"; }
  else { phase = `Overdue ${daysIn - 21}d — some chicks take a little longer than 21 days`; tone = "danger"; }
  return { daysIn, phase, tone, milestone, candle1Date, candle2Date, lockdownDate, expectedHatchDate };
}

/** Which milestone (candling #1/#2, lockdown, hatch day) is next for a
 * clutch, and whether it's today, upcoming, or overdue -- built for the
 * dashboard alerts list, which needs a single clear "what's next" per
 * clutch rather than hatchDayInfo's fuller phase/tone description. */
function hatchNextEventInfo(dateStarted) {
  const { daysIn } = hatchDayInfo(dateStarted);
  const events = [
    { day: 7, label: "Candling #1" },
    { day: 14, label: "Candling #2" },
    { day: 18, label: "Lockdown" },
    { day: 21, label: "Hatch day" },
  ];
  if (daysIn > 21) return { overdue: true, daysOverdue: daysIn - 21 };
  const today = events.find(e => e.day === daysIn);
  if (today) return { isToday: true, label: today.label };
  const next = events.find(e => e.day > daysIn);
  return { daysUntil: next.day - daysIn, label: next.label };
}

/** A horizontal timeline bar spanning the 21-day incubation window, shaded
 * by phase (setting / lockdown / hatch), with a white arrow pointing at
 * today's exact position. Milestone labels are positioned at their true
 * day/21 proportion -- NOT evenly spaced -- so a label always lines up
 * with where the marker actually sits when today matches that day. */
function hatchTimelineBarHtml(dateStarted) {
  const daysIn = Math.max(0, Math.min(22, daysSince(dateStarted)));
  const milestones = [
    { day: 0, label: "Day 0" },
    { day: 7, label: "Candle d7" },
    { day: 14, label: "Candle d14" },
    { day: 18, label: "Lockdown d18" },
    { day: 21, label: "Hatch d21" },
  ];
  // Clamped, always centered -- the line, arrow, and every label share this
  // exact same function, so whatever width each one happens to have, they
  // still land on the identical point rather than diverging based on their
  // own width (which is what pinning-without-centering at the edges used to do).
  const clampedPct = (day) => Math.max(3, Math.min(97, (day / 21) * 100));
  const posStyle = (day) => `left:${clampedPct(day)}%;transform:translateX(-50%)`;
  return `
    <div style="position:relative;margin:20px 0 4px">
      <div style="position:absolute;${posStyle(daysIn)};top:-14px;font-size:13px;color:#fff;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,0.6)">▼</div>
      <div style="position:relative;height:20px;border-radius:6px;overflow:hidden;background:linear-gradient(to right, var(--sage) 0%, var(--sage) 85.7%, var(--gold) 85.7%, var(--gold) 95.2%, var(--danger) 95.2%, var(--danger) 100%)">
        <div style="position:absolute;top:0;bottom:0;left:${clampedPct(daysIn)}%;width:2px;background:#fff;box-shadow:0 0 0 1px var(--bg)"></div>
      </div>
      <div style="position:relative;height:13px;margin-top:2px">
        ${milestones.map(m => `<span style="position:absolute;${posStyle(m.day)};font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap">${m.label}</span>`).join("")}
      </div>
    </div>`;
}

let editingHatchId = null;

/** Background color for one egg tile -- pink/blue only for a live outcome
 * (still incubating or hatched); Clear/Quit/Failed use a flat grey
 * regardless of gender, since those outcomes aren't about gender at all. */
function eggTileColor(egg) {
  if (egg.status === "Clear" || egg.status === "Quit" || egg.status === "Failed to Hatch") return "var(--surface-raised)";
  if (egg.gender === "Hen") return "#C97B94";
  if (egg.gender === "Rooster") return "#5E85A8";
  return "var(--surface-raised)";
}
function eggTileIcon(egg) {
  if (egg.status === "Hatched") return "🐣";
  if (egg.status === "Clear") return "✖️";
  if (egg.status === "Quit") return "❌";
  if (egg.status === "Failed to Hatch") return "🪦";
  return "🥚";
}
function eggTileHtml(egg) {
  const named = !!egg.bird_id;
  return `<button type="button" class="egg-tile" data-egg="${egg.id}" title="Egg #${egg.position} -- ${esc(egg.status)}${egg.gender ? ` · ${egg.gender}` : ""}" style="background:${eggTileColor(egg)};${named ? "box-shadow:0 0 0 2px var(--gold);" : ""}">${eggTileIcon(egg)}</button>`;
}
/** The full grid for one clutch, sorted by position so numbering stays stable. */
function eggGridHtml(hatchId) {
  const eggs = STATE.hatchEggs.filter(e => e.hatch_id === hatchId).sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  if (eggs.length === 0) return "";
  return `<div class="egg-grid">${eggs.map(eggTileHtml).join("")}</div>`;
}

const HATCH_EGG_STATUSES = ["Incubating", "Hatched", "Clear", "Quit", "Failed to Hatch"];

function hatchEggFormHtml(egg, hatch) {
  const bird = egg.bird_id ? STATE.birds.find(b => b.id === egg.bird_id) : null;
  const needsNaming = egg.status === "Hatched" && !bird && !egg.tracked_externally;
  const showResolvedDate = egg.status !== "Incubating";
  return `
    <div class="form-head">Egg #${egg.position}</div>
    <div class="grid-form">
      <label class="field"><span>Status</span><select id="eg_status">${HATCH_EGG_STATUSES.map(s => `<option ${egg.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field"><span>Gender</span><select id="eg_gender">${["", "Hen", "Rooster"].map(g => `<option value="${g}" ${(egg.gender || "") === g ? "selected" : ""}>${g || "Unknown"}</option>`).join("")}</select></label>
      ${showResolvedDate ? `<label class="field"><span>Date</span><input type="date" id="eg_resolved_date" value="${egg.resolved_date || todayStr()}"></label>` : ""}
    </div>
    <div class="dim" style="font-size:11px;margin-top:6px">Gender is usually only knowable once hatched (or right at hatch for autosexing breeds) -- set it whenever you actually know it.${showResolvedDate ? " The date is when this was actually decided -- not the clutch's start date -- so monthly/yearly hatching stats land in the right period." : ""}</div>

    ${bird ? `
      <div class="note-box" style="margin-top:12px">Already in the flock as <strong style="color:var(--text)">${esc(bird.name)}</strong> -- edit that bird directly from the Flock tab for anything beyond gender here.</div>
    ` : egg.tracked_externally ? `
      <div class="note-box" style="margin-top:12px">Marked as tracked elsewhere -- no flock record here by choice.</div>
    ` : ""}

    ${needsNaming ? `
      <div class="form-block" style="margin-top:12px;border-color:var(--sage)">
        <div class="form-head" style="font-size:13px">🐣 Add to flock</div>
        <div class="grid-form">
          <label class="field"><span>Name</span><input id="eg_name" placeholder="e.g. Nugget"></label>
          <label class="field"><span>Type</span><select id="eg_type">${BIRD_TYPES.map(t => `<option ${t === "Layer" ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        </div>
        <div class="dim" style="font-size:11px;margin-top:6px">Gender carries over from above. Breed (${esc(hatch.breed) || "Mixed"}), hatch date, and acquired date (all ${fmtDate(todayStr())}) carry over automatically -- add a photo or anything else later from the Flock tab.</div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-confirm small" id="saveChickFromEgg">+ Add to flock</button>
          <button class="btn ghost small" id="skipChickFromEgg" title="Mark as tracked without creating a flock record">Already tracked elsewhere</button>
        </div>
      </div>
    ` : ""}

    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveHatchEgg">✓ Save</button>
    </div>
  `;
}

function openHatchEggModal(egg, hatch) {
  openModal(
    hatchEggFormHtml(egg, hatch),
    null,
    () => confirmAndDelete(
      `Delete egg #${egg.position} from this clutch? This can't be undone.`,
      () => localBulkDelete("hatch_eggs", [egg.id], currentCoopId),
      "Egg deleted",
      async () => { STATE.hatchEggs = await localGetAll("hatch_eggs", currentCoopId); renderHatching(); }
    )
  );
  wireHatchEggModal(egg, hatch);
}

function wireHatchEggModal(egg, hatch) {
  // Status/gender changes re-render the modal body against a draft (not yet
  // saved) version of the egg, so "Add to flock" appears the moment you
  // pick "Hatched" rather than only reflecting whatever was last saved.
  const rewireLive = () => {
    const statusEl = document.getElementById("eg_status");
    const genderEl = document.getElementById("eg_gender");
    if (statusEl) statusEl.addEventListener("change", () => {
      const draft = { ...egg, status: statusEl.value, gender: genderEl.value || null };
      refreshModalContent(hatchEggFormHtml(draft, hatch));
      wireHatchEggModal(egg, hatch);
    });
    if (genderEl) genderEl.addEventListener("change", () => {
      const draft = { ...egg, status: statusEl.value, gender: genderEl.value || null };
      refreshModalContent(hatchEggFormHtml(draft, hatch));
      wireHatchEggModal(egg, hatch);
    });
  };
  rewireLive();
  document.getElementById("saveHatchEgg").addEventListener("click", async () => {
    const status = document.getElementById("eg_status").value;
    const gender = document.getElementById("eg_gender").value || null;
    const resolvedDateEl = document.getElementById("eg_resolved_date");
    const resolved_date = status === "Incubating" ? null : (resolvedDateEl ? resolvedDateEl.value : (egg.resolved_date || todayStr()));
    await localHatchEggUpdate(egg.id, { status, gender, resolved_date });
    showToast("Egg updated", "update");
    closeModal();
    STATE.hatchEggs = await localGetAll("hatch_eggs", currentCoopId);
    renderHatching();
  });
  const saveChickBtn = document.getElementById("saveChickFromEgg");
  if (saveChickBtn) saveChickBtn.addEventListener("click", async () => {
    const name = document.getElementById("eg_name").value.trim();
    if (!name) return;
    const status = document.getElementById("eg_status").value;
    const gender = document.getElementById("eg_gender").value || null;
    const type = document.getElementById("eg_type").value;
    const today = todayStr();
    const resolvedDateEl = document.getElementById("eg_resolved_date");
    const resolved_date = resolvedDateEl ? resolvedDateEl.value : today;
    const createdBird = await localBirdCreate({ coop_id: currentCoopId, name, breed: hatch.breed || "", type, gender, status: "Active", hatch_date: today, acquired_date: today, hatch_id: hatch.id }, { suppressUndo: true });
    const updatedEgg = await localHatchEggUpdate(egg.id, { status, gender, bird_id: createdBird.id, resolved_date }, { suppressUndo: true });
    pushUndoAction(`Added bird "${name}" from clutch`, [
      { resource: "birds", id: createdBird.id, before: null, after: createdBird },
      { resource: "hatch_eggs", id: egg.id, before: egg, after: updatedEgg },
    ]);
    showToast(`${name} added to the flock`, "create");
    closeModal();
    STATE.birds = await localGetAll("birds", currentCoopId);
    STATE.hatchEggs = await localGetAll("hatch_eggs", currentCoopId);
    renderHatching();
  });
  const skipBtn = document.getElementById("skipChickFromEgg");
  if (skipBtn) skipBtn.addEventListener("click", async () => {
    const status = document.getElementById("eg_status").value;
    const gender = document.getElementById("eg_gender").value || null;
    await localHatchEggUpdate(egg.id, { status, gender, tracked_externally: 1 });
    showToast("Marked as tracked elsewhere", "update");
    closeModal();
    STATE.hatchEggs = await localGetAll("hatch_eggs", currentCoopId);
    renderHatching();
  });
}

function renderHatching() {
  const el = document.getElementById("eggsSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const active = STATE.hatches.filter(h => h.status !== "Complete").sort((a, b) => a.date_started.localeCompare(b.date_started));
  const complete = STATE.hatches.filter(h => h.status === "Complete").sort((a, b) => b.date_started.localeCompare(a.date_started));

  const clutchCardHtml = (h) => {
    const info = hatchDayInfo(h.date_started);
    const eggs = STATE.hatchEggs.filter(e => e.hatch_id === h.id);
    const hatchedCount = eggs.filter(e => e.status === "Hatched").length;
    const clearCount = eggs.filter(e => e.status === "Clear").length;
    const quitCount = eggs.filter(e => e.status === "Quit").length;
    const failedCount = eggs.filter(e => e.status === "Failed to Hatch").length;
    const incubatingCount = eggs.filter(e => e.status === "Incubating").length;
    const pendingToName = eggs.filter(e => e.status === "Hatched" && !e.bird_id && !e.tracked_externally).length;
    const allAccountedFor = incubatingCount === 0 && eggs.length > 0;
    const isComplete = h.status === "Complete";
    return `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title" style="margin-bottom:2px">${esc(h.breed) || "Mixed"} · ${h.egg_count} egg${h.egg_count !== 1 ? "s" : ""}</div>
          <div class="dim" style="font-size:12px">Set ${fmtDate(h.date_started)}${!isComplete ? ` · Day ${info.daysIn} · expected hatch ${fmtDate(info.expectedHatchDate)}` : ""}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="icon-btn" data-edit-hatch="${h.id}">✎</button>
          <button class="icon-btn" data-del-hatch="${h.id}">🗑</button>
        </div>
      </div>

      ${!isComplete ? `
        ${hatchTimelineBarHtml(h.date_started)}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          <span class="stamp tone-${info.tone}">${info.phase}</span>
          ${info.milestone ? `<span class="stamp tone-slate">${info.milestone}</span>` : ""}
        </div>
        <div class="dim" style="font-size:10px;margin-top:6px">Candling: ${fmtDate(info.candle1Date)} &amp; ${fmtDate(info.candle2Date)} · Lockdown: ${fmtDate(info.lockdownDate)} · Hatch: ${fmtDate(info.expectedHatchDate)}</div>
      ` : `<div class="stamp tone-sage" style="margin-top:8px">Complete</div>`}

      ${eggGridHtml(h.id)}
      <div class="dim" style="font-size:10.5px;margin-top:8px">🥚 incubating · 🐣 hatched (gold ring once in the flock) · ✖️ clear · ❌ quit · 🪦 failed to hatch — pink or blue once gender's known. Tap an egg to update it.</div>

      <div class="dim" style="font-size:11px;margin-top:10px">${hatchedCount} hatched · ${clearCount} clear · ${quitCount} quit · ${failedCount} failed to hatch · ${incubatingCount} still incubating${pendingToName > 0 ? ` · ${pendingToName} waiting to be named` : ""}</div>
      ${allAccountedFor && !isComplete ? `<button class="btn ghost small" data-complete-hatch="${h.id}" style="margin-top:6px">✓ Mark clutch complete</button>` : ""}
      ${(() => {
        const chicks = STATE.birds.filter(b => b.hatch_id === h.id).sort((a, b) => (a.hatch_date || "").localeCompare(b.hatch_date || ""));
        if (chicks.length === 0) return "";
        return `<div class="dim" style="font-size:11px;margin-top:8px">${chicks.map(c => `${esc(c.name)} (${fmtDate(c.hatch_date)})`).join(", ")}</div>`;
      })()}
      ${h.notes ? `<div class="dim" style="font-size:12px;margin-top:8px">${esc(h.notes)}</div>` : ""}
    </div>`;
  };

  el.innerHTML = `
    <div class="toolbar" style="margin-bottom:12px">
      <div class="dim">${active.length} active clutch${active.length !== 1 ? "es" : ""}</div>
      <button class="btn" id="toggleHatchForm">+ Start a clutch</button>
    </div>

    ${active.length === 0 && complete.length === 0 ? `<div class="card"><div class="empty">No clutches yet -- start one when you set eggs in the incubator.</div></div>` : ""}
    ${active.map(clutchCardHtml).join("")}
    ${complete.length > 0 ? `<div class="flock-section-header" style="margin-top:18px">Completed</div>${complete.map(clutchCardHtml).join("")}` : ""}
  `;

  document.getElementById("toggleHatchForm").addEventListener("click", () => openHatchModal(null));
  el.querySelectorAll("[data-edit-hatch]").forEach(b => b.addEventListener("click", () => openHatchModal(STATE.hatches.find(h => h.id === b.dataset.editHatch))));
  el.querySelectorAll("[data-del-hatch]").forEach(b => b.addEventListener("click", async () => {
    if (!(await showConfirmDialog("Delete this clutch and its tracked outcomes? This can't be undone."))) return;
    await localHatchDelete(b.dataset.delHatch, currentCoopId);
    STATE.hatches = await localGetAll("hatches", currentCoopId);
    showToast("Clutch deleted", "delete");
    renderHatching();
  }));
  el.querySelectorAll("[data-complete-hatch]").forEach(b => b.addEventListener("click", async () => {
    await localHatchUpdate(b.dataset.completeHatch, { status: "Complete" });
    STATE.hatches = await localGetAll("hatches", currentCoopId);
    renderHatching();
  }));
  el.querySelectorAll("[data-egg]").forEach(tile => tile.addEventListener("click", () => {
    const egg = STATE.hatchEggs.find(e => e.id === tile.dataset.egg);
    const hatch = STATE.hatches.find(h => h.id === egg.hatch_id);
    if (egg && hatch) openHatchEggModal(egg, hatch);
  }));
}

function hatchFormHtml(editing) {
  return `
    <div class="form-head">${editing ? "Edit clutch" : "Start a new clutch"}</div>
    <div class="grid-form">
      <label class="field"><span>Breed</span><input id="h_breed" placeholder="e.g. Rhode Island Red, or leave blank for mixed" value="${editing ? esc(editing.breed || "") : ""}"></label>
      <label class="field"><span>Date started</span><input type="date" id="h_date" value="${editing ? editing.date_started : todayStr()}"></label>
      <label class="field"><span>Number of eggs</span><input type="number" min="1" step="1" id="h_count" value="${editing ? editing.egg_count : ""}" placeholder="e.g. 12"></label>
    </div>
    <label class="field" style="margin-top:12px"><span>Notes</span><input id="h_notes" placeholder="optional" value="${editing ? esc(editing.notes || "") : ""}"></label>
    <div class="note-box" style="margin-top:10px">Expected hatch date is day 21 from when the eggs went in -- the timeline below each clutch tracks it automatically, including candling and lockdown reminders.</div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveHatch">${editing ? "✓ Save changes" : "+ Start clutch"}</button>
    </div>
  `;
}

function openHatchModal(editing) {
  editingHatchId = editing ? editing.id : null;
  openModal(
    hatchFormHtml(editing),
    () => { editingHatchId = null; },
    editing ? () => confirmAndDelete(
      "Delete this clutch and its tracked outcomes? This can't be undone.",
      () => localHatchDelete(editing.id, currentCoopId),
      "Clutch deleted",
      async () => { STATE.hatches = await localGetAll("hatches", currentCoopId); renderHatching(); }
    ) : null
  );
  document.getElementById("saveHatch").addEventListener("click", async () => {
    const breed = document.getElementById("h_breed").value.trim();
    const date_started = document.getElementById("h_date").value;
    const egg_count = Number(document.getElementById("h_count").value) || 0;
    const notes = document.getElementById("h_notes").value.trim();
    if (!date_started || egg_count <= 0) return;
    const payload = { coop_id: currentCoopId, breed, date_started, egg_count, notes };
    if (editing) {
      const oldCount = Number(editing.egg_count) || 0;
      await localHatchUpdate(editing.id, payload);
      if (egg_count !== oldCount) {
        const existingEggs = STATE.hatchEggs.filter(e => e.hatch_id === editing.id).sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
        if (egg_count > oldCount) {
          const toAdd = [];
          for (let p = existingEggs.length + 1; p <= egg_count; p++) toAdd.push({ coop_id: currentCoopId, hatch_id: editing.id, position: p, status: "Incubating", gender: null, bird_id: null });
          if (toAdd.length) await localBulkCreate("hatch_eggs", toAdd, { suppressUndo: true });
        } else {
          const removable = existingEggs.filter(e => e.status === "Incubating").slice(-(oldCount - egg_count));
          if (removable.length < oldCount - egg_count) {
            showToast(`Only removed ${removable.length} still-incubating egg${removable.length !== 1 ? "s" : ""} -- the rest already have a tracked outcome`, "update");
          }
          if (removable.length) await localBulkDelete("hatch_eggs", removable.map(e => e.id), currentCoopId, { suppressUndo: true });
        }
        STATE.hatchEggs = await localGetAll("hatch_eggs", currentCoopId);
      }
      showToast("Clutch updated", "update");
    } else {
      const created = await localHatchCreate({ ...payload, hatched_count: 0, named_count: 0, clear_count: 0, quit_count: 0, failed_count: 0, status: "Incubating" });
      await ensureHatchEggsExist(created);
      showToast("Clutch started", "create");
    }
    closeModal();
    STATE.hatches = await localGetAll("hatches", currentCoopId);
    renderHatching();
  });
}

function renderEggsMain() {
  const el = document.getElementById("eggsSubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const years = yearsFromDates(STATE.eggs, "date");
  const filtered = STATE.eggs.filter(e => !eggFilters.year || e.date.slice(0, 4) === eggFilters.year);
  const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date));
  el.innerHTML = `
    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${sorted.length} of ${STATE.eggs.length} shown</div>
      <div style="display:flex;gap:8px">
        ${years.length > 0 ? `<button class="btn ghost small" id="toggleEggFilters">Filters${eggFilters.year ? " (1)" : ""} ${eggFiltersOpen ? "▾" : "▸"}</button>` : ""}
        ${selectModeButtonHtml("eggs", "toggleEggSelectMode")}
        <button class="btn" id="toggleEggForm">+ Add entry</button>
      </div>
    </div>

    ${bulkDeleteBarHtml(selectedEggIds)}

    ${eggFiltersOpen && years.length > 0 ? `
    <div class="form-block" style="padding:12px 16px">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <label class="field"><span>Year</span><select id="filterEggYear"><option value="">All years</option>${years.map(y => `<option value="${y}" ${eggFilters.year === y ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      </div>
    </div>
    ` : ""}

    ${sorted.length > 0 ? (() => {
      const totalCount = sorted.reduce((s, e) => s + (Number(e.count) || 0), 0);
      const totalValue = sorted.reduce((s, e) => s + (Number(e.count) || 0) * (Number(e.price_per_egg) || 0), 0);
      return `<div class="note-box" style="margin-bottom:10px">${eggFilters.year ? eggFilters.year : "All time"}: <strong style="color:var(--text)">${totalCount} eggs</strong> (${(totalCount / 12).toFixed(1)} dozen) across ${sorted.length} entr${sorted.length !== 1 ? "ies" : "y"}${totalValue ? ` · <strong style="color:var(--text)">${fmtMoney(totalValue)}</strong> value` : ""}</div>`;
    })() : ""}

    ${sorted.length === 0 ? `<div class="card"><div class="empty">${STATE.eggs.length === 0 ? "No egg logs yet." : "No eggs logged in this year."}</div></div>` : (() => {
      const visible = sorted.slice(0, eggsVisibleCount);
      return `
    <div class="list-stack">
      ${visible.map(e => {
        const value = (Number(e.count) || 0) * (Number(e.price_per_egg) || 0);
        const daysAgo = daysSince(e.date);
        const freshTone = daysAgo === 0 ? "sage" : daysAgo <= 7 ? "slate" : "";
        const freshLabel = daysAgo === 0 ? "New" : daysAgo <= 7 ? "Recent" : "";
        return `
        <div class="list-card${freshTone ? " tone-" + freshTone : ""}${selectedEggIds.has(e.id) ? " card-selected" : ""}" data-edit="${e.id}" data-id="${e.id}" style="cursor:pointer;align-items:flex-start">
          ${selectionState.eggs.mode ? `<input type="checkbox" class="list-card-check egg-check" data-id="${e.id}" ${selectedEggIds.has(e.id) ? "checked" : ""} onclick="event.stopPropagation()">` : ""}
          <div class="list-card-main">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
              <div style="font-weight:700">${fmtDate(e.date)}${freshLabel ? ` <span class="stamp tone-${freshTone}" style="margin-left:4px">${freshLabel}</span>` : ""}</div>
              ${value > 0 ? `<span class="stamp stamp-lg tone-gold">${fmtMoney(value)}</span>` : ""}
            </div>
            <div class="list-card-desc dim">${e.count} egg${e.count !== 1 ? "s" : ""}${e.price_per_egg ? ` @ ${fmtMoney(e.price_per_egg)}/egg` : ""}${e.notes ? " · " + esc(e.notes) : ""}</div>
            ${eggCartonHtml(Number(e.count) || 0)}
          </div>
        </div>`;
      }).join("")}
    </div>
    ${loadMoreButtonHtml(sorted.length, eggsVisibleCount)}`;
    })()}
  `;
  document.getElementById("toggleEggForm").addEventListener("click", () => openEggModal(null));
  document.getElementById("toggleEggSelectMode").addEventListener("click", () => {
    selectionState.eggs.mode = !selectionState.eggs.mode;
    if (!selectionState.eggs.mode) selectedEggIds.clear();
    renderEggsMain();
  });
  const toggleFiltersBtn = document.getElementById("toggleEggFilters");
  if (toggleFiltersBtn) toggleFiltersBtn.addEventListener("click", () => { eggFiltersOpen = !eggFiltersOpen; renderEggsMain(); });
  const yearFilterEl = document.getElementById("filterEggYear");
  if (yearFilterEl) yearFilterEl.addEventListener("change", (e) => { eggFilters.year = e.target.value; eggsVisibleCount = PAGE_SIZE; renderEggsMain(); });
  const loadMoreEl = document.getElementById("loadMoreBtn");
  if (loadMoreEl) loadMoreEl.addEventListener("click", () => { eggsVisibleCount += PAGE_SIZE; renderEggsMain(); });
  el.querySelectorAll(".egg-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedEggIds.add(cb.dataset.id); else selectedEggIds.delete(cb.dataset.id);
    renderEggsMain();
  }));
  wireCardSelection(
    el.querySelectorAll("[data-edit]"),
    selectedEggIds,
    "eggs",
    () => [...el.querySelectorAll("[data-edit]")].map(c => c.dataset.id),
    (id) => openEggModal(STATE.eggs.find(e => e.id === id)),
    renderEggsMain
  );
  wireBulkDeleteBar(selectedEggIds, "eggs", "egg log", async () => { STATE.eggs = await localGetAll("eggs", currentCoopId); }, renderEggsMain);
}

function eggFormHtml(editing) {
  return `
    <div class="form-head">${editing ? "Edit egg log" : "Log eggs collected"}</div>
    <div class="grid-form">
      <label class="field"><span>Date</span><input type="date" id="e_date" value="${editing ? editing.date : todayStr()}"></label>
      <label class="field"><span>Count</span><input type="number" id="e_count" placeholder="e.g. 8" value="${editing ? editing.count : ""}"></label>
      <label class="field"><span>Value Per Egg</span><input type="number" step="0.01" id="e_price" placeholder="e.g. 0.50" value="${editing ? (editing.price_per_egg != null ? editing.price_per_egg : "") : getCoopDefaults().eggPrice}"></label>
      <label class="field"><span>Notes</span><input id="e_notes" placeholder="optional" value="${editing ? esc(editing.notes || "") : ""}"></label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveEgg">${editing ? "✓ Save changes" : "+ Add entry"}</button>
    </div>
  `;
}

function openEggModal(editing) {
  editingEggId = editing ? editing.id : null;
  openModal(
    eggFormHtml(editing),
    () => { editingEggId = null; },
    editing ? () => confirmAndDelete(
      "Delete this egg log entry? This can't be undone.",
      () => localEggDelete(editing.id, currentCoopId),
      "Egg log deleted",
      refreshAndRender
    ) : null
  );
  document.getElementById("saveEgg").addEventListener("click", async () => {
    const count = document.getElementById("e_count").value;
    if (!count) return;
    const price = document.getElementById("e_price").value;
    const payload = { coop_id: currentCoopId, date: document.getElementById("e_date").value, count: Number(count), price_per_egg: price ? Number(price) : null, notes: document.getElementById("e_notes").value };
    if (editing) await localEggUpdate(editing.id, payload);
    else await localEggCreate(payload);
    showToast(editing ? "Egg log updated" : "Egg log added", editing ? "update" : "create");
    closeModal();
    // refreshAndRender (not a hardcoded renderEggsMain) so this redraws
    // whichever tab is actually on screen -- eggs can now be opened from the
    // Eggs tab itself or from a "value produced" reference row on the
    // Finances tab, and hardcoding one target left the other stale until the
    // next navigation or reload. Same pattern showBirdForm already uses.
    refreshAndRender();
  });
}

