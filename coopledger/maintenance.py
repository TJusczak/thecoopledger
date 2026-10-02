"""Background upkeep: pruning, scheduled backups, and reminders."""
import asyncio
import os
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone

from .auth import rotate_primary_code
from .config import BACKUP_DIR, DB_PATH, PHOTOS_DIR
from .db import get_db, now_iso
from .push import push_reminder_sweep
from .settings import get_setting

def maybe_auto_rotate_invite_code():
    with get_db() as conn:
        row = conn.execute("SELECT auto_rotate_days, rotated_at FROM auth_settings WHERE id = 1").fetchone()
        if not row or not row["auto_rotate_days"]:
            return
        rotated_at = datetime.fromisoformat(row["rotated_at"]) if row["rotated_at"] else None
        due = (not rotated_at) or (datetime.now(timezone.utc) - rotated_at).days >= row["auto_rotate_days"]
        if due:
            print(f"Invite code auto-rotated (scheduled): {rotate_primary_code(conn)}")


def prune_old_activity_log():
    cutoff = (datetime.now(timezone.utc) - timedelta(days=get_setting("activity_log_retention_days"))).isoformat()
    now = now_iso()
    with get_db() as conn:
        conn.execute(
            'UPDATE activity_log SET deleted_at = ?, updated_at = ? WHERE updated_at < ? AND deleted_at IS NULL',
            (now, now, cutoff),
        )


def prune_old_failed_logins():
    # Keep the most recent 500 -- enough history to spot a pattern (someone
    # guessing codes, a bot hammering the endpoint) without growing forever.
    with get_db() as conn:
        conn.execute('''
            DELETE FROM failed_logins WHERE id NOT IN (
                SELECT id FROM failed_logins ORDER BY attempted_at DESC LIMIT 500
            )
        ''')


def prune_idle_sessions():
    """Drops sessions that haven't been used in the configured idle window.
    Disabled entirely at the default of 0 -- a household server where
    logging in once on the kitchen tablet is meant to stick forever is
    a perfectly reasonable setup, so expiry is strictly opt-in."""
    days = get_setting("session_max_idle_days")
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


def create_full_backup():
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
    for old in existing[get_setting("max_backups_to_keep"):]:
        shutil.rmtree(old, ignore_errors=True)  # removes this backup's links; each photo's actual data survives as long as the live copy or any other backup still references it
    print(f"Automatic backup created: {backup_folder.name}")


def maybe_run_scheduled_backup():
    if not get_setting("backups_enabled"):
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
            if (datetime.now(timezone.utc) - last_backup_time).total_seconds() < get_setting("backup_interval_hours") * 3600:
                return
        except ValueError:
            pass  # malformed folder name somehow -- just proceed with a fresh backup
    try:
        create_full_backup()
    except Exception as e:
        print(f"Scheduled backup failed: {e}")


def run_maintenance_pass():
    """Everything the hourly tick does. Each step is isolated: one failing
    must not skip the rest (an exception in, say, pruning used to silently
    cancel the backup and the reminder sweep after it)."""
    for step in (
        maybe_auto_rotate_invite_code,
        prune_old_activity_log,
        prune_old_failed_logins,
        prune_idle_sessions,
        maybe_run_scheduled_backup,
        push_reminder_sweep,
    ):
        try:
            step()
        except Exception as e:
            print(f"Maintenance step {step.__name__} failed: {e}")


async def periodic_maintenance_loop():
    while True:
        await asyncio.sleep(3600)  # once an hour is plenty
        # In a worker thread: backups copy files and the reminder sweep makes
        # outbound HTTPS calls (10 s timeout each). Run on the event loop,
        # that would freeze every request -- and every SSE stream -- for the
        # duration.
        await asyncio.to_thread(run_maintenance_pass)
