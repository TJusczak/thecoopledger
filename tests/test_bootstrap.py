"""First run and upgrades: where the first admin comes from, and that updating never locks anyone out."""
import sqlite3
import stat

import pytest

from coopledger import auth, config, migrations, passwords
from coopledger.db import get_db
from coopledger.settings import get_setting


@pytest.fixture()
def scratch(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "coop.db")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(migrations, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "ALLOW_INVITE_CODES", False)     # a new server's default (the suite overrides it globally)
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    return tmp_path


def users_in(path):
    with sqlite3.connect(path / "coop.db") as c:
        c.row_factory = sqlite3.Row
        return [dict(r) for r in c.execute("SELECT * FROM users")]


# ------------------------------------------------------------------------ a brand-new server

def test_a_new_server_creates_an_admin_with_a_generated_password(scratch, capsys):
    migrations.init_db()
    (admin,) = users_in(scratch)
    assert (admin["username"], admin["role"], admin["must_change_password"]) == ("admin", "admin", 1)

    creds = scratch / "admin_credentials.txt"
    text = creds.read_text()
    password = next(line.split(": ", 1)[1] for line in text.splitlines() if line.startswith("Password: "))
    assert passwords.verify_password(password, admin["password_hash"]), "the file holds the real password"
    assert password not in admin["password_hash"]
    assert stat.S_IMODE(creds.stat().st_mode) == 0o600, "owner-only: it is a credential"

    out = capsys.readouterr().out
    assert "FIRST-RUN ADMINISTRATOR" in out and password in out and "Username: admin" in out


def test_a_new_server_starts_with_invite_codes_off(scratch):
    migrations.init_db()
    assert get_setting("allow_invite_codes") is False
    assert not (scratch / "invite_code.txt").exists(), "no shared code is written out for a server that doesn't use them"


def test_init_is_idempotent_and_never_regenerates_the_admin(scratch):
    migrations.init_db()
    (before,) = users_in(scratch)
    migrations.init_db()
    migrations.init_db()
    (after,) = users_in(scratch)
    assert after["id"] == before["id"] and after["password_hash"] == before["password_hash"]


def test_credentials_file_is_removed_when_the_password_is_changed(scratch):
    migrations.init_db()
    assert (scratch / "admin_credentials.txt").exists()
    auth._bootstrap_credentials_file().unlink(missing_ok=True)       # what change_my_password does
    assert not (scratch / "admin_credentials.txt").exists()


# ------------------------------------------------------------------------ docker-compose env vars

def test_admin_credentials_from_the_environment(scratch, monkeypatch, capsys):
    monkeypatch.setenv("ADMIN_USERNAME", "farmer.joe")
    monkeypatch.setenv("ADMIN_PASSWORD", "A-Password-I-Chose-1")
    migrations.init_db()
    (admin,) = users_in(scratch)
    assert admin["username"] == "farmer.joe" and admin["display_name"] == "farmer.joe"
    assert admin["must_change_password"] == 0, "the operator chose it: no forced change"
    assert passwords.verify_password("A-Password-I-Chose-1", admin["password_hash"])
    assert not (scratch / "admin_credentials.txt").exists(), "nothing generated, so nothing to write down"
    assert "A-Password-I-Chose-1" not in capsys.readouterr().out, "a chosen password is never printed"


def test_a_weak_password_in_the_environment_is_ignored_with_a_warning(scratch, monkeypatch, capsys):
    monkeypatch.setenv("ADMIN_PASSWORD", "password")
    migrations.init_db()
    (admin,) = users_in(scratch)
    assert not passwords.verify_password("password", admin["password_hash"])
    assert admin["must_change_password"] == 1 and (scratch / "admin_credentials.txt").exists()
    assert "ADMIN_PASSWORD was ignored" in capsys.readouterr().out


def test_an_invalid_username_in_the_environment_falls_back_to_admin(scratch, monkeypatch, capsys):
    monkeypatch.setenv("ADMIN_USERNAME", "no spaces allowed!")
    migrations.init_db()
    assert users_in(scratch)[0]["username"] == "admin"
    assert "isn't a valid username" in capsys.readouterr().out


