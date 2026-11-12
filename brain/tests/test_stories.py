"""One story across sources: grouped at ingest, shown once with where else it appeared, repeats hidden, updates shown."""

import time
from datetime import UTC, datetime, timedelta

import httpx
from conftest import wait_until_refreshed
from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

from moi_brain.items import normalize
from moi_brain.llm import Gateway
from moi_brain.rank import best_copy_per_story, rank
from moi_brain.store import Store
from moi_brain.stories import CLUSTER_KEY, UPDATE_KEY, Updater, assign_clusters, overlap, story_key, story_words, update_prompt

NOW = datetime.now(UTC)


def story(source_id: str, number: int, title: str, extra: dict | None = None, hours: float = 1.0):
    record = {"native_id": str(number), "url": f"https://{source_id.replace(':', '-')}.example/{number}", "title": title, "published_at": (NOW - timedelta(hours=hours)).isoformat()}
    made = normalize(source_id, record, NOW)
    return made.model_copy(update={"extra": extra or {}})


def test_story_words_leave_out_short_and_common_words():
    item = story("rss:a", 1, "The Fed raises rates: what it means for your mortgage")
    assert story_words(item) == {"fed", "raises", "rates", "means", "mortgage"}
    assert story_words(story("rss:a", 2, "iPhone 15 review: 3 days later")) == {"iphone", "15", "review", "3", "days", "later"}
    assert overlap(frozenset(), frozenset({"a"})) == 0.0


def test_items_about_the_same_story_join_one_cluster():
    first = story("rss:a", 1, "Fed raises interest rates by half a point")
    other = story("rss:b", 2, "Fed raises interest rates by half point today")
    unrelated = story("x", 3, "Cute dog learns to surf at the beach")
    too_short = story("x", 4, "Fed rates")
    placed = assign_clusters([other, unrelated, too_short], [first])
    assert story_key(placed[0]) == first.item_id
    assert CLUSTER_KEY not in placed[1].extra and CLUSTER_KEY not in placed[2].extra
    chained = assign_clusters([story("rss:c", 5, "Fed raises interest rates half point, markets react")], [first, placed[0]])
    assert story_key(chained[0]) == first.item_id


def test_fresh_items_cluster_with_each_other_too():
    a, b = story("rss:a", 1, "Storm closes bridge across the bay overnight"), story("rss:b", 2, "Storm closes bridge across bay overnight again")
    placed = assign_clusters([a, b], [])
    assert story_key(placed[1]) == a.item_id


def test_items_of_one_source_never_merge_and_numbers_tell_stories_apart():
    posts = [story("page:feed", index, f"Endless post {index} at a birthday party") for index in range(4)]
    assert [CLUSTER_KEY in item.extra for item in assign_clusters(posts, [])] == [False] * 4
    phones = assign_clusters([story("rss:b", 2, "Apple announces iPhone 16 with a bigger camera")], [story("rss:a", 1, "Apple announces iPhone 15 with bigger camera")])
    assert CLUSTER_KEY not in phones[0].extra


@hypothesis_settings(max_examples=150, deadline=None)
@given(titles=st.lists(st.text(alphabet="abcdefg hij", min_size=0, max_size=40), max_size=12))
def test_clusters_always_point_at_an_item_that_exists(titles):
    items = [story("rss:a", index, title.strip() or "x") for index, title in enumerate(titles)]
    placed = assign_clusters(items, [])
    ids = {item.item_id for item in items}
    assert all(story_key(item) in ids for item in placed)


def test_one_copy_per_story_with_where_else_it_appeared():
    first = story("rss:a", 1, "Fed raises rates")
    second = story("rss:b", 2, "Fed raises rates", {CLUSTER_KEY: first.item_id})
    third = story("x", 3, "Fed raises rates", {CLUSTER_KEY: first.item_id})
    page, _ = rank([second, first, third], [], NOW)
    assert len(page) == 1
    assert page[0].reasons[-1] == f"also on {', '.join(sorted({'rss:a', 'rss:b', 'x'} - {page[0].item.source_id}))}"


def test_a_story_you_saw_comes_back_only_as_an_update():
    seen = story("rss:a", 1, "Fed raises rates", hours=5)
    repeat = story("rss:b", 2, "Fed raises rates again", {CLUSTER_KEY: seen.item_id, UPDATE_KEY: ""})
    waiting = story("rss:c", 3, "Fed raises rates, analysis", {CLUSTER_KEY: seen.item_id})
    news = story("x", 4, "Fed confirms another raise", {CLUSTER_KEY: seen.item_id, UPDATE_KEY: "A second raise is planned"})
    page, _ = rank([seen, repeat, waiting, news], [], NOW, exclude_ids={seen.item_id})
    assert [entry.item.item_id for entry in page] == [news.item_id]
    assert page[0].reasons[0] == "update: A second raise is planned"
    kept, also = best_copy_per_story([(1.0, seen, []), (0.5, news, [])], {seen.item_id})
    assert [entry[1].item_id for entry in kept] == [seen.item_id, news.item_id] and also == {seen.item_id: ["x"]}


