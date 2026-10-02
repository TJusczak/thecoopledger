# Architecture

A short map of how the pieces fit, written for someone about to change something.

## Shape of the system

```
 browser (PWA)                                   server (optional)
 ┌───────────────────────────────┐              ┌──────────────────────────┐
 │ UI  ─▶ local-first CRUD       │   outbox     │ FastAPI + SQLite (WAL)   │
 │        │   writes IndexedDB   │ ───push────▶ │  /api/{resource} CRUD    │
 │        └─▶ _outbox (queue)    │              │  /api/sync/{resource}    │
 │                               │ ◀──pull───── │  /api/events  (SSE nudge)│
 │ reads always come from        │   cursor     │  photos, backups, auth   │
 │ IndexedDB, never the network  │              └──────────────────────────┘
 └───────────────────────────────┘
```

The app is **local-first**: every read and write hits IndexedDB, so it is fully usable
offline. With a server configured, writes are also queued in an *outbox* and pushed;
changes made elsewhere are pulled incrementally. With no server ("local only") nothing ever
leaves the browser.

## Server (`coopledger/`)

`main.py` is a one-line shim (`from coopledger.app import app`) so `uvicorn main:app`,
the Dockerfile and existing deployments are unchanged.

| module | responsibility |
| --- | --- |
| `config.py` | environment variables, paths, constants (derived at import time) |
| `db.py` | connections, transactions, **the sync clock** (see below) |
| `schema.py` | `SCHEMA` / `SCOPED`: the synced tables. Nothing server-internal may go here |
| `migrations.py` | declarative schema creation + versioned data migrations |
| `auth.py` | invite codes, sessions, roles, login rate limiting |
| `middleware.py` | plain-ASGI middleware: auth gate, security headers, cache headers |
| `routes_resources.py` | generic CRUD + `/api/sync/*` — registered **last** |
| `routes_coops.py` / `routes_admin.py` / `routes_birds.py` | coop lifecycle + export/import, admin pages, bird bulk ops |
| `photos.py` | photo files, reference counting, upload validation (magic bytes) |
| `events.py` | Server-Sent Events: a "pull now" nudge, sent **after commit** |
| `push.py` / `integrations.py` | Web Push reminders; read-only stats feed for Home Assistant |
| `maintenance.py` | pruning, scheduled backups, hourly pass (run in a worker thread) |
| `app.py` | assembles the above; **router order matters** |

Two rules that have each caused real bugs:

* **Route order.** `/api/{resource}` matches almost any `/api/x`. Specific routes are included
  first and `routes_resources` last (see `app.create_app`). A new `/api/...` route added
  after it is silently unreachable.
* **Never nest write transactions.** `get_db()` takes SQLite's write lock up front. A second
  write connection opened inside the first would wait on its own caller for 30 s, so `db.py`
  raises immediately instead. Do reads with `get_db(write=False)`, and do the second write
  after the first block exits.

### The sync clock (why incremental sync is lossless)

Clients pull `GET /api/sync/<resource>?since=<cursor>` and remember the `server_time` returned.
For that to never skip a row:

1. Every write transaction starts with `BEGIN IMMEDIATE` and *then* draws its `updated_at`
   from a persisted, strictly increasing clock (`sync_clock`) — so commit order equals
   timestamp order, even if the wall clock steps backwards.
2. `server_time` is the clock value read **in the same snapshot as the rows**. Everything
   committed is ≤ it; anything still in flight will be stamped > it.

`now_iso()` returns the current transaction's stamp, so call sites don't know the clock
exists. `tests/test_sync_robustness.py::test_no_row_is_lost_when_writes_race_a_puller` fails
on the old wall-clock-before-lock design and passes on this one.

Related semantics: deletes are soft (`deleted_at` + bumped `updated_at`) so offline devices learn
of them; creates are idempotent by id (a retry never overwrites newer edits); updates merge
per field; an edit to a deleted row revives it (intent to keep wins).

### Migrations

* **Schema** is declarative: add a column by editing `schema.SCHEMA`; `init_db()` adds it.
* **Data migrations** are appended to `migrations.MIGRATIONS` and recorded in
  `schema_migrations`. Mark one `repeatable=True` only for idempotent *repairs* that must also
  catch stale data an old offline client syncs in later. A safety backup is taken before a new
  one-time migration runs on an existing database.

## Frontend (`static/`)

Vanilla JS, **no build step** — `static/` is served as-is (Docker) or copied (Cloudflare).
`app.js` holds only the build identity (CI stamps `__BUILD_CHANNEL__` into that exact file).
Everything else is `static/js/*.js`, loaded as **classic scripts sharing one global scope**, in
the order listed in `index.html`:

`state` → `helpers` → `connection-auth` → `local-db` → `sync-core` → `sync` → `local-crud` →
`export-import` → `shell` → `settings` → `notes` → `coops` → `dashboard` → `undo` → `flock` →
`eggs` → `finances` → `supply` → `init` → `main`

Order matters only for code that runs at load time (top-level `const`s and listeners); function
bodies run later, after everything has loaded. `main.js` is last and starts the app. A new
file must be added to **both** `index.html` and the `SHELL_ASSETS` list in `sw.js`.

`sync-core.js` is deliberately free of DOM and IndexedDB so Node can test it
(`tests/test_sync_core.mjs`) and the service worker can `importScripts` it — which guarantees
the background outbox drain makes the same decisions as the app.

### Layout

One DOM, two layouts (`style.css`, end of file). `>= 900px`: a left **sidebar** (brand, coop
switcher, section nav, status) beside a content pane with a page header and sticky sub-tabs.
Below that, the original top bar + bottom tab bar; the sidebar wrapper becomes
`display: contents`. Sections render their own sub-tab strip (`.range-select.sub-nav-fixed`) —
CSS restyles it as the sticky tab row on wide screens.

## Tests

| command | what |
| --- | --- |
| `pytest` | server: auth/roles, CRUD, sync guarantees, regressions, migrations, backups (~100 tests, seconds) |
| `node tests/test_*.mjs` | client logic: sync decisions, feed engine, dashboard render |
| `pytest -m e2e` | real Chromium against a real server: offline queueing, two-device convergence, offline reload via the service worker, layout. Needs `playwright install chromium` |
| `ruff check .` | lint (pyflakes + bugbear) |

CI (`.github/workflows/docker-publish.yml`) runs all of these before an image is published.
