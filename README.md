# The Coop Ledger

**Try it now: [thecoopledger.com](https://thecoopledger.com)** — no account needed for local use.

Self-hosted flock tracker: birds (including batches for meat birds), egg
production, an income/expense ledger, supply inventory with photos, egg
incubation/hatching, and bedding freshness tracking. FastAPI + SQLite on
the backend, a local-first vanilla-JS PWA on the front — installable as a
standalone app on desktop and Android, and works fully offline once loaded.

## Quick start (recommended: published image, no source needed)

```yaml
# docker-compose.yml
services:
  coop-ledger:
    image: ghcr.io/TJusczak/thecoopledger:latest
    container_name: coop-ledger
    ports:
      - "8000:8000"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

That pulls the image straight from GHCR — no cloning, no build step. (See
**Publishing your own image** below if you're setting up that pipeline for
the first time, or forking this to publish your own copy.)

Visit `http://<server-ip>:8000` from any machine on your network.

### First login

On first startup, the server generates an invite code and:
- prints it to the container logs (`docker compose logs coop-ledger`)
- writes it to `data/invite_code.txt` on the host

Enter that code (plus a name for yourself) on the app's login screen to get
in. You can rotate it anytime from Settings → Connection once logged in —
share the current code with anyone else you want to have access.

### Building from source instead

If you've modified the code, or just prefer building it yourself:

```bash
git clone <this-repo>
cd coop-ledger
docker compose up -d --build
```

Or without Docker at all:

```bash
pip install -r requirements.txt
DATA_DIR=./data uvicorn main:app --host 0.0.0.0 --port 8000
```

## Publishing your own image

A GitHub Actions workflow (`.github/workflows/docker-publish.yml`) is
already set up to build and publish a multi-architecture image (amd64 +
arm64, so it runs on a typical home server or a Raspberry Pi / ARM NAS
alike) to GHCR, GitHub's own container registry.

1. Push this repo to your own GitHub account.
2. Push to `main` (or push a tag like `v1.0.0` for a pinned version) — the
   workflow builds and publishes automatically. No extra account or secret
   needed; it authenticates with the token GitHub Actions already provides.
3. **Important:** the first time it publishes, go to the package's page on
   GitHub (your profile or org → **Packages**) and set its visibility to
   **Public**. Packages default to private, and a private one will fail
   with a 401 for anyone (including you, on another machine) trying to
   `docker pull` it without being logged into GHCR first.
4. `docker-compose.yml` in this repo already points at
   `ghcr.io/TJusczak/thecoopledger:latest` — if you've forked this under a
   different account or repo name, update the `image:` line to match
   yours instead (`ghcr.io/<your-username>/<repo-name>:latest`).

From then on, `docker compose pull && docker compose up -d` picks up new
versions without ever needing the source on that machine.

## Local-only mode: no server required at all

The app doesn't require self-hosting to be useful. On first visit, "Start
tracking now" runs the entire app in the browser with **zero server
involvement** — all data lives in that browser's local storage (IndexedDB),
nothing is sent anywhere. This works from the same static files whether
they're served by your own self-hosted instance, or from
[thecoopledger.com](https://thecoopledger.com) (a static delivery site,
hosted separately from any individual's synced server), since local-only
mode never calls the API at all after the page itself loads.

You can switch to "Sync with a server" at any point without losing
anything already entered — everything gets pushed up automatically. Same
in reverse: local-only data can always be exported and moved to a synced
setup later.

**Because local-only mode is entirely client-side, once the app is
installed (see below) or its files are cached by the service worker, it
keeps working indefinitely with no connection at all** — the server or
website was only ever needed to hand over the code the first time, not to
keep running the app afterward.

Local-only data isn't backed up automatically, since by definition nothing
is sent to a server. Settings shows a persistent reminder, a "Synced
folder" option (desktop Chrome/Edge only) that can save a backup straight
into a Dropbox/Drive/OneDrive-watched folder automatically, and a manual
"Export (.zip)" that always works regardless of browser.

## Installable app (PWA + Android)

The app is a full PWA — install it from the browser (look for an install
icon in the address bar, or the option in Settings → Connection) for its
own window, icon, and Start Menu / home screen presence, with the app
shell cached for offline use. There's also a wrapped Android APK (a
Trusted Web Activity) for a proper Play-Store-style install without a
browser wrapper at all.

## Coops (profiles)

Everything is siloed under a named **coop** — birds, eggs, expenses,
supplies, and bedding logs all belong to one. Create as many as you want
(a real one plus a throwaway one for testing, for example), switch between
them from Settings, and export/import individual coops as backups or to
move them elsewhere.

## Backup

**The database (self-hosted / synced mode):** everything lives in one
SQLite file, `data/coop.db`. Back it up however you already back up other
files on your server — rsync, a TrueNAS snapshot/replication task, a cron
`cp` to another dataset, whatever you're already doing for Immich/
Paperless. Stopping the container first isn't strictly necessary (SQLite
is crash-safe), but for a guaranteed-consistent snapshot: `docker compose
stop`, copy the file, `docker compose start`.

**Per-coop exports (either mode):** from Settings → Coops, "Export (.zip)"
is a full backup of a single coop — all its data plus real photo files —
and works with or without a connection. "Spreadsheet (.csv)" is for
viewing/analyzing in a spreadsheet, not a backup (no photos, can't be
re-imported).

To restore the whole database, drop a `coop.db` back into `data/` before
starting the container. To restore a single coop from a `.zip` export, use
Import on the Coops page.

## Security notes

- Auth is a single, server-wide invite code (not per-coop) — rate-limited,
  with a lockout after repeated failed attempts. Rotate it from Settings →
  Connection; sessions can be reviewed/revoked from there too.
- If you're exposing this beyond your home network, set the
  `TRUST_PROXY_HEADERS=1` environment variable **only if** you're actually
  behind a trusted reverse proxy (e.g. Cloudflare Tunnel) that sets
  `CF-Connecting-IP`/`X-Forwarded-For` itself — otherwise leave it unset,
  since trusting those headers from an untrusted source would let the
  login rate-limit be trivially bypassed by spoofing a different IP on
  each attempt.
- Photos are only ever served to an authenticated request — same as any
  other data in the app.

## Notes

- The API is plain REST under `/api/{birds,eggs,expenses,supplies,...}` if
  you ever want to script against it (e.g. pull sensor data from a coop Pi
  into an expense or bedding log automatically). Needs a valid session
  token, same as the app itself.
- If you already ran an early single-coop version of this app, existing
  data isn't lost — it's automatically migrated into a coop named "Default
  Coop" on first startup with the current backend.
