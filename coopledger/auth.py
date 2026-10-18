"""Authentication: user accounts, sessions, roles, and login rate limiting.

People sign in with a username and password (see users.py for account management and
passwords.py for how passwords are stored) and get a session token. Servers that existed
before accounts also still accept the shared invite codes they were using, until an admin
turns that off -- upgrading must not lock anyone out.

Session tokens are random 256-bit values handed to the client once. Only their SHA-256 is
stored, so a copy of the database (or a backup) cannot be turned into working logins.
"""
import hashlib
import os
import secrets
import time

from fastapi import APIRouter, Body, HTTPException, Request

from . import config, passwords
from .db import get_db, now_iso
from .settings import get_setting

router = APIRouter()

INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

ROLES = ("admin", "member", "readonly")


def generate_invite_code(length=8):
    return "".join(secrets.choice(INVITE_CODE_ALPHABET) for _ in range(length))


# ------------------------------------------------------------------ tokens & sessions

def hash_token(token: str) -> str:
    """What is stored for a session token. A fast hash is right here (unlike for passwords):
    the token is 256 random bits, so there is nothing to guess."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_session(conn, *, name: str, role: str, user_id: str | None = None, invite_code_id: int | None = None) -> str:
    """Creates a session and returns the raw token -- the only time it exists in the clear."""
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token, name, created_at, last_activity, role, invite_code_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (hash_token(token), name, now_iso(), now_iso(), role, invite_code_id, user_id),
    )
    return token


SESSION_SQL = """
    SELECT s.id, s.name, s.role, s.user_id, s.last_activity, u.username, u.must_change_password, u.disabled_at
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
"""


def lookup_session(conn, token: str | None):
    """The session row for a raw token, or None. A session whose account has been disabled
    is not a session (disabling also deletes them; this is the belt to those braces)."""
    if not token:
        return None
    row = conn.execute(SESSION_SQL, (hash_token(token),)).fetchone()
    if row and row["disabled_at"]:
        return None
    return row


def extract_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return request.query_params.get("token")  # EventSource can't send custom headers, so SSE relies on this


def require_session(request: Request):
    """The caller's session row (id, name, role, user_id, username, must_change_password).
    Touches last_activity. 401 if there is no valid session."""
    token = extract_token(request)
    if token:
        with get_db() as conn:
            row = lookup_session(conn, token)
            if row:
                conn.execute("UPDATE sessions SET last_activity = ? WHERE id = ?", (now_iso(), row["id"]))
                return row
    raise HTTPException(401, "Not logged in")


def require_auth(request: Request) -> str:
    return require_session(request)["name"]


def require_admin_session(request: Request):
    """The session row of a signed-in admin (403 for anyone else)."""
    row = require_session(request)
    if row["role"] != "admin":
        raise HTTPException(403, "Admin access required")
    return row


def require_admin(request: Request) -> str:
    """Like require_auth, but for endpoints that must stay admin-only even for reads -- user
    management, server settings, backups -- where a read-only or member session simply reading
    them would be an escalation. The middleware's write-blocking doesn't cover this since a GET
    is a read, not a write."""
    return require_admin_session(request)["name"]


# ------------------------------------------------------------------ rate limiting

failed_login_attempts: dict[str, list[float]] = {}      # by client IP
failed_username_attempts: dict[str, list[float]] = {}   # by username, whoever is asking
MAX_LOGIN_ATTEMPTS = 5
MAX_USERNAME_ATTEMPTS = 20   # a backstop against many IPs hammering one account; high enough that
                             # one attacker can't trivially lock the real owner out
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


def _recent(bucket: dict, key: str) -> list[float]:
    now = time.time()
    kept = [t for t in bucket.get(key, []) if now - t < LOGIN_LOCKOUT_SECONDS]
    bucket[key] = kept
    return kept


def check_login_rate_limit(ip: str, username: str = ""):
    if len(_recent(failed_login_attempts, ip)) >= MAX_LOGIN_ATTEMPTS:
        raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")
    if username and len(_recent(failed_username_attempts, username.lower())) >= MAX_USERNAME_ATTEMPTS:
        raise HTTPException(429, "Too many failed attempts for that account. Try again in a few minutes.")


def record_failed_login(ip: str, name: str = "", code: str = ""):
    """Remembers a failed attempt. `code` is only ever a legacy invite code -- a password is NEVER
    recorded, here or anywhere else (the Failed logins list is shown to admins)."""
    failed_login_attempts.setdefault(ip, []).append(time.time())
    if name:
        failed_username_attempts.setdefault(name.lower(), []).append(time.time())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO failed_logins (name_attempted, code_attempted, ip, attempted_at) VALUES (?, ?, ?, ?)",
            (name[:80], code, ip, now_iso()),
        )


# ------------------------------------------------------------------ login / me / logout

GENERIC_LOGIN_FAILURE = "Invalid username or password."


@router.post("/api/auth/login")
def login(payload: dict = Body(...), request: Request = None):
    ip = client_ip(request)
    if "code" in payload and "password" not in payload and "username" not in payload:
        return _login_with_invite_code(payload, ip)
    return _login_with_password(payload, ip)


def _login_with_password(payload: dict, ip: str):
    username = str(payload.get("username") or "").strip()
    password = payload.get("password")
    if not username or not isinstance(password, str) or not password:
        raise HTTPException(400, "Enter your username and password.")
    check_login_rate_limit(ip, username)

    with get_db(write=False) as conn:
        user = conn.execute(
            "SELECT id, username, display_name, password_hash, role, must_change_password, disabled_at FROM users WHERE username = ? COLLATE NOCASE",
            (username,),
        ).fetchone()
    if user:
        ok = passwords.verify_password(password, user["password_hash"])
    else:
        passwords.burn_a_verification()   # same time as a real check: don't reveal which usernames exist
        ok = False
    if not ok or user["disabled_at"]:
        record_failed_login(ip, username)
        raise HTTPException(401, GENERIC_LOGIN_FAILURE)

    with get_db() as conn:
        if passwords.needs_rehash(user["password_hash"]):
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (passwords.hash_password(password), user["id"]))
        conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_iso(), user["id"]))
        token = new_session(conn, name=user["display_name"], role=user["role"], user_id=user["id"])
    return {
        "token": token, "name": user["display_name"], "username": user["username"], "role": user["role"],
        "must_change_password": bool(user["must_change_password"]),
    }


def _login_with_invite_code(payload: dict, ip: str):
    """Servers from before accounts: a shared code plus a display name. Off unless an admin
    allows it (upgraded servers have it on, so nobody is locked out by updating)."""
    if not get_setting("allow_invite_codes"):
        raise HTTPException(403, "Invite-code login is turned off on this server. Sign in with a username and password.")
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
    with get_db() as conn:
        token = new_session(conn, name=name, role=row["role"], invite_code_id=row["id"])
    return {"token": token, "name": name, "username": None, "role": row["role"], "must_change_password": False}


@router.get("/api/auth/me")
def auth_me(request: Request):
    token = extract_token(request)
    with get_db(write=False) as conn:
        row = lookup_session(conn, token)
    if not row:
        raise HTTPException(401, "Not logged in")
    return {
        "name": row["name"], "username": row["username"], "role": row["role"], "user_id": row["user_id"],
        "method": "password" if row["user_id"] else "invite_code",
        "must_change_password": bool(row["must_change_password"]),
    }


@router.post("/api/auth/logout")
def logout(request: Request):
    token = extract_token(request)
    if token:
        with get_db() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (hash_token(token),))
    return {"ok": True}


# ------------------------------------------------------------------ my account

def _bootstrap_credentials_file():
    return config.DATA_DIR / "admin_credentials.txt"


@router.post("/api/auth/password")
def change_my_password(payload: dict = Body(...), request: Request = None):
    """Change your own password. Needs the current one (so a stolen, still-signed-in device can't
    lock the owner out), signs every OTHER device out, and clears the first-login 'must change'
    flag."""
    me = require_session(request)
    if not me["user_id"]:
        raise HTTPException(400, "This session was started with a shared invite code, which has no password. Ask an admin for an account.")
    current, new = payload.get("current_password"), payload.get("new_password")
    ip = client_ip(request)
    check_login_rate_limit(ip, me["username"] or "")
    with get_db(write=False) as conn:
        user = conn.execute("SELECT id, username, password_hash FROM users WHERE id = ?", (me["user_id"],)).fetchone()
    if not user or not isinstance(current, str) or not passwords.verify_password(current, user["password_hash"]):
        record_failed_login(ip, me["username"] or "")
        raise HTTPException(400, "Your current password isn't right.")
    problem = passwords.validate_password(new, user["username"])
    if problem:
        raise HTTPException(400, problem)
    if new == current:
        raise HTTPException(400, "The new password has to be different from the current one.")
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?",
            (passwords.hash_password(new), now_iso(), user["id"]),
        )
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND id != ?", (user["id"], me["id"]))
    # The first-run credentials file held the old password; it must not outlive it.
    _bootstrap_credentials_file().unlink(missing_ok=True)
    return {"ok": True}


@router.patch("/api/auth/profile")
def update_my_profile(payload: dict = Body(...), request: Request = None):
    """Change your own display name (the name shown on activity and to other people)."""
    me = require_session(request)
    name = " ".join(str(payload.get("display_name") or "").split())
    if not name or len(name) > 60 or any(ord(c) < 32 for c in name):
        raise HTTPException(400, "Names are 1-60 characters.")
    with get_db() as conn:
        if me["user_id"]:
            conn.execute("UPDATE users SET display_name = ? WHERE id = ?", (name, me["user_id"]))
            conn.execute("UPDATE sessions SET name = ? WHERE user_id = ?", (name, me["user_id"]))
        else:
            conn.execute("UPDATE sessions SET name = ? WHERE id = ?", (name, me["id"]))
    return {"name": name}


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
        rows = conn.execute(
            "SELECT s.id, s.name, s.created_at, s.last_activity, s.role, u.username "
            "FROM sessions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC"
        ).fetchall()
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
