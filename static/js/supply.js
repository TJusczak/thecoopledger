// Supply: inventory, feed bags, products, bedding.
// (Classic script: shares one global scope with the other files in index.html -- load order matters, see index.html.)

// ================= BEDDING =================
/** A horizontal row of saved product photos to reuse instead of retaking a
 * photo of the same brand every time it's bought again, plus a tile to add
 * a new one. Shared by the supply form and the expense form's auto-create
 * flow -- both just embed this HTML and call wireProductPicker after. */
/** Shared by both the picker's inline mini-form and the Supply tab's
 * "Products" page's edit form -- one definition, so the two never drift apart. */
function renderProductEditFormHtml(editingProduct, category, standalone = false) {
  const lockedUnit = UNIT_LOCKS[category];
  const photo = editingProduct ? productPhotoUrl(editingProduct) : null;
  const inner = `
      <div class="dim" style="font-size:11px;margin-bottom:6px">${editingProduct ? `Editing "${esc(editingProduct.brand)}"` : "New saved product"}</div>
      ${standalone && photo ? `
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
        <div id="productPhotoPreview" style="width:64px;height:64px;border-radius:8px;overflow:hidden"><img src="${photo}" data-view-photo="${esc(photo)}" class="thumb-clickable" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(editingProduct)};${photoTransformStyle(editingProduct)}border:1px solid var(--border);cursor:zoom-in"></div>
        <button class="btn ghost small" id="repositionProductPhoto">↔ Reposition</button>
      </div>
      ` : ""}
      <div class="grid-form">
        <label class="field"><span>Brand</span><input id="np_brand" placeholder="e.g. Purina Layena" value="${editingProduct ? esc(editingProduct.brand || "") : ""}"></label>
        <label class="field"><span>Photo${editingProduct ? " (leave blank to keep current)" : ""}</span><input type="file" id="np_photo" accept="image/*"></label>
        <label class="field"><span>Description</span><input id="np_desc" placeholder="e.g. large bag" value="${editingProduct ? esc(editingProduct.default_description || "") : ""}"></label>
        <label class="field"><span>Usual quantity</span><input type="number" step="0.01" id="np_qty" placeholder="e.g. 50" value="${editingProduct && editingProduct.default_quantity != null ? displayQty(editingProduct.default_quantity, editingProduct.default_unit) : ""}"></label>
        <label class="field"><span>Usual unit</span><select id="np_unit" ${lockedUnit ? "disabled" : ""}>${lockedUnit
          ? `<option selected>${lockedUnit}</option>`
          : `<option value="">—</option>${unitOptionsHtml(editingProduct && editingProduct.default_unit)}`
        }</select></label>
      </div>
      <div class="dim" style="font-size:11px;margin-top:6px">Selecting this product will fill in the brand (and description/quantity/unit, if set here) automatically -- keeps bags of the same product consistent instead of drifting apart by typo.</div>
      ${standalone ? `
      <div class="modal-actions">
        <button class="btn btn-confirm" id="saveNewProduct">✓ Save product</button>
      </div>
      ` : `
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-confirm small" id="saveNewProduct">✓ Save product</button>
        <button class="btn btn-close small" id="cancelNewProduct">Cancel</button>
      </div>
      `}
  `;
  return standalone ? inner : `<div class="form-block" style="margin:4px 0 8px;padding:10px">${inner}</div>`;
}

function renderProductPickerRow(category) {
  const products = STATE.supplyProducts.filter(p => !category || p.category === category);
  // Group by brand so duplicate/near-duplicate saved products (e.g. two
  // "Purina Layena" entries created by accident) are visually clustered
  // together instead of scattered through the row.
  const groups = {};
  products.forEach(p => {
    const key = p.brand || p.category;
    (groups[key] = groups[key] || []).push(p);
  });
  const sortedGroups = Object.entries(groups)
    .map(([brand, items]) => ({ brand, items: items.sort((a, b) => (b.last_used_at || "").localeCompare(a.last_used_at || "")) }))
    .sort((a, b) => (b.items[0].last_used_at || "").localeCompare(a.items[0].last_used_at || ""));
  const editingProduct = editingProductId ? STATE.supplyProducts.find(p => p.id === editingProductId) : null;
  const formOpen = newProductFormOpen || !!editingProduct;
  const tileHtml = (p) => {
    const qtyPart = p.default_quantity != null ? `${displayQty(p.default_quantity, p.default_unit)} ${unitLabel(p.default_unit)}`.trim() : "";
    const label = [p.default_description, qtyPart].filter(Boolean).join(" -- ") || p.brand || p.category;
    return `
        <div class="product-picker-item${selectedProductId === p.id ? " selected" : ""}" data-product="${p.id}">
          <span class="product-picker-remove" data-remove-product="${p.id}" title="Remove this saved product">×</span>
          <span class="product-picker-edit" data-edit-product="${p.id}" title="Rename or update this product">✎</span>
          <div class="product-picker-thumb">${productPhotoUrl(p) ? `<img src="${productPhotoUrl(p)}" style="object-position:${photoPosition(p)};${photoTransformStyle(p)}">` : "📦"}</div>
          <div class="product-picker-label">${esc(label)}</div>
        </div>`;
  };
  return `
    <div class="dim" style="font-size:11px;margin:8px 0 2px">Saved products${category ? ` (${category})` : ""} -- tap to reuse instead of retaking a photo</div>
    <div class="product-picker-row" id="productPickerRow">
      ${sortedGroups.map(({ brand, items }) => `
        <div class="product-brand-group">
          <div class="product-brand-group-label">${esc(brand)}</div>
          <div class="product-brand-group-items">${items.map(tileHtml).join("")}</div>
        </div>`).join("")}
      <div class="product-picker-new" id="newProductTile">
        <div class="product-picker-thumb">+</div>
        <div class="product-picker-label">New</div>
      </div>
    </div>
    ${formOpen ? renderProductEditFormHtml(editingProduct, editingProduct ? editingProduct.category : category) : ""}
  `;
}

/** Wires the picker rendered above. categoryFieldId/brandFieldId let it work
 * inside either the supply form or the expense form without duplicating
 * this logic -- it just reads/writes whichever field ids that host form
 * actually uses. rerenderFn re-renders enough of the host form to reflect
 * a new selection or a newly-created product. */
