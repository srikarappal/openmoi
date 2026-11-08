from datetime import UTC, datetime, timedelta

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


def test_upsert_returns_only_new_items_and_dedupes_by_url(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    first = make_item("rss:a", "1")
    same_url_other_source = make_item("rss:b", "9", url=first.url)
    assert store.upsert_items([first, make_item("rss:a", "2")]) == [first, make_item("rss:a", "2")]
    assert store.upsert_items([first, same_url_other_source]) == []
    assert store.stats()["items"] == {"rss:a": 2}


def test_items_for_sources_filters_by_source_window_and_seen(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    fresh, old, other, seen = make_item("x", "1"), make_item("x", "2", hours_old=200), make_item("rss:a", "3"), make_item("x", "4")
    store.upsert_items([fresh, old, other, seen])
    store.add_events([Event(view_id="feed", item_id=seen.item_id, event_kind="seen")], NOW)
    found = store.items_for_sources(["x"], NOW - timedelta(days=7), NOW + timedelta(seconds=1))
    assert [item.item_id for item in found] == [fresh.item_id]
    kept = store.items_for_sources(["x"], NOW - timedelta(days=7), NOW - timedelta(hours=12))
    assert {item.item_id for item in kept} == {fresh.item_id, seen.item_id}
    assert store.items_for_sources([], NOW, NOW) == []
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
