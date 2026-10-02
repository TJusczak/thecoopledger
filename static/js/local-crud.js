// Local-first create/update/delete for every resource (write locally, queue for the server).
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

function newLocalId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    try {
      return "c" + crypto.randomUUID().replace(/-/g, "").slice(0, 15);
    } catch (err) { /* fall through */ }
  }
  // crypto.randomUUID requires a secure context (HTTPS or localhost) and is
  // simply unavailable over plain HTTP (e.g. a bare LAN IP with no TLS) --
  // this only needs to be unique within this app, not cryptographically
  // random, so a timestamp + random fallback is perfectly fine here.
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

async function localEggCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("eggs", [record]);
  await queueOutbox({ resource: "eggs", op: "create", id: record.id, payload: record });
  trySyncSoon("eggs", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added egg entry (${record.count} egg${record.count !== 1 ? "s" : ""}, ${fmtDate(record.date)})`, [{ resource: "eggs", id: record.id, before: null, after: record }]);
  return record;
}
async function localEggUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("eggs", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("eggs", [record]);
  await queueOutbox({ resource: "eggs", op: "update", id, payload });
  trySyncSoon("eggs", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited egg entry (${fmtDate(record.date)})`, [{ resource: "eggs", id, before: existing, after: record }]);
  return record;
}
async function localEggDelete(id, coopId) {
  const existing = await localGetOne("eggs", id);
  const now = new Date().toISOString();
  await localPutMany("eggs", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "eggs", op: "delete", id, payload: null });
  trySyncSoon("eggs", coopId);
  if (existing) pushUndoAction(`Deleted egg entry (${existing.count} egg${existing.count !== 1 ? "s" : ""}, ${fmtDate(existing.date)})`, [{ resource: "eggs", id, before: existing, after: null }]);
}

async function localExpenseCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("expenses", [record]);
  await queueOutbox({ resource: "expenses", op: "create", id: record.id, payload: record });
  trySyncSoon("expenses", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added ${record.entry_type === "income" ? "income" : "expense"}: ${record.category} (${fmtMoney(record.amount)})`, [{ resource: "expenses", id: record.id, before: null, after: record }]);
  return record;
}
async function localExpenseUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("expenses", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("expenses", [record]);
  await queueOutbox({ resource: "expenses", op: "update", id, payload });
  trySyncSoon("expenses", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited ${record.entry_type === "income" ? "income" : "expense"}: ${record.category}`, [{ resource: "expenses", id, before: existing, after: record }]);
  return record;
}
async function localExpenseDelete(id, coopId) {
  const existing = await localGetOne("expenses", id);
  const now = new Date().toISOString();
  await localPutMany("expenses", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "expenses", op: "delete", id, payload: null });
  trySyncSoon("expenses", coopId);
  if (existing) pushUndoAction(`Deleted ${existing.entry_type === "income" ? "income" : "expense"}: ${existing.category} (${fmtMoney(existing.amount)})`, [{ resource: "expenses", id, before: existing, after: null }]);
}

/** Creates many records at once, local-first -- all written to IndexedDB
 * immediately (so they're usable offline right away, same as individual
 * creates), but queued as ONE outbox entry instead of N separate ones. That
 * single entry syncs via the bulk-create endpoint in one request, instead
 * of turning into hundreds or thousands of sequential HTTP round-trips the
 * next time the outbox drains -- which is what actually crashed the server
 * on a 4000-item group before this existed.
 *
 * Also pushes exactly one undo action covering every record created, since
 * "select a count and create a batch" is one user action regardless of how
 * many records it produced -- undoing it removes all of them together. */