function wireProductPicker(el, { categoryFieldId, brandFieldId, descFieldId, qtyFieldId, unitFieldId, rerenderFn }) {
  // Re-renders and re-wires just the picker itself, not the whole host
  // form -- a full rerenderFn() rebuilds category/brand/quantity fields
  // from scratch, which would erase whatever was just filled in (including
  // snapping the category dropdown back to its default, since a brand-new
  // item has no "selected" category to persist across a rebuild).
  const refreshPicker = () => {
    const categoryField = document.getElementById(categoryFieldId);
    const currentCategory = categoryField ? categoryField.value : null;
    el.innerHTML = renderProductPickerRow(currentCategory);
    wireProductPicker(el, { categoryFieldId, brandFieldId, descFieldId, qtyFieldId, unitFieldId, rerenderFn });
  };
  el.querySelectorAll("[data-product]").forEach(item => item.addEventListener("click", () => {
    const id = item.dataset.product;
    selectedProductId = selectedProductId === id ? null : id; // tap again to deselect
    const product = STATE.supplyProducts.find(p => p.id === id);
    // Always sync these fields to the selected product (not just when
    // empty) -- this is what keeps every bag of the same product
    // consistent, which is what the grouping logic actually depends on to
    // collapse identical sealed bags together correctly.
    if (product) {
      const brandField = document.getElementById(brandFieldId);
      if (brandField) brandField.value = product.brand;
      const descField = descFieldId ? document.getElementById(descFieldId) : null;
      if (descField && product.default_description) descField.value = product.default_description;
      const qtyField = qtyFieldId ? document.getElementById(qtyFieldId) : null;
      if (qtyField && product.default_quantity != null) qtyField.value = product.default_quantity;
      const unitField = unitFieldId ? document.getElementById(unitFieldId) : null;
      if (unitField && product.default_unit) unitField.value = product.default_unit;
    }
    refreshPicker();
  }));
  el.querySelectorAll("[data-remove-product]").forEach(btn => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const id = btn.dataset.removeProduct;
    if (!(await showConfirmDialog("Remove this saved product? Any bags already using its photo will lose it too, not just future ones -- this can't be undone."))) return;
    await localSupplyProductDelete(id, currentCoopId);
    if (selectedProductId === id) selectedProductId = null;
    STATE.supplyProducts = await localGetAll("supply_products", currentCoopId);
    refreshPicker();
  }));
  el.querySelectorAll("[data-edit-product]").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    editingProductId = btn.dataset.editProduct;
    newProductFormOpen = false;
    refreshPicker();
  }));
  const newTile = document.getElementById("newProductTile");
  if (newTile) newTile.addEventListener("click", () => { newProductFormOpen = true; editingProductId = null; refreshPicker(); });
  const cancelBtn = document.getElementById("cancelNewProduct");
  if (cancelBtn) cancelBtn.addEventListener("click", () => { newProductFormOpen = false; editingProductId = null; refreshPicker(); });
  const saveBtn = document.getElementById("saveNewProduct");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const brand = document.getElementById("np_brand").value.trim();
    if (!brand) { alert("Give the product a name first"); return; }
    const qtyVal = document.getElementById("np_qty").value;
    const unitVal = document.getElementById("np_unit").value;
    const descVal = document.getElementById("np_desc").value;
    const photoFile = document.getElementById("np_photo").files[0];
    let productId;
    if (editingProductId) {
      await localSupplyProductUpdate(editingProductId, {
        brand, default_quantity: parseQtyInput(qtyVal, unitVal), default_unit: unitVal || null, default_description: descVal || null,
      });
      productId = editingProductId;
    } else {
      const categoryField = document.getElementById(categoryFieldId);
      const category = categoryField ? categoryField.value : "";
      const created = await localSupplyProductCreate({
        coop_id: currentCoopId, category, brand, last_used_at: todayStr(),
        default_quantity: parseQtyInput(qtyVal, unitVal), default_unit: unitVal || null, default_description: descVal || null,
      });
      productId = created.id;
    }
    if (photoFile) {
      const blob = await resizeImageFileToBlob(photoFile);
      await queuePendingProductPhoto(productId, blob);
      trySyncSoon("supply_products", currentCoopId);
      await refreshPendingProductPhotoUrls();
    }
    selectedProductId = productId;
    newProductFormOpen = false;
    editingProductId = null;
    STATE.supplyProducts = await localGetAll("supply_products", currentCoopId);
    const brandField = document.getElementById(brandFieldId);
    if (brandField) brandField.value = brand;
    refreshPicker();
  });
}

const FULLNESS_STEPS = [
  { status: "Empty", icon: "○", label: "Empty" },
  { status: "1/4", icon: "◔", label: "1/4 full" },
  { status: "1/2", icon: "◑", label: "1/2 full" },
  { status: "3/4", icon: "◕", label: "3/4 full" },
  { status: "Full", icon: "●", label: "Full" },
];

function supplyCardHtml(s) {
  const tone = supplyStatusTone(s.status); // "sage" | "gold" | "rust" | "slate"
  const catTone = supplyCategoryTone(s.category);
  const amountLabel = s.quantity ? `${displayQty(s.quantity, s.unit)} ${esc(unitLabel(s.unit))}` : "";
  const product = s.product_id ? STATE.supplyProducts.find(p => p.id === s.product_id) : null;
  const photo = product ? productPhotoUrl(product) : null;
  const line1 = s.brand || s.description || s.category;
  const line2 = (s.description && s.description !== line1) ? s.description : "";
  const thumb = photo
    ? `<div class="thumb-clickable" data-view-supply-photo="${esc(photo)}" title="Tap to view full size" onclick="event.stopPropagation()" style="width:48px;height:48px;border-radius:6px;overflow:hidden;flex:0 0 auto;cursor:zoom-in"><img src="${photo}" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(product)};${photoTransformStyle(product)}"></div>`
    : `<div style="width:48px;height:48px;border-radius:6px;flex:0 0 auto;background:color-mix(in srgb, var(--${catTone}) 12%, var(--bg));display:flex;align-items:center;justify-content:center;font-size:20px">📦</div>`;
  return `<div class="list-card tone-${catTone}${selectedSupplyIds.has(s.id) ? " card-selected" : ""}" data-edit-supply="${s.id}" data-id="${s.id}">
    ${selectionState.supplies.mode ? `<input type="checkbox" class="list-card-check supply-check" data-id="${s.id}" ${selectedSupplyIds.has(s.id) ? "checked" : ""} onclick="event.stopPropagation()">` : ""}
    ${thumb}
    <div class="list-card-main">
      <div style="font-weight:700">${esc(line1)}</div>
      <div class="list-card-desc dim">${esc(s.category)}${amountLabel ? ` · ${amountLabel}` : ""}</div>
      ${line2 ? `<div class="list-card-desc dim">${esc(line2)}</div>` : ""}
    </div>
    <div class="list-card-side">
      <span class="stamp tone-${tone}">${esc(supplyStampLabel(s))}</span>
      <div class="fullness-pills" onclick="event.stopPropagation()">
        ${FULLNESS_STEPS.map(f => `<button type="button" class="fullness-pill${s.status === f.status ? " active" : ""}" data-status="${f.status}" data-id="${s.id}" title="${f.label}" style="--pill-tone:var(--${tone})">${f.icon}</button>`).join("")}
      </div>
    </div>
  </div>`;
}

