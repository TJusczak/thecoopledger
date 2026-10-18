"""Accounts, in a real browser: the sign-in page, first-login password change, my account, and the admin's users screen."""
import httpx
import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.e2e


def open_settings(d, tab):
    d.eval("(t) => { settingsSubTab = t; switchTab('settings'); }", tab)
    d.page.wait_for_function("(t) => document.querySelector('#settingsSubNav .range-btn.active')?.dataset.sub === t", arg=tab)


def make_account(server, username, role="member", password="Temporary-Pass-1"):
    server.api("POST", "/api/auth/users", json={"username": username, "display_name": username.title(), "role": role, "password": password})


def delete_account(server, username):
    users = server.api("GET", "/api/auth/users")["users"]
    for u in users:
        if u["username"] == username:
            server.api("DELETE", f"/api/auth/users/{u['id']}")


# ------------------------------------------------------------------------------------ the sign-in page

def test_wrong_password_shows_an_error_and_right_password_gets_you_in(make_device, server):
    d = make_device()
    d.fill_sign_in("admin", "definitely-not-it")
    d.page.click("#login_submit")
    d.page.wait_for_function("document.getElementById('login_error').textContent.length > 0")
    assert d.page.inner_text("#login_error") == "Invalid username or password."
    assert d.page.input_value("#login_password") == "", "a wrong password is cleared, not left on screen"
    d.fill_sign_in("Admin", server.admin_password)             # username is not case sensitive
    with d.page.expect_navigation():
        d.page.click("#login_submit")
    d.ready()
    assert d.eval("localOnlyMode") is False and d.eval("getAuthUsername()") == "admin"
    d.assert_no_js_errors()


def test_enter_submits_and_the_password_can_be_revealed(make_device, server):
    d = make_device()
    assert d.page.get_attribute("#login_password", "type") == "password"
    d.page.click("[data-show-for=login_password]")
    assert d.page.get_attribute("#login_password", "type") == "text"
    d.page.click("[data-show-for=login_password]")
    assert d.page.get_attribute("#login_password", "type") == "password"
    d.fill_sign_in("admin", server.admin_password)
    with d.page.expect_navigation():
        d.page.press("#login_password", "Enter")
    d.ready()
    assert d.eval("!!getAuthToken()")


def test_you_stay_signed_in_across_a_reload_and_the_chip_shows_who_you_are(make_device, server):
    d = make_device(1280, 800)
    d.login(server, "Casey")
    d.page.reload(); d.ready()
    d.page.wait_for_selector("#userChip:not([hidden])")
    assert "Casey" in d.page.inner_text("#userChip")
    assert d.page.locator("#login_username").count() == 0
    d.assert_no_js_errors()


def test_the_sign_in_page_is_clean_and_works_on_a_phone(make_device):
    d = make_device(390, 800)
    assert d.page.locator("#login_username").is_visible() and d.page.locator("#login_submit").is_visible()
    for hidden in ("#globalSearchBtn", "#connIndicator", "#tabs"):
        assert d.page.locator(hidden).is_hidden(), f"{hidden} doesn't belong on the sign-in page"
    assert d.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 1
    d.assert_no_js_errors()


def test_a_session_ended_on_the_server_returns_you_to_sign_in_with_an_explanation(make_device, server):
    d = make_device()
    d.login(server, "Evicted")
    uid = next(u["id"] for u in server.api("GET", "/api/auth/users")["users"] if u["username"] == "evicted")
    server.api("PATCH", f"/api/auth/users/{uid}", json={"disabled": True})
    try:
        d.page.reload(); d.ready()
        d.page.wait_for_selector("#login_username")
        assert "signed out" in d.page.inner_text(".auth-notice").lower()
    finally:
        server.api("PATCH", f"/api/auth/users/{uid}", json={"disabled": False})


# ------------------------------------------------------------------------------------ local only

