import asyncio
import base64
import csv
import io
import json
import os
import platform
import secrets
import shutil
import sqlite3
import time
import uuid
import zipfile
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Body, File, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders

# ---------- Configuration (environment variables) ----------
# Every setting has a sane default -- a bare `docker compose up` with no
# configuration at all keeps working exactly as before. A malformed value
# (e.g. MAX_PHOTO_UPLOAD_MB=banana) falls back to the default rather than
# crashing the server on startup, but prints a warning so it isn't silent.

def _env_int(name: str, default: int, minimum: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
        if minimum is not None and value < minimum:
            print(f"WARNING: {name}={value} is below the minimum of {minimum} -- using {default}")
            return default
        return value
    except ValueError:
        print(f"WARNING: {name}={raw!r} isn't a whole number -- using the default of {default}")
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "coop.db"

# Bumped alongside the frontend's APP_VERSION (static/app.js) whenever either
# changes -- lets the client detect a sync server that's running older code
# than what it's talking to it with (e.g. the static frontend auto-updated
# from a CDN, but this self-hosted server hasn't been restarted since).
SERVER_VERSION = "2026.07.13-187"
PHOTOS_DIR = DATA_DIR / "photos"
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
# The frontend already resizes images before upload, so a normal photo is
# well under this -- this is a backstop against something huge slipping
# through, whether picked by mistake or from a client that bypasses the
# frontend's resize step and hits the API directly.
MAX_PHOTO_UPLOAD_BYTES = _env_int("MAX_PHOTO_UPLOAD_MB", 25, minimum=1) * 1024 * 1024

# Automatic backups (see _create_full_backup below for how they work).
BACKUPS_ENABLED = _env_bool("BACKUPS_ENABLED", True)
BACKUP_INTERVAL_HOURS = _env_int("BACKUP_INTERVAL_HOURS", 24, minimum=1)
MAX_BACKUPS_TO_KEEP = _env_int("MAX_BACKUPS_TO_KEEP", 14, minimum=1)

# 0 (the default) means sessions never expire from inactivity -- matching
# the app's original behavior, where logging in once on the kitchen tablet
# was meant to stick. Set to e.g. 90 to automatically drop sessions that
# haven't been used in that many days.
SESSION_MAX_IDLE_DAYS = _env_int("SESSION_MAX_IDLE_DAYS", 0, minimum=0)

# Comma-separated list of allowed CORS origins, or "*" (the default) to
# allow any -- the permissive default is what lets a TWA/wrapped app or a
# CDN-hosted frontend talk to a separately-hosted sync server out of the
# box. Lock it down (e.g. "https://coop.example.com") if your frontend
# only ever lives at one origin.
CORS_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "*").split(",") if o.strip()] or ["*"]

# Which settings an admin can override from the app (Settings -> Server), and
# the env-derived default each falls back to when they haven't. Kept to the
# ones that are genuinely operational policy rather than deployment plumbing:
# CORS origins and the data directory, for instance, stay env-only, since
# getting those wrong from a web form could lock you out of your own server.
OVERRIDABLE_SETTINGS = {
    "session_max_idle_days": {"type": "int", "min": 0, "max": 3650, "env_default": lambda: SESSION_MAX_IDLE_DAYS},
    "backups_enabled": {"type": "bool", "env_default": lambda: BACKUPS_ENABLED},
    "backup_interval_hours": {"type": "int", "min": 1, "max": 24 * 30, "env_default": lambda: BACKUP_INTERVAL_HOURS},
    "max_backups_to_keep": {"type": "int", "min": 1, "max": 365, "env_default": lambda: MAX_BACKUPS_TO_KEEP},
    "activity_log_retention_days": {"type": "int", "min": 1, "max": 3650, "env_default": lambda: ACTIVITY_LOG_RETENTION_DAYS},
}


def _get_setting(key: str):
    """The value actually in force: an admin's override if one exists,
    otherwise the environment default. Every consumer below reads through
    this rather than the module-level constant, so a change in the app
    takes effect on the next maintenance pass without a restart."""
    spec = OVERRIDABLE_SETTINGS[key]
    with get_db() as conn:
        row = conn.execute("SELECT value FROM server_settings WHERE key = ?", (key,)).fetchone()
    if row is None:
        return spec["env_default"]()
    raw = row["value"]
    if spec["type"] == "bool":
        return raw == "1"
    try:
        return int(raw)
    except ValueError:  # shouldn't happen (writes are validated), but never crash the server over a bad row
        return spec["env_default"]()


def _setting_is_overridden(key: str) -> bool:
    with get_db() as conn:
        return conn.execute("SELECT 1 FROM server_settings WHERE key = ?", (key,)).fetchone() is not None

DEFAULT_SETTINGS = {
    "bedding_thresholds": {
        "Coop Floor": {"warn": 120, "danger": 180},
        "Nesting Boxes": {"warn": 60, "danger": 90},
        "Run": {"warn": 120, "danger": 180},
    }
}

