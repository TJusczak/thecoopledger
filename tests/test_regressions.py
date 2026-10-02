"""One test per bug found in the server audit, so none of them can come back."""
import sqlite3
from datetime import date, timedelta

import pytest

from coopledger import config, maintenance, push


def test_importing_a_coop_with_hatches_works(client, admin, coop):
    # Used to raise NameError (old_hatch_id was never assigned): any coop that
    # had ever had a clutch could not be restored from a backup.
    bird = client.post("/api/birds", json={"coop_id": coop, "name": "Chick"}, headers=admin).json()
    h = client.post("/api/hatches", json={"coop_id": coop, "date_started": "2026-07-01", "egg_count": 2, "breed": "Cochin"}, headers=admin).json()
    client.post("/api/hatch_eggs", json={"coop_id": coop, "hatch_id": h["id"], "position": 1, "status": "Hatched", "bird_id": bird["id"]}, headers=admin)
    client.post("/api/hatch_eggs", json={"coop_id": coop, "hatch_id": h["id"], "position": 2, "status": "Clear"}, headers=admin)

    bundle = client.get(f"/api/coops/{coop}/export", headers=admin).json()
    r = client.post("/api/coops/import", json=bundle, headers=admin)
    assert r.status_code == 200, r.text
    new = r.json()["id"]

    hatches = client.get(f"/api/hatches?coop_id={new}", headers=admin).json()
    eggs = client.get(f"/api/hatch_eggs?coop_id={new}", headers=admin).json()
    birds = client.get(f"/api/birds?coop_id={new}", headers=admin).json()
    assert len(hatches) == 1 and len(eggs) == 2
    assert {e["hatch_id"] for e in eggs} == {hatches[0]["id"]}             # remapped to the NEW clutch
    assert hatches[0]["id"] != h["id"]
    linked = next(e for e in eggs if e["status"] == "Hatched")
    assert linked["bird_id"] == birds[0]["id"] != bird["id"]               # and to the NEW bird


def test_imported_coop_is_announced_to_other_devices(client, admin, coop):
    # import creates a coop; the sync tombstone/row must be there for other devices
    bundle = client.get(f"/api/coops/{coop}/export", headers=admin).json()
    new = client.post("/api/coops/import", json=bundle, headers=admin).json()["id"]
    ids = [c["id"] for c in client.get("/api/sync/coops", headers=admin).json()["rows"]]
    assert new in ids


def test_auto_rotated_invite_code_actually_logs_in(client, admin, admin_code, keep_primary_code):
    # Auto-rotation updated auth_settings but not invite_codes, so the new code
    # was printed to the log and then rejected at login (and the old one kept working).
    with sqlite3.connect(config.DB_PATH) as c:
        c.execute("UPDATE auth_settings SET auto_rotate_days = 1, rotated_at = '2020-01-01T00:00:00+00:00' WHERE id = 1")
    maintenance.maybe_auto_rotate_invite_code()
    with sqlite3.connect(config.DB_PATH) as c:
        new_code = c.execute("SELECT invite_code FROM auth_settings WHERE id = 1").fetchone()[0]
        c.execute("UPDATE auth_settings SET auto_rotate_days = NULL WHERE id = 1")
    assert new_code != admin_code
    assert client.post("/api/auth/login", json={"name": "Rot", "code": new_code}).status_code == 200
    assert client.post("/api/auth/login", json={"name": "Rot", "code": admin_code}).status_code == 401


def test_integration_key_can_be_deleted(client, admin):
    # Shadowed by DELETE /api/{resource}/{item_id}, so it 404'd forever.
    key = client.post("/api/integrations/key/rotate", headers=admin).json()["api_key"]
    assert client.get("/api/integrations/stats", headers={"X-API-Key": key}).status_code in (200, 404)
    assert client.delete("/api/integrations/key", headers=admin).status_code == 200
    assert client.get("/api/integrations/key", headers=admin).json()["api_key"] is None
    assert client.get("/api/integrations/stats", headers={"X-API-Key": key}).status_code == 503