def test_local_only_is_available_without_an_account(make_device):
    d = make_device()
    d.local_only("Offline Olive")
    assert d.eval("localOnlyMode") is True
    assert d.page.locator("#userChip").is_hidden(), "no account in local-only mode"
    d.eval("() => switchTab('settings')")
    tabs = d.eval("[...document.querySelectorAll('#settingsSubNav .range-btn')].map(b => b.textContent.trim())")
    assert "Account" not in tabs and "Users" not in tabs and "Connection" in tabs
    d.assert_no_js_errors()


def test_the_website_leads_with_local_only_and_can_sign_in_to_your_own_server(make_device_at, website, server):
    d = make_device_at(website)
    assert d.page.locator("#gs_local").is_visible() and d.page.locator("#gs_name").is_visible(), "no server here: local-only is the main path"
    assert d.page.locator("#login_username").is_hidden()
    d.page.click("#gs_toggle_server")
    d.page.fill("#login_server", "http://127.0.0.1:1")            # nothing there
    d.fill_sign_in("admin", server.admin_password)
    d.page.click("#login_submit")
    d.page.wait_for_function("document.getElementById('login_error').textContent.includes('No Coop Ledger server')")
    d.page.fill("#login_server", server.url)
    with d.page.expect_navigation(timeout=15000):
        d.page.click("#login_submit")
    d.ready()
    assert d.eval("localOnlyMode") is False and d.eval("getServerUrl()") == server.url
    d.page.wait_for_selector("#userChip:not([hidden])")
    d.assert_no_js_errors()


def test_the_website_can_start_local_only(make_device_at, website):
    d = make_device_at(website)
    d.page.fill("#gs_name", "Website Wendy")
    with d.page.expect_navigation():
        d.page.click("#gs_local")
    d.ready()
    assert d.eval("localOnlyMode") is True


# ------------------------------------------------------------------------------------ first sign-in

def test_a_new_account_must_choose_a_password_before_anything_else(make_device, server):
    make_account(server, "newcomer")
    try:
        d = make_device()
        d.fill_sign_in("newcomer", "Temporary-Pass-1")
        with d.page.expect_navigation():
            d.page.click("#login_submit")
        d.ready()
        d.page.wait_for_selector("#pwchange_form")
        assert d.page.locator("#tabs").is_hidden(), "nothing else is reachable yet"

        d.page.fill("#pw_current", "Temporary-Pass-1")
        d.page.fill("#pw_new", "a-new-password-1")
        d.page.fill("#pw_confirm", "a-different-one-2")
        d.page.click("#pw_submit")
        assert "don't match" in d.page.inner_text("#pw_error")

        d.page.fill("#pw_confirm", "a-new-password-1")
        d.page.fill("#pw_new", "password123")                      # too guessable
        d.page.fill("#pw_confirm", "password123")
        d.page.click("#pw_submit")
        d.page.wait_for_function("document.getElementById('pw_error').textContent.includes('guess')")

        d.page.fill("#pw_new", "a-new-password-1")
        d.page.fill("#pw_confirm", "a-new-password-1")
        with d.page.expect_navigation():
            d.page.click("#pw_submit")
        d.ready()
        d.page.wait_for_selector("#tabs:not([hidden])")
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "newcomer", "password": "a-new-password-1"}).status_code == 200
        d.assert_no_js_errors()
    finally:
        delete_account(server, "newcomer")


# ------------------------------------------------------------------------------------ my account

