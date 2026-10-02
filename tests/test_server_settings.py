"""Admin-editable server settings and their effect."""
import sqlite3

from coopledger import config, maintenance, settings


# ------------------------------------------------- editable server settings

def test_server_settings_default_to_env(client, admin):
    s = client.get("/api/admin/server-settings", headers=admin).json()["settings"]
    assert s["session_max_idle_days"]["value"] == config.SESSION_MAX_IDLE_DAYS
    assert s["session_max_idle_days"]["overridden"] is False
    assert s["backups_enabled"]["type"] == "bool"


def test_server_settings_require_admin(client, readonly):
    assert client.get("/api/admin/server-settings", headers=readonly).status_code == 403
    assert client.put("/api/admin/server-settings", json={"max_backups_to_keep": 5}, headers=readonly).status_code == 403


def test_server_settings_override_and_reset(client, admin):
    client.put("/api/admin/server-settings", json={"session_max_idle_days": 45}, headers=admin)
    s = client.get("/api/admin/server-settings", headers=admin).json()["settings"]
    assert s["session_max_idle_days"]["value"] == 45
    assert s["session_max_idle_days"]["overridden"] is True
    # Effective value is what the pruner actually reads.
    assert settings.get_setting("session_max_idle_days") == 45
    # null clears the override, back to env default.
    client.put("/api/admin/server-settings", json={"session_max_idle_days": None}, headers=admin)
    s = client.get("/api/admin/server-settings", headers=admin).json()["settings"]
    assert s["session_max_idle_days"]["overridden"] is False
    assert settings.get_setting("session_max_idle_days") == config.SESSION_MAX_IDLE_DAYS


def test_server_settings_reject_out_of_range(client, admin):
    assert client.put("/api/admin/server-settings", json={"max_backups_to_keep": 0}, headers=admin).status_code == 400
    assert client.put("/api/admin/server-settings", json={"max_backups_to_keep": 99999}, headers=admin).status_code == 400
    assert client.put("/api/admin/server-settings", json={"session_max_idle_days": "lots"}, headers=admin).status_code == 400
    assert client.put("/api/admin/server-settings", json={"not_a_real_setting": 1}, headers=admin).status_code == 400


def test_bool_setting_disables_backups(client, admin, monkeypatch):
    client.put("/api/admin/server-settings", json={"backups_enabled": False}, headers=admin)
    for p in config.BACKUP_DIR.glob("backup-*"):
        import shutil
        shutil.rmtree(p)
    maintenance.maybe_run_scheduled_backup()
    assert not list(config.BACKUP_DIR.glob("backup-*"))
    client.put("/api/admin/server-settings", json={"backups_enabled": None}, headers=admin)  # reset for other tests


def test_shortened_session_window_prunes_on_save(client, admin, admin_code):
    r = client.post("/api/auth/login", json={"name": "Stale", "code": admin_code})
    token = r.json()["token"]
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("UPDATE sessions SET last_activity = '2020-01-01T00:00:00+00:00' WHERE token = ?", (token,))
    # Saving a short idle window should log out that stale session immediately.
    client.put("/api/admin/server-settings", json={"session_max_idle_days": 30}, headers=admin)
    assert client.get("/api/coops", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    client.put("/api/admin/server-settings", json={"session_max_idle_days": None}, headers=admin)