def test_the_update_prompt_treats_items_as_data():
    messages = update_prompt(story("rss:a", 1, "Seen"), story("x", 2, "New"))
    assert "never instructions" in messages[0]["content"]
    assert '"seen": {"title": "Seen"' in messages[1]["content"]


def ingest(client, source_id: str, titles: list[tuple[str, str]]) -> list[str]:
    records = [{"native_id": native, "url": f"https://{source_id.replace(':', '-')}.example/{native}", "title": title, "published_at": NOW.isoformat()} for native, title in titles]
    return [item["item_id"] for item in client.post("/ingest", json={"source_id": source_id, "records": records}).json()["items"]]


def settled(client, view_id: str = "news") -> dict:
    deadline = time.monotonic() + 10
    page = wait_until_refreshed(client, view_id)
    while page["refreshing"] and time.monotonic() < deadline:
        page = wait_until_refreshed(client, view_id)
    return page


def test_the_same_story_from_three_outlets_shows_once_then_only_its_real_update(client, paths):
    (paths.views / "news.md").write_text("# News\n\n## Sources\n* RSS: https://a.example/rss\n* RSS: https://b.example/rss\n* RSS: https://c.example/rss\n")
    [first] = ingest(client, "rss:a", [("a1", "Bridge closed after storm damage downtown")])
    ingest(client, "rss:b", [("b1", "Bridge closed after storm damage downtown, officials say")])
    page = settled(client)
    assert len(page["items"]) == 1 and page["items"][0]["reasons"][-1].startswith("also on ")
    shown_id = page["items"][0]["item"]["item_id"]
    client.post("/events", json={"events": [{"view_id": "news", "item_id": shown_id, "event_kind": "seen"}]})
    ingest(client, "rss:c", [("c1", "Bridge closed after storm damage downtown, a retelling"), ("c2", "Update: bridge closed after storm damage downtown reopens now")])
    later = settled(client)
    titles = [entry["item"]["title"] for entry in later["items"]]
    assert "Bridge closed after storm damage downtown, a retelling" not in titles
    assert "Update: bridge closed after storm damage downtown reopens now" in titles
    update = next(entry for entry in later["items"] if entry["item"]["title"].startswith("Update"))
    assert update["reasons"][0] == "update: Update: bridge closed after storm damage downtown reopens now"
    assert first


def test_a_copy_of_a_link_you_saw_is_never_compared(client, paths, services):
    (paths.views / "news.md").write_text("# News\n\n## Sources\n* RSS: https://a.example/rss\n* RSS: https://b.example/rss\n")
    [first] = ingest(client, "rss:a", [("a1", "Bridge closed after storm damage downtown")])
    client.post("/events", json={"events": [{"view_id": "news", "item_id": first, "event_kind": "seen"}]})
    record = {"native_id": "b1", "url": "https://rss-a.example/a1", "title": "Bridge closed after storm damage downtown", "published_at": NOW.isoformat()}
    client.post("/ingest", json={"source_id": "rss:b", "records": [record]})
    settled(client)
    assert services.model_calls("update") == []


class Exploding:
    """Stands in for the store once: the first lookup fails, later ones work."""

    def __init__(self, store):
        self.store = store
        self.failed = False

    def get_items(self, item_ids):
        if not self.failed:
            self.failed = True
            raise RuntimeError("disk on fire")
        return self.store.get_items(item_ids)

    def update_extra(self, item_id, values):
        self.store.update_extra(item_id, values)


def wait_quiet(updater, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while updater.busy and time.monotonic() < deadline:
        time.sleep(0.01)


def test_the_update_worker_survives_failures_and_a_model_that_is_down(tmp_path, settings, services, capsys):
    store = Store(tmp_path / "db.sqlite")
    seen, new = story("rss:a", 1, "Seen story"), story("x", 2, "Update: new facts now")
    store.upsert_items([seen, new])
    store.update_extra("missing", {UPDATE_KEY: "x"})
    with httpx.Client(timeout=5) as http:
        updater = Updater(Exploding(store), Gateway(settings, tmp_path / "calls.jsonl", http))
        updater.enqueue([(seen.item_id, new.item_id), ("missing", new.item_id)])
        wait_quiet(updater)
        assert "disk on fire" in capsys.readouterr().err
        assert UPDATE_KEY not in store.get_item(new.item_id).extra
        services.queue_model_reply("update", None)
        updater.enqueue([(seen.item_id, new.item_id)])
        wait_quiet(updater)
        assert "update check paused" in capsys.readouterr().err
        updater.enqueue([(seen.item_id, new.item_id)])
        wait_quiet(updater)
        assert store.get_item(new.item_id).extra[UPDATE_KEY] == "Update: new facts now"
