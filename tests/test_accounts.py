"""Accounts: sign-in, sessions, first-login password change, my account, and the admin's user screens."""
import sqlite3

import pytest

from coopledger import auth, config, passwords
from helpers import ADMIN_PASSWORD

GOOD = "Hen-House-Password-7"


def login(client, username, password):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def bearer(r):
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture()
def make_user(client, admin):
    """Creates an account the way an admin would, then signs it in and completes the forced password change."""
    made = []

    def factory(username, role="member", password=GOOD, display_name=None):
        r = client.post("/api/auth/users", json={"username": username, "role": role, "password": "Temporary-Pass-1", "display_name": display_name or username}, headers=admin)
        assert r.status_code == 200, r.text
        made.append(r.json()["user"]["id"])
        r = login(client, username, "Temporary-Pass-1")
        assert r.status_code == 200 and r.json()["must_change_password"] is True
        h = bearer(r)
        assert client.post("/api/auth/password", json={"current_password": "Temporary-Pass-1", "new_password": password}, headers=h).status_code == 200
        return {"headers": h, "id": made[-1], "username": username, "password": password}

    yield factory
    for uid in made:
        client.delete(f"/api/auth/users/{uid}", headers=admin)


# ----------------------------------------------------------------------------- first run

def test_first_run_admin_must_have_changed_the_generated_password(admin):
    assert not (config.DATA_DIR / "admin_credentials.txt").exists(), "the credentials file is deleted once the password is changed"


def test_the_generated_password_no_longer_works_after_the_change(client, admin, first_run_credentials):
    assert login(client, first_run_credentials["username"], first_run_credentials["password"]).status_code == 401
    assert login(client, first_run_credentials["username"], ADMIN_PASSWORD).status_code == 200


def test_health_says_how_to_sign_in(client):
    login_info = client.get("/api/health").json()["login"]
    assert login_info["accounts"] is True and login_info["invite_codes"] is True   # the suite emulates an upgraded server


# ----------------------------------------------------------------------------- signing in

def test_login_returns_a_working_session(client, admin):
    r = login(client, "admin", ADMIN_PASSWORD)
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "admin" and body["username"] == "admin" and body["must_change_password"] is False
    me = client.get("/api/auth/me", headers=bearer(r)).json()
    assert me["method"] == "password" and me["username"] == "admin"


def test_username_is_case_insensitive(client, admin):
    assert login(client, "ADMIN", ADMIN_PASSWORD).status_code == 200
    assert login(client, "  Admin  ", ADMIN_PASSWORD).status_code == 200


def test_wrong_password_and_unknown_user_look_identical(client, admin):
    a = login(client, "admin", "definitely-wrong")
    b = login(client, "no-such-user", "definitely-wrong")
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json() == {"detail": auth.GENERIC_LOGIN_FAILURE}


def test_unknown_user_still_costs_a_password_check(client, monkeypatch):
    burned = []
    monkeypatch.setattr(passwords, "burn_a_verification", lambda: burned.append(1))
    login(client, "nobody-at-all", "whatever-whatever")
    assert burned, "response time must not reveal which usernames exist"


@pytest.mark.parametrize("payload", [{}, {"username": "admin"}, {"password": "x"}, {"username": "", "password": ""}, {"username": "admin", "password": 12345678}])
def test_login_needs_both_fields(client, payload):
    assert client.post("/api/auth/login", json=payload).status_code == 400


def test_failed_logins_are_recorded_without_the_password(client, admin):
    secret = "my-super-secret-guess-123"
    login(client, "admin", secret)
    login(client, "ghost", secret)
    with sqlite3.connect(config.DB_PATH) as c:
        rows = c.execute("SELECT name_attempted, code_attempted FROM failed_logins").fetchall()
        dump = "\n".join(str(r) for r in c.execute("SELECT * FROM failed_logins"))
    assert ("admin", "") in rows and ("ghost", "") in rows
    assert secret not in dump
    assert secret not in str(client.get("/api/auth/failed-logins", headers=admin).json())


def test_login_is_rate_limited_per_ip(client, admin):
    for _ in range(auth.MAX_LOGIN_ATTEMPTS):
        login(client, "admin", "wrong-wrong-wrong")
    r = login(client, "admin", ADMIN_PASSWORD)              # even the right password is refused during a lockout
    assert r.status_code == 429


