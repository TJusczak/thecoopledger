"""Application assembly: routers, middleware, lifespan, static files."""
import asyncio
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.staticfiles import StaticFiles

from . import config, events, middleware
from . import auth, integrations, maintenance, photos, push
from . import routes_admin, routes_birds, routes_coops, routes_resources
from .db import get_db
from .migrations import init_db, run_migrations

health_router = APIRouter()


@health_router.get("/api/health")
def health():
    """Cheap reachability ping for the app's online/offline indicator, and
    reports this server's version so the client can detect a mismatch --
    e.g. a self-hosted sync server that hasn't been restarted since the
    static frontend it's serving (or being talked to by) auto-updated."""
    return {"status": "ok", "db": str(config.DB_PATH), "version": config.SERVER_VERSION}


def run_startup_work():
    """Everything that must happen before serving, in dependency order: the
    schema exists before the migrations that touch it, and push tables are
    repaired before anything reads them. Blocking, so the caller runs it in a
    worker thread."""
    init_db()
    run_migrations(before_pending=lambda ids: _safety_backup(ids))
    with get_db() as conn:
        push.ensure_push_tables(conn)
    maintenance.maybe_auto_rotate_invite_code()  # catch anything overdue from while the server was down
    maintenance.prune_old_activity_log()
    maintenance.prune_old_failed_logins()
    maintenance.prune_idle_sessions()
    maintenance.maybe_run_scheduled_backup()


def _safety_backup(pending_ids):
    print(f"Pending data migrations {pending_ids}: taking a safety backup first")
    maintenance.create_full_backup()


@asynccontextmanager
async def lifespan(app):
    # Captured before anything can publish SSE events from a worker thread.
    events.main_event_loop = asyncio.get_running_loop()
    await asyncio.to_thread(run_startup_work)
    # Held in a variable: the event loop keeps only a weak reference to tasks,
    # so a fire-and-forget task can be garbage-collected mid-flight.
    task = asyncio.create_task(maintenance.periodic_maintenance_loop())
    try:
        yield
    finally:
        task.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title="Coop Ledger", lifespan=lifespan)
    middleware.install(app, config.CORS_ALLOWED_ORIGINS)

    # ORDER MATTERS. Specific /api/... routes first; the generic
    # /api/{resource} catch-alls last, or they swallow routes like
    # DELETE /api/integrations/key and GET /api/events.
    for r in (
        health_router,
        routes_coops.router,
        routes_admin.router,
        photos.router,
        routes_birds.router,
        auth.router,
        events.router,
        push.router,
        integrations.router,
        routes_resources.router,
    ):
        app.include_router(r)

    # Photo files live under DATA_DIR (outside static/), served at /photos --
    # authenticated by AuthMiddleware like any other API data.
    app.mount("/photos", StaticFiles(directory=config.PHOTOS_DIR), name="photos")
    # This catch-all mount must stay LAST -- anything registered after it is
    # shadowed by the static file handler and 404s.
    app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
    return app


app = create_app()
