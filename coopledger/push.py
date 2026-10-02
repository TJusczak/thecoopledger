"""Web Push reminders (opt-in, per category)."""
import base64
import json
import sqlite3
import uuid
from datetime import date

from fastapi import APIRouter, HTTPException, Request

from .auth import require_auth
from .db import get_db, now_iso
from .schema import DEFAULT_SETTINGS

router = APIRouter()

# ===========================================================================
# Web Push notifications
#
# Reminders that reach the phone with the app closed: bedding due for a change,
# a hatch hitting a milestone, supplies running low. Everything is opt-in --
# nothing is sent until the browser grants permission AND the person turns on
# the individual categories.
#
# Delivery is standard Web Push, so the server needs outbound HTTPS to the
# browser vendor's push endpoint (FCM for Chrome/Android). Self-hosters behind
# a firewall that blocks egress simply won't see notifications; the rest of the
# app is unaffected.
# ===========================================================================

PUSH_CATEGORIES = ("bedding", "hatch", "supplies")


def ensure_push_tables(conn):
    """Creates the push tables, and migrates them if an older build already made
    them a different shape.

    Push tables are created here rather than declared in SCHEMA on purpose:
    anything in SCHEMA is served by the generic /api/{resource} route, which
    would hand every device's push endpoint and auth secret to any logged-in
    user. These are server-internal and must never sync to clients.

    CREATE TABLE IF NOT EXISTS is not a migration -- it does nothing at all when
    the table already exists. Earlier builds created push_subscriptions through
    SCHEMA, which only ever adds updated_at/deleted_at, so those installs have a
    table with no created_at column and every INSERT fails. Missing columns are
    therefore added explicitly, the same way init_db migrates the main schema.
    """
    wanted = {
        "push_subscriptions": {
            "endpoint": "TEXT", "p256dh": "TEXT", "auth": "TEXT", "user_agent": "TEXT",
            "notify_bedding": "INTEGER DEFAULT 1", "notify_hatch": "INTEGER DEFAULT 1",
            "notify_supplies": "INTEGER DEFAULT 1", "last_error": "TEXT",
            "failure_count": "INTEGER DEFAULT 0", "created_at": "TEXT", "updated_at": "TEXT",
        },
        "push_sent_log": {
            "subject_key": "TEXT", "sent_on": "TEXT", "created_at": "TEXT", "updated_at": "TEXT",
        },
    }
    for table, cols in wanted.items():
        col_defs = ", ".join(f'"{c}" {t}' for c, t in cols.items())
        conn.execute(f"CREATE TABLE IF NOT EXISTS {table} (id TEXT PRIMARY KEY, {col_defs})")
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for c, t in cols.items():
            if c not in existing:
                conn.execute(f'ALTER TABLE {table} ADD COLUMN "{c}" {t}')

    # One row per device. UNIQUE can't be bolted on with ALTER, so a unique
    # index does the same job -- after clearing any duplicates an older build
    # may have left, since it had no constraint at all.
    conn.execute(
        "DELETE FROM push_subscriptions WHERE rowid NOT IN "
        "(SELECT MAX(rowid) FROM push_subscriptions GROUP BY endpoint)"
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_push_sent ON push_sent_log(subject_key, sent_on)")


def push_config():
    """Returns the VAPID keypair, generating and storing it on first use.

    The keypair identifies this server to the push services. It must stay
    stable: regenerating invalidates every existing subscription, so it's
    created once and then read back forever after.
    """
    def read(conn):
        try:
            row = conn.execute("SELECT private_pem, public_key FROM push_config WHERE id = 1").fetchone()
        except sqlite3.OperationalError:
            return None
        return (row["private_pem"], row["public_key"]) if row else None

    with get_db(write=False) as conn:  # the common case: no write lock for a read
        found = read(conn)
    if found:
        return found
    try:
        from py_vapid import Vapid02
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        return None, None
    with get_db() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS push_config (id INTEGER PRIMARY KEY CHECK (id = 1), "
            "private_pem TEXT NOT NULL, public_key TEXT NOT NULL, created_at TEXT)"
        )
        found = read(conn)  # re-check under the write lock: two first-time callers must not mint two keypairs
        if found:
            return found
        v = Vapid02()
        v.generate_keys()
        private_pem = v.private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode()
        raw_pub = v.public_key.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        public_key = base64.urlsafe_b64encode(raw_pub).decode().rstrip("=")
        conn.execute(
            "INSERT INTO push_config (id, private_pem, public_key, created_at) VALUES (1, ?, ?, ?)",
            (private_pem, public_key, now_iso()),
        )
        return private_pem, public_key


@router.get("/api/push/public-key")
def push_public_key(request: Request):
    require_auth(request)
    _, public_key = push_config()
    if not public_key:
        raise HTTPException(status_code=503, detail="Push is unavailable: the pywebpush package is not installed on the server.")
    return {"public_key": public_key}


@router.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    require_auth(request)
    body = await request.json()
    sub = body.get("subscription") or {}
    endpoint = sub.get("endpoint")
    keys = sub.get("keys") or {}
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise HTTPException(status_code=400, detail="Incomplete push subscription")
    prefs = body.get("prefs") or {}
    now = now_iso()
    with get_db() as conn:
        ensure_push_tables(conn)
        existing = conn.execute("SELECT id FROM push_subscriptions WHERE endpoint = ?", (endpoint,)).fetchone()
        fields = {
            "endpoint": endpoint,
            "p256dh": keys["p256dh"],
            "auth": keys["auth"],
            "user_agent": (request.headers.get("user-agent") or "")[:300],
            "failure_count": 0,
            "last_error": None,
            "updated_at": now,
        }
        for cat in PUSH_CATEGORIES:
            fields[f"notify_{cat}"] = 1 if prefs.get(cat, True) else 0
        if existing:
            sets = ", ".join(f'"{k}" = ?' for k in fields)
            conn.execute(f"UPDATE push_subscriptions SET {sets} WHERE id = ?", (*fields.values(), existing["id"]))
            sub_id = existing["id"]
        else:
            sub_id = uuid.uuid4().hex[:12]
            fields["id"] = sub_id
            fields["created_at"] = now
            cols = ", ".join(f'"{k}"' for k in fields)
            marks = ", ".join("?" for _ in fields)
            conn.execute(f"INSERT INTO push_subscriptions ({cols}) VALUES ({marks})", tuple(fields.values()))
    return {"ok": True, "id": sub_id}


@router.post("/api/push/unsubscribe")
async def push_unsubscribe(request: Request):
    require_auth(request)
    body = await request.json()
    endpoint = body.get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=400, detail="endpoint required")
    with get_db() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    return {"ok": True}


