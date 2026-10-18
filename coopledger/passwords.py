"""Password hashing and password / username rules. Pure functions: no database, no HTTP.

Hashing is scrypt from the standard library (`hashlib.scrypt`), so there is no extra
dependency to install or to go stale. A stored hash is one self-describing string,

    scrypt$<N>$<r>$<p>$<salt, base64>$<hash, base64>

so the cost can be raised later without a migration: old hashes keep verifying with the
parameters they were made with, and `needs_rehash()` tells the login path to upgrade
them to the current cost the next time the person signs in successfully.

Cost: N=2**15, r=8, p=3 -- one of the equivalent-strength combinations OWASP lists for
scrypt (about 32 MiB of memory, a few hundred milliseconds on a desktop, around a second
on a Raspberry Pi). That is deliberately slow *per guess*; it only costs a legitimate
person one login.
"""
import base64
import hashlib
import hmac
import re
import secrets

# Mutable on purpose: the test suite lowers it so hundreds of logins don't take minutes.
# Hashes record the parameters they were made with, so changing this never breaks old ones.
HASH_PARAMS = {"n": 2 ** 15, "r": 8, "p": 3}
_MAXMEM = 256 * 1024 * 1024
_SALT_BYTES = 16
_DKLEN = 32

PASSWORD_MIN = 8
PASSWORD_MAX = 128   # scrypt cost does not grow with length, but an unbounded body is a free DoS
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$")

# Not a dictionary: just the passwords that every guessing list tries first. Length is the real policy.
_COMMON = {
    "password", "password1", "password12", "password123", "12345678", "123456789", "1234567890",
    "qwertyui", "qwerty123", "qwertyuiop", "iloveyou", "letmein1", "welcome1", "admin123",
    "administrator", "changeme", "changeme1", "chickens", "chicken123", "coopledger", "thecoopledger",
    "11111111", "00000000", "abcd1234", "abc12345", "passw0rd", "p@ssw0rd", "trustno1",
}

# No 0/O, 1/l/I: a generated password is often read off a screen and typed by hand.
_GENERATED_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=_MAXMEM, dklen=_DKLEN)


def hash_password(password: str) -> str:
    n, r, p = HASH_PARAMS["n"], HASH_PARAMS["r"], HASH_PARAMS["p"]
    salt = secrets.token_bytes(_SALT_BYTES)
    return f"scrypt${n}${r}${p}${_b64(salt)}${_b64(_derive(password, salt, n, r, p))}"


def verify_password(password: str, stored: str | None) -> bool:
    """True if `password` matches `stored`. Never raises on a malformed or missing hash --
    that is simply 'no match' (a corrupt row must not become a 500 that reveals which
    usernames exist)."""
    if not stored:
        return False
    try:
        scheme, n, r, p, salt, expected = stored.split("$")
        if scheme != "scrypt":
            return False
        actual = _derive(password, _unb64(salt), int(n), int(r), int(p))
        return hmac.compare_digest(actual, _unb64(expected))
    except (ValueError, TypeError):
        return False


def needs_rehash(stored: str) -> bool:
    """True if `stored` was made with weaker parameters than the current ones."""
    try:
        _, n, r, p, _, _ = stored.split("$")
        return (int(n), int(r), int(p)) < (HASH_PARAMS["n"], HASH_PARAMS["r"], HASH_PARAMS["p"])
    except ValueError:
        return True


# What an unknown username is checked against, so "no such user" costs the same time as
# "wrong password" and response timing can't be used to find which usernames exist.
_DUMMY_HASH: str | None = None


def burn_a_verification() -> None:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_urlsafe(16))
    verify_password("not-the-password", _DUMMY_HASH)


def validate_username(username: str) -> str | None:
    """None if fine, otherwise a message fit to show the person."""
    if not USERNAME_RE.match(username or ""):
        return "Usernames are 3-32 characters: letters, numbers, dot, dash or underscore, starting with a letter or number."
    return None


def validate_password(password: str, username: str = "") -> str | None:
    """None if acceptable, otherwise a message fit to show the person. Length and not being
    on the obvious-passwords list -- not 'must contain a symbol', which pushes people toward
    predictable substitutions and away from long memorable phrases."""
    if not isinstance(password, str) or len(password) < PASSWORD_MIN:
        return f"Passwords need at least {PASSWORD_MIN} characters."
    if len(password) > PASSWORD_MAX:
        return f"Passwords can be at most {PASSWORD_MAX} characters."
    lowered = password.lower()
    if username and lowered == username.lower():
        return "The password can't be the same as the username."
    if lowered in _COMMON:
        return "That password is one of the first things anyone would guess. Pick something else."
    if len(set(password)) < 3:
        return "That password is too repetitive."
    return None


def generate_password(length: int = 16) -> str:
    """A random password for 'reset it for them' and the first-run admin account."""
    return "".join(secrets.choice(_GENERATED_ALPHABET) for _ in range(length))