def test_login_is_rate_limited_per_account_across_ips(client, admin):
    import time
    auth.failed_username_attempts["admin"] = [time.time()] * auth.MAX_USERNAME_ATTEMPTS   # many different IPs, one target
    assert login(client, "admin", ADMIN_PASSWORD).status_code == 429
    assert login(client, "someone-else", "whatever-whatever").status_code == 401, "other accounts are unaffected"


def test_a_weaker_stored_hash_is_upgraded_on_login(client, admin, monkeypatch):
    monkeypatch.setitem(passwords.HASH_PARAMS, "n", passwords.HASH_PARAMS["n"] * 2)
    with sqlite3.connect(config.DB_PATH) as c:
        before = c.execute("SELECT password_hash FROM users WHERE username = 'admin'").fetchone()[0]
    assert login(client, "admin", ADMIN_PASSWORD).status_code == 200
    with sqlite3.connect(config.DB_PATH) as c:
        after = c.execute("SELECT password_hash FROM users WHERE username = 'admin'").fetchone()[0]
    assert after != before and f"${passwords.HASH_PARAMS['n']}$" in after
    assert login(client, "admin", ADMIN_PASSWORD).status_code == 200


# ----------------------------------------------------------------------------- secrets at rest

def test_nothing_secret_is_stored_in_the_clear(client, admin):
    r = login(client, "admin", ADMIN_PASSWORD)
    token = r.json()["token"]
    with sqlite3.connect(config.DB_PATH) as c:
        everything = "\n".join(str(row) for table in ("users", "sessions", "failed_logins") for row in c.execute(f"SELECT * FROM {table}"))
        stored_token = c.execute("SELECT token FROM sessions WHERE token = ?", (auth.hash_token(token),)).fetchone()
    assert ADMIN_PASSWORD not in everything
    assert token not in everything, "only the token's hash is stored"
    assert stored_token is not None and len(stored_token[0]) == 64


def test_a_database_copy_cannot_be_replayed_as_a_login(client, admin):
    r = login(client, "admin", ADMIN_PASSWORD)
    with sqlite3.connect(config.DB_PATH) as c:
        stored = c.execute("SELECT token FROM sessions WHERE token = ?", (auth.hash_token(r.json()["token"]),)).fetchone()[0]
    assert client.get("/api/coops", headers={"Authorization": f"Bearer {stored}"}).status_code == 401


def test_users_endpoint_never_returns_hashes(client, admin):
    body = client.get("/api/auth/users", headers=admin).text
    assert "password_hash" not in body and "scrypt$" not in body


def test_users_are_not_reachable_through_the_generic_sync_api(client, admin):
    assert client.get("/api/users?coop_id=x", headers=admin).status_code == 404
    assert client.get("/api/sync/users", headers=admin).status_code == 404


def test_old_plaintext_session_tokens_are_converted_and_still_work(client):
    from coopledger import migrations
    raw = "legacy-plaintext-token-that-is-43-characters-long"[:43]
    with sqlite3.connect(config.DB_PATH) as c:
        c.execute("INSERT INTO sessions (token, name, created_at, role) VALUES (?, 'Old Device', '2026-01-01T00:00:00+00:00', 'admin')", (raw,))
    migrations.migrate_hash_session_tokens()
    migrations.migrate_hash_session_tokens()                          # idempotent
    with sqlite3.connect(config.DB_PATH) as c:
        assert c.execute("SELECT COUNT(*) FROM sessions WHERE token = ?", (raw,)).fetchone()[0] == 0
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {raw}"}).status_code == 200, "the device keeps its login"


# ----------------------------------------------------------------------------- logout / invite codes

def test_logout_ends_only_that_session(client, admin):
    a, b = login(client, "admin", ADMIN_PASSWORD), login(client, "admin", ADMIN_PASSWORD)
    assert client.post("/api/auth/logout", headers=bearer(a)).status_code == 200
    assert client.get("/api/auth/me", headers=bearer(a)).status_code == 401
    assert client.get("/api/auth/me", headers=bearer(b)).status_code == 200


def test_invite_codes_can_be_switched_off_and_on(client, admin, admin_code):
    assert client.put("/api/admin/server-settings", json={"allow_invite_codes": False}, headers=admin).status_code == 200
    try:
        assert client.get("/api/health").json()["login"]["invite_codes"] is False
        r = client.post("/api/auth/login", json={"name": "Visitor", "code": admin_code})
        assert r.status_code == 403 and "turned off" in r.json()["detail"]
        assert login(client, "admin", ADMIN_PASSWORD).status_code == 200, "accounts are unaffected"
    finally:
        client.put("/api/admin/server-settings", json={"allow_invite_codes": None}, headers=admin)   # back to the suite's default
    assert client.post("/api/auth/login", json={"name": "Visitor", "code": admin_code}).status_code == 200


