"""Transaction semantics, and the schema/data-migration machinery."""
import sqlite3

import pytest

from coopledger import config, db, migrations
from coopledger.db import get_db, now_iso, on_commit


# --------------------------------------------------------------- transactions

def test_exception_rolls_the_transaction_back(coop):
    with pytest.raises(ZeroDivisionError):
        with get_db() as conn:
            conn.execute("INSERT INTO eggs (id, coop_id, count, updated_at) VALUES ('rb-1', ?, 1, ?)", (coop, now_iso()))
            1 / 0  # noqa: B018
    with get_db(write=False) as conn:
        assert conn.execute("SELECT 1 FROM eggs WHERE id = 'rb-1'").fetchone() is None


def test_nested_write_transaction_fails_fast_instead_of_deadlocking():
    with get_db():
        with pytest.raises(RuntimeError, match="nested write"):
            with get_db():
                pass


def test_a_read_transaction_may_run_inside_a_write():
    with get_db():
        with get_db(write=False) as conn:
            assert conn.execute("SELECT 1").fetchone()[0] == 1


def test_after_commit_callbacks_run_only_after_the_data_is_visible(coop):
    seen = []

    def check():
        with sqlite3.connect(config.DB_PATH) as other:  # a different connection, like a client's pull
            seen.append(other.execute("SELECT COUNT(*) FROM eggs WHERE id = 'ac-1'").fetchone()[0])

    with get_db() as conn:
        conn.execute("INSERT INTO eggs (id, coop_id, count, updated_at) VALUES ('ac-1', ?, 1, ?)", (coop, now_iso()))
        on_commit(check)
        assert seen == []  # not yet: still inside the transaction
    assert seen == [1]     # after commit, and it can see the row


def test_after_commit_callbacks_are_dropped_on_rollback():
    called = []
    with pytest.raises(RuntimeError):
        with get_db():
            on_commit(lambda: called.append(1))
            raise RuntimeError
    assert called == []


def test_a_failing_callback_cannot_fail_a_committed_request(capsys):
    with get_db():
        on_commit(lambda: 1 / 0)
    assert "after-commit callback failed" in capsys.readouterr().out


def test_on_commit_outside_a_transaction_runs_immediately():
    called = []
    on_commit(lambda: called.append(1))
    assert called == [1]


# ----------------------------------------------------------------- migrations

@pytest.fixture()
def scratch_db(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "scratch.db")
    return config.DB_PATH


def test_fresh_database_gets_the_full_schema(scratch_db):
    migrations.init_db()
    with sqlite3.connect(scratch_db) as c:
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"birds", "eggs", "coops", "sessions", "invite_codes", "sync_clock", "schema_migrations"} <= tables
        assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert c.execute("SELECT COUNT(*) FROM invite_codes WHERE role = 'admin'").fetchone()[0] == 1


def test_init_db_is_idempotent(scratch_db):
    migrations.init_db()
    with sqlite3.connect(scratch_db) as c:
        code = c.execute("SELECT invite_code FROM auth_settings").fetchone()[0]
    migrations.init_db()
    migrations.init_db()
    with sqlite3.connect(scratch_db) as c:
        assert c.execute("SELECT invite_code FROM auth_settings").fetchone()[0] == code  # never regenerated
        assert c.execute("SELECT COUNT(*) FROM invite_codes").fetchone()[0] == 1


