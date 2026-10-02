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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from coopledger import auth  # noqa: E402
from coopledger.app import app  # noqa: E402

DATA_DIR = Path(_TMP)

# A tiny but genuine 1x1 PNG (magic bytes + valid structure).
TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082"
)


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:  # context manager triggers the lifespan (init_db etc.)
        yield c


@pytest.fixture(scope="session")
def admin_code():
    # init_db writes the bootstrap code to invite_code.txt -- the same way a
    # real operator gets it.
    return (DATA_DIR / "invite_code.txt").read_text().strip()


@pytest.fixture(autouse=True)
def _reset_login_rate_limit():
    # The limiter is in-memory per-IP; TestClient always presents the same
    # IP, so leftover failures from one test would poison the next.
    auth.failed_login_attempts.clear()
    yield
    auth.failed_login_attempts.clear()


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
