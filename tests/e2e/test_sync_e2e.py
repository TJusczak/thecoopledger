"""Sync, end to end: real browsers, real server, real network conditions."""
import pytest

pytestmark = pytest.mark.e2e


def bird(d, **fields):
    return d.eval("async (f) => await localBirdCreate({ coop_id: currentCoopId, type: 'Layer', status: 'Active', ...f }, { suppressUndo: true })", fields)


def rename(d, bird_id, **fields):
    return d.eval("async ([id, f]) => await localBirdUpdate(id, f, { suppressUndo: true })", [bird_id, fields])


def server_bird(server, coop_id, bird_id):
    return next((b for b in server.rows("birds", coop_id) if b["id"] == bird_id), None)


def test_login_create_and_it_reaches_the_server(make_device, server):
    d = make_device()
    d.login(server)
    coop = d.create_coop("Synced Coop")
    b = bird(d, name="Henrietta")
    d.sync_all()
    assert d.outbox() == 0
    assert server_bird(server, coop, b["id"])["name"] == "Henrietta"
    d.assert_no_js_errors()


def test_offline_changes_queue_then_drain_when_back_online(make_device, server):
    d = make_device()
    d.login(server)
    coop = d.create_coop("Offline Coop")
    d.sync_all()

    d.offline(True)
    b = bird(d, name="Written offline")
    rename(d, b["id"], breed="Cochin")
    assert d.outbox() >= 2
    assert server_bird(server, coop, b["id"]) is None            # genuinely not on the server yet
    assert any(x["name"] == "Written offline" for x in d.local("birds"))  # but fully usable locally

    d.offline(False)
    d.sync_all()
    assert d.outbox() == 0
    row = server_bird(server, coop, b["id"])
    assert (row["name"], row["breed"]) == ("Written offline", "Cochin")
    d.assert_no_js_errors()


def test_offline_changes_survive_a_reload_even_with_no_connection(make_device, server):
    """The headline PWA claim: once loaded, the app (and the user's unsent work) survives a
    reload with the network completely gone -- shell from the service worker's cache, data
    and outbox from IndexedDB."""
    d = make_device()
    d.login(server)
    coop = d.create_coop("Durable Coop")
    d.sync_all()
    # wait until the service worker controls the page and has cached the shell
    d.page.evaluate("navigator.serviceWorker.ready.then(() => true)")
    d.page.reload(); d.ready()
    d.page.wait_for_function("!!navigator.serviceWorker.controller", timeout=10000)

    d.offline(True)
    b = bird(d, name="Survives reload")
    d.page.reload()                       # no network at all
    d.ready()
    assert d.outbox() >= 1, "the queued change must persist across an offline reload"
    assert any(x["name"] == "Survives reload" for x in d.eval("async () => await localGetAll('birds', localStorage.getItem(COOP_KEY))"))

    d.offline(False)
    d.sync_all()
    assert d.outbox() == 0
    assert server_bird(server, coop, b["id"])["name"] == "Survives reload"
    d.assert_no_js_errors()


def test_a_second_device_sees_changes_and_edits_to_different_fields_both_survive(make_device, server):
    a, b = make_device(), make_device()
    a.login(server, "Alice")
    b.login(server, "Bob")
    coop = a.create_coop("Shared Coop")
    hen = bird(a, name="Original", breed="Orpington")
    a.sync_all()
    b.join_coop(coop)
    b.sync_all()
    assert any(x["id"] == hen["id"] for x in b.local("birds")), "device B should receive A's bird"

    # both edit while apart, touching DIFFERENT fields of the same record
    a.offline(True); b.offline(True)
    rename(a, hen["id"], name="Renamed by Alice")
    rename(b, hen["id"], breed="Bantam")
    a.offline(False); b.offline(False)
    a.sync_all(); b.sync_all(); a.sync_all()

    final = server_bird(server, coop, hen["id"])
    assert (final["name"], final["breed"]) == ("Renamed by Alice", "Bantam"), "neither edit may be lost"
    for dev in (a, b):
        local = next(x for x in dev.local("birds") if x["id"] == hen["id"])
        assert (local["name"], local["breed"]) == ("Renamed by Alice", "Bantam")
    a.assert_no_js_errors(); b.assert_no_js_errors()


def test_a_delete_on_one_device_reaches_the_other(make_device, server):
    a, b = make_device(), make_device()
    a.login(server, "Alice"); b.login(server, "Bob")
    coop = a.create_coop("Delete Coop")
    hen = bird(a, name="Doomed")
    a.sync_all(); b.join_coop(coop); b.sync_all()
    assert any(x["id"] == hen["id"] for x in b.local("birds"))
    a.eval("async (id) => await localBirdDelete(id, currentCoopId)", hen["id"])
    a.sync_all(); b.sync_all()
    assert not any(x["id"] == hen["id"] for x in b.local("birds")), "the tombstone must remove it on the other device"