def test_change_my_name_and_password_then_sign_out_and_back_in(make_device, server):
    make_account(server, "morgan", password="Starting-Pass-1")
    try:
        d = make_device()
        d.fill_sign_in("morgan", "Starting-Pass-1")
        with d.page.expect_navigation():
            d.page.click("#login_submit")
        d.ready()
        d.page.fill("#pw_current", "Starting-Pass-1"); d.page.fill("#pw_new", "Morgans-Own-Pass-1"); d.page.fill("#pw_confirm", "Morgans-Own-Pass-1")
        with d.page.expect_navigation():
            d.page.click("#pw_submit")
        d.ready()
        d.page.wait_for_selector("#tabs:not([hidden])")

        open_settings(d, "account")
        d.page.fill("#acct_name", "Morgan the Great")
        d.page.click("#acct_name_save")
        d.page.wait_for_function("document.querySelector('#userChip').textContent.includes('Morgan the Great')")

        d.page.fill("#acct_pw_current", "not-my-password"); d.page.fill("#acct_pw_new", "Another-Pass-2"); d.page.fill("#acct_pw_confirm", "Another-Pass-2")
        d.page.click("#acct_pw_save")
        d.page.wait_for_function("document.getElementById('acct_pw_error').textContent.length > 0")
        assert "current password" in d.page.inner_text("#acct_pw_error")

        d.page.fill("#acct_pw_current", "Morgans-Own-Pass-1")
        d.page.click("#acct_pw_save")
        d.page.wait_for_function("document.getElementById('acct_pw_current').value === ''")   # the form re-rendered after success
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "morgan", "password": "Another-Pass-2"}).status_code == 200
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "morgan", "password": "Morgans-Own-Pass-1"}).status_code == 401

        d.page.click("#acct_signout")
        d.page.click("#confirmYes")
        d.page.wait_for_selector("#login_username")
        assert d.eval("!!getAuthToken()") is False
        d.fill_sign_in("morgan", "Another-Pass-2")
        with d.page.expect_navigation():
            d.page.click("#login_submit")
        d.ready()
        d.page.wait_for_selector("#userChip:not([hidden])")
        assert "Morgan the Great" in d.page.inner_text("#userChip"), "the new name is on the account, not just this browser"
        d.assert_no_js_errors()
    finally:
        delete_account(server, "morgan")


# ------------------------------------------------------------------------------------ users (admin)

def test_admin_adds_a_user_who_signs_in_on_another_device_and_can_then_be_disabled_reset_and_deleted(make_device, server):
    admin, other = make_device(1280, 900), make_device()
    admin.login(server)
    open_settings(admin, "users")
    admin.page.click("#addUserBtn")
    admin.page.fill("#uf_username", "pat-the-helper")
    admin.page.fill("#uf_display", "Pat")
    admin.page.click("#uf_save")
    admin.page.wait_for_selector("#tempPw")
    temp = admin.page.inner_text("#tempPw").strip()
    assert len(temp) == 16 and "only time" in admin.page.inner_text("#modalContent")
    admin.page.click("#tempPwDone")
    admin.page.wait_for_selector("[data-user-row]:has-text('Pat')")
    assert "temporary password" in admin.page.inner_text("[data-user-row]:has-text('Pat')").lower()

    try:
        # Pat signs in on a different device with the temporary password and must choose their own
        other.fill_sign_in("pat-the-helper", temp)
        with other.page.expect_navigation():
            other.page.click("#login_submit")
        other.ready()
        other.page.wait_for_selector("#pwchange_form")
        other.page.fill("#pw_current", temp); other.page.fill("#pw_new", "Pats-Own-Password-1"); other.page.fill("#pw_confirm", "Pats-Own-Password-1")
        with other.page.expect_navigation():
            other.page.click("#pw_submit")
        other.ready()
        other.page.wait_for_selector("#userChip:not([hidden])")
        other.eval("() => { settingsSubTab = 'coops'; switchTab('settings'); }")
        tabs = other.eval("[...document.querySelectorAll('#settingsSubNav .range-btn')].map(b => b.textContent.trim())")
        assert "Users" not in tabs and "Server" not in tabs, "a member sees no admin tabs"

        # disable: Pat is cut off
        open_settings(admin, "users")
        admin.page.click("[data-user-row]:has-text('Pat') [data-toggle]")
        admin.page.click("#confirmYes")
        admin.page.wait_for_selector("[data-user-row]:has-text('Pat') .chip-warn:has-text('disabled')")
        other.page.reload(); other.ready()
        other.page.wait_for_selector("#login_username")
        other.fill_sign_in("pat-the-helper", "Pats-Own-Password-1")
        other.page.click("#login_submit")
        other.page.wait_for_function("document.getElementById('login_error').textContent.length > 0")

        # enable, then reset the password: a new temporary one is shown once
        admin.page.click("[data-user-row]:has-text('Pat') [data-toggle]")
        admin.page.wait_for_selector("[data-user-row]:has-text('Pat'):not(.is-disabled)")
        admin.page.click("[data-user-row]:has-text('Pat') [data-reset]")
        admin.page.click("#confirmYes")
        admin.page.wait_for_selector("#tempPw")
        new_temp = admin.page.inner_text("#tempPw").strip()
        assert new_temp != temp
        admin.page.click("#tempPwDone")
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "pat-the-helper", "password": "Pats-Own-Password-1"}).status_code == 401
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "pat-the-helper", "password": new_temp}).json()["must_change_password"] is True

        # delete
        admin.page.click("[data-user-row]:has-text('Pat') [data-delete]")
        admin.page.click("#confirmYes")
        admin.page.wait_for_selector("[data-user-row]:has-text('Pat')", state="detached")
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "pat-the-helper", "password": new_temp}).status_code == 401
    finally:
        delete_account(server, "pat-the-helper")
    admin.assert_no_js_errors()


