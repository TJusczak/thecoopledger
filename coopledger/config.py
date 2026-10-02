"""Configuration: environment variables, paths, and constants.

Everything is derived at import time, so DATA_DIR must be set in the
environment before this module is first imported (the test suite does this).
"""
import os
from pathlib import Path

# ---------- Configuration (environment variables) ----------
# Every setting has a sane default -- a bare `docker compose up` with no
# configuration at all keeps working exactly as before. A malformed value
# (e.g. MAX_PHOTO_UPLOAD_MB=banana) falls back to the default rather than
# crashing the server on startup, but prints a warning so it isn't silent.

def env_int(name: str, default: int, minimum: int | None = None) -> int:
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


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# The repo root (where static/ lives): this file is <root>/coopledger/config.py.
ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "coop.db"

# Bumped alongside the frontend's APP_VERSION (static/app.js) whenever either
# changes -- lets the client detect a sync server that's running older code
# than what it's talking to it with (e.g. the static frontend auto-updated
# from a CDN, but this self-hosted server hasn't been restarted since).
SERVER_VERSION = "2026.10.02-253"
PHOTOS_DIR = DATA_DIR / "photos"
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
# The frontend already resizes images before upload, so a normal photo is
# well under this -- this is a backstop against something huge slipping
# through, whether picked by mistake or from a client that bypasses the
# frontend's resize step and hits the API directly.
MAX_PHOTO_UPLOAD_BYTES = env_int("MAX_PHOTO_UPLOAD_MB", 25, minimum=1) * 1024 * 1024

# Automatic backups (see create_full_backup below for how they work).
BACKUPS_ENABLED = env_bool("BACKUPS_ENABLED", True)
BACKUP_INTERVAL_HOURS = env_int("BACKUP_INTERVAL_HOURS", 24, minimum=1)
MAX_BACKUPS_TO_KEEP = env_int("MAX_BACKUPS_TO_KEEP", 14, minimum=1)

# 0 (the default) means sessions never expire from inactivity -- matching
# the app's original behavior, where logging in once on the kitchen tablet
# was meant to stick. Set to e.g. 90 to automatically drop sessions that
# haven't been used in that many days.
SESSION_MAX_IDLE_DAYS = env_int("SESSION_MAX_IDLE_DAYS", 0, minimum=0)

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


# How long activity-log entries stick around before being pruned (soft-
# deleted, same as any other delete -- so existing devices get told to
# remove their local copies too via the normal sync/tombstone mechanism,
# rather than silently drifting out of sync with the server's shorter
# history).
ACTIVITY_LOG_RETENTION_DAYS = env_int("ACTIVITY_LOG_RETENTION_DAYS", 7, minimum=1)


BACKUP_DIR = DATA_DIR / "backups"


# Canonical weight unit is lb; kg is converted on the way in (see migrations).
LB_TO_KG = 0.45359237
