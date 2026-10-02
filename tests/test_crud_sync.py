"""Generic CRUD, tombstones, and incremental sync."""
import sqlite3

from coopledger import config, migrations


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


def test_create_retry_with_same_id_is_idempotent_and_never_overwrites(client, admin, coop):
    # A retried create (reply lost after the server committed) must be a
    # no-op -- it used to overwrite the row, undoing edits made in between.
    payload = {"id": "retry-test-1", "coop_id": coop, "name": "First"}
    assert client.post("/api/birds", json=payload, headers=admin).status_code == 200
    client.put("/api/birds/retry-test-1", json={"name": "Edited elsewhere"}, headers=admin)
    r = client.post("/api/birds", json=payload, headers=admin)  # the stale retry
    assert r.status_code == 200
    assert r.json()["name"] == "Edited elsewhere"


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
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("INSERT INTO hatches (id, coop_id, date_started, deleted_at, updated_at) VALUES ('orph-h', ?, '2026-01-01', '2026-01-02T00:00:00+00:00', '2026-01-02T00:00:00+00:00')", (coop,))
        conn.execute("INSERT INTO hatch_eggs (id, coop_id, hatch_id, updated_at) VALUES ('orph-e', ?, 'orph-h', '2026-01-01T00:00:00+00:00')", (coop,))
    migrations.migrate_repair_orphaned_hatch_eggs()
    with sqlite3.connect(config.DB_PATH) as conn:
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