def send_push(sub_row, title, body, tag, url="/"):
    """Sends one notification. Returns True if it was accepted.

    A 404 or 410 means the browser has permanently discarded the subscription
    (app uninstalled, permission revoked), so the row is deleted rather than
    retried forever. Other failures are counted, and a subscription that keeps
    failing is dropped so a dead endpoint can't slow the hourly sweep.
    """
    private_pem, _ = push_config()
    if not private_pem:
        return False
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        return False
    payload = json.dumps({"title": title, "body": body, "tag": tag, "url": url})
    try:
        webpush(
            subscription_info={
                "endpoint": sub_row["endpoint"],
                "keys": {"p256dh": sub_row["p256dh"], "auth": sub_row["auth"]},
            },
            data=payload,
            vapid_private_key=private_pem,
            vapid_claims={"sub": "mailto:admin@thecoopledger.local"},
            timeout=10,
        )
        return True
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        with get_db() as conn:
            if status in (404, 410):
                conn.execute("DELETE FROM push_subscriptions WHERE id = ?", (sub_row["id"],))
            else:
                count = (sub_row["failure_count"] or 0) + 1
                if count >= 10:
                    conn.execute("DELETE FROM push_subscriptions WHERE id = ?", (sub_row["id"],))
                else:
                    conn.execute(
                        "UPDATE push_subscriptions SET failure_count = ?, last_error = ? WHERE id = ?",
                        (count, str(e)[:300], sub_row["id"]),
                    )
            return False
    except Exception:
        return False


def notify(category, title, body, subject_key, url="/"):
    """Sends to every device opted in to `category`, at most once per day for
    a given subject_key. The dedupe matters because the sweep runs hourly --
    without it "Coop Floor is due for a clean-out" would fire 24 times a day."""
    today = date.today().isoformat()
    with get_db(write=False) as conn:
        already = conn.execute(
            "SELECT 1 FROM push_sent_log WHERE subject_key = ? AND sent_on = ?", (subject_key, today)
        ).fetchone()
        if already:
            return 0
        if category not in PUSH_CATEGORIES:
            raise ValueError(f"unknown push category: {category}")
        subs = conn.execute(
            f"SELECT * FROM push_subscriptions WHERE notify_{category} = 1"
        ).fetchall()
    if not subs:
        return 0
    sent = sum(1 for s in subs if send_push(s, title, body, tag=subject_key, url=url))
    if sent:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO push_sent_log (id, subject_key, sent_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (uuid.uuid4().hex[:12], subject_key, today, now_iso(), now_iso()),
            )
            conn.execute("DELETE FROM push_sent_log WHERE sent_on < date('now', '-14 day')")
        return sent