function supplyGroupFormHtml(members) {
  const first = members[0];
  return `
    <div class="form-head">Edit group (${members.length} full)</div>
    <div class="dim" style="font-size:12px;margin:8px 0 14px">Changes apply to the whole pile. Raise the count to add more (e.g. you actually bought 10, not 9), lower it to remove some -- no need to open and delete bags one at a time.</div>
    <div class="grid-form">
      <label class="field"><span>Category</span><select id="grp_category">${[...QUANTITY_CATEGORIES].map(c => `<option ${first.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field"><span>Brand</span><input id="grp_brand" value="${esc(first.brand || "")}"></label>
      <label class="field"><span>Description</span><input id="grp_desc" value="${esc(first.description || "")}"></label>
      <label class="field"><span>Quantity (per item)</span><input type="number" step="0.01" id="grp_qty" value="${displayQty(first.quantity, first.unit)}"></label>
      <label class="field"><span>Unit</span><select id="grp_unit">${unitOptionsHtml(first.unit)}</select></label>
      <label class="field"><span>Date added</span><input type="date" id="grp_date" value="${first.date_added || todayStr()}"></label>
      <label class="field"><span>Count</span><input type="number" min="0" max="500" step="1" id="grp_count" value="${members.length}"></label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveGroupBtn">✓ Save changes</button>
      <button class="btn btn-close" id="deleteGroupBtn">🗑 Delete all ${members.length}</button>
    </div>
  `;
}

function openSupplyGroupModal(key) {
  const members = STATE.supplies.filter(s => s.status === "Full" && !s.opened_at && supplyGroupKey(s) === key);
  if (members.length === 0) return;
  openModal(supplyGroupFormHtml(members));
  applyFeedUnitLock("grp_category", "grp_unit");

  document.getElementById("saveGroupBtn").addEventListener("click", async () => {
    const payload = {
      coop_id: currentCoopId,
      category: document.getElementById("grp_category").value,
      brand: document.getElementById("grp_brand").value,
      description: document.getElementById("grp_desc").value,
      quantity: parseQtyInput(document.getElementById("grp_qty").value, document.getElementById("grp_unit").value),
      unit: document.getElementById("grp_unit").value,
      date_added: document.getElementById("grp_date").value,
      status: "Full",
      date_emptied: null,
      product_id: members[0] ? (members[0].product_id || null) : null,
    };
    const targetCount = Math.max(0, Math.floor(Number(document.getElementById("grp_count").value) || 0));
    if (targetCount > 500) { alert("That's a lot of bags for one group -- try 500 or fewer at a time"); return; }
    const currentIds = members.map(m => m.id);
    const keepIds = currentIds.slice(0, Math.min(targetCount, currentIds.length));
    const removeIds = currentIds.slice(keepIds.length);
    const addCount = Math.max(0, targetCount - currentIds.length);
    // Whichever of these actually has anything to do fires as ONE bulk
    // request, not one request per bag -- this is what changing the count
    // by a lot (raising or lowering) used to turn into hundreds or
    // thousands of individual sync operations.
    const [updatedRecords, deletedBefore, createdRecords] = await Promise.all([
      keepIds.length > 0 ? localBulkUpdate("supplies", keepIds.map(id => ({ id, fields: payload })), currentCoopId, { suppressUndo: true }) : Promise.resolve([]),
      removeIds.length > 0 ? localBulkDelete("supplies", removeIds, currentCoopId, { suppressUndo: true }) : Promise.resolve([]),
      addCount > 0 ? localBulkCreate("supplies", Array.from({ length: addCount }, () => payload), { suppressUndo: true }) : Promise.resolve([]),
    ]);
    const keptBefore = keepIds.map(id => members.find(m => m.id === id));
    const undoOps = [
      ...keepIds.map((id, i) => ({ resource: "supplies", id, before: keptBefore[i], after: updatedRecords[i] })),
      ...removeIds.map((id, i) => ({ resource: "supplies", id, before: deletedBefore[i], after: null })),
      ...createdRecords.map(r => ({ resource: "supplies", id: r.id, before: null, after: r })),
    ];
    pushUndoAction(`Edited group (${targetCount} full)`, undoOps);
    showToast(`Group updated (${targetCount} full)`, "update");
    closeModal();
    await loadCoopData();
    renderSupplyInventory();
  });

  document.getElementById("deleteGroupBtn").addEventListener("click", async () => {
    if (!(await showConfirmDialog(`Delete all ${members.length} bags in this group? This can't be undone.`))) return;
    await localBulkDelete("supplies", members.map(m => m.id), currentCoopId);
    showToast(`${members.length} items deleted`, "delete");
    closeModal();
    await loadCoopData();
    renderSupplyInventory();
  });
}

function emptySupplyModalHtml() {
  const emptyItems = STATE.supplies.filter(s => s.status === "Empty").sort((a, b) => (b.date_emptied || "").localeCompare(a.date_emptied || ""));
  // Grouped by year, newest first -- an active coop can empty a LOT of bags
  // over a few years (feed and bedding together), and a flat list that long
  // stops being something you can actually scan. Narrowing to one year at a
  // time keeps each group small enough that it doesn't need its own
  // pagination on top of the grouping.
  const byYear = new Map();
  emptyItems.forEach(s => {
    const y = s.date_emptied ? s.date_emptied.slice(0, 4) : "Unknown date";
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(s);
  });
  const years = [...byYear.keys()].sort().reverse();
  const supplyRow = (s) => {
    const product = s.product_id ? STATE.supplyProducts.find(p => p.id === s.product_id) : null;
    const photo = product ? productPhotoUrl(product) : null;
    return `
      <div class="list-card tone-slate" data-edit-supply="${s.id}" style="cursor:pointer">
        ${photo ? `<div style="width:44px;height:44px;border-radius:6px;overflow:hidden;flex:0 0 auto;margin-right:2px"><img src="${photo}" style="width:100%;height:100%;object-fit:cover;object-position:${photoPosition(product)};${photoTransformStyle(product)}opacity:0.75"></div>` : ""}
        <div class="list-card-main">
          <div style="font-weight:600">${esc(s.brand || s.description || s.category)}</div>
          <div class="list-card-desc dim">${esc(s.category)}${s.quantity ? ` · ${displayQty(s.quantity, s.unit)} ${esc(unitLabel(s.unit))}` : ""}</div>
          <div class="list-card-desc dim">${s.date_added ? `added ${fmtDate(s.date_added)}` : ""}${s.opened_at ? ` · opened ${fmtDate(s.opened_at)}` : ""}${s.date_emptied ? ` · emptied ${fmtDate(s.date_emptied)}` : ""}${s.opened_at && s.date_emptied ? ` · used over ${Math.max(1, daysSince(s.opened_at) - daysSince(s.date_emptied))}d` : ""}</div>
        </div>
        <div class="list-card-side">
          <button class="icon-btn" data-restore-supply="${s.id}" title="Not actually empty -- restore to Full" onclick="event.stopPropagation()">↺</button>
          <button class="icon-btn" data-del-supply-modal="${s.id}" title="Delete permanently" onclick="event.stopPropagation()">🗑</button>
        </div>
      </div>`;
  };
  return `
    <div class="form-head">Emptied (${emptyItems.length})</div>
    <div class="dim" style="font-size:12px;margin:8px 0 14px">Kept for your records — how long each one lasted stays intact for future cost/usage stats. Slide one back to a fill level if it was marked empty by mistake, or delete it for good.</div>
    ${emptyItems.length === 0 ? `<div class="empty">Nothing emptied yet.</div>` : `
    <div style="max-height:420px;overflow-y:auto">
      ${years.map((y, i) => `
      <details class="cost-breakdown-batch"${i === 0 ? " open" : ""}>
        <summary>
          <div class="cost-breakdown-batch-head">
            <span class="cost-breakdown-batch-name">${esc(y)}</span>
            <span class="cost-breakdown-batch-count dim">${byYear.get(y).length} emptied</span>
          </div>
        </summary>
        <div class="list-stack" style="padding-left:2px">${byYear.get(y).map(supplyRow).join("")}</div>
      </details>
      `).join("")}
    </div>
    `}
  `;
}

function wireEmptySupplyModal() {
  document.querySelectorAll("[data-edit-supply]").forEach(card => card.addEventListener("click", () => {
    const supply = STATE.supplies.find(s => s.id === card.dataset.editSupply);
    if (supply) openSupplyModal(supply);
  }));
  document.querySelectorAll("[data-restore-supply]").forEach(b => b.addEventListener("click", async () => {
    await localSupplyUpdate(b.dataset.restoreSupply, { status: "Full", date_emptied: null });
    showToast("Restored to Full", "update");
    await loadCoopData();
    refreshModalContent(emptySupplyModalHtml());
    wireEmptySupplyModal();
    renderSupplyInventory();
  }));
  document.querySelectorAll("[data-del-supply-modal]").forEach(b => b.addEventListener("click", async () => {
    if (!(await showConfirmDialog("Delete this supply item permanently? This can't be undone."))) return;
    await localSupplyDelete(b.dataset.delSupplyModal, currentCoopId);
    showToast("Supply item deleted", "delete");
    await loadCoopData();
    refreshModalContent(emptySupplyModalHtml());
    wireEmptySupplyModal();
    renderSupplyInventory();
  }));
}

function openEmptySupplyModal() {
  openModal(emptySupplyModalHtml());
  wireEmptySupplyModal();
}

/** A pile of identical Full bags (same category/description/quantity/unit)
 * collapses into one compact card with a count, instead of one big card per
 * bag -- buying 10 bags on a good sale shouldn't mean 10 cards. "Open one"
 * just opens the normal edit form for a single bag from the pile; once its
 * status changes from Full, it naturally becomes its own individual card and
 * the pile's count drops by one. */
