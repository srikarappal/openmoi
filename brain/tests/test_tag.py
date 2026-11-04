import json
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from moi_brain.compile import CompiledView, Condition, Rule
from moi_brain.config import Settings, Slot
from moi_brain.items import normalize
from moi_brain.llm import Gateway
from moi_brain.store import Store
from moi_brain.tag import BASE_TOPICS, Tagger, rule_topics, watch_list

NOW = datetime.now(UTC)
TOPICS = ["politics", "sourdough", "technology"]


def make_item(native_id: str, title: str, hours_old: float = 1.0):
    published = (NOW - timedelta(hours=hours_old)).isoformat()
    return normalize("rss:a", {"native_id": native_id, "url": f"https://a.com/{native_id}", "title": title, "published_at": published}, NOW)


def wait_idle(tagger: Tagger, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while tagger.busy and time.monotonic() < deadline:
        time.sleep(0.01)


def explode(item_ids: list[str]) -> dict:
    raise RuntimeError("disk on fire")


class TopicList:
    """A changeable watch list, standing in for the brain's compiled views."""

    def __init__(self, topics: list[str]):
        self.topics = topics

    def __call__(self) -> list[str]:
        return self.topics


@pytest.fixture
def tagger(tmp_path, settings):
    with httpx.Client(timeout=5) as http:
        yield Tagger(Store(tmp_path / "db.sqlite"), Gateway(settings, tmp_path / "calls.jsonl", http), tmp_path / "tagged.json", TopicList(TOPICS))


def topic_rule(value, unless_value=None):
    unless = Condition(field="topic", op="eq", value=unless_value) if unless_value else None
    return Rule(when=Condition(field="topic", op="in", value=value), unless=unless, do="hide")


def test_rule_topics_and_watch_list():
    rules = [topic_rule(["Crypto", " art "], "music"), Rule(when=Condition(field="text", op="contains", value="x"), do="hide")]
    assert rule_topics(rules) == {"crypto", "art", "music"}
    view = CompiledView(view_id="feed", title="Feed", file_hash="h", rules=rules)
    assert watch_list([view]) == sorted({*BASE_TOPICS, "art", "music"})


def test_tag_uses_only_watched_topics_in_batches(tagger, services):
    items = [make_item(str(index), "Election night" if index % 2 else "New laptop chip") for index in range(25)]
    tagged = tagger.tag(items, ["politics", "technology"])
    assert [(item.topics, item.tagged) for item in tagged[:2]] == [(["technology"], True), (["politics"], True)]
    calls = services.model_calls("tag")
    assert [len(json.loads(call["payload"]["messages"][1]["content"])["items"]) for call in calls] == [10, 10, 5]


def test_model_topics_outside_the_list_or_batch_are_ignored(tagger, services):
    item = make_item("1", "anything")
    reply = {"tags": [{"item_id": item.item_id, "topics": ["Politics", "aliens"]}, {"item_id": "other", "topics": ["politics"]}]}
    services.queue_model_reply("tag", json.dumps(reply))
    assert tagger.tag([item], ["politics"])[0].topics == ["politics"]


def test_failed_batches_come_back_unchanged_and_report(tagger, services):
    item = make_item("1", "Election night").model_copy(update={"topics": ["old"]})
    services.queue_model_reply("tag", None)
    [unchanged] = tagger.tag([item], ["politics"])
    assert (unchanged.topics, unchanged.tagged) == (["old"], False)
    assert tagger.status.startswith("Topic tagging paused:")
    assert not tagger.healthy
    tagger.tag([item], ["politics"])
    assert tagger.healthy


def test_worker_tags_queued_items_in_the_background(tagger):
    items = [make_item("1", "Election night"), make_item("2", "Sourdough starter tips")]
    tagger.store.upsert_items(items)
    tagger.enqueue(items)
    assert tagger.busy
    wait_idle(tagger)
    stored = tagger.store.get_items([item.item_id for item in items])
    assert [(stored[item.item_id].topics, stored[item.item_id].tagged) for item in items] == [(["politics"], True), (["sourdough"], True)]


def test_worker_leaves_items_untagged_when_the_model_is_down(tagger, services):
    item = make_item("1", "Election night")
    tagger.store.upsert_items([item])
    services.queue_model_reply("tag", None)
    tagger.enqueue([item])
    wait_idle(tagger)
    assert tagger.store.get_item(item.item_id).tagged is False
    tagger.enqueue([item])
    wait_idle(tagger)
    assert tagger.store.get_item(item.item_id).topics == ["politics"]


def test_worker_survives_unexpected_errors(tagger, monkeypatch):
    item = make_item("1", "Election night")
    tagger.store.upsert_items([item])
    original = tagger.store.get_items
    monkeypatch.setattr(tagger.store, "get_items", explode)
    tagger.enqueue([item])
    wait_idle(tagger)
    monkeypatch.setattr(tagger.store, "get_items", original)
    tagger.enqueue([item])
    wait_idle(tagger)
    assert tagger.store.get_item(item.item_id).tagged is True


def test_new_topics_send_recent_items_back_through_the_worker_once(tagger, tmp_path, services):
    recent, old = make_item("1", "Sourdough starter tips"), make_item("2", "Sourdough history", hours_old=24 * 5)
    tagger.store.upsert_items([recent, old])
    tagger.ensure_current(list(BASE_TOPICS), NOW)
    assert not tagger.busy
    tagger.ensure_current(TOPICS, NOW)
    wait_idle(tagger)
    assert tagger.store.get_item(recent.item_id).topics == ["sourdough"]
    assert tagger.store.get_item(old.item_id).tagged is False
    assert json.loads((tmp_path / "tagged.json").read_text()) == TOPICS
    calls = len(services.model_calls("tag"))
    tagger.ensure_current(TOPICS, NOW)
    wait_idle(tagger)
    assert len(services.model_calls("tag")) == calls
    assert Tagger(tagger.store, tagger.gateway, tmp_path / "tagged.json", TopicList(TOPICS)).tagged_topics == TOPICS


def test_hosted_fast_slot_without_the_switch_pauses_tagging(tmp_path):
    hosted = Slot(base_url="https://models.example.com/v1", model="big")
    with httpx.Client(timeout=1) as http:
        gateway = Gateway(Settings(fast=hosted, smart=hosted), tmp_path / "c.jsonl", http)
        tagger = Tagger(Store(tmp_path / "db.sqlite"), gateway, tmp_path / "t.json", TopicList(["politics"]))
        assert tagger.tag([make_item("1", "Election")], ["politics"])[0].topics == []
    assert "allow_content_to_hosted" in tagger.status
