"""Server test suite for The Coop Ledger.

Run with:  pytest
(from the project root; needs requirements-dev.txt installed)

The suite exercises the real FastAPI app against a real (temporary) SQLite
database -- no mocks of the database layer, since SQLite behavior (WAL mode,
soft-delete visibility, sync timestamps) IS the thing worth testing. Each
test session gets a fresh DATA_DIR, so nothing here can ever touch a real
deployment's data.
"""
import io
import os
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

import pytest

# DATA_DIR must be set BEFORE main.py is imported -- it creates directories
# and derives every path at import time.
_TMP = tempfile.mkdtemp(prefix="coop-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["MAX_PHOTO_UPLOAD_MB"] = "1"  # small cap so the oversize test doesn't need 25MB of bytes

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# A tiny but genuine 1x1 PNG (magic bytes + valid structure).
TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082"
)


@pytest.fixture(scope="session")
def client():
    with TestClient(main.app) as c:  # context manager triggers startup (init_db etc.)
        yield c


@pytest.fixture(scope="session")
def admin_code():
    # init_db writes the bootstrap code to invite_code.txt -- the same way a
    # real operator gets it.
    return (Path(_TMP) / "invite_code.txt").read_text().strip()


@pytest.fixture(autouse=True)
def _reset_login_rate_limit():
    # The limiter is in-memory per-IP; TestClient always presents the same
    # IP, so leftover failures from one test would poison the next.
    main._failed_login_attempts.clear()
    yield
    main._failed_login_attempts.clear()


@pytest.fixture(scope="session")
def admin(client, admin_code):
    r = client.post("/api/auth/login", json={"name": "Test Admin", "code": admin_code})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="session")
def readonly(client, admin):
    r = client.post("/api/auth/invite-codes", json={"role": "readonly", "label": "test"}, headers=admin)
    assert r.status_code == 200
    code = r.json()["code"]
    r = client.post("/api/auth/login", json={"name": "Test Viewer", "code": code})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture()
def coop(client, admin):
    r = client.post("/api/coops", json={"name": "Test Coop"}, headers=admin)
    assert r.status_code == 200
    return r.json()["id"]


# ---------------------------------------------------------------- auth basics

