"""The app loads, every screen renders, and nothing throws -- the net under the
frontend split and the layout work."""
import pytest

pytestmark = pytest.mark.e2e

TABS = ["dashboard", "flock", "eggs", "bedding", "expenses", "settings"]


def seed(d):
    d.eval("""async () => {
        const c = await localCoopCreate({ name: 'Home Flock', created_date: '2024-03-01' });
        await loadCoops(); await switchCoop(c.id);
        for (const n of ['Henrietta', 'Clucky']) await localBirdCreate({ coop_id: currentCoopId, name: n, type: 'Layer', status: 'Active', gender: 'Hen' }, { suppressUndo: true });
        for (let i = 0; i < 5; i++) await localEggCreate({ coop_id: currentCoopId, date: new Date(Date.now() - i * 864e5).toISOString().slice(0, 10), count: 2 + i }, { suppressUndo: true });
        await localExpenseCreate({ coop_id: currentCoopId, date: new Date().toISOString().slice(0, 10), category: 'Feed', description: 'Pellets', amount: 24.5, entry_type: 'expense' }, { suppressUndo: true });
        await refreshAndRender();
    }""")


def test_first_run_screen_renders(make_device):
    d = make_device()
    assert d.page.locator("#gs_local").is_visible()
    d.assert_no_js_errors()


def test_every_tab_renders_with_data_and_no_errors(make_device):
    d = make_device()
    d.local_only()
    seed(d)
    for tab in TABS:
        d.eval("(t) => switchTab(t)", tab)
        d.page.wait_for_timeout(150)
        assert d.page.locator(f"#panel-{tab}").is_visible(), tab
        assert d.page.locator(f"#panel-{tab}").inner_text().strip(), f"{tab} rendered empty"
    d.assert_no_js_errors()


def test_data_survives_a_reload_in_local_only_mode(make_device):
    d = make_device()
    d.local_only()
    seed(d)
    d.page.reload()
    d.ready()
    d.page.wait_for_function("STATE && STATE.birds && STATE.birds.length === 2", timeout=10000)
    assert {b["name"] for b in d.eval("STATE.birds")} == {"Henrietta", "Clucky"}
    d.assert_no_js_errors()


@pytest.mark.parametrize("size", [(1280, 800), (900, 700), (390, 800)])
def test_layout_has_no_horizontal_overflow(make_device, size):
    d = make_device(*size)
    d.local_only()
    seed(d)
    for tab in TABS:
        d.eval("(t) => switchTab(t)", tab)
        d.page.wait_for_timeout(120)
        overflow = d.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 1, f"{tab} at {size}: page scrolls sideways by {overflow}px"
    d.assert_no_js_errors()