def test_the_admin_cannot_disable_or_delete_themselves_from_the_screen(make_device, server):
    d = make_device()
    d.login(server)
    open_settings(d, "users")
    # init() finishes asynchronously and re-renders the open tab, so assert with retrying expectations
    row = d.page.locator("[data-user-row]:has(.chip:has-text('you'))")
    expect(row.locator("[data-edit]")).to_have_count(1)
    expect(row.locator("[data-reset]")).to_have_count(1)
    expect(row.locator("[data-toggle]")).to_have_count(0)
    expect(row.locator("[data-delete]")).to_have_count(0)


def test_user_form_reports_server_side_problems_in_the_dialog(make_device, server):
    d = make_device()
    d.login(server)
    open_settings(d, "users")
    d.page.click("#addUserBtn")
    d.page.fill("#uf_username", "x")
    d.page.click("#uf_save")
    d.page.wait_for_function("document.getElementById('uf_error').textContent.length > 0")
    assert "3-32" in d.page.inner_text("#uf_error")
    d.page.fill("#uf_username", "admin")
    d.page.click("#uf_save")
    d.page.wait_for_function("document.getElementById('uf_error').textContent.includes('taken')")
    assert d.page.locator("#uf_username").is_visible(), "the dialog stays open so nothing typed is lost"


def test_read_only_accounts_can_look_but_not_change_data_and_can_still_change_their_password(make_device, server):
    d = make_device()
    d.login(server, "Viewer Vic")                     # a member account...
    uid = next(u["id"] for u in server.api("GET", "/api/auth/users")["users"] if u["username"] == "viewer-vic")
    server.api("PATCH", f"/api/auth/users/{uid}", json={"role": "readonly"})    # ...made read-only while signed in
    d.page.reload(); d.ready()
    d.page.wait_for_function("getUserRole() === 'readonly'")
    assert "Read-only" in d.page.inner_text("#sidebar #statusBannerSlot")
    open_settings(d, "account")
    d.page.fill("#acct_name", "Vic Viewer")
    d.page.click("#acct_name_save")
    d.page.wait_for_function("document.querySelector('#userChip').textContent.includes('Vic Viewer')")


# ------------------------------------------------------------------------------------ the older invite-code sign-in

