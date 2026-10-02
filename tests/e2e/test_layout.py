"""The app shell: a sidebar layout on wide screens, the original bottom-tab-bar layout on narrow ones."""
import pytest

pytestmark = pytest.mark.e2e


def box(d, selector):
    return d.eval("""(sel) => { const e = document.querySelector(sel); if (!e) return null;
        const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom,
        display: getComputedStyle(e).display, position: getComputedStyle(e).position }; }""", selector)


def seed_two_coops(d):
    d.eval("""async () => {
        const a = await localCoopCreate({ name: 'Home Flock', created_date: '2024-03-01' });
        const b = await localCoopCreate({ name: 'Meat Birds 2026', created_date: '2026-05-01' });
        await loadCoops(); await switchCoop(a.id);
        for (let i = 0; i < 40; i++) await localBirdCreate({ coop_id: a.id, name: 'Layer ' + i, type: 'Layer', status: 'Active' }, { suppressUndo: true });
        await localBirdCreate({ coop_id: b.id, name: 'Broiler One', type: 'Meat', status: 'Active' }, { suppressUndo: true });
        await refreshAndRender();
        window.__coops = { a: a.id, b: b.id };
    }""")


@pytest.fixture()
def wide(make_device):
    d = make_device(1280, 800)
    d.local_only()
    seed_two_coops(d)
    return d


# ------------------------------------------------------------------ wide layout

def test_sidebar_is_on_the_left_and_content_to_its_right(wide):
    sb, content = box(wide, "#sidebar"), box(wide, ".content")
    assert sb["x"] == 0 and 230 <= sb["w"] <= 280
    assert sb["h"] >= 795, "sidebar spans the full viewport height"
    assert content["x"] >= sb["w"] - 1


def test_nav_is_a_vertical_list_inside_the_sidebar(wide):
    tabs = wide.eval("""[...document.querySelectorAll('#sidebar .tab')].map(t => { const r = t.getBoundingClientRect(); return [t.dataset.tab, r.x, r.y]; })""")
    assert [t[0] for t in tabs] == ["dashboard", "flock", "eggs", "bedding", "expenses", "settings"]
    assert len({round(t[1]) for t in tabs}) == 1, "all nav items share one x: a column, not a row"
    ys = [t[2] for t in tabs]
    assert ys == sorted(ys) and len(set(ys)) == 6


def test_status_lives_in_the_sidebar(wide):
    for sel in ("#connIndicator", "#globalSearchBtn", "#statusBannerSlot", "#coopSwitcher", "#syncIndicator", "#undoRedoSlot"):
        assert wide.eval("(s) => !!document.querySelector('#sidebar ' + s)", sel), f"{sel} should be inside the sidebar"


def test_page_header_names_the_section_and_the_coop(wide):
    for tab, label in (("flock", "Flock"), ("eggs", "Eggs"), ("expenses", "Finances"), ("settings", "Settings")):
        wide.eval("(t) => switchTab(t)", tab)
        assert wide.page.inner_text("#pageTitle") == label
        assert wide.page.inner_text("#pageSub") == "Home Flock"
        assert wide.page.get_attribute(f".tab[data-tab='{tab}']", "aria-current") == "page"
        assert wide.eval("document.querySelectorAll('.tab[aria-current]').length") == 1


@pytest.mark.parametrize("tab,subnav,expected", [
    ("dashboard", "#coopSubNav", ["Overview", "Year Review", "All-Time Stats"]),
    ("flock", "#flockSubNav", ["Birds", "Notes", "Health"]),
    ("eggs", "#eggsSubNav", ["Eggs", "Hatching"]),
    ("bedding", "#supplySubNav", ["Inventory", "Freshness", "Products"]),
    ("settings", "#settingsSubNav", ["Coops", "Connection", "Activity", "App"]),
])
def test_subtabs_run_along_the_top_of_the_content_pane(wide, tab, subnav, expected):
    wide.eval("(t) => switchTab(t)", tab)
    labels = wide.eval("(s) => [...document.querySelectorAll(s + ' .range-btn')].map(b => b.textContent.trim())", subnav)
    assert labels[:len(expected)] == expected
    nav, header, content = box(wide, subnav), box(wide, "#pageHeader"), box(wide, ".content")
    assert nav["x"] >= content["x"] - 1, "sub-tabs sit in the content pane, not the sidebar"
    assert nav["y"] >= header["b"] - 1, "directly under the page header"
    xs = wide.eval("(s) => [...document.querySelectorAll(s + ' .range-btn')].map(b => b.getBoundingClientRect().y)", subnav)
    assert max(xs) - min(xs) < 2, "one horizontal row"


def test_subtabs_stay_pinned_while_a_long_page_scrolls(wide):
    wide.eval("() => switchTab('flock')")
    wide.page.mouse.move(700, 500)
    wide.page.mouse.wheel(0, 900)
    wide.page.wait_for_timeout(250)
    assert wide.eval("window.scrollY") > 300, "the page really did scroll"
    nav = box(wide, "#flockSubNav")
    assert -1 <= nav["y"] <= 2, f"sub-tabs should pin to the top, got y={nav['y']}"
    assert wide.page.locator("#flockSubNav").is_visible()
    # the sidebar doesn't scroll away with the page
    assert box(wide, "#sidebar")["y"] == 0


