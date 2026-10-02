"""Read-only stats feed for Home Assistant, Grafana and friends."""
import secrets
import sqlite3
from datetime import date

from fastapi import APIRouter, HTTPException, Request

from .auth import require_admin
from .db import get_db, now_iso

router = APIRouter()

# ===========================================================================
# Integrations: a read-only stats feed for Home Assistant, Grafana, dashboards
#
# Authenticated with a long-lived API key rather than a session token, because
# a polling integration can't complete a login flow and shouldn't hold one.
# The key is read-only by construction: this endpoint runs SELECTs and there is
# no integration route that writes. Revoking regenerates the key, immediately
# invalidating anything still using the old one.
# ===========================================================================

def integration_key(create=False):
    if not create:
        with get_db(write=False) as conn:
            try:
                row = conn.execute("SELECT api_key FROM integration_config WHERE id = 1").fetchone()
            except sqlite3.OperationalError:  # table not created yet: no key has ever been generated
                return None
        return row["api_key"] if row and row["api_key"] else None
    with get_db() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS integration_config ("
            "id INTEGER PRIMARY KEY CHECK (id = 1), api_key TEXT, created_at TEXT)"
        )
        key = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO integration_config (id, api_key, created_at) VALUES (1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key, created_at = excluded.created_at",
            (key, now_iso()),
        )
        return key


def require_integration_key(request: Request):
    supplied = request.headers.get("x-api-key") or request.query_params.get("key")
    actual = integration_key()
    if not actual:
        raise HTTPException(status_code=503, detail="No integration key has been generated yet.")
    # Constant-time compare so a wrong key can't be discovered by timing.
    if not supplied or not secrets.compare_digest(str(supplied), str(actual)):
        raise HTTPException(status_code=401, detail="Invalid integration key")


@router.post("/api/integrations/key/rotate")
def integration_key_rotate(request: Request):
    require_admin(request)
    return {"api_key": integration_key(create=True)}


@router.get("/api/integrations/key")
def integration_key_get(request: Request):
    require_admin(request)
    return {"api_key": integration_key()}


@router.delete("/api/integrations/key")
def integration_key_delete(request: Request):
    require_admin(request)
    with get_db() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS integration_config (id INTEGER PRIMARY KEY CHECK (id = 1), api_key TEXT, created_at TEXT)")
        conn.execute("DELETE FROM integration_config WHERE id = 1")
    return {"ok": True}


