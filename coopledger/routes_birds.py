"""Bird-specific bulk endpoints."""
import uuid
from datetime import date

from fastapi import APIRouter, Body, HTTPException

from .db import get_db, now_iso
from .events import sse_publish
from .photos import cascade_delete_bird_photos, delete_photo_file
from .schema import SCHEMA

router = APIRouter()

@router.post("/api/birds/bulk-update")
def bulk_update_birds(payload: dict = Body(...)):
    ids = payload.get("ids") or []
    updates = payload.get("updates") or {}
    if not ids or not isinstance(ids, list):
        raise HTTPException(400, "ids (a list) is required")
    if len(ids) > 2000:
        raise HTTPException(400, "That's a lot of birds to update at once -- try 2000 or fewer at a time")
    cols = SCHEMA["birds"]
    valid_updates = {k: v for k, v in updates.items() if k in cols and k != "coop_id"}
    if not valid_updates:
        raise HTTPException(400, "No valid fields to update")
    set_clause = ", ".join(f'"{c}" = ?' for c in valid_updates) + ', "updated_at" = ?'
    with get_db() as conn:
        updated = 0
        for bird_id in ids:
            cur = conn.execute(f"UPDATE birds SET {set_clause} WHERE id = ?", list(valid_updates.values()) + [now_iso(), bird_id])
            updated += cur.rowcount
        if updated:
            for coop in {r["coop_id"] for r in conn.execute(f"SELECT coop_id FROM birds WHERE id IN ({','.join('?' for _ in ids)})", ids)}:
                sse_publish(coop, "birds")
        return {"updated": updated}


@router.post("/api/birds/bulk-delete")
def bulk_delete_birds(payload: dict = Body(...)):
    ids = payload.get("ids") or []
    if not ids or not isinstance(ids, list):
        raise HTTPException(400, "ids (a list) is required")
    with get_db() as conn:
        deleted = 0
        now = now_iso()
        coops_touched = set()
        for bird_id in ids:
            row = conn.execute("SELECT photo, coop_id FROM birds WHERE id = ? AND deleted_at IS NULL", (bird_id,)).fetchone()
            if row:
                coops_touched.add(row["coop_id"])
                conn.execute('UPDATE bird_logs SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, bird_id))
                conn.execute('UPDATE birds SET deleted_at = ?, updated_at = ? WHERE id = ?', (now, now, bird_id))
                cascade_delete_bird_photos(conn, bird_id, now)
                delete_photo_file(conn, row["photo"])
                deleted += 1
        for coop in coops_touched:
            sse_publish(coop, "birds")
        return {"deleted": deleted}


@router.post("/api/birds/bulk")
def create_birds_bulk(payload: dict = Body(...)):
    coop_id = payload.get("coop_id")
    try:
        count = int(payload.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    if not coop_id or count < 1:
        raise HTTPException(400, "coop_id and a count of at least 1 are required")
    if count > 200:
        raise HTTPException(400, "That's a lot of birds for one batch — try 200 or fewer at a time")

    batch_name = (payload.get("batch_name") or "").strip() or f"Batch {date.today().isoformat()}"
    shared = {
        "coop_id": coop_id,
        "breed": payload.get("breed", ""),
        "type": payload.get("type", "Meat"),
        "status": payload.get("status", "Active"),
        "hatch_date": payload.get("hatch_date", ""),
        "acquired_date": payload.get("acquired_date", ""),
        "target_harvest_date": payload.get("target_harvest_date", ""),
        "batch_name": batch_name,
        "notes": payload.get("notes", ""),
    }
    created_ids = []
    with get_db() as conn:
        for i in range(1, count + 1):
            bird_id = uuid.uuid4().hex[:12]
            row = dict(shared)
            row["name"] = f"{batch_name} #{i}"
            row["updated_at"] = now_iso()
            fields = ["id"] + list(row.keys())
            values = [bird_id] + list(row.values())
            placeholders = ", ".join("?" for _ in fields)
            col_list = ", ".join(f'"{f}"' for f in fields)
            conn.execute(f"INSERT INTO birds ({col_list}) VALUES ({placeholders})", values)
            created_ids.append(bird_id)
        sse_publish(coop_id, "birds")
    return {"created": len(created_ids), "batch_name": batch_name, "created_ids": created_ids}
