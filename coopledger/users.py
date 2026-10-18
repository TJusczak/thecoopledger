"""User accounts: the admin's add / edit / reset / remove screens, and the first-run admin.

Everything here is admin-only except bootstrap (which runs once at startup). Changing your OWN
password or name is in auth.py, because anyone signed in may do that.
"""
import os
import uuid

from fastapi import APIRouter, Body, HTTPException, Request

from . import config, passwords
from .auth import ROLES, rename_checked, require_admin, require_admin_session
from .db import get_db, now_iso

router = APIRouter()

DEFAULT_ADMIN_USERNAME = "admin"


def _public(row) -> dict:
    """A user as the admin screens see them. The password hash never leaves the server."""
    return {
        "id": row["id"], "username": row["username"], "display_name": row["display_name"], "role": row["role"],
        "must_change_password": bool(row["must_change_password"]), "created_at": row["created_at"],
        "last_login_at": row["last_login_at"], "disabled": bool(row["disabled_at"]),
    }


_COLUMNS = "id, username, display_name, role, must_change_password, created_at, last_login_at, disabled_at"


def _active_admins(conn, excluding: str | None = None) -> int:
    sql = "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL"
    params: tuple = ()
    if excluding:
        sql += " AND id != ?"
        params = (excluding,)
    return conn.execute(sql, params).fetchone()["n"]


def _clean_display_name(raw, fallback: str) -> str:
    name = " ".join(str(raw or "").split()) or fallback
    if len(name) > 60 or any(ord(c) < 32 for c in name):
        raise HTTPException(400, "Names are 1-60 characters.")
    return name


def _get_user(conn, user_id: str):
    row = conn.execute(f"SELECT {_COLUMNS} FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    return row


@router.get("/api/auth/users")
def list_users(request: Request):
    require_admin(request)
    with get_db(write=False) as conn:
        rows = conn.execute(f"SELECT {_COLUMNS} FROM users ORDER BY created_at ASC").fetchall()
        return {"users": [_public(r) for r in rows]}


@router.post("/api/auth/users")
def create_user(payload: dict = Body(...), request: Request = None):
    """Add someone. Leave the password out and a random one is generated and returned ONCE -- show it
    to the admin to pass on. Either way the new person must choose their own at first sign-in."""
    require_admin(request)
    username = str(payload.get("username") or "").strip()
    problem = passwords.validate_username(username)
    if problem:
        raise HTTPException(400, problem)
    role = payload.get("role") or "member"
    if role not in ROLES:
        raise HTTPException(400, f"role must be one of: {', '.join(ROLES)}")
    password = payload.get("password")
    generated = not password
    if generated:
        password = passwords.generate_password()
    else:
        problem = passwords.validate_password(password, username)
        if problem:
            raise HTTPException(400, problem)
    display_name = _clean_display_name(payload.get("display_name"), username)
    with get_db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone():
            raise HTTPException(409, "That username is already taken.")
        user_id = uuid.uuid4().hex[:12]
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
            (user_id, username, display_name, passwords.hash_password(password), role, now_iso()),
        )
        user = _get_user(conn, user_id)
    out = {"user": _public(user)}
    if generated:
        out["temporary_password"] = password
    return out


@router.patch("/api/auth/users/{user_id}")
def update_user(user_id: str, payload: dict = Body(...), request: Request = None):
    me = require_admin_session(request)
    with get_db() as conn:
        user = _get_user(conn, user_id)
        changes, params = [], []
        if "display_name" in payload:
            name = _clean_display_name(payload["display_name"], user["username"])
            changes.append("display_name = ?"); params.append(name)
        if "username" in payload and payload["username"] != user["username"]:
            new_username = rename_checked(conn, user_id, str(payload["username"] or "").strip())
            changes.append("username = ?"); params.append(new_username)
        if "role" in payload and payload["role"] != user["role"]:
            if payload["role"] not in ROLES:
                raise HTTPException(400, f"role must be one of: {', '.join(ROLES)}")
            if user_id == me["user_id"]:
                raise HTTPException(400, "You can't change your own role. Ask another admin.")
            if user["role"] == "admin" and _active_admins(conn, excluding=user_id) == 0:
                raise HTTPException(400, "That would leave no admin. Make someone else an admin first.")
            changes.append("role = ?"); params.append(payload["role"])
        if "disabled" in payload:
            disable = bool(payload["disabled"])
            if disable and user_id == me["user_id"]:
                raise HTTPException(400, "You can't disable your own account.")
            if disable and user["role"] == "admin" and _active_admins(conn, excluding=user_id) == 0:
                raise HTTPException(400, "That would leave no admin. Make someone else an admin first.")
            changes.append("disabled_at = ?"); params.append(now_iso() if disable else None)
        if not changes:
            raise HTTPException(400, "Nothing to change.")
        conn.execute(f"UPDATE users SET {', '.join(changes)} WHERE id = ?", params + [user_id])
        after = _get_user(conn, user_id)
        # Sessions carry a copy of the role and name; keep them in step, and cut off anyone just disabled.
        conn.execute("UPDATE sessions SET role = ?, name = ? WHERE user_id = ?", (after["role"], after["display_name"], user_id))
        if after["disabled_at"]:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        return {"user": _public(after)}