def test_health_is_public(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["version"] == main.SERVER_VERSION


def test_api_requires_auth(client):
    assert client.get("/api/coops").status_code == 401
    assert client.get("/api/birds?coop_id=x").status_code == 401
    assert client.post("/api/coops", json={"name": "x"}).status_code == 401


def test_photos_require_auth(client):
    assert client.get("/photos/some/file.jpg").status_code == 401


def test_login_rejects_bad_code(client):
    r = client.post("/api/auth/login", json={"name": "Nobody", "code": "WRONGCODE"})
    assert r.status_code == 401


def test_login_requires_name(client, admin_code):
    r = client.post("/api/auth/login", json={"name": "", "code": admin_code})
    assert r.status_code == 400


def test_login_rate_limit_locks_after_5_failures(client):
    for _ in range(5):
        client.post("/api/auth/login", json={"name": "Bot", "code": "GUESS"})
    r = client.post("/api/auth/login", json={"name": "Bot", "code": "GUESS"})
    assert r.status_code == 429


def test_login_is_case_insensitive(client, admin_code):
    r = client.post("/api/auth/login", json={"name": "Casey", "code": admin_code.lower()})
    assert r.status_code == 200
    client.post("/api/auth/logout", headers={"Authorization": f"Bearer {r.json()['token']}"})


def test_auth_me_roundtrip(client, admin):
    r = client.get("/api/auth/me", headers=admin)
    assert r.status_code == 200
    assert r.json()["role"] == "admin"


def test_logged_out_token_stops_working(client, admin_code):
    r = client.post("/api/auth/login", json={"name": "Brief", "code": admin_code})
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    assert client.get("/api/coops", headers=h).status_code == 200
    assert client.post("/api/auth/logout", headers=h).status_code == 200
    assert client.get("/api/coops", headers=h).status_code == 401


def test_security_headers_present(client):
    r = client.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["referrer-policy"] == "same-origin"


# ------------------------------------------------------------- readonly role

def test_readonly_can_read(client, readonly, coop):
    assert client.get("/api/coops", headers=readonly).status_code == 200
    assert client.get(f"/api/birds?coop_id={coop}", headers=readonly).status_code == 200


def test_readonly_writes_blocked(client, readonly, coop):
    r = client.post("/api/birds", json={"coop_id": coop, "name": "Nope"}, headers=readonly)
    assert r.status_code == 403
    r = client.post("/api/coops", json={"name": "Nope"}, headers=readonly)
    assert r.status_code == 403


def test_readonly_can_still_log_out(client, admin, admin_code):
    r = client.post("/api/auth/invite-codes", json={"role": "readonly"}, headers=admin)
    code = r.json()["code"]
    r = client.post("/api/auth/login", json={"name": "Leaver", "code": code})
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    assert client.post("/api/auth/logout", headers=h).status_code == 200


ADMIN_ONLY_GETS = [
    "/api/admin/server-info",
    "/api/backups",
    "/api/auth/failed-logins",
    "/api/auth/invite-codes",
    "/api/auth/invite-code",
    "/api/auth/sessions",
]


@pytest.mark.parametrize("path", ADMIN_ONLY_GETS)
def test_admin_only_reads_reject_readonly(client, readonly, path):
    # These are all GETs, so the middleware write-gate does NOT protect them;
    # each endpoint must enforce admin itself. /api/backups especially: a
    # backup contains every invite code and session token.
    assert client.get(path, headers=readonly).status_code == 403


@pytest.mark.parametrize("path", ADMIN_ONLY_GETS)
def test_admin_only_reads_allow_admin(client, admin, path):
    assert client.get(path, headers=admin).status_code == 200


def test_backup_download_rejects_readonly(client, admin, readonly):
    main._create_full_backup()
    name = client.get("/api/backups", headers=admin).json()["backups"][0]["filename"]
    assert client.get(f"/api/backups/{name}", headers=readonly).status_code == 403
    assert client.get(f"/api/backups/{name}", headers=admin).status_code == 200


# ------------------------------------------------------------------ CRUD/sync

def test_crud_roundtrip_and_tombstone(client, admin, coop):
    r = client.post("/api/birds", json={"coop_id": coop, "name": "Henrietta", "breed": "Orpington"}, headers=admin)
    assert r.status_code == 200
    bird = r.json()
    assert bird["updated_at"]  # sync-critical: a NULL here is invisible to incremental sync

    r = client.put(f"/api/birds/{bird['id']}", json={"name": "Henrietta II"}, headers=admin)
    assert r.json()["name"] == "Henrietta II"

    r = client.delete(f"/api/birds/{bird['id']}", headers=admin)
    assert r.status_code == 200

    listed = client.get(f"/api/birds?coop_id={coop}", headers=admin).json()
    assert all(b["id"] != bird["id"] for b in listed)

    synced = client.get(f"/api/sync/birds?coop_id={coop}", headers=admin).json()["rows"]
    tomb = next(b for b in synced if b["id"] == bird["id"])
    assert tomb["deleted_at"] is not None


def test_create_retry_with_same_id_is_update_not_conflict(client, admin, coop):
    payload = {"id": "retry-test-1", "coop_id": coop, "name": "First"}
    assert client.post("/api/birds", json=payload, headers=admin).status_code == 200
    payload["name"] = "Second"
    r = client.post("/api/birds", json=payload, headers=admin)
    assert r.status_code == 200
    assert r.json()["name"] == "Second"


def test_scoped_list_requires_coop_id(client, admin):
    assert client.get("/api/birds", headers=admin).status_code == 400


def test_unknown_resource_404s(client, admin):
    assert client.get("/api/not_a_table?coop_id=x", headers=admin).status_code == 404
    assert client.post("/api/not_a_table", json={"coop_id": "x"}, headers=admin).status_code == 404


def test_schema_injection_fields_are_ignored(client, admin, coop):
    # Unknown fields never make it into SQL -- only SCHEMA columns do.
    r = client.post("/api/birds", json={"coop_id": coop, "name": "Safe", "evil'); DROP TABLE birds;--": "x"}, headers=admin)
    assert r.status_code == 200
    assert client.get(f"/api/birds?coop_id={coop}", headers=admin).status_code == 200  # table still exists


def test_sync_since_filters(client, admin, coop):
    r = client.post("/api/birds", json={"coop_id": coop, "name": "SyncBird"}, headers=admin)
    ts = r.json()["updated_at"]
    # params= so the timezone's "+" is percent-encoded -- passed raw in the
    # URL it decodes to a space and silently changes the string comparison.
    rows = client.get("/api/sync/birds", params={"coop_id": coop, "since": ts}, headers=admin).json()["rows"]
    assert all(row["updated_at"] > ts for row in rows)


# -------------------------------------------------------------- photo upload

def test_photo_upload_accepts_real_png(client, admin, coop):
    bird = client.post("/api/birds", json={"coop_id": coop, "name": "Photogenic"}, headers=admin).json()
    r = client.post(
        f"/api/birds/{bird['id']}/photo",
        files={"file": ("hen.png", TINY_PNG, "image/png")},
        headers=admin,
    )
    assert r.status_code == 200
    ref = r.json()["photo"]
    assert ref.startswith(f"/photos/{coop}/")
    assert ref.endswith(".png")  # extension came from magic bytes, not the filename
    assert client.get(ref, headers=admin).status_code == 200


def test_photo_upload_rejects_non_image(client, admin, coop):
    bird = client.post("/api/birds", json={"coop_id": coop, "name": "Victim"}, headers=admin).json()
    r = client.post(
        f"/api/birds/{bird['id']}/photo",
        files={"file": ("evil.png", b"<script>alert(1)</script>", "image/png")},
        headers=admin,
    )
    assert r.status_code == 415  # claims PNG, isn't one


def test_photo_upload_rejects_oversize(client, admin, coop):
    bird = client.post("/api/birds", json={"coop_id": coop, "name": "Big"}, headers=admin).json()
    huge = TINY_PNG + b"\x00" * (2 * 1024 * 1024)  # over the 1MB test cap
    r = client.post(
        f"/api/birds/{bird['id']}/photo",
        files={"file": ("big.png", huge, "image/png")},
        headers=admin,
    )
    assert r.status_code == 413


def test_sniffer_recognizes_formats():
    assert main._sniff_image_ext(b"\xff\xd8\xff\xe0rest") == ".jpg"
    assert main._sniff_image_ext(TINY_PNG) == ".png"
    assert main._sniff_image_ext(b"RIFF\x00\x00\x00\x00WEBPrest") == ".webp"
    assert main._sniff_image_ext(b"GIF89a...") == ".gif"
    assert main._sniff_image_ext(b"%PDF-1.7") is None


# ------------------------------------------------------------------- backups

def test_backup_contains_db_and_download_is_zip(client, admin):
    main._create_full_backup()
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
    monkeypatch.setattr(main, "MAX_BACKUPS_TO_KEEP", 2)
    for _ in range(4):
        main._create_full_backup()
    remaining = [p for p in main.BACKUP_DIR.glob("backup-*") if p.is_dir()]
    assert len(remaining) == 2


def test_backups_enabled_flag_respected(monkeypatch):
    monkeypatch.setattr(main, "BACKUPS_ENABLED", False)
    for p in main.BACKUP_DIR.glob("backup-*"):
        import shutil
        shutil.rmtree(p)
    main._maybe_run_scheduled_backup()
    assert not list(main.BACKUP_DIR.glob("backup-*"))


# ---------------------------------------------------------------- invite codes

def test_cannot_revoke_last_admin_code(client, admin):
    codes = client.get("/api/auth/invite-codes", headers=admin).json()
    active_admins = [c for c in codes if c["role"] == "admin" and not c["revoked_at"]]
    if len(active_admins) == 1:
        r = client.delete(f"/api/auth/invite-codes/{active_admins[0]['id']}", headers=admin)
        assert r.status_code == 400


def test_permanent_delete_requires_revoke_first(client, admin):
    created = client.post("/api/auth/invite-codes", json={"role": "readonly", "label": "temp"}, headers=admin).json()
    codes = client.get("/api/auth/invite-codes", headers=admin).json()
    code_id = next(c["id"] for c in codes if c["code"] == created["code"])
    assert client.delete(f"/api/auth/invite-codes/{code_id}/permanent", headers=admin).status_code == 400
    assert client.delete(f"/api/auth/invite-codes/{code_id}", headers=admin).status_code == 200
    assert client.delete(f"/api/auth/invite-codes/{code_id}/permanent", headers=admin).status_code == 200


def test_revoking_code_kills_its_sessions(client, admin):
    created = client.post("/api/auth/invite-codes", json={"role": "readonly"}, headers=admin).json()
    r = client.post("/api/auth/login", json={"name": "Doomed", "code": created["code"]})
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    assert client.get("/api/coops", headers=h).status_code == 200
    codes = client.get("/api/auth/invite-codes", headers=admin).json()
    code_id = next(c["id"] for c in codes if c["code"] == created["code"])
    client.delete(f"/api/auth/invite-codes/{code_id}", headers=admin)
    assert client.get("/api/coops", headers=h).status_code == 401


# ------------------------------------------------------------ session expiry

def test_idle_sessions_pruned_when_enabled(client, admin_code, monkeypatch):
    r = client.post("/api/auth/login", json={"name": "Idler", "code": admin_code})
    token = r.json()["token"]
    # Age the session directly in the database.
    with sqlite3.connect(main.DB_PATH) as conn:
        conn.execute(
            "UPDATE sessions SET last_activity = '2020-01-01T00:00:00+00:00', created_at = '2020-01-01T00:00:00+00:00' WHERE token = ?",
            (token,),
        )
    monkeypatch.setattr(main, "SESSION_MAX_IDLE_DAYS", 30)
    main._prune_idle_sessions()
    assert client.get("/api/coops", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_idle_pruning_off_by_default(client, admin_code):
    r = client.post("/api/auth/login", json={"name": "Keeper", "code": admin_code})
    token = r.json()["token"]
    with sqlite3.connect(main.DB_PATH) as conn:
        conn.execute(
            "UPDATE sessions SET last_activity = '2020-01-01T00:00:00+00:00' WHERE token = ?", (token,)
        )
    assert main.SESSION_MAX_IDLE_DAYS == 0
    main._prune_idle_sessions()
    assert client.get("/api/coops", headers={"Authorization": f"Bearer {token}"}).status_code == 200


# ------------------------------------------------- hatch cascade & server-info

def test_hatch_delete_cascades_to_hatch_eggs(client, admin, coop):
    h = client.post("/api/hatches", json={"coop_id": coop, "date_started": "2026-07-01", "egg_count": 3}, headers=admin).json()
    eggs = [client.post("/api/hatch_eggs", json={"coop_id": coop, "hatch_id": h["id"], "position": i}, headers=admin).json() for i in range(3)]
    client.delete(f"/api/hatches/{h['id']}", headers=admin)
    rows = client.get(f"/api/sync/hatch_eggs?coop_id={coop}", headers=admin).json()["rows"]
    for egg in eggs:
        tomb = next(r for r in rows if r["id"] == egg["id"])
        assert tomb["deleted_at"] is not None, "hatch_eggs must be tombstoned with their clutch"


def test_orphan_repair_migration(client, admin, coop):
    # Manufacture a pre-fix orphan: live egg row under an already-deleted hatch.
    with sqlite3.connect(main.DB_PATH) as conn:
        conn.execute("INSERT INTO hatches (id, coop_id, date_started, deleted_at, updated_at) VALUES ('orph-h', ?, '2026-01-01', '2026-01-02T00:00:00+00:00', '2026-01-02T00:00:00+00:00')", (coop,))
        conn.execute("INSERT INTO hatch_eggs (id, coop_id, hatch_id, updated_at) VALUES ('orph-e', ?, 'orph-h', '2026-01-01T00:00:00+00:00')", (coop,))
    main.migrate_repair_orphaned_hatch_eggs()
    with sqlite3.connect(main.DB_PATH) as conn:
        deleted_at, updated_at = conn.execute("SELECT deleted_at, updated_at FROM hatch_eggs WHERE id='orph-e'").fetchone()
    assert deleted_at is not None
    assert updated_at > "2026-01-01T00:00:00+00:00"  # bumped, so the fix syncs out to devices


def test_server_info_counts_are_active_and_broken_down(client, admin, coop):
    bird = client.post("/api/birds", json={"coop_id": coop, "name": "Counted"}, headers=admin).json()
    client.delete(f"/api/birds/{bird['id']}", headers=admin)
    info = client.get("/api/admin/server-info", headers=admin).json()
    db = info["database"]
    assert db["tombstone_counts"].get("birds", 0) >= 1
    assert db["coop_count"] == len(db["per_coop"])  # active coops only, matching the breakdown
    total_birds_across_coops = sum(c["counts"]["birds"] for c in db["per_coop"])
    assert db["row_counts"]["birds"] == total_birds_across_coops  # flat total == sum of per-coop
