"""Schema creation, bootstrap, and data migrations.

Two kinds of change live here, deliberately handled differently:

* **Declarative schema** (init_db): tables and columns come from schema.SCHEMA
  and are created/added idempotently on every start. Adding a column is just
  editing SCHEMA -- no numbered step needed, and it can't be applied twice or
  out of order.
* **Data migrations** (MIGRATIONS below): one-off rewrites of existing rows or
  files. These are recorded in `schema_migrations` so a one-time migration runs
  once, in a fixed order. Ones marked `repeatable` are idempotent *repairs*
  that run on every start on purpose -- an older client that is still offline
  can sync stale data back in (a kg weight, an orphaned child row) long after
  the fix first shipped, and a once-only repair would never catch it.
"""
import base64
import json
import sqlite3
import uuid
from datetime import date
from typing import Callable, NamedTuple

from . import config
from .auth import generate_invite_code
from .config import DATA_DIR, LB_TO_KG, PHOTOS_DIR
from .db import get_db, now_iso
from .photos import photo_relpath, save_photo_bytes
from .schema import DEFAULT_SETTINGS, SCHEMA, SCOPED, SYNC_COLUMNS

def enable_wal():
    """WAL lets readers and the single writer proceed concurrently. It is a
    persistent property of the database file, so setting it once at startup is
    enough -- and it cannot be changed from inside a transaction, which is why
    this uses its own bare connection instead of get_db()."""
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    finally:
        conn.close()


def init_db():
    """Idempotent: safe on a brand-new file and on every existing install."""
    enable_wal()
    with get_db() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS sync_clock (id INTEGER PRIMARY KEY CHECK (id = 1), last_ts TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
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
        backfill_ts = now_iso()
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
            conn.execute("INSERT INTO auth_settings (id, invite_code, rotated_at) VALUES (1, ?, ?)", (generate_invite_code(), now_iso()))

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
                (existing_code["invite_code"], now_iso()),
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
                    (default_id, "Default Coop", "Auto-created to hold data from before multi-coop support.", date.today().isoformat(), now_iso()),
                )
            for table in SCOPED:
                conn.execute(f"UPDATE {table} SET coop_id = ? WHERE coop_id IS NULL", (default_id,))


def migrate_base64_photos_to_files():
    """One-time upgrade: birds saved with an earlier version embedded photos directly
    in the database as base64. Convert those into real files on disk."""
    with get_db() as conn:
        rows = conn.execute("SELECT id, coop_id, photo FROM birds WHERE photo LIKE 'data:%'").fetchall()
        for r in rows:
            try:
                header, b64data = r["photo"].split(",", 1)
                ext = ".png" if "png" in header else ".jpg"
                new_ref = save_photo_bytes(r["coop_id"], r["id"], base64.b64decode(b64data), ext)
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
    now = now_iso()
    with get_db() as conn:
        for table in ("bird_photos", "birds", "supply_products"):
            rows = conn.execute(f"SELECT id, photo FROM {table} WHERE photo LIKE '/photos/%' AND deleted_at IS NULL").fetchall()
            for r in rows:
                p = photo_relpath(r["photo"])
                if p is not None and p.exists():
                    continue  # reference is fine
                if table == "bird_photos":
                    conn.execute(f"UPDATE {table} SET deleted_at = ?, updated_at = ? WHERE id = ?", (now, now, r["id"]))
                else:
                    conn.execute(f"UPDATE {table} SET photo = NULL, updated_at = ? WHERE id = ?", (now, r["id"]))


