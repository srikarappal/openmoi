"""Topic tagging: the fast model marks which watched topics each item is about.

Tagging uses a closed watch list (a few common topics plus every topic your rules name),
so tags and rules always speak the same words. When rules start watching a new topic,
recent items are retagged in the background.
"""

import json
import threading
from datetime import datetime, timedelta
from itertools import batched
from pathlib import Path

from pydantic import BaseModel, Field

from moi_brain.compile import CompiledView, Rule
from moi_brain.items import Item
from moi_brain.llm import Gateway, LlmError
from moi_brain.store import Store

BASE_TOPICS = ("politics", "crypto", "sports", "celebrity", "technology", "science", "business", "health", "gaming", "climate")
BATCH_SIZE = 20
RETAG_WINDOW = timedelta(days=3)
MAX_RETAG = 200
MAX_TAG_TEXT = 300
SYSTEM_PROMPT = """You tag feed items with topics for openMoi, a personal feed reader.
Reply with one JSON object: {"tags": [{"item_id": "...", "topics": ["..."]}]}.
Use only topics from the list you are given. An item can have several topics or none.
Tag by meaning, not by exact words: an article about an election is politics, a video about galaxies is science."""


class ItemTopics(BaseModel):
    item_id: str
    topics: list[str] = Field(default_factory=list)


class TagReply(BaseModel):
    tags: list[ItemTopics] = Field(default_factory=list)


def rule_topics(rules: list[Rule]) -> set[str]:
    topics: set[str] = set()
    for rule in rules:
        for condition in (rule.when, rule.unless):
            if condition and condition.field == "topic":
                values = condition.value if isinstance(condition.value, list) else [condition.value]
                topics |= {str(value).strip().lower() for value in values if str(value).strip()}
    return topics


def watch_list(views: list[CompiledView]) -> list[str]:
    topics = set(BASE_TOPICS)
    for view in views:
        topics |= rule_topics(view.rules)
    return sorted(topics)


def tag_prompt(items: list[Item], topics: list[str]) -> list[dict[str, str]]:
    payload = {
        "topics": topics,
        "items": [
            {"item_id": item.item_id, "source_id": item.source_id, "title": item.title or "", "text": (item.text or "")[:MAX_TAG_TEXT]}
            for item in items
        ],
    }
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": json.dumps(payload)}]


class Tagger:
    def __init__(self, store: Store, gateway: Gateway, state_file: Path):
        self.store = store
        self.gateway = gateway
        self.state_file = state_file
        self.status = "ok"
        self.lock = threading.Lock()
        self.retagging = False
        self.tagged_topics: list[str] = json.loads(state_file.read_text()) if state_file.exists() else list(BASE_TOPICS)

    def tag(self, items: list[Item], topics: list[str]) -> list[Item]:
        """Items with topics set; a batch the model could not tag keeps the topics it had."""
        tagged: list[Item] = []
        for batch in batched(items, BATCH_SIZE):
            topics_by_id = self.tag_batch(list(batch), topics)
            if topics_by_id is None:
                tagged += batch
            else:
                tagged += [item.model_copy(update={"topics": topics_by_id.get(item.item_id, [])}) for item in batch]
        return tagged

    def tag_batch(self, batch: list[Item], topics: list[str]) -> dict[str, list[str]] | None:
        try:
            reply = self.gateway.complete_json("fast", "tag", tag_prompt(batch, topics), True, TagReply)
        except LlmError as error:
            self.status = f"Topic tagging paused: {error}"
            return None
        self.status = "ok"
        allowed = set(topics)
        batch_ids = {item.item_id for item in batch}
        return {
            entry.item_id: sorted({topic.strip().lower() for topic in entry.topics} & allowed)
            for entry in reply.tags
            if entry.item_id in batch_ids
        }

    def ensure_current(self, topics: list[str], now: datetime) -> None:
        """Start a background retag of recent items when rules watch topics they were not tagged for."""
        with self.lock:
            if self.retagging or set(topics) <= set(self.tagged_topics):
                return
            self.retagging = True
        threading.Thread(target=self.retag, args=(topics, now), daemon=True).start()

    def retag(self, topics: list[str], now: datetime) -> None:
        try:
            items = self.store.recent_items(now - RETAG_WINDOW)[:MAX_RETAG]
            tagged = self.tag(items, topics)
            self.store.update_topics({item.item_id: item.topics for item in tagged})
            if self.status == "ok":
                self.tagged_topics = topics
                self.state_file.write_text(json.dumps(topics))
        finally:
            with self.lock:
                self.retagging = False