def test_a_pending_local_edit_is_not_reverted_by_a_pull(make_device, server):
    """The push is blocked (server answers 503), so the edit stays queued; a pull in
    that state used to overwrite the local copy with the server's older one."""
    d = make_device()
    d.login(server)
    coop = d.create_coop("Rebase Coop")
    hen = bird(d, name="Before")
    d.sync_all()

    d.page.route("**/api/birds/*", lambda route: route.fulfill(status=503, body="{}") if route.request.method == "PUT" else route.continue_())
    rename(d, hen["id"], name="Edited locally")
    d.eval("async () => { await pushOutbox(); await pullChanges('birds', currentCoopId); STATE.birds = await localGetAll('birds', currentCoopId); }")
    assert d.outbox() >= 1, "503 is transient: the change must stay queued"
    assert next(x for x in d.eval("STATE.birds") if x["id"] == hen["id"])["name"] == "Edited locally"
    assert server_bird(server, coop, hen["id"])["name"] == "Before"

    d.page.unroute("**/api/birds/*")
    d.sync_all()
    assert server_bird(server, coop, hen["id"])["name"] == "Edited locally"


def test_a_change_the_server_refuses_is_reported_not_silently_dropped(make_device, server):
    d = make_device()
    d.login(server)
    d.create_coop("Reject Coop")
    d.sync_all()
    # A syntactically valid id the server will refuse (400): it contains a space.
    d.eval("""async () => {
        const rec = { id: 'bad id', coop_id: currentCoopId, name: 'x', updated_at: new Date().toISOString(), deleted_at: null };
        await localPutMany('birds', [rec]);
        await queueOutbox({ resource: 'birds', op: 'create', id: rec.id, payload: rec });
    }""")
    d.sync_all()
    assert d.outbox() == 0, "a permanently-refused change must not block the queue"
    rejected = d.eval("getRejectedChanges()")
    assert len(rejected) == 1 and rejected[0]["status"] == 400 and rejected[0]["resource"] == "birds"
    # ...and the user can see it in Settings -> Connection
    d.eval("() => { switchTab('settings'); settingsSubTab = 'connection'; renderSettingsHub(); }")
    d.page.wait_for_selector(".rejected-changes", timeout=5000)
    assert "refused by the server" in d.page.inner_text(".rejected-changes")
    d.page.click("#dismissRejectedBtn")
    d.page.wait_for_selector(".rejected-changes", state="detached")
    d.assert_no_js_errors()


def test_a_restored_server_backup_triggers_a_full_resync(make_device, server):
    """If the server's database is restored from an older backup, its clock is behind every
    client's cursor. Pulling 'since' a future cursor would return nothing forever."""
    d = make_device()
    d.login(server)
    coop = d.create_coop("Restore Coop")
    hen = bird(d, name="Keep me")
    d.sync_all()
    d.eval("async () => await setLastSync('birds', currentCoopId, '2999-01-01T00:00:00.000000+00:00')")  # cursor from the 'future'
    # wipe the local copy so only a genuine re-pull can bring the row back
    d.eval("async () => { const db = await openLocalDb(); const tx = db.transaction('birds', 'readwrite'); tx.objectStore('birds').clear(); await idbDone(tx); }")
    rows = d.eval("async () => (await pullChanges('birds', currentCoopId)).length")
    assert rows >= 1
    assert any(x["id"] == hen["id"] for x in d.eval("async () => await localGetAll('birds', currentCoopId)"))
    cursor = d.eval("async () => await getLastSync('birds', currentCoopId)")
    assert cursor < "2999", "the cursor must come back to the server's own clock"
    assert server_bird(server, coop, hen["id"])


def test_large_history_pulls_in_pages(make_device, server):
    """A new device joining a coop with years of history gets it as a series of bounded
    requests (and keeps a cursor per page), not one enormous response."""
    coop = server.api("POST", "/api/coops", json={"name": "Paged Coop"})["id"]
    items = [{"id": f"pg{i:04d}", "coop_id": coop, "name": f"P{i}"} for i in range(2300)]
    for i in range(0, len(items), 1000):
        server.api("POST", "/api/birds/bulk-create", json={"items": items[i:i + 1000]})

    d = make_device()
    d.login(server)
    page_requests = []
    d.page.on("request", lambda r: page_requests.append(r.url) if "/api/sync/birds" in r.url else None)
    d.join_coop(coop)
    d.sync_all()
    assert len(d.eval("async () => await localGetAll('birds', currentCoopId)")) == 2300
    paged = [u for u in page_requests if "limit=1000" in u]
    assert len(paged) >= 3, f"expected the history to arrive in >= 3 pages, saw {len(paged)} requests"
    d.assert_no_js_errors()
