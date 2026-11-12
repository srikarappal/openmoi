"""Lens and extractor generation: prompts carry structure only, replies are cleaned and checked."""

import base64
import json

import httpx
import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient
from helpers import Recorder, ok_reply

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import REPO_DIR, Settings, Slot
from moi_brain.extractor_gen import generate_spec
from moi_brain.lens_gen import DEFAULT_LAYOUT, LensEdit, LensPatchError, apply_edits, generate_lens, html_document, judge_lens, lens_messages, patch_messages, token_names
from moi_brain.llm import Gateway, LlmError

HOSTED = Slot(base_url="https://models.example.com/v1", model="big")
DEFAULT_LENS = (REPO_DIR / "lenses" / "default" / "default.html").read_text()
TOKENS = (REPO_DIR / "lenses" / "tokens.css").read_text()


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


def test_edits_apply_in_order_and_fail_when_their_text_is_missing_or_ambiguous():
    html = "<body><p>one</p><p>two</p></body>"
    assert apply_edits(html, [LensEdit(find="<p>one</p>", replace="<p>1</p>"), LensEdit(find="<p>1</p><p>two", replace="<p>both")]) == "<body><p>both</p></body>"
    with pytest.raises(LensPatchError, match="edit 1 finds its text 0 times"):
        apply_edits(html, [LensEdit(find="<p>three</p>", replace="")])
    with pytest.raises(LensPatchError, match="edit 2 finds its text 2 times"):
        apply_edits(html, [LensEdit(find="one", replace="x"), LensEdit(find="<p>", replace="<p class=a>")])


def test_token_names_come_from_the_shared_tokens_file():
    names = token_names(TOKENS)
    assert names[:3] == ["--bg", "--surface", "--text"] and "--accent" in names and len(names) == len(set(names))
    [system, user] = patch_messages("Two columns", "feed", DEFAULT_LENS, None, names)
    payload = json.loads(user["content"])
    assert payload["current_lens"] == DEFAULT_LENS and payload["design_tokens"] == names and "example_lens" not in payload
    assert "find" in system["content"] and "Never write a color" in system["content"]


def test_a_lens_change_is_a_patch_on_the_current_lens(tmp_path):
    edits = {"edits": [{"find": "<body>", "replace": "<body><h1>Two columns</h1>"}]}
    recorder = Recorder(ok_reply(json.dumps(edits)))
    gateway = hosted_gateway(tmp_path, recorder)
    html = generate_lens(gateway, "Two columns", "feed", DEFAULT_LENS, None, current=DEFAULT_LENS, tokens_css=TOKENS)
    assert html == DEFAULT_LENS.replace("<body>", "<body><h1>Two columns</h1>", 1)
    assert len(recorder.requests) == 1 and recorder.requests[0].headers["x-moi-task"] == "lens_patch"
    assert gateway.recent_calls()[0]["contained_user_content"] is False


@pytest.mark.parametrize(
    "replies",
    [
        [json.dumps({"edits": [], "rewrite": True})],
        [json.dumps({"edits": [{"find": "not in the lens", "replace": "x"}]})],
        [json.dumps({"edits": []})],
        ["not json", "still not json"],
    ],
)
def test_a_patch_that_asks_for_a_rewrite_or_does_not_apply_becomes_a_whole_lens(tmp_path, replies):
    recorder = Recorder(*[ok_reply(reply) for reply in replies], ok_reply("<!doctype html><html><body>whole</body></html>"))
    html = generate_lens(hosted_gateway(tmp_path, recorder), "Magazine", "feed", DEFAULT_LENS, "items missing", current="<body>live</body>", tokens_css=TOKENS)
    assert html == "<!doctype html><html><body>whole</body></html>"
    rewrite = json.loads(json.loads(recorder.requests[-1].content)["messages"][1]["content"])
    assert recorder.requests[-1].headers["x-moi-task"] == "lens"
    assert rewrite["example_lens"] == DEFAULT_LENS and rewrite["last_error"] == "items missing" and "--accent" in rewrite["design_tokens"]


def test_a_brain_patches_the_live_lens_of_the_view(client, services):
    first = client.post("/lens/generate", json={"view_id": "feed", "kind": "feed"}).json()["html"]
    assert first.count('id="look"') == 1 and "moi.ready()" in first
    client.post("/lens/accept", json={"view_id": "feed", "kind": "feed", "html": first})
    second = client.post("/lens/generate", json={"view_id": "feed", "kind": "feed"}).json()["html"]
    assert second.count('id="look"') == 1
    sent = json.loads(services.model_calls("lens_patch")[-1]["payload"]["messages"][1]["content"])
    assert sent["current_lens"] == first and "--surface" in sent["design_tokens"]


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


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def test_without_a_vision_model_the_judge_skips(tmp_path):
    verdict = judge_lens(hosted_gateway(tmp_path, Recorder()), "Two columns", "feed", PNG)
    assert (verdict.verdict, verdict.problem) == ("skipped", "no vision model is set up")


def test_a_hosted_vision_model_sees_only_the_screenshot_of_made_up_items(tmp_path):
    recorder = Recorder(ok_reply(json.dumps({"matches": False, "problem": " One column, not two. "})))
    settings = Settings(fast=HOSTED, smart=HOSTED, vision=HOSTED.model_copy(update={"model": "eyes"}), allow_content_to_hosted=False)
    gateway = Gateway(settings, tmp_path / "calls.jsonl", httpx.Client(transport=httpx.MockTransport(recorder)))
    verdict = judge_lens(gateway, "Two columns", "feed", PNG)
    assert (verdict.verdict, verdict.problem) == ("differs", "One column, not two.")
    sent = json.loads(recorder.requests[0].content)
    assert sent["model"] == "eyes"
    parts = sent["messages"][1]["content"]
    assert json.loads(parts[0]["text"]) == {"layout": "Two columns", "kind": "feed"}
    assert parts[1]["image_url"]["url"] == f"data:image/png;base64,{base64.b64encode(PNG).decode()}"
    assert gateway.recent_calls()[0]["contained_user_content"] is False
    assert judge_lens(gateway, "x", "feed", PNG).verdict == "skipped"


def test_the_judge_endpoint_checks_the_screenshot_and_asks_the_vision_slot(paths, settings, services):
    brain = Brain(paths, settings.model_copy(update={"vision": settings.fast}), youtube_base=services.base_url)
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    screenshot = base64.b64encode(PNG).decode()
    assert client.post("/lens/judge", json={"view_id": "feed", "screenshot": screenshot}).json() == {"verdict": "matches", "problem": ""}
    (paths.views / "feed.md").write_text("# Feed\n\n## Layout\n* UGLY two columns.\n")
    assert client.post("/lens/judge", json={"view_id": "feed", "screenshot": screenshot}).json() == {"verdict": "differs", "problem": "the cards are not in two columns"}
    assert client.post("/lens/judge", json={"view_id": "feed", "screenshot": "not base64!"}).status_code == 422
    assert client.post("/lens/judge", json={"view_id": "feed", "screenshot": base64.b64encode(b"GIF89a").decode()}).status_code == 422
    services.queue_model_reply("judge_lens", None)
    services.queue_model_reply("judge_lens", None)
    assert client.post("/lens/judge", json={"view_id": "feed", "screenshot": screenshot}).json()["verdict"] == "skipped"
    brain.http.close()
