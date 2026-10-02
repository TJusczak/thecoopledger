"""SQLite access: connections, transactions, and the sync clock.

Every request opens its own short-lived connection through get_db(). The
interesting part is the *sync clock*, which exists to make incremental sync
(`GET /api/sync/<resource>?since=<cursor>`) provably lossless:

* Write transactions start with BEGIN IMMEDIATE, so SQLite's single writer
  lock is held *before* any timestamp is chosen.
* The timestamp for the whole transaction is then drawn from a persisted,
  strictly increasing clock (`sync_clock`), inside that lock. So commit order
  == timestamp order, even across processes, and even if the wall clock steps
  backwards (NTP, a VM resume, a dead CMOS battery).
* Readers take the clock's committed value inside their own snapshot and hand
  it to clients as the next cursor. Everything committed is <= that value;
  anything still in flight will be stamped strictly greater. Nothing can be
  skipped.

Previously `updated_at` was taken from the wall clock *before* the write lock
was acquired, so a slow transaction could commit a row stamped earlier than a
cursor a client had already been given -- that row was then invisible to that
client forever.
"""
import contextvars
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from . import config

TS_FORMAT = "%Y-%m-%dT%H:%M:%S.%f+00:00"

# The stamp for the write transaction running in this context, if any. now_iso()
# returns it so every row touched in one transaction shares one timestamp and
# no call site needs to know the clock exists.
_txn_ts: contextvars.ContextVar[str | None] = contextvars.ContextVar("txn_ts", default=None)
_after_commit: contextvars.ContextVar[list | None] = contextvars.ContextVar("after_commit", default=None)


def wall_clock_iso() -> str:
    return datetime.now(timezone.utc).strftime(TS_FORMAT)


def now_iso() -> str:
    """The current write transaction's stamp, or the wall clock outside one."""
    return _txn_ts.get() or wall_clock_iso()


def in_write_transaction() -> bool:
    return _txn_ts.get() is not None


def on_commit(fn) -> None:
    """Run `fn` after the current transaction commits (immediately if there
    isn't one). Used for SSE nudges: telling clients to pull *before* the
    commit means they can pull, see nothing new, and then sit on a stale view
    until the next poll."""
    pending = _after_commit.get()
    if pending is None:
        fn()
    else:
        pending.append(fn)


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, TS_FORMAT).replace(tzinfo=timezone.utc)


def _advance_clock(conn: sqlite3.Connection) -> str:
    """Next strictly-increasing stamp. Must be called inside BEGIN IMMEDIATE."""
    try:
        row = conn.execute("SELECT last_ts FROM sync_clock WHERE id = 1").fetchone()
    except sqlite3.OperationalError:  # first ever write on a fresh/old database
        conn.execute("CREATE TABLE IF NOT EXISTS sync_clock (id INTEGER PRIMARY KEY CHECK (id = 1), last_ts TEXT NOT NULL)")
        row = None
    candidate = datetime.now(timezone.utc)
    if row and row["last_ts"]:
        try:
            floor = _parse(row["last_ts"]) + timedelta(microseconds=1)
            if floor > candidate:
                candidate = floor
        except ValueError:
            pass  # unparseable legacy value: the wall clock is the best we have
    ts = candidate.strftime(TS_FORMAT)
    if row:
        conn.execute("UPDATE sync_clock SET last_ts = ? WHERE id = 1", (ts,))
    else:
        conn.execute("INSERT INTO sync_clock (id, last_ts) VALUES (1, ?)", (ts,))
    return ts


def read_sync_cursor(conn: sqlite3.Connection) -> str:
    """The safe `since` value for a client that has just read through `conn`.
    Call inside the same read transaction that fetched the rows."""
    try:
        row = conn.execute("SELECT last_ts FROM sync_clock WHERE id = 1").fetchone()
    except sqlite3.OperationalError:
        row = None
    return row["last_ts"] if row and row["last_ts"] else wall_clock_iso()


@contextmanager
def get_db(write: bool = True):
    """A connection inside one transaction: committed on success, rolled back
    on any exception.

    write=True (the default, so a forgotten flag fails safe) takes the write
    lock immediately and stamps the transaction. Pass write=False for pure
    reads: a deferred read transaction gives a consistent snapshot across
    several SELECTs and never blocks, or is blocked by, a writer (WAL).
    """
    if write and in_write_transaction():
        # A second writer connection inside a write transaction would wait on
        # the lock its own caller is holding -- a guaranteed 30 s stall, then
        # "database is locked". Fail loudly instead; it is always a code bug.
        raise RuntimeError("nested write transaction: restructure so the inner write happens after the outer block")
    conn = sqlite3.connect(config.DB_PATH, timeout=30, isolation_level=None)  # we manage BEGIN/COMMIT ourselves
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    ts_token = None
    cb_token = None
    callbacks: list = []
    try:
        if write:
            conn.execute("BEGIN IMMEDIATE")
            ts_token = _txn_ts.set(_advance_clock(conn))
            cb_token = _after_commit.set(callbacks)
        else:
            conn.execute("BEGIN")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        callbacks.clear()  # never announce a change that didn't happen
        raise
    finally:
        if ts_token is not None:
            _txn_ts.reset(ts_token)
        if cb_token is not None:
            _after_commit.reset(cb_token)
        conn.close()
    for fn in callbacks:
        try:
            fn()
        except Exception as e:  # a failed nudge must never fail a request that already committed
            print(f"after-commit callback failed: {e}")
