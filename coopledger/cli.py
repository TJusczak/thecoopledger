"""Command-line recovery and inspection, run from the server's own shell.

    docker compose exec coop-ledger python -m coopledger.cli reset-admin
    docker compose exec coop-ledger python -m coopledger.cli list-users

There is deliberately no "forgot password" button and no email: if the only admin loses their password, the
way back in is to have shell access to the machine the server runs on -- the same trust boundary as the data
directory itself. Anyone who can run this can already read the database, so it adds no new power.

reset-admin recreates the administrator's credentials (like Crafty Controller's reset): the `admin` account
gets a new generated password, is made an admin again and enabled if it had been demoted or disabled, and is
signed out everywhere; if there is no such account it is created. Other accounts are not touched. The new
password is printed and written to data/admin_credentials.txt, and must be changed at the next sign-in.
It works while the server is running.
"""
import argparse
import os
import sys


def _drop_to_data_owner(data_dir) -> None:
    """Run as whoever owns the data directory. `docker exec` starts as root, but the server runs as an
    unprivileged user: a root-run command could create root-owned database files (the -wal/-shm companions)
    the server then cannot open."""
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return
    st = os.stat(data_dir)
    if st.st_uid == 0:
        return
    os.setgroups([])
    os.setgid(st.st_gid)
    os.setuid(st.st_uid)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m coopledger.cli", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    reset = sub.add_parser("reset-admin", help="recreate the administrator's credentials")
    reset.add_argument("--username", default="admin", help="the account to reset or create (default: admin)")
    reset.add_argument("--password", help="set this password instead of generating one (no forced change, nothing written to disk)")
    sub.add_parser("list-users", help="show every account")
    args = parser.parse_args(argv)

    from . import config
    _drop_to_data_owner(config.DATA_DIR)
    from .db import get_db
    from .migrations import init_db
    from .users import reset_admin

    init_db()   # a no-op on a database the server already set up; creates one if the server has never run
    if args.command == "list-users":
        with get_db(write=False) as conn:
            for u in conn.execute("SELECT username, display_name, role, disabled_at, last_login_at FROM users ORDER BY created_at"):
                flags = " (disabled)" if u["disabled_at"] else ""
                print(f"{u['username']:<24} {u['role']:<9} {u['display_name']}{flags}")
        return 0

    try:
        with get_db() as conn:
            result = reset_admin(conn, username=args.username, password=args.password)
    except ValueError as e:
        print(f"Can't do that: {e}", file=sys.stderr)
        return 2
    print("=" * 60)
    print(f"  {'CREATED' if result['created'] else 'RESET'}: administrator account '{result['username']}'")
    if result["generated"]:
        print(f"    Username: {result['username']}")
        print(f"    Password: {result['password']}")
        print(f"  (also written to {result['path']})")
        print("  Sign in with this, and you'll be asked to choose your own password.")
    else:
        print("  The password you gave is now set. Sign in with it.")
    print("  Everyone else's accounts are unchanged.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
