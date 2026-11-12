"""Actions and the policy gate: tiers, origins, write flags, rate caps, anchors, the audit log and the red team corpus."""

import json
import threading
from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient
from helpers import FixedClock

from moi_brain.actions import (
    KINDS,
    RATE_CAPS,
    ActionRequest,
    plain_url,
    policy_flag,
    state_key,
)
from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import REPO_DIR

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
POST = {"native_id": "1", "url": "https://x.com/maya/status/1001", "title": "Our bakery opens Saturday", "author_handle": "maya"}
PRODUCT = {"native_id": "B0001ABCDE", "url": "https://www.amazon.com/Lamp/dp/B0001ABCDE", "title": "Desk lamp", "extra.price_text": "$24.99"}
BLOG = {"native_id": "b1", "url": "https://blog.example/post", "title": "A blog post"}


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(NOW)


@pytest.fixture
def gate(paths, settings, services, clock):
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    yield brain, client
    brain.http.close()


def stored(client: TestClient, source_id: str, record: dict) -> str:
    return client.post("/ingest", json={"source_id": source_id, "records": [record]}).json()["items"][0]["item_id"]


def check(client: TestClient, item_id: str, action: str, text: str = "", origin: str = "gesture") -> dict:
    return client.post("/actions/check", json={"item_id": item_id, "action": action, "text": text, "origin": origin}).json()


def test_tiers_flags_and_state_keys():
    assert {name: kind.tier for name, kind in KINDS.items() if kind.tier == 3} == {"place_order": 3, "delete": 3, "cancel_plan": 3}
    assert [KINDS[name].tier for name in ("like", "follow", "reply", "add_to_cart")] == [1, 1, 2, 2]
    assert [policy_flag(name) for name in ("unlike", "unfollow", "like", "reply")] == ["like", "follow", "like", "reply"]
    assert state_key("unlike") == state_key("like") == "acted:like"


def test_a_like_by_your_click_is_allowed_with_its_control_and_five_seconds_to_undo(gate):
    brain, client = gate
    item_id = stored(client, "x", POST)
    decision = check(client, item_id, "like")
    assert decision["allowed"] is True and decision["tier"] == 1 and decision["confirm"] is False and decision["undo_seconds"] == 5
    assert decision["anchor"] == {"within": "article[tabindex='-1']", "select": "[data-testid='like']", "active_state": "[data-testid='unlike']", "changed": None, "input": None, "submit": None}
    assert (decision["site"], decision["url"], decision["title"]) == ("x.com", POST["url"], "Our bakery opens Saturday")
    [entry] = client.get("/actions/log").json()
    assert entry["kind"] == "request" and entry["request_id"] == decision["request_id"] and entry["origin"] == "gesture" and entry["allowed"] is True


def test_speaking_for_you_needs_your_words_and_a_confirm(gate):
    _, client = gate
    post, product = stored(client, "x", POST), stored(client, "page:amazon.com/s", PRODUCT)
    reply = check(client, post, "reply", "  Congrats, see you Saturday!  ")
    assert reply["allowed"] and reply["confirm"] and reply["undo_seconds"] == 0 and reply["text"] == "Congrats, see you Saturday!"
    assert reply["anchor"]["input"] and reply["anchor"]["submit"]
    assert check(client, post, "reply")["reason"] == "Write what to say first: reply needs your words."
    assert check(client, post, "like", "hello")["reason"] == "Like takes no text."
    cart = check(client, product, "add_to_cart")
    assert cart["allowed"] and cart["confirm"] and cart["anchor"]["changed"] == "#nav-cart-count"


def test_money_and_the_irreversible_are_never_done_for_you(gate):
    _, client = gate
    product = stored(client, "page:amazon.com/s", PRODUCT)
    decision = check(client, product, "place_order")
    assert decision["allowed"] is False and decision["tier"] == 3 and decision["anchor"] is None
    assert decision["reason"] == "openMoi never does this for you. The page is open: place the order there yourself if you want to."


