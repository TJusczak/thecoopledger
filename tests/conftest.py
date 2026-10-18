"""Shared fixtures for the server test suite.

Run with:  pytest   (from the project root; needs requirements-dev.txt)

The suite exercises the real FastAPI app against a real (temporary) SQLite
database -- no mocks of the database layer, since SQLite behavior (WAL mode,
soft-delete visibility, sync timestamps) IS the thing worth testing. The whole
session shares one fresh DATA_DIR, so nothing here can touch a real
deployment's data.
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

# DATA_DIR must be set BEFORE the package is imported -- config derives every
# path at import time.
_TMP = tempfile.mkdtemp(prefix="coop-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["MAX_PHOTO_UPLOAD_MB"] = "1"  # small cap so the oversize test doesn't need 25MB of bytes
# Behave like a server upgraded from before accounts, where shared invite codes still work: the older
# tests exercise them, and test_accounts.py switches them off to test the new-install default.
os.environ["ALLOW_INVITE_CODES"] = "1"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from coopledger import auth, passwords  # noqa: E402
from helpers import ADMIN_PASSWORD, FAST_HASH  # noqa: E402
from coopledger.app import app  # noqa: E402

DATA_DIR = Path(_TMP)

passwords.HASH_PARAMS.update(FAST_HASH)

@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:  # context manager triggers the lifespan (init_db etc.)
        yield c


@pytest.fixture(scope="session")
def first_run_credentials(client):
    """What the first-run banner would have told the operator (read before anything changes it)."""
    text = (DATA_DIR / "admin_credentials.txt").read_text()
    return {k.lower(): v.strip() for k, v in (line.split(": ", 1) for line in text.splitlines() if line.startswith(("Username: ", "Password: ")))}


@pytest.fixture(scope="session")
def admin_code(client):
    """The legacy shared invite code (switched on for the suite, see ALLOW_INVITE_CODES above)."""
    return (DATA_DIR / "invite_code.txt").read_text().strip()


@pytest.fixture(autouse=True)
def _reset_login_rate_limit():
    # The limiters are in-memory; TestClient always presents the same IP, so leftover failures from one
    # test would poison the next.
    for bucket in (auth.failed_login_attempts, auth.failed_username_attempts):
        bucket.clear()
    yield
    for bucket in (auth.failed_login_attempts, auth.failed_username_attempts):
        bucket.clear()


@pytest.fixture(scope="session")
def admin(client, first_run_credentials):
    """Signed in as the bootstrap admin, the way a real operator would: with the generated password, then
    choosing their own (the server insists before it will do anything else)."""
    r = client.post("/api/auth/login", json={"username": first_run_credentials["username"], "password": first_run_credentials["password"]})
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    headers = {"Authorization": f"Bearer {r.json()['token']}"}
    r = client.post("/api/auth/password", json={"current_password": first_run_credentials["password"], "new_password": ADMIN_PASSWORD}, headers=headers)
    assert r.status_code == 200, r.text
    return headers


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


@pytest.fixture()
def keep_primary_code(admin_code):
    """For tests that rotate the primary invite code: put it back afterwards so
    the session-scoped `admin_code` stays valid for every later test."""
    import sqlite3

    from coopledger import config
    yield
    with sqlite3.connect(config.DB_PATH) as c:
        current = c.execute("SELECT invite_code FROM auth_settings WHERE id = 1").fetchone()[0]
        c.execute("UPDATE invite_codes SET code = ? WHERE code = ?", (admin_code, current))
        c.execute("UPDATE auth_settings SET invite_code = ?, auto_rotate_days = NULL WHERE id = 1", (admin_code,))
    (config.DATA_DIR / "invite_code.txt").write_text(admin_code + "\n")