@router.get("/api/integrations/stats")
def integration_stats(request: Request, coop_id: str = None):
    """Flat, poll-friendly JSON. Values are deliberately shallow and
    consistently named so a Home Assistant REST sensor can pull any of them
    with a one-line template and never see a null appear or vanish."""
    require_integration_key(request)
    today = date.today()
    month = today.strftime("%Y-%m")
    year = today.strftime("%Y")

    with get_db(write=False) as conn:
        if coop_id:
            coop = conn.execute("SELECT id, name FROM coops WHERE id = ? AND deleted_at IS NULL", (coop_id,)).fetchone()
        else:
            coop = conn.execute("SELECT id, name FROM coops WHERE deleted_at IS NULL ORDER BY created_date LIMIT 1").fetchone()
        if not coop:
            raise HTTPException(status_code=404, detail="No coop found")
        cid = coop["id"]

        def one(sql, params=()):
            r = conn.execute(sql, params).fetchone()
            return (r[0] if r and r[0] is not None else 0)

        eggs_today = one("SELECT SUM(count) FROM eggs WHERE coop_id=? AND date=? AND deleted_at IS NULL", (cid, today.isoformat()))
        eggs_month = one("SELECT SUM(count) FROM eggs WHERE coop_id=? AND substr(date,1,7)=? AND deleted_at IS NULL", (cid, month))
        eggs_year = one("SELECT SUM(count) FROM eggs WHERE coop_id=? AND substr(date,1,4)=? AND deleted_at IS NULL", (cid, year))
        eggs_all = one("SELECT SUM(count) FROM eggs WHERE coop_id=? AND deleted_at IS NULL", (cid,))

        birds_active = one("SELECT COUNT(*) FROM birds WHERE coop_id=? AND status='Active' AND deleted_at IS NULL", (cid,))
        layers = one("SELECT COUNT(*) FROM birds WHERE coop_id=? AND status='Active' AND type IN ('Layer','Dual Purpose') AND deleted_at IS NULL", (cid,))
        meat_birds = one("SELECT COUNT(*) FROM birds WHERE coop_id=? AND status='Active' AND type='Meat' AND deleted_at IS NULL", (cid,))

        spend_month = one("SELECT SUM(amount) FROM expenses WHERE coop_id=? AND substr(date,1,7)=? AND entry_type IS NOT 'income' AND deleted_at IS NULL", (cid, month))
        spend_year = one("SELECT SUM(amount) FROM expenses WHERE coop_id=? AND substr(date,1,4)=? AND entry_type IS NOT 'income' AND deleted_at IS NULL", (cid, year))
        income_year = one("SELECT SUM(amount) FROM expenses WHERE coop_id=? AND substr(date,1,4)=? AND entry_type='income' AND deleted_at IS NULL", (cid, year))

        meat_year = one("SELECT SUM(harvest_weight) FROM birds WHERE coop_id=? AND status='Processed' AND substr(harvest_date,1,4)=? AND deleted_at IS NULL", (cid, year))
        birds_processed_year = one("SELECT COUNT(*) FROM birds WHERE coop_id=? AND status='Processed' AND substr(harvest_date,1,4)=? AND deleted_at IS NULL", (cid, year))

        feed_open = one("SELECT COUNT(*) FROM supplies WHERE coop_id=? AND date_emptied IS NULL AND category IN ('Layer Feed','Meat Feed') AND deleted_at IS NULL", (cid,))
        feed_low = one("SELECT COUNT(*) FROM supplies WHERE coop_id=? AND date_emptied IS NULL AND status='1/4' AND category IN ('Layer Feed','Meat Feed') AND deleted_at IS NULL", (cid,))

        # Days since the most recent full clean-out of each bedding area, so a
        # dashboard can show "worst area" without replicating the thresholds.
        bedding = {}
        for r in conn.execute(
            "SELECT area, MAX(date) AS last FROM bedding WHERE coop_id=? AND LOWER(entry_type)='full clean-out' AND deleted_at IS NULL GROUP BY area",
            (cid,),
        ):
            try:
                bedding[r["area"]] = (today - date.fromisoformat(r["last"])).days
            except (TypeError, ValueError):
                pass

        active_hatches = one("SELECT COUNT(*) FROM hatches WHERE coop_id=? AND deleted_at IS NULL AND (status IS NULL OR status != 'Complete')", (cid,))

    return {
        "coop": {"id": cid, "name": coop["name"]},
        "generated_at": now_iso(),
        "eggs": {"today": int(eggs_today), "this_month": int(eggs_month), "this_year": int(eggs_year), "all_time": int(eggs_all),
                 "dozen_this_year": round(eggs_year / 12, 2)},
        "flock": {"active": int(birds_active), "layers": int(layers), "meat_birds": int(meat_birds),
                  "processed_this_year": int(birds_processed_year), "active_hatches": int(active_hatches)},
        "meat": {"lb_this_year": round(float(meat_year), 2)},
        "money": {"spent_this_month": round(float(spend_month), 2), "spent_this_year": round(float(spend_year), 2),
                  "income_this_year": round(float(income_year), 2),
                  "net_this_year": round(float(income_year) - float(spend_year), 2)},
        "feed": {"bags_open": int(feed_open), "bags_low": int(feed_low)},
        "bedding_days_since_cleanout": bedding,
    }
