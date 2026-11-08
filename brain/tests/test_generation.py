"""Lens and extractor generation: prompts carry structure only, replies are cleaned and checked."""

import json

import httpx
import pytest
from helpers import Recorder, ok_reply

from moi_brain.config import REPO_DIR, Settings, Slot
from moi_brain.extractor_gen import generate_spec
from moi_brain.lens_gen import DEFAULT_LAYOUT, generate_lens, html_document, lens_messages
from moi_brain.llm import Gateway, LlmError

HOSTED = Slot(base_url="https://models.example.com/v1", model="big")
DEFAULT_LENS = (REPO_DIR / "lenses" / "default" / "default.html").read_text()


def hosted_gateway(tmp_path, recorder: Recorder) -> Gateway:
    return Gateway(Settings(fast=HOSTED, smart=HOSTED, allow_content_to_hosted=False), tmp_path / "calls.jsonl", httpx.Client(transport=httpx.MockTransport(recorder)))


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ("<!doctype html><html></html>", "<!doctype html><html></html>"),
        ("Sure! Here you go:\n<!DOCTYPE html><html><body></body></html>", "<!DOCTYPE html><html><body></body></html>"),
        ("Lens below <html><body>x</body></html>", "<html><body>x</body></html>"),
        ("text then <div>fragment</div>", "<div>fragment</div>"),
        ("no markup", "no markup"),
    ],
)
def test_html_document(reply, expected):
    assert html_document(reply) == expected


def test_lens_messages_hold_layout_schema_api_and_example_only():
    [system, user] = lens_messages("  ", "listing", DEFAULT_LENS, "items missing")
    payload = json.loads(user["content"])
    assert payload["layout"] == DEFAULT_LAYOUT
    assert payload["kind"] == "listing"
    assert payload["last_error"] == "items missing"
    assert "moi.ready()" in payload["helper_api"]
    assert payload["item_schema"]["title"] == "ViewItem"
    assert payload["example_lens"] == DEFAULT_LENS
    assert "data-item-id" in system["content"]


def test_generate_lens_works_on_a_hosted_slot_without_sharing_content(tmp_path):
    recorder = Recorder(ok_reply("```html\n<!doctype html><html><body>generated</body></html>\n```"))
    gateway = hosted_gateway(tmp_path, recorder)
    assert generate_lens(gateway, "Two columns", "feed", DEFAULT_LENS, None) == "<!doctype html><html><body>generated</body></html>"
    assert gateway.recent_calls()[0]["contained_user_content"] is False
    assert json.loads(recorder.requests[0].content)["model"] == "big"


def test_generate_lens_rejects_unknown_kinds(tmp_path):
    with pytest.raises(ValueError):
        generate_lens(hosted_gateway(tmp_path, Recorder()), "x", "carousel", DEFAULT_LENS, None)


def test_generate_spec_takes_domain_and_pattern_from_the_url(tmp_path):
    draft = {
        "item_root": "li.result",
        "domain": "evil.example",
        "fields": {"title": {"select": "a"}, "url": {"select": "a", "take": "attr:href", "transform": "absolute_url"}},
    }
    recorder = Recorder(ok_reply(json.dumps(draft)))
    spec = generate_spec(hosted_gateway(tmp_path, recorder), "https://www.example.com/search/lamps?page=2", "<ul>skeleton</ul>", None)
    assert (spec.domain, spec.path_pattern, spec.page_type, spec.version) == ("example.com", "/search/lamps*", "listing", 1)
    assert spec.item_root == "li.result"
    sent = recorder.requests[0].content.decode()
    payload = json.loads(json.loads(sent)["messages"][1]["content"])
    assert payload == {"site": "example.com", "skeleton": "<ul>skeleton</ul>", "last_error": None}
    assert "lamps" not in sent and "page=2" not in sent


def test_generate_spec_needs_url_and_title(tmp_path):
    reply = json.dumps({"item_root": "li", "fields": {"title": {"select": "a"}}})
    with pytest.raises(LlmError, match="no url field"):
        generate_spec(hosted_gateway(tmp_path, Recorder(ok_reply(reply))), "https://e.com/", "<ul></ul>", None)