@router.post("/api/auth/users/{user_id}/password")
def reset_user_password(user_id: str, payload: dict = Body(default={}), request: Request = None):
    """Admin reset: set a password (or leave it out for a generated one, returned once). The person
    is signed out everywhere and must choose their own at next sign-in."""
    require_admin(request)
    password = (payload or {}).get("password")
    generated = not password
    with get_db() as conn:
        user = _get_user(conn, user_id)
        if generated:
            password = passwords.generate_password()
        else:
            problem = passwords.validate_password(password, user["username"])
            if problem:
                raise HTTPException(400, problem)
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?",
            (passwords.hash_password(password), now_iso(), user_id),
        )
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return {"ok": True, **({"temporary_password": password} if generated else {})}


@router.delete("/api/auth/users/{user_id}")
def delete_user(user_id: str, request: Request):
    me = require_admin_session(request)
    with get_db() as conn:
        user = _get_user(conn, user_id)
        if user_id == me["user_id"]:
            raise HTTPException(400, "You can't delete your own account.")
        if user["role"] == "admin" and not user["disabled_at"] and _active_admins(conn, excluding=user_id) == 0:
            raise HTTPException(400, "That would leave no admin. Make someone else an admin first.")
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return {"deleted": True}


# ------------------------------------------------------------------ first run and recovery

def _credentials_file():
    return config.DATA_DIR / "admin_credentials.txt"


def _write_credentials_file(username: str, password: str, heading: str):
    path = _credentials_file()
    path.write_text(
        f"The Coop Ledger -- {heading}\n"
        f"Username: {username}\nPassword: {password}\n\n"
        "You will be asked to choose your own password the first time you sign in.\n"
        "This file is deleted automatically when you do.\n"
    )
    try:
        path.chmod(0o600)
    except OSError:
        pass  # e.g. a filesystem without permissions: still better to have the file than not
    return path


def bootstrap_admin(conn) -> dict | None:
    """If there are no users yet (a brand-new database, or a server from before accounts), create the
    first admin. Returns what to tell the operator, or None when users already exist.

    * ADMIN_USERNAME / ADMIN_PASSWORD (docker-compose) are used when set: the operator chose them, so
      there is no forced change.
    * Otherwise the username is 'admin' and the password is generated and written to
      data/admin_credentials.txt (and the log) -- the same pattern as Crafty Controller. The account
      must change it at first sign-in, which also deletes that file.
    """
    if conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
        return None
    username = (os.environ.get("ADMIN_USERNAME") or DEFAULT_ADMIN_USERNAME).strip()
    if passwords.validate_username(username):
        print(f"WARNING: ADMIN_USERNAME={username!r} isn't a valid username -- using {DEFAULT_ADMIN_USERNAME!r}")
        username = DEFAULT_ADMIN_USERNAME
    password = os.environ.get("ADMIN_PASSWORD") or ""
    chosen = bool(password)
    if chosen:
        problem = passwords.validate_password(password, username)
        if problem:
            print(f"WARNING: ADMIN_PASSWORD was ignored ({problem}) -- generating one instead")
            chosen = False
    if not chosen:
        password = passwords.generate_password()
    conn.execute(
        "INSERT INTO users (id, username, display_name, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, 'admin', ?, ?)",
        (uuid.uuid4().hex[:12], username, "Admin" if username == DEFAULT_ADMIN_USERNAME else username, passwords.hash_password(password), 0 if chosen else 1, now_iso()),
    )
    path = _credentials_file()
    if chosen:
        path.unlink(missing_ok=True)
    else:
        _write_credentials_file(username, password, "first-run administrator account")
    return {"username": username, "password": None if chosen else password, "from_env": chosen, "path": path}


def reset_admin(conn, username: str = DEFAULT_ADMIN_USERNAME, password: str | None = None) -> dict:
    """Recovery for a lost admin password (run from the server's own shell -- see coopledger/cli.py).

    Recreates the administrator's credentials, the way Crafty Controller does, WITHOUT touching anyone else:
    * an account with that username exists  -> it gets a new password, is made an admin again if it had been
      demoted, is enabled again if it had been disabled, and is signed out everywhere;
    * it doesn't exist                      -> it is created.
    With no `password` one is generated, written to data/admin_credentials.txt, and must be changed at the next
    sign-in. A password you pass is used as given (no forced change, nothing written to disk)."""
    problem = passwords.validate_username(username)
    if problem:
        raise ValueError(problem)
    generated = password is None
    if generated:
        password = passwords.generate_password()
    else:
        problem = passwords.validate_password(password, username)
        if problem:
            raise ValueError(problem)
    row = conn.execute("SELECT id FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
    must_change = 1 if generated else 0
    if row:
        conn.execute(
            "UPDATE users SET password_hash = ?, role = 'admin', disabled_at = NULL, must_change_password = ?, password_changed_at = ? WHERE id = ?",
            (passwords.hash_password(password), must_change, now_iso(), row["id"]),
        )
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
        created = False
    else:
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, 'admin', ?, ?)",
            (uuid.uuid4().hex[:12], username, "Admin" if username == DEFAULT_ADMIN_USERNAME else username, passwords.hash_password(password), must_change, now_iso()),
        )
        created = True
    path = _credentials_file()
    if generated:
        _write_credentials_file(username, password, "administrator credentials (reset)")
    else:
        path.unlink(missing_ok=True)
    return {"username": username, "password": password if generated else None, "generated": generated, "created": created, "path": path}