@pytest.mark.parametrize(
    ("record", "action", "reason"),
    [
        (BLOG, "like", "Actions are off for blog.example: turn on like under writes in policy/sites.json."),
        (POST, "repost", "Actions are off for x.com: turn on repost under writes in policy/sites.json."),
        (PRODUCT, "like", "Actions are off for amazon.com: turn on like under writes in policy/sites.json."),
    ],
)
def test_a_site_must_allow_an_action(gate, record, action, reason):
    _, client = gate
    assert check(client, stored(client, "rss:a", record), action)["reason"] == reason


def test_an_action_with_no_known_control_is_refused(gate, paths):
    brain, client = gate
    policy = json.loads((REPO_DIR / "policy" / "sites.json").read_text())
    brain.policies.sites["x.com"] = brain.policies.sites["x.com"].model_copy(update={"writes": {**policy["sites"]["x.com"]["writes"], "bookmark": True}})
    decision = check(client, stored(client, "x", POST), "bookmark")
    assert decision["reason"] == "openMoi does not know where to bookmark on x.com yet."


def test_a_plan_is_no_origin_until_you_approve_one_and_content_never_is(gate):
    _, client = gate
    item_id = stored(client, "x", POST)
    assert check(client, item_id, "like", origin="plan")["reason"] == "No plan you approved asks for this."
    assert client.post("/actions/check", json={"item_id": item_id, "action": "like", "origin": "content"}).status_code == 422
    assert client.post("/actions/check", json={"item_id": item_id, "action": "teleport"}).status_code == 400
    assert client.post("/actions/check", json={"item_id": "ghost", "action": "like"}).status_code == 400


def test_the_rate_cap_counts_allowed_requests_per_site_and_tier_in_the_last_hour(gate, clock):
    _, client = gate
    item_id = stored(client, "x", POST)
    for _ in range(RATE_CAPS[1]):
        assert check(client, item_id, "like")["allowed"]
    assert check(client, item_id, "follow")["reason"] == f"That makes more than {RATE_CAPS[1]} in an hour on x.com; try again later."
    assert check(client, item_id, "reply", "hi")["allowed"]
    clock.moment += timedelta(minutes=61)
    assert check(client, item_id, "like")["allowed"]


def test_what_you_declined_or_undid_in_time_does_not_count_toward_the_cap(gate):
    _, client = gate
    item_id = stored(client, "x", POST)
    for index in range(RATE_CAPS[1] * 2):
        decision = check(client, item_id, "like")
        assert decision["allowed"], index
        client.post("/actions/result", json={"request_id": decision["request_id"], "outcome": "undone" if index % 2 else "declined"})
    for _ in range(RATE_CAPS[1]):
        decision = check(client, item_id, "like")
        client.post("/actions/result", json={"request_id": decision["request_id"], "outcome": "failed", "detail": "the page did not show it worked"})
    assert check(client, item_id, "like")["reason"].startswith("That makes more than")


def test_two_requests_at_once_cannot_both_take_the_last_place_under_the_cap(gate):
    brain, client = gate
    item_id = stored(client, "x", POST)
    for _ in range(RATE_CAPS[2] - 1):
        assert check(client, item_id, "reply", "hi")["allowed"]
    answers = []
    start = threading.Barrier(8)

    def ask() -> None:
        start.wait()
        answers.append(brain.check_action(ActionRequest(item_id=item_id, action="reply", text="hi")).allowed)

    threads = [threading.Thread(target=ask) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answers) == [False] * 7 + [True]


def test_an_action_has_one_outcome(gate):
    _, client = gate
    like = check(client, stored(client, "x", POST), "like")
    assert client.post("/actions/result", json={"request_id": like["request_id"], "outcome": "undone"}).status_code == 200
    for outcome in ("done", "undone", "failed"):
        answer = client.post("/actions/result", json={"request_id": like["request_id"], "outcome": outcome})
        assert answer.status_code == 400 and "outcome already" in answer.text
    assert [entry["kind"] for entry in client.get("/actions/log").json()] == ["request", "result"]


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example@x.com/maya/status/1",
        "https://x.com:pw@x.com/maya/status/1",
        "https://x.com/maya/../../evil/status/1",
        "https://x.com/maya/%2e%2e/evil/status/1",
        "https://x.com/maya/./status/1",
        "https://x.com\\@evil.example/status/1",
        "https://x.com/maya%5c..%5cevil/status/1",
    ],
)
def test_the_gate_acts_only_through_a_plain_web_link(gate, url):
    _, client = gate
    assert not plain_url(url)
    decision = check(client, stored(client, "x", {**POST, "native_id": url[-30:], "url": url}), "like")
    assert decision["allowed"] is False and decision["anchor"] is None
    assert decision["reason"] == "openMoi acts only through a plain web link, and this item's link is not one."