def test_the_environment_does_not_override_an_existing_admin(scratch, monkeypatch):
    migrations.init_db()
    monkeypatch.setenv("ADMIN_USERNAME", "hijacker")
    monkeypatch.setenv("ADMIN_PASSWORD", "Hijack-Password-1")
    migrations.init_db()                                                # a restart with new env vars
    assert [u["username"] for u in users_in(scratch)] == ["admin"], "env vars only seed an EMPTY server"


# ------------------------------------------------------------------------ upgrading an existing server

def legacy_server(path, *, code="ABCD2345", token="legacy-session-token-43-characters-long--"):
    """A database as the previous release left it: invite codes, sessions with raw tokens, no users table."""
    with sqlite3.connect(path / "coop.db") as c:
        c.executescript(f"""
            CREATE TABLE auth_settings (id INTEGER PRIMARY KEY CHECK (id = 1), invite_code TEXT NOT NULL, auto_rotate_days INTEGER, rotated_at TEXT);
            INSERT INTO auth_settings VALUES (1, '{code}', NULL, '2026-01-01T00:00:00+00:00');
            CREATE TABLE invite_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','readonly')), label TEXT, created_at TEXT NOT NULL, revoked_at TEXT);
            INSERT INTO invite_codes (code, role, label, created_at) VALUES ('{code}', 'admin', 'Original admin code', '2026-01-01T00:00:00+00:00');
            INSERT INTO invite_codes (code, role, label, created_at) VALUES ('VIEWONLY', 'readonly', 'Grandma', '2026-01-02T00:00:00+00:00');
            CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, last_activity TEXT, role TEXT NOT NULL DEFAULT 'admin', invite_code_id INTEGER);
            INSERT INTO sessions (token, name, created_at, role, invite_code_id) VALUES ('{token}', 'Kitchen Tablet', '2026-01-03T00:00:00+00:00', 'admin', 1);
        """)
    return code, token


def test_upgrading_keeps_invite_codes_working_and_adds_an_admin(scratch, capsys):
    code, token = legacy_server(scratch)
    migrations.init_db()
    migrations.run_migrations()

    assert get_setting("allow_invite_codes") is True, "an upgraded server keeps its shared codes on"
    assert (scratch / "invite_code.txt").read_text().strip() == code
    (admin,) = users_in(scratch)
    assert admin["username"] == "admin" and admin["must_change_password"] == 1
    out = capsys.readouterr().out
    assert "Existing invite codes still work" in out

    with get_db(write=False) as conn:
        assert conn.execute("SELECT 1 FROM invite_codes WHERE code = 'VIEWONLY'").fetchone(), "codes and labels survive"
        session = auth.lookup_session(conn, token)
    assert session and session["name"] == "Kitchen Tablet" and session["role"] == "admin", "the tablet stays signed in"
    with sqlite3.connect(scratch / "coop.db") as c:
        assert c.execute("SELECT COUNT(*) FROM sessions WHERE token = ?", (token,)).fetchone()[0] == 0, "...but its token is no longer stored raw"


def test_upgrading_twice_changes_nothing_more(scratch):
    legacy_server(scratch)
    migrations.init_db(); migrations.run_migrations()
    (first,) = users_in(scratch)
    migrations.init_db(); migrations.run_migrations()
    (second,) = users_in(scratch)
    assert second["password_hash"] == first["password_hash"]


def test_an_admin_can_turn_invite_codes_off_after_an_upgrade(scratch):
    legacy_server(scratch)
    migrations.init_db()
    with get_db() as conn:
        conn.execute("UPDATE server_settings SET value = '0' WHERE key = 'allow_invite_codes'")
    assert get_setting("allow_invite_codes") is False
    migrations.init_db()                                                # a restart must not flip it back on
    assert get_setting("allow_invite_codes") is False
    assert not (scratch / "invite_code.txt").exists()


def test_the_users_table_enforces_roles_and_unique_names_ignoring_case(scratch):
    migrations.init_db()
    with sqlite3.connect(scratch / "coop.db") as c:
        with pytest.raises(sqlite3.IntegrityError):
            c.execute("INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('x', 'ADMIN', 'x', 'x', 'admin', 'now')")
        with pytest.raises(sqlite3.IntegrityError):
            c.execute("INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('y', 'someone', 'x', 'x', 'root', 'now')")
