"""Authentication: invite codes, sessions, roles, and login rate limiting.

Deliberately not a full user-account system: one shared, rotatable invite code
gates entry (like a WiFi password), and anyone who provides it picks their own
display name and gets a session token.
"""
import os
import secrets
import time

from fastapi import APIRouter, Body, HTTPException, Request

from .db import get_db, now_iso

router = APIRouter()

INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

def generate_invite_code(length=8):
    return "".join(secrets.choice(INVITE_CODE_ALPHABET) for _ in range(length))


def extract_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return request.query_params.get("token")  # EventSource can't send custom headers, so SSE relies on this


def require_auth(request: Request) -> str:
    token = extract_token(request)
    if token:
        with get_db() as conn:
            row = conn.execute("SELECT name FROM sessions WHERE token = ?", (token,)).fetchone()
            if row:
                conn.execute("UPDATE sessions SET last_activity = ? WHERE token = ?", (now_iso(), token))
                return row["name"]
    raise HTTPException(401, "Not logged in")


def require_admin(request: Request) -> str:
    """Like require_auth, but for endpoints that must stay admin-only even
    for reads -- viewing or managing invite codes, for instance, where a
    read-only session simply reading the admin code would let it escalate
    its own access. The middleware's write-blocking doesn't cover this
    case since a GET is a read, not a write."""
    token = extract_token(request)
    if token:
        with get_db() as conn:
            row = conn.execute("SELECT name, role FROM sessions WHERE token = ?", (token,)).fetchone()
            if row:
                if row["role"] != "admin":
                    raise HTTPException(403, "Admin access required")
                conn.execute("UPDATE sessions SET last_activity = ? WHERE token = ?", (now_iso(), token))
                return row["name"]
    raise HTTPException(401, "Not logged in")


failed_login_attempts: dict[str, list[float]] = {}
MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCKOUT_SECONDS = 15 * 60


def client_ip(request: Request) -> str:
    # Behind Cloudflare Tunnel, request.client.host is the tunnel's own local
    # connection, not the real visitor -- every request would look like it
    # came from the same place, making per-IP limiting meaningless (one
    # person's failed attempts would lock out everyone). Cloudflare forwards
    # the real IP via this header, and Cloudflare itself sets/overwrites it,
    # so it can be trusted -- but only when something's actually terminating
    # traffic in front of this process. Exposed directly to the internet,
    # these same headers are just arbitrary client input: anyone could send
    # a different fake IP on every single request and make the login lockout
    # below count nothing at all. Only trust them when explicitly told to.
    if os.environ.get("TRUST_PROXY_HEADERS") == "1":
        cf_ip = request.headers.get("cf-connecting-ip")
        if cf_ip:
            return cf_ip
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_login_rate_limit(ip: str):
    now = time.time()
    attempts = [t for t in failed_login_attempts.get(ip, []) if now - t < LOGIN_LOCKOUT_SECONDS]
    failed_login_attempts[ip] = attempts
    if len(attempts) >= MAX_LOGIN_ATTEMPTS:
        raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")


def record_failed_login(ip: str, name: str = "", code: str = ""):
    failed_login_attempts.setdefault(ip, []).append(time.time())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO failed_logins (name_attempted, code_attempted, ip, attempted_at) VALUES (?, ?, ?, ?)",
            (name, code, ip, now_iso()),
        )


@router.post("/api/auth/login")
def login(payload: dict = Body(...), request: Request = None):
    ip = client_ip(request)
    check_login_rate_limit(ip)
    name = (payload.get("name") or "").strip()
    code = (payload.get("code") or "").strip()
    if not name:
        raise HTTPException(400, "Name is required")
    with get_db(write=False) as conn:
        row = conn.execute(
            "SELECT id, role FROM invite_codes WHERE UPPER(code) = UPPER(?) AND revoked_at IS NULL",
            (code,),
        ).fetchone()
    if not row:
        record_failed_login(ip, name, code)
        raise HTTPException(401, "Invalid invite code")
    role = row["role"]
    token = secrets.token_urlsafe(32)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, name, created_at, role, invite_code_id) VALUES (?, ?, ?, ?, ?)",
            (token, name, now_iso(), role, row["id"]),
        )
    return {"token": token, "name": name, "role": role}


@router.get("/api/auth/me")
def auth_me(request: Request):
    token = extract_token(request)
    with get_db(write=False) as conn:
        row = conn.execute("SELECT name, role FROM sessions WHERE token = ?", (token,)).fetchone()
    if not row:
        raise HTTPException(401, "Not logged in")
    return {"name": row["name"], "role": row["role"]}


@router.post("/api/auth/logout")
def logout(request: Request):
    token = extract_token(request)
    if token:
        with get_db() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return {"ok": True}


@router.get("/api/auth/invite-code")
def get_invite_code(request: Request):
    require_admin(request)
    with get_db(write=False) as conn:
        row = conn.execute("SELECT invite_code, auto_rotate_days FROM auth_settings WHERE id = 1").fetchone()
        return {"invite_code": row["invite_code"], "auto_rotate_days": row["auto_rotate_days"]}