def test_an_invite_code_session_has_no_account(client, admin_code):
    r = client.post("/api/auth/login", json={"name": "Guest", "code": admin_code})
    me = client.get("/api/auth/me", headers=bearer(r)).json()
    assert me["method"] == "invite_code" and me["username"] is None
    r2 = client.post("/api/auth/password", json={"current_password": "x", "new_password": GOOD}, headers=bearer(r))
    assert r2.status_code == 400 and "invite code" in r2.json()["detail"]


# ----------------------------------------------------------------------------- my account

def test_change_password_rules(client, make_user):
    u = make_user("pwrules-user")
    h = u["headers"]
    def change(cur, new):
        return client.post("/api/auth/password", json={"current_password": cur, "new_password": new}, headers=h)
    assert change("not-my-password", "A-Brand-New-Pass-9").status_code == 400
    assert "current password" in change("not-my-password", "A-Brand-New-Pass-9").json()["detail"]
    assert "at least" in change(GOOD, "short").json()["detail"]
    assert "guess" in change(GOOD, "password123").json()["detail"]
    assert "different" in change(GOOD, GOOD).json()["detail"]
    assert "username" in change(GOOD, "pwrules-user").json()["detail"]
    assert change(GOOD, "A-Brand-New-Pass-9").status_code == 200
    assert login(client, "pwrules-user", GOOD).status_code == 401
    assert login(client, "pwrules-user", "A-Brand-New-Pass-9").status_code == 200


def test_changing_password_signs_other_devices_out_but_not_this_one(client, make_user):
    u = make_user("devices")
    other = login(client, "devices", GOOD)
    assert client.post("/api/auth/password", json={"current_password": GOOD, "new_password": "Second-Password-22"}, headers=u["headers"]).status_code == 200
    assert client.get("/api/auth/me", headers=u["headers"]).status_code == 200
    assert client.get("/api/auth/me", headers=bearer(other)).status_code == 401


def test_guessing_the_current_password_is_throttled(client, make_user):
    u = make_user("guesser")
    for _ in range(auth.MAX_LOGIN_ATTEMPTS):
        client.post("/api/auth/password", json={"current_password": "wrong-wrong-1", "new_password": "Whatever-Pass-33"}, headers=u["headers"])
    r = client.post("/api/auth/password", json={"current_password": GOOD, "new_password": "Whatever-Pass-33"}, headers=u["headers"])
    assert r.status_code == 429


def test_change_display_name(client, make_user):
    u = make_user("namer", display_name="Old Name")
    assert client.patch("/api/auth/profile", json={"display_name": "  New   Name "}, headers=u["headers"]).json() == {"name": "New Name"}
    assert client.get("/api/auth/me", headers=u["headers"]).json()["name"] == "New Name"
    assert login(client, "namer", GOOD).json()["name"] == "New Name", "persisted on the account, not just this session"
    assert client.patch("/api/auth/profile", json={"display_name": "two\nlines"}, headers=u["headers"]).json() == {"name": "two lines"}, "whitespace is normalised"
    for bad in ("", "   ", "x" * 61, "bell\x07", "nul\x00byte"):
        assert client.patch("/api/auth/profile", json={"display_name": bad}, headers=u["headers"]).status_code == 400


def test_read_only_people_can_still_manage_their_own_account(client, make_user):
    u = make_user("viewer", role="readonly")
    h = u["headers"]
    assert client.post("/api/coops", json={"name": "Nope"}, headers=h).status_code == 403
    assert client.patch("/api/auth/profile", json={"display_name": "Viewer Vic"}, headers=h).status_code == 200
    assert client.post("/api/auth/password", json={"current_password": GOOD, "new_password": "Another-Pass-44"}, headers=h).status_code == 200


# ----------------------------------------------------------------------------- first-login change is enforced

