"""The sync guarantees: nothing committed is ever invisible to a client that
pulls with the cursor it was given, no matter how writes and pulls interleave."""
import random
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from coopledger import config, db
from coopledger.db import get_db, now_iso
from coopledger.routes_resources import sync_resource


def _pull_all(coop, since=""):
    """What a client does: pull with the stored cursor, return (rows, new cursor)."""
    out = sync_resource("birds", coop_id=coop, since=since or None)
    return out["rows"], out["server_time"]


# ---------------------------------------------------------------- the clock

def test_write_stamps_strictly_increase(client, admin, coop):
    stamps = []
    for i in range(20):
        r = client.post("/api/eggs", json={"coop_id": coop, "date": "2026-01-01", "count": i}, headers=admin)
        stamps.append(r.json()["updated_at"])
    assert stamps == sorted(stamps)
    assert len(set(stamps)) == len(stamps)


def test_clock_never_goes_backwards_even_if_wall_clock_does(client, admin, coop):
    future = (datetime.now(timezone.utc) + timedelta(days=3)).strftime(db.TS_FORMAT)
    with sqlite3.connect(config.DB_PATH) as c:
        c.execute("UPDATE sync_clock SET last_ts = ? WHERE id = 1", (future,))
    r = client.post("/api/eggs", json={"coop_id": coop, "date": "2026-01-01", "count": 1}, headers=admin)
    assert r.json()["updated_at"] > future  # stepped past the future value instead of using the (earlier) wall clock


def test_one_transaction_shares_one_stamp(client, admin, coop):
    items = [{"coop_id": coop, "name": f"B{i}"} for i in range(5)]
    rows = client.post("/api/birds/bulk-create", json={"items": items}, headers=admin).json()["items"]
    assert len({r["updated_at"] for r in rows}) == 1


def test_cursor_is_not_ahead_of_any_row(client, admin, coop):
    client.post("/api/birds", json={"coop_id": coop, "name": "x"}, headers=admin)
    rows, cursor = _pull_all(coop)
    assert all(r["updated_at"] <= cursor for r in rows)
    again, _ = _pull_all(coop, cursor)
    assert again == []  # nothing new: the cursor really is "caught up"


def test_new_write_appears_after_the_cursor(client, admin, coop):
    _, cursor = _pull_all(coop)
    client.post("/api/birds", json={"coop_id": coop, "name": "late"}, headers=admin)
    rows, _ = _pull_all(coop, cursor)
    assert [r["name"] for r in rows] == ["late"]


# ------------------------------------------------- the race that used to lose rows

