"""Learned ranking: a small logistic model of what you open, trained online from the event log and kept in
.moi/ranker.json. Features are ones you can read (source, author, topic, recency, media, length, rage bait, rule
boosts), so "why this?" comes from their contributions. Until it has learned from enough events, ranking stays by
recency and rule boosts.

    uv run python -m moi_brain.ranker evaluate     NDCG@20 of the model against recency on your own history
"""

import json
import math
import sqlite3
import sys
import threading
from collections.abc import Iterable
from datetime import datetime
from functools import partial
from pathlib import Path

from pydantic import BaseModel, Field

from moi_brain.config import load_paths
from moi_brain.files import read_json, write_atomic
from moi_brain.enrich import RAGE_JUDGMENTS
from moi_brain.items import JUDGED_PREFIX, Item, source_family

LEARNING_RATE = 0.2
L2 = 1e-4
MIN_EVENTS = 20
HALF_LIFE_HOURS = 24.0
LONG_MINUTES = 5
# How much each kind of event teaches: opening is a clear yes, less like this a clear no, scrolling past a faint no.
WEIGHTS = {"open": (1.0, 1.0), "less_like_this": (0.0, 3.0), "seen": (0.0, 0.3)}
NDCG_AT = 20


class RankerState(BaseModel):
    weights: dict[str, float] = Field(default_factory=dict)
    events: int = 0


def age_hours(item: Item, now: datetime) -> float:
    moment = item.published_at or item.fetched_at
    return max((now - moment).total_seconds() / 3600, 0.0)


def features(item: Item, now: datetime, boosts: float = 0.0) -> dict[str, float]:
    """The readable facts the model weighs for one item."""
    found = {"bias": 1.0, f"source:{item.source_id}": 1.0, f"family:{source_family(item.source_id)}": 1.0, "recency": 0.5 ** (age_hours(item, now) / HALF_LIFE_HOURS)}
    if item.author_handle:
        found[f"author:{item.author_handle.lower()}"] = 1.0
    for topic in item.topics:
        found[f"topic:{topic}"] = 1.0
    if item.media_kind:
        found[f"media:{item.media_kind}"] = 1.0
    try:
        found["long"] = 1.0 if int(item.extra.get("reading_minutes", "0")) >= LONG_MINUTES else 0.0
        found["ragebait"] = float(item.extra.get("ragebait", "0"))
    except ValueError:
        found["long"], found["ragebait"] = 0.0, 0.0
    if any(item.extra.get(f"{JUDGED_PREFIX}{name}") == "yes" for name in RAGE_JUDGMENTS):
        found["ragebait"] = max(found["ragebait"], 0.9)
    if boosts:
        found["boosts"] = boosts / 10
    return found


def sigmoid(value: float) -> float:
    return 1 / (1 + math.exp(-max(min(value, 30.0), -30.0)))


def explain(name: str) -> str | None:
    """A feature that pushed an item up, in plain words; None for ones not worth saying."""
    kind, _, value = name.partition(":")
    phrases = {"author": f"you often open {value}", "topic": f"you like {value}", "source": f"you often open {value}", "media": f"you like {value.replace('_', ' ')}"}
    return phrases.get(kind)


class Ranker:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        try:
            self.state = RankerState.model_validate(read_json(path, {}))
        except ValueError:
            self.state = RankerState()

    @property
    def trained(self) -> bool:
        return self.state.events >= MIN_EVENTS

    def score(self, found: dict[str, float]) -> float:
        with self.lock:
            return sigmoid(sum(self.state.weights.get(name, 0.0) * value for name, value in found.items()))

    def learn(self, examples: Iterable[tuple[dict[str, float], str]]) -> None:
        """One online step per example (features, event kind) and the model saved."""
        with self.lock:
            weights = self.state.weights
            for found, kind in examples:
                label, strength = WEIGHTS[kind]
                error = label - sigmoid(sum(weights.get(name, 0.0) * value for name, value in found.items()))
                for name, value in found.items():
                    weights[name] = weights.get(name, 0.0) * (1 - LEARNING_RATE * L2) + LEARNING_RATE * strength * error * value
                self.state.events += 1
            write_atomic(self.path, self.state.model_dump_json())

    def reasons(self, found: dict[str, float], limit: int = 2) -> list[str]:
        """The features that pushed this item up most, in plain words."""
        with self.lock:
            contributions = sorted(((self.state.weights.get(name, 0.0) * value, name) for name, value in found.items()), reverse=True)
        phrases = [phrase for weight, name in contributions if weight > 0.2 and (phrase := explain(name))]
        return phrases[:limit]

    def top_topics(self, count: int = 5) -> set[str]:
        with self.lock:
            topics = sorted(((weight, name) for name, weight in self.state.weights.items() if name.startswith("topic:") and weight > 0), reverse=True)
        return {name.removeprefix("topic:") for _, name in topics[:count]}


def dcg(relevances: list[float]) -> float:
    return sum(relevance / math.log2(position + 2) for position, relevance in enumerate(relevances))


def ndcg(ranked_ids: list[str], relevant: set[str], at: int = NDCG_AT) -> float:
    """How close the first `at` items come to putting every relevant item first: 1 is perfect, 0 none found."""
    ideal = dcg([1.0] * min(len(relevant), at))
    return dcg([1.0 if item_id in relevant else 0.0 for item_id in ranked_ids[:at]]) / ideal if ideal else 0.0


def evaluate(days: list[tuple[datetime, list[Item], set[str]]], path: Path) -> dict[str, float]:
    """NDCG@20 of recency and of the model, day by day: each day is ranked by a model trained on the days before it."""
    ranker = Ranker(path)
    recency_scores, model_scores = [], []
    for now, items, opened in days:
        if opened:
            by_recency = [item.item_id for item in sorted(items, key=partial(age_hours, now=now))]
            recency_scores.append(ndcg(by_recency, opened))
            scores = {item.item_id: ranker.score(features(item, now)) for item in items}
            model_scores.append(ndcg(sorted(scores, key=scores.__getitem__, reverse=True), opened) if ranker.trained else recency_scores[-1])
        ranker.learn((features(item, now), "open" if item.item_id in opened else "seen") for item in items)
    recency, model = (sum(scores) / len(scores) if scores else 0.0 for scores in (recency_scores, model_scores))
    return {"recency": round(recency, 4), "model": round(model, 4), "days": float(len(recency_scores))}


def history_days(db_path: Path) -> list[tuple[datetime, list[Item], set[str]]]:
    """Your own history by day, read straight from the store: the items you saw each day and the ones you opened."""
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "SELECT substr(events.ts, 1, 10), events.event_kind, items.item_json FROM events JOIN items ON items.item_id = events.item_id "
            "WHERE events.event_kind IN ('seen', 'open') ORDER BY events.ts"
        ).fetchall()
    days: dict[str, tuple[dict[str, Item], set[str]]] = {}
    for day, kind, item_json in rows:
        item = Item.model_validate_json(item_json)
        items, opened = days.setdefault(day, ({}, set()))
        items[item.item_id] = item
        if kind == "open":
            opened.add(item.item_id)
    return [(datetime.fromisoformat(f"{day}T23:59:59+00:00"), list(items.values()), opened) for day, (items, opened) in days.items()]


def main(arguments: list[str]) -> int:
    if arguments == ["evaluate"]:
        paths = load_paths()
        print(json.dumps(evaluate(history_days(paths.db), paths.state / "ranker_evaluation.json")))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
