import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from moi_brain.items import Event, normalize
from moi_brain.store import Store

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


def make_item(source_id: str, native_id: str, url: str | None = None, hours_old: float = 1.0, fetched: datetime = NOW):
    record = {
        "native_id": native_id,
        "url": url or f"https://example.com/{source_id}/{native_id}",
        "title": f"title {native_id}",
        "published_at": (NOW - timedelta(hours=hours_old)).isoformat(),
    }
    return normalize(source_id, record, fetched)


def test_upsert_returns_only_new_items_and_dedupes_by_url_within_a_source(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    first = make_item("rss:a", "1")
    same_url_new_id = make_item("rss:a", "renamed", url=first.url)
    same_url_other_source = make_item("rss:b", "9", url=first.url)
    assert store.upsert_items([first, make_item("rss:a", "2")]) == [first, make_item("rss:a", "2")]
    assert store.upsert_items([first, same_url_new_id]) == []
    assert store.upsert_items([same_url_other_source]) == [same_url_other_source]
    assert store.stats()["items"] == {"rss:a": 2, "rss:b": 1}


def test_items_for_sources_filters_by_source_window_and_seen(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    fresh, old, other, seen = make_item("x", "1"), make_item("x", "2", hours_old=200), make_item("rss:a", "3"), make_item("x", "4")
    store.upsert_items([fresh, old, other, seen])
    store.add_events([Event(view_id="feed", item_id=seen.item_id, event_kind="seen")], NOW)
    found = store.items_with_seen(["x"], NOW - timedelta(days=7))
    assert {item.item_id: seen_at for item, seen_at in found} == {fresh.item_id: None, seen.item_id: NOW}
    assert {item.item_id for item in store.items_for_sources(["x"], NOW - timedelta(days=7))} == {fresh.item_id, seen.item_id}
    assert store.items_for_sources([], NOW) == []
    assert {item.item_id for item in store.recent_items(NOW - timedelta(days=7))} == {fresh.item_id, other.item_id}


def test_events_are_recorded_and_seen_marks_once(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    item = make_item("x", "1")
    store.upsert_items([item])
    events = [
        Event(view_id="feed", item_id=item.item_id, event_kind="seen"),
        Event(view_id="feed", item_id=item.item_id, event_kind="seen"),
        Event(view_id="feed", item_id=item.item_id, event_kind="open"),
        Event(view_id="feed", event_kind="less_like_this"),
    ]
    store.add_events(events, NOW)
    stats = store.stats()
    assert stats["events"] == {"seen": 2, "open": 1, "less_like_this": 1}
    assert stats["seen"] == {"x": 1}


def test_get_item_and_update_topics(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    item = make_item("x", "1")
    store.upsert_items([item])
    store.update_topics({item.item_id: ["politics"], "missing": ["x"]})
    assert store.get_item(item.item_id).topics == ["politics"]
    assert store.get_item("missing") is None


def test_expire_keeps_items_you_opened(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    stale = make_item("x", "1", fetched=NOW - timedelta(days=40))
    opened = make_item("x", "2", fetched=NOW - timedelta(days=40))
    recent = make_item("x", "3")
    store.upsert_items([stale, opened, recent])
    store.add_events([Event(view_id="feed", item_id=opened.item_id, event_kind="open")], NOW)
    assert store.expire(NOW) == 1
    assert store.get_item(stale.item_id) is None
    assert store.get_item(opened.item_id) is not None
    assert store.get_item(recent.item_id) is not None


def test_store_survives_reopen(tmp_path):
    item = make_item("x", "1")
    Store(tmp_path / "db.sqlite").upsert_items([item])
    assert Store(tmp_path / "db.sqlite").get_item(item.item_id) == item


def test_get_items_with_no_ids_skips_the_database(tmp_path):
    assert Store(tmp_path / "db.sqlite").get_items([]) == {}


def test_the_same_url_is_kept_for_each_source(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    mined = make_item("site:news.ycombinator.com", "hn1", url="https://arstechnica.com/story")
    from_feed = make_item("rss:arstechnica", "ars1", url="https://arstechnica.com/story")
    assert store.upsert_items([mined]) == [mined]
    assert store.upsert_items([from_feed]) == [from_feed]
    assert [item.item_id for item in store.items_for_sources(["rss:arstechnica"], NOW - timedelta(days=7))] == [from_feed.item_id]
    assert store.items_by_url("rss:arstechnica", ["https://arstechnica.com/story", "https://other"]) == {"https://arstechnica.com/story": from_feed}
    assert store.items_by_url("rss:arstechnica", []) == {}


def test_seeing_an_item_marks_its_copies_in_other_sources(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    first, second = make_item("rss:a", "1", url="https://same.example/x"), make_item("rss:b", "2", url="https://same.example/x")
    store.upsert_items([first, second])
    store.add_events([Event(view_id="feed", item_id=first.item_id, event_kind="seen")], NOW)
    assert [seen for _, seen in store.items_with_seen(["rss:a", "rss:b"], NOW - timedelta(days=7))] == [NOW, NOW]


def test_an_item_still_listed_does_not_expire_or_come_back_as_new(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    undated = make_item("rss:a", "1", fetched=NOW - timedelta(days=40))
    store.upsert_items([undated])
    relisted = undated.model_copy(update={"fetched_at": NOW})
    assert store.upsert_items([relisted]) == []
    assert store.expire(NOW) == 0
    assert store.get_item(undated.item_id) is not None
    store.upsert_items([make_item("rss:a", "2", fetched=NOW - timedelta(days=40))])
    assert store.expire(NOW) == 1


def test_recent_items_come_newest_first(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    store.upsert_items([make_item("x", "old", hours_old=40), make_item("x", "new", hours_old=1), make_item("x", "mid", hours_old=10)])
    assert [item.native_id for item in store.recent_items(NOW - timedelta(days=3))] == ["new", "mid", "old"]


OLD_SCHEMA = """
CREATE TABLE items (item_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, url TEXT NOT NULL UNIQUE, published_at TEXT,
    fetched_at TEXT NOT NULL, seen_at TEXT, item_json TEXT NOT NULL);
CREATE INDEX items_by_source ON items (source_id, published_at);
CREATE TABLE events (event_id INTEGER PRIMARY KEY, ts TEXT NOT NULL, view_id TEXT NOT NULL, item_id TEXT,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('open', 'seen', 'less_like_this')));
"""


def test_a_database_from_before_keeps_its_items_and_seen_state(tmp_path):
    path = tmp_path / "db.sqlite"
    item = make_item("rss:a", "1")
    with sqlite3.connect(path) as connection:
        connection.executescript(OLD_SCHEMA)
        connection.execute(
            "INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?)",
            (item.item_id, item.source_id, item.url, item.published_at.isoformat(), NOW.isoformat(), NOW.isoformat(), item.model_dump_json()),
        )
        connection.execute("INSERT INTO events (ts, view_id, item_id, event_kind) VALUES (?, 'feed', ?, 'open')", (NOW.isoformat(), item.item_id))
    store = Store(path)
    assert store.items_with_seen(["rss:a"], NOW - timedelta(days=7)) == [(item, NOW)]
    assert store.upsert_items([make_item("rss:b", "9", url=item.url)])
    assert store.stats()["events"] == {"open": 1}
    indexes = {row[1] for row in store.connection.execute("PRAGMA index_list(items)")}
    assert {"items_by_source", "items_by_url"} <= indexes
    assert Store(path).get_item(item.item_id) == item


def test_a_migration_a_crash_left_half_done_is_finished_on_the_next_start(tmp_path):
    path = tmp_path / "db.sqlite"
    item = make_item("rss:a", "1")
    with sqlite3.connect(path) as connection:
        connection.executescript(OLD_SCHEMA.replace("CREATE TABLE items", "CREATE TABLE items_before_listed_at").replace("ON items", "ON items_before_listed_at"))
        connection.execute(
            "INSERT INTO items_before_listed_at VALUES (?, ?, ?, ?, ?, ?, ?)",
            (item.item_id, item.source_id, item.url, item.published_at.isoformat(), NOW.isoformat(), None, item.model_dump_json()),
        )
        connection.execute("CREATE TABLE items (item_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, url TEXT NOT NULL, published_at TEXT, fetched_at TEXT NOT NULL, listed_at TEXT, seen_at TEXT, item_json TEXT NOT NULL, UNIQUE (source_id, url))")
    store = Store(path)
    assert store.get_item(item.item_id) == item
    tables = {row[0] for row in store.connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "items_before_listed_at" not in tables


def test_a_copy_that_arrives_after_you_saw_the_story_is_seen_too(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    first = make_item("rss:a", "1", url="https://same.example/story")
    store.upsert_items([first])
    store.add_events([Event(view_id="feed", item_id=first.item_id, event_kind="seen")], NOW)
    late = make_item("rss:b", "2", url="https://same.example/story")
    store.upsert_items([late], listed_at=NOW)
    assert [seen for _, seen in store.items_with_seen(["rss:b"], NOW - timedelta(days=7))] == [NOW]


def test_a_migration_that_fails_part_way_leaves_the_old_table_as_it_was(tmp_path):
    path = tmp_path / "db.sqlite"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE items (item_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, url TEXT NOT NULL UNIQUE, fetched_at TEXT NOT NULL)")
        connection.execute("INSERT INTO items VALUES ('a', 'rss:a', 'https://a.example', '2026-11-01T00:00:00+00:00')")
    with pytest.raises(sqlite3.OperationalError):
        Store(path)
    with sqlite3.connect(path) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert "items_before_listed_at" not in tables
        assert connection.execute("SELECT item_id FROM items").fetchall() == [("a",)]