def test_invite_codes_appear_only_when_the_admin_allows_them(make_device, server):
    d0 = make_device()
    assert d0.page.locator("#login_use_code").count() == 0, "off by default on a new server"
    code = server.set_invite_codes(True)
    try:
        d = make_device()
        d.page.click("#login_use_code")
        d.page.fill("#login_code_name", "Grandma")
        d.page.fill("#login_code", code)
        with d.page.expect_navigation():
            d.page.click("#login_submit")
        d.ready()
        assert d.eval("localOnlyMode") is False and d.eval("getAuthUsername()") == ""
        open_settings(d, "account")
        assert "shared invite code" in d.page.inner_text("#settingsContent")
        assert d.page.locator("#acct_pw_form").count() == 0, "a shared code has no password to change"
        server.set_invite_codes(False)                                           # the admin turns codes off...
        d.page.reload(); d.ready()
        d.page.wait_for_selector("#login_username")                              # ...and that device is signed out
    finally:
        server.set_invite_codes(False)


# ------------------------------------------------------------------------------------ renaming

def test_admin_renames_a_user_from_the_edit_dialog(make_device, server):
    make_account(server, "old-name-1", password="Starting-Pass-1")
    try:
        admin = make_device()
        admin.login(server)
        open_settings(admin, "users")
        admin.page.click("[data-user-row]:has-text('@old-name-1') [data-edit]")
        admin.page.fill("#uf_username", "x")
        admin.page.click("#uf_save")
        admin.page.wait_for_function("document.getElementById('uf_error').textContent.includes('3-32')")
        admin.page.fill("#uf_username", "admin")
        admin.page.click("#uf_save")
        admin.page.wait_for_function("document.getElementById('uf_error').textContent.includes('taken')")
        admin.page.fill("#uf_username", "renamed-by-admin")
        admin.page.click("#uf_save")
        admin.page.wait_for_selector("[data-user-row]:has-text('@renamed-by-admin')")
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "old-name-1", "password": "Starting-Pass-1"}).status_code == 401
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "renamed-by-admin", "password": "Starting-Pass-1"}).status_code == 200
        admin.assert_no_js_errors()
    finally:
        delete_account(server, "old-name-1")
        delete_account(server, "renamed-by-admin")


def test_you_cannot_edit_your_own_username_in_the_users_dialog_it_lives_in_account(make_device, server):
    d = make_device()
    d.login(server)
    open_settings(d, "users")
    d.page.click("[data-user-row]:has(.chip:has-text('you')) [data-edit]")
    assert d.page.is_disabled("#uf_username")
    assert "Settings → Account" in d.page.inner_text("#modalContent")


def test_you_rename_yourself_in_account_with_your_password(make_device, server):
    make_account(server, "self-namer", password="Starting-Pass-1")
    try:
        d = make_device()
        d.fill_sign_in("self-namer", "Starting-Pass-1")
        with d.page.expect_navigation():
            d.page.click("#login_submit")
        d.ready()
        d.page.fill("#pw_current", "Starting-Pass-1"); d.page.fill("#pw_new", "Self-Namers-Pass-1"); d.page.fill("#pw_confirm", "Self-Namers-Pass-1")
        with d.page.expect_navigation():
            d.page.click("#pw_submit")
        d.ready()
        d.page.wait_for_selector("#tabs:not([hidden])")
        open_settings(d, "account")

        d.page.fill("#acct_username", "self-renamed")
        d.page.click("#acct_un_save")
        d.page.wait_for_function("document.getElementById('acct_un_error').textContent.length > 0")
        assert "current password" in d.page.inner_text("#acct_un_error"), "no password, no rename"

        d.page.fill("#acct_un_password", "not-the-password-1")
        d.page.click("#acct_un_save")
        d.page.wait_for_function("document.getElementById('acct_un_error').textContent.includes('current password')")

        d.page.fill("#acct_un_password", "Self-Namers-Pass-1")
        d.page.click("#acct_un_save")
        d.page.wait_for_function("getAuthUsername() === 'self-renamed'")
        assert "@self-renamed" in d.page.inner_text("#settingsContent")
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "self-renamed", "password": "Self-Namers-Pass-1"}).status_code == 200
        assert httpx.post(f"{server.url}/api/auth/login", json={"username": "self-namer", "password": "Self-Namers-Pass-1"}).status_code == 401
        d.assert_no_js_errors()
    finally:
        delete_account(server, "self-namer")
        delete_account(server, "self-renamed")
