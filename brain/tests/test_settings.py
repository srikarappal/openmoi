"""Model settings, .env loading, new views and scoped chat edits."""

import json
import os

import httpx
import pytest
from helpers import Recorder, ok_reply

from moi_brain.config import PROVIDERS, ModelChange, Settings, Slot, apply_model_change, load_env_file, model_info, provider_of
from moi_brain.llm import Gateway

NEMOTRON = "nvidia/nemotron-3.5-super-vl:free"


def test_load_env_file_wins_over_the_shell(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text('# comment\nOPENROUTER_API_KEY="sk-test"\nexport MOI_ONE=1\nMOI_KEEP=from_file\nnot a line\n\n')
    monkeypatch.setenv("MOI_KEEP", "from_shell")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("MOI_ONE", raising=False)
    assert load_env_file(env) == ["OPENROUTER_API_KEY", "MOI_ONE", "MOI_KEEP"]
    assert (os.environ["OPENROUTER_API_KEY"], os.environ["MOI_KEEP"]) == ("sk-test", "from_file")
    assert load_env_file(tmp_path / "missing.env") == []


def test_switching_both_slots_to_openrouter_brings_key_and_reasoning_choices():
    updated = apply_model_change(Settings(), ModelChange(slot="both", provider="openrouter", model=NEMOTRON))
    assert updated.fast == Slot(base_url="https://openrouter.ai/api/v1", model=NEMOTRON, api_key_env="OPENROUTER_API_KEY", extra={"reasoning": {"enabled": False}})
    assert updated.smart.extra == {"reasoning": {"enabled": True}}
    assert updated.allow_content_to_hosted is False


def test_one_slot_model_only_and_privacy_changes():
    settings = apply_model_change(Settings(), ModelChange(slot="smart", provider="openrouter", model=NEMOTRON))
    assert provider_of(settings.fast) == "ollama"
    renamed = apply_model_change(settings, ModelChange(slot="fast", model="llama3.2"))
    assert (renamed.fast.model, provider_of(renamed.fast)) == ("llama3.2", "ollama")
    assert apply_model_change(renamed, ModelChange(allow_content_to_hosted=True)).allow_content_to_hosted is True
    custom = Settings(fast=Slot(base_url="https://models.example.com/v1", model="a"))
    assert apply_model_change(custom, ModelChange(slot="fast", model="b")).fast.base_url == "https://models.example.com/v1"


def test_model_info_reports_whether_the_key_is_there(monkeypatch):
    settings = apply_model_change(Settings(), ModelChange(slot="both", provider="openrouter", model=NEMOTRON))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert model_info(settings).fast.key_ready is False
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    info = model_info(settings)
    assert (info.fast.provider, info.fast.local, info.fast.key_ready) == ("openrouter", False, True)
    assert model_info(Settings()).smart.key_ready is True


def test_slot_extras_go_into_the_request(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    settings = apply_model_change(Settings(), ModelChange(slot="both", provider="openrouter", model=NEMOTRON))
    recorder = Recorder(ok_reply("<html></html>"))
    Gateway(settings, tmp_path / "c.jsonl", httpx.Client(transport=httpx.MockTransport(recorder))).complete("smart", "lens", [], False)
    sent = json.loads(recorder.requests[0].content)
    assert sent["reasoning"] == {"enabled": True}
    assert sent["model"] == NEMOTRON
    assert recorder.requests[0].headers["authorization"] == "Bearer sk-test"


def test_providers_are_known():
    assert set(PROVIDERS) == {"ollama", "openrouter"}


def test_model_endpoint_changes_and_saves_settings(client, paths, brain):
    assert client.get("/model").json()["fast"]["provider"] == "custom"
    info = client.post("/model", json={"slot": "both", "provider": "openrouter", "model": NEMOTRON}).json()
    assert info["smart"]["model"] == NEMOTRON
    assert brain.gateway.settings.fast.base_url == "https://openrouter.ai/api/v1"
    saved = json.loads(paths.settings_file.read_text())
    assert saved["fast"]["extra"] == {"reasoning": {"enabled": False}}
    assert client.post("/model", json={"allow_content_to_hosted": True}).json()["allow_content_to_hosted"] is True
    assert json.loads(paths.settings_file.read_text())["allow_content_to_hosted"] is True
    assert client.post("/model", json={"provider": "somewhere"}).status_code == 422


def test_new_views_become_tabs(client, paths):
    assert client.post("/views", json={"view_id": "tech", "title": "Tech"}).json() == {"view_id": "tech", "title": "Tech"}
    assert (paths.views / "tech.md").read_text() == "# Tech\n\n## Sources\n\n## Rules\n\n## Layout\n"
    assert [view["view_id"] for view in client.get("/views").json()] == ["feed", "tech"]
    assert "already exists" in client.post("/views", json={"view_id": "tech"}).json()["detail"]
    assert client.post("/views", json={"view_id": "../etc"}).status_code == 400
    assert client.post("/views", json={"view_id": "site_amazon.com"}).status_code == 400


def test_overview_shows_the_view_memory_models_and_chrome(client, paths):
    (paths.memory / "dislikes.md").write_text("# dislikes\n\n* crypto\n")
    overview = client.get("/overview/feed").json()
    assert overview["home"] == str(paths.home)
    assert overview["view_file"] == "views/feed.md"
    assert overview["sections"]["Sources"].startswith("* X home timeline")
    assert overview["sections"]["Rules"] == ""
    assert overview["memory"]["dislikes.md"] == "* crypto"
    assert set(overview["model"]) == {"fast", "smart", "allow_content_to_hosted"}
    assert overview["relay"]["connected"] is False


def edit(client, text: str, scope: str, view_id: str = "feed") -> dict:
    return client.post("/edit", json={"view_id": view_id, "text": text, "scope": scope}).json()


@pytest.mark.parametrize(
    ("text", "scope", "files"),
    [
        ("no shorts and vegetarian", "memory", ["memory/about_me.md"]),
        ("no shorts and vegetarian", "rules", ["views/feed.md"]),
        ("no shorts and make it compact", "layout", ["views/feed.md"]),
        ("no shorts and make it compact", "sources", []),
        ("no shorts and vegetarian", "any", ["views/feed.md", "memory/about_me.md"]),
    ],
)
def test_scopes_limit_what_an_edit_may_touch(client, services, text, scope, files):
    proposal = edit(client, text, scope)
    assert [change["file"] for change in proposal["changes"]] == files
    request = json.loads(services.model_calls("edit")[-1]["payload"]["messages"][1]["content"])
    assert ("views/feed.md" in request["files"]) is (scope != "memory")
    assert ("memory/about_me.md" in request["files"]) is (scope in ("memory", "any"))


def test_layout_scope_changes_only_the_layout_section(client):
    [change] = edit(client, "no shorts and make it compact", "layout")["changes"]
    assert "+no shorts and make it compact" in change["diff"]
    assert "No shorts" not in change["diff"].replace("no shorts and make it compact", "")


def test_view_scope_writes_a_new_view_file(client, paths):
    proposal = edit(client, "make it a magazine of science", "view", view_id="science")
    [change] = proposal["changes"]
    assert change["file"] == "views/science.md"
    client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    assert (paths.views / "science.md").read_text() == "# science\n\n## Layout\nmake it a magazine of science\n"