function supplyGroupKey(s) { return `${s.category}|${s.brand || s.description || ""}|${s.quantity}|${s.unit || ""}`; }

function supplyGroupCardHtml(items) {
  const first = items[0];
  const count = items.length;
  const key = supplyGroupKey(first);
  const catTone = supplyCategoryTone(first.category);
  const amountLabel = first.quantity ? `${displayQty(first.quantity, first.unit)} ${esc(unitLabel(first.unit))} each` : "";
  // Any item in the group with a resolvable photo, not just whichever
  // happens to be first -- a group can end up mixing older items (created
  // before they were linked to a product) with newer, correctly-linked
  // ones, since grouping is based on matching description/quantity/unit,
  // not on having a consistent product link.
  let groupPhoto = null;
  let groupPhotoPos = "50% 50%";
  for (const it of items) {
    const p = it.product_id ? STATE.supplyProducts.find(x => x.id === it.product_id) : null;
    const url = p ? productPhotoUrl(p) : null;
    if (url) { groupPhoto = url; groupPhotoPos = photoPosition(p); break; }
  }
  const thumb = groupPhoto
    ? `<div style="width:48px;height:48px;border-radius:6px;overflow:hidden;flex:0 0 auto"><img src="${groupPhoto}" style="width:100%;height:100%;object-fit:cover;object-position:${groupPhotoPos}"></div>`
    : `<div style="width:48px;height:48px;border-radius:6px;flex:0 0 auto;background:color-mix(in srgb, var(--${catTone}) 12%, var(--bg));display:flex;align-items:center;justify-content:center;font-size:20px">📦</div>`;
  const line1 = first.brand || first.description || first.category;
  const line2 = (first.description && first.description !== line1) ? first.description : "";
  return `<div class="list-card tone-${catTone}" data-edit-group="${esc(key)}" style="cursor:pointer">
    ${thumb}
    <div class="list-card-main">
      <div style="font-weight:700">${esc(line1)}</div>
      <div class="list-card-desc dim">${esc(first.category)}${amountLabel ? ` · ${amountLabel}` : ""}</div>
      ${line2 ? `<div class="list-card-desc dim">${esc(line2)}</div>` : ""}
    </div>
    <div class="list-card-side">
      <span class="stamp tone-sage">Full × ${count}</span>
      <button class="btn ghost small supply-open-one-btn" data-open-one-supply="${first.id}" onclick="event.stopPropagation()">📦 Open one</button>
    </div>
  </div>`;
}

/** Splits a list of supply items into display cards: partial-status items
 * stay individual (they're what you're actively tracking), Full-status items
 * with identical category/description/quantity/unit collapse into one
 * grouped card. Returns { html, sortKey } entries pre-sorted the same way
 * the plain list would be (partial first, soonest-to-empty first). */
function buildSupplyEntries(items) {
  const partial = items.filter(s => s.status !== "Full" || s.opened_at);
  const full = items.filter(s => s.status === "Full" && !s.opened_at);
  const fullGroups = {};
  full.forEach(s => {
    const key = supplyGroupKey(s);
    (fullGroups[key] = fullGroups[key] || []).push(s);
  });
  // Grouped by category, not by fullness -- an opened bag's position stays
  // fixed (by date added) regardless of how its status changes, so dragging
  // a slider doesn't jump it around the list. Sealed-spare groups always
  // sort last within their category, since they're not actively in use yet.
  const entries = partial.map(s => ({ category: s.category, isGroup: false, sortKey: s.date_added || "", html: supplyCardHtml(s) }));
  Object.values(fullGroups).forEach(group => {
    const sortKey = [...group].sort((a, b) => (b.date_added || "").localeCompare(a.date_added || ""))[0].date_added || "";
    entries.push({ category: group[0].category, isGroup: true, sortKey, html: group.length > 1 ? supplyGroupCardHtml(group) : supplyCardHtml(group[0]) });
  });
  entries.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.isGroup !== b.isGroup) return a.isGroup ? 1 : -1;
    return b.sortKey.localeCompare(a.sortKey);
  });
  return entries;
}

