"""Generic CRUD and incremental sync for every SCHEMA resource.

These catch-all routes (/api/{resource}...) must be registered AFTER every
specific /api/... route, or they shadow them. (That ordering was once wrong,
which silently made DELETE /api/integrations/key unreachable.)

Sync model, in one paragraph: every row carries `updated_at`, stamped by the
server's transaction clock (see db.py) -- never by a client. Deletes are
soft (`deleted_at` + a bumped `updated_at`) so a device that was offline can
learn a row is gone. Clients pull `GET /api/sync/<resource>?since=<cursor>`
and store the `server_time` it returns as their next cursor. Because that
value comes from the same snapshot the rows were read from, a row can never be
committed "behind" a cursor a client already holds.
"""
import json
import uuid

from fastapi import APIRouter, Body, HTTPException

from .db import get_db, now_iso, read_sync_cursor
from .events import GLOBAL_CHANNEL, sse_publish
from .photos import cascade_delete_bird_photos, delete_photo_file
from .schema import SCHEMA, SCOPED

router = APIRouter()

MAX_BULK_ITEMS = 1000
MAX_BULK_IDS = 2000
MAX_ID_LENGTH = 64
MAX_SYNC_PAGE = 5000


# ----------------------------------------------------------------- helpers

def _require_resource(resource: str) -> None:
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")


def _clean_id(value) -> str:
    """A client-supplied id (the local-first engine mints ids on-device so an
    offline create already has its final id), or a fresh one."""
    if value is None or value == "":
        return uuid.uuid4().hex[:12]
    if not isinstance(value, str) or len(value) > MAX_ID_LENGTH or any(c.isspace() or c == "/" for c in value):
        raise HTTPException(400, f"id must be a string of at most {MAX_ID_LENGTH} characters, without spaces or slashes")
    return value


def _scalar(value):
    """SQLite binds scalars only. Structured values (a coop's settings object)
    are stored as JSON text rather than crashing the request."""
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, bool):
        return int(value)
    return value


def _coop_of(conn, resource: str, item_id: str):
    if resource == "coops":
        return GLOBAL_CHANNEL
    if resource not in SCOPED:
        return None
    row = conn.execute(f"SELECT coop_id FROM {resource} WHERE id = ?", (item_id,)).fetchone()
    return row["coop_id"] if row else None


def _insert_if_absent(conn, resource: str, payload: dict):
    """Create a row, or return the existing one untouched. -> (row, created).

    A create is idempotent by id: the client may legitimately send the same
    create twice (the connection dropped after the server committed but before
    the client saw the reply). The retry must be a no-op. It used to *overwrite*
    the row with the original create payload -- which silently undid any edit
    another device had made in between."""
    item_id = _clean_id(payload.get("id"))
    existing = conn.execute(f"SELECT * FROM {resource} WHERE id = ?", (item_id,)).fetchone()
    if existing:
        return dict(existing), False
    cols = SCHEMA[resource]
    present = [c for c in cols if c in payload]
    fields = ["id", "updated_at"] + present
    values = [item_id, now_iso()] + [_scalar(payload[c]) for c in present]
    col_list = ", ".join(f'"{f}"' for f in fields)
    placeholders = ", ".join("?" for _ in fields)
    conn.execute(f"INSERT INTO {resource} ({col_list}) VALUES ({placeholders})", values)
    return dict(conn.execute(f"SELECT * FROM {resource} WHERE id = ?", (item_id,)).fetchone()), True


def _update_fields(conn, resource: str, item_id: str, fields: dict):
    """Apply a partial update. Returns the new row, or None if no such row.

    Fields are merged one by one, so two devices editing *different* fields of
    the same record both land; the same field is last-write-wins by arrival.

    Clearing deleted_at is deliberate: an edit that reaches the server after a
    delete means "I am actively saving this" -- treated as intent for the
    record to exist rather than landing silently in a row that stays hidden."""
    cols = SCHEMA[resource]
    present = [c for c in cols if c in fields]
    if not present:
        return None
    set_clause = ", ".join(f'"{c}" = ?' for c in present) + ', "updated_at" = ?, "deleted_at" = NULL'
    cur = conn.execute(
        f"UPDATE {resource} SET {set_clause} WHERE id = ?",
        [_scalar(fields[c]) for c in present] + [now_iso(), item_id],
    )
    if cur.rowcount == 0:
        return None
    return dict(conn.execute(f"SELECT * FROM {resource} WHERE id = ?", (item_id,)).fetchone())