def migrate_normalize_supply_weight_units():
    """Convert any supplies stored in kg to lb, the canonical weight unit.

    Supplies carry their own `unit` field, but every aggregation (feed totals,
    charts, cost per lb, cost per dozen) summed `quantity` without looking at
    it -- so a 20 kg bag was counted as "20" next to a 50 lb bag's "50",
    silently under-counting. Weights are now normalized to lb on save and
    converted only for display, so this brings existing rows in line.

    Only kg rows are touched: cu ft, bag, bale, gallon, unit and eggs are not
    weights and are left exactly as they are. updated_at is bumped so the fix
    syncs outward to every device rather than being re-overwritten by a stale
    local copy.
    """
    now = now_iso()
    total = 0
    # Same normalization for expenses and product defaults: an expense's
    # quantity becomes the supply bag's quantity, and a product's default
    # quantity pre-fills both, so a stray kg in either reintroduces the bug.
    targets = [
        ("supplies", "quantity", "unit"),
        ("expenses", "quantity", "unit"),
        ("supply_products", "default_quantity", "default_unit"),
    ]
    with get_db() as conn:
        existing_tables = {
            r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        for table, qty_col, unit_col in targets:
            if table not in existing_tables:
                continue
            rows = conn.execute(
                f"SELECT id, {qty_col} AS q FROM {table} "
                f"WHERE lower(trim(coalesce({unit_col},''))) = 'kg' AND {qty_col} IS NOT NULL"
            ).fetchall()
            for r in rows:
                try:
                    lb = round(float(r["q"]) / LB_TO_KG, 4)
                except (TypeError, ValueError):
                    continue
                conn.execute(
                    f"UPDATE {table} SET {qty_col} = ?, {unit_col} = 'lb', updated_at = ? WHERE id = ?",
                    (lb, now, r["id"]),
                )
                total += 1
    if total:
        print(f"Normalized {total} row(s) from kg to lb")


def migrate_repair_orphaned_hatch_eggs():
    """Tombstones hatch_eggs whose parent hatch was already deleted -- these
    are orphans from before hatch deletion cascaded to its egg rows. They
    were invisible in the app (nothing renders eggs for a deleted clutch)
    but still counted, synced to every device, and carried in every backup.
    Setting updated_at makes the fix itself sync outward, so every device's
    local copy gets the same cleanup on its next pull."""
    now = now_iso()
    with get_db() as conn:
        cur = conn.execute(
            """UPDATE hatch_eggs SET deleted_at = ?, updated_at = ?
               WHERE deleted_at IS NULL AND hatch_id IN (SELECT id FROM hatches WHERE deleted_at IS NOT NULL)""",
            (now, now),
        )
        if cur.rowcount:
            print(f"Repair: tombstoned {cur.rowcount} orphaned hatch_eggs row(s) whose clutch was already deleted")


class Migration(NamedTuple):
    id: str
    run: Callable[[], None]
    repeatable: bool  # True = idempotent repair, re-run on every start


# Append only; never reorder or renumber. Ids are what is recorded as applied.
MIGRATIONS = [
    Migration("001_base64_photos_to_files", migrate_base64_photos_to_files, repeatable=False),
    Migration("002_flat_photos_to_coop_folders", migrate_flat_photos_to_coop_folders, repeatable=False),
    Migration("003_repair_orphaned_photo_refs", migrate_repair_orphaned_photo_refs, repeatable=True),
    Migration("004_repair_orphaned_hatch_eggs", migrate_repair_orphaned_hatch_eggs, repeatable=True),
    Migration("005_normalize_supply_weight_units", migrate_normalize_supply_weight_units, repeatable=True),
]


def run_migrations(migrations=None, before_pending=None) -> list[str]:
    """Runs every migration that should run, in order; returns the ids run.

    `before_pending(ids)` is called once, before any of them, only when
    one-time migrations are actually pending on a database that already
    records migrations -- a hook for taking a safety backup before data is
    rewritten. (A first-ever run has nothing recorded yet and is not treated as
    an upgrade: those migrations are no-ops on any database that has no
    legacy data, and snapshotting on every fresh install would be noise.)
    """
    migrations = MIGRATIONS if migrations is None else migrations
    with get_db(write=False) as conn:
        applied = {r["id"] for r in conn.execute("SELECT id FROM schema_migrations")}
    to_run = [m for m in migrations if m.repeatable or m.id not in applied]
    one_time_pending = [m.id for m in to_run if not m.repeatable]
    if before_pending and applied and one_time_pending:
        before_pending(one_time_pending)
    ran = []
    for m in to_run:
        m.run()  # each manages its own transaction, so a failure leaves earlier ones recorded
        if not m.repeatable:
            with get_db() as conn:
                conn.execute("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)", (m.id, now_iso()))
        ran.append(m.id)
    return ran
