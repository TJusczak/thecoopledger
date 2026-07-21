#!/bin/sh
# Runs as root just long enough to make the data volume writable by the
# unprivileged app user, then drops privileges for the server itself.
#
# Why this dance exists: when Docker Compose auto-creates ./data on the
# host, it's owned by root -- a container that simply declared "USER app"
# would start, fail to write the database, and crash with a permissions
# error that's miserable to debug. Chowning here, then dropping to the
# app user, gives the security of a non-root server without making every
# new user fight volume permissions on first run.
#
# PUID/PGID (default 1000:1000) control which host uid/gid owns the data
# files -- match them to your own user so ./data stays readable to you.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" != "0" ]; then
    # Started with a user override (e.g. compose `user:`) -- respect it and
    # just run; the operator has taken ownership of permissions themselves.
    exec uvicorn main:app --host 0.0.0.0 --port 8000 "$@"
fi

# Create/adjust the runtime group and user to the requested ids.
if ! getent group coop >/dev/null 2>&1; then
    groupadd -g "$PGID" coop 2>/dev/null || groupadd coop
fi
if ! id coop >/dev/null 2>&1; then
    useradd -u "$PUID" -g coop -M -s /usr/sbin/nologin coop 2>/dev/null || useradd -g coop -M -s /usr/sbin/nologin coop
fi

mkdir -p /data
chown -R coop:coop /data

if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid coop --regid coop --clear-groups \
        uvicorn main:app --host 0.0.0.0 --port 8000 "$@"
else
    echo "WARNING: setpriv not found -- running as root. This still works, but isn't ideal."
    exec uvicorn main:app --host 0.0.0.0 --port 8000 "$@"
fi
