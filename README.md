<img src="static/icon-512.png" alt="" width="96" height="96">

# The Coop Ledger

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/thecoopledger)

**Try it now: [thecoopledger.com](https://thecoopledger.com)** — no account needed for local use.

Self-hosted flock tracker: birds (including batches for meat birds), egg
production, an income/expense ledger, supply inventory with photos, egg
incubation/hatching, and bedding freshness tracking. FastAPI + SQLite on
the backend, a local-first vanilla-JS PWA on the front — installable as a
standalone app on any phone or desktop, and works fully offline once loaded.

> 🚧 **Actively in development.** This is a one-person project under active,
> ongoing development — features and behavior are still changing, and
> while care is taken to avoid it, bugs happen. **Back up your data
> regularly**: `Settings → Coops → Export (.zip)` in the app, or a direct
> copy of `data/coop.db` if you're self-hosting (see **Backup** below).
> Nothing here is deliberately experimental, but this hasn't had years of
> production hardening either — treat it accordingly.

## Quick start (recommended: published image, no source needed)

```yaml
# docker-compose.yml
services:
  coop-ledger:
    image: ghcr.io/tjusczak/thecoopledger:latest
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

On first startup the server creates an **administrator account** with a generated
password, and tells you where to find it:

- it's printed to the container logs (`docker compose logs coop-ledger`)
- it's written to `data/admin_credentials.txt` on the host (readable only by its owner)

Open `http://<server-ip>:8000`, sign in as `admin` with that password, and you'll be asked to
choose your own straight away. Once you do, `admin_credentials.txt` is deleted. From then on
you sign in with a username and password you can actually remember.

Prefer to choose it yourself up front? Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in
`docker-compose.yml` (see **Configuration**). They only create the *first* account, on an empty
server, so changing them later doesn't touch an existing one.

**Adding people:** Settings → **Users** lets an admin add accounts, give each a role, reset
passwords, disable or delete them. Roles are **Admin** (everything, including users and server
settings), **Member** (add and edit flock data) and **Read-only** (look, don't touch). New and
reset accounts get a temporary password, shown once, and must choose their own at first sign-in.
Everyone can change their own display name and password under Settings → **Account**.

**Renaming:** an admin can change anyone's username (Settings → Users → Edit) and they stay signed in;
anyone can change their own under Settings → Account (it asks for your password). Display names are
separate and change any time.

**Using it without a server:** the sign-in page also has *Use on this device only*. That's local-only
mode: no account, nothing leaves the browser. On the public website that's the main option, with
*Sign in to your own server* underneath for people who run one.

### Lost the admin password?

There's no "forgot password" button and no email, on purpose: nothing to set up, and nothing for an
attacker to abuse. Instead, like Crafty Controller, you recover from the server's own shell. If you can
reach the machine the server runs on, you can recreate the admin credentials:

```bash
docker compose exec coop-ledger python -m coopledger.cli reset-admin
# not using Docker:  DATA_DIR=./data python -m coopledger.cli reset-admin
```

That prints a new generated password (also written to `data/admin_credentials.txt`) for the `admin`
account. Sign in with it and you'll be asked to choose your own. Everything else stays as it was:

- it works while the server is running, and signs that account out everywhere;
- the account is made an admin again and enabled, if it had been demoted or disabled;
- **everyone else's accounts are left exactly as they are**;
- `--username NAME` recovers a different admin account (or creates it); `--password '...'` sets one you
  choose instead of generating it (no forced change, nothing written to disk);
- `python -m coopledger.cli list-users` shows who exists.

Whoever can run that command can already read the database, so it adds no new power -- shell access to
the server *is* the trust boundary.

**Upgrading a server from before accounts?** Nothing breaks: the shared invite codes keep working,
and an `admin` account is added (its password is in the logs and `data/admin_credentials.txt`, same
as a new install). Once everyone has their own account, switch the codes off in Settings → Users.
New servers don't use invite codes at all unless you turn them on.

> **Use HTTPS if the server is reachable from outside your home.** A password is sent to the server
> when you sign in, so over plain `http://` anyone on the network path can read it. On a trusted home
> network that's a reasonable trade; across the internet put it behind HTTPS (a Cloudflare Tunnel, Caddy,
> Traefik or nginx). The sign-in page warns when it's talking over plain HTTP.

### Choosing a release channel

The image is published under two tags:

- **`:stable`** (same as `:latest`) — only updates when a version is
  deliberately promoted. This is the safe default, and what
  `docker-compose.yml` points at out of the box.
- **`:beta`** — rebuilds automatically on every push to `main`. Newer
  features sooner, but less tested — expect the occasional rough edge.

Switch by changing one line in `docker-compose.yml`:

```yaml
image: ghcr.io/tjusczak/thecoopledger:beta
```

then `docker compose pull && docker compose up -d`. Switching back to
`:stable` works the same way, any time.

If you'd rather freeze at a specific version and upgrade on your own
schedule instead of tracking a moving tag, pin to a version number
instead, e.g. `ghcr.io/tjusczak/thecoopledger:1.4.0` — see the
[Releases page](https://github.com/TJusczak/thecoopledger/releases) for
what's changed between versions.

### Access the app from your own server's address

Open the app at `http://<your-server-ip>:8000` directly, rather than
using thecoopledger.com and pointing it at your server for sync. Every
release ships frontend and backend together in the same image, so
loading the app from your own server guarantees the two are always a
matching pair — there's nothing to drift out of sync, on whatever channel
you've chosen above.

Opening thecoopledger.com itself and syncing with a self-hosted server
elsewhere works too, but the two then update independently — you could
end up with newer frontend code than your server's backend actually
supports. The app detects this and quietly stops offering "update
available" prompts in that situation, since they'd only reflect
thecoopledger.com's own version rather than anything meaningful about
your server, and shows an explanation instead if you check manually.

**Installed PWA:** installing from a given address (Chrome → menu → **Add
to Home Screen**, or the install icon in a desktop address bar) fixes the
app to that origin the same way a browser tab there would be. For a
self-hosted server, install directly from your own server's address to get
an icon and standalone window with the same guaranteed frontend/backend
pairing as above.

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

## Configuration

Everything is configured with environment variables, and **everything has a
sensible default** — a bare `docker compose up` with no configuration at
all is a fully working, safe setup. The commented `environment:` block in
`docker-compose.yml` mirrors this table; uncomment only what you want to
change. A malformed value falls back to its default with a warning in the
logs rather than refusing to start.

Several of these can also be changed **from the app**, by an admin, under
Settings → Server — session expiry, the four backup settings, and activity
log retention. An override set there takes effect immediately (no restart)
and wins over the environment variable until you hit **Reset**, which drops
the override and returns to whatever your environment says. This means you
can either drive everything from `docker-compose.yml` as config-as-code, or
adjust day-to-day settings from the app without redeploying — whichever you
prefer. Deployment-critical values (`DATA_DIR`, `PUID`/`PGID`,
`CORS_ALLOWED_ORIGINS`, `TRUST_PROXY_HEADERS`) are environment-only, since a
bad value typed into a web form shouldn't be able to lock you out.

| Variable | Default | What it does |
| --- | --- | --- |
| `DATA_DIR` | `/data` (in Docker) | Where the database, photos, and backups live. Map a volume here. |
| `PUID` / `PGID` | `1000` / `1000` | Host user/group that owns the files in `./data`. Set to your own ids (`id -u` / `id -g`) so the data stays readable to you. The container starts as root only long enough to fix volume ownership, then drops to this unprivileged user. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / generated | The first administrator, created only on an **empty** server. If the password is left out (or is too weak) one is generated and written to `data/admin_credentials.txt`; a password you set here isn't forced to change. |
| `ALLOW_INVITE_CODES` | `false` | Whether the older shared invite-code sign-in works. Servers upgraded from before accounts have it switched on automatically; an admin can change it in Settings → Users, which overrides this. |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Failed sign-ins allowed from one IP before it's locked out, and for how long. (One *account* tolerates four times as many from anywhere, so one attacker can't easily lock you out of your own.) |
| `TRUST_PROXY_HEADERS` | unset | Set to `1` **only** behind a reverse proxy you control (e.g. Cloudflare Tunnel), so the login rate-limit sees real visitor IPs. See Security notes. |
| `MAX_PHOTO_UPLOAD_MB` | `25` | Per-photo upload size cap. The app resizes photos before upload anyway; this is the server-side backstop. |
| `BACKUPS_ENABLED` | `true` | Automatic rotating backups into `DATA_DIR/backups`. Turn off only if you snapshot the volume some other way. |
| `BACKUP_INTERVAL_HOURS` | `24` | How often an automatic backup is taken. |
| `MAX_BACKUPS_TO_KEEP` | `14` | Older backups are rotated out past this count. Backups hard-link photos, so keeping many is nearly free on disk. |
| `SESSION_MAX_IDLE_DAYS` | `0` | `0` = logins never expire (the kitchen-tablet default). Set to e.g. `90` to automatically log out sessions idle that long. |
| `ACTIVITY_LOG_RETENTION_DAYS` | `7` | How much history the activity feed keeps. |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed origins for the API. The permissive default is what lets an installed PWA / a CDN-hosted frontend talk to your server out of the box; set e.g. `https://coop.example.com` to lock it to one origin. |

The container reports its health at `/api/health` and carries a Docker
`HEALTHCHECK`, so `docker ps`, Portainer, Uptime Kuma, and
`depends_on: condition: service_healthy` all see real status instead of
just "running".

## Running the tests

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest                                  # server: ~100 tests, a few seconds
for t in tests/test_*.mjs; do node "$t"; done   # client logic (no dependencies)
ruff check .                            # lint

playwright install chromium             # once
pytest -m e2e                           # real browser + real server (about a minute)
```

The server tests run against a temporary data directory -- they can't touch a real
deployment's database -- and cover auth and roles, the admin-only boundary, CRUD and the
sync guarantees (including a concurrent writer-vs-puller race), photo validation, backups,
invite codes, migrations, and a regression test for each bug found in the server audit. The
browser tests drive the real app: offline queueing and draining, two devices converging,
reloading with no network at all, and the layout at phone, tablet and desktop sizes.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit together (server
package layout, the sync clock, the frontend script order) before changing any of them.

## Publishing your own image

A GitHub Actions workflow (`.github/workflows/docker-publish.yml`) is
already set up to build and publish a multi-architecture image (amd64 +
arm64, so it runs on a typical home server or a Raspberry Pi / ARM NAS
alike) to GHCR, GitHub's own container registry.

1. Push this repo to your own GitHub account.
2. Push to `main` and the workflow builds and publishes `:beta`
   automatically — no extra account or secret needed, it authenticates
   with the token GitHub Actions already provides. When you're confident
   in a particular build, push a version tag (e.g. `v1.0.0`) to also
   publish it as `:stable`, `:latest`, and that pinned version number —
   see **Choosing a release channel** above for what each tag means.
3. **Important:** the first time it publishes, go to the package's page on
   GitHub (your profile or org → **Packages**) and set its visibility to
   **Public**. Packages default to private, and a private one will fail
   with a 401 for anyone (including you, on another machine) trying to
   `docker pull` it without being logged into GHCR first.
4. `docker-compose.yml` in this repo already points at
   `ghcr.io/tjusczak/thecoopledger:latest` — if you've forked this under a
   different account or repo name, update the `image:` line to match
   yours instead (`ghcr.io/<your-username>/<repo-name>:latest`).

From then on, `docker compose pull && docker compose up -d` picks up new
versions without ever needing the source on that machine.

## Deploying the landing site (thecoopledger.com)

The `landing/` folder is the marketing/delivery site; `static/` is the app
itself (also what self-hosted Docker instances serve). Cloudflare Pages
combines them at build time rather than keeping two copies in sync by
hand. In the Cloudflare dashboard for this project:

- **Root directory:** leave blank (repo root)
- **Build command:**
  ```
  mkdir -p dist && cp -r landing/. dist/ && mkdir -p dist/app && cp -r static/. dist/app/ && sed -i 's/__BUILD_CHANNEL__/stable/' dist/index.html dist/app/app.js
  ```
- **Build output directory:** `dist`

`wrangler.jsonc` at the repo root tells Cloudflare's deploy step where to
find those built files (`./dist`) -- without it, deploys fail with
`Missing entry-point to Worker script or to assets directory`, since
newer Cloudflare projects deploy through Wrangler rather than the older
Pages-only pipeline. This is checked into the repo, so there's nothing to
configure for it in the dashboard.

Note the `/.` (not `/*`) at the end of each source path — a trailing `/*`
is a shell glob that silently skips hidden files and folders. `/.` copies
everything, hidden or not, so any dot-prefixed files stay in the deploy.

### Beta channel for the website

This project deploys through Cloudflare Workers Builds, not classic Pages,
which changes how a beta channel needs to be set up. The main project's
**Production branch** (Worker → Settings → Build → Branch control) is set
to `stable`, with **Builds for non-production branches** left unchecked --
that project only builds `stable` now.

Named Wrangler environments (a single project deploying `main` and
`stable` to two different Workers via `wrangler.jsonc`) turned out not to
work cleanly here: Workers Builds ties a connected project to one fixed
Worker identity, and overrides whatever name a `wrangler.jsonc`
environment specifies back to that identity -- which defeats the point,
since it meant a beta deploy could land on the same Worker as
production instead of a separate one.

What actually works is a **second, separate Workers Builds project**,
connected to the same GitHub repo:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → connect this
   repo again, as a new project named `thecoopledger-beta` at creation --
   that becomes its real identity, so there's nothing for the CI to
   override.
2. Its **Production branch**: `main`.
3. **Build command**: the same as the main project (see Quick start
   above), except the channel stamp at the end needs to say `beta`
   instead of `stable`:
   ```
   mkdir -p dist && cp -r landing/. dist/ && mkdir -p dist/app && cp -r static/. dist/app/ && sed -i 's/__BUILD_CHANNEL__/beta/' dist/index.html dist/app/app.js
   ```
   **Build output directory**: `dist`, same as the main project.
4. **Deploy command**: `npx wrangler deploy` (no `--env` needed here --
   this project has its own identity now, not a borrowed environment).
5. Add `beta.thecoopledger.com` as its custom domain -- a bare hostname,
   no wildcard or path (Custom Domains reject both).

From then on, this second project tracks `main` independently: every
push deploys live to beta.thecoopledger.com automatically, with zero risk
to the production Worker, since the two projects don't share a deploy
identity at all. A small gold "BETA" ribbon in the corner of both the app
and the landing page confirms at a glance which channel you're looking
at -- stamped in by the `sed` step above, and by the equivalent step in
`docker-publish.yml` for the Docker image.

The `stable` branch only moves when a version tag is pushed -- the
`promote-stable-branch` job in `.github/workflows/docker-publish.yml`
fast-forwards it to match automatically, at the same time the Docker
`:stable` tag gets published. One tag push promotes the Docker image and
the production website together; `main` continues to preview
automatically on both the Docker `:beta` tag and beta.thecoopledger.com.

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

## Installable app (PWA)

The app is a full PWA — install it from the browser (look for an install
icon in the address bar, or the option in Settings → App) for its own
window, icon, and Start Menu / home screen presence, with the app shell
cached for offline use. This works the same on phones (Chrome → **Add to
Home Screen**) and desktops, with no separate download or app store
needed.

## Coops (profiles)

Everything is siloed under a named **coop** — birds, eggs, expenses,
supplies, and bedding logs all belong to one. Create as many as you want
(a real one plus a throwaway one for testing, for example), switch between
them from Settings, and export/import individual coops as backups or to
move them elsewhere.

## Backup

**Automatic (self-hosted / synced mode):** the server keeps a rolling two
weeks of full backups (database + every photo) on its own, created daily,
no setup needed. Photos are hard-linked rather than copied into each one,
so the whole two weeks costs barely more disk space than a single day's
data. Download any of them from Settings → Server (admin only), or find them
directly on disk under `data/backups/`.

**The database directly (self-hosted / synced mode):** everything also
lives in one SQLite file, `data/coop.db`, if you'd rather back it up
yourself the way you already back up other files on your server — rsync,
a TrueNAS snapshot/replication task, a cron `cp` to another dataset,
whatever you're already doing for Immich/Paperless. Stopping the
container first isn't strictly necessary (SQLite is crash-safe), but for
a guaranteed-consistent snapshot: `docker compose stop`, copy the file,
`docker compose start`.

**Per-coop exports (either mode):** from Settings → Coops, "Export (.zip)"
is a full backup of a single coop — all its data plus real photo files —
and works with or without a connection. "Spreadsheet (.csv)" is for
viewing/analyzing in a spreadsheet, not a backup (no photos, can't be
re-imported).

To restore the whole database, drop a `coop.db` back into `data/` before
starting the container (an automatic backup's `coop.db` works here too).
To restore a single coop from a `.zip` export, use Import on the Coops
page.

## Security notes

- Sign-in is by username and password. Passwords are never stored: each is kept as a salted
  **scrypt** hash (N=2^15, r=8, p=3), so even someone holding a copy of the database or a backup
  can't read them, and every guess costs real time. The cost is recorded inside each hash, so it
  can be raised later; older hashes upgrade the next time their owner signs in. Passwords need
  8-128 characters and can't be an obvious one (or the username); there's no "must contain a
  symbol" rule, which mostly pushes people toward predictable substitutions.
- Session tokens are random 256-bit values and only their SHA-256 is stored, so a copy of the
  database can't be replayed as logins. Changing your password signs your *other* devices out; an
  admin resetting a password, or disabling or deleting an account, ends that person's sessions at
  once, and a role change takes effect without a sign-out.
- Sign-in is rate-limited per IP and per account, and tells a wrong password and an unknown
  username apart in neither wording nor timing. Failed attempts are logged (admins can see them)
  with the username tried but **never** the password.
- A new or reset account can't do anything except choose its own password until it has. That's
  enforced on the server, not just by the page.
- Read-only people can still change their own name and password; they just can't change data.
- Servers from before accounts keep their shared invite codes until an admin turns them off
  (which also ends any sessions that came in through a code).
- Read-only enforcement lives on the server, not just hidden in the UI —
  every write request is checked centrally before it ever reaches an
  endpoint, so it doesn't depend on every screen correctly disabling its
  own buttons.
- If you're exposing this beyond your home network, set the
  `TRUST_PROXY_HEADERS=1` environment variable **only if** you're actually
  behind a trusted reverse proxy (e.g. Cloudflare Tunnel) that sets
  `CF-Connecting-IP`/`X-Forwarded-For` itself — otherwise leave it unset,
  since trusting those headers from an untrusted source would let the
  login rate-limit be trivially bypassed by spoofing a different IP on
  each attempt.
- Photos are only ever served to an authenticated request — same as any
  other data in the app. Uploads are additionally validated by their
  actual bytes (magic numbers), not the claimed content type, so only
  genuine JPEG/PNG/WebP/GIF data is ever stored, and every response
  carries `X-Content-Type-Options: nosniff` so a browser never
  second-guesses that.
- Admin-only material is enforced per-endpoint on the server, not just by
  which pages the UI shows: backups (which contain the full database,
  including every invite code and every account's password *hash*), the
  failed-login log (attempted invite codes are exactly the material someone
  would need to guess a real one), user and session management, and
  invite-code management all reject non-admin sessions outright --
  including read-only and member sessions.
- The container runs the server as an unprivileged user; root is used
  only momentarily at startup to fix data-volume ownership (`PUID`/`PGID`
  above).

## Notes

- The API is plain REST under `/api/{birds,eggs,expenses,supplies,...}` if
  you ever want to script against it (e.g. pull sensor data from a coop Pi
  into an expense or bedding log automatically). Needs a valid session
  token, same as the app itself.
- If you already ran an early single-coop version of this app, existing
  data isn't lost — it's automatically migrated into a coop named "Default
  Coop" on first startup with the current backend.