@router.post("/api/push/test")
def push_test(request: Request):
    require_auth(request)
    with get_db(write=False) as conn:
        subs = conn.execute("SELECT * FROM push_subscriptions").fetchall()
    if not subs:
        raise HTTPException(status_code=400, detail="No devices are subscribed yet.")
    sent = sum(1 for s in subs if send_push(s, "The Coop Ledger", "Notifications are working.", tag="test"))
    return {"ok": True, "sent": sent, "devices": len(subs)}


def push_reminder_sweep():
    """Hourly check for anything worth a nudge. Each subject dedupes to once a
    day, so this can run every hour without becoming a nuisance.

    Reads the same per-coop settings the app does (`bedding_areas`,
    `bedding_thresholds`), falling back to the app's own defaults, so a coop
    that never customised them gets the same reminders the UI would show.

    Read-only on purpose: notify() does its own writes, and a write
    transaction held open across network calls would block every request."""
    today = date.today()
    with get_db(write=False) as conn:
        coops = conn.execute("SELECT id, name, settings FROM coops WHERE deleted_at IS NULL").fetchall()
    for coop in coops:
        try:
            _sweep_one_coop(coop, today)
        except Exception as e:  # one coop's bad data must not silence everyone else's reminders
            print(f"Reminder sweep failed for coop {coop['id']}: {e}")


def _sweep_one_coop(coop, today):
    try:
        settings = json.loads(coop["settings"] or "{}")
    except (TypeError, ValueError):
        settings = {}
    thresholds = settings.get("bedding_thresholds") or DEFAULT_SETTINGS["bedding_thresholds"]
    areas = settings.get("bedding_areas") or list(thresholds)
    with get_db(write=False) as conn:
        # --- Bedding: how long since the last full clean-out of each area
        for area in areas:
            t = thresholds.get(area) or {}
            danger = int(t.get("danger") or 180)
            last = conn.execute(
                "SELECT date FROM bedding WHERE coop_id = ? AND area = ? "
                "AND LOWER(entry_type) = 'full clean-out' AND deleted_at IS NULL ORDER BY date DESC LIMIT 1",
                (coop["id"], area),
            ).fetchone()
            if not last or not last["date"]:
                continue  # never cleaned: no baseline to measure against
            try:
                days = (today - date.fromisoformat(last["date"])).days
            except ValueError:
                continue
            if days >= danger:
                over = days - danger
                notify(
                    "bedding",
                    f"{area} needs a clean-out",
                    f"It has been {days} days" + (f", {over} past due" if over > 0 else "") + f" in {coop['name']}.",
                    subject_key=f"bedding:{coop['id']}:{area}",
                )

        # --- Hatching: lockdown (day 18) and hatch day (day 21)
        hatches = conn.execute(
            "SELECT id, breed, date_started FROM hatches WHERE coop_id = ? AND deleted_at IS NULL "
            "AND (status IS NULL OR status != 'Complete')",
            (coop["id"],),
        ).fetchall()
        for h in hatches:
            if not h["date_started"]:
                continue
            try:
                day = (today - date.fromisoformat(h["date_started"])).days
            except ValueError:
                continue
            label = h["breed"] or "Clutch"
            if day == 18:
                notify("hatch", f"{label}: lockdown day",
                       "Day 18 -- stop turning and raise the humidity.",
                       subject_key=f"hatch:lockdown:{h['id']}")
            elif day == 21:
                notify("hatch", f"{label}: hatch day",
                       "Day 21 -- chicks are due today.",
                       subject_key=f"hatch:due:{h['id']}")

        # --- Supplies: feed bags that are nearly gone
        low = conn.execute(
            "SELECT COUNT(*) AS n FROM supplies WHERE coop_id = ? AND deleted_at IS NULL "
            "AND date_emptied IS NULL AND status = '1/4' AND category IN ('Layer Feed', 'Meat Feed')",
            (coop["id"],),
        ).fetchone()
        if low and low["n"]:
            notify("supplies", "Feed running low",
                   f"{low['n']} bag(s) down to a quarter in {coop['name']}.",
                   subject_key=f"supplies:{coop['id']}:{today.isoformat()}")
