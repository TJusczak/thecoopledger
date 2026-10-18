"""Recovering a lost admin password: the reset-admin command (and the pieces under it)."""
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from coopledger import cli, config, migrations, passwords, users
from coopledger.db import get_db

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def scratch(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "coop.db")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(migrations, "DATA_DIR", tmp_path)
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    migrations.init_db()
    # the operator has chosen their own password, so the first-run file is gone -- the normal state of an install
    (tmp_path / "admin_credentials.txt").unlink(missing_ok=True)
    return tmp_path


def row(path, username):
    with sqlite3.connect(path / "coop.db") as c:
        c.row_factory = sqlite3.Row
        r = c.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
        return dict(r) if r else None


def add_user(username, role="member", password="Some-Password-1"):
    with get_db() as conn:
        conn.execute("INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, '2026-01-01')",
                     (f"id-{username}", username, username, passwords.hash_password(password), role))


# --------------------------------------------------------------------------- reset_admin

def test_a_lost_password_is_replaced_and_the_old_one_stops_working(scratch):
    with get_db() as conn:
        conn.execute("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = 'admin'", (passwords.hash_password("The-One-I-Forgot-1"),))
    with get_db() as conn:
        out = users.reset_admin(conn)
    assert out["generated"] and not out["created"] and len(out["password"]) == 16
    admin = row(scratch, "admin")
    assert passwords.verify_password(out["password"], admin["password_hash"])
    assert not passwords.verify_password("The-One-I-Forgot-1", admin["password_hash"])
    assert admin["must_change_password"] == 1, "a generated password has to be replaced at the next sign-in"


def test_the_new_credentials_are_written_down_owner_only(scratch):
    with get_db() as conn:
        out = users.reset_admin(conn)
    f = scratch / "admin_credentials.txt"
    assert f.exists() and out["password"] in f.read_text() and "Username: admin" in f.read_text()
    assert oct(f.stat().st_mode & 0o777) == "0o600"


def test_a_demoted_and_disabled_admin_is_restored(scratch):
    with get_db() as conn:
        conn.execute("UPDATE users SET role = 'readonly', disabled_at = '2026-01-01' WHERE username = 'admin'")
    with get_db() as conn:
        users.reset_admin(conn)
    admin = row(scratch, "admin")
    assert admin["role"] == "admin" and admin["disabled_at"] is None, "the whole point is being able to get back in"


def test_the_account_is_signed_out_everywhere(scratch):
    with get_db() as conn:
        uid = conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()["id"]
        conn.execute("INSERT INTO sessions (token, name, created_at, role, user_id) VALUES ('t1', 'Admin', 'now', 'admin', ?)", (uid,))
        conn.execute("INSERT INTO sessions (token, name, created_at, role, user_id) VALUES ('t2', 'Other', 'now', 'member', NULL)")
    with get_db() as conn:
        users.reset_admin(conn)
    with sqlite3.connect(scratch / "coop.db") as c:
        left = {r[0] for r in c.execute("SELECT token FROM sessions")}
    assert left == {"t2"}, "the admin's sessions end; an unrelated session is untouched"


def test_other_accounts_are_not_touched(scratch):
    add_user("maya", "member")
    add_user("sam", "readonly")
    before = {n: row(scratch, n) for n in ("maya", "sam")}
    with get_db() as conn:
        users.reset_admin(conn)
    assert {n: row(scratch, n) for n in ("maya", "sam")} == before


def test_a_missing_admin_account_is_created(scratch):
    with get_db() as conn:
        conn.execute("DELETE FROM users WHERE username = 'admin'")
    add_user("maya")
    with get_db() as conn:
        out = users.reset_admin(conn)
    assert out["created"] and row(scratch, "admin")["role"] == "admin"


def test_any_account_can_be_the_one_recovered(scratch):
    add_user("farmer-joe", "member")
    with get_db() as conn:
        out = users.reset_admin(conn, username="Farmer-Joe")       # the match ignores case
    joe = row(scratch, "farmer-joe")
    assert joe["role"] == "admin" and passwords.verify_password(out["password"], joe["password_hash"])
    assert row(scratch, "admin") is not None