def test_a_new_account_can_do_nothing_but_change_its_password(client, admin):
    r = client.post("/api/auth/users", json={"username": "newbie", "role": "member", "password": "Temporary-Pass-1"}, headers=admin)
    uid = r.json()["user"]["id"]
    try:
        h = bearer(login(client, "newbie", "Temporary-Pass-1"))
        blocked = client.get("/api/coops", headers=h)
        assert blocked.status_code == 403 and blocked.json()["code"] == "password_change_required"
        assert client.post("/api/coops", json={"name": "x"}, headers=h).status_code == 403
        assert client.get("/api/events?coop_id=x", headers=h).status_code == 403
        assert client.get("/api/auth/me", headers=h).json()["must_change_password"] is True
        assert client.post("/api/auth/password", json={"current_password": "Temporary-Pass-1", "new_password": GOOD}, headers=h).status_code == 200
        assert client.get("/api/coops", headers=h).status_code == 200
    finally:
        client.delete(f"/api/auth/users/{uid}", headers=admin)


# ----------------------------------------------------------------------------- admin: user management

def test_creating_users(client, admin):
    r = client.post("/api/auth/users", json={"username": "Maya", "display_name": "Maya R.", "role": "member"}, headers=admin)
    assert r.status_code == 200
    body = r.json()
    uid = body["user"]["id"]
    try:
        assert body["user"]["must_change_password"] is True and body["user"]["role"] == "member"
        temp = body["temporary_password"]
        assert len(temp) == 16, "no password given -> one is generated and shown once"
        assert login(client, "maya", temp).status_code == 200
        assert "temporary_password" not in client.get("/api/auth/users", headers=admin).text
    finally:
        client.delete(f"/api/auth/users/{uid}", headers=admin)


@pytest.mark.parametrize("payload,status", [
    ({"username": "ab", "password": GOOD}, 400),
    ({"username": "has space", "password": GOOD}, 400),
    ({"username": "okname", "password": "short"}, 400),
    ({"username": "okname", "password": GOOD, "role": "superuser"}, 400),
    ({"username": "admin", "password": GOOD}, 409),
    ({"username": "ADMIN", "password": GOOD}, 409),
])
def test_user_creation_is_validated(client, admin, payload, status):
    assert client.post("/api/auth/users", json=payload, headers=admin).status_code == status


def test_only_admins_can_manage_users(client, make_user, admin):
    member, viewer = make_user("justmember", role="member"), make_user("justviewer", role="readonly")
    some_id = client.get("/api/auth/users", headers=admin).json()["users"][0]["id"]
    for who in (member, viewer):
        h = who["headers"]
        assert client.get("/api/auth/users", headers=h).status_code == 403
        assert client.post("/api/auth/users", json={"username": "sneaky", "password": GOOD}, headers=h).status_code == 403
        assert client.patch(f"/api/auth/users/{some_id}", json={"role": "readonly"}, headers=h).status_code == 403
        assert client.post(f"/api/auth/users/{some_id}/password", json={}, headers=h).status_code == 403
        assert client.delete(f"/api/auth/users/{some_id}", headers=h).status_code == 403
    assert client.get("/api/auth/users").status_code == 401


def test_members_edit_data_but_cannot_reach_admin_pages(client, make_user, coop):
    m = make_user("worker", role="member")["headers"]
    assert client.post("/api/birds", json={"coop_id": coop, "name": "Henny"}, headers=m).status_code == 200
    for path in ("/api/admin/server-info", "/api/backups", "/api/auth/sessions", "/api/auth/invite-codes", "/api/auth/failed-logins"):
        assert client.get(path, headers=m).status_code == 403, path


def test_changing_a_role_takes_effect_immediately(client, admin, make_user):
    u = make_user("promoted", role="member")
    assert client.get("/api/admin/server-info", headers=u["headers"]).status_code == 403
    assert client.patch(f"/api/auth/users/{u['id']}", json={"role": "admin"}, headers=admin).status_code == 200
    assert client.get("/api/admin/server-info", headers=u["headers"]).status_code == 200, "no sign-out needed"
    assert client.patch(f"/api/auth/users/{u['id']}", json={"role": "readonly"}, headers=admin).status_code == 200
    assert client.post("/api/coops", json={"name": "x"}, headers=u["headers"]).status_code == 403


def test_renaming_a_user_updates_their_sessions(client, admin, make_user):
    u = make_user("renamed")
    client.patch(f"/api/auth/users/{u['id']}", json={"display_name": "Renamed By Admin"}, headers=admin)
    assert client.get("/api/auth/me", headers=u["headers"]).json()["name"] == "Renamed By Admin"


