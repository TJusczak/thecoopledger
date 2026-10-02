"""Local-only mode: backing up from Settings -> Connection, and the sidebar 'Local only' tag."""
import zipfile

import pytest

pytestmark = pytest.mark.e2e

TAG = "#localOnlyBadge .local-only-badge"


@pytest.fixture()
def dev(make_device):
    d = make_device(1280, 800)
    d.local_only()
    d.eval("""async () => {
        const a = await localCoopCreate({ name: 'Home Flock', created_date: '2024-03-01' });
        await localCoopCreate({ name: 'Meat Birds', created_date: '2026-05-01' });
        await loadCoops(); await switchCoop(a.id);
        await localBirdCreate({ coop_id: a.id, name: 'Henrietta', type: 'Layer', status: 'Active' }, { suppressUndo: true });
        await refreshAndRender();
    }""")
    return d


def open_connection(d):
    d.eval("() => { switchTab('settings'); settingsSubTab = 'connection'; renderSettingsHub(); }")
    d.page.wait_for_selector("#backUpNowBtn")


def recent_backup(d, days_ago=1):
    d.eval("(n) => { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now() - n * 864e5)); renderLocalOnlyBadge(); }", days_ago)


def test_clicking_the_tag_lands_on_a_page_with_a_backup_button(dev):
    # never backed up => already overdue, so the tag is the red 'back up now'
    assert "back up now" in dev.page.inner_text(TAG).lower()
    dev.page.click(TAG)
    dev.page.wait_for_selector("#backUpNowBtn")
    assert "never" in dev.page.inner_text("#lastBackupLine")
    assert "all 2 coops" in dev.page.inner_text("#backUpNowBtn")


def test_back_up_now_downloads_every_coop_and_updates_last_backup_and_tag(dev, tmp_path):
    open_connection(dev)
    downloads = []
    dev.page.on("download", lambda dl: downloads.append(dl))
    dev.page.click("#backUpNowBtn")
    dev.page.wait_for_function("document.getElementById('backUpNowStatus').textContent.startsWith('Backed up')", timeout=20000)
    assert "Backed up 2 coops" in dev.page.inner_text("#backUpNowStatus")
    assert len(downloads) == 2
    names = []
    for i, dl in enumerate(downloads):
        path = tmp_path / f"b{i}.zip"
        dl.save_as(path)
        names.append(dl.suggested_filename)
        assert "data.json" in zipfile.ZipFile(path).namelist(), "each download is a real coop backup"
    assert len(set(names)) == 2
    assert "just now" in dev.page.inner_text("#lastBackupLine")
    assert "backed up today" in dev.page.inner_text(TAG).lower(), "the tag stops saying it needs a backup"
    assert "local-only-badge-overdue" not in dev.page.get_attribute(TAG, "class")
    assert not dev.page.is_disabled("#backUpNowBtn")
    dev.assert_no_js_errors()


def test_the_tag_can_be_hidden_and_stays_hidden_after_a_reload(dev):
    recent_backup(dev)            # a backed-up coop: the calm tag, which is the one that can be hidden
    open_connection(dev)
    assert dev.page.locator(TAG).is_visible()
    dev.page.check("#hideLocalTag")
    dev.page.wait_for_selector(TAG, state="detached")
    dev.page.reload(); dev.ready()
    assert dev.page.locator(TAG).count() == 0
    open_connection(dev)
    assert dev.page.is_checked("#hideLocalTag")
    dev.page.uncheck("#hideLocalTag")
    dev.page.wait_for_selector(TAG)


def test_hiding_the_tag_never_hides_an_overdue_backup_warning(dev):
    recent_backup(dev)
    open_connection(dev)
    dev.page.check("#hideLocalTag")
    dev.page.wait_for_selector(TAG, state="detached")
    # last backup was 40 days ago, reminders on (default, 14 days)
    dev.eval("() => { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now() - 40 * 864e5)); renderLocalOnlyBadge(); }")
    dev.page.wait_for_selector(TAG)
    assert "local-only-badge-overdue" in dev.page.get_attribute(TAG, "class")
    assert "back up now" in dev.page.inner_text(TAG).lower()
    # ...unless the person has deliberately turned reminders off
    dev.eval("() => { setBackupReminderEnabled(false); renderLocalOnlyBadge(); }")
    dev.page.wait_for_selector(TAG, state="detached")


def test_tag_shows_how_long_ago_the_last_backup_was(dev):
    recent_backup(dev, 5)
    assert "backed up 5d ago" in dev.page.inner_text(TAG).lower()
    assert "local-only-badge-overdue" not in dev.page.get_attribute(TAG, "class")


def test_back_up_now_with_no_coops_says_so_instead_of_failing_silently(make_device):
    d = make_device(1280, 800)
    d.local_only()
    d.eval("() => { switchTab('settings'); settingsSubTab = 'connection'; renderSettingsHub(); }")
    d.page.wait_for_selector("#backUpNowBtn")
    messages = []
    d.page.on("dialog", lambda dlg: (messages.append(dlg.message), dlg.accept()))
    d.page.click("#backUpNowBtn")
    d.page.wait_for_function("true")
    d.page.wait_for_timeout(500)
    assert messages and "no coops" in messages[0].lower()
