"""Admin-overridable server settings (Settings -> Server in the app)."""
from .config import OVERRIDABLE_SETTINGS
from .db import get_db

def get_setting(key: str):
    """The value actually in force: an admin's override if one exists,
    otherwise the environment default. Every consumer below reads through
    this rather than the module-level constant, so a change in the app
    takes effect on the next maintenance pass without a restart."""
    spec = OVERRIDABLE_SETTINGS[key]
    with get_db(write=False) as conn:
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


def setting_is_overridden(key: str) -> bool:
    with get_db(write=False) as conn:
        return conn.execute("SELECT 1 FROM server_settings WHERE key = ?", (key,)).fetchone() is not None
