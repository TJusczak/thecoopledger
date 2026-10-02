"""Photo files on disk: storage, reference counting, and upload/remove routes."""
import base64
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile

from .config import MAX_PHOTO_UPLOAD_BYTES, PHOTOS_DIR
from .db import get_db, now_iso

router = APIRouter()

def photo_relpath(photo_value):
    """The path of a /photos/... reference relative to PHOTOS_DIR, with a
    containment check -- used by both delete and read so a malformed or
    unexpected value can never resolve outside the photos directory.
    Works for both the current per-coop layout (/photos/<coop_id>/<file>)
    and the flat layout every photo used before this existed, since both
    are just "whatever comes after /photos/" to this function."""
    if not (photo_value and isinstance(photo_value, str) and photo_value.startswith("/photos/")):
        return None
    rel = photo_value[len("/photos/"):]
    p = PHOTOS_DIR / rel
    try:
        p.resolve().relative_to(PHOTOS_DIR.resolve())
    except ValueError:
        return None
    return p


def photo_still_referenced(conn, photo_value):
    """Whether any live (non-soft-deleted) row still references this exact
    photo path -- checked before physically deleting a file, since photos
    can now be shared (e.g. a group of birds created together with one
    group photo, all pointing at the same file rather than each having
    its own copy).

    Takes the CALLER's own connection rather than opening a new one: a
    caller that just soft-deleted (or updated) the row referencing this
    photo, in the same transaction, needs that change to be visible here
    even though it hasn't committed yet. A separate connection can't see
    another connection's uncommitted work, so it would see the row as
    still "live" and wrongly conclude the file is still needed."""
    if not photo_value:
        return False
    for table in ("birds", "bird_photos", "supply_products"):
        if conn.execute(f"SELECT 1 FROM {table} WHERE photo = ? AND deleted_at IS NULL", (photo_value,)).fetchone():
            return True
    return False


def delete_photo_file(conn, photo_value):
    """Remove a photo file from disk if it's one of ours (a /photos/...
    reference) AND nothing else still references it. See
    photo_still_referenced for why this needs the caller's own
    connection, and why call ordering (update/delete the row first, then
    call this) matters."""
    p = photo_relpath(photo_value)
    if p and p.exists() and not photo_still_referenced(conn, photo_value):
        try:
            p.unlink()
        except OSError:
            pass


def cascade_delete_bird_photos(conn, bird_id, now):
    """Soft-deletes a bird's timeline (bird_photos) entries and cleans up
    their files where nothing else references them -- call alongside the
    existing bird_logs cascade, after the bird itself is already
    soft-deleted. Without this, a bird's auto-seeded timeline entry stays
    live forever even after the bird is gone, permanently pinning its
    photo file (shared or not) and preventing it from ever being cleaned up."""
    rows = conn.execute("SELECT id, photo FROM bird_photos WHERE bird_id = ? AND deleted_at IS NULL", (bird_id,)).fetchall()
    conn.execute('UPDATE bird_photos SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, bird_id))
    for r in rows:
        delete_photo_file(conn, r["photo"])


def save_photo_bytes(coop_id: str, item_id: str, content: bytes, ext: str = ".jpg") -> str:
    # Grouped under the owning coop's own folder so photos from different
    # coops on the same shared server don't all pile into one directory --
    # falls back to a shared "_unscoped" folder only if a coop_id genuinely
    # isn't available (shouldn't normally happen; better than crashing or
    # silently writing into PHOTOS_DIR's own root where it'd look like a
    # coop folder to future listing/cleanup code).
    coop_dir = PHOTOS_DIR / (coop_id or "_unscoped")
    coop_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{item_id}-{uuid.uuid4().hex[:6]}{ext}"
    (coop_dir / filename).write_bytes(content)
    return f"/photos/{coop_id or '_unscoped'}/{filename}"


def photo_to_data_uri(photo_value):
    """For export: turn a stored file reference into a self-contained data URI."""
    if not photo_value:
        return None
    if photo_value.startswith("data:"):
        return photo_value
    p = photo_relpath(photo_value)
    if not p or not p.exists():
        return None
    ext = p.suffix.lower()
    mime = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/jpeg")
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"



def sniff_image_ext(content: bytes) -> str | None:
    """Determine the image type from the file's own magic bytes -- the
    only part of an upload that can't simply be lied about the way a
    Content-Type header or a filename extension can. Returns the correct
    extension for the actual content, or None if it isn't a recognized
    image format at all."""
    if content.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    if content.startswith(b"GIF87a") or content.startswith(b"GIF89a"):
        return ".gif"
    return None


async def upload_photo_for(table: str, item_id: str, file: UploadFile):
    with get_db(write=False) as conn:
        row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        coop_id, old_photo = row["coop_id"], row["photo"]

    # No database connection held during the read -- this can be a slow
    # network operation for a large file, and doing it without a lock held
    # means it can't block every other request against this database file
    # for however long it takes.
    content = await file.read()
    if len(content) > MAX_PHOTO_UPLOAD_BYTES:
        raise HTTPException(413, f"That photo is too large ({len(content) // (1024*1024)}MB) -- please use one under {MAX_PHOTO_UPLOAD_BYTES // (1024*1024)}MB")
    ext = sniff_image_ext(content)
    if ext is None:
        # The Content-Type header is just whatever the client claims; the
        # bytes themselves are what actually gets stored and later served
        # back. Only accept things that are verifiably image data.
        raise HTTPException(415, "That file doesn't look like an image -- photos must be JPEG, PNG, WebP, or GIF")
    new_ref = save_photo_bytes(coop_id, item_id, content, ext)

    with get_db() as conn:
        conn.execute(f'UPDATE {table} SET photo = ?, updated_at = ? WHERE id = ?', (new_ref, now_iso(), item_id))
        delete_photo_file(conn, old_photo)  # after the update, so a shared old photo isn't wrongly seen as still used by this row
        return {"photo": new_ref}


def remove_photo_for(table: str, item_id: str):
    with get_db() as conn:
        row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        old_photo = row["photo"]
        conn.execute(f'UPDATE {table} SET photo = NULL, updated_at = ? WHERE id = ?', (now_iso(), item_id))
        delete_photo_file(conn, old_photo)
        return {"removed": True}


@router.post("/api/supply_products/{product_id}/photo")
async def upload_supply_product_photo(product_id: str, file: UploadFile = File(...)):
    return await upload_photo_for("supply_products", product_id, file)


@router.delete("/api/supply_products/{product_id}/photo")
def remove_supply_product_photo(product_id: str):
    return remove_photo_for("supply_products", product_id)


@router.post("/api/birds/{bird_id}/photo")
async def upload_bird_photo(bird_id: str, file: UploadFile = File(...)):
    return await upload_photo_for("birds", bird_id, file)


@router.delete("/api/birds/{bird_id}/photo")
def remove_bird_photo(bird_id: str):
    return remove_photo_for("birds", bird_id)


@router.post("/api/bird_photos/{photo_id}/photo")
async def upload_bird_history_photo(photo_id: str, file: UploadFile = File(...)):
    return await upload_photo_for("bird_photos", photo_id, file)


@router.delete("/api/bird_photos/{photo_id}/photo")
def remove_bird_history_photo(photo_id: str):
    return remove_photo_for("bird_photos", photo_id)