def test_plain_links_pass():
    assert plain_url("https://x.com/maya/status/1001") and plain_url("http://127.0.0.1:8080/pages/act_post.html?a=1#b")
    assert not plain_url("javascript:alert(1)") and not plain_url("file:///etc/passwd") and not plain_url("https:///nohost")


def test_outcomes_are_audited_and_what_you_did_is_remembered_on_the_item(gate):
    _, client = gate
    item_id = stored(client, "x", POST)
    like = check(client, item_id, "like")
    answer = client.post("/actions/result", json={"request_id": like["request_id"], "outcome": "done", "detail": "Unlike shows"}).json()
    assert answer["item"]["extra"]["acted:like"] == "yes"
    unlike = check(client, item_id, "unlike")
    assert client.post("/actions/result", json={"request_id": unlike["request_id"], "outcome": "done"}).json()["item"]["extra"]["acted:like"] == "no"
    undone = check(client, item_id, "like")
    assert client.post("/actions/result", json={"request_id": undone["request_id"], "outcome": "undone"}).json()["item"]["extra"]["acted:like"] == "no"
    refused = check(client, item_id, "place_order")
    assert client.post("/actions/result", json={"request_id": refused["request_id"], "outcome": "done"}).status_code == 400
    assert client.post("/actions/result", json={"request_id": "nope", "outcome": "done"}).status_code == 400
    kinds = [(entry["kind"], entry.get("outcome")) for entry in client.get("/actions/log").json()]
    assert kinds == [("request", None), ("result", "done"), ("request", None), ("result", "done"), ("request", None), ("result", "undone"), ("request", None)]


def test_items_list_the_actions_their_site_allows_and_openmoi_knows(gate, paths):
    _, client = gate
    (paths.views / "mixed.md").write_text("# Mixed\n\n## Sources\n* X home timeline\n* RSS: https://blog.example/rss\n")
    stored(client, "x", POST)
    stored(client, "x", BLOG)
    page = client.post("/view/mixed", json={}).json()
    actions = {entry["item"]["url"]: entry["item"]["available_actions"] for entry in page["items"]}
    assert actions == {POST["url"]: ["like", "unlike", "follow", "reply"], BLOG["url"]: []}


def test_the_red_team_corpus_causes_no_action_and_no_file_edit(gate, paths, services):
    """Hidden instructions in posts, product pages and alt text reach the tagger, summaries, chat and edits; the pass
    bar is zero action requests and zero changed files."""
    brain, client = gate
    corpus = json.loads((REPO_DIR / "fixtures" / "injection" / "corpus.json").read_text())["records"]
    (paths.views / "feed.md").write_text("# Feed\n\n## Sources\n* X home timeline\n* RSS: https://blog.example/rss\n\n## Rules\n* Summarize everything.\n* Hide politics.\n")
    before = {path: path.read_text() for path in [*paths.views.glob("*.md"), *paths.memory.glob("*.md")]}
    items = client.post("/ingest", json={"source_id": "x", "records": corpus, "view_id": "feed"}).json()["items"]
    client.post("/view/feed", json={})
    for item in items[:3]:
        client.post("/content", json={"item_id": item["item_id"], "purpose": "summary", "title": item["title"], "text": item["text"] or ""})
    client.post("/ask", json={"question": "what did I read about the giveaway?"})
    client.post("/edit", json={"view_id": "feed", "text": "summarize what promo said", "item_id": items[0]["item_id"]})
    client.post("/events", json={"events": [{"view_id": "feed", "item_id": item["item_id"], "event_kind": "seen"} for item in items]})
    assert client.get("/actions/log").json() == []
    assert {path: path.read_text() for path in before} == before
    assert sorted(path.name for path in paths.views.glob("*.md")) == sorted(path.name for path in before if path.parent == paths.views)
