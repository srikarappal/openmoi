"""The learned ranker: features you can read, online learning from events, reasons, and NDCG against recency."""

import json
import random
from datetime import UTC, datetime, timedelta
from functools import partial

from moi_brain.compile import Condition, Rule
from moi_brain.config import Paths
from moi_brain.items import Event, normalize
from moi_brain.rank import describe, rank, with_explore
from moi_brain.ranker import MIN_EVENTS, Ranker, evaluate, features, history_days, main, ndcg, sigmoid
from moi_brain.store import Store

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
AUTHORS = ["maya", "ben", "troll", "brand", "news"]
TOPICS = ["science", "politics", "sports", "celebrity"]


def post(number: int, author: str, topic: str, hours: float, now: datetime = NOW):
    record = {"native_id": str(number), "url": f"https://x.com/{author}/status/{number}", "text": f"Post {number}", "author_handle": author, "published_at": (now - timedelta(hours=hours)).isoformat()}
    item = normalize("x", record, now)
    return item.model_copy(update={"topics": [topic], "extra": {"reading_minutes": "6" if topic == "science" else "1", "ragebait": "0.8" if author == "troll" else "0.0"}})


def test_features_say_what_an_item_is():
    found = features(post(1, "maya", "science", 24), NOW, boosts=10)
    assert found == {"bias": 1.0, "source:x": 1.0, "family:x": 1.0, "recency": 0.5, "author:maya": 1.0, "topic:science": 1.0, "long": 1.0, "ragebait": 0.0, "boosts": 1.0}
    odd = post(2, "maya", "science", 1).model_copy(update={"extra": {"reading_minutes": "lots"}, "author_handle": None, "topics": [], "media_kind": "short_video"})
    assert {name: value for name, value in features(odd, NOW).items() if name in ("long", "ragebait", "media:short_video")} == {"long": 0.0, "ragebait": 0.0, "media:short_video": 1.0}