async function localBulkCreate(resource, payloads, opts = {}) {
  const now = new Date().toISOString();
  const records = payloads.map(p => ({ id: newLocalId(), updated_at: now, deleted_at: null, ...p }));
  await localPutMany(resource, records);
  await queueOutbox({ resource, op: "bulk-create", id: null, payload: records });
  const coopId = records[0] && records[0].coop_id;
  if (coopId) trySyncSoon(resource, coopId);
  if (!opts.suppressUndo && records.length > 0) {
    const label = records.length === 1 ? `Added ${RESOURCE_LABELS[resource] || "an item"}` : `Added ${records.length} ${RESOURCE_LABELS_PLURAL[resource] || "items"}`;
    pushUndoAction(label, records.map(r => ({ resource, id: r.id, before: null, after: r })));
  }
  return records;
}

/** Deletes many records at once, local-first -- same reasoning as
 * localBulkCreate, but for the delete side. This is what the group-count
 * "raise to add more, lower to remove" flow needs: reducing a pile of 4000
 * down to 4 used to mean 3996 individual delete operations (and eventually
 * 3996 individual sync requests) -- now it's one. Also pushes one combined
 * undo action for the same reason localBulkCreate does. */
async function localBulkDelete(resource, ids, coopId, opts = {}) {
  const now = new Date().toISOString();
  const existing = await Promise.all(ids.map(id => localGetOne(resource, id)));
  const records = ids.map((id, i) => ({ ...(existing[i] || { id }), deleted_at: now, updated_at: now }));
  await localPutMany(resource, records);
  await queueOutbox({ resource, op: "bulk-delete", id: null, payload: ids });
  if (coopId) trySyncSoon(resource, coopId);
  if (!opts.suppressUndo && ids.length > 0) {
    const label = ids.length === 1 ? `Deleted ${RESOURCE_LABELS[resource] || "an item"}` : `Deleted ${ids.length} ${RESOURCE_LABELS_PLURAL[resource] || "items"}`;
    pushUndoAction(label, ids.map((id, i) => ({ resource, id, before: existing[i], after: null })));
  }
  return existing;
}

/** Same idea for updates -- payload is an array of {id, fields} objects. */
async function localBulkUpdate(resource, updates, coopId, opts = {}) {
  const now = new Date().toISOString();
  const existingRecords = await Promise.all(updates.map(u => localGetOne(resource, u.id)));
  const records = updates.map((u, i) => ({ ...(existingRecords[i] || { id: u.id }), ...u.fields, updated_at: now }));
  await localPutMany(resource, records);
  await queueOutbox({ resource, op: "bulk-update", id: null, payload: updates });
  if (coopId) trySyncSoon(resource, coopId);
  if (!opts.suppressUndo && updates.length > 0) {
    const label = updates.length === 1 ? `Edited ${RESOURCE_LABELS[resource] || "an item"}` : `Edited ${updates.length} ${RESOURCE_LABELS_PLURAL[resource] || "items"}`;
    pushUndoAction(label, updates.map((u, i) => ({ resource, id: u.id, before: existingRecords[i], after: records[i] })));
  }
  return records;
}

async function localSupplyCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("supplies", [record]);
  await queueOutbox({ resource: "supplies", op: "create", id: record.id, payload: record });
  trySyncSoon("supplies", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added supply item: ${record.brand || record.description || record.category}`, [{ resource: "supplies", id: record.id, before: null, after: record }]);
  return record;
}
async function localSupplyUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("supplies", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("supplies", [record]);
  await queueOutbox({ resource: "supplies", op: "update", id, payload });
  trySyncSoon("supplies", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited supply item: ${record.brand || record.description || record.category}`, [{ resource: "supplies", id, before: existing, after: record }]);
  return record;
}
async function localSupplyDelete(id, coopId) {
  const existing = await localGetOne("supplies", id);
  const now = new Date().toISOString();
  await localPutMany("supplies", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "supplies", op: "delete", id, payload: null });
  trySyncSoon("supplies", coopId);
  if (existing) pushUndoAction(`Deleted supply item: ${existing.brand || existing.description || existing.category}`, [{ resource: "supplies", id, before: existing, after: null }]);
}

