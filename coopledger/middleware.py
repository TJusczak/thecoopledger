"""Plain-ASGI middleware (never BaseHTTPMiddleware: it buffers response bodies,
which would hang the never-ending /api/events stream)."""
from urllib.parse import parse_qs

from starlette.datastructures import MutableHeaders
from fastapi.responses import JSONResponse

from .db import get_db, now_iso

# The app shell files below MUST never be cached by an intermediate proxy
# (Cloudflare, etc.) or the browser's own HTTP cache -- not just because
# stale content is annoying, but because sw.js specifically is how the
# browser detects there's a new version at all. If a CDN or browser caches
# THAT file, updates silently stop being detected, no matter how many times
# a deploy actually ships new code. A short max-age here means a browser
# won't even contact the server again for up to a minute after its last
# load of these -- still shows a fresh deploy within that same minute (
# negligible for how often this app actually changes), but avoids a full
# re-download of app.js + style.css (roughly 380KB combined) on every
# single page load, which no-store was forcing even for someone reloading
# twice in a row. That matters if this is ever reachable by more than a
# handful of people at once -- request volume and bandwidth both drop for
# free, without giving up "a fresh deploy shows up fast."
NO_CACHE_PATHS = {"/", "/sw.js", "/manifest.json", "/app.js", "/style.css", "/index.html"}


class NoCacheMiddleware:
    """A plain ASGI middleware, not @router.middleware("http") (which is
    BaseHTTPMiddleware under the hood). BaseHTTPMiddleware has a
    well-documented issue: to let middleware inspect/modify a response, it
    has to reconstruct a full Response object, which in practice means
    buffering the entire body before anything is sent to the client. That's
    harmless for a normal quick response, but fatal for /api/events, whose
    whole point is staying open indefinitely -- a response that never
    finishes can never finish buffering, so the connection just hangs from
    the browser's point of view. This version operates directly on the raw
    ASGI send callable and never reconstructs a response, so a streaming
    path that isn't in NO_CACHE_PATHS passes through completely untouched,
    byte for byte, as it arrives -- there's nothing here that *could*
    buffer it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] not in NO_CACHE_PATHS:
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "public, max-age=60"
            await send(message)

        await self.app(scope, receive, send_wrapper)




class SecurityHeadersMiddleware:
    """Same non-buffering ASGI pattern as NoCacheMiddleware above -- only
    mutates headers on http.response.start, never touches the body, so
    streaming responses (/api/events, backup downloads) pass through
    untouched. The headers themselves are the conservative, break-nothing
    set:

    - X-Content-Type-Options: nosniff -- the companion to the magic-byte
      check on photo uploads. Even if something non-image ever ended up
      under /photos/, the browser is told to trust the declared image/*
      type rather than sniffing the bytes and potentially executing them.
    - X-Frame-Options: DENY -- nothing about this app belongs in someone
      else's iframe (the Android TWA is not an iframe and is unaffected).
    - Referrer-Policy: same-origin -- photo URLs carry ?token=... for
      <img> loading; this keeps them from leaking to any external site a
      note or link might ever point at.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["Referrer-Policy"] = "same-origin"
            await send(message)

        await self.app(scope, receive, send_wrapper)




# Paths that must stay reachable with no login at all: the login endpoint
# itself (chicken-and-egg otherwise), and the plain reachability check used
# by the "Test connection" button and the online/offline indicator.
PUBLIC_API_PATHS = {"/api/auth/login", "/api/health"}
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Technically a write (deleting your own session row), but blocking it for
# a read-only role would trap someone in a session they can't get out of --
# logging out is always allowed regardless of role.
ALWAYS_ALLOWED_WRITE_PATHS = {"/api/auth/logout"}


class AuthMiddleware:
    """Also a plain ASGI middleware (same reasoning as NoCacheMiddleware
    above) -- this one only ever inspects the request and, when rejecting,
    sends its own complete response; it never wraps or reconstructs the
    downstream response, so it can't introduce any buffering risk for
    /api/events either. Gates every /api/* route except the two paths
    above, AND every /photos/* route -- uploaded photos are real personal
    data (and the whole reason this exists is that a photo URL, once seen
    anywhere, would otherwise stay permanently and publicly fetchable
    forever, with no invite code required, regardless of how the rest of
    the app is locked down). Only the app shell itself (HTML/CSS/JS,
    manifest, service worker, Digital Asset Links) stays unauthenticated,
    since that much has to be reachable just to render a login screen in
    the first place -- none of it is coop data.

    Also enforces role-based write access here, in this same central
    place, rather than in each individual endpoint -- a read-only session
    can authenticate and read everything, but any write method
    (POST/PUT/PATCH/DELETE) gets rejected with 403 before it ever reaches
    an endpoint handler. The actual security boundary for this shouldn't
    depend on every write endpoint separately remembering to check
    permissions; one shared gate that's already proven itself (the login
    check right below) is far harder to accidentally bypass by adding a
    new endpoint later and forgetting the check.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        is_protected = path.startswith("/api/") or path.startswith("/photos/")
        # The integration feed authenticates with its own long-lived API key
        # (checked inside the route), so it must bypass the session gate --
        # a polling client like Home Assistant can't hold a login session.
        # Only the read-only stats path is exempt; key management still
        # requires an admin session.
        if path == "/api/integrations/stats":
            is_protected = False
        if (
            scope["type"] != "http"
            or scope["method"] == "OPTIONS"  # CORS preflight requests never carry auth headers by design
            or not is_protected
            or path in PUBLIC_API_PATHS
        ):
            await self.app(scope, receive, send)
            return

        headers = dict(scope["headers"])
        auth_header = headers.get(b"authorization", b"").decode()
        token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None
        if not token:
            query_params = parse_qs(scope.get("query_string", b"").decode())
            token = query_params.get("token", [None])[0]

        role = None
        touch = False
        if token:
            with get_db(write=False) as conn:
                row = conn.execute("SELECT role, last_activity FROM sessions WHERE token = ?", (token,)).fetchone()
            if row:
                role = row["role"]
                # Keep last_activity current so idle-session expiry (and the
                # Sessions list on the Server page) reflects reality -- most
                # requests only ever pass through here, not through
                # require_auth. Throttled to once an hour per session so this
                # stays one cheap read per request, not a write per request.
                last = row["last_activity"]
                touch = not last or (now_iso()[:13] != last[:13])  # different UTC hour
        if touch:
            with get_db() as conn:
                conn.execute("UPDATE sessions SET last_activity = ? WHERE token = ?", (now_iso(), token))

        if role is None:
            response = JSONResponse({"detail": "Not logged in"}, status_code=401)
            await response(scope, receive, send)
            return

        if role == "readonly" and scope["method"] in WRITE_METHODS and path not in ALWAYS_ALLOWED_WRITE_PATHS:
            response = JSONResponse({"detail": "Read-only access -- this action isn't available"}, status_code=403)
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)




def install(app, cors_origins):
    """Attach middleware to `app`. Order matters: Starlette wraps in reverse,
    so the LAST one added is the OUTERMOST.

    CORS goes last (outermost) on purpose: it then decorates every response,
    including a 401 from AuthMiddleware -- otherwise a cross-origin client (a
    wrapped app pointed at a separately-hosted server) couldn't read the
    rejection at all, because browsers hide cross-origin response bodies that
    lack CORS headers regardless of status code.
    """
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(NoCacheMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(AuthMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