def test_integration_stats_see_bedding_cleanouts(client, admin, coop):
    # The app writes "Full Clean-out"; the server compared against "Full Clean-Out".
    d = (date.today() - timedelta(days=12)).isoformat()
    client.post("/api/bedding", json={"coop_id": coop, "area": "Run", "entry_type": "Full Clean-out", "date": d}, headers=admin)
    key = client.post("/api/integrations/key/rotate", headers=admin).json()["api_key"]
    stats = client.get("/api/integrations/stats", params={"coop_id": coop}, headers={"X-API-Key": key}).json()
    assert stats["bedding_days_since_cleanout"]["Run"] == 12


def test_integration_stats_count_active_hatches(client, admin, coop):
    client.post("/api/hatches", json={"coop_id": coop, "date_started": date.today().isoformat(), "egg_count": 4}, headers=admin)
    done = client.post("/api/hatches", json={"coop_id": coop, "date_started": "2026-01-01", "status": "Complete"}, headers=admin).json()
    key = client.post("/api/integrations/key/rotate", headers=admin).json()["api_key"]
    stats = client.get("/api/integrations/stats", params={"coop_id": coop}, headers={"X-API-Key": key}).json()
    assert stats["flock"]["active_hatches"] == 1 and done["id"]


@pytest.fixture()
def sent(monkeypatch):
    calls = []
    monkeypatch.setattr(push, "notify", lambda category, title, body, subject_key, url="/": calls.append((category, title, subject_key)) or 1)
    return calls


def test_reminder_sweep_fires_hatch_lockdown(client, admin, coop, sent):
    # Queried hatches.name / hatches.start_date, which don't exist: the SQL
    # error aborted the whole sweep, so no reminder of any kind was ever sent.
    start = (date.today() - timedelta(days=18)).isoformat()
    client.post("/api/hatches", json={"coop_id": coop, "date_started": start, "breed": "Silkie"}, headers=admin)
    push.push_reminder_sweep()
    assert any(c == "hatch" and "Silkie" in t and "lockdown" in t for c, t, _ in sent)


def test_reminder_sweep_fires_bedding_using_the_apps_settings(client, admin, coop, sent):
    old = (date.today() - timedelta(days=200)).isoformat()
    client.post("/api/bedding", json={"coop_id": coop, "area": "Coop Floor", "entry_type": "Full Clean-out", "date": old}, headers=admin)
    push.push_reminder_sweep()
    assert any(c == "bedding" and "Coop Floor" in t for c, t, _ in sent)


def test_reminder_sweep_one_bad_coop_does_not_silence_the_rest(client, admin, coop, sent):
    bad = client.post("/api/coops", json={"name": "Corrupt"}, headers=admin).json()["id"]
    with sqlite3.connect(config.DB_PATH) as c:
        c.execute("UPDATE coops SET settings = '{not json' WHERE id = ?", (bad,))
    start = (date.today() - timedelta(days=21)).isoformat()
    client.post("/api/hatches", json={"coop_id": coop, "date_started": start, "breed": "Brahma"}, headers=admin)
    push.push_reminder_sweep()
    assert any("Brahma" in t for _, t, _ in sent)


def test_maintenance_steps_are_isolated(monkeypatch):
    ran = []

    def boom():
        raise RuntimeError("one step fails")

    monkeypatch.setattr(maintenance, "prune_old_activity_log", boom)
    monkeypatch.setattr(maintenance, "prune_old_failed_logins", lambda: ran.append("later step"))
    maintenance.run_maintenance_pass()
    assert "later step" in ran


def test_bulk_bird_endpoints_have_a_size_cap(client, admin, coop):
    assert client.post("/api/birds/bulk-update", json={"ids": ["x"] * 2001, "updates": {"notes": "n"}}, headers=admin).status_code == 400


def test_rotating_the_primary_code_changes_both_tables(client, admin, keep_primary_code):
    with sqlite3.connect(config.DB_PATH) as c:
        before = c.execute("SELECT invite_code FROM auth_settings").fetchone()[0]
    new = client.post("/api/auth/invite-code/rotate", headers=admin).json()["invite_code"]
    assert new != before
    with sqlite3.connect(config.DB_PATH) as c:
        assert c.execute("SELECT COUNT(*) FROM invite_codes WHERE code = ?", (new,)).fetchone()[0] == 1
        assert c.execute("SELECT COUNT(*) FROM invite_codes WHERE code = ?", (before,)).fetchone()[0] == 0