let supplySubTab = "inventory";
function renderSupplyHub() {
  const el = document.getElementById("panel-bedding");
  const subs = [{ id: "inventory", label: "Inventory" }, { id: "freshness", label: "Freshness" }, { id: "products", label: "Products" }];
  el.innerHTML = `
    <div class="range-select sub-nav-fixed" id="supplySubNav">
      ${subs.map(s => `<button class="range-btn ${supplySubTab === s.id ? "active" : ""}" data-supplysub="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div id="supplySubContent"></div>
  `;
  el.querySelectorAll("[data-supplysub]").forEach(b => b.addEventListener("click", () => { supplySubTab = b.dataset.supplysub; renderSupplyHub(); }));
  if (supplySubTab === "inventory") renderSupplyInventory();
  else if (supplySubTab === "freshness") renderBeddingFreshness();
  else if (supplySubTab === "products") renderProductsSection();
}

function renderSupplyInventory() {
  const el = document.getElementById("supplySubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const emptyCount = STATE.supplies.filter(s => s.status === "Empty").length;
  const activeSupplies = STATE.supplies.filter(s => s.status !== "Empty");
  const feedEntries = buildSupplyEntries(activeSupplies.filter(s => FEED_SUPPLY_CATEGORIES.has(s.category)));
  const beddingEntries = buildSupplyEntries(activeSupplies.filter(s => !FEED_SUPPLY_CATEGORIES.has(s.category)));
  const pagedFeed = feedEntries.slice(0, feedSupplyVisibleCount);
  const pagedBedding = beddingEntries.slice(0, beddingSupplyVisibleCount);
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:4px">Feed &amp; Bedding Inventory</div>
    <div class="dim" style="font-size:12px;margin-bottom:12px">Bags/supplies logged with a quantity on the Finances tab show up here automatically as "Full." Tap a fullness dot as you work through one, or add something directly if you didn't buy it through an expense entry.</div>

    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${pagedFeed.length + pagedBedding.length} of ${feedEntries.length + beddingEntries.length} shown</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${emptyCount ? `<button class="btn ghost small" id="openEmptyModal">📦 Emptied (${emptyCount})</button>` : ""}
        <button class="btn ${selectionState.supplies.mode ? "btn-close" : "ghost"} small" id="toggleSupplySelectMode">${selectionState.supplies.mode ? "✕ Cancel selection" : "☑ Select"}</button>
        <button class="btn" id="toggleSupplyForm">+ Add supply item</button>
      </div>
    </div>

    ${selectedSupplyIds.size > 0 ? `
      <div class="form-block" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-color:var(--rust);margin-bottom:10px">
        <div><strong style="color:var(--text)">${selectedSupplyIds.size}</strong> selected</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-close small" id="supplyBulkDeleteBtn">Delete selected</button>
          <button class="btn ghost small" id="supplyClearSelection">Clear selection</button>
        </div>
      </div>
    ` : ""}

    ${feedEntries.length === 0 && beddingEntries.length === 0 ? `<div class="card"><div class="empty">${STATE.supplies.length === 0 ? "No supplies logged yet -- log a Feed or Bedding expense with a quantity, or add one directly." : "Nothing currently in stock -- check Emptied above, or add a new item."}</div></div>` : `
    <div class="supply-columns">
      <div${feedEntries.length > 0 && beddingEntries.length > 0 ? ` style="border-right:2px dashed var(--border);padding-right:20px"` : ""}>
        ${feedEntries.length > 0 ? `
          <div class="flock-section-header" style="border-bottom:2px dashed var(--border);padding-bottom:4px">🌾 Feed</div>
          <div class="supply-grid">${pagedFeed.map(e => e.html).join("")}</div>
          ${loadMoreButtonHtml(feedEntries.length, feedSupplyVisibleCount, "loadMoreFeedSupplyBtn")}
        ` : ""}
      </div>
      <div>
        ${beddingEntries.length > 0 ? `
          <div class="flock-section-header" style="border-bottom:2px dashed var(--border);padding-bottom:4px">🛏️ Bedding</div>
          <div class="supply-grid">${pagedBedding.map(e => e.html).join("")}</div>
          ${loadMoreButtonHtml(beddingEntries.length, beddingSupplyVisibleCount, "loadMoreBeddingSupplyBtn")}
        ` : ""}
      </div>
    </div>
    `}

    `;

  // ---- Supply inventory handlers ----
  document.getElementById("toggleSupplyForm").addEventListener("click", () => openSupplyModal(null));
  document.getElementById("toggleSupplySelectMode").addEventListener("click", () => {
    selectionState.supplies.mode = !selectionState.supplies.mode;
    if (!selectionState.supplies.mode) selectedSupplyIds.clear();
    renderSupplyInventory();
  });
  const openEmptyBtn = document.getElementById("openEmptyModal");
  if (openEmptyBtn) openEmptyBtn.addEventListener("click", () => openEmptySupplyModal());
  el.querySelectorAll(".supply-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedSupplyIds.add(cb.dataset.id); else selectedSupplyIds.delete(cb.dataset.id);
    renderSupplyInventory();
  }));
  const supplyBulkDeleteBtn = document.getElementById("supplyBulkDeleteBtn");
  if (supplyBulkDeleteBtn) supplyBulkDeleteBtn.addEventListener("click", async () => {
    const n = selectedSupplyIds.size;
    if (!(await showConfirmDialog(`Delete ${n} selected item${n !== 1 ? "s" : ""}? This can't be undone.`))) return;
    await localBulkDelete("supplies", [...selectedSupplyIds], currentCoopId);
    showToast(`${n} item${n !== 1 ? "s" : ""} deleted`, "delete");
    selectedSupplyIds.clear();
    STATE.supplies = await localGetAll("supplies", currentCoopId);
    renderSupplyInventory();
  });
  const supplyClearSelectionBtn = document.getElementById("supplyClearSelection");
  if (supplyClearSelectionBtn) supplyClearSelectionBtn.addEventListener("click", () => { selectedSupplyIds.clear(); renderSupplyInventory(); });
  const loadMoreFeedEl = document.getElementById("loadMoreFeedSupplyBtn");
  if (loadMoreFeedEl) loadMoreFeedEl.addEventListener("click", () => { feedSupplyVisibleCount += PAGE_SIZE; renderSupplyInventory(); });
  const loadMoreBeddingSupplyEl = document.getElementById("loadMoreBeddingSupplyBtn");
  if (loadMoreBeddingSupplyEl) loadMoreBeddingSupplyEl.addEventListener("click", () => { beddingSupplyVisibleCount += PAGE_SIZE; renderSupplyInventory(); });
  wireCardSelection(
    el.querySelectorAll("[data-edit-supply]"),
    selectedSupplyIds,
    "supplies",
    () => [...el.querySelectorAll("[data-edit-supply]")].map(c => c.dataset.id),
    (id) => openSupplyModal(STATE.supplies.find(s => s.id === id)),
    renderSupplyInventory
  );
  el.querySelectorAll("[data-open-one-supply]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    b.classList.add("tearing");
    b.disabled = true;
    await new Promise(resolve => setTimeout(resolve, 380)); // let the tear animation actually finish playing before the card re-renders out from under it
    await localSupplyUpdate(b.dataset.openOneSupply, { opened_at: todayStr() });
    STATE.supplies = await localGetAll("supplies", currentCoopId);
    showToast("Bag opened -- still tracked as Full until you use some", "update");
    renderSupplyInventory();
  }));
  el.querySelectorAll("[data-edit-group]").forEach(card => card.addEventListener("click", () => openSupplyGroupModal(card.dataset.editGroup)));
  el.querySelectorAll("[data-view-supply-photo]").forEach(t => t.addEventListener("click", (e) => {
    e.stopPropagation(); // the card itself opens the edit modal -- the photo opens full size instead
    showPhotoLightbox(t.dataset.viewSupplyPhoto);
  }));
  el.querySelectorAll(".fullness-pill").forEach(pill => pill.addEventListener("click", async (e) => {
    e.stopPropagation();
    const id = pill.dataset.id;
    const newStatus = pill.dataset.status;
    const existing = STATE.supplies.find(s => s.id === id);
    if (existing && existing.status === newStatus) return; // already this status -- nothing to do
    const payload = { status: newStatus };
    // date_emptied needs to be a two-way gate, not just set-on-reaching-Empty:
    // picking a fuller status again (correcting an accidental tap, or just
    // changing your mind) needs to clear it too, or the stale date keeps
    // counting this bag as "used" in usage totals long after it's no longer
    // actually empty.
    payload.date_emptied = newStatus === "Empty" ? todayStr() : null;
    // Any fullness change implies the bag has been handled -- mark it
    // opened (once, idempotently) so it stops being grouped with sealed
    // spares from here on, regardless of how little has actually been used.
    if (existing && !existing.opened_at) payload.opened_at = todayStr();
    await localSupplyUpdate(id, payload);
    showToast(`Marked ${newStatus}`, "update");
    refreshAndRender();
  }));

}

/** Just the form's own markup -- no outer .form-block wrapper, since the
 * modal panel itself already provides that card-like container. Kept as a
 * pure function of editingSupply so it's easy to reason about independent
 * of wherever it ends up being rendered. */
