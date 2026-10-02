"""Login, rate limiting, roles, invite codes, and session expiry."""
import sqlite3

import pytest

from coopledger import auth, config, maintenance


# ---------------------------------------------------------------- auth basics

def test_health_is_public(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["version"] == config.SERVER_VERSION


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
    maintenance.create_full_backup()
    name = client.get("/api/backups", headers=admin).json()["backups"][0]["filename"]
    assert client.get(f"/api/backups/{name}", headers=readonly).status_code == 403
    assert client.get(f"/api/backups/{name}", headers=admin).status_code == 200


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
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute(
            "UPDATE sessions SET last_activity = '2020-01-01T00:00:00+00:00', created_at = '2020-01-01T00:00:00+00:00' WHERE token = ?",
            (token,),
        )
    monkeypatch.setattr(config, "SESSION_MAX_IDLE_DAYS", 30)
    maintenance.prune_idle_sessions()
    assert client.get("/api/coops", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_idle_pruning_off_by_default(client, admin_code):
    r = client.post("/api/auth/login", json={"name": "Keeper", "code": admin_code})
    token = r.json()["token"]
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute(
            "UPDATE sessions SET last_activity = '2020-01-01T00:00:00+00:00' WHERE token = ?", (token,)
        )
    assert config.SESSION_MAX_IDLE_DAYS == 0
    maintenance.prune_idle_sessions()
    assert client.get("/api/coops", headers={"Authorization": f"Bearer {token}"}).status_code == 200