def test_learning_from_opens_and_less_like_this_moves_scores_and_explains_them(tmp_path):
    ranker = Ranker(tmp_path / "ranker.json")
    liked, disliked = features(post(1, "maya", "science", 2), NOW), features(post(2, "troll", "politics", 2), NOW)
    assert not ranker.trained and ranker.score(liked) == 0.5
    ranker.learn([(liked, "open"), (disliked, "less_like_this")] * (MIN_EVENTS // 2))
    assert ranker.trained and ranker.score(liked) > 0.7 > 0.3 > ranker.score(disliked)
    assert set(ranker.reasons(liked)) <= {"you often open maya", "you like science", "you often open x"}
    assert ranker.reasons(disliked) == [] or "troll" not in " ".join(ranker.reasons(disliked))
    assert "science" in ranker.top_topics()
    assert Ranker(tmp_path / "ranker.json").state.events == MIN_EVENTS
    (tmp_path / "bad.json").write_text('{"weights": "many"}')
    assert Ranker(tmp_path / "bad.json").state.events == 0
    assert sigmoid(1000) < 1.0 + 1e-9 and sigmoid(-1000) > 0.0


def test_ndcg_rewards_putting_what_you_opened_first():
    assert ndcg(["a", "b", "c"], {"a"}) == 1.0
    assert round(ndcg(["b", "a", "c"], {"a"}), 4) == 0.6309
    assert ndcg(["a"], set()) == 0.0


def synthetic_days(count: int, seed: int = 7) -> list:
    """A person who opens Maya's posts and science, whatever their age, and ignores the newest noise."""
    chooser = random.Random(seed)
    days = []
    number = 0
    for day in range(count):
        now = NOW + timedelta(days=day)
        items = []
        for _ in range(40):
            number += 1
            items.append(post(number, chooser.choice(AUTHORS), chooser.choice(TOPICS), chooser.uniform(0, 24), now))
        opened = {item.item_id for item in items if item.author_handle == "maya" or "science" in item.topics}
        days.append((now, items, opened))
    return days


def test_the_model_beats_recency_by_at_least_fifteen_percent_on_a_month_of_history(tmp_path):
    result = evaluate(synthetic_days(30), tmp_path / "ranker.json")
    assert result["days"] == 30
    assert result["model"] >= result["recency"] * 1.15


def test_history_comes_from_the_store_and_the_command_line_runs(tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    (home / ".moi").mkdir(parents=True)
    store = Store(home / ".moi" / "openmoi.db")
    first, second = post(1, "maya", "science", 2), post(2, "ben", "sports", 1)
    store.upsert_items([first, second])
    store.add_events([Event(view_id="feed", item_id=first.item_id, event_kind="seen"), Event(view_id="feed", item_id=second.item_id, event_kind="seen"), Event(view_id="feed", item_id=first.item_id, event_kind="open")], NOW)
    [(day, items, opened)] = history_days(home / ".moi" / "openmoi.db")
    assert day.date() == NOW.date() and {item.item_id for item in items} == {first.item_id, second.item_id} and opened == {first.item_id}
    monkeypatch.setattr("moi_brain.ranker.load_paths", partial(Paths, home=home, assets=tmp_path))
    assert main(["evaluate"]) == 0
    assert json.loads(capsys.readouterr().out)["days"] == 1.0
    assert main([]) == 2


def trained_on_maya(tmp_path) -> Ranker:
    ranker = Ranker(tmp_path / "ranker.json")
    liked, ignored = features(post(1, "maya", "science", 30), NOW), features(post(2, "brand", "celebrity", 1), NOW)
    ranker.learn([(liked, "open"), (ignored, "seen")] * MIN_EVENTS)
    return ranker


def test_a_trained_model_ranks_what_you_open_first_and_says_why(tmp_path):
    ranker = trained_on_maya(tmp_path)
    old_maya, new_brand = post(10, "maya", "science", 30), post(11, "brand", "celebrity", 1)
    by_recency, _ = rank([old_maya, new_brand], [], NOW)
    assert [entry.item.author_handle for entry in by_recency] == ["brand", "maya"]
    learned, _ = rank([old_maya, new_brand], [], NOW, learned=ranker)
    assert [entry.item.author_handle for entry in learned] == ["maya", "brand"]
    assert any(reason in learned[0].reasons for reason in ("you often open maya", "you like science"))
    by_page, _ = rank([new_brand, old_maya], [], NOW, order="page", learned=ranker)
    assert [entry.item.author_handle for entry in by_page] == ["brand", "maya"]


def test_every_tenth_place_explores_outside_your_top_topics_unless_turned_off(tmp_path):
    ranker = trained_on_maya(tmp_path)
    usual = [post(100 + index, "maya", "science", index) for index in range(12)]
    other = [post(200, "ben", "sports", 50)]
    page, _ = rank(usual + other, [], NOW, learned=ranker)
    assert page[9].item.author_handle == "ben" and page[9].reasons[-1] == "explore: outside your usual topics"
    plain, _ = rank(usual + other, [], NOW, learned=ranker, explore=False)
    assert plain[-1].item.author_handle == "ben"
    assert with_explore([], set()) == ([], set())
    only_outside, explored = with_explore([(1.0, other[0], [])], {"science"})
    assert only_outside[0][1] == other[0] and explored == set()


def test_your_opens_teach_the_view_and_no_exploring_turns_the_slot_off(client, paths):
    (paths.views / "feed.md").write_text("# Feed\n\n## Sources\n* X home timeline\n\n## Rules\n* No exploring.\n")
    assert client.app.state.brain.compiler.compiled("feed").explore is False
    records = []
    for index in range(30):
        author = "maya" if index % 2 else "brand"
        records.append({"native_id": str(index), "url": f"/{author}/status/{index}", "text": f"Post {index} by {author}", "author_handle": author, "published_at": (datetime.now(UTC) - timedelta(hours=index)).isoformat()})
    items = client.post("/ingest", json={"source_id": "x", "records": records, "page_url": "https://x.com/home"}).json()["items"]
    events = [{"view_id": "feed", "item_id": item["item_id"], "event_kind": "open" if item["author_handle"] == "maya" else "seen"} for item in items]
    client.post("/events", json={"events": events})
    assert client.get("/debug").json()["ranker"] == {"events": 30, "trained": True}
    fresh = [{"native_id": f"n{index}", "url": f"/{author}/status/n{index}", "text": f"New post by {author}", "author_handle": author, "published_at": (datetime.now(UTC) - timedelta(hours=hours)).isoformat()} for index, (author, hours) in enumerate([("brand", 0), ("maya", 5)])]
    client.post("/ingest", json={"source_id": "x", "records": fresh, "page_url": "https://x.com/home"})
    texts = [entry["item"]["text"] for entry in client.post("/view/feed", json={}).json()["items"]]
    assert texts.index("New post by maya") < texts.index("New post by brand")


def test_rules_can_test_language_reading_time_and_rage_bait():
    spanish = post(1, "ana", "science", 1).model_copy(update={"extra": {"lang": "es", "reading_minutes": "12", "ragebait": "0.7"}})
    english = post(2, "ben", "science", 1).model_copy(update={"extra": {"lang": "en", "reading_minutes": "2", "ragebait": "0.1"}})
    for condition, kept in (
        (Condition(field="lang", op="eq", value="es"), "ben"),
        (Condition(field="reading_minutes", op="gt", value=10), "ben"),
        (Condition(field="ragebait", op="gt", value=0.5), "ben"),
        (Condition(field="ragebait", op="lt", value=0.5), "ana"),
    ):
        page, _ = rank([spanish, english], [Rule(when=condition, do="hide")], NOW)
        assert [entry.item.author_handle for entry in page] == [kept]
    assert describe(Condition(field="reading_minutes", op="gt", value=10)) == "reading time 10"


def test_a_rage_bait_judgment_counts_and_a_day_without_opens_still_teaches(tmp_path):
    judged = post(1, "troll", "politics", 1).model_copy(update={"extra": {"judged:rage_bait": "yes"}})
    assert features(judged, NOW)["ragebait"] == 0.9
    quiet_day = (NOW, [post(2, "ben", "sports", 1)], set())
    result = evaluate([quiet_day], tmp_path / "ranker.json")
    assert result == {"recency": 0.0, "model": 0.0, "days": 0.0}
    assert Ranker(tmp_path / "ranker.json").state.events == 1
