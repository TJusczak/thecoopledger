"""Plain constants shared by test modules (conftest.py is for fixtures only --
importing from a conftest breaks as soon as a second one exists)."""

# A tiny but genuine 1x1 PNG (magic bytes + valid structure).
TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082"
)


# scrypt at production cost is ~0.3 s a hash; hundreds of logins would take minutes. Hashes record the
# parameters they were made with, so lowering this only changes how fast the tests run.
FAST_HASH = {"n": 2 ** 4, "r": 1, "p": 1}

# The bootstrap admin's password after the forced change (see the `admin` fixture in conftest.py).
ADMIN_PASSWORD = "Coop-Test-Admin-1"