async function localSupplyProductCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("supply_products", [record]);
  await queueOutbox({ resource: "supply_products", op: "create", id: record.id, payload: record });
  trySyncSoon("supply_products", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added saved product: ${record.brand}`, [{ resource: "supply_products", id: record.id, before: null, after: record }]);
  return record;
}
async function localSupplyProductUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("supply_products", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("supply_products", [record]);
  await queueOutbox({ resource: "supply_products", op: "update", id, payload });
  trySyncSoon("supply_products", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited saved product: ${record.brand}`, [{ resource: "supply_products", id, before: existing, after: record }]);
  return record;
}
async function localSupplyProductDelete(id, coopId) {
  const existing = await localGetOne("supply_products", id);
  const now = new Date().toISOString();
  await localPutMany("supply_products", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "supply_products", op: "delete", id, payload: null });
  trySyncSoon("supply_products", coopId);
  if (existing) pushUndoAction(`Deleted saved product: ${existing.brand}`, [{ resource: "supply_products", id, before: existing, after: null }]);
}

async function localBeddingCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("bedding", [record]);
  await queueOutbox({ resource: "bedding", op: "create", id: record.id, payload: record });
  trySyncSoon("bedding", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added bedding entry: ${record.area}`, [{ resource: "bedding", id: record.id, before: null, after: record }]);
  return record;
}
async function localBeddingUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("bedding", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("bedding", [record]);
  await queueOutbox({ resource: "bedding", op: "update", id, payload });
  trySyncSoon("bedding", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited bedding entry: ${record.area}`, [{ resource: "bedding", id, before: existing, after: record }]);
  return record;
}
async function localBeddingDelete(id, coopId) {
  const existing = await localGetOne("bedding", id);
  const now = new Date().toISOString();
  await localPutMany("bedding", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "bedding", op: "delete", id, payload: null });
  trySyncSoon("bedding", coopId);
  if (existing) pushUndoAction(`Deleted bedding entry: ${existing.area}`, [{ resource: "bedding", id, before: existing, after: null }]);
}

