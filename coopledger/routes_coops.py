"""Coop lifecycle: list/create/delete, and the three export formats + import."""
import base64
import csv
import io
import json
import uuid
import zipfile
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Body, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from .config import PHOTOS_DIR
from .db import get_db, now_iso
from .events import GLOBAL_CHANNEL, sse_publish
from .photos import delete_photo_file, photo_relpath, photo_to_data_uri, save_photo_bytes
from .schema import DEFAULT_SETTINGS, SCHEMA, SCOPED

router = APIRouter()

@router.get("/api/coops")
def list_coops():
    with get_db(write=False) as conn:
        rows = conn.execute("SELECT * FROM coops WHERE deleted_at IS NULL ORDER BY created_date ASC").fetchall()
        return [dict(r) for r in rows]


@router.post("/api/coops")
def create_coop(payload: dict = Body(...)):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Coop name is required")
    # A client-supplied id (used by the local-first sync engine, which
    # generates ids on-device so an offline create already has its final id)
    # is accepted as-is; otherwise the server assigns one as before. This
    # matters more here than it might look: without it, a coop created
    # offline would end up with two different ids -- the one the creating
    # device already committed to locally, and a different one the server
    # mints instead -- and every other device would sync down a coop under
    # an id the creating device itself doesn't recognize as the same one.
    coop_id = payload.get("id") or uuid.uuid4().hex[:12]
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM coops WHERE id = ?", (coop_id,)).fetchone()
        if existing:
            row = dict(conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone())
            sse_publish(GLOBAL_CHANNEL, "coops")
            return row
        # updated_at must be set explicitly here -- SQL's "WHERE updated_at > ?"
        # (used by every incremental sync) never matches a NULL value, so a row
        # created without it is permanently invisible to any device that's
        # already synced before, not just delayed. This was the actual root
        # cause of coops never appearing on other devices.
        conn.execute(
            "INSERT INTO coops (id, name, notes, created_date, settings, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (coop_id, name, payload.get("notes", ""), date.today().isoformat(), json.dumps(DEFAULT_SETTINGS), now_iso()),
        )
        row = dict(conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone())
        sse_publish(GLOBAL_CHANNEL, "coops")
        return row


def _import_photo(photo, coop_id, row_id, zip_photo_reader):
    """Resolve one photo from an export bundle into a stored file reference.
    Old (JSON) exports inline photos as base64 data URIs; zip exports reference
    a path inside the archive. Anything unreadable becomes None -- a missing
    photo must never abort restoring the rest of a coop."""
    if not (isinstance(photo, str) and photo):
        return None
    if photo.startswith("data:"):
        try:
            header, b64data = photo.split(",", 1)
            ext = ".png" if "png" in header else ".jpg"
            return save_photo_bytes(coop_id, row_id, base64.b64decode(b64data), ext)
        except Exception:
            return None
    if zip_photo_reader is not None:
        content = zip_photo_reader(photo)
        if content:
            return save_photo_bytes(coop_id, row_id, content, Path(photo).suffix.lower() or ".jpg")
    return None


# Parents before children, so child foreign keys can be remapped to the new ids.
# supply_products before supplies (product_id), birds before bird_logs and
# bird_photos (bird_id), hatches before hatch_eggs (hatch_id, and bird_id for
# a hatched-and-named egg) -- everything else is independent.
_IMPORT_LAST = ["supplies", "bird_logs", "bird_photos", "hatch_eggs"]
_IMPORT_ORDER = ["birds", "supply_products"] + [t for t in SCOPED if t not in ("birds", "supply_products", *_IMPORT_LAST)] + _IMPORT_LAST