def test_no_row_is_lost_when_writes_race_a_puller(coop):
    """Writers deliberately dawdle between stamping and committing -- the
    window in which, under the old wall-clock-before-lock scheme, a row could
    commit with a timestamp *behind* a cursor already handed to a client."""
    written = []
    lock = threading.Lock()

    def writer(n):
        for _ in range(15):
            bird_id = uuid.uuid4().hex[:12]
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO birds (id, coop_id, name, updated_at) VALUES (?, ?, 'r', ?)",
                    (bird_id, coop, now_iso()),
                )
                time.sleep(random.uniform(0, 0.01))  # hold the transaction open
            with lock:
                written.append(bird_id)

    seen, cursor = {}, ""
    threads = [threading.Thread(target=writer, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    while any(t.is_alive() for t in threads):
        rows, cursor = _pull_all(coop, cursor)
        seen.update({r["id"]: r for r in rows})
    for t in threads:
        t.join()
    rows, cursor = _pull_all(coop, cursor)  # one final pull, like the next poll
    seen.update({r["id"]: r for r in rows})

    missing = set(written) - set(seen)
    assert not missing, f"{len(missing)} committed rows were never delivered"
    assert len(written) == 60


def test_concurrent_writers_do_not_hit_database_is_locked(coop):
    errors = []

    def writer():
        try:
            for _ in range(25):
                with get_db() as conn:
                    conn.execute("INSERT INTO eggs (id, coop_id, count, updated_at) VALUES (?, ?, 1, ?)",
                                 (uuid.uuid4().hex[:12], coop, now_iso()))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=writer) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors


# ------------------------------------------------------------------ paging

def test_paging_returns_every_row_exactly_once_and_never_splits_a_transaction(client, admin, coop):
    items = [{"coop_id": coop, "name": f"P{i}"} for i in range(25)]
    client.post("/api/birds/bulk-create", json={"items": items}, headers=admin)  # 25 rows, one stamp
    client.post("/api/birds", json={"coop_id": coop, "name": "after"}, headers=admin)

    got, cursor, pages = [], "", 0
    while True:
        out = client.get("/api/sync/birds", params={"coop_id": coop, "since": cursor, "limit": 10}, headers=admin).json()
        pages += 1
        got += out["rows"]
        cursor = out["server_time"]
        if not out["has_more"]:
            break
        assert pages < 10
    ids = [r["id"] for r in got]
    assert len(ids) == len(set(ids)), "a row was delivered twice"
    assert {r["name"] for r in got} >= {f"P{i}" for i in range(25)} | {"after"}
    # the 25-row transaction came back whole in the first page, not cut at 10
    assert sum(1 for r in got[:25] if r["name"].startswith("P")) == 25


def test_unpaged_sync_still_returns_everything_for_old_clients(client, admin, coop):
    for i in range(3):
        client.post("/api/birds", json={"coop_id": coop, "name": f"o{i}"}, headers=admin)
    out = client.get("/api/sync/birds", params={"coop_id": coop}, headers=admin).json()
    assert len(out["rows"]) == 3 and out["has_more"] is False


@pytest.mark.parametrize("limit", [0, -1, 5001])
def test_sync_limit_is_validated(client, admin, coop, limit):
    assert client.get("/api/sync/birds", params={"coop_id": coop, "limit": limit}, headers=admin).status_code == 400


# ------------------------------------------------ merge / idempotency semantics

def test_edits_to_different_fields_both_survive(client, admin, coop):
    b = client.post("/api/birds", json={"coop_id": coop, "name": "A", "breed": "B0"}, headers=admin).json()
    client.put(f"/api/birds/{b['id']}", json={"name": "Renamed"}, headers=admin)      # device 1
    client.put(f"/api/birds/{b['id']}", json={"breed": "Orpington"}, headers=admin)   # device 2, stale for 'name'
    final = client.get(f"/api/birds?coop_id={coop}", headers=admin).json()
    bird = next(x for x in final if x["id"] == b["id"])
    assert (bird["name"], bird["breed"]) == ("Renamed", "Orpington")


def test_stale_create_does_not_resurrect_a_deleted_row(client, admin, coop):
    payload = {"id": "ghost-1", "coop_id": coop, "name": "Ghost"}
    client.post("/api/birds", json=payload, headers=admin)
    client.delete("/api/birds/ghost-1", headers=admin)
    client.post("/api/birds", json=payload, headers=admin)  # delayed retry of the original create
    assert all(b["id"] != "ghost-1" for b in client.get(f"/api/birds?coop_id={coop}", headers=admin).json())


def test_edit_after_delete_is_treated_as_intent_to_keep(client, admin, coop):
    b = client.post("/api/birds", json={"coop_id": coop, "name": "Phoenix"}, headers=admin).json()
    client.delete(f"/api/birds/{b['id']}", headers=admin)
    client.put(f"/api/birds/{b['id']}", json={"name": "Phoenix II"}, headers=admin)
    assert any(x["id"] == b["id"] for x in client.get(f"/api/birds?coop_id={coop}", headers=admin).json())


def test_bulk_create_retry_is_idempotent(client, admin, coop):
    items = [{"id": "bulk-a", "coop_id": coop, "name": "Orig"}]
    client.post("/api/birds/bulk-create", json={"items": items}, headers=admin)
    client.put("/api/birds/bulk-a", json={"name": "Edited"}, headers=admin)
    client.post("/api/birds/bulk-create", json={"items": items}, headers=admin)
    rows = client.get(f"/api/birds?coop_id={coop}", headers=admin).json()
    assert next(b for b in rows if b["id"] == "bulk-a")["name"] == "Edited"


def test_failed_bulk_create_leaves_nothing_behind(client, admin, coop):
    items = [{"id": "atomic-1", "coop_id": coop, "name": "ok"}, {"name": "no coop id"}]
    assert client.post("/api/birds/bulk-create", json={"items": items}, headers=admin).status_code == 400
    assert all(b["id"] != "atomic-1" for b in client.get(f"/api/birds?coop_id={coop}", headers=admin).json())


@pytest.mark.parametrize("bad_id", ["has space", "a/b", "x" * 65, 123])
def test_client_supplied_ids_are_validated(client, admin, coop, bad_id):
    r = client.post("/api/birds", json={"id": bad_id, "coop_id": coop, "name": "x"}, headers=admin)
    assert r.status_code == 400


def test_structured_values_are_stored_as_json_not_a_500(client, admin, coop):
    r = client.put(f"/api/coops/{coop}", json={"settings": {"bedding_areas": ["Run"]}}, headers=admin)
    assert r.status_code == 200
    assert '"Run"' in r.json()["settings"]


def test_bulk_delete_cascades_like_single_delete(client, admin, coop):
    h = client.post("/api/hatches", json={"coop_id": coop, "date_started": "2026-07-01"}, headers=admin).json()
    e = client.post("/api/hatch_eggs", json={"coop_id": coop, "hatch_id": h["id"], "position": 1}, headers=admin).json()
    client.post("/api/hatches/bulk-delete-items", json={"ids": [h["id"]]}, headers=admin)
    rows = client.get(f"/api/sync/hatch_eggs?coop_id={coop}", headers=admin).json()["rows"]
    assert next(r for r in rows if r["id"] == e["id"])["deleted_at"]


def test_deleting_a_bird_tombstones_its_logs_and_timeline(client, admin, coop):
    b = client.post("/api/birds", json={"coop_id": coop, "name": "Cascade"}, headers=admin).json()
    log = client.post("/api/bird_logs", json={"coop_id": coop, "bird_id": b["id"], "note": "n"}, headers=admin).json()
    ph = client.post("/api/bird_photos", json={"coop_id": coop, "bird_id": b["id"]}, headers=admin).json()
    client.delete(f"/api/birds/{b['id']}", headers=admin)
    for table, row in (("bird_logs", log), ("bird_photos", ph)):
        rows = client.get(f"/api/sync/{table}?coop_id={coop}", headers=admin).json()["rows"]
        assert next(r for r in rows if r["id"] == row["id"])["deleted_at"], table
