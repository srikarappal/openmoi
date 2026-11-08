"""Integration: the HTTP API with real files, SQLite and the fake outside world."""

from datetime import datetime, timedelta

from conftest import TOKEN, wait_until_refreshed
from fastapi.testclient import TestClient

from moi_brain.api import create_app
from moi_brain.brain import SEEN_KEEP, utc_now

X_RECORDS = [
    {"native_id": "1000", "url": "https://x.com/maya/status/1000", "author_name": "Maya R", "author_handle": "maya", "text": "Post number 0 from maya"},
    {"native_id": "1001", "url": "/bob/status/1001", "author_handle": "bob", "text": "Post number 1 from bob about the election"},
    {"native_id": "1002", "url": "https://x.com/no_words/status/1002"},
]


def page_ids(page: dict) -> list[str]:
    return [view_item["item"]["native_id"] for view_item in page["items"]]


def half_a_day_later() -> datetime:
    return utc_now() + SEEN_KEEP + timedelta(minutes=1)


def shown_item_ids(client: TestClient) -> list[str]:
    return [view_item["item"]["item_id"] for view_item in client.post("/view/feed", json={}).json()["items"]]


def test_token_is_required(brain):
    anonymous = TestClient(create_app(brain, TOKEN))
    assert anonymous.get("/health").status_code == 401
    assert anonymous.get("/health", headers={"x-moi-token": "wrong"}).status_code == 401
    assert anonymous.get("/health", headers={"x-moi-token": TOKEN}).json() == {"status": "ok"}


def test_views_lists_the_feed(client):
    assert client.get("/views").json() == [{"view_id": "feed", "title": "Feed"}]


def test_refresh_returns_page_sources_and_reads_feeds_in_the_background(client):
    response = client.post("/refresh", json={"view_id": "feed"}).json()
    [x_source] = response["page_sources"]
    assert x_source["source_id"] == "x"
    assert x_source["start_url"] == "https://x.com/home"
    assert x_source["spec"]["item_root"] == "article[data-testid='tweet']"
    assert x_source["budget"] == {"page_loads": 1, "scroll_steps": 5, "min_step_interval_ms": 1500}
    page = wait_until_refreshed(client)
    sources = {view_item["item"]["source_id"] for view_item in page["items"]}
    assert sources == {"rss:tech", "rss:news", "youtube:veritasium"}
    native_ids = page_ids(page)
    assert native_ids.count("tech1") == 1
    assert "news1" in native_ids and "SHORT00001B" in native_ids
    assert page["caught_up"] is True
    assert page["summary"] == "Reading X, 1 YouTube channel and 2 RSS feeds."
    tech1 = next(view_item["item"] for view_item in page["items"] if view_item["item"]["native_id"] == "tech1")
    assert "utm_source" not in tech1["url"]


def test_recent_feeds_are_not_refetched_unless_forced(client, services):
    client.post("/refresh", json={"view_id": "feed"})
    wait_until_refreshed(client)
    count = len(services.requests)
    client.post("/refresh", json={"view_id": "feed"})
    wait_until_refreshed(client)
    assert len(services.requests) == count
    client.post("/refresh", json={"view_id": "feed", "force": True})
    wait_until_refreshed(client)
    assert len(services.requests) > count


def test_ingest_normalizes_page_records_into_the_view(client):
    items = client.post("/ingest", json={"source_id": "x", "records": X_RECORDS, "page_url": "https://x.com/home"}).json()["items"]
    assert [item["native_id"] for item in items] == ["1000", "1001"]
    assert items[1]["url"] == "https://x.com/bob/status/1001"
    assert items[0]["kind"] == "post"
    page = client.post("/view/feed", json={}).json()
    assert set(page_ids(page)) == {"1000", "1001"}
    again = client.post("/ingest", json={"source_id": "x", "records": X_RECORDS}).json()["items"]
    assert len(again) == 2
    assert len(client.post("/view/feed", json={}).json()["items"]) == 2


def test_seen_items_stay_for_half_a_day_then_leave_and_open_is_recorded(client, brain):
    client.post("/ingest", json={"source_id": "x", "records": X_RECORDS})
    page = client.post("/view/feed", json={}).json()
    first_id = page["items"][0]["item"]["item_id"]
    events = [{"view_id": "feed", "item_id": first_id, "event_kind": "seen"}, {"view_id": "feed", "item_id": first_id, "event_kind": "open"}]
    assert client.post("/events", json={"events": events}).json() == {"recorded": 2}
    assert first_id in shown_item_ids(client)
    brain.clock = half_a_day_later
    assert first_id not in shown_item_ids(client)
    assert client.get("/debug").json()["store"]["events"] == {"seen": 1, "open": 1}


def test_exclusion_paging(client):
    client.post("/refresh", json={"view_id": "feed"})
    wait_until_refreshed(client)
    first = client.post("/view/feed", json={"limit": 4}).json()
    assert first["has_more"] is True
    assert first["caught_up"] is False
    second = client.post("/view/feed", json={"limit": 4, "exclude_ids": [view_item["item"]["item_id"] for view_item in first["items"]]}).json()
    assert not set(page_ids(first)) & set(page_ids(second))


def test_broken_sources_show_up_as_warnings(client, paths, services):
    (paths.views / "feed.md").write_text(f"# Feed\n## Sources\n* RSS: {services.base_url}/rss/broken.xml\n* Mastodon\n")
    client.post("/refresh", json={"view_id": "feed"})
    page = wait_until_refreshed(client)
    assert page["warnings"] == ["Unknown source line: Mastodon", f"rss:broken: {services.base_url}/rss/broken.xml is not a readable feed"]


def test_lens_and_bad_view_ids(client):
    html = client.get("/lens/feed").text
    assert "moi.on_render" in html
    assert client.get("/lens/feed", params={"kind": "listing"}).status_code == 200
    assert client.get("/lens/feed", params={"kind": "nope"}).status_code == 422
    bad = client.post("/view/..%2Fsecrets", json={})
    assert bad.status_code in (400, 404)
    assert client.get("/lens/bad view").status_code == 400


def test_new_view_files_become_tabs_without_a_restart(client, paths):
    (paths.views / "tech.md").write_text("# Tech\n## Sources\n* RSS: https://feeds.arstechnica.com/arstechnica/index\n")
    assert [view["view_id"] for view in client.get("/views").json()] == ["feed", "tech"]
    assert client.post("/view/tech", json={}).json()["summary"] == "Reading 1 RSS feed."


def test_debug_reports_sources(client):
    client.post("/refresh", json={"view_id": "feed"})
    wait_until_refreshed(client)
    debug = client.get("/debug").json()
    assert debug["sources"]["rss:tech"] == "ok"
    assert debug["store"]["items"]["youtube:veritasium"] == 3
    assert debug["refreshing"] == []
