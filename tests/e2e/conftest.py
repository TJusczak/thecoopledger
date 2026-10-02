"""End-to-end harness: a REAL uvicorn process + a real Chromium, driven like a user.

    pip install playwright && playwright install chromium     (once)
    pytest -m e2e

The page under test is the real app. Because it is a set of classic scripts, its
functions (localBirdCreate, syncResource, ...) are globals, so tests can seed data
and force a sync directly instead of waiting out the 60 s background timer -- while
the things being asserted (what reached the server, what survives a reload, what the
user sees) are all real.
"""
import glob
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import pytest

pytest.importorskip("playwright.sync_api", reason="e2e tests need playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _chromium_path():
    if os.environ.get("CHROMIUM_PATH"):
        return os.environ["CHROMIUM_PATH"]
    base = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")
    for pattern in (f"{base}/chromium/chrome-linux/chrome", f"{base}/chromium-*/chrome-linux/chrome", f"{base}/chromium"):
        hits = sorted(glob.glob(pattern))
        if hits and os.path.isfile(hits[-1]):
            return hits[-1]
    return None  # let Playwright use its own managed browser


class Server:
    def __init__(self, url, data_dir, code, proc):
        self.url, self.data_dir, self.code, self.proc = url, data_dir, code, proc
        self._token = None

    @property
    def headers(self):
        if not self._token:
            r = httpx.post(f"{self.url}/api/auth/login", json={"name": "e2e-api", "code": self.code})
            self._token = r.json()["token"]
        return {"Authorization": f"Bearer {self._token}"}

    def api(self, method, path, **kw):
        r = httpx.request(method, f"{self.url}{path}", headers=self.headers, timeout=15, **kw)
        r.raise_for_status()
        return r.json()

    def rows(self, resource, coop_id=None):
        q = f"?coop_id={coop_id}" if coop_id else ""
        return self.api("GET", f"/api/{resource}{q}")


@pytest.fixture(scope="session")
def server():
    data_dir = Path(tempfile.mkdtemp(prefix="coop-e2e-"))
    port = _free_port()
    env = {**os.environ, "DATA_DIR": str(data_dir), "BACKUPS_ENABLED": "false"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--port", str(port), "--log-level", "warning"],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{url}/api/health", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("server did not start:\n" + (proc.stdout.read().decode() if proc.stdout else ""))
    code = (data_dir / "invite_code.txt").read_text().strip()
    yield Server(url, data_dir, code, proc)
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=_chromium_path(), args=["--no-sandbox"])
        yield b
        b.close()


# Failures caused by the sandbox/CI network, not the app: Google Fonts is unreachable.
_IGNORED_CONSOLE = ("ERR_CERT_AUTHORITY_INVALID", "fonts.g", "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION", "ERR_TUNNEL", "Failed to load resource")


class Device:
    """One browser profile = one phone/laptop. Wraps the page with the few
    operations the tests need, and records every uncaught JS error."""

    def __init__(self, ctx, page, errors):
        self.ctx, self.page, self.errors = ctx, page, errors

    def eval(self, js, arg=None):
        return self.page.evaluate(js, arg)

    # -- lifecycle
    # Choosing a mode makes the app reload itself ("cleanest way to restart the whole app"),
    # so each of these waits for that navigation and for the new page's scripts.
    def ready(self):
        self.page.wait_for_function("typeof checkForAppUpdate === 'function' && typeof switchTab === 'function'", timeout=15000)

    def local_only(self, name="Tester"):
        self.page.fill("#gs_name", name)
        with self.page.expect_navigation():
            self.page.click("#gs_local")
        self.ready()
        assert self.eval("localOnlyMode") is True

    def login(self, server, name="Tester"):
        self.page.click("#gs_toggle_server")
        self.page.fill("#gs_name", name)
        self.page.fill("#gs_code", server.code)
        with self.page.expect_navigation(timeout=15000):
            self.page.click("#gs_connect")
        self.ready()
        assert self.eval("localOnlyMode") is False

    # -- helpers over the app's own globals
    def sync_all(self):
        self.eval("""async () => {
            await syncResource('coops', null);
            if (currentCoopId) for (const r of LOCAL_FIRST_RESOURCES) if (r !== 'coops') await syncResource(r, currentCoopId);
            await loadCoopData();
        }""")

    def create_coop(self, name):
        coop_id = self.eval("""async (name) => {
            const c = await localCoopCreate({ name, created_date: '2024-01-01' });
            await loadCoops();
            await switchCoop(c.id);
            return c.id;
        }""", name)
        return coop_id

    def join_coop(self, coop_id):
        self.eval("""async (id) => { await loadCoops(); await switchCoop(id); }""", coop_id)

    def outbox(self):
        return self.eval("async () => (await getOutbox()).filter(o => o.resource !== 'activity_log').length")

    def local(self, store):
        return self.eval("async (s) => await localGetAll(s, currentCoopId)", store)

    def offline(self, on=True):
        self.ctx.set_offline(on)

    def assert_no_js_errors(self):
        real = [e for e in self.errors if not any(i in e for i in _IGNORED_CONSOLE)]
        assert not real, "uncaught JS errors:\n" + "\n".join(real)


@pytest.fixture()
def make_device(browser, server):
    made = []

    def factory(width=1280, height=800):
        ctx = browser.new_context(viewport={"width": width, "height": height})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)
        page.goto(server.url + "/")
        # The first-run screen can paint while later scripts are still loading, so wait
        # for the LAST script's functions (pwa.js) before touching any app global.
        d = Device(ctx, page, errors)
        d.ready()
        page.wait_for_selector("#gs_local, #tabs", state="attached", timeout=10000)
        made.append(d)
        return d

    yield factory
    for d in made:
        d.ctx.close()
