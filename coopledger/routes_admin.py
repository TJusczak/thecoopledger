"""Admin-only server information, settings, and backup download."""
import io
import platform
import sqlite3
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from .auth import require_admin
from .config import BACKUP_DIR, DATA_DIR, OVERRIDABLE_SETTINGS, PHOTOS_DIR, SERVER_VERSION
from .db import get_db, now_iso
from .maintenance import prune_idle_sessions
from .schema import SCHEMA
from .settings import get_setting, setting_is_overridden

router = APIRouter()

def dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


@router.get("/api/admin/server-info")
def get_server_info(request: Request):
    require_admin(request)

    with get_db(write=False) as conn:
        journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        page_count = conn.execute("PRAGMA page_count").fetchone()[0]
        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        row_counts = {}
        tombstone_counts = {}
        for table in sorted(SCHEMA.keys()):
            try:
                n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE deleted_at IS NULL").fetchone()[0]
                t = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE deleted_at IS NOT NULL").fetchone()[0]
            except sqlite3.OperationalError:
                n = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # table has no deleted_at column
                t = 0
            row_counts[table] = n
            if t:
                tombstone_counts[table] = t
        coop_count = conn.execute("SELECT COUNT(*) FROM coops WHERE deleted_at IS NULL").fetchone()[0]
        deleted_coop_count = conn.execute("SELECT COUNT(*) FROM coops WHERE deleted_at IS NOT NULL").fetchone()[0]
        # Per-coop breakdown of the tables people actually think in terms of.
        # The flat totals above sum across every live coop, so anyone with a
        # leftover test coop sees inflated numbers with no visible reason --
        # this makes the reason visible.
        per_coop = []
        for coop in conn.execute("SELECT id, name FROM coops WHERE deleted_at IS NULL ORDER BY name").fetchall():
            counts = {}
            for table in ("birds", "eggs", "expenses", "supplies", "supply_products", "hatches", "notes", "bird_photos"):
                counts[table] = conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE deleted_at IS NULL AND coop_id = ?", (coop["id"],)
                ).fetchone()[0]
            per_coop.append({"id": coop["id"], "name": coop["name"], "counts": counts})
        active_session_count = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        invite_code_count = conn.execute("SELECT COUNT(*) FROM invite_codes WHERE revoked_at IS NULL").fetchone()[0]

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backups = sorted([p for p in BACKUP_DIR.glob("backup-*") if p.is_dir()], key=lambda p: p.name, reverse=True)
    most_recent_backup = None
    if backups:
        ts_str = backups[0].name.replace("backup-", "")
        try:
            most_recent_backup = datetime.strptime(ts_str, "%Y%m%d-%H%M%S-%f").replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            most_recent_backup = None

    return {
        "server_version": SERVER_VERSION,
        "python_version": platform.python_version(),
        "sqlite_version": sqlite3.sqlite_version,
        "database": {
            "journal_mode": journal_mode,
            "size_bytes": page_count * page_size,
            "row_counts": row_counts,
            "tombstone_counts": tombstone_counts,
            "coop_count": coop_count,
            "deleted_coop_count": deleted_coop_count,
            "per_coop": per_coop,
        },
        "disk": {
            "photos_bytes": dir_size(PHOTOS_DIR),
            "backups_bytes": dir_size(BACKUP_DIR),
            "data_dir_bytes": dir_size(DATA_DIR),
        },
        "backups": {
            "count": len(backups),
            "most_recent": most_recent_backup,
            "max_kept": get_setting("max_backups_to_keep"),
            "interval_hours": get_setting("backup_interval_hours"),
        },
        "auth": {
            "active_sessions": active_session_count,
            "active_invite_codes": invite_code_count,
        },
    }


@router.get("/api/admin/server-settings")
def get_server_settings(request: Request):
    require_admin(request)
    out = {}
    for key, spec in OVERRIDABLE_SETTINGS.items():
        out[key] = {
            "value": get_setting(key),
            "env_default": spec["env_default"](),
            "overridden": setting_is_overridden(key),  # lets the UI show "set in the app" vs "from your compose file"
            "type": spec["type"],
            "min": spec.get("min"),
            "max": spec.get("max"),
        }
    return {"settings": out}


@router.put("/api/admin/server-settings")
async def update_server_settings(request: Request):
    require_admin(request)
    body = await request.json()
    now = now_iso()
    with get_db() as conn:
        for key, raw in body.items():
            if key not in OVERRIDABLE_SETTINGS:
                raise HTTPException(400, f"Unknown setting: {key}")
            spec = OVERRIDABLE_SETTINGS[key]
            # A null means "stop overriding this -- go back to whatever the
            # environment says." That's the escape hatch that keeps the env
            # var meaningful instead of being silently shadowed forever by a
            # value someone typed once.
            if raw is None:
                conn.execute("DELETE FROM server_settings WHERE key = ?", (key,))
                continue
            if spec["type"] == "bool":
                value = "1" if raw in (True, "1", "true", 1) else "0"
            else:
                try:
                    n = int(raw)
                except (TypeError, ValueError):
                    raise HTTPException(400, f"{key} must be a whole number") from None
                lo, hi = spec.get("min"), spec.get("max")
                if (lo is not None and n < lo) or (hi is not None and n > hi):
                    raise HTTPException(400, f"{key} must be between {lo} and {hi}")
                value = str(n)
            conn.execute(
                "INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (key, value, now),
            )
    # Apply anything time-based immediately rather than waiting for the next
    # hourly maintenance tick -- shortening the session window should log out
    # stale sessions now, not up to an hour from now.
    prune_idle_sessions()
    return {"ok": True, "settings": get_server_settings(request)["settings"]}


@router.get("/api/backups")
def list_backups(request: Request):
    # Admin-only, like everything else on the Server settings page. The
    # middleware's write-blocking doesn't help here (these are GETs), and
    # a backup is the single most sensitive thing this server has: the
    # database inside it contains every invite code and every session
    # token. A read-only session being able to fetch one would be a
    # direct path to escalating itself to admin.
    require_admin(request)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backups = []
    for p in sorted([d for d in BACKUP_DIR.glob("backup-*") if d.is_dir()], key=lambda p: p.name, reverse=True):
        size_bytes = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
        stat = p.stat()
        backups.append({"filename": p.name, "size_bytes": size_bytes, "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()})
    return {"backups": backups}


@router.get("/api/backups/{filename}")
def download_backup(filename: str, request: Request):
    require_admin(request)  # see list_backups above -- a backup contains all codes and tokens
    # Guard against a path-traversal filename (e.g. "../../etc/passwd") --
    # only ever serve something that's actually a folder directly inside
    # BACKUP_DIR, matching the naming this endpoint itself creates.
    if "/" in filename or "\\" in filename or not filename.startswith("backup-"):
        raise HTTPException(400, "Invalid backup filename")
    folder = BACKUP_DIR / filename
    if not folder.is_dir():
        raise HTTPException(404, "Backup not found")
    # Built on demand rather than stored as a zip at rest -- backups live
    # as a database file plus hard-linked photos, specifically so many
    # backups can share the same on-disk photo data without each one
    # duplicating it. Zipping only happens here, at the point someone
    # actually wants a single downloadable file.
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in folder.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(folder).as_posix())
    zip_buf.seek(0)
    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}.zip"'},
    )