def test_clicking_a_subtab_switches_the_content(wide):
    wide.eval("() => switchTab('flock')")
    before = wide.page.inner_text("#panel-flock")
    wide.page.click("#flockSubNav >> text=Health")
    wide.page.wait_for_function("flockSubTab === 'health'")
    assert wide.page.inner_text("#panel-flock") != before
    assert wide.page.locator("#flockSubNav .range-btn.active").inner_text() == "Health"
    wide.assert_no_js_errors()


def test_keyboard_can_reach_nav_and_subtabs(wide):
    wide.page.focus(".tab[data-tab='eggs']")
    wide.page.keyboard.press("Enter")
    wide.page.wait_for_function("activeTab === 'eggs'")
    wide.page.focus("#eggsSubNav .range-btn:nth-child(2)")
    wide.page.keyboard.press("Enter")
    wide.page.wait_for_function("eggsSubTab === 'hatching'")


# --------------------------------------------------------------- coop switcher

def test_coop_switcher_lists_coops_and_switches(wide):
    assert "Home Flock" in wide.page.inner_text("#coopHeaderName")
    wide.page.click("#coopSwitcher")
    menu = wide.page.locator("#coopMenu")
    assert menu.is_visible()
    assert wide.page.get_attribute("#coopSwitcher", "aria-expanded") == "true"
    items = wide.page.locator(".coop-menu-item[data-coop-id]").all_inner_texts()
    assert any("Home Flock" in i for i in items) and any("Meat Birds 2026" in i for i in items)
    assert wide.page.get_attribute(".coop-menu-item.current", "aria-checked") == "true"

    wide.page.keyboard.press("Escape")
    wide.eval("() => switchTab('flock')")
    wide.page.click("#coopSwitcher")
    wide.page.click(".coop-menu-item[data-coop-id]:has-text('Meat Birds 2026')")
    wide.page.wait_for_function("currentCoopId === window.__coops.b")
    assert menu.is_hidden()
    wide.page.wait_for_function("document.querySelector('#coopHeaderName').innerText.includes('Meat Birds 2026')")
    assert wide.page.inner_text("#pageSub") == "Meat Birds 2026"
    wide.page.wait_for_function("document.querySelector('#panel-flock').innerText.includes('Broiler One')")
    assert "Layer 1" not in wide.page.inner_text("#panel-flock")
    wide.assert_no_js_errors()


def test_coop_menu_closes_on_escape_and_outside_click(wide):
    wide.page.click("#coopSwitcher")
    wide.page.keyboard.press("Escape")
    assert wide.page.locator("#coopMenu").is_hidden()
    wide.page.click("#coopSwitcher")
    wide.page.click(".page-header-title")
    assert wide.page.locator("#coopMenu").is_hidden()


def test_manage_coops_goes_to_settings(wide):
    wide.page.click("#coopSwitcher")
    wide.page.click("[data-manage-coops]")
    wide.page.wait_for_function("activeTab === 'settings' && settingsSubTab === 'coops'")


# --------------------------------------------------------------- narrow layouts

@pytest.mark.parametrize("size", [(390, 800), (820, 1000)])
def test_narrow_screens_keep_the_bottom_tab_bar(make_device, size):
    d = make_device(*size)
    d.local_only()
    seed_two_coops(d)
    tabs = box(d, "#tabs")
    assert tabs["position"] == "fixed"
    assert abs(tabs["b"] - size[1]) <= 1, "tab bar is pinned to the bottom edge"
    assert box(d, "#sidebar")["display"] == "contents", "no sidebar box on narrow screens"
    assert d.eval("getComputedStyle(document.querySelector('#pageHeader')).display") == "none"
    d.eval("() => switchTab('flock')")
    nav = box(d, "#flockSubNav")
    assert nav["position"] == "fixed" and nav["b"] <= tabs["y"] + 1, "sub-tabs sit directly above the tab bar"
    d.assert_no_js_errors()


def test_the_coop_switcher_works_on_narrow_screens_too(make_device):
    d = make_device(390, 800)
    d.local_only()
    seed_two_coops(d)
    d.page.click("#coopSwitcher")
    assert d.page.locator("#coopMenu").is_visible()
    m = box(d, "#coopMenu")
    assert m["x"] >= 0 and m["r"] <= 390, "menu fits inside the phone screen"
    d.page.click(".coop-menu-item[data-coop-id]:has-text('Meat Birds 2026')")
    d.page.wait_for_function("currentCoopId === window.__coops.b")


# ------------------------------------------------------------------- onboarding

@pytest.mark.parametrize("size", [(1280, 800), (390, 800)])
def test_first_run_hides_navigation_there_is_nothing_to_navigate_yet(make_device, size):
    d = make_device(*size)
    assert d.page.locator("#gs_local").is_visible()
    assert d.page.locator("#tabs").is_hidden()
    assert d.page.locator("#coopSwitcher").is_hidden()
    assert d.page.locator("#pageHeader").is_hidden()
    d.assert_no_js_errors()