def _soft_delete(conn, resource: str, item_id: str, now: str) -> bool:
    """Tombstone one row and everything that hangs off it. True if it was live.

    Cascades are tombstoned too (not hard-deleted) so every other device is
    told about them on its next pull -- otherwise they linger as invisible
    live orphans: counted, synced, and carried in every backup."""
    photo = None
    if resource in ("birds", "bird_photos", "supply_products"):
        row = conn.execute(f"SELECT photo FROM {resource} WHERE id = ?", (item_id,)).fetchone()
        photo = row["photo"] if row else None
    cur = conn.execute(
        f"UPDATE {resource} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        (now, now, item_id),
    )
    if cur.rowcount == 0:
        return False
    if resource == "birds":
        conn.execute("UPDATE bird_logs SET deleted_at = ?, updated_at = ? WHERE bird_id = ? AND deleted_at IS NULL", (now, now, item_id))
        cascade_delete_bird_photos(conn, item_id, now)
    elif resource == "hatches":
        conn.execute("UPDATE hatch_eggs SET deleted_at = ?, updated_at = ? WHERE hatch_id = ? AND deleted_at IS NULL", (now, now, item_id))
    if photo:
        delete_photo_file(conn, photo)  # after the tombstone, so a shared photo isn't seen as still referenced by this row
    return True


def _publish(coops: set, resource: str) -> None:
    for coop_id in (coops or {GLOBAL_CHANNEL}):
        sse_publish(coop_id, resource)


# -------------------------------------------------------------------- reads

@router.get("/api/{resource}")
def list_items(resource: str, coop_id: str | None = None):
    _require_resource(resource)
    if resource in SCOPED and not coop_id:
        raise HTTPException(400, "coop_id query parameter is required")
    with get_db(write=False) as conn:
        if resource in SCOPED:
            order = "ORDER BY date DESC" if "date" in SCHEMA[resource] else ""
            rows = conn.execute(f"SELECT * FROM {resource} WHERE coop_id = ? AND deleted_at IS NULL {order}", (coop_id,)).fetchall()
        else:
            rows = conn.execute(f"SELECT * FROM {resource} WHERE deleted_at IS NULL").fetchall()
        return [dict(r) for r in rows]


@router.get("/api/sync/{resource}")
def sync_resource(resource: str, coop_id: str | None = None, since: str | None = None, limit: int | None = None):
    """Every row changed (created, updated, or soft-deleted) after `since`,
    tombstones included -- the generic list endpoint hides those. A
    local-first client applies upserts and removes anything with `deleted_at`.
    Omit `since` for an initial full sync.

    `server_time` is the cursor to send as `since` next time. It is NOT the
    wall clock: it is the committed sync-clock value read in the same snapshot
    as the rows, so it is safe by construction (see db.py).

    Pass `limit` to page: at most `limit` rows are returned (plus any rows
    sharing the last row's timestamp, so a transaction is never split across
    pages), `has_more` says whether to call again, and `server_time` then
    points at the end of this page. Without `limit` everything is returned,
    exactly as older clients expect."""
    _require_resource(resource)
    if resource in SCOPED and not coop_id:
        raise HTTPException(400, "coop_id query parameter is required")
    if limit is not None and not (1 <= limit <= MAX_SYNC_PAGE):
        raise HTTPException(400, f"limit must be between 1 and {MAX_SYNC_PAGE}")
    with get_db(write=False) as conn:
        cursor = read_sync_cursor(conn)  # first, inside the snapshot, so it can never be ahead of the rows
        clauses, params = [], []
        if resource in SCOPED:
            clauses.append("coop_id = ?")
            params.append(coop_id)
        if since:
            clauses.append("updated_at > ?")
            params.append(since)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        has_more = False
        if limit is None:
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {resource} {where} ORDER BY updated_at ASC, id ASC", params)]
        else:
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {resource} {where} ORDER BY updated_at ASC, id ASC LIMIT ?", params + [limit])]
            if len(rows) == limit:
                last_ts = rows[-1]["updated_at"]
                seen = {r["id"] for r in rows}
                tail_clauses = [c for c in clauses if c != "updated_at > ?"] + ["updated_at = ?"]
                tail_params = [p for c, p in zip(clauses, params, strict=True) if c != "updated_at > ?"] + [last_ts]
                rows += [dict(r) for r in conn.execute(
                    f"SELECT * FROM {resource} WHERE {' AND '.join(tail_clauses)} ORDER BY id ASC", tail_params,
                ) if r["id"] not in seen]
                cursor, has_more = last_ts, True
    return {"server_time": cursor, "rows": rows, "has_more": has_more}


