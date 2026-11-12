"""Signed packs: only a pack signed with openMoi's key installs, and only what the brain already validates."""

import base64
import json
import shutil

import httpx
import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import REPO_DIR, Paths, Settings, pack_channel
from moi_brain.packs import MAX_PACK_BYTES, PackError, installed_pack, keygen, main, public_key, sign, verified_pack

SPEC = {"domain": "news.example", "path_pattern": "/", "item_root": "article", "fields": {"title": {"select": "h2"}, "url": {"select": "a", "take": "attr:href"}}}


def pack_bytes(version: int = 2, **extra) -> bytes:
    return json.dumps({"pack_version": version, "created_at": "2026-11-12", "specs": [SPEC], "policy": {"sites": {"tiktok.com": {"status": "removed"}}}, **extra}).encode()


@pytest.fixture
def keys(tmp_path):
    private = tmp_path / "signing.key"
    (tmp_path / "pack_key.pub").write_text(keygen(private))
    return private, public_key(tmp_path / "pack_key.pub")


def test_a_pack_signed_with_the_shipped_key_installs(tmp_path, keys):
    private, key = keys
    assert oct(private.stat().st_mode)[-3:] == "600"
    (tmp_path / "pack.json").write_bytes(pack_bytes())
    signature = sign(tmp_path / "pack.json", private).read_bytes()
    pack = verified_pack(pack_bytes(), signature, key)
    assert pack.pack_version == 2 and pack.specs[0].domain == "news.example" and pack.policy.sites["tiktok.com"].status == "removed"


def test_a_pack_changed_after_signing_or_signed_by_another_key_is_refused(tmp_path, keys):
    private, key = keys
    (tmp_path / "pack.json").write_bytes(pack_bytes())
    signature = sign(tmp_path / "pack.json", private).read_bytes()
    with pytest.raises(PackError, match="does not check out"):
        verified_pack(pack_bytes(version=3), signature, key)
    other = public_key_of(tmp_path, "other")
    with pytest.raises(PackError, match="does not check out"):
        verified_pack(pack_bytes(), signature, other)
    with pytest.raises(PackError, match="does not check out"):
        verified_pack(pack_bytes(), b"not base64!", key)


def public_key_of(tmp_path, name):
    (tmp_path / f"{name}.pub").write_text(keygen(tmp_path / f"{name}.key"))
    return public_key(tmp_path / f"{name}.pub")


def test_no_key_too_big_or_not_a_pack_is_refused(tmp_path, keys):
    private, key = keys
    with pytest.raises(PackError, match="no pack key"):
        verified_pack(pack_bytes(), b"", None)
    with pytest.raises(PackError, match="too big"):
        verified_pack(b" " * (MAX_PACK_BYTES + 1), b"", key)
    (tmp_path / "bad.json").write_bytes(b'{"pack_version": 0}')
    signature = sign(tmp_path / "bad.json", private).read_bytes()
    with pytest.raises(PackError, match="not valid"):
        verified_pack(b'{"pack_version": 0}', signature, key)
    assert public_key(tmp_path / "missing.pub") is None
    (tmp_path / "garbage.pub").write_text("not a key")
    assert public_key(tmp_path / "garbage.pub") is None
    (tmp_path / "short.pub").write_text(base64.b64encode(b"short").decode())
    assert public_key(tmp_path / "short.pub") is None


def test_the_command_line_makes_keys_and_signs(tmp_path, capsys):
    assert main(["keygen", str(tmp_path / "k")]) == 0
    assert len(base64.b64decode(capsys.readouterr().out.strip())) == 32
    (tmp_path / "pack.json").write_bytes(pack_bytes())
    assert main(["sign", str(tmp_path / "pack.json"), str(tmp_path / "k")]) == 0
    assert (tmp_path / "pack.json.sig").exists()
    assert main(["nonsense"]) == 2



class PackChannel:
    """A pack channel: serves pack.json and its .sig, whichever the test put there."""

    def __init__(self, pack: bytes, signature: bytes):
        self.pack = pack
        self.signature = signature

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/missing.json":
            return httpx.Response(404)
        return httpx.Response(200, content=self.signature if request.url.path.endswith(".sig") else self.pack)


@pytest.fixture
def pack_world(tmp_path):
    """An openMoi whose assets ship a pack key, and a channel serving a pack signed with it."""
    assets = tmp_path / "assets"
    for name in ("templates", "lenses", "extractors", "policy"):
        shutil.copytree(REPO_DIR / name, assets / name)
    private = tmp_path / "signing.key"
    (assets / "policy" / "pack_key.pub").write_text(keygen(private))
    (tmp_path / "pack.json").write_bytes(pack_bytes())
    channel = PackChannel(pack_bytes(), sign(tmp_path / "pack.json", private).read_bytes())
    home = tmp_path / "home"
    (home / "views").mkdir(parents=True)
    return Paths(home=home, assets=assets), channel, private


def brain_on(paths: Paths, channel: PackChannel, settings: Settings, pack_url: str | None) -> Brain:
    http = httpx.Client(transport=httpx.MockTransport(channel))
    return Brain(paths, settings.model_copy(update={"pack_url": pack_url}), http=http)


def test_a_signed_newer_pack_installs_specs_and_policy_and_survives_a_restart(pack_world, settings, tmp_path):
    paths, channel, private = pack_world
    assert brain_on(paths, channel, settings, None).update_packs() == "no pack channel"
    brain = brain_on(paths, channel, settings, "https://packs.example/pack.json")
    assert brain.update_packs() == "installed pack v2"
    assert brain.best_spec("https://news.example/").domain == "news.example"
    assert brain.policies.sites["tiktok.com"].status == "removed"
    assert brain.update_packs() == "pack v2 is current"
    assert brain_on(paths, channel, settings, None).policies.sites["tiktok.com"].status == "removed"
    channel.pack = pack_bytes(version=3)
    assert brain.update_packs() == "pack refused: the pack's signature does not check out"
    (tmp_path / "pack.json").write_bytes(channel.pack)
    channel.signature = sign(tmp_path / "pack.json", private).read_bytes()
    assert brain.update_packs() == "installed pack v3"
    assert brain_on(paths, channel, settings, "https://packs.example/missing.json").update_packs().startswith("pack refused: ")


def test_the_channel_shipped_with_openmoi_is_used_and_a_bad_one_is_none(pack_world, settings):
    paths, channel, _ = pack_world
    (paths.assets / "policy" / "pack_channel.json").write_text(json.dumps({"url": "https://packs.example/pack.json"}))
    assert brain_on(paths, channel, settings, None).update_packs() == "installed pack v2"
    for written in ('{"url": "http://packs.example/pack.json"}', '{"url": 5}', "not json", "[]"):
        (paths.assets / "policy" / "pack_channel.json").write_text(written)
        assert pack_channel(paths) is None


def test_packs_are_off_without_a_shipped_key(paths, settings, services):
    brain = Brain(paths, settings.model_copy(update={"pack_url": "https://packs.example/pack.json"}), youtube_base=services.base_url)
    assert brain.update_packs() == "packs are off: openMoi ships without a pack key"
    assert TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN}).post("/packs/update").json() == {"status": "packs are off: openMoi ships without a pack key"}
    assert installed_pack(paths.packs) is None