function supplyFormHtml(editingSupply) {
  return `
    <div class="form-head">${editingSupply ? "Edit supply item" : "Add a supply item"}</div>

    <div style="${FORM_SECTION_HEAD}">Identity</div>
    <div class="grid-form">
      <label class="field"><span>Category</span><select id="sp_category">${[...QUANTITY_CATEGORIES].map(c => `<option ${editingSupply && editingSupply.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field"><span>Brand</span><input id="sp_brand" placeholder="e.g. Purina Layena" value="${editingSupply ? esc(editingSupply.brand || "") : ""}"></label>
      <label class="field"><span>Description</span><input id="sp_desc" placeholder="e.g. large bag, opened" value="${editingSupply ? esc(editingSupply.description || "") : ""}"></label>
    </div>

    <div style="${FORM_SECTION_HEAD}">Quantity & Cost</div>
    <div class="grid-form">
      <label class="field"><span>Quantity (per item)</span><input type="number" step="0.01" id="sp_qty" value="${editingSupply && editingSupply.quantity != null ? displayQty(editingSupply.quantity, editingSupply.unit) : ""}"></label>
      <label class="field"><span>Unit</span><select id="sp_unit">${unitOptionsHtml(editingSupply && editingSupply.unit)}</select></label>
      <label class="field"><span>Cost for this item ${editingSupply && editingSupply.source_expense_id ? "(from its expense)" : "*"}</span><input type="number" step="0.01" min="0" id="sp_cost" value="${(() => {
        if (!editingSupply) return "";
        if (editingSupply.cost != null) return editingSupply.cost;
        // Legacy bag created from an expense before costs were stored: derive
        // its share of that expense (expense total / bags it created) so the
        // field is pre-filled rather than blank.
        if (editingSupply.source_expense_id) {
          const exp = STATE.expenses.find(x => x.id === editingSupply.source_expense_id);
          if (exp) {
            const siblingCount = STATE.supplies.filter(s => s.source_expense_id === editingSupply.source_expense_id).length || 1;
            return ((Number(exp.amount) || 0) / siblingCount).toFixed(2);
          }
        }
        return "";
      })()}" placeholder="e.g. 22.50"><span class="dim" style="font-size:11px;margin-top:4px">Required. Auto-filled from the linked expense when there is one; you can override it. Powers the feed cost per lb, cost per dozen eggs, and cost per lb of meat figures.</span></label>
      ${!editingSupply ? `<label class="field"><span>Number of items</span><input type="number" min="1" max="500" step="1" id="sp_count" value="1" placeholder="e.g. 3 for three separate bags"></label>` : ""}
    </div>
    ${!editingSupply ? `<div id="productPickerHost">${renderProductPickerRow([...QUANTITY_CATEGORIES][0])}</div>` : ""}

    <div style="${FORM_SECTION_HEAD}">Status & Timeline</div>
    <div class="grid-form">
      <label class="field"><span>Status</span><select id="sp_status">${SUPPLY_STATUSES.map(s => `<option ${(editingSupply ? editingSupply.status === s : s === "Full") ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field"><span>Date added</span><input type="date" id="sp_date" value="${editingSupply ? (editingSupply.date_added || todayStr()) : todayStr()}"></label>
      ${editingSupply ? `<label class="field"><span>Date emptied${editingSupply.status !== "Empty" ? " (if applicable)" : ""}</span><input type="date" id="sp_date_emptied" value="${editingSupply.date_emptied || ""}"></label>` : ""}
    </div>
    ${editingSupply ? `
    <label class="field" style="display:flex;flex-direction:row;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="sp_opened" ${editingSupply.opened_at ? "checked" : ""} style="width:auto"><span>Opened -- won't group with sealed spares even at Full</span></label>
    <label class="field" id="sp_opened_date_field" style="margin-top:8px;${editingSupply.opened_at ? "" : "display:none"}"><span>Date opened</span><input type="date" id="sp_opened_at" value="${editingSupply.opened_at || todayStr()}"><span class="dim" style="font-size:11px;margin-top:4px">Feed usage is drawn as a straight line from this date (0 used) to the emptied date (fully used). Correcting an opened date fixes the curve and the daily-average estimate.</span></label>
    ` : ""}
    ${editingSupply && editingSupply.opened_at && editingSupply.status !== "Empty" ? `
    <div class="note-box" style="margin-top:14px">
      <strong style="color:var(--text)">Not going to finish this bag for a while?</strong> Leaving it open keeps spreading its cost thinner every day that passes, even on days nothing was eaten -- so a bag set aside for months would understate what it actually cost per day while it was really in use, and that number would keep drifting the longer it sits. Closing it out now locks in the real cost for the time it was actually used, splitting both the amount AND the cost between what's really been eaten and what's left -- so the leftover carries its own fair share of what you paid, not a discount, and this batch isn't charged for food it never got to.
      <div style="margin-top:8px"><button class="btn ghost small" id="closeOutRemainderBtn">📦 Close out &amp; store the rest</button></div>
    </div>
    ` : ""}
    ${!editingSupply ? `<div class="dim" style="font-size:11px;margin-top:8px">Buying multiple bags at once? Set the count above -- each one is added as its own separate, independently trackable item rather than a single item marked "3 bags." Identical full bags collapse into one compact card automatically -- "Open one" peels a single bag off to track it on its own.</div>` : ""}
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveSupply">${editingSupply ? "✓ Save changes" : "+ Add item"}</button>
    </div>
  `;
}

/** Wires up everything inside the form -- unchanged from before the modal
 * conversion, just operating on whatever container the form's HTML
 * actually ended up in (the modal content area), found the same way it
 * always was: by element id, which doesn't care where in the DOM it lives. */
function wireSupplyForm(editingSupply) {
  applyFeedUnitLock("sp_category", "sp_unit");
  const productPickerHost = document.getElementById("productPickerHost");
  const rerenderPicker = () => { productPickerHost.innerHTML = renderProductPickerRow(document.getElementById("sp_category").value); wireProductPicker(productPickerHost, pickerCfg); };
  const pickerCfg = { categoryFieldId: "sp_category", brandFieldId: "sp_brand", descFieldId: "sp_desc", qtyFieldId: "sp_qty", unitFieldId: "sp_unit", rerenderFn: rerenderPicker };
  if (productPickerHost) {
    wireProductPicker(productPickerHost, pickerCfg);
    document.getElementById("sp_category").addEventListener("change", rerenderPicker);
  }
  // Show the opened-date field only when "Opened" is checked -- an unopened
  // bag has no opened date to set.
  const openedToggle = document.getElementById("sp_opened");
  const openedDateField = document.getElementById("sp_opened_date_field");
  if (openedToggle && openedDateField) {
    openedToggle.addEventListener("change", () => { openedDateField.style.display = openedToggle.checked ? "" : "none"; });
  }
  const closeOutBtn = document.getElementById("closeOutRemainderBtn");
  if (closeOutBtn) closeOutBtn.addEventListener("click", async () => {
    const consumedFraction = STATUS_USED_FRACTION[editingSupply.status] ?? 0;
    const remainingFraction = 1 - consumedFraction;
    const originalQty = Number(editingSupply.quantity) || 0;
    const originalCost = Number(editingSupply.cost) || 0;
    const remainingQty = originalQty * remainingFraction;
    if (!(remainingQty > 0)) { showToast("Nothing left to carry over -- this bag is already fully used.", "update"); return; }
    if (!(await showConfirmDialog(`Close out this bag as of today, and carry the remaining ${displayQty(remainingQty, editingSupply.unit)} ${unitLabel(editingSupply.unit)} over as a new, unopened item? It keeps its own fair share of what this bag cost (${fmtMoney(originalCost * remainingFraction)}), so whichever batch eats it later is charged for it -- not this one, and not for free either.`, "Close out"))) return;
    // Marking a bag Empty tells the app the WHOLE recorded quantity was used
    // across the real open-to-emptied window -- that's true for a bag that
    // genuinely ran out, but not here, where only part of it really got
    // eaten. Both the quantity AND cost on the ORIGINAL record need to
    // shrink to just the truly-consumed share, or the finishing batch gets
    // charged for food it never ate, and the leftover carries none of what
    // it actually cost -- silently free to whichever batch opens it next.
    await localSupplyUpdate(editingSupply.id, {
      quantity: originalQty * consumedFraction, cost: originalCost * consumedFraction,
      status: "Empty", date_emptied: todayStr(),
    });
    await localSupplyCreate({
      coop_id: currentCoopId, category: editingSupply.category, brand: editingSupply.brand, description: editingSupply.description,
      quantity: remainingQty, unit: editingSupply.unit, cost: originalCost * remainingFraction, status: "Full", date_added: todayStr(), opened_at: null,
    }, { suppressUndo: true }); // one undo entry (the close-out) reads more clearly than two separate ones for what's really one action
    showToast("Closed out -- the remainder is now a stored, unopened item with its own fair share of the cost", "update");
    closeModal();
    refreshAndRender();
  });
  document.getElementById("saveSupply").addEventListener("click", async () => {
    const status = document.getElementById("sp_status").value;
    // Cost is required -- every bag needs a cost so feed cost-per-lb, cost per
    // dozen, and cost per lb of meat are always complete (no unpriced feed
    // silently dragging the figures down). Bags created from an expense get it
    // auto-filled; a bag added directly must have one entered.
    const costEl = document.getElementById("sp_cost");
    if (costEl && (costEl.value === "" || !(Number(costEl.value) >= 0))) {
      alert("Please enter the cost for this item. Every inventory item needs a cost so feed and production cost figures stay accurate.");
      costEl.focus();
      return;
    }
    const dateEmptiedEl = document.getElementById("sp_date_emptied");
    const openedEl = document.getElementById("sp_opened");
    // Guard: an opened date after the emptied date would produce a negative
    // span and a nonsensical ramp. Catch it here with a clear message rather
    // than silently saving something the chart can't draw.
    if (openedEl && openedEl.checked) {
      const openedVal = (document.getElementById("sp_opened_at") || {}).value;
      const emptiedVal = status === "Empty" ? ((dateEmptiedEl && dateEmptiedEl.value) || editingSupply?.date_emptied) : null;
      if (openedVal && emptiedVal && openedVal > emptiedVal) {
        alert("The opened date can't be after the emptied date -- a bag has to be opened before it's finished.");
        return;
      }
    }
    const payload = {
      coop_id: currentCoopId,
      category: document.getElementById("sp_category").value,
      brand: document.getElementById("sp_brand").value,
      description: document.getElementById("sp_desc").value,
      // Weights are typed in the toggle unit and stored canonically in lb.
      quantity: parseQtyInput(document.getElementById("sp_qty").value, document.getElementById("sp_unit").value),
      unit: document.getElementById("sp_unit").value,
      cost: document.getElementById("sp_cost") && document.getElementById("sp_cost").value !== "" ? Number(document.getElementById("sp_cost").value) : null,
      status,
      date_added: document.getElementById("sp_date").value,
      // Respects an explicitly back-dated value, but only when the final
      // status is actually Empty -- still forced to null otherwise, same
      // reasoning as the earlier fix: a status corrected away from Empty
      // must not leave a stale emptied date behind.
      date_emptied: status === "Empty" ? ((dateEmptiedEl && dateEmptiedEl.value) || editingSupply?.date_emptied || todayStr()) : null,
      // Opened date is now explicitly editable (was implicitly "today").
      // Checkbox off clears it entirely; checkbox on uses whatever's in the
      // date field, falling back to a preserved value or today. This is the
      // fix for a bag whose opened date was wrong and skewed its usage ramp.
      opened_at: (() => {
        if (!openedEl) return editingSupply?.opened_at || null;
        if (!openedEl.checked) return null;
        const openedDateEl = document.getElementById("sp_opened_at");
        return (openedDateEl && openedDateEl.value) || editingSupply?.opened_at || todayStr();
      })(),
    };
    if (editingSupply) {
      await localSupplyUpdate(editingSupply.id, payload);
      showToast("Supply item updated", "update");
    } else {
      const undoOps = [];
      if (selectedProductId) {
        const productBefore = STATE.supplyProducts.find(p => p.id === selectedProductId);
        const productAfter = await localSupplyProductUpdate(selectedProductId, { last_used_at: todayStr() }, { suppressUndo: true });
        undoOps.push({ resource: "supply_products", id: selectedProductId, before: productBefore, after: productAfter });
        payload.product_id = selectedProductId;
      }
      const countEl = document.getElementById("sp_count");
      const count = countEl ? Math.max(1, Number(countEl.value) || 1) : 1;
      if (count > 500) { alert("That's a lot of separate items to add at once -- try 500 or fewer at a time"); return; }
      const created = await localBulkCreate("supplies", Array.from({ length: count }, () => payload), { suppressUndo: true });
      undoOps.push(...created.map(r => ({ resource: "supplies", id: r.id, before: null, after: r })));
      pushUndoAction(count === 1 ? "Added supply item" : `Added ${count} supply items`, undoOps);
      showToast(count > 1 ? `${count} items added` : "Supply item added", "create");
    }
    closeModal();
    refreshAndRender();
  });
}

/** Single entry point for both "+ Add supply item" (pass null) and editing
 * an existing card (pass that supply). Replaces the old pattern of setting
 * module-level open/editing state and re-rendering the whole inline panel
 * just to reveal a form -- the modal is a separate layer now, so opening
 * it doesn't touch the list underneath at all. */
function openSupplyModal(supply) {
  selectedProductId = null;
  editingProductId = null;
  newProductFormOpen = false;
  openModal(
    supplyFormHtml(supply),
    () => { selectedProductId = null; editingProductId = null; newProductFormOpen = false; },
    supply ? () => confirmAndDelete(
      "Delete this supply item permanently? This can't be undone.",
      () => localSupplyDelete(supply.id, currentCoopId),
      "Supply item deleted",
      refreshAndRender
    ) : null
  );
  wireSupplyForm(supply);
}

function renderBeddingFreshness() {
  const el = document.getElementById("supplySubContent");
  if (!currentCoopId) { el.innerHTML = noCoopMessage(); return; }
  const years = yearsFromDates(STATE.bedding, "date");
  const filtered = STATE.bedding.filter(b =>
    (!beddingFilters.area || b.area === beddingFilters.area)
    && (!beddingFilters.entryType || b.entry_type === beddingFilters.entryType)
    && (!beddingFilters.year || b.date.slice(0, 4) === beddingFilters.year)
  );
  const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date));
  const anyFilter = beddingFilters.area || beddingFilters.entryType || beddingFilters.year;
  el.innerHTML = `
    <div class="card-title" style="margin-bottom:4px">Bedding Freshness</div>
    <div class="grid-stats" style="margin-bottom:16px">
      ${getBeddingAreas().map(area => {
        const bs = beddingStatsFor(area);
        const t = getBeddingThresholds(area);
        const daysSinceCleanout = bs.lastCleanout ? daysSince(bs.lastCleanout.date) : null;
        const daysSinceActivity = bs.lastActivity ? daysSince(bs.lastActivity.date) : null;
        const daysSinceChurn = bs.lastChurn ? daysSince(bs.lastChurn.date) : null;
        const cleanoutToneInfo = cleanoutTone(daysSinceCleanout, area);
        const daysUntilCleanout = daysSinceCleanout !== null ? t.danger - daysSinceCleanout : null;
        const daysUntilChurn = daysSinceChurn !== null ? t.churn - daysSinceChurn : null;
        const cleanoutLabel = daysUntilCleanout === null ? "no clean-out logged"
          : daysUntilCleanout < 0 ? `overdue ${-daysUntilCleanout}d`
          : daysUntilCleanout === 0 ? "due today"
          : `in ${daysUntilCleanout}d`;
        const churnToneClass = daysUntilChurn === null ? "slate" : daysUntilChurn <= 0 ? "gold" : "sage";
        const churnLabel = daysUntilChurn === null ? "no churn logged"
          : daysUntilChurn < 0 ? `overdue ${-daysUntilChurn}d`
          : daysUntilChurn === 0 ? "due today"
          : `in ${daysUntilChurn}d`;
        return `<div class="stat tone-${cleanoutToneInfo.tone === "danger" ? "" : cleanoutToneInfo.tone}">
          <div class="stat-label">${esc(area)}</div>
          <div class="stat-value">${daysSinceActivity !== null ? daysSinceActivity + "d" : "—"}</div>
          <div class="stat-sub">last activity${bs.lastCleanout ? ` · last material: ${esc(bs.lastCleanout.material)}` : ""}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <span class="stamp tone-${cleanoutToneInfo.tone}">${daysUntilCleanout === null ? cleanoutLabel : "Clean-out " + cleanoutLabel}</span>
            <span class="stamp tone-${churnToneClass}">${daysUntilChurn === null ? churnLabel : "Churn " + churnLabel}</span>
          </div>
        </div>`;
      }).join("")}
    </div>

    <div class="toolbar" style="margin-bottom:10px">
      <div class="dim">${sorted.length} of ${STATE.bedding.length} shown</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost small" id="openBedThresholds" title="Add/remove/reorder tracking areas, and set warn/overdue timing for each">⚙ Areas &amp; thresholds</button>
        <button class="btn ghost small" id="toggleBedFilters">Filters${anyFilter ? " (on)" : ""} ${beddingFiltersOpen ? "▾" : "▸"}</button>
        ${selectModeButtonHtml("bedding", "toggleBeddingSelectMode")}
        <button class="btn" id="toggleBedForm">+ Add entry</button>
      </div>
    </div>

    ${bulkDeleteBarHtml(selectedBeddingIds)}

    ${beddingFiltersOpen ? `
    <div class="form-block" style="padding:12px 16px">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <label class="field"><span>Area</span><select id="filterBedArea"><option value="">All areas</option>${[...new Set([...getBeddingAreas(), ...STATE.bedding.map(b => b.area)])].map(a => `<option value="${a}" ${beddingFilters.area === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
        <label class="field"><span>Type</span><select id="filterBedType"><option value="">All types</option>${BEDDING_TYPES.map(t => `<option value="${t}" ${beddingFilters.entryType === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field"><span>Year</span><select id="filterBedYear"><option value="">All years</option>${years.map(y => `<option value="${y}" ${beddingFilters.year === y ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      </div>
      ${anyFilter ? `<div style="margin-top:10px"><button class="btn ghost small" id="clearBedFilters">Clear filters</button></div>` : ""}
    </div>
    ` : ""}

    ${sorted.length === 0 ? `<div class="card"><div class="empty">${STATE.bedding.length === 0 ? "No bedding changes logged yet." : "No entries match these filters."}</div></div>` : (() => {
      const visible = sorted.slice(0, beddingVisibleCount);
      return `
    <div class="list-stack">
      ${visible.map(b => `
        <div class="list-card tone-${b.entry_type === "Full Clean-out" ? "sage" : "gold"}${selectedBeddingIds.has(b.id) ? " card-selected" : ""}" data-edit="${b.id}" data-id="${b.id}" style="cursor:pointer">
          ${selectionState.bedding.mode ? `<input type="checkbox" class="list-card-check bedding-check" data-id="${b.id}" ${selectedBeddingIds.has(b.id) ? "checked" : ""} onclick="event.stopPropagation()">` : ""}
          <div class="list-card-main">
            <div style="font-weight:600">${esc(b.area)}</div>
            <div class="list-card-desc dim">${fmtDate(b.date)} · ${esc(b.material)}${b.notes ? " · " + esc(b.notes) : ""}</div>
          </div>
          <div class="list-card-side">
            <span class="stamp tone-${b.entry_type === "Full Clean-out" ? "sage" : "gold"}">${esc(b.entry_type)}</span>
          </div>
        </div>`).join("")}
    </div>
    ${loadMoreButtonHtml(sorted.length, beddingVisibleCount)}`;
    })()}
  `;

  document.getElementById("toggleBedForm").addEventListener("click", () => openBeddingModal(null));
  document.getElementById("openBedThresholds").addEventListener("click", () => openBeddingThresholdsModal());
  document.getElementById("toggleBedFilters").addEventListener("click", () => { beddingFiltersOpen = !beddingFiltersOpen; renderBeddingFreshness(); });
  const filterAreaEl = document.getElementById("filterBedArea");
  if (filterAreaEl) filterAreaEl.addEventListener("change", (e) => { beddingFilters.area = e.target.value; beddingVisibleCount = PAGE_SIZE; renderBeddingFreshness(); });
  const filterTypeEl = document.getElementById("filterBedType");
  if (filterTypeEl) filterTypeEl.addEventListener("change", (e) => { beddingFilters.entryType = e.target.value; beddingVisibleCount = PAGE_SIZE; renderBeddingFreshness(); });
  const filterYearEl = document.getElementById("filterBedYear");
  if (filterYearEl) filterYearEl.addEventListener("change", (e) => { beddingFilters.year = e.target.value; beddingVisibleCount = PAGE_SIZE; renderBeddingFreshness(); });
  const clearBtn = document.getElementById("clearBedFilters");
  if (clearBtn) clearBtn.addEventListener("click", () => { beddingFilters = { area: "", entryType: "", year: "" }; beddingVisibleCount = PAGE_SIZE; renderBeddingFreshness(); });
  const loadMoreEl = document.getElementById("loadMoreBtn");
  if (loadMoreEl) loadMoreEl.addEventListener("click", () => { beddingVisibleCount += PAGE_SIZE; renderBeddingFreshness(); });
  el.querySelectorAll(".bedding-check").forEach(cb => cb.addEventListener("change", (e) => {
    if (e.target.checked) selectedBeddingIds.add(cb.dataset.id); else selectedBeddingIds.delete(cb.dataset.id);
    renderBeddingFreshness();
  }));
  wireCardSelection(
    el.querySelectorAll("[data-edit]"),
    selectedBeddingIds,
    "bedding",
    () => [...el.querySelectorAll("[data-edit]")].map(c => c.dataset.id),
    (id) => openBeddingModal(STATE.bedding.find(b => b.id === id)),
    renderBeddingFreshness
  );
  document.getElementById("toggleBeddingSelectMode").addEventListener("click", () => {
    selectionState.bedding.mode = !selectionState.bedding.mode;
    if (!selectionState.bedding.mode) selectedBeddingIds.clear();
    renderBeddingFreshness();
  });
  wireBulkDeleteBar(selectedBeddingIds, "bedding", "entry", async () => { STATE.bedding = await localGetAll("bedding", currentCoopId); }, renderBeddingFreshness, "entries");
}

function beddingFormHtml(editing) {
  return `
    <div class="form-head">${editing ? "Edit bedding entry" : "Log a bedding change"}</div>
    <div class="grid-form">
      <label class="field"><span>Date</span><input type="date" id="d_date" value="${editing ? editing.date : todayStr()}"></label>
      <label class="field"><span>Area</span><select id="d_area">${getBeddingAreas().map(a => `<option ${editing && editing.area === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
      <label class="field"><span>Entry type</span><select id="d_type">${BEDDING_TYPES.map(t => `<option ${editing && editing.entry_type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="field"><span>Material</span><select id="d_material">${BEDDING_MATERIALS.map(m => `<option ${editing && editing.material === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      <label class="field"><span>Notes</span><input id="d_notes" placeholder="optional" value="${editing ? esc(editing.notes || "") : ""}"></label>
    </div>
    <div class="note-box" style="margin-top:10px"><strong style="color:var(--text)">Top-off</strong> is adding fresh material without stirring. <strong style="color:var(--text)">Churn</strong> is stirring what's already there without adding anything. <strong style="color:var(--text)">Top-off + Churn</strong> is both in the same visit. Only Churn and Top-off + Churn count toward the churn-due countdown above -- topping off alone doesn't reset it. Use <strong style="color:var(--text)">Full Clean-out</strong> when the coop or run is emptied down to bare floor.</div>
    <div class="modal-actions">
      <button class="btn btn-confirm" id="saveBedding">${editing ? "✓ Save changes" : "+ Add entry"}</button>
    </div>
  `;
}

function openBeddingModal(editing) {
  editingBeddingId = editing ? editing.id : null;
  openModal(
    beddingFormHtml(editing),
    () => { editingBeddingId = null; },
    editing ? () => confirmAndDelete(
      "Delete this bedding entry? This can't be undone.",
      () => localBeddingDelete(editing.id, currentCoopId),
      "Bedding entry deleted",
      refreshAndRender
    ) : null
  );
  document.getElementById("saveBedding").addEventListener("click", async () => {
    const payload = {
      coop_id: currentCoopId,
      date: document.getElementById("d_date").value,
      area: document.getElementById("d_area").value,
      entry_type: document.getElementById("d_type").value,
      material: document.getElementById("d_material").value,
      notes: document.getElementById("d_notes").value,
    };
    if (editing) await localBeddingUpdate(editing.id, payload);
    else await localBeddingCreate(payload);
    showToast(editing ? "Bedding entry updated" : "Bedding entry added", editing ? "update" : "create");
    closeModal();
    refreshAndRender();
  });
}

