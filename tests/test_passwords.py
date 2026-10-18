"""Password hashing and the password / username rules (pure functions, no server)."""
import pytest

from coopledger import passwords


def test_hash_is_self_describing_salted_and_not_the_password():
    h = passwords.hash_password("correct horse battery")
    assert h.startswith("scrypt$")
    assert "correct horse battery" not in h
    assert len(h.split("$")) == 6
    assert passwords.hash_password("correct horse battery") != h, "every hash gets its own salt"


def test_verify_accepts_the_right_password_and_nothing_else():
    h = passwords.hash_password("correct horse battery")
    assert passwords.verify_password("correct horse battery", h)
    for wrong in ("correct horse batter", "Correct horse battery", "", " correct horse battery", "correct horse battery "):
        assert not passwords.verify_password(wrong, h)


def test_unicode_passwords_work():
    h = passwords.hash_password("pässwörd-🐔-长い")
    assert passwords.verify_password("pässwörd-🐔-长い", h)


@pytest.mark.parametrize("stored", [None, "", "garbage", "scrypt$1$2", "bcrypt$1$2$3$4$5", "scrypt$x$y$z$!!$!!", "scrypt$16$1$1$AAAA$AAAA"])
def test_verify_never_raises_on_a_bad_hash(stored):
    assert passwords.verify_password("anything", stored) is False


def test_old_hashes_keep_working_after_the_cost_is_raised(monkeypatch):
    old = passwords.hash_password("correct horse battery")
    monkeypatch.setitem(passwords.HASH_PARAMS, "n", passwords.HASH_PARAMS["n"] * 2)
    assert passwords.verify_password("correct horse battery", old), "parameters are read from the stored hash"
    assert passwords.needs_rehash(old), "...and the login path is told to upgrade it"
    assert not passwords.needs_rehash(passwords.hash_password("x" * 10))


def test_needs_rehash_treats_junk_as_needing_a_rehash():
    assert passwords.needs_rehash("junk")


def test_production_cost_is_not_the_test_cost():
    # conftest lowers HASH_PARAMS for speed. The shipped default must not be that.
    import importlib
    fresh = importlib.reload(passwords)
    try:
        assert fresh.HASH_PARAMS["n"] >= 2 ** 15 and fresh.HASH_PARAMS["p"] >= 1
    finally:
        # reload() gave the module new defaults; put the suite's fast ones back
        from helpers import FAST_HASH
        fresh.HASH_PARAMS.update(FAST_HASH)


@pytest.mark.parametrize("name", ["abc", "Alex", "a.b-c_d", "user123", "A" * 32])
def test_valid_usernames(name):
    assert passwords.validate_username(name) is None


@pytest.mark.parametrize("name", ["", "ab", "-lead", ".lead", "has space", "semi;colon", "a" * 33, "tab\tname", "emoji🐔", "slash/y"])
def test_invalid_usernames(name):
    assert passwords.validate_username(name)


@pytest.mark.parametrize("pw", ["correct horse battery", "a-long-passphrase", "Tr0ub4dor&3", "12345678a", ("pass-phrase-" * 11)[:128]])
def test_acceptable_passwords(pw):
    assert passwords.validate_password(pw, "alex") is None


@pytest.mark.parametrize("pw,fragment", [
    ("short", "at least"), ("", "at least"), (None, "at least"),
    ("x" * 129, "at most"),
    ("password", "guess"), ("PASSWORD123", "guess"), ("12345678", "guess"),
    ("aaaaaaaa", "repetitive"), ("ababababab", "repetitive"), ("x" * 128, "repetitive"),
])
def test_rejected_passwords(pw, fragment):
    msg = passwords.validate_password(pw, "alex")
    assert msg and fragment in msg


def test_password_may_not_be_the_username_in_any_case():
    assert passwords.validate_password("Chickenlady", "chickenlady") == "The password can't be the same as the username."


def test_generated_passwords_are_long_random_and_typeable():
    seen = {passwords.generate_password() for _ in range(50)}
    assert len(seen) == 50
    for pw in seen:
        assert len(pw) == 16 and not set(pw) & set("0O1lI"), "no look-alike characters"
        assert passwords.validate_password(pw, "admin") is None


def test_unknown_user_costs_a_verification(monkeypatch):
    calls = []
    real = passwords.verify_password
    monkeypatch.setattr(passwords, "verify_password", lambda *a, **k: calls.append(1) or real(*a, **k))
    passwords.burn_a_verification()
    assert calls, "the dummy check really runs a scrypt verification"