def test_disabling_a_user_cuts_them_off_and_can_be_undone(client, admin, make_user):
    u = make_user("sleeper")
    assert client.patch(f"/api/auth/users/{u['id']}", json={"disabled": True}, headers=admin).json()["user"]["disabled"] is True
    assert client.get("/api/coops", headers=u["headers"]).status_code == 401
    assert login(client, "sleeper", GOOD).status_code == 401
    assert client.patch(f"/api/auth/users/{u['id']}", json={"disabled": False}, headers=admin).status_code == 200
    assert login(client, "sleeper", GOOD).status_code == 200


def test_resetting_a_password(client, admin, make_user):
    u = make_user("forgetful")
    r = client.post(f"/api/auth/users/{u['id']}/password", json={}, headers=admin)
    temp = r.json()["temporary_password"]
    assert client.get("/api/auth/me", headers=u["headers"]).status_code == 401, "signed out everywhere"
    assert login(client, "forgetful", GOOD).status_code == 401
    again = login(client, "forgetful", temp)
    assert again.status_code == 200 and again.json()["must_change_password"] is True
    r = client.post(f"/api/auth/users/{u['id']}/password", json={"password": "Chosen-By-Admin-5"}, headers=admin)
    assert "temporary_password" not in r.json(), "an admin-chosen password isn't echoed back"
    assert client.post(f"/api/auth/users/{u['id']}/password", json={"password": "weak"}, headers=admin).status_code == 400


def test_deleting_a_user(client, admin, make_user):
    u = make_user("leaver")
    assert client.delete(f"/api/auth/users/{u['id']}", headers=admin).status_code == 200
    assert client.get("/api/coops", headers=u["headers"]).status_code == 401
    assert login(client, "leaver", GOOD).status_code == 401
    assert client.delete(f"/api/auth/users/{u['id']}", headers=admin).status_code == 404
    assert all(x["username"] != "leaver" for x in client.get("/api/auth/users", headers=admin).json()["users"])


def test_an_admin_cannot_lock_themselves_out(client, admin):
    me = client.get("/api/auth/me", headers=admin).json()["user_id"]
    assert client.delete(f"/api/auth/users/{me}", headers=admin).status_code == 400
    assert client.patch(f"/api/auth/users/{me}", json={"role": "member"}, headers=admin).status_code == 400
    assert client.patch(f"/api/auth/users/{me}", json={"disabled": True}, headers=admin).status_code == 400
    assert client.get("/api/auth/me", headers=admin).status_code == 200


def test_admins_can_demote_and_disable_each_other_while_one_remains(client, make_user):
    p, q = make_user("admin-p", role="admin"), make_user("admin-q", role="admin")
    assert client.patch(f"/api/auth/users/{q['id']}", json={"role": "member"}, headers=p["headers"]).status_code == 200
    assert client.get("/api/auth/users", headers=q["headers"]).status_code == 403, "demoted: no longer an admin"
    assert client.patch(f"/api/auth/users/{q['id']}", json={"role": "admin"}, headers=p["headers"]).status_code == 200
    assert client.patch(f"/api/auth/users/{q['id']}", json={"disabled": True}, headers=p["headers"]).status_code == 200
    assert client.delete(f"/api/auth/users/{q['id']}", headers=p["headers"]).status_code == 200


def test_disabled_admins_do_not_count_as_admins():
    """The 'never leave zero admins' guard counts ACTIVE admins only. (The API can't reach the zero case --
    whoever is acting is an active admin themselves -- so the counting is tested directly.)"""
    from coopledger import users
    from coopledger.db import get_db
    with get_db() as conn:
        base = users._active_admins(conn)
        conn.execute("INSERT INTO users (id, username, display_name, password_hash, role, created_at, disabled_at) VALUES ('zz1', 'ghost-admin', 'g', 'x', 'admin', '2026-01-01', '2026-01-02')")
        assert users._active_admins(conn) == base, "a disabled admin is not an active admin"
        conn.execute("UPDATE users SET disabled_at = NULL WHERE id = 'zz1'")
        assert users._active_admins(conn) == base + 1
        assert users._active_admins(conn, excluding="zz1") == base
        conn.execute("DELETE FROM users WHERE id = 'zz1'")


def test_sessions_list_shows_who_is_signed_in(client, admin):
    rows = client.get("/api/auth/sessions", headers=admin).json()
    assert any(r["username"] == "admin" for r in rows)
    assert all("token" not in r for r in rows)
