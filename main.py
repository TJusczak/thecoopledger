import asyncio
import base64
import csv
import io
import json
import os
import secrets
import sqlite3
import time
import uuid
import zipfile
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Body, File, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "coop.db"

# Bumped alongside the frontend's APP_VERSION (static/app.js) whenever either
# changes -- lets the client detect a sync server that's running older code
# than what it's talking to it with (e.g. the static frontend auto-updated
# from a CDN, but this self-hosted server hasn't been restarted since).
SERVER_VERSION = "2026.07.06-116"
PHOTOS_DIR = DATA_DIR / "photos"
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

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
        "coop_id": "TEXT", "category": "TEXT", "title": "TEXT", "body": "TEXT", "created_date": "TEXT",
    },
    "supplies": {
        "coop_id": "TEXT", "category": "TEXT", "description": "TEXT", "brand": "TEXT", "quantity": "REAL", "unit": "TEXT",
        "status": "TEXT", "date_added": "TEXT", "date_emptied": "TEXT", "source_expense_id": "TEXT", "opened_at": "TEXT",
        "product_id": "TEXT",
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
    "activity_log": {
        # Append-only by convention (the app never updates or deletes a log entry) --
        # reuses the same generic create/list/sync endpoints as everything else.
        "coop_id": "TEXT", "resource": "TEXT", "op": "TEXT", "changed_by": "TEXT", "summary": "TEXT",
    },
}
SCOPED = {"birds", "eggs", "expenses", "bedding", "bird_logs", "notes", "supplies", "hatches", "activity_log", "supply_products"}  # tables siloed by coop_id


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
ACTIVITY_LOG_RETENTION_DAYS = 7


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

        conn.execute('''
            CREATE TABLE IF NOT EXISTS failed_logins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name_attempted TEXT,
                code_attempted TEXT,
                ip TEXT,
                attempted_at TEXT NOT NULL
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


def _delete_photo_file(photo_value):
    """Remove a bird's photo file from disk if it's one of ours (a /photos/... reference)."""
    if photo_value and isinstance(photo_value, str) and photo_value.startswith("/photos/"):
        p = PHOTOS_DIR / Path(photo_value).name
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass


def _save_photo_bytes(bird_id: str, content: bytes, ext: str = ".jpg") -> str:
    filename = f"{bird_id}-{uuid.uuid4().hex[:6]}{ext}"
    (PHOTOS_DIR / filename).write_bytes(content)
    return f"/photos/{filename}"


def _photo_to_data_uri(photo_value):
    """For export: turn a stored file reference into a self-contained data URI."""
    if not photo_value:
        return None
    if photo_value.startswith("data:"):
        return photo_value
    if photo_value.startswith("/photos/"):
        p = PHOTOS_DIR / Path(photo_value).name
        if not p.exists():
            return None
        ext = p.suffix.lower()
        mime = "image/png" if ext == ".png" else "image/jpeg"
        return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"
    return None


def migrate_base64_photos_to_files():
    """One-time upgrade: birds saved with an earlier version embedded photos directly
    in the database as base64. Convert those into real files on disk."""
    with get_db() as conn:
        rows = conn.execute("SELECT id, photo FROM birds WHERE photo LIKE 'data:%'").fetchall()
        for r in rows:
            try:
                header, b64data = r["photo"].split(",", 1)
                ext = ".png" if "png" in header else ".jpg"
                new_ref = _save_photo_bytes(r["id"], base64.b64decode(b64data), ext)
                conn.execute("UPDATE birds SET photo = ? WHERE id = ?", (new_ref, r["id"]))
            except Exception:
                pass  # leave the bird's photo as-is if anything about it is malformed


app = FastAPI(title="Coop Ledger")


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


# Paths that must stay reachable with no login at all: the login endpoint
# itself (chicken-and-egg otherwise), and the plain reachability check used
# by the "Test connection" button and the online/offline indicator.
PUBLIC_API_PATHS = {"/api/auth/login", "/api/health"}


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

        valid = False
        if token:
            with get_db() as conn:
                valid = conn.execute("SELECT 1 FROM sessions WHERE token = ?", (token,)).fetchone() is not None

        if not valid:
            response = JSONResponse({"detail": "Not logged in"}, status_code=401)
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
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()
    migrate_base64_photos_to_files()


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
        # supply_products before supplies (so product_id can be remapped),
        # birds before bird_logs (so bird_id can be remapped) -- everything
        # else order doesn't matter.
        import_order = ["birds", "supply_products"] + [t for t in SCOPED if t not in ("birds", "bird_logs", "supply_products", "supplies")] + ["supplies", "bird_logs"]
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
                            new_photo = _save_photo_bytes(new_row_id, base64.b64decode(b64data), ext)
                        except Exception:
                            new_photo = None
                    elif isinstance(photo, str) and photo and zip_photo_reader is not None:
                        content = zip_photo_reader(photo)
                        if content:
                            ext = Path(photo).suffix.lower() or ".jpg"
                            new_photo = _save_photo_bytes(new_row_id, content, ext)
                    row["photo"] = new_photo
                if table == "supply_products":
                    old_product_id = row.get("id")
                    photo = row.get("photo")
                    new_photo = None
                    if isinstance(photo, str) and photo.startswith("data:"):
                        try:
                            header, b64data = photo.split(",", 1)
                            ext = ".png" if "png" in header else ".jpg"
                            new_photo = _save_photo_bytes(new_row_id, base64.b64decode(b64data), ext)
                        except Exception:
                            new_photo = None
                    elif isinstance(photo, str) and photo and zip_photo_reader is not None:
                        content = zip_photo_reader(photo)
                        if content:
                            ext = Path(photo).suffix.lower() or ".jpg"
                            new_photo = _save_photo_bytes(new_row_id, content, ext)
                    row["photo"] = new_photo
                if table == "supplies" and row.get("product_id"):
                    row["product_id"] = product_id_map.get(row["product_id"])  # None if the product wasn't in this export -- fine, just an unlinked bag
                if table == "bird_logs":
                    new_bird_id = bird_id_map.get(row.get("bird_id"))
                    if not new_bird_id:
                        continue  # log referenced a bird that wasn't in this export; skip it
                    row["bird_id"] = new_bird_id
                fields = ["id", "coop_id", "updated_at"] + [c for c in cols if c in row]
                values = [new_row_id, new_id, _now_iso()] + [row[c] for c in cols if c in row]
                placeholders = ", ".join("?" for _ in fields)
                col_list = ", ".join(f'"{f}"' for f in fields)
                conn.execute(f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})", values)
                if table == "birds":
                    bird_id_map[old_bird_id] = new_row_id
                if table == "supply_products":
                    product_id_map[old_product_id] = new_row_id
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
            if table == "birds":
                for r in rows:
                    r["photo"] = _photo_to_data_uri(r["photo"])
            if table == "supply_products":
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
            if table == "birds":
                for r in rows:
                    photo_ref = r["photo"]
                    new_ref = None
                    if photo_ref and isinstance(photo_ref, str) and photo_ref.startswith("/photos/"):
                        p = PHOTOS_DIR / Path(photo_ref).name
                        if p.exists():
                            rel = f"photos/{p.name}"
                            photo_files[rel] = p.read_bytes()
                            new_ref = rel
                    r["photo"] = new_ref
            if table == "supply_products":
                for r in rows:
                    photo_ref = r["photo"]
                    new_ref = None
                    if photo_ref and isinstance(photo_ref, str) and photo_ref.startswith("/photos/"):
                        p = PHOTOS_DIR / Path(photo_ref).name
                        if p.exists():
                            rel = f"photos/{p.name}"
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
                if table == "birds":
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


@app.delete("/api/coops/{coop_id}")
def delete_coop(coop_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM coops WHERE id = ?", (coop_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Coop not found")
        for r in conn.execute("SELECT photo FROM birds WHERE coop_id = ?", (coop_id,)).fetchall():
            _delete_photo_file(r["photo"])
        for table in SCOPED:
            conn.execute(f"DELETE FROM {table} WHERE coop_id = ?", (coop_id,))
        # Soft delete, not a hard DELETE -- same reasoning as every other
        # resource in this app: a hard delete leaves nothing behind for a
        # future "what's changed since X" sync to detect, so other devices
        # would never learn the coop was gone. Child data above still gets
        # hard-deleted, since a deleted coop should genuinely lose its data.
        now = _now_iso()
        conn.execute("UPDATE coops SET deleted_at = ?, updated_at = ? WHERE id = ?", (now, now, coop_id))
        _sse_publish(GLOBAL_CHANNEL, "coops")
        return {"deleted": coop_id}


@app.post("/api/supply_products/{product_id}/photo")
async def upload_supply_product_photo(product_id: str, file: UploadFile = File(...)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM supply_products WHERE id = ?", (product_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Product not found")
        content = await file.read()
        ext = ".png" if (file.content_type or "").endswith("png") else ".jpg"
        new_ref = _save_photo_bytes(product_id, content, ext)
        _delete_photo_file(row["photo"])  # clean up the old file, if any
        conn.execute('UPDATE supply_products SET photo = ?, updated_at = ? WHERE id = ?', (new_ref, _now_iso(), product_id))
        return {"photo": new_ref}


@app.delete("/api/supply_products/{product_id}/photo")
def remove_supply_product_photo(product_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM supply_products WHERE id = ?", (product_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Product not found")
        _delete_photo_file(row["photo"])
        conn.execute('UPDATE supply_products SET photo = NULL, updated_at = ? WHERE id = ?', (_now_iso(), product_id))
        return {"removed": True}


@app.post("/api/birds/{bird_id}/photo")
async def upload_bird_photo(bird_id: str, file: UploadFile = File(...)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM birds WHERE id = ?", (bird_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Bird not found")
        content = await file.read()
        ext = ".png" if (file.content_type or "").endswith("png") else ".jpg"
        new_ref = _save_photo_bytes(bird_id, content, ext)
        _delete_photo_file(row["photo"])  # clean up the old file, if any
        conn.execute('UPDATE birds SET photo = ?, updated_at = ? WHERE id = ?', (new_ref, _now_iso(), bird_id))
        return {"photo": new_ref}


@app.delete("/api/birds/{bird_id}/photo")
def remove_bird_photo(bird_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM birds WHERE id = ?", (bird_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Bird not found")
        _delete_photo_file(row["photo"])
        conn.execute('UPDATE birds SET photo = NULL, updated_at = ? WHERE id = ?', (_now_iso(), bird_id))
        return {"removed": True}


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
                _delete_photo_file(row["photo"])
                conn.execute('UPDATE bird_logs SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, bird_id))
                conn.execute('UPDATE birds SET deleted_at = ?, updated_at = ? WHERE id = ?', (now, now, bird_id))
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
        row = conn.execute("SELECT invite_code FROM auth_settings WHERE id = 1").fetchone()
        if not row or code.upper() != row["invite_code"].upper():
            _record_failed_login(ip, name, code)
            raise HTTPException(401, "Invalid invite code")
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO sessions (token, name, created_at) VALUES (?, ?, ?)", (token, name, _now_iso()))
        return {"token": token, "name": name}


@app.get("/api/auth/me")
def auth_me(request: Request):
    name = _require_auth(request)
    return {"name": name}


@app.post("/api/auth/logout")
def logout(request: Request):
    token = _extract_token(request)
    if token:
        with get_db() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return {"ok": True}


@app.get("/api/auth/invite-code")
def get_invite_code(request: Request):
    _require_auth(request)
    with get_db() as conn:
        row = conn.execute("SELECT invite_code, auto_rotate_days FROM auth_settings WHERE id = 1").fetchone()
        return {"invite_code": row["invite_code"], "auto_rotate_days": row["auto_rotate_days"]}


@app.post("/api/auth/invite-code/rotate")
def rotate_invite_code(request: Request):
    _require_auth(request)
    new_code = generate_invite_code()
    with get_db() as conn:
        conn.execute("UPDATE auth_settings SET invite_code = ?, rotated_at = ? WHERE id = 1", (new_code, _now_iso()))
    return {"invite_code": new_code}


@app.post("/api/auth/invite-code/auto-rotate")
def set_auto_rotate(payload: dict = Body(...), request: Request = None):
    _require_auth(request)
    days = payload.get("days")  # null/None disables it
    with get_db() as conn:
        conn.execute("UPDATE auth_settings SET auto_rotate_days = ? WHERE id = 1", (days,))
    return {"auto_rotate_days": days}


@app.get("/api/auth/sessions")
def list_sessions(request: Request):
    _require_auth(request)
    with get_db() as conn:
        rows = conn.execute("SELECT id, name, created_at, last_activity FROM sessions ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


@app.get("/api/auth/failed-logins")
def list_failed_logins(request: Request):
    _require_auth(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name_attempted, code_attempted, ip, attempted_at FROM failed_logins ORDER BY attempted_at DESC LIMIT 100"
        ).fetchall()
        return [dict(r) for r in rows]


@app.delete("/api/auth/sessions/{session_id}")
def revoke_session(session_id: int, request: Request):
    _require_auth(request)
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
    cutoff = (datetime.now(timezone.utc) - timedelta(days=ACTIVITY_LOG_RETENTION_DAYS)).isoformat()
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


async def _periodic_maintenance_loop():
    while True:
        await asyncio.sleep(3600)  # once an hour is plenty for both of these
        try:
            _maybe_auto_rotate_invite_code()
            _prune_old_activity_log()
            _prune_old_failed_logins()
        except Exception as e:
            print(f"Periodic maintenance error: {e}")


@app.on_event("startup")
async def _capture_event_loop():
    global _main_event_loop
    _main_event_loop = asyncio.get_running_loop()
    _maybe_auto_rotate_invite_code()  # catch anything overdue from while the server was down
    _prune_old_activity_log()
    _prune_old_failed_logins()
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
            if resource == "birds":
                row = conn.execute("SELECT photo FROM birds WHERE id = ?", (item_id,)).fetchone()
                if row:
                    _delete_photo_file(row["photo"])
                conn.execute('UPDATE bird_logs SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, item_id))
            coop_row = conn.execute(f"SELECT coop_id FROM {resource} WHERE id = ?", (item_id,)).fetchone() if resource in SCOPED else None
            cur = conn.execute(f'UPDATE {resource} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', (now, now, item_id))
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
        if resource == "birds":
            row = conn.execute("SELECT photo FROM birds WHERE id = ?", (item_id,)).fetchone()
            if row:
                _delete_photo_file(row["photo"])
            # Soft-delete cascaded logs too, so a syncing client learns those are gone as well.
            conn.execute('UPDATE bird_logs SET deleted_at = ?, updated_at = ? WHERE bird_id = ?', (now, now, item_id))
        coop_row = conn.execute(f"SELECT coop_id FROM {resource} WHERE id = ?", (item_id,)).fetchone() if resource in SCOPED else None
        # Soft delete: a syncing client needs to be told a row disappeared, not
        # just stop seeing it -- an actual DELETE gives no way to distinguish
        # "removed" from "never existed" once a client is offline for a while.
        cur = conn.execute(f'UPDATE {resource} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', (now, now, item_id))
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
        return {"server_time": _now_iso(), "rows": [dict(r) for r in rows]}


# Bird photo files live under DATA_DIR (outside the app's static/ dir), served at /photos
app.mount("/photos", StaticFiles(directory=PHOTOS_DIR), name="photos")

# Static frontend (mounted last so /api/* and /photos above take precedence)
app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
