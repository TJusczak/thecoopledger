"""Server-Sent Events: a tiny "go pull now" nudge to every connected device."""
import asyncio

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from .db import on_commit

router = APIRouter()

sse_subscribers: dict[str, list[asyncio.Queue]] = {}
main_event_loop: asyncio.AbstractEventLoop | None = None


def safe_put(q: asyncio.Queue, resource: str):
    try:
        q.put_nowait(resource)
    except asyncio.QueueFull:
        pass  # a slow/stuck subscriber shouldn't block everyone else


# Coop-level events (create, rename, delete a coop) don't have a natural
# single coop_id to scope to the way birds/eggs/etc do -- a rename should
# reach anyone connected regardless of which coop they currently have
# selected, since the Coops list itself isn't scoped to one active coop.
# Every SSE connection subscribes to this in addition to its own coop_id.
GLOBAL_CHANNEL = "_global_"


def _deliver(coop_id: str, resource: str):
    # The mutating endpoints are plain `def`, so FastAPI runs them in a worker
    # thread, not on the event loop the SSE connections live on. asyncio.Queue
    # isn't thread-safe -- calling put_nowait() from that thread doesn't
    # reliably wake a waiting get() on the main loop. call_soon_threadsafe is
    # the correct way to hand work back to the loop.
    loop = main_event_loop
    if not loop:
        return
    for q in list(sse_subscribers.get(coop_id, [])):
        loop.call_soon_threadsafe(safe_put, q, resource)


def sse_publish(coop_id: str | None, resource: str):
    """Nudge every device connected for `coop_id` to pull `resource`.

    Deferred until the surrounding transaction commits (see db.on_commit):
    announcing before the commit lets a fast client pull, see nothing new,
    and then wait out its whole poll interval for a change that already exists.
    """
    if not coop_id:
        return
    on_commit(lambda: _deliver(coop_id, resource))


@router.get("/api/events")
async def sse_events(coop_id: str):
    queue: asyncio.Queue = asyncio.Queue(maxsize=50)
    sse_subscribers.setdefault(coop_id, []).append(queue)
    sse_subscribers.setdefault(GLOBAL_CHANNEL, []).append(queue)

    async def event_stream():
        try:
            yield ": connected\n\n"  # comment-only event, just confirms the stream is actually open
            while True:
                try:
                    resource = await asyncio.wait_for(queue.get(), timeout=25)
                    yield f"data: {resource}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"  # comment ping so idle proxies/load balancers don't close the connection
        finally:
            sse_subscribers[coop_id].remove(queue)
            sse_subscribers[GLOBAL_CHANNEL].remove(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


GLOBAL_CHANNEL = "_global_"
