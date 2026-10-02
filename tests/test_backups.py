"""Backup creation, download, rotation, and the enabled flag."""
import io
import zipfile

from coopledger import config, maintenance


# ------------------------------------------------------------------- backups

def test_backup_contains_db_and_download_is_zip(client, admin):
    maintenance.create_full_backup()
    backups = client.get("/api/backups", headers=admin).json()["backups"]
    assert backups
    r = client.get(f"/api/backups/{backups[0]['filename']}", headers=admin)
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert "coop.db" in zf.namelist()


def test_backup_download_blocks_traversal(client, admin):
    assert client.get("/api/backups/..%2F..%2Fetc", headers=admin).status_code in (400, 404)
    assert client.get("/api/backups/notaprefix", headers=admin).status_code == 400


def test_backup_rotation_keeps_max(client, monkeypatch):
    monkeypatch.setattr(config, "MAX_BACKUPS_TO_KEEP", 2)
    for _ in range(4):
        maintenance.create_full_backup()
    remaining = [p for p in config.BACKUP_DIR.glob("backup-*") if p.is_dir()]
    assert len(remaining) == 2


def test_backups_enabled_flag_respected(monkeypatch):
    monkeypatch.setattr(config, "BACKUPS_ENABLED", False)
    for p in config.BACKUP_DIR.glob("backup-*"):
        import shutil
        shutil.rmtree(p)
    maintenance.maybe_run_scheduled_backup()
    assert not list(config.BACKUP_DIR.glob("backup-*"))