SCHEMA = {
    "coops": {
        "name": "TEXT", "notes": "TEXT", "created_date": "TEXT", "settings": "TEXT",
    },
    "birds": {
        "coop_id": "TEXT", "name": "TEXT", "breed": "TEXT", "type": "TEXT", "gender": "TEXT", "hatch_date": "TEXT",
        "acquired_date": "TEXT", "status": "TEXT", "target_harvest_date": "TEXT",
        "harvest_date": "TEXT", "harvest_weight": "REAL", "notes": "TEXT",
        "photo": "TEXT", "photo_pos_x": "REAL", "photo_pos_y": "REAL", "photo_zoom": "REAL", "batch_name": "TEXT", "price_per_lb": "REAL",
        "death_date": "TEXT", "death_cause": "TEXT", "card_color": "TEXT", "border_style": "TEXT", "hatch_id": "TEXT", "card_pattern": "TEXT", "location": "TEXT",
        "main_bird_photo_id": "TEXT",
    },
    "bird_photos": {
        # A bird's photo history, separate from birds.photo (the single
        # "current" photo shown on cards everywhere, which this doesn't
        # replace). Each entry has its own crop, its own date, and an
        # optional growth-stage label, so a bird's timeline can show it as
        # a chick, then months later as an adult, without losing either shot.
        "coop_id": "TEXT", "bird_id": "TEXT", "photo": "TEXT", "photo_pos_x": "REAL", "photo_pos_y": "REAL", "photo_zoom": "REAL",
        "date_taken": "TEXT", "stage": "TEXT",
    },
    "eggs": {
        "coop_id": "TEXT", "date": "TEXT", "count": "REAL", "notes": "TEXT", "price_per_egg": "REAL",
    },
    "expenses": {
        "coop_id": "TEXT", "date": "TEXT", "category": "TEXT", "description": "TEXT", "amount": "REAL", "for_type": "TEXT",
        "quantity": "REAL", "unit": "TEXT", "entry_type": "TEXT", "washout_unit_price": "REAL",
    },
    "bedding": {
        "coop_id": "TEXT", "date": "TEXT", "area": "TEXT", "material": "TEXT", "entry_type": "TEXT", "notes": "TEXT",
    },
    "bird_logs": {
        "coop_id": "TEXT", "bird_id": "TEXT", "date": "TEXT", "note": "TEXT",
    },
    "notes": {
        "coop_id": "TEXT", "category": "TEXT", "title": "TEXT", "body": "TEXT", "created_date": "TEXT", "color": "TEXT",
    },
    "supplies": {
        "coop_id": "TEXT", "category": "TEXT", "description": "TEXT", "brand": "TEXT", "quantity": "REAL", "unit": "TEXT",
        "status": "TEXT", "date_added": "TEXT", "date_emptied": "TEXT", "source_expense_id": "TEXT", "opened_at": "TEXT",
        "product_id": "TEXT", "cost": "REAL",
    },
    "supply_products": {
        "coop_id": "TEXT", "category": "TEXT", "brand": "TEXT", "photo": "TEXT", "photo_pos_x": "REAL", "photo_pos_y": "REAL", "photo_zoom": "REAL",
        "default_unit": "TEXT", "default_quantity": "REAL", "default_description": "TEXT", "last_used_at": "TEXT",
    },
    "hatches": {
        "coop_id": "TEXT", "breed": "TEXT", "date_started": "TEXT", "egg_count": "REAL",
        "hatched_count": "REAL", "named_count": "REAL", "clear_count": "REAL", "quit_count": "REAL", "failed_count": "REAL",
        "status": "TEXT", "notes": "TEXT",
    },
    "hatch_eggs": {
        # One row per individual egg in a clutch -- position is a stable
        # display order (1, 2, 3...) that doesn't change as status changes.
        # status: Incubating | Hatched | Clear | Quit | Failed to Hatch.
        # bird_id is set once a Hatched egg has been named into the flock;
        # tracked_externally marks one as "handled" without a real flock
        # record (kept separate from bird_id so a null bird_id still means
        # "still needs naming" rather than being ambiguous with this).
        "coop_id": "TEXT", "hatch_id": "TEXT", "position": "REAL", "status": "TEXT", "gender": "TEXT", "bird_id": "TEXT", "tracked_externally": "REAL",
    },
    "activity_log": {
        # Append-only by convention (the app never updates or deletes a log entry) --
        # reuses the same generic create/list/sync endpoints as everything else.
        "coop_id": "TEXT", "resource": "TEXT", "op": "TEXT", "changed_by": "TEXT", "summary": "TEXT",
    },
}
SCOPED = {"birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "hatch_eggs", "bird_photos", "activity_log", "supply_products"}  # tables siloed by coop_id


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


SYNC_COLUMNS = {"updated_at": "TEXT", "deleted_at": "TEXT"}


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


# Excludes visually ambiguous characters (0/O, 1/I/L) since this needs to be
# read aloud or typed by hand, unlike session tokens which never are.
INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

# How long activity-log entries stick around before being pruned (soft-
# deleted, same as any other delete -- so existing devices get told to
# remove their local copies too via the normal sync/tombstone mechanism,
# rather than silently drifting out of sync with the server's shorter
# history).
ACTIVITY_LOG_RETENTION_DAYS = _env_int("ACTIVITY_LOG_RETENTION_DAYS", 7, minimum=1)


def generate_invite_code(length=8):
    return "".join(secrets.choice(INVITE_CODE_ALPHABET) for _ in range(length))


def init_db():
    with get_db() as conn:
        for table, cols in SCHEMA.items():
            all_cols = {**cols, **SYNC_COLUMNS}
            col_defs = ", ".join(f'"{c}" {t}' for c, t in all_cols.items())
            conn.execute(f'CREATE TABLE IF NOT EXISTS {table} (id TEXT PRIMARY KEY, {col_defs})')
            existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            for c, t in all_cols.items():
                if c not in existing:
                    conn.execute(f'ALTER TABLE {table} ADD COLUMN "{c}" {t}')

        # Backfill missing settings (coops created before this feature existed)
        conn.execute(
            "UPDATE coops SET settings = ? WHERE settings IS NULL OR settings = ''",
            (json.dumps(DEFAULT_SETTINGS),),
        )

        # Backfill updated_at for rows that predate sync support, so they
        # don't all look "just changed" to a client doing its first sync.
        backfill_ts = _now_iso()
        for table in SCHEMA:
            conn.execute(f'UPDATE {table} SET updated_at = ? WHERE updated_at IS NULL', (backfill_ts,))
        # coops lives outside the generic SCHEMA-driven table list (it's not
        # coop-scoped, it's the top-level entity), so it was never covered by
        # the loop above -- same repair, applied explicitly here instead.
        conn.execute('UPDATE coops SET updated_at = ? WHERE updated_at IS NULL', (backfill_ts,))

        # Indexes on the coop-scoped tables. Every query in this app filters by
        # coop_id (and usually orders by date), so these keep lookups fast as a
        # single coop's history grows into the thousands of rows over years of
        # use, rather than degrading to a full table scan.
        for table in SCOPED:
            conn.execute(f'CREATE INDEX IF NOT EXISTS idx_{table}_coop ON {table} ("coop_id")')
            if "date" in SCHEMA[table]:
                conn.execute(f'CREATE INDEX IF NOT EXISTS idx_{table}_coop_date ON {table} ("coop_id", "date")')
            conn.execute(f'CREATE INDEX IF NOT EXISTS idx_{table}_coop_updated ON {table} ("coop_id", "updated_at")')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_bird_logs_bird ON bird_logs ("bird_id")')

        # Auth: server-local only, deliberately not part of SCHEMA/SCOPED --
        # sessions/invite codes are per-server, never synced to a client.
        conn.execute('''
            CREATE TABLE IF NOT EXISTS auth_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                invite_code TEXT NOT NULL,
                auto_rotate_days INTEGER,
                rotated_at TEXT
            )
        ''')
        existing_auth_cols = {r["name"] for r in conn.execute("PRAGMA table_info(auth_settings)")}
        for col, coltype in [("auto_rotate_days", "INTEGER"), ("rotated_at", "TEXT")]:
            if col not in existing_auth_cols:
                conn.execute(f'ALTER TABLE auth_settings ADD COLUMN "{col}" {coltype}')
        if not conn.execute("SELECT 1 FROM auth_settings WHERE id = 1").fetchone():
            conn.execute("INSERT INTO auth_settings (id, invite_code, rotated_at) VALUES (1, ?, ?)", (generate_invite_code(), _now_iso()))

        conn.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        ''')
        existing_session_cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
        if "last_activity" not in existing_session_cols:
            conn.execute('ALTER TABLE sessions ADD COLUMN "last_activity" TEXT')
        if "role" not in existing_session_cols:
            conn.execute('ALTER TABLE sessions ADD COLUMN "role" TEXT NOT NULL DEFAULT \'admin\'')
        if "invite_code_id" not in existing_session_cols:
            conn.execute('ALTER TABLE sessions ADD COLUMN "invite_code_id" INTEGER')

        conn.execute('''
            CREATE TABLE IF NOT EXISTS invite_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'readonly')),
                label TEXT,
                created_at TEXT NOT NULL,
                revoked_at TEXT
            )
        ''')
        # Demo role removed -- too much surface area (scrambling every
        # financial field correctly, everywhere, forever) for what it was
        # worth. Downgrade any already-existing demo codes/sessions to
        # readonly rather than leaving them in a role the app no longer
        # understands -- SQLite can't alter the CHECK constraint above in
        # place on an existing table, so this handles the data side directly.
        conn.execute("UPDATE invite_codes SET role = 'readonly' WHERE role = 'demo'")
        conn.execute("UPDATE sessions SET role = 'readonly' WHERE role = 'demo'")
        # One-time migration: the original single invite_code becomes the
        # first admin-role entry here, so an already-deployed server's
        # existing code keeps working unchanged -- nobody who already has
        # it gets locked out just because roles now exist.
        existing_code = conn.execute("SELECT invite_code FROM auth_settings WHERE id = 1").fetchone()
        if existing_code and not conn.execute("SELECT 1 FROM invite_codes WHERE code = ?", (existing_code["invite_code"],)).fetchone():
            conn.execute(
                "INSERT INTO invite_codes (code, role, label, created_at) VALUES (?, 'admin', 'Original admin code', ?)",
                (existing_code["invite_code"], _now_iso()),
            )

        conn.execute('''
            CREATE TABLE IF NOT EXISTS failed_logins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name_attempted TEXT,
                code_attempted TEXT,
                ip TEXT,
                attempted_at TEXT NOT NULL
            )
        ''')

        # Admin-editable overrides for the settings that otherwise come from
        # environment variables. A key is only present here if an admin has
        # actually changed it in the app; absent means "use the env default."
        # That ordering matters: it keeps a bare `docker compose up` working
        # exactly as before, lets an operator who prefers config-as-code keep
        # driving everything from compose, and still means nobody has to
        # redeploy a container just to change how long a login lasts.
        conn.execute('''
            CREATE TABLE IF NOT EXISTS server_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        ''')

        # Printed (and written to a file) on every startup, not just when
        # first generated -- this is the deliberate bootstrap mechanism for
        # getting the very first invite code, since /api/auth/invite-code
        # itself requires already being logged in. An unauthenticated
        # endpoint that reveals it would defeat the entire point of having
        # it gate access in the first place -- server console access (or
        # this file) is the intended way in, the same pattern used by a lot
        # of self-hosted apps for their initial setup credential.
        current_code = conn.execute("SELECT invite_code FROM auth_settings WHERE id = 1").fetchone()["invite_code"]
        print("=" * 50)
        print(f"  COOP LEDGER INVITE CODE: {current_code}")
        print(f"  (also written to {DATA_DIR / 'invite_code.txt'})")
        print("=" * 50)
        (DATA_DIR / "invite_code.txt").write_text(current_code + "\n")

        # Migrate any pre-existing (pre-multi-coop) rows into a Default Coop rather than losing them
        orphaned = any(
            conn.execute(f"SELECT COUNT(*) c FROM {table} WHERE coop_id IS NULL").fetchone()["c"] > 0
            for table in SCOPED
        )
        if orphaned:
            existing_default = conn.execute("SELECT id FROM coops WHERE name = ?", ("Default Coop",)).fetchone()
            default_id = existing_default["id"] if existing_default else uuid.uuid4().hex[:12]
            if not existing_default:
                conn.execute(
                    "INSERT INTO coops (id, name, notes, created_date, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (default_id, "Default Coop", "Auto-created to hold data from before multi-coop support.", date.today().isoformat(), _now_iso()),
                )
            for table in SCOPED:
                conn.execute(f"UPDATE {table} SET coop_id = ? WHERE coop_id IS NULL", (default_id,))


def _photo_relpath(photo_value):
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


def _photo_still_referenced(conn, photo_value):
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


def _delete_photo_file(conn, photo_value):
    """Remove a photo file from disk if it's one of ours (a /photos/...
    reference) AND nothing else still references it. See
    _photo_still_referenced for why this needs the caller's own
    connection, and why call ordering (update/delete the row first, then
    call this) matters."""
    p = _photo_relpath(photo_value)
    if p and p.exists() and not _photo_still_referenced(conn, photo_value):
        try:
            p.unlink()
        except OSError:
            pass


def _cascade_delete_bird_photos(conn, bird_id, now):
    """Soft-deletes a bird's timeline (bird_photos) entries and cleans up
    their files where nothing else references them -- call alongside the
    existing bird_logs cascade, after the bird itself is already
    soft-deleted. Without this, a bird's auto-seeded timeline entry stays
    live forever even after the bird is gone, permanently pinning its
    photo file (shared or not) and preventing it from ever being cleaned up."""
    rows = conn.execute("SELECT id, photo FROM bird_photos WHERE bird_id = ? AND deleted_at IS NULL", (bird_id,)).fetchall()
    conn.execute('UPDATE bird_photos SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, bird_id))
    for r in rows:
        _delete_photo_file(conn, r["photo"])


def _save_photo_bytes(coop_id: str, item_id: str, content: bytes, ext: str = ".jpg") -> str:
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


def _photo_to_data_uri(photo_value):
    """For export: turn a stored file reference into a self-contained data URI."""
    if not photo_value:
        return None
    if photo_value.startswith("data:"):
        return photo_value
    p = _photo_relpath(photo_value)
    if not p or not p.exists():
        return None
    ext = p.suffix.lower()
    mime = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/jpeg")
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"


def migrate_base64_photos_to_files():
    """One-time upgrade: birds saved with an earlier version embedded photos directly
    in the database as base64. Convert those into real files on disk."""
    with get_db() as conn:
        rows = conn.execute("SELECT id, coop_id, photo FROM birds WHERE photo LIKE 'data:%'").fetchall()
        for r in rows:
            try:
                header, b64data = r["photo"].split(",", 1)
                ext = ".png" if "png" in header else ".jpg"
                new_ref = _save_photo_bytes(r["coop_id"], r["id"], base64.b64decode(b64data), ext)
                conn.execute("UPDATE birds SET photo = ? WHERE id = ?", (new_ref, r["id"]))
            except Exception:
                pass  # leave the bird's photo as-is if anything about it is malformed


def migrate_flat_photos_to_coop_folders():
    """One-time upgrade: every photo saved before per-coop folders existed
    sits directly in PHOTOS_DIR with no subfolder. Moves each one into its
    owning coop's folder and updates the database reference to match.
    Runs on every startup, but only ever touches files still in the old
    flat layout -- a no-op once everything's been migrated once. Includes
    soft-deleted rows too, so anything that predates the delete-cleanup
    fix doesn't get left behind forever in the old location."""
    with get_db() as conn:
        for table in ("birds", "supply_products", "bird_photos"):
            rows = conn.execute(f"SELECT id, coop_id, photo FROM {table} WHERE photo LIKE '/photos/%'").fetchall()
            for r in rows:
                rel = r["photo"][len("/photos/"):]
                if "/" in rel:
                    continue  # already has a coop subfolder -- already migrated
                old_path = PHOTOS_DIR / rel
                if not old_path.exists():
                    continue  # reference is already stale -- nothing on disk to move
                coop_id = r["coop_id"] or "_unscoped"
                new_dir = PHOTOS_DIR / coop_id
                new_dir.mkdir(parents=True, exist_ok=True)
                try:
                    old_path.rename(new_dir / rel)
                except OSError:
                    continue
                conn.execute(f"UPDATE {table} SET photo = ? WHERE id = ?", (f"/photos/{coop_id}/{rel}", r["id"]))


def migrate_repair_orphaned_photo_refs():
    """One-time-per-startup repair: a couple of historical bugs (a
    cross-connection transaction-visibility issue and a missing
    bird-deletion cascade, both since fixed) could leave a live row
    referencing a photo file that's genuinely gone from disk -- shows up
    as a broken-image placeholder instead of the actual photo.

    For bird_photos specifically, soft-deleting the broken entry (rather
    than trying to fix the reference, since there's nothing left to point
    it at) lets the existing "seed one entry from the bird's current
    photo" logic on the frontend correctly repopulate a valid entry next
    time that bird's timeline is opened -- same mechanism that already
    handles a bird with zero history entries.

    For birds/supply_products, clears the dangling reference so the UI
    falls back to its normal empty-photo placeholder instead of a
    permanently broken image icon."""
    now = _now_iso()
    with get_db() as conn:
        for table in ("bird_photos", "birds", "supply_products"):
            rows = conn.execute(f"SELECT id, photo FROM {table} WHERE photo LIKE '/photos/%' AND deleted_at IS NULL").fetchall()
            for r in rows:
                p = _photo_relpath(r["photo"])
                if p is not None and p.exists():
                    continue  # reference is fine
                if table == "bird_photos":
                    conn.execute(f"UPDATE {table} SET deleted_at = ?, updated_at = ? WHERE id = ?", (now, now, r["id"]))
                else:
                    conn.execute(f"UPDATE {table} SET photo = NULL, updated_at = ? WHERE id = ?", (now, r["id"]))


@asynccontextmanager
async def _lifespan(app):
    await _on_startup()
    yield


app = FastAPI(title="Coop Ledger", lifespan=_lifespan)


# The app shell files below MUST never be cached by an intermediate proxy
# (Cloudflare, etc.) or the browser's own HTTP cache -- not just because
# stale content is annoying, but because sw.js specifically is how the
# browser detects there's a new version at all. If a CDN or browser caches
# THAT file, updates silently stop being detected, no matter how many times
# a deploy actually ships new code. A short max-age here means a browser
# won't even contact the server again for up to a minute after its last
# load of these -- still shows a fresh deploy within that same minute (
# negligible for how often this app actually changes), but avoids a full
# re-download of app.js + style.css (roughly 380KB combined) on every
# single page load, which no-store was forcing even for someone reloading
# twice in a row. That matters if this is ever reachable by more than a
# handful of people at once -- request volume and bandwidth both drop for
# free, without giving up "a fresh deploy shows up fast."
NO_CACHE_PATHS = {"/", "/sw.js", "/manifest.json", "/app.js", "/style.css", "/index.html"}


class NoCacheMiddleware:
    """A plain ASGI middleware, not @app.middleware("http") (which is
    BaseHTTPMiddleware under the hood). BaseHTTPMiddleware has a
    well-documented issue: to let middleware inspect/modify a response, it
    has to reconstruct a full Response object, which in practice means
    buffering the entire body before anything is sent to the client. That's
    harmless for a normal quick response, but fatal for /api/events, whose
    whole point is staying open indefinitely -- a response that never
    finishes can never finish buffering, so the connection just hangs from
    the browser's point of view. This version operates directly on the raw
    ASGI send callable and never reconstructs a response, so a streaming
    path that isn't in NO_CACHE_PATHS passes through completely untouched,
    byte for byte, as it arrives -- there's nothing here that *could*
    buffer it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] not in NO_CACHE_PATHS:
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "public, max-age=60"
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(NoCacheMiddleware)


class SecurityHeadersMiddleware:
    """Same non-buffering ASGI pattern as NoCacheMiddleware above -- only
    mutates headers on http.response.start, never touches the body, so
    streaming responses (/api/events, backup downloads) pass through
    untouched. The headers themselves are the conservative, break-nothing
    set:

    - X-Content-Type-Options: nosniff -- the companion to the magic-byte
      check on photo uploads. Even if something non-image ever ended up
      under /photos/, the browser is told to trust the declared image/*
      type rather than sniffing the bytes and potentially executing them.
    - X-Frame-Options: DENY -- nothing about this app belongs in someone
      else's iframe (the Android TWA is not an iframe and is unaffected).
    - Referrer-Policy: same-origin -- photo URLs carry ?token=... for
      <img> loading; this keeps them from leaking to any external site a
      note or link might ever point at.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["Referrer-Policy"] = "same-origin"
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(SecurityHeadersMiddleware)


# Paths that must stay reachable with no login at all: the login endpoint
# itself (chicken-and-egg otherwise), and the plain reachability check used
# by the "Test connection" button and the online/offline indicator.
PUBLIC_API_PATHS = {"/api/auth/login", "/api/health"}
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Technically a write (deleting your own session row), but blocking it for
# a read-only role would trap someone in a session they can't get out of --
# logging out is always allowed regardless of role.
ALWAYS_ALLOWED_WRITE_PATHS = {"/api/auth/logout"}


class AuthMiddleware:
    """Also a plain ASGI middleware (same reasoning as NoCacheMiddleware
    above) -- this one only ever inspects the request and, when rejecting,
    sends its own complete response; it never wraps or reconstructs the
    downstream response, so it can't introduce any buffering risk for
    /api/events either. Gates every /api/* route except the two paths
    above, AND every /photos/* route -- uploaded photos are real personal
    data (and the whole reason this exists is that a photo URL, once seen
    anywhere, would otherwise stay permanently and publicly fetchable
    forever, with no invite code required, regardless of how the rest of
    the app is locked down). Only the app shell itself (HTML/CSS/JS,
    manifest, service worker, Digital Asset Links) stays unauthenticated,
    since that much has to be reachable just to render a login screen in
    the first place -- none of it is coop data.

    Also enforces role-based write access here, in this same central
    place, rather than in each individual endpoint -- a read-only session
    can authenticate and read everything, but any write method
    (POST/PUT/PATCH/DELETE) gets rejected with 403 before it ever reaches
    an endpoint handler. The actual security boundary for this shouldn't
    depend on every write endpoint separately remembering to check
    permissions; one shared gate that's already proven itself (the login
    check right below) is far harder to accidentally bypass by adding a
    new endpoint later and forgetting the check.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        is_protected = path.startswith("/api/") or path.startswith("/photos/")
        if (
            scope["type"] != "http"
            or scope["method"] == "OPTIONS"  # CORS preflight requests never carry auth headers by design
            or not is_protected
            or path in PUBLIC_API_PATHS
        ):
            await self.app(scope, receive, send)
            return

        headers = dict(scope["headers"])
        auth_header = headers.get(b"authorization", b"").decode()
        token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None
        if not token:
            query_params = parse_qs(scope.get("query_string", b"").decode())
            token = query_params.get("token", [None])[0]

        role = None
        if token:
            with get_db() as conn:
                row = conn.execute("SELECT role, last_activity FROM sessions WHERE token = ?", (token,)).fetchone()
                if row:
                    role = row["role"]
                    # Keep last_activity current so idle-session expiry (and
                    # the Sessions list on the Server page) reflects reality --
                    # most requests only ever pass through here, not through
                    # _require_auth. Throttled to once an hour per session so
                    # this stays one read per request, not a write per request.
                    last = row["last_activity"]
                    if not last or (_now_iso()[:13] != last[:13]):  # different UTC hour
                        conn.execute("UPDATE sessions SET last_activity = ? WHERE token = ?", (_now_iso(), token))

        if role is None:
            response = JSONResponse({"detail": "Not logged in"}, status_code=401)
            await response(scope, receive, send)
            return

        if role == "readonly" and scope["method"] in WRITE_METHODS and path not in ALWAYS_ALLOWED_WRITE_PATHS:
            response = JSONResponse({"detail": "Read-only access -- this action isn't available"}, status_code=403)
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)


app.add_middleware(AuthMiddleware)

# Added last (outermost) on purpose: this means CORS headers get applied to
# every response, including a 401 from AuthMiddleware above -- otherwise a
# cross-origin client (e.g. a wrapped app pointed at a separately-configured
# server) wouldn't be able to read the rejection at all, since the browser
# blocks reading a cross-origin response body with no CORS headers on it,
# regardless of status code.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    """Cheap reachability ping for the app's online/offline indicator, and
    reports this server's version so the client can detect a mismatch --
    e.g. a self-hosted sync server that hasn't been restarted since the
    static frontend it's serving (or being talked to by) auto-updated."""
    return {"status": "ok", "db": str(DB_PATH), "version": SERVER_VERSION}


# ---------- Coop-specific routes (registered before the generic ones below, since
#             they'd otherwise be shadowed by /api/{resource} and /api/{resource}/{item_id}) ----------

@app.get("/api/coops")
def list_coops():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM coops WHERE deleted_at IS NULL ORDER BY created_date ASC").fetchall()
        return [dict(r) for r in rows]


@app.post("/api/coops")
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
            _sse_publish(GLOBAL_CHANNEL, "coops")
            return row
        # updated_at must be set explicitly here -- SQL's "WHERE updated_at > ?"
        # (used by every incremental sync) never matches a NULL value, so a row
        # created without it is permanently invisible to any device that's
        # already synced before, not just delayed. This was the actual root
        # cause of coops never appearing on other devices.
        conn.execute(
            "INSERT INTO coops (id, name, notes, created_date, settings, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (coop_id, name, payload.get("notes", ""), date.today().isoformat(), json.dumps(DEFAULT_SETTINGS), _now_iso()),
        )
        row = dict(conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone())
        _sse_publish(GLOBAL_CHANNEL, "coops")
        return row


def _do_import_bundle(bundle: dict, zip_photo_reader=None) -> dict:
    """Shared import logic for both the JSON-body endpoint (old format, photos
    as base64 data URIs) and the new zip endpoint (photos as separate files,
    referenced by their relative path inside the zip)."""
    src = bundle.get("coop") or {}
    name = (src.get("name") or "Imported Coop").strip()
    with get_db() as conn:
        new_id = uuid.uuid4().hex[:12]
        conn.execute(
            "INSERT INTO coops (id, name, notes, created_date, settings, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (new_id, name, src.get("notes", ""), src.get("created_date") or date.today().isoformat(), src.get("settings") or json.dumps(DEFAULT_SETTINGS), _now_iso()),
        )
        bird_id_map = {}
        product_id_map = {}
        hatch_id_map = {}
        # supply_products before supplies (so product_id can be remapped),
        # birds before bird_logs and bird_photos (both need bird_id
        # remapped), hatch_eggs last of all (needs both hatches and birds
        # already imported) -- everything else order doesn't matter.
        import_order = ["birds", "supply_products"] + [t for t in SCOPED if t not in ("birds", "bird_logs", "bird_photos", "supply_products", "supplies", "hatch_eggs")] + ["supplies", "bird_logs", "bird_photos", "hatch_eggs"]
        for table in import_order:
            cols = [c for c in SCHEMA[table] if c != "coop_id"]
            for row in bundle.get(table, []) or []:
                row = dict(row)
                new_row_id = uuid.uuid4().hex[:12]
                if table == "birds":
                    old_bird_id = row.get("id")
                    photo = row.get("photo")
                    new_photo = None
                    if isinstance(photo, str) and photo.startswith("data:"):
                        try:
                            header, b64data = photo.split(",", 1)
                            ext = ".png" if "png" in header else ".jpg"
                            new_photo = _save_photo_bytes(new_id, new_row_id, base64.b64decode(b64data), ext)
                        except Exception:
                            new_photo = None
                    elif isinstance(photo, str) and photo and zip_photo_reader is not None:
                        content = zip_photo_reader(photo)
                        if content:
                            ext = Path(photo).suffix.lower() or ".jpg"
                            new_photo = _save_photo_bytes(new_id, new_row_id, content, ext)
                    row["photo"] = new_photo
                if table == "supply_products":
                    old_product_id = row.get("id")
                    photo = row.get("photo")
                    new_photo = None
                    if isinstance(photo, str) and photo.startswith("data:"):
                        try:
                            header, b64data = photo.split(",", 1)
                            ext = ".png" if "png" in header else ".jpg"
                            new_photo = _save_photo_bytes(new_id, new_row_id, base64.b64decode(b64data), ext)
                        except Exception:
                            new_photo = None
                    elif isinstance(photo, str) and photo and zip_photo_reader is not None:
                        content = zip_photo_reader(photo)
                        if content:
                            ext = Path(photo).suffix.lower() or ".jpg"
                            new_photo = _save_photo_bytes(new_id, new_row_id, content, ext)
                    row["photo"] = new_photo
                if table == "supplies" and row.get("product_id"):
                    row["product_id"] = product_id_map.get(row["product_id"])  # None if the product wasn't in this export -- fine, just an unlinked bag
                if table == "bird_logs":
                    new_bird_id = bird_id_map.get(row.get("bird_id"))
                    if not new_bird_id:
                        continue  # log referenced a bird that wasn't in this export; skip it
                    row["bird_id"] = new_bird_id
                if table == "bird_photos":
                    new_bird_id = bird_id_map.get(row.get("bird_id"))
                    if not new_bird_id:
                        continue  # referenced a bird that wasn't in this export; skip it
                    row["bird_id"] = new_bird_id
                    photo = row.get("photo")
                    new_photo = None
                    if isinstance(photo, str) and photo.startswith("data:"):
                        try:
                            header, b64data = photo.split(",", 1)
                            ext = ".png" if "png" in header else ".jpg"
                            new_photo = _save_photo_bytes(new_id, new_row_id, base64.b64decode(b64data), ext)
                        except Exception:
                            new_photo = None
                    elif isinstance(photo, str) and photo and zip_photo_reader is not None:
                        content = zip_photo_reader(photo)
                        if content:
                            ext = Path(photo).suffix.lower() or ".jpg"
                            new_photo = _save_photo_bytes(new_id, new_row_id, content, ext)
                    row["photo"] = new_photo
                if table == "hatch_eggs":
                    new_hatch_id = hatch_id_map.get(row.get("hatch_id"))
                    if not new_hatch_id:
                        continue  # egg referenced a clutch that wasn't in this export; skip it
                    row["hatch_id"] = new_hatch_id
                    if row.get("bird_id"):
                        row["bird_id"] = bird_id_map.get(row["bird_id"])  # None if that bird wasn't in this export -- fine, the egg just loses its flock link
                fields = ["id", "coop_id", "updated_at"] + [c for c in cols if c in row]
                values = [new_row_id, new_id, _now_iso()] + [row[c] for c in cols if c in row]
                placeholders = ", ".join("?" for _ in fields)
                col_list = ", ".join(f'"{f}"' for f in fields)
                conn.execute(f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})", values)
                if table == "birds":
                    bird_id_map[old_bird_id] = new_row_id
                if table == "supply_products":
                    product_id_map[old_product_id] = new_row_id
                if table == "hatches":
                    hatch_id_map[old_hatch_id] = new_row_id
        return dict(conn.execute("SELECT * FROM coops WHERE id = ?", (new_id,)).fetchone())


@app.post("/api/coops/import")
def import_coop(payload: dict = Body(...)):
    return _do_import_bundle(payload)


@app.post("/api/coops/import.zip")
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

    return _do_import_bundle(bundle, zip_photo_reader=read_zip_photo)


@app.get("/api/coops/{coop_id}/export")
def export_coop(coop_id: str):
    with get_db() as conn:
        coop = conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone()
        if not coop:
            raise HTTPException(404, "Coop not found")
        bundle = {"version": 1, "exported_at": date.today().isoformat(), "coop": dict(coop)}
        for table in SCOPED:
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE coop_id = ? AND deleted_at IS NULL", (coop_id,)).fetchall()]
            if table in ("birds", "supply_products", "bird_photos"):
                for r in rows:
                    r["photo"] = _photo_to_data_uri(r["photo"])
            bundle[table] = rows
        return bundle


@app.get("/api/coops/{coop_id}/export.zip")
def export_coop_zip(coop_id: str):
    """Same full backup as /export, but photos ship as real files in a photos/
    folder instead of being base64-inflated inline -- smaller, faster, and the
    photos are directly viewable/recoverable straight out of the zip."""
    with get_db() as conn:
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
                    p = _photo_relpath(photo_ref)
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


@app.get("/api/coops/{coop_id}/export.csv")
def export_coop_csv(coop_id: str):
    with get_db() as conn:
        coop = conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone()
        if not coop:
            raise HTTPException(404, "Coop not found")

        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for table in SCOPED:
                fieldnames = ["id"] + [c for c in SCHEMA[table] if c != "coop_id"]
                if table in ("birds", "supply_products", "bird_photos"):
                    fieldnames = [f for f in fieldnames if f != "photo"]  # base64 blobs don't belong in a spreadsheet
                rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE coop_id = ? AND deleted_at IS NULL", (coop_id,)).fetchall()]
                csv_buf = io.StringIO()
                writer = csv.DictWriter(csv_buf, fieldnames=fieldnames, extrasaction="ignore")
                writer.writeheader()
                for r in rows:
                    writer.writerow({k: r.get(k, "") for k in fieldnames})
                zf.writestr(f"{table}.csv", csv_buf.getvalue())

        zip_buf.seek(0)
        safe_name = "".join(c if c.isalnum() else "-" for c in coop["name"]).strip("-").lower() or "coop"
        filename = f"{safe_name}-csv-{date.today().isoformat()}.zip"
        return StreamingResponse(
            zip_buf,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


@app.get("/api/admin/server-info")
def get_server_info(request: Request):
    _require_admin(request)

    with get_db() as conn:
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
            "photos_bytes": _dir_size(PHOTOS_DIR),
            "backups_bytes": _dir_size(BACKUP_DIR),
            "data_dir_bytes": _dir_size(DATA_DIR),
        },
        "backups": {
            "count": len(backups),
            "most_recent": most_recent_backup,
            "max_kept": _get_setting("max_backups_to_keep"),
            "interval_hours": _get_setting("backup_interval_hours"),
        },
        "auth": {
            "active_sessions": active_session_count,
            "active_invite_codes": invite_code_count,
        },
    }


@app.get("/api/admin/server-settings")
def get_server_settings(request: Request):
    _require_admin(request)
    out = {}
    for key, spec in OVERRIDABLE_SETTINGS.items():
        out[key] = {
            "value": _get_setting(key),
            "env_default": spec["env_default"](),
            "overridden": _setting_is_overridden(key),  # lets the UI show "set in the app" vs "from your compose file"
            "type": spec["type"],
            "min": spec.get("min"),
            "max": spec.get("max"),
        }
    return {"settings": out}


@app.put("/api/admin/server-settings")
async def update_server_settings(request: Request):
    _require_admin(request)
    body = await request.json()
    now = _now_iso()
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
                    raise HTTPException(400, f"{key} must be a whole number")
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
    _prune_idle_sessions()
    return {"ok": True, "settings": get_server_settings(request)["settings"]}


@app.get("/api/backups")
def list_backups(request: Request):
    # Admin-only, like everything else on the Server settings page. The
    # middleware's write-blocking doesn't help here (these are GETs), and
    # a backup is the single most sensitive thing this server has: the
    # database inside it contains every invite code and every session
    # token. A read-only session being able to fetch one would be a
    # direct path to escalating itself to admin.
    _require_admin(request)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backups = []
    for p in sorted([d for d in BACKUP_DIR.glob("backup-*") if d.is_dir()], key=lambda p: p.name, reverse=True):
        size_bytes = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
        stat = p.stat()
        backups.append({"filename": p.name, "size_bytes": size_bytes, "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()})
    return {"backups": backups}


@app.get("/api/backups/{filename}")
def download_backup(filename: str, request: Request):
    _require_admin(request)  # see list_backups above -- a backup contains all codes and tokens
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


@app.delete("/api/coops/{coop_id}")
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
            _delete_photo_file(conn, photo_value)
        # Soft delete, not a hard DELETE -- same reasoning as every other
        # resource in this app: a hard delete leaves nothing behind for a
        # future "what's changed since X" sync to detect, so other devices
        # would never learn the coop was gone. Child data above still gets
        # hard-deleted, since a deleted coop should genuinely lose its data.
        now = _now_iso()
        conn.execute("UPDATE coops SET deleted_at = ?, updated_at = ? WHERE id = ?", (now, now, coop_id))
        _sse_publish(GLOBAL_CHANNEL, "coops")
        return {"deleted": coop_id}


def _sniff_image_ext(content: bytes) -> str | None:
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


async def _upload_photo_for(table: str, item_id: str, file: UploadFile):
    with get_db() as conn:
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
    ext = _sniff_image_ext(content)
    if ext is None:
        # The Content-Type header is just whatever the client claims; the
        # bytes themselves are what actually gets stored and later served
        # back. Only accept things that are verifiably image data.
        raise HTTPException(415, "That file doesn't look like an image -- photos must be JPEG, PNG, WebP, or GIF")
    new_ref = _save_photo_bytes(coop_id, item_id, content, ext)

    with get_db() as conn:
        conn.execute(f'UPDATE {table} SET photo = ?, updated_at = ? WHERE id = ?', (new_ref, _now_iso(), item_id))
        _delete_photo_file(conn, old_photo)  # after the update, so a shared old photo isn't wrongly seen as still used by this row
        return {"photo": new_ref}


def _remove_photo_for(table: str, item_id: str):
    with get_db() as conn:
        row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        old_photo = row["photo"]
        conn.execute(f'UPDATE {table} SET photo = NULL, updated_at = ? WHERE id = ?', (_now_iso(), item_id))
        _delete_photo_file(conn, old_photo)
        return {"removed": True}


@app.post("/api/supply_products/{product_id}/photo")
async def upload_supply_product_photo(product_id: str, file: UploadFile = File(...)):
    return await _upload_photo_for("supply_products", product_id, file)


@app.delete("/api/supply_products/{product_id}/photo")
def remove_supply_product_photo(product_id: str):
    return _remove_photo_for("supply_products", product_id)


@app.post("/api/birds/{bird_id}/photo")
async def upload_bird_photo(bird_id: str, file: UploadFile = File(...)):
    return await _upload_photo_for("birds", bird_id, file)


@app.delete("/api/birds/{bird_id}/photo")
def remove_bird_photo(bird_id: str):
    return _remove_photo_for("birds", bird_id)


@app.post("/api/bird_photos/{photo_id}/photo")
async def upload_bird_history_photo(photo_id: str, file: UploadFile = File(...)):
    return await _upload_photo_for("bird_photos", photo_id, file)


@app.delete("/api/bird_photos/{photo_id}/photo")
def remove_bird_history_photo(photo_id: str):
    return _remove_photo_for("bird_photos", photo_id)


@app.post("/api/birds/bulk-update")
def bulk_update_birds(payload: dict = Body(...)):
    ids = payload.get("ids") or []
    updates = payload.get("updates") or {}
    if not ids or not isinstance(ids, list):
        raise HTTPException(400, "ids (a list) is required")
    cols = SCHEMA["birds"]
    valid_updates = {k: v for k, v in updates.items() if k in cols and k != "coop_id"}
    if not valid_updates:
        raise HTTPException(400, "No valid fields to update")
    set_clause = ", ".join(f'"{c}" = ?' for c in valid_updates) + ', "updated_at" = ?'
    with get_db() as conn:
        updated = 0
        for bird_id in ids:
            cur = conn.execute(f"UPDATE birds SET {set_clause} WHERE id = ?", list(valid_updates.values()) + [_now_iso(), bird_id])
            updated += cur.rowcount
        return {"updated": updated}


@app.post("/api/birds/bulk-delete")
def bulk_delete_birds(payload: dict = Body(...)):
    ids = payload.get("ids") or []
    if not ids or not isinstance(ids, list):
        raise HTTPException(400, "ids (a list) is required")
    with get_db() as conn:
        deleted = 0
        now = _now_iso()
        for bird_id in ids:
            row = conn.execute("SELECT photo FROM birds WHERE id = ? AND deleted_at IS NULL", (bird_id,)).fetchone()
            if row:
                conn.execute('UPDATE bird_logs SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, bird_id))
                conn.execute('UPDATE birds SET deleted_at = ?, updated_at = ? WHERE id = ?', (now, now, bird_id))
                _cascade_delete_bird_photos(conn, bird_id, now)
                _delete_photo_file(conn, row["photo"])
                deleted += 1
        return {"deleted": deleted}


@app.post("/api/birds/bulk")
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
            row["updated_at"] = _now_iso()
            fields = ["id"] + list(row.keys())
            values = [bird_id] + list(row.values())
            placeholders = ", ".join("?" for _ in fields)
            col_list = ", ".join(f'"{f}"' for f in fields)
            conn.execute(f"INSERT INTO birds ({col_list}) VALUES ({placeholders})", values)
            created_ids.append(bird_id)
    return {"created": len(created_ids), "batch_name": batch_name, "created_ids": created_ids}


# ---------- Auth ----------
# Deliberately not a full user-account system: one shared, rotatable invite
# code gates entry (like a WiFi password), and anyone who provides it picks
# their own display name and gets a session token. Rotating the code only
# affects future logins -- it never invalidates sessions already granted.

def _extract_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return request.query_params.get("token")  # EventSource can't send custom headers, so SSE relies on this


def _require_auth(request: Request) -> str:
    token = _extract_token(request)
    if token:
        with get_db() as conn:
            row = conn.execute("SELECT name FROM sessions WHERE token = ?", (token,)).fetchone()
            if row:
                conn.execute("UPDATE sessions SET last_activity = ? WHERE token = ?", (_now_iso(), token))
                return row["name"]
    raise HTTPException(401, "Not logged in")


def _require_admin(request: Request) -> str:
    """Like _require_auth, but for endpoints that must stay admin-only even
    for reads -- viewing or managing invite codes, for instance, where a
    read-only session simply reading the admin code would let it escalate
    its own access. The middleware's write-blocking doesn't cover this
    case since a GET is a read, not a write."""
    token = _extract_token(request)
    if token:
        with get_db() as conn:
            row = conn.execute("SELECT name, role FROM sessions WHERE token = ?", (token,)).fetchone()
            if row:
                if row["role"] != "admin":
                    raise HTTPException(403, "Admin access required")
                conn.execute("UPDATE sessions SET last_activity = ? WHERE token = ?", (_now_iso(), token))
                return row["name"]
    raise HTTPException(401, "Not logged in")


# Rate limiting on login specifically: an 8-character invite code has a lot
# of possible values, but that only matters if guessing it is actually slow.
# Unthrottled, a bot could try thousands of codes a second: this is what
# makes brute force genuinely impractical rather than just inconvenient.
# In-memory and per-process is fine here -- a restart clearing it is a minor
# inconvenience for an attacker, not a real weakness, for an app this size.
_failed_login_attempts: dict[str, list[float]] = {}
MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCKOUT_SECONDS = 15 * 60


def _client_ip(request: Request) -> str:
    # Behind Cloudflare Tunnel, request.client.host is the tunnel's own local
    # connection, not the real visitor -- every request would look like it
    # came from the same place, making per-IP limiting meaningless (one
    # person's failed attempts would lock out everyone). Cloudflare forwards
    # the real IP via this header, and Cloudflare itself sets/overwrites it,
    # so it can be trusted -- but only when something's actually terminating
    # traffic in front of this process. Exposed directly to the internet,
    # these same headers are just arbitrary client input: anyone could send
    # a different fake IP on every single request and make the login lockout
    # below count nothing at all. Only trust them when explicitly told to.
    if os.environ.get("TRUST_PROXY_HEADERS") == "1":
        cf_ip = request.headers.get("cf-connecting-ip")
        if cf_ip:
            return cf_ip
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_login_rate_limit(ip: str):
    now = time.time()
    attempts = [t for t in _failed_login_attempts.get(ip, []) if now - t < LOGIN_LOCKOUT_SECONDS]
    _failed_login_attempts[ip] = attempts
    if len(attempts) >= MAX_LOGIN_ATTEMPTS:
        raise HTTPException(429, f"Too many failed attempts. Try again in a few minutes.")


def _record_failed_login(ip: str, name: str = "", code: str = ""):
    _failed_login_attempts.setdefault(ip, []).append(time.time())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO failed_logins (name_attempted, code_attempted, ip, attempted_at) VALUES (?, ?, ?, ?)",
            (name, code, ip, _now_iso()),
        )


@app.post("/api/auth/login")
def login(payload: dict = Body(...), request: Request = None):
    ip = _client_ip(request)
    _check_login_rate_limit(ip)
    name = (payload.get("name") or "").strip()
    code = (payload.get("code") or "").strip()
    if not name:
        raise HTTPException(400, "Name is required")
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, role FROM invite_codes WHERE UPPER(code) = UPPER(?) AND revoked_at IS NULL",
            (code,),
        ).fetchone()
        if not row:
            _record_failed_login(ip, name, code)
            raise HTTPException(401, "Invalid invite code")
        role = row["role"]
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token, name, created_at, role, invite_code_id) VALUES (?, ?, ?, ?, ?)",
            (token, name, _now_iso(), role, row["id"]),
        )
        return {"token": token, "name": name, "role": role}


@app.get("/api/auth/me")
def auth_me(request: Request):
    token = _extract_token(request)
    with get_db() as conn:
        row = conn.execute("SELECT name, role FROM sessions WHERE token = ?", (token,)).fetchone()
    if not row:
        raise HTTPException(401, "Not logged in")
    return {"name": row["name"], "role": row["role"]}


@app.post("/api/auth/logout")
def logout(request: Request):
    token = _extract_token(request)
    if token:
        with get_db() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return {"ok": True}


@app.get("/api/auth/invite-code")
def get_invite_code(request: Request):
    _require_admin(request)
    with get_db() as conn:
        row = conn.execute("SELECT invite_code, auto_rotate_days FROM auth_settings WHERE id = 1").fetchone()
        return {"invite_code": row["invite_code"], "auto_rotate_days": row["auto_rotate_days"]}


@app.post("/api/auth/invite-code/rotate")
def rotate_invite_code(request: Request):
    _require_admin(request)
    new_code = generate_invite_code()
    with get_db() as conn:
        old_code = conn.execute("SELECT invite_code FROM auth_settings WHERE id = 1").fetchone()["invite_code"]
        conn.execute("UPDATE auth_settings SET invite_code = ?, rotated_at = ? WHERE id = 1", (new_code, _now_iso()))
        # Keep the invite_codes table in sync -- this IS the same primary
        # admin code tracked there, just rotated to a new value.
        conn.execute("UPDATE invite_codes SET code = ? WHERE code = ?", (new_code, old_code))
    return {"invite_code": new_code}


@app.post("/api/auth/invite-code/auto-rotate")
def set_auto_rotate(payload: dict = Body(...), request: Request = None):
    _require_admin(request)
    days = payload.get("days")  # null/None disables it
    with get_db() as conn:
        conn.execute("UPDATE auth_settings SET auto_rotate_days = ? WHERE id = 1", (days,))
    return {"auto_rotate_days": days}


@app.get("/api/auth/sessions")
def list_sessions(request: Request):
    _require_admin(request)
    with get_db() as conn:
        rows = conn.execute("SELECT id, name, created_at, last_activity, role FROM sessions ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


@app.get("/api/auth/invite-codes")
def list_invite_codes(request: Request):
    _require_admin(request)
    with get_db() as conn:
        rows = conn.execute("SELECT id, code, role, label, created_at, revoked_at FROM invite_codes ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


@app.post("/api/auth/invite-codes")
def create_invite_code(payload: dict = Body(...), request: Request = None):
    _require_admin(request)
    role = payload.get("role")
    if role not in ("admin", "readonly"):
        raise HTTPException(400, "role must be one of: admin, readonly")
    label = (payload.get("label") or "").strip() or None
    code = generate_invite_code()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO invite_codes (code, role, label, created_at) VALUES (?, ?, ?, ?)",
            (code, role, label, _now_iso()),
        )
    return {"code": code, "role": role, "label": label}


@app.delete("/api/auth/invite-codes/{code_id}")
def revoke_invite_code(code_id: int, request: Request):
    _require_admin(request)
    with get_db() as conn:
        row = conn.execute("SELECT code, role FROM invite_codes WHERE id = ?", (code_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Invite code not found")
        admin_count = conn.execute(
            "SELECT COUNT(*) as n FROM invite_codes WHERE role = 'admin' AND revoked_at IS NULL"
        ).fetchone()["n"]
        if row["role"] == "admin" and admin_count <= 1:
            # Never allow revoking the last admin code -- that would
            # permanently lock everyone out with no way back in short of
            # editing the database directly.
            raise HTTPException(400, "Can't revoke the last remaining admin code")
        conn.execute("UPDATE invite_codes SET revoked_at = ? WHERE id = ?", (_now_iso(), code_id))
        # Any sessions already logged in under this specific code are cut
        # off immediately too, not just future login attempts -- but only
        # those, not sessions from any other still-valid code (including
        # the admin's own session doing this revoke).
        conn.execute("DELETE FROM sessions WHERE invite_code_id = ?", (code_id,))
    return {"revoked": True}


@app.delete("/api/auth/invite-codes/{code_id}/permanent")
def delete_invite_code_permanently(code_id: int, request: Request):
    _require_admin(request)
    with get_db() as conn:
        row = conn.execute("SELECT revoked_at FROM invite_codes WHERE id = ?", (code_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Invite code not found")
        if row["revoked_at"] is None:
            # Requires revoking first -- a deliberate two-step process for
            # something this sensitive, so an active code can't be
            # permanently removed by a single misclick.
            raise HTTPException(400, "Revoke this code before deleting it permanently")
        conn.execute("DELETE FROM invite_codes WHERE id = ?", (code_id,))
    return {"deleted": True}


@app.get("/api/auth/failed-logins")
def list_failed_logins(request: Request):
    # Admin-only, not just logged-in: code_attempted routinely contains a
    # VALID code someone typed alongside a mistyped name, or a code one
    # character off from a real one. Letting a read-only session read this
    # list would hand it exactly the material needed to escalate itself.
    _require_admin(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name_attempted, code_attempted, ip, attempted_at FROM failed_logins ORDER BY attempted_at DESC LIMIT 100"
        ).fetchall()
        return [dict(r) for r in rows]


@app.delete("/api/auth/sessions/{session_id}")
def revoke_session(session_id: int, request: Request):
    # The middleware already blocks readonly DELETEs, but revoking someone
    # else's session is an admin action -- enforce that here too rather
    # than relying on the write-gate alone (defense in depth, and it stays
    # correct even if a future role gains some write access).
    _require_admin(request)
    with get_db() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    return {"ok": True}


# ---------- Live updates (Server-Sent Events) ----------
# Purely a "go check now" nudge -- the instant something changes for a coop,
# every connected device for that coop gets a tiny message telling it which
# resource to sync, so it can pull the real data through the normal sync
# endpoint immediately instead of waiting out its next poll interval. This
# doesn't touch how syncing itself works at all, it just wakes it up sooner.
# In-memory only, scoped to this one process -- entirely appropriate for a
# small self-hosted instance; it doesn't need to survive a restart.
# IMPORTANT: this must be registered before the generic /api/{resource}
# route below -- "events" has no extra path segment to distinguish it, so if
# the catch-all route is registered first, it matches "/api/events" too
# (treating "events" as if it were a resource name) and this route never
# gets a chance to run at all.
_sse_subscribers: dict[str, list[asyncio.Queue]] = {}
_main_event_loop: asyncio.AbstractEventLoop | None = None


def _maybe_auto_rotate_invite_code():
    with get_db() as conn:
        row = conn.execute("SELECT auto_rotate_days, rotated_at FROM auth_settings WHERE id = 1").fetchone()
        if not row or not row["auto_rotate_days"]:
            return
        rotated_at = datetime.fromisoformat(row["rotated_at"]) if row["rotated_at"] else None
        due = (not rotated_at) or (datetime.now(timezone.utc) - rotated_at).days >= row["auto_rotate_days"]
        if due:
            new_code = generate_invite_code()
            conn.execute("UPDATE auth_settings SET invite_code = ?, rotated_at = ? WHERE id = 1", (new_code, _now_iso()))
            print(f"Invite code auto-rotated (scheduled): {new_code}")


def _prune_old_activity_log():
    cutoff = (datetime.now(timezone.utc) - timedelta(days=_get_setting("activity_log_retention_days"))).isoformat()
    now = _now_iso()
    with get_db() as conn:
        conn.execute(
            'UPDATE activity_log SET deleted_at = ?, updated_at = ? WHERE updated_at < ? AND deleted_at IS NULL',
            (now, now, cutoff),
        )


def _prune_old_failed_logins():
    # Keep the most recent 500 -- enough history to spot a pattern (someone
    # guessing codes, a bot hammering the endpoint) without growing forever.
    with get_db() as conn:
        conn.execute('''
            DELETE FROM failed_logins WHERE id NOT IN (
                SELECT id FROM failed_logins ORDER BY attempted_at DESC LIMIT 500
            )
        ''')


def _prune_idle_sessions():
    """Drops sessions that haven't been used in the configured idle window.
    Disabled entirely at the default of 0 -- a household server where
    logging in once on the kitchen tablet is meant to stick forever is
    a perfectly reasonable setup, so expiry is strictly opt-in."""
    days = _get_setting("session_max_idle_days")
    if days <= 0:
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with get_db() as conn:
        # COALESCE: sessions from before last_activity existed have only
        # created_at to judge idleness by -- better than never expiring them.
        cur = conn.execute(
            "DELETE FROM sessions WHERE COALESCE(last_activity, created_at) < ?",
            (cutoff,),
        )
        if cur.rowcount:
            print(f"Pruned {cur.rowcount} session(s) idle for over {days} days")


BACKUP_DIR = DATA_DIR / "backups"


def _create_full_backup():
    """Creates a timestamped backup folder: a fresh database snapshot (via
    SQLite's online backup API -- safe against a live database, correctly
    captures WAL-mode state with nothing paused) plus every photo on disk,
    hard-linked rather than copied since photos are effectively immutable
    once uploaded. Rotates out anything past the configured keep count."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    backup_folder = BACKUP_DIR / f"backup-{timestamp}"
    backup_folder.mkdir()

    source = sqlite3.connect(DB_PATH)
    dest = sqlite3.connect(str(backup_folder / "coop.db"))
    try:
        source.backup(dest)
    finally:
        dest.close()
        source.close()

    if PHOTOS_DIR.exists():
        backup_photos_dir = backup_folder / "photos"
        for photo_file in PHOTOS_DIR.rglob("*"):
            if not photo_file.is_file():
                continue
            rel = photo_file.relative_to(PHOTOS_DIR)
            dest_path = backup_photos_dir / rel
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(photo_file, dest_path)  # hard link -- same disk blocks, no extra space used
            except OSError:
                shutil.copy2(photo_file, dest_path)  # different filesystem or link limit hit -- fall back to a real copy

    existing = sorted([p for p in BACKUP_DIR.glob("backup-*") if p.is_dir()], key=lambda p: p.name, reverse=True)
    for old in existing[_get_setting("max_backups_to_keep"):]:
        shutil.rmtree(old, ignore_errors=True)  # removes this backup's links; each photo's actual data survives as long as the live copy or any other backup still references it
    print(f"Automatic backup created: {backup_folder.name}")


def _maybe_run_scheduled_backup():
    if not _get_setting("backups_enabled"):
        return
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    existing = sorted([p for p in BACKUP_DIR.glob("backup-*") if p.is_dir()], key=lambda p: p.name, reverse=True)
    if existing:
        # Folder names are backup-YYYYMMDD-HHMMSS -- the timestamp is
        # parsed directly out of the most recent one rather than tracked
        # in a separate database column, since the folders already record
        # exactly when they were made.
        try:
            ts_str = existing[0].name.replace("backup-", "")
            last_backup_time = datetime.strptime(ts_str, "%Y%m%d-%H%M%S-%f").replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - last_backup_time).total_seconds() < _get_setting("backup_interval_hours") * 3600:
                return
        except ValueError:
            pass  # malformed folder name somehow -- just proceed with a fresh backup
    try:
        _create_full_backup()
    except Exception as e:
        print(f"Scheduled backup failed: {e}")


async def _periodic_maintenance_loop():
    while True:
        await asyncio.sleep(3600)  # once an hour is plenty for both of these
        try:
            _maybe_auto_rotate_invite_code()
            _prune_old_activity_log()
            _prune_old_failed_logins()
            _prune_idle_sessions()
            _maybe_run_scheduled_backup()
        except Exception as e:
            print(f"Periodic maintenance error: {e}")


def migrate_repair_orphaned_hatch_eggs():
    """Tombstones hatch_eggs whose parent hatch was already deleted -- these
    are orphans from before hatch deletion cascaded to its egg rows. They
    were invisible in the app (nothing renders eggs for a deleted clutch)
    but still counted, synced to every device, and carried in every backup.
    Setting updated_at makes the fix itself sync outward, so every device's
    local copy gets the same cleanup on its next pull."""
    now = _now_iso()
    with get_db() as conn:
        cur = conn.execute(
            """UPDATE hatch_eggs SET deleted_at = ?, updated_at = ?
               WHERE deleted_at IS NULL AND hatch_id IN (SELECT id FROM hatches WHERE deleted_at IS NOT NULL)""",
            (now, now),
        )
        if cur.rowcount:
            print(f"Repair: tombstoned {cur.rowcount} orphaned hatch_eggs row(s) whose clutch was already deleted")


async def _on_startup():
    """All startup work in one place (modern lifespan handler, replacing the
    two deprecated @app.on_event hooks this grew out of). Order matters:
    the schema must exist before the migrations that touch it, and the
    event loop must be captured before anything can publish SSE events."""
    global _main_event_loop
    _main_event_loop = asyncio.get_running_loop()
    init_db()
    migrate_base64_photos_to_files()
    migrate_flat_photos_to_coop_folders()
    migrate_repair_orphaned_photo_refs()
    migrate_repair_orphaned_hatch_eggs()
    _maybe_auto_rotate_invite_code()  # catch anything overdue from while the server was down
    _prune_old_activity_log()
    _prune_old_failed_logins()
    _prune_idle_sessions()
    _maybe_run_scheduled_backup()
    asyncio.create_task(_periodic_maintenance_loop())


def _safe_put(q: asyncio.Queue, resource: str):
    try:
        q.put_nowait(resource)
    except asyncio.QueueFull:
        pass  # a slow/stuck subscriber shouldn't block everyone else


# Coop-level events (create, rename, delete a coop) don't have a natural
# single coop_id to scope to the way birds/eggs/etc do -- a rename should
# reach anyone connected regardless of which coop they currently have
# selected, since the Coops list itself isn't scoped to one active coop.
# Every SSE connection subscribes to this in addition to its own coop_id.
GLOBAL_CHANNEL = "_global_"


def _sse_publish(coop_id: str | None, resource: str):
    if not coop_id or not _main_event_loop:
        return
    # create_item/update_item/delete_item are plain `def`, so FastAPI runs
    # them in a worker thread, not on the event loop the SSE connections
    # actually live on. asyncio.Queue isn't thread-safe -- calling
    # put_nowait() directly from that thread doesn't reliably wake up a
    # get() that's waiting on the main loop. call_soon_threadsafe is the
    # actual correct way to hand work back to the loop from another thread.
    for q in _sse_subscribers.get(coop_id, []):
        _main_event_loop.call_soon_threadsafe(_safe_put, q, resource)


@app.get("/api/events")
async def sse_events(coop_id: str):
    queue: asyncio.Queue = asyncio.Queue(maxsize=50)
    _sse_subscribers.setdefault(coop_id, []).append(queue)
    _sse_subscribers.setdefault(GLOBAL_CHANNEL, []).append(queue)

    async def event_stream():
        try:
            yield ": connected\n\n"  # comment-only event, just confirms the stream is actually open
            while True:
                try:
                    resource = await asyncio.wait_for(queue.get(), timeout=25)
                    yield f"data: {resource}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"  # comment ping so idle proxies/load balancers don't close the connection
        finally:
            _sse_subscribers[coop_id].remove(queue)
            _sse_subscribers[GLOBAL_CHANNEL].remove(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------- Generic CRUD for the siloed resources (birds, eggs, expenses, bedding) ----------

@app.get("/api/{resource}")
def list_items(resource: str, coop_id: str | None = None):
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")
    if resource in SCOPED and not coop_id:
        raise HTTPException(400, "coop_id query parameter is required")
    with get_db() as conn:
        if resource in SCOPED:
            order = "ORDER BY date DESC" if "date" in SCHEMA[resource] else ""
            rows = conn.execute(f"SELECT * FROM {resource} WHERE coop_id = ? AND deleted_at IS NULL {order}", (coop_id,)).fetchall()
        else:
            rows = conn.execute(f"SELECT * FROM {resource} WHERE deleted_at IS NULL").fetchall()
        return [dict(r) for r in rows]


@app.post("/api/{resource}/bulk-delete-items")
def delete_items_bulk(resource: str, payload: dict = Body(...)):
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")
    ids = payload.get("ids")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "ids must be a non-empty list")
    if len(ids) > 2000:
        raise HTTPException(400, "That's a lot of items to delete at once -- try 2000 or fewer at a time")
    now = _now_iso()
    deleted_ids = []
    coop_ids_touched = set()
    with get_db() as conn:
        for item_id in ids:
            photo_to_clean = None
            if resource == "birds":
                row = conn.execute("SELECT photo FROM birds WHERE id = ?", (item_id,)).fetchone()
                if row:
                    photo_to_clean = row["photo"]
                conn.execute('UPDATE bird_logs SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, item_id))
            elif resource in ("bird_photos", "supply_products"):
                row = conn.execute(f"SELECT photo FROM {resource} WHERE id = ?", (item_id,)).fetchone()
                if row:
                    photo_to_clean = row["photo"]
            coop_row = conn.execute(f"SELECT coop_id FROM {resource} WHERE id = ?", (item_id,)).fetchone() if resource in SCOPED else None
            cur = conn.execute(f'UPDATE {resource} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', (now, now, item_id))
            if resource == "birds":
                _cascade_delete_bird_photos(conn, item_id, now)
            if photo_to_clean:
                _delete_photo_file(conn, photo_to_clean)
            if cur.rowcount > 0:
                deleted_ids.append(item_id)
                if coop_row and coop_row["coop_id"]:
                    coop_ids_touched.add(coop_row["coop_id"])
    for coop_id in (coop_ids_touched or {GLOBAL_CHANNEL}):
        _sse_publish(coop_id, resource)
    return {"deleted": len(deleted_ids), "ids": deleted_ids}


@app.post("/api/{resource}/bulk-update-items")
def update_items_bulk(resource: str, payload: dict = Body(...)):
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")
    updates = payload.get("updates")
    if not isinstance(updates, list) or not updates:
        raise HTTPException(400, "updates must be a non-empty list of {id, fields} objects")
    if len(updates) > 2000:
        raise HTTPException(400, "That's a lot of items to update at once -- try 2000 or fewer at a time")
    cols = SCHEMA[resource]
    updated_ids = []
    coop_ids_touched = set()
    with get_db() as conn:
        for entry in updates:
            item_id = entry.get("id")
            fields = entry.get("fields") or {}
            valid_fields = [c for c in cols if c in fields]
            if not item_id or not valid_fields:
                continue
            set_clause = ", ".join(f'"{c}" = ?' for c in valid_fields) + ', "updated_at" = ?, "deleted_at" = NULL'
            values = [fields[c] for c in valid_fields] + [_now_iso(), item_id]
            cur = conn.execute(f'UPDATE {resource} SET {set_clause} WHERE id = ?', values)
            if cur.rowcount > 0:
                updated_ids.append(item_id)
                coop_row = conn.execute(f"SELECT coop_id FROM {resource} WHERE id = ?", (item_id,)).fetchone() if resource in SCOPED else None
                if coop_row and coop_row["coop_id"]:
                    coop_ids_touched.add(coop_row["coop_id"])
    for coop_id in (coop_ids_touched or {GLOBAL_CHANNEL}):
        _sse_publish(coop_id, resource)
    return {"updated": len(updated_ids), "ids": updated_ids}


@app.post("/api/{resource}/bulk-create")
def create_items_bulk(resource: str, payload: dict = Body(...)):
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "items must be a non-empty list")
    if len(items) > 1000:
        raise HTTPException(400, "That's a lot of items for one batch -- try 1000 or fewer at a time")
    cols = SCHEMA[resource]
    created_rows = []
    coop_ids_touched = set()
    # Same create-or-reconcile logic as the single-item endpoint (a client-
    # supplied id lets an offline-created record keep its final id, and a
    # duplicate id on retry is treated as an update rather than a failure),
    # just applied to a whole list inside one connection instead of one
    # HTTP round-trip per item -- this is what makes a few thousand items
    # take one request instead of a few thousand.
    with get_db() as conn:
        for item_payload in items:
            if resource in SCOPED and not item_payload.get("coop_id"):
                raise HTTPException(400, "coop_id is required for every item")
            item_id = item_payload.get("id") or uuid.uuid4().hex[:12]
            existing = conn.execute(f"SELECT id FROM {resource} WHERE id = ?", (item_id,)).fetchone()
            if existing:
                updates = [c for c in cols if c in item_payload]
                if updates:
                    set_clause = ", ".join(f'"{c}" = ?' for c in updates) + ', "updated_at" = ?'
                    values = [item_payload[c] for c in updates] + [_now_iso(), item_id]
                    conn.execute(f"UPDATE {resource} SET {set_clause} WHERE id = ?", values)
            else:
                fields = ["id", "updated_at"] + [c for c in cols if c in item_payload]
                values = [item_id, _now_iso()] + [item_payload[c] for c in cols if c in item_payload]
                placeholders = ", ".join("?" for _ in fields)
                col_list = ", ".join(f'"{f}"' for f in fields)
                conn.execute(f"INSERT INTO {resource} ({col_list}) VALUES ({placeholders})", values)
            row = dict(conn.execute(f"SELECT * FROM {resource} WHERE id = ?", (item_id,)).fetchone())
            created_rows.append(row)
            if row.get("coop_id"):
                coop_ids_touched.add(row["coop_id"])
    # One SSE notification per affected coop, not one per record -- a
    # thousand individual pushes would just recreate the same flood on a
    # different channel.
    for coop_id in (coop_ids_touched or {GLOBAL_CHANNEL}):
        _sse_publish(coop_id, resource)
    return {"created": len(created_rows), "items": created_rows}


@app.post("/api/{resource}")
def create_item(resource: str, payload: dict = Body(...)):
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")
    if resource in SCOPED and not payload.get("coop_id"):
        raise HTTPException(400, "coop_id is required")
    cols = SCHEMA[resource]
    # A client-supplied id (used by the local-first sync engine, which
    # generates ids on-device so an offline create already has its final id)
    # is accepted as-is; otherwise the server assigns one as before.
    item_id = payload.get("id") or uuid.uuid4().hex[:12]
    with get_db() as conn:
        existing = conn.execute(f"SELECT id FROM {resource} WHERE id = ?", (item_id,)).fetchone()
        if existing:
            # An offline create can get pushed twice if the connection drops
            # after the server processed it but before the client saw the
            # response -- treat a retry with the same id as an update rather
            # than failing on a duplicate key.
            updates = [c for c in cols if c in payload]
            if updates:
                set_clause = ", ".join(f'"{c}" = ?' for c in updates) + ', "updated_at" = ?'
                values = [payload[c] for c in updates] + [_now_iso(), item_id]
                conn.execute(f"UPDATE {resource} SET {set_clause} WHERE id = ?", values)
            row = dict(conn.execute(f"SELECT * FROM {resource} WHERE id = ?", (item_id,)).fetchone())
            _sse_publish(row.get("coop_id"), resource)
            return row
        fields = ["id", "updated_at"] + [c for c in cols if c in payload]
        values = [item_id, _now_iso()] + [payload[c] for c in cols if c in payload]
        placeholders = ", ".join("?" for _ in fields)
        col_list = ", ".join(f'"{f}"' for f in fields)
        conn.execute(f"INSERT INTO {resource} ({col_list}) VALUES ({placeholders})", values)
        row = dict(conn.execute(f"SELECT * FROM {resource} WHERE id = ?", (item_id,)).fetchone())
        _sse_publish(row.get("coop_id"), resource)
        return row


@app.put("/api/{resource}/{item_id}")
def update_item(resource: str, item_id: str, payload: dict = Body(...)):
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")
    cols = SCHEMA[resource]
    updates = [c for c in cols if c in payload]
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    # Clearing deleted_at here is a deliberate choice, not just plumbing: if
    # someone deletes a record while another person is mid-edit of that same
    # record, the edit reaching the server after the delete means "I'm
    # actively trying to save this" -- treated as intent for it to exist,
    # rather than landing silently into a row that stays hidden as deleted.
    set_clause = ", ".join(f'"{c}" = ?' for c in updates) + ', "updated_at" = ?, "deleted_at" = NULL'
    values = [payload[c] for c in updates] + [_now_iso(), item_id]
    with get_db() as conn:
        cur = conn.execute(f"UPDATE {resource} SET {set_clause} WHERE id = ?", values)
        if cur.rowcount == 0:
            raise HTTPException(404, "Item not found")
        row = dict(conn.execute(f"SELECT * FROM {resource} WHERE id = ?", (item_id,)).fetchone())
        # coops rows have no coop_id field of their own (they're not scoped
        # to another coop) -- row.get("coop_id") is always None for this one
        # resource, so it needs the same global-channel treatment as create/
        # delete above rather than the per-coop scoping every other resource uses.
        _sse_publish(GLOBAL_CHANNEL if resource == "coops" else row.get("coop_id"), resource)
        return row


@app.delete("/api/{resource}/{item_id}")
def delete_item(resource: str, item_id: str):
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")
    with get_db() as conn:
        now = _now_iso()
        photo_to_clean = None
        if resource == "birds":
            row = conn.execute("SELECT photo FROM birds WHERE id = ?", (item_id,)).fetchone()
            if row:
                photo_to_clean = row["photo"]
            # Soft-delete cascaded logs too, so a syncing client learns those are gone as well.
            conn.execute('UPDATE bird_logs SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, item_id))
        elif resource == "hatches":
            # A clutch's per-egg tracking rows go with it. Without this they
            # linger as live orphans forever -- invisible in the app (their
            # parent is gone) but still counted, synced, and backed up.
            conn.execute('UPDATE hatch_eggs SET deleted_at = ?, updated_at = ? WHERE hatch_id = ? AND deleted_at IS NULL', (now, now, item_id))
        elif resource in ("bird_photos", "supply_products"):
            row = conn.execute(f"SELECT photo FROM {resource} WHERE id = ?", (item_id,)).fetchone()
            if row:
                photo_to_clean = row["photo"]
        coop_row = conn.execute(f"SELECT coop_id FROM {resource} WHERE id = ?", (item_id,)).fetchone() if resource in SCOPED else None
        # Soft delete: a syncing client needs to be told a row disappeared, not
        # just stop seeing it -- an actual DELETE gives no way to distinguish
        # "removed" from "never existed" once a client is offline for a while.
        cur = conn.execute(f'UPDATE {resource} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', (now, now, item_id))
        if resource == "birds":
            _cascade_delete_bird_photos(conn, item_id, now)
        if photo_to_clean:
            _delete_photo_file(conn, photo_to_clean)
        if cur.rowcount == 0:
            raise HTTPException(404, "Item not found")
        _sse_publish(coop_row["coop_id"] if coop_row else None, resource)
        return {"deleted": item_id}


@app.get("/api/sync/{resource}")
def sync_resource(resource: str, coop_id: str | None = None, since: str | None = None):
    """Returns every row changed (created, updated, or soft-deleted) after
    `since` -- including deleted ones, which the generic list endpoint above
    hides. A local-first client uses this to reconcile its own copy: apply
    updates, and remove anything whose deleted_at is now set. Omit `since`
    (or pass an empty string) for an initial full sync."""
    if resource not in SCHEMA:
        raise HTTPException(404, f"Unknown resource: {resource}")
    if resource in SCOPED and not coop_id:
        raise HTTPException(400, "coop_id query parameter is required")
    with get_db() as conn:
        clauses, params = [], []
        if resource in SCOPED:
            clauses.append("coop_id = ?")
            params.append(coop_id)
        if since:
            clauses.append("updated_at > ?")
            params.append(since)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(f"SELECT * FROM {resource} {where} ORDER BY updated_at ASC", params).fetchall()
        result_rows = [dict(r) for r in rows]
    return {"server_time": _now_iso(), "rows": result_rows}


# Bird photo files live under DATA_DIR (outside the app's static/ dir), served at /photos
app.mount("/photos", StaticFiles(directory=PHOTOS_DIR), name="photos")

# Static frontend (mounted last so /api/* and /photos above take precedence)
app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