def rotate_primary_code(conn) -> str:
    """Replace the primary admin invite code. Both tables must change
    together: auth_settings holds the code shown in Settings, but login checks
    invite_codes, so updating only one leaves a code that is displayed and
    doesn't work (or one that works and isn't displayed)."""
    new_code = generate_invite_code()
    old_code = conn.execute("SELECT invite_code FROM auth_settings WHERE id = 1").fetchone()["invite_code"]
    conn.execute("UPDATE auth_settings SET invite_code = ?, rotated_at = ? WHERE id = 1", (new_code, now_iso()))
    conn.execute("UPDATE invite_codes SET code = ? WHERE code = ?", (new_code, old_code))
    return new_code


@router.post("/api/auth/invite-code/rotate")
def rotate_invite_code(request: Request):
    require_admin(request)
    with get_db() as conn:
        return {"invite_code": rotate_primary_code(conn)}


@router.post("/api/auth/invite-code/auto-rotate")
def set_auto_rotate(payload: dict = Body(...), request: Request = None):
    require_admin(request)
    days = payload.get("days")  # null/None disables it
    with get_db() as conn:
        conn.execute("UPDATE auth_settings SET auto_rotate_days = ? WHERE id = 1", (days,))
    return {"auto_rotate_days": days}


@router.get("/api/auth/sessions")
def list_sessions(request: Request):
    require_admin(request)
    with get_db(write=False) as conn:
        rows = conn.execute("SELECT id, name, created_at, last_activity, role FROM sessions ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


@router.get("/api/auth/invite-codes")
def list_invite_codes(request: Request):
    require_admin(request)
    with get_db(write=False) as conn:
        rows = conn.execute("SELECT id, code, role, label, created_at, revoked_at FROM invite_codes ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


@router.post("/api/auth/invite-codes")
def create_invite_code(payload: dict = Body(...), request: Request = None):
    require_admin(request)
    role = payload.get("role")
    if role not in ("admin", "readonly"):
        raise HTTPException(400, "role must be one of: admin, readonly")
    label = (payload.get("label") or "").strip() or None
    code = generate_invite_code()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO invite_codes (code, role, label, created_at) VALUES (?, ?, ?, ?)",
            (code, role, label, now_iso()),
        )
    return {"code": code, "role": role, "label": label}


@router.delete("/api/auth/invite-codes/{code_id}")
def revoke_invite_code(code_id: int, request: Request):
    require_admin(request)
    with get_db() as conn:
        row = conn.execute("SELECT code, role FROM invite_codes WHERE id = ?", (code_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Invite code not found")
        admin_count = conn.execute(
            "SELECT COUNT(*) as n FROM invite_codes WHERE role = 'admin' AND revoked_at IS NULL"
        ).fetchone()["n"]
        if row["role"] == "admin" and admin_count <= 1:
            # Never allow revoking the last admin code -- that would
            # permanently lock everyone out with no way back in short of
            # editing the database directly.
            raise HTTPException(400, "Can't revoke the last remaining admin code")
        conn.execute("UPDATE invite_codes SET revoked_at = ? WHERE id = ?", (now_iso(), code_id))
        # Any sessions already logged in under this specific code are cut
        # off immediately too, not just future login attempts -- but only
        # those, not sessions from any other still-valid code (including
        # the admin's own session doing this revoke).
        conn.execute("DELETE FROM sessions WHERE invite_code_id = ?", (code_id,))
    return {"revoked": True}


@router.delete("/api/auth/invite-codes/{code_id}/permanent")
def delete_invite_code_permanently(code_id: int, request: Request):
    require_admin(request)
    with get_db() as conn:
        row = conn.execute("SELECT revoked_at FROM invite_codes WHERE id = ?", (code_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Invite code not found")
        if row["revoked_at"] is None:
            # Requires revoking first -- a deliberate two-step process for
            # something this sensitive, so an active code can't be
            # permanently removed by a single misclick.
            raise HTTPException(400, "Revoke this code before deleting it permanently")
        conn.execute("DELETE FROM invite_codes WHERE id = ?", (code_id,))
    return {"deleted": True}


@router.get("/api/auth/failed-logins")
def list_failed_logins(request: Request):
    # Admin-only, not just logged-in: code_attempted routinely contains a
    # VALID code someone typed alongside a mistyped name, or a code one
    # character off from a real one. Letting a read-only session read this
    # list would hand it exactly the material needed to escalate itself.
    require_admin(request)
    with get_db(write=False) as conn:
        rows = conn.execute(
            "SELECT id, name_attempted, code_attempted, ip, attempted_at FROM failed_logins ORDER BY attempted_at DESC LIMIT 100"
        ).fetchall()
        return [dict(r) for r in rows]


@router.delete("/api/auth/sessions/{session_id}")
def revoke_session(session_id: int, request: Request):
    # The middleware already blocks readonly DELETEs, but revoking someone
    # else's session is an admin action -- enforce that here too rather
    # than relying on the write-gate alone (defense in depth, and it stays
    # correct even if a future role gains some write access).
    require_admin(request)
    with get_db() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    return {"ok": True}