def do_import_bundle(bundle: dict, zip_photo_reader=None) -> dict:
    """Shared import logic for both the JSON-body endpoint (old format, photos
    as base64 data URIs) and the zip endpoint (photos as separate files,
    referenced by their relative path inside the zip). Always creates a brand
    new coop with fresh ids -- it never merges into or overwrites an existing one."""
    src = bundle.get("coop") or {}
    name = (src.get("name") or "Imported Coop").strip()
    with get_db() as conn:
        new_id = uuid.uuid4().hex[:12]
        conn.execute(
            "INSERT INTO coops (id, name, notes, created_date, settings, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (new_id, name, src.get("notes", ""), src.get("created_date") or date.today().isoformat(), src.get("settings") or json.dumps(DEFAULT_SETTINGS), now_iso()),
        )
        id_maps = {"birds": {}, "supply_products": {}, "hatches": {}}
        for table in _IMPORT_ORDER:
            cols = [c for c in SCHEMA[table] if c != "coop_id"]
            for row in bundle.get(table, []) or []:
                row = dict(row)
                old_id = row.get("id")
                new_row_id = uuid.uuid4().hex[:12]
                if table in ("birds", "supply_products", "bird_photos"):
                    row["photo"] = _import_photo(row.get("photo"), new_id, new_row_id, zip_photo_reader)
                if table == "supplies" and row.get("product_id"):
                    row["product_id"] = id_maps["supply_products"].get(row["product_id"])  # None if the product wasn't in this export -- fine, just an unlinked bag
                if table in ("bird_logs", "bird_photos"):
                    row["bird_id"] = id_maps["birds"].get(row.get("bird_id"))
                    if not row["bird_id"]:
                        continue  # referenced a bird that wasn't in this export; skip it
                if table == "hatch_eggs":
                    row["hatch_id"] = id_maps["hatches"].get(row.get("hatch_id"))
                    if not row["hatch_id"]:
                        continue  # egg referenced a clutch that wasn't in this export; skip it
                    if row.get("bird_id"):
                        row["bird_id"] = id_maps["birds"].get(row["bird_id"])  # None if that bird wasn't in this export -- the egg just loses its flock link
                fields = ["id", "coop_id", "updated_at"] + [c for c in cols if c in row]
                values = [new_row_id, new_id, now_iso()] + [row[c] for c in cols if c in row]
                placeholders = ", ".join("?" for _ in fields)
                col_list = ", ".join(f'"{f}"' for f in fields)
                conn.execute(f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})", values)
                if table in id_maps:
                    id_maps[table][old_id] = new_row_id
        sse_publish(GLOBAL_CHANNEL, "coops")
        return dict(conn.execute("SELECT * FROM coops WHERE id = ?", (new_id,)).fetchone())


@router.post("/api/coops/import")
def import_coop(payload: dict = Body(...)):
    return do_import_bundle(payload)


@router.post("/api/coops/import.zip")
async def import_coop_zip(file: UploadFile = File(...)):
    content = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise HTTPException(400, "That doesn't look like a valid .zip file")
    try:
        manifest_raw = zf.read("coop.json")
    except KeyError:
        raise HTTPException(400, "This zip doesn't contain a coop.json -- make sure it's a backup exported from this app")
    bundle = json.loads(manifest_raw)

    def read_zip_photo(rel_path):
        try:
            return zf.read(rel_path)
        except KeyError:
            return None

    return do_import_bundle(bundle, zip_photo_reader=read_zip_photo)


@router.get("/api/coops/{coop_id}/export")
def export_coop(coop_id: str):
    with get_db(write=False) as conn:
        coop = conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone()
        if not coop:
            raise HTTPException(404, "Coop not found")
        bundle = {"version": 1, "exported_at": date.today().isoformat(), "coop": dict(coop)}
        for table in SCOPED:
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE coop_id = ? AND deleted_at IS NULL", (coop_id,)).fetchall()]
            if table in ("birds", "supply_products", "bird_photos"):
                for r in rows:
                    r["photo"] = photo_to_data_uri(r["photo"])
            bundle[table] = rows
        return bundle


@router.get("/api/coops/{coop_id}/export.zip")
def export_coop_zip(coop_id: str):
    """Same full backup as /export, but photos ship as real files in a photos/
    folder instead of being base64-inflated inline -- smaller, faster, and the
    photos are directly viewable/recoverable straight out of the zip."""
    with get_db(write=False) as conn:
        coop = conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone()
        if not coop:
            raise HTTPException(404, "Coop not found")
        bundle = {"version": 2, "exported_at": date.today().isoformat(), "coop": dict(coop)}
        photo_files = {}
        for table in SCOPED:
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE coop_id = ? AND deleted_at IS NULL", (coop_id,)).fetchall()]
            if table in ("birds", "supply_products", "bird_photos"):
                for r in rows:
                    photo_ref = r["photo"]
                    new_ref = None
                    p = photo_relpath(photo_ref)
                    if p and p.exists():
                        rel = f"photos/{p.relative_to(PHOTOS_DIR).as_posix()}"
                        photo_files[rel] = p.read_bytes()
                        new_ref = rel
                    r["photo"] = new_ref
            bundle[table] = rows

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("coop.json", json.dumps(bundle, indent=2))
        for rel, content in photo_files.items():
            zf.writestr(rel, content)
    zip_buf.seek(0)
    safe_name = "".join(c if c.isalnum() else "-" for c in coop["name"]).strip("-").lower() or "coop"
    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}-backup.zip"'},
    )