# ------------------------------------------------------------------- writes

@router.post("/api/{resource}/bulk-delete-items")
def delete_items_bulk(resource: str, payload: dict = Body(...)):
    _require_resource(resource)
    ids = payload.get("ids")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "ids must be a non-empty list")
    if len(ids) > MAX_BULK_IDS:
        raise HTTPException(400, f"That's a lot of items to delete at once -- try {MAX_BULK_IDS} or fewer at a time")
    deleted_ids, coops = [], set()
    with get_db() as conn:
        now = now_iso()
        for item_id in ids:
            coop = _coop_of(conn, resource, item_id)
            if _soft_delete(conn, resource, item_id, now):
                deleted_ids.append(item_id)
                if coop:
                    coops.add(coop)
        _publish(coops, resource)
    return {"deleted": len(deleted_ids), "ids": deleted_ids}


@router.post("/api/{resource}/bulk-update-items")
def update_items_bulk(resource: str, payload: dict = Body(...)):
    _require_resource(resource)
    updates = payload.get("updates")
    if not isinstance(updates, list) or not updates:
        raise HTTPException(400, "updates must be a non-empty list of {id, fields} objects")
    if len(updates) > MAX_BULK_IDS:
        raise HTTPException(400, f"That's a lot of items to update at once -- try {MAX_BULK_IDS} or fewer at a time")
    updated_ids, coops = [], set()
    with get_db() as conn:
        for entry in updates:
            item_id, fields = entry.get("id"), entry.get("fields") or {}
            if not item_id:
                continue
            row = _update_fields(conn, resource, item_id, fields)
            if row:
                updated_ids.append(item_id)
                coops.add(GLOBAL_CHANNEL if resource == "coops" else row.get("coop_id"))
        _publish({c for c in coops if c}, resource)
    return {"updated": len(updated_ids), "ids": updated_ids}


@router.post("/api/{resource}/bulk-create")
def create_items_bulk(resource: str, payload: dict = Body(...)):
    _require_resource(resource)
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "items must be a non-empty list")
    if len(items) > MAX_BULK_ITEMS:
        raise HTTPException(400, f"That's a lot of items for one batch -- try {MAX_BULK_ITEMS} or fewer at a time")
    rows, coops = [], set()
    # One transaction for the whole list: a few thousand items cost one
    # request, not a few thousand -- and a bad item rolls back the lot instead
    # of leaving half a batch behind for the client to wonder about.
    with get_db() as conn:
        for item in items:
            if not isinstance(item, dict):
                raise HTTPException(400, "every item must be an object")
            if resource in SCOPED and not item.get("coop_id"):
                raise HTTPException(400, "coop_id is required for every item")
            row, _ = _insert_if_absent(conn, resource, item)
            rows.append(row)
            coops.add(GLOBAL_CHANNEL if resource == "coops" else row.get("coop_id"))
        # One nudge per affected coop, not one per record.
        _publish({c for c in coops if c}, resource)
    return {"created": len(rows), "items": rows}


@router.post("/api/{resource}")
def create_item(resource: str, payload: dict = Body(...)):
    _require_resource(resource)
    if resource in SCOPED and not payload.get("coop_id"):
        raise HTTPException(400, "coop_id is required")
    with get_db() as conn:
        row, _ = _insert_if_absent(conn, resource, payload)
        sse_publish(GLOBAL_CHANNEL if resource == "coops" else row.get("coop_id"), resource)
        return row


@router.put("/api/{resource}/{item_id}")
def update_item(resource: str, item_id: str, payload: dict = Body(...)):
    _require_resource(resource)
    if not any(c in payload for c in SCHEMA[resource]):
        raise HTTPException(400, "No valid fields to update")
    with get_db() as conn:
        row = _update_fields(conn, resource, item_id, payload)
        if row is None:
            raise HTTPException(404, "Item not found")
        sse_publish(GLOBAL_CHANNEL if resource == "coops" else row.get("coop_id"), resource)
        return row


@router.delete("/api/{resource}/{item_id}")
def delete_item(resource: str, item_id: str):
    _require_resource(resource)
    with get_db() as conn:
        coop = _coop_of(conn, resource, item_id)
        # Soft delete, not a real DELETE: a syncing client must be told a row
        # disappeared, not merely stop seeing it -- once a device has been
        # offline a while, "removed" and "never existed" look identical.
        if not _soft_delete(conn, resource, item_id, now_iso()):
            raise HTTPException(404, "Item not found")
        sse_publish(coop, resource)
        return {"deleted": item_id}