def test_a_password_you_choose_is_used_as_given_with_no_forced_change_and_no_file(scratch):
    (scratch / "admin_credentials.txt").write_text("stale")
    with get_db() as conn:
        out = users.reset_admin(conn, password="My-Own-Passphrase-9")
    assert out["generated"] is False and out["password"] is None
    admin = row(scratch, "admin")
    assert passwords.verify_password("My-Own-Passphrase-9", admin["password_hash"]) and admin["must_change_password"] == 0
    assert not (scratch / "admin_credentials.txt").exists(), "a stale file with an old password must not linger"


@pytest.mark.parametrize("kwargs", [{"password": "weak"}, {"password": "password"}, {"username": "no spaces"}, {"username": "ab"}])
def test_bad_input_is_refused_and_changes_nothing(scratch, kwargs):
    before = row(scratch, "admin")
    with pytest.raises(ValueError):
        with get_db() as conn:
            users.reset_admin(conn, **kwargs)
    assert row(scratch, "admin") == before


# --------------------------------------------------------------------------- the command itself

def run_cli(data_dir, *args, env_extra=None):
    env = {**os.environ, "DATA_DIR": str(data_dir), **(env_extra or {})}
    env.pop("ADMIN_PASSWORD", None)
    return subprocess.run([sys.executable, "-m", "coopledger.cli", *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)


def test_the_command_resets_the_admin_end_to_end(tmp_path):
    first = run_cli(tmp_path, "list-users")                       # the very first run creates the database and the first admin
    assert first.returncode == 0 and "admin" in first.stdout
    (tmp_path / "admin_credentials.txt").unlink(missing_ok=True)

    r = run_cli(tmp_path, "reset-admin")
    assert r.returncode == 0, r.stderr
    password = re.search(r"Password: (\S+)", r.stdout).group(1)
    assert "RESET" in r.stdout and "Everyone else's accounts are unchanged" in r.stdout
    assert passwords.verify_password(password, row(tmp_path, "admin")["password_hash"])
    assert password in (tmp_path / "admin_credentials.txt").read_text()


def test_the_command_reports_bad_input_without_a_traceback(tmp_path):
    run_cli(tmp_path, "list-users")
    r = run_cli(tmp_path, "reset-admin", "--password", "password")
    assert r.returncode == 2 and "Can't do that" in r.stderr and "Traceback" not in r.stderr


def test_list_users_shows_roles_and_disabled_state(tmp_path):
    run_cli(tmp_path, "list-users")
    with sqlite3.connect(tmp_path / "coop.db") as c:
        c.execute("INSERT INTO users (id, username, display_name, password_hash, role, created_at, disabled_at) VALUES ('x', 'sleepy', 'Sleepy', 'x', 'member', '2026-01-01', '2026-01-02')")
    out = run_cli(tmp_path, "list-users").stdout
    assert re.search(r"sleepy\s+member\s+Sleepy \(disabled\)", out)


def test_run_as_root_the_command_becomes_the_data_owner_first(tmp_path, monkeypatch):
    """`docker exec` starts as root, but the server runs unprivileged: a root-run command could leave root-owned
    database files the server can't open."""
    calls = []
    st = tmp_path.stat()
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(os, "stat", lambda p: type("S", (), {"st_uid": 1234, "st_gid": 4321})())
    monkeypatch.setattr(os, "setgroups", lambda g: calls.append(("groups", tuple(g))))
    monkeypatch.setattr(os, "setgid", lambda g: calls.append(("gid", g)))
    monkeypatch.setattr(os, "setuid", lambda u: calls.append(("uid", u)))
    cli._drop_to_data_owner(tmp_path)
    assert calls == [("groups", ()), ("gid", 4321), ("uid", 1234)], "supplementary groups, then gid, then uid (uid last: it can't be undone)"
    assert st


def test_a_non_root_run_or_root_owned_data_is_left_alone(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(os, "setuid", lambda u: calls.append(u))
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    cli._drop_to_data_owner(tmp_path)
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(os, "stat", lambda p: type("S", (), {"st_uid": 0, "st_gid": 0})())
    cli._drop_to_data_owner(tmp_path)
    assert calls == []