def test_a_legacy_database_is_upgraded_in_place_without_losing_data(scratch_db):
    """A database from before sync support and multi-coop: no updated_at /
    deleted_at columns, no coop_id values, weights in kg."""
    with sqlite3.connect(scratch_db) as c:
        c.execute("CREATE TABLE birds (id TEXT PRIMARY KEY, name TEXT, coop_id TEXT)")
        c.execute("INSERT INTO birds (id, name) VALUES ('old-1', 'Veteran')")
        c.execute("CREATE TABLE supplies (id TEXT PRIMARY KEY, coop_id TEXT, quantity REAL, unit TEXT)")
        c.execute("INSERT INTO supplies (id, quantity, unit) VALUES ('s-1', 20, 'kg')")
    migrations.init_db()
    migrations.run_migrations()
    with sqlite3.connect(scratch_db) as c:
        c.row_factory = sqlite3.Row
        bird = c.execute("SELECT * FROM birds WHERE id = 'old-1'").fetchone()
        assert bird["name"] == "Veteran"
        assert bird["updated_at"]                       # backfilled, so incremental sync can see it
        assert bird["coop_id"]                           # adopted into a "Default Coop"
        assert c.execute("SELECT name FROM coops WHERE id = ?", (bird["coop_id"],)).fetchone()[0] == "Default Coop"
        sup = c.execute("SELECT * FROM supplies WHERE id = 's-1'").fetchone()
        assert sup["unit"] == "lb" and round(sup["quantity"], 1) == 44.1  # kg normalised to the canonical unit


def test_one_time_migrations_run_once_repeatable_ones_every_time(scratch_db):
    migrations.init_db()
    log = []
    ms = [
        migrations.Migration("m1_once", lambda: log.append("once"), repeatable=False),
        migrations.Migration("m2_repair", lambda: log.append("repair"), repeatable=True),
    ]
    assert migrations.run_migrations(ms) == ["m1_once", "m2_repair"]
    assert migrations.run_migrations(ms) == ["m2_repair"]
    assert log == ["once", "repair", "repair"]


def test_safety_backup_hook_only_fires_on_a_real_upgrade(scratch_db):
    migrations.init_db()
    fired = []
    first = [migrations.Migration("a", lambda: None, repeatable=False)]
    migrations.run_migrations(first, before_pending=fired.append)
    assert fired == []                      # first-ever run: nothing recorded yet, not an upgrade
    second = first + [migrations.Migration("b", lambda: None, repeatable=False)]
    migrations.run_migrations(second, before_pending=fired.append)
    assert fired == [["b"]]                 # a new one-time migration is pending -> back up first


def test_a_failing_migration_stops_the_run_and_is_not_recorded(scratch_db):
    migrations.init_db()

    def boom():
        raise RuntimeError("bad data")

    ms = [migrations.Migration("ok", lambda: None, False), migrations.Migration("bad", boom, False), migrations.Migration("after", lambda: None, False)]
    with pytest.raises(RuntimeError):
        migrations.run_migrations(ms)
    with sqlite3.connect(scratch_db) as c:
        recorded = {r[0] for r in c.execute("SELECT id FROM schema_migrations")}
    assert recorded == {"ok"}               # 'bad' will be retried next start; 'after' never ran


def test_migration_ids_are_unique_and_ordered():
    ids = [m.id for m in migrations.MIGRATIONS]
    assert len(ids) == len(set(ids)) and ids == sorted(ids)


def test_orphan_repair_syncs_outward(client, coop):
    with sqlite3.connect(config.DB_PATH) as c:
        c.execute("INSERT INTO hatches (id, coop_id, deleted_at, updated_at) VALUES ('o-h', ?, '2026-01-02T00:00:00+00:00', '2026-01-02T00:00:00+00:00')", (coop,))
        c.execute("INSERT INTO hatch_eggs (id, coop_id, hatch_id, updated_at) VALUES ('o-e', ?, 'o-h', '2026-01-01T00:00:00+00:00')", (coop,))
    migrations.migrate_repair_orphaned_hatch_eggs()
    with sqlite3.connect(config.DB_PATH) as c:
        deleted, updated = c.execute("SELECT deleted_at, updated_at FROM hatch_eggs WHERE id='o-e'").fetchone()
    assert deleted and updated > "2026-01-02T00:00:00+00:00"
    assert db.read_sync_cursor  # the cursor API is the thing devices pull the repair through
