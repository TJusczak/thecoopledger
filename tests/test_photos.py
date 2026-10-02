"""Photo upload validation and magic-byte sniffing."""
from helpers import TINY_PNG
from coopledger import photos


# -------------------------------------------------------------- photo upload

def test_photo_upload_accepts_real_png(client, admin, coop):
    bird = client.post("/api/birds", json={"coop_id": coop, "name": "Photogenic"}, headers=admin).json()
    r = client.post(
        f"/api/birds/{bird['id']}/photo",
        files={"file": ("hen.png", TINY_PNG, "image/png")},
        headers=admin,
    )
    assert r.status_code == 200
    ref = r.json()["photo"]
    assert ref.startswith(f"/photos/{coop}/")
    assert ref.endswith(".png")  # extension came from magic bytes, not the filename
    assert client.get(ref, headers=admin).status_code == 200


def test_photo_upload_rejects_non_image(client, admin, coop):
    bird = client.post("/api/birds", json={"coop_id": coop, "name": "Victim"}, headers=admin).json()
    r = client.post(
        f"/api/birds/{bird['id']}/photo",
        files={"file": ("evil.png", b"<script>alert(1)</script>", "image/png")},
        headers=admin,
    )
    assert r.status_code == 415  # claims PNG, isn't one


def test_photo_upload_rejects_oversize(client, admin, coop):
    bird = client.post("/api/birds", json={"coop_id": coop, "name": "Big"}, headers=admin).json()
    huge = TINY_PNG + b"\x00" * (2 * 1024 * 1024)  # over the 1MB test cap
    r = client.post(
        f"/api/birds/{bird['id']}/photo",
        files={"file": ("big.png", huge, "image/png")},
        headers=admin,
    )
    assert r.status_code == 413


def test_sniffer_recognizes_formats():
    assert photos.sniff_image_ext(b"\xff\xd8\xff\xe0rest") == ".jpg"
    assert photos.sniff_image_ext(TINY_PNG) == ".png"
    assert photos.sniff_image_ext(b"RIFF\x00\x00\x00\x00WEBPrest") == ".webp"
    assert photos.sniff_image_ext(b"GIF89a...") == ".gif"
    assert photos.sniff_image_ext(b"%PDF-1.7") is None