async function localHatchCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("hatches", [record]);
  await queueOutbox({ resource: "hatches", op: "create", id: record.id, payload: record });
  trySyncSoon("hatches", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Started clutch (${record.egg_count} eggs)`, [{ resource: "hatches", id: record.id, before: null, after: record }]);
  return record;
}
async function localHatchUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("hatches", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("hatches", [record]);
  await queueOutbox({ resource: "hatches", op: "update", id, payload });
  trySyncSoon("hatches", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited clutch (${record.egg_count} eggs)`, [{ resource: "hatches", id, before: existing, after: record }]);
  return record;
}
async function localHatchDelete(id, coopId) {
  const existing = await localGetOne("hatches", id);
  const now = new Date().toISOString();
  await localPutMany("hatches", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  const clutchEggs = (await localGetAll("hatch_eggs", coopId)).filter(e => e.hatch_id === id && !e.deleted_at);
  if (clutchEggs.length) await localPutMany("hatch_eggs", clutchEggs.map(e => ({ ...e, deleted_at: now, updated_at: now })));
  await queueOutbox({ resource: "hatches", op: "delete", id, payload: null });
  trySyncSoon("hatches", coopId);
  if (existing) pushUndoAction(`Deleted clutch (${existing.egg_count} eggs, started ${fmtDate(existing.date_started)})`, [{ resource: "hatches", id, before: existing, after: null }]);
}

async function localHatchEggCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("hatch_eggs", [record]);
  await queueOutbox({ resource: "hatch_eggs", op: "create", id: record.id, payload: record });
  trySyncSoon("hatch_eggs", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added egg #${record.position}`, [{ resource: "hatch_eggs", id: record.id, before: null, after: record }]);
  return record;
}
async function localHatchEggUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("hatch_eggs", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("hatch_eggs", [record]);
  await queueOutbox({ resource: "hatch_eggs", op: "update", id, payload });
  trySyncSoon("hatch_eggs", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited egg #${record.position}`, [{ resource: "hatch_eggs", id, before: existing, after: record }]);
  return record;
}

async function localBirdPhotoCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("bird_photos", [record]);
  await queueOutbox({ resource: "bird_photos", op: "create", id: record.id, payload: record });
  trySyncSoon("bird_photos", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added a photo to the timeline`, [{ resource: "bird_photos", id: record.id, before: null, after: record }]);
  return record;
}
async function localBirdPhotoUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("bird_photos", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("bird_photos", [record]);
  await queueOutbox({ resource: "bird_photos", op: "update", id, payload });
  trySyncSoon("bird_photos", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited a timeline photo`, [{ resource: "bird_photos", id, before: existing, after: record }]);
  return record;
}

/** For a bird that already has a "current" photo but no timeline entries
 * yet (every bird from before this feature existed), seeds the timeline
 * with one entry mirroring that photo -- the exact original capture date
 * isn't known, so it defaults to today (editable by hand afterward if the
 * real date matters). Runs once per bird -- after this it behaves exactly
 * like one that always had timeline entries. */
async function ensureBirdPhotoHistorySeeded(bird) {
  if (!bird.photo) return;
  const existing = STATE.birdPhotos.filter(p => p.bird_id === bird.id);
  if (existing.length > 0) return;
  const today = todayStr();
  await localBirdPhotoCreate({
    coop_id: bird.coop_id, bird_id: bird.id, photo: bird.photo,
    photo_pos_x: bird.photo_pos_x, photo_pos_y: bird.photo_pos_y, photo_zoom: bird.photo_zoom,
    date_taken: today, stage: suggestStage(bird.hatch_date, today),
  }, { suppressUndo: true });
  STATE.birdPhotos = await localGetAll("bird_photos", currentCoopId);
}

/** Lazily creates individual hatch_eggs rows for a clutch that doesn't have
 * any yet -- covers both a genuinely fresh clutch (all old counters at
 * zero, generates egg_count "Incubating" eggs) and an old clutch from
 * before per-egg tracking existed (reconstructs eggs from the old
 * aggregate counters). Already-named birds linked via hatch_id get matched
 * to generated "Hatched" eggs in display order, carrying their gender over
 * rather than starting blank. Runs once per clutch -- after this it
 * behaves exactly like one that always had individual eggs. */
async function ensureHatchEggsExist(hatch) {
  const existing = STATE.hatchEggs.filter(e => e.hatch_id === hatch.id);
  if (existing.length > 0) return existing;

  const hatchedCount = Number(hatch.hatched_count) || 0;
  const namedCount = Number(hatch.named_count) || 0;
  const clearCount = Number(hatch.clear_count) || 0;
  const quitCount = Number(hatch.quit_count) || 0;
  const failedCount = Number(hatch.failed_count) || 0;
  const eggCount = Number(hatch.egg_count) || 0;
  const accountedFor = hatchedCount + clearCount + quitCount + failedCount;
  const incubatingCount = Math.max(0, eggCount - accountedFor);
  const linkedBirds = STATE.birds.filter(b => b.hatch_id === hatch.id).sort((a, b) => (a.hatch_date || "").localeCompare(b.hatch_date || ""));
  // named_count beyond the number of real linked birds represents eggs
  // that were marked "already tracked elsewhere" via the old skip button --
  // no bird record, but shouldn't prompt for naming again either.
  const skippedCount = Math.max(0, namedCount - linkedBirds.length);

  const toCreate = [];
  let position = 1;
  for (let i = 0; i < hatchedCount; i++) {
    const bird = linkedBirds[i] || null;
    const isSkipped = !bird && (i - linkedBirds.length) < skippedCount;
    toCreate.push({ coop_id: hatch.coop_id, hatch_id: hatch.id, position: position++, status: "Hatched", gender: bird ? (bird.gender || null) : null, bird_id: bird ? bird.id : null, tracked_externally: isSkipped ? 1 : null });
  }
  for (let i = 0; i < clearCount; i++) toCreate.push({ coop_id: hatch.coop_id, hatch_id: hatch.id, position: position++, status: "Clear", gender: null, bird_id: null });
  for (let i = 0; i < quitCount; i++) toCreate.push({ coop_id: hatch.coop_id, hatch_id: hatch.id, position: position++, status: "Quit", gender: null, bird_id: null });
  for (let i = 0; i < failedCount; i++) toCreate.push({ coop_id: hatch.coop_id, hatch_id: hatch.id, position: position++, status: "Failed to Hatch", gender: null, bird_id: null });
  for (let i = 0; i < incubatingCount; i++) toCreate.push({ coop_id: hatch.coop_id, hatch_id: hatch.id, position: position++, status: "Incubating", gender: null, bird_id: null });

  if (toCreate.length === 0) return [];
  await localBulkCreate("hatch_eggs", toCreate, { suppressUndo: true });
  STATE.hatchEggs = await localGetAll("hatch_eggs", currentCoopId);
  return STATE.hatchEggs.filter(e => e.hatch_id === hatch.id);
}

async function localNoteCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("notes", [record]);
  await queueOutbox({ resource: "notes", op: "create", id: record.id, payload: record });
  trySyncSoon("notes", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added note: ${record.title || "Untitled"}`, [{ resource: "notes", id: record.id, before: null, after: record }]);
  return record;
}
async function localNoteUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("notes", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("notes", [record]);
  await queueOutbox({ resource: "notes", op: "update", id, payload });
  trySyncSoon("notes", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited note: ${record.title || "Untitled"}`, [{ resource: "notes", id, before: existing, after: record }]);
  return record;
}
async function localNoteDelete(id, coopId) {
  const existing = await localGetOne("notes", id);
  const now = new Date().toISOString();
  await localPutMany("notes", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "notes", op: "delete", id, payload: null });
  trySyncSoon("notes", coopId);
  if (existing) pushUndoAction(`Deleted note: ${existing.title || "Untitled"}`, [{ resource: "notes", id, before: existing, after: null }]);
}

