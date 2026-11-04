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


def make_item(native_id: str, title: str):
    return normalize("rss:a", {"native_id": native_id, "url": f"https://a.com/{native_id}", "title": title, "published_at": NOW.isoformat()}, NOW)


@pytest.fixture
def tagger(tmp_path, settings):
    with httpx.Client(timeout=5) as http:
        yield Tagger(Store(tmp_path / "db.sqlite"), Gateway(settings, tmp_path / "calls.jsonl", http), tmp_path / "tagged.json")


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
    assert [item.topics for item in tagged[:2]] == [["technology"], ["politics"]]
    calls = services.model_calls("tag")
    assert [len(json.loads(call["payload"]["messages"][1]["content"])["items"]) for call in calls] == [20, 5]


def test_model_topics_outside_the_list_or_batch_are_ignored(tagger, services):
    item = make_item("1", "anything")
    reply = {"tags": [{"item_id": item.item_id, "topics": ["Politics", "aliens"]}, {"item_id": "other", "topics": ["politics"]}]}
    services.queue_model_reply("tag", json.dumps(reply))
    assert tagger.tag([item], ["politics"])[0].topics == ["politics"]


def test_failed_batches_keep_existing_topics_and_report(tagger, services):
    item = make_item("1", "Election night").model_copy(update={"topics": ["old"]})
    services.queue_model_reply("tag", None)
    assert tagger.tag([item], ["politics"])[0].topics == ["old"]
    assert tagger.status.startswith("Topic tagging paused:")
    tagger.tag([item], ["politics"])
    assert tagger.status == "ok"


def test_retag_runs_once_for_new_topics_and_remembers(tagger, tmp_path):
    item = make_item("1", "Sourdough starter tips")
    tagger.store.upsert_items([item])
    tagger.ensure_current(list(BASE_TOPICS), NOW)
    assert tagger.retagging is False
    topics = sorted({*BASE_TOPICS, "sourdough"})
    tagger.ensure_current(topics, NOW)
    deadline = time.monotonic() + 5
    while tagger.retagging and time.monotonic() < deadline:
        time.sleep(0.02)
    assert tagger.store.get_item(item.item_id).topics == ["sourdough"]
    assert json.loads((tmp_path / "tagged.json").read_text()) == topics
    reloaded = Tagger(tagger.store, tagger.gateway, tmp_path / "tagged.json")
    assert reloaded.tagged_topics == topics


def test_retag_skips_items_outside_the_window(tagger):
    old = make_item("old", "Sourdough history").model_copy(update={"published_at": NOW - timedelta(days=5)})
    tagger.store.upsert_items([old])
    tagger.retag(["sourdough"], NOW)
    assert tagger.store.get_item(old.item_id).topics == []


def test_hosted_fast_slot_without_the_switch_pauses_tagging(tmp_path):
    hosted = Slot(base_url="https://models.example.com/v1", model="big")
    with httpx.Client(timeout=1) as http:
        tagger = Tagger(Store(tmp_path / "db.sqlite"), Gateway(Settings(fast=hosted, smart=hosted), tmp_path / "c.jsonl", http), tmp_path / "t.json")
        assert tagger.tag([make_item("1", "Election")], ["politics"])[0].topics == []
    assert "allow_content_to_hosted" in tagger.status