@router.get("/api/coops/{coop_id}/export.csv")
def export_coop_csv(coop_id: str):
    """Standardized spreadsheet export: a handful of clean, human-readable
    files rather than a raw dump of every internal table.

    This intentionally differs from the SCOPED/SCHEMA-driven dump the sync API
    uses: those are the database's own shape (13 tables, raw ids, cosmetic
    columns like card_color, internal join keys like product_id), built for
    the app to read back, not for a person to read in a spreadsheet.

    Design choices, so a future change to this stays consistent:
      - Column headers are plain English, one clear concept per column.
      - Foreign keys are RESOLVED, not exported raw -- a health log shows the
        bird's name, not its id, because a bare id is meaningless once pasted
        into a spreadsheet outside the app.
      - Weight is always in lb, labeled as such in the header. The kg/lb
        toggle is a client-side display preference with no server record of
        which one was active, and a "standardized" export needs one fixed,
        predictable unit rather than one that silently depends on whatever
        the toggle happened to be set to at export time.
      - Money is a bare decimal (no "$"), so SUM() and friends work directly
        on the column without stripping a currency symbol first.
      - Purely cosmetic/internal tables (bird_photos, supply_products,
        activity_log) are left out -- they're not something a person analyzes
        in a spreadsheet, just app-internal bookkeeping.
    """
    with get_db(write=False) as conn:
        coop = conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone()
        if not coop:
            raise HTTPException(404, "Coop not found")

        def rows_of(table):
            return [dict(r) for r in conn.execute(
                f"SELECT * FROM {table} WHERE coop_id = ? AND deleted_at IS NULL", (coop_id,),
            ).fetchall()]

        def write_csv(zf, filename, header, records):
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(header)
            for rec in records:
                writer.writerow(rec)
            zf.writestr(filename, buf.getvalue())

        def num(v, digits=2):
            if v is None or v == "":
                return ""
            try:
                return round(float(v), digits)
            except (TypeError, ValueError):
                return v

        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            bird_name_by_id = {}

            # --- Flock.csv ---
            birds = rows_of("birds")
            for b in birds:
                bird_name_by_id[b["id"]] = b.get("name") or "(unnamed)"
            write_csv(zf, "Flock.csv",
                ["Name", "Type", "Breed", "Gender", "Status", "Batch", "Location",
                 "Hatch Date", "Acquired Date", "Target Harvest Date",
                 "Harvest Date", "Dressed Weight (lb)", "Price per lb", "Harvest Value",
                 "Death Date", "Death Cause", "Notes"],
                [[
                    b.get("name") or "(unnamed)", b.get("type") or "", b.get("breed") or "", b.get("gender") or "",
                    b.get("status") or "", b.get("batch_name") or "", b.get("location") or "",
                    b.get("hatch_date") or "", b.get("acquired_date") or "", b.get("target_harvest_date") or "",
                    b.get("harvest_date") or "", num(b.get("harvest_weight")), num(b.get("price_per_lb")),
                    num((float(b["harvest_weight"]) * float(b["price_per_lb"])) if b.get("harvest_weight") and b.get("price_per_lb") else None),
                    b.get("death_date") or "", b.get("death_cause") or "", b.get("notes") or "",
                ] for b in birds])

            # --- Eggs.csv ---
            eggs = rows_of("eggs")
            write_csv(zf, "Eggs.csv",
                ["Date", "Count", "Price per Egg", "Value", "Notes"],
                [[e.get("date") or "", num(e.get("count"), 0), num(e.get("price_per_egg"), 4),
                  num((float(e["count"]) * float(e["price_per_egg"])) if e.get("count") and e.get("price_per_egg") else None),
                  e.get("notes") or ""] for e in eggs])

            # --- Finances.csv (expenses + income, one readable ledger) ---
            expenses = rows_of("expenses")
            write_csv(zf, "Finances.csv",
                ["Date", "Type", "Category", "Description", "Amount", "Quantity", "Unit", "Applies To", "Notes"],
                [[x.get("date") or "", "Income" if x.get("entry_type") == "income" else "Expense",
                  x.get("category") or "", x.get("description") or "", num(x.get("amount")),
                  num(x.get("quantity")), x.get("unit") or "", x.get("for_type") or "", ""] for x in expenses])

            # --- Inventory.csv (feed, bedding, and other tracked supplies) ---
            supplies = rows_of("supplies")
            write_csv(zf, "Inventory.csv",
                ["Category", "Description", "Brand", "Quantity", "Unit", "Cost", "Status", "Date Added", "Opened", "Emptied"],
                [[s.get("category") or "", s.get("description") or "", s.get("brand") or "",
                  num(s.get("quantity")), s.get("unit") or "", num(s.get("cost")), s.get("status") or "",
                  s.get("date_added") or "", s.get("opened_at") or "", s.get("date_emptied") or ""] for s in supplies])

            # --- Bedding.csv ---
            bedding = rows_of("bedding")
            write_csv(zf, "Bedding.csv",
                ["Date", "Area", "Material", "Type", "Notes"],
                [[bd.get("date") or "", bd.get("area") or "", bd.get("material") or "",
                  bd.get("entry_type") or "", bd.get("notes") or ""] for bd in bedding])

            # --- Health Log.csv (bird_id resolved to the bird's name) ---
            bird_logs = rows_of("bird_logs")
            write_csv(zf, "Health Log.csv",
                ["Date", "Bird", "Note"],
                [[log.get("date") or "", bird_name_by_id.get(log.get("bird_id"), "(deleted bird)"), log.get("note") or ""] for log in bird_logs])

            # --- Hatches.csv (already one row per clutch with summary counts) ---
            hatches = rows_of("hatches")
            write_csv(zf, "Hatches.csv",
                ["Breed", "Date Started", "Status", "Eggs Set", "Hatched", "Named", "Clear", "Quit", "Failed to Hatch", "Notes"],
                [[h.get("breed") or "", h.get("date_started") or "", h.get("status") or "",
                  num(h.get("egg_count"), 0), num(h.get("hatched_count"), 0), num(h.get("named_count"), 0),
                  num(h.get("clear_count"), 0), num(h.get("quit_count"), 0), num(h.get("failed_count"), 0),
                  h.get("notes") or ""] for h in hatches])

            # --- Notes.csv ---
            notes = rows_of("notes")
            write_csv(zf, "Notes.csv",
                ["Date", "Category", "Title", "Note"],
                [[n.get("created_date") or "", n.get("category") or "", n.get("title") or "", n.get("body") or ""] for n in notes])

        zip_buf.seek(0)
        safe_name = "".join(c if c.isalnum() else "-" for c in coop["name"]).strip("-").lower() or "coop"
        filename = f"{safe_name}-spreadsheet-{date.today().isoformat()}.zip"
        return StreamingResponse(
            zip_buf,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


@router.delete("/api/coops/{coop_id}")
def delete_coop(coop_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Coop not found")
        photo_values = []
        for photo_table in ("birds", "bird_photos", "supply_products"):
            for r in conn.execute(f"SELECT photo FROM {photo_table} WHERE coop_id = ?", (coop_id,)).fetchall():
                photo_values.append(r["photo"])
        for table in SCOPED:
            conn.execute(f"DELETE FROM {table} WHERE coop_id = ?", (coop_id,))
        for photo_value in photo_values:
            delete_photo_file(conn, photo_value)
        # Soft delete, not a hard DELETE -- same reasoning as every other
        # resource in this app: a hard delete leaves nothing behind for a
        # future "what's changed since X" sync to detect, so other devices
        # would never learn the coop was gone. Child data above still gets
        # hard-deleted, since a deleted coop should genuinely lose its data.
        now = now_iso()
        conn.execute("UPDATE coops SET deleted_at = ?, updated_at = ? WHERE id = ?", (now, now, coop_id))
        sse_publish(GLOBAL_CHANNEL, "coops")
        return {"deleted": coop_id}