async function localBirdLogCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("bird_logs", [record]);
  await queueOutbox({ resource: "bird_logs", op: "create", id: record.id, payload: record });
  trySyncSoon("bird_logs", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added health log entry (${fmtDate(record.date)})`, [{ resource: "bird_logs", id: record.id, before: null, after: record }]);
  return record;
}
async function localBirdLogDelete(id, coopId) {
  const existing = await localGetOne("bird_logs", id);
  const now = new Date().toISOString();
  await localPutMany("bird_logs", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "bird_logs", op: "delete", id, payload: null });
  trySyncSoon("bird_logs", coopId);
  if (existing) pushUndoAction(`Deleted health log entry (${fmtDate(existing.date)})`, [{ resource: "bird_logs", id, before: existing, after: null }]);
}

async function localBirdCreate(payload, opts = {}) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("birds", [record]);
  await queueOutbox({ resource: "birds", op: "create", id: record.id, payload: record });
  trySyncSoon("birds", payload.coop_id);
  if (!opts.suppressUndo) pushUndoAction(`Added bird "${record.name}"`, [{ resource: "birds", id: record.id, before: null, after: record }]);
  return record;
}
async function localBirdUpdate(id, payload, opts = {}) {
  const existing = await localGetOne("birds", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("birds", [record]);
  await queueOutbox({ resource: "birds", op: "update", id, payload });
  trySyncSoon("birds", payload.coop_id || (existing && existing.coop_id));
  if (existing && !opts.suppressUndo) pushUndoAction(`Edited bird "${record.name}"`, [{ resource: "birds", id, before: existing, after: record }]);
  return record;
}
async function localBirdDelete(id, coopId) {
  const existing = await localGetOne("birds", id);
  const now = new Date().toISOString();
  await localPutMany("birds", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "birds", op: "delete", id, payload: null });
  await clearPendingPhoto(id); // no point uploading a photo for a bird that's gone
  const operations = [{ resource: "birds", id, before: existing, after: null }];
  // If this bird came from a hatching clutch, un-name it there too -- the
  // clutch's pending-to-name queue should reflect that this chick no longer
  // has a bird record, not silently think it's still resolved. Captured as
  // part of the same undo action as the bird itself, so undoing this
  // restores both the bird and the clutch's count together, not just the bird.
  if (existing && existing.hatch_id) {
    const linkedEgg = (await localGetAll("hatch_eggs", coopId)).find(e => e.bird_id === id);
    if (linkedEgg) {
      const eggUpdated = await localHatchEggUpdate(linkedEgg.id, { bird_id: null }, { suppressUndo: true });
      operations.push({ resource: "hatch_eggs", id: linkedEgg.id, before: linkedEgg, after: eggUpdated });
    }
  }
  trySyncSoon("birds", coopId);
  if (existing) pushUndoAction(`Deleted bird "${existing.name}"`, operations);
}

/** Same as localBulkDelete, but for birds specifically -- preserves the
 * hatch-clutch reconciliation that individual bird deletion already does
 * (un-naming a chick in its originating clutch's pending queue), grouped by
 * clutch so several chicks from the same batch decrement it once by the
 * right amount rather than each reading a stale count before the others
 * have written theirs. */
async function localBulkDeleteBirds(ids, coopId) {
  const now = new Date().toISOString();
  const existing = await Promise.all(ids.map(id => localGetOne("birds", id)));
  const records = ids.map((id, i) => ({ ...(existing[i] || { id }), deleted_at: now, updated_at: now }));
  await localPutMany("birds", records);
  await queueOutbox({ resource: "birds", op: "bulk-delete", id: null, payload: ids });
  await Promise.all(ids.map(id => clearPendingPhoto(id)));
  const linkedEggIds = new Set(existing.filter(b => b && b.hatch_id).map(b => b.id));
  const hatchOps = [];
  if (linkedEggIds.size > 0) {
    const allEggs = await localGetAll("hatch_eggs", coopId);
    const eggsToClear = allEggs.filter(e => linkedEggIds.has(e.bird_id));
    await Promise.all(eggsToClear.map(async (egg) => {
      const updated = await localHatchEggUpdate(egg.id, { bird_id: null }, { suppressUndo: true });
      hatchOps.push({ resource: "hatch_eggs", id: egg.id, before: egg, after: updated });
    }));
  }
  if (coopId) trySyncSoon("birds", coopId);
  const birdOps = ids.map((id, i) => ({ resource: "birds", id, before: existing[i], after: null }));
  pushUndoAction(ids.length === 1 ? "Deleted a bird" : `Deleted ${ids.length} birds`, [...birdOps, ...hatchOps]);
}

async function localCoopCreate(payload) {
  const record = { id: newLocalId(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
  await localPutMany("coops", [record]);
  await queueOutbox({ resource: "coops", op: "create", id: record.id, payload: record });
  trySyncSoon("coops", null);
  return record;
}
async function localCoopUpdate(id, payload) {
  const existing = await localGetOne("coops", id);
  const record = { ...(existing || { id }), ...payload, updated_at: new Date().toISOString() };
  await localPutMany("coops", [record]);
  await queueOutbox({ resource: "coops", op: "update", id, payload });
  trySyncSoon("coops", null);
  return record;
}
async function localCoopDelete(id) {
  const existing = await localGetOne("coops", id);
  const now = new Date().toISOString();
  await localPutMany("coops", [{ ...(existing || { id }), deleted_at: now, updated_at: now }]);
  await queueOutbox({ resource: "coops", op: "delete", id, payload: null });
  // The server hard-deletes everything under this coop in one shot -- clean
  // up the same local records so nothing orphaned lingers in IndexedDB.
  const db = await openLocalDb();
  for (const store of ["birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "hatch_eggs", "bird_photos", "supply_products"]) {
    const all = await localGetAll(store, id);
    const tx = db.transaction(store, "readwrite");
    all.forEach(r => tx.objectStore(store).delete(r.id));
    await idbDone(tx);
  }
  trySyncSoon("coops", null);
}

