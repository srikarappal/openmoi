"""User journeys through the brain's HTTP API, end to end against real files, SQLite and the fake outside world.

Each test is one thing a person does with openMoi, from first refresh to pairing Chrome, checked the way they
would notice it: what the feed shows, what it warns about and what is in their files afterwards.
"""

import json
import threading
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from conftest import TOKEN, fixture_view, wait_until_refreshed
from fastapi.testclient import TestClient
from helpers import EXTENSION_ID, FakeExtension

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import Settings, Slot

MORNING = datetime(2026, 11, 4, 8, 0, tzinfo=UTC)


class FixedClock:
    """The brain's clock, moved by the test."""

    def __init__(self, moment: datetime):
        self.moment = moment

    def __call__(self) -> datetime:
        return self.moment


def refreshed(client: TestClient, view_id: str = "feed", force: bool = True) -> dict:
    client.post("/refresh", json={"view_id": view_id, "force": force})
    return wait_until_refreshed(client, view_id)


def page(client: TestClient, view_id: str = "feed", exclude: list[str] | None = None, limit: int = 30) -> dict:
    return client.post(f"/view/{view_id}", json={"exclude_ids": exclude or [], "limit": limit}).json()


def titles(view_page: dict) -> list[str]:
    return [entry["item"]["title"] or entry["item"]["text"] for entry in view_page["items"]]


def ids(view_page: dict) -> list[str]:
    return [entry["item"]["item_id"] for entry in view_page["items"]]


def confirm(client: TestClient, text: str, scope: str = "any", view_id: str = "feed") -> dict:
    proposal = client.post("/edit", json={"view_id": view_id, "text": text, "scope": scope}).json()
    assert proposal["changes"] or proposal["lens_action"], proposal
    applied = client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    assert applied.status_code == 200, applied.text
    return applied.json()


def mark_seen(client: TestClient, item_ids: list[str], view_id: str = "feed") -> None:
    client.post("/events", json={"events": [{"view_id": view_id, "item_id": item_id, "event_kind": "seen"} for item_id in item_ids]})


def x_posts(count: int, published: datetime, start: int = 0) -> list[dict]:
    return [
        {"native_id": str(2000 + index), "url": f"/maya/status/{2000 + index}", "author_handle": "maya", "text": f"Morning post {index}", "published_at": (published + timedelta(minutes=index)).isoformat()}
        for index in range(start, start + count)
    ]


def ingest_x(client: TestClient, records: list[dict]) -> list[dict]:
    return client.post("/ingest", json={"source_id": "x", "records": records, "page_url": "https://x.com/home"}).json()["items"]


def write_view(paths, text: str, view_id: str = "feed") -> None:
    (paths.views / f"{view_id}.md").write_text(text)


def tagging_done(client: TestClient, view_id: str = "feed", timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        current = page(client, view_id)
        if not current["refreshing"] or time.monotonic() > deadline:
            return current
        time.sleep(0.05)


def test_the_first_morning_shows_every_source_once_and_pages_to_caught_up(client):
    first = refreshed(client)
    assert {"New laptop chip doubles battery life", "Senate debates the election budget", "Why the sky is blue, really"} <= set(titles(first))
    assert titles(first).count("New laptop chip doubles battery life") == 1
    ingest_x(client, x_posts(3, datetime.now(UTC) - timedelta(hours=1)))
    seen_ids: list[str] = []
    while True:
        current = page(client, exclude=seen_ids, limit=4)
        assert not set(ids(current)) & set(seen_ids)
        seen_ids += ids(current)
        if current["caught_up"]:
            break
    assert len(seen_ids) == len(set(seen_ids)) == len(ids(page(client, limit=100)))
    assert sum(1 for title in titles(page(client, limit=100)) if title.startswith("Morning post")) == 3


def test_no_shorts_by_chat_then_back_by_editing_the_file(client, paths):
    refreshed(client)
    assert "One minute physics trick" in titles(page(client))
    applied = confirm(client, "no shorts", "rules")
    assert applied["changes"][0]["file"] == "views/feed.md"
    assert "* No shorts." in (paths.views / "feed.md").read_text()
    assert "One minute physics trick" not in titles(page(client))
    write_view(paths, (paths.views / "feed.md").read_text().replace("* No shorts.\n", ""))
    assert "One minute physics trick" in titles(page(client))


def test_hide_politics_unless_it_comes_from_the_news_feed(client, paths, services):
    write_view(paths, fixture_view("feed", services.base_url).replace("## Rules\n", "## Rules\n* Hide politics unless it comes from news\n"))
    refreshed(client)
    shown = titles(tagging_done(client))
    assert "Election results shake up tech policy" not in shown
    assert "Senate debates the election budget" in shown
    assert "New laptop chip doubles battery life" in shown


def test_a_dislike_in_memory_hides_items_in_every_view(client, paths, services):
    (paths.views / "tech.md").write_text(f"# Tech\n\n## Sources\n* RSS: {services.base_url}/rss/tech.xml\n")
    (paths.memory / "dislikes.md").write_text("# dislikes\n\n* politics\n")
    refreshed(client)
    refreshed(client, "tech")
    for view_id in ("feed", "tech"):
        shown = titles(tagging_done(client, view_id))
        assert "Election results shake up tech policy" not in shown
        assert "New laptop chip doubles battery life" in shown
    assert "Senate debates the election budget" not in titles(page(client, "feed"))


def test_items_you_read_stay_for_the_day_and_are_gone_the_next_morning(client, brain):
    refreshed(client)
    clock = FixedClock(datetime.now(UTC))
    brain.clock = clock
    morning = page(client)
    mark_seen(client, ids(morning)[:3])
    clock.moment += timedelta(hours=2)
    assert ids(morning)[:3] == [item_id for item_id in ids(page(client)) if item_id in ids(morning)[:3]]
    clock.moment += timedelta(hours=11)
    later = ids(page(client))
    assert not set(ids(morning)[:3]) & set(later)
    assert set(ids(morning)[3:]) <= set(later)


def test_a_daily_limit_holds_all_day_even_after_read_items_leave(client, brain, paths, services):
    write_view(paths, "# Feed\n\n## Sources\n* X home timeline\n\n## Rules\n* At most 2 posts from x\n")
    clock = FixedClock(MORNING)
    brain.clock = clock
    ingest_x(client, x_posts(5, MORNING - timedelta(hours=1)))
    first = page(client)
    assert len(first["items"]) == 2
    mark_seen(client, ids(first))
    clock.moment = MORNING + timedelta(hours=13)
    assert page(client)["items"] == []
    ingest_x(client, x_posts(2, MORNING + timedelta(days=1), start=10))
    clock.moment = MORNING + timedelta(days=1, hours=1)
    assert len(page(client)["items"]) == 2


def test_two_chat_proposals_at_once_the_later_one_is_stale(client):
    rules = client.post("/edit", json={"view_id": "feed", "text": "no shorts", "scope": "rules"}).json()
    layout = client.post("/edit", json={"view_id": "feed", "text": "make it a two column magazine", "scope": "layout"}).json()
    assert client.post("/edit/apply", json={"proposal_id": rules["proposal_id"]}).status_code == 200
    stale = client.post("/edit/apply", json={"proposal_id": layout["proposal_id"]})
    assert (stale.status_code, stale.json()["kind"]) == (409, "stale")
    again = confirm(client, "make it a two column magazine", "layout")
    assert "two column magazine" in again["changes"][0]["diff"]


def test_a_hosted_model_sees_your_content_only_once_you_allow_it(paths, services):
    hosted = Slot(base_url="https://models.example.invalid/v1", model="big")
    brain = Brain(paths, Settings(fast=hosted, smart=hosted.model_copy()), youtube_base=services.base_url)
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    try:
        blocked = client.post("/edit", json={"view_id": "feed", "text": "no shorts"})
        assert (blocked.status_code, blocked.json()["kind"]) == (409, "privacy")
        assert client.post("/model", json={"allow_content_to_hosted": True}).json()["allow_content_to_hosted"] is True
        attempted = client.post("/edit", json={"view_id": "feed", "text": "no shorts"})
        assert (attempted.status_code, attempted.json()["kind"]) == (502, "llm")
    finally:
        brain.http.close()


def test_a_broken_feed_warns_until_you_take_it_out(client, paths, services):
    good = fixture_view("feed", services.base_url)
    write_view(paths, good.replace("## Rules", f"* RSS: {services.base_url}/rss/broken.xml\n\n## Rules"))
    warned = refreshed(client)
    assert any("is not a readable feed" in warning for warning in warned["warnings"])
    write_view(paths, good)
    assert not any("readable feed" in warning for warning in refreshed(client)["warnings"])


def test_when_youtube_feeds_are_down_videos_still_come_from_the_channel_page(client, services):
    services.youtube_feed_down = True
    current = refreshed(client)
    assert {"Why the sky is blue, really", "The surprising math of traffic"} <= set(titles(current))
    assert not [warning for warning in current["warnings"] if warning.startswith("youtube")]


def test_mine_a_listing_page_then_give_it_a_new_look_and_roll_it_back(client, services):
    url = f"{services.base_url}/pages/listing.html"
    spec = client.post("/extractor/generate", json={"url": url, "skeleton": '<table><tr class="athing">{t:9}</tr></table>'}).json()["spec"]
    client.post("/extractor/accept", json=spec)
    assert client.get("/extractor", params={"url": url}).json()["spec"]["item_root"] == "tr.athing"
    records = [{"native_id": f"hn{index}", "url": f"https://story.example/{index}", "title": f"Story {index}"} for index in range(5)]
    mined = client.post("/ingest", json={"source_id": "site:127.0.0.1", "records": records, "page_url": url, "view_id": "site_127.0.0.1", "kind": "listing"}).json()
    assert [entry["item"]["title"] for entry in mined["view_items"]] == [f"Story {index}" for index in range(5)]
    assert mined["lens_stale"] is False
    confirm(client, "make it a compact list", "layout", view_id="site_127.0.0.1")
    again = client.post("/ingest", json={"source_id": "site:127.0.0.1", "records": records, "page_url": url, "view_id": "site_127.0.0.1", "kind": "listing"}).json()
    assert again["lens_stale"] is True
    html = client.post("/lens/generate", json={"view_id": "site_127.0.0.1", "kind": "listing"}).json()["html"]
    assert client.post("/lens/accept", json={"view_id": "site_127.0.0.1", "kind": "listing", "html": html}).json()["version"] == 1
    assert "Look: make it a compact list" in client.get("/lens/site_127.0.0.1", params={"kind": "listing"}).text
    confirm(client, "bring back the previous look", view_id="site_127.0.0.1")
    assert "Look:" not in client.get("/lens/site_127.0.0.1", params={"kind": "listing"}).text


def test_paired_chrome_reads_for_you_and_comes_back_after_a_drop_without_asking_again(client, brain):
    port = brain.relay.start(0)
    try:
        extension = FakeExtension(port)
        assert extension.recv()["type"] == "approval_needed"
        client.post("/relay/trust", json={"extension_id": EXTENSION_ID})
        welcome = extension.recv()
        assert extension.hub_is_genuine(welcome)
        extension.secret = welcome["secret"]
        extension.answer_calls(chrome_page)
        assert client.post("/relay/call", json={"op": "open", "args": {"url": "https://x.com/home"}}).json() == {"result": {"handle": "512"}}
        records = client.post("/relay/call", json={"op": "run", "args": {"handle": "512", "op": "extract"}}).json()["result"]
        ingest_x(client, records)
        assert "From Chrome" in titles(page(client))
        extension.close()
        deadline = time.monotonic() + 3
        while client.get("/relay/poll").json()["status"]["connected"] and time.monotonic() < deadline:
            time.sleep(0.02)
        failed = client.post("/relay/call", json={"op": "url", "args": {"handle": "512"}})
        assert (failed.status_code, failed.json()["kind"]) == (503, "relay")
        back = FakeExtension(port, secret=extension.secret)
        assert back.recv()["type"] == "welcome"
        back.answer_calls(chrome_page)
        assert client.post("/relay/call", json={"op": "url", "args": {"handle": "512"}}).json() == {"result": "https://x.com/home"}
        assert client.get("/relay/poll").json()["status"]["waiting_for_approval"] is None
    finally:
        brain.relay.stop()


def chrome_page(op: str, args: dict) -> object:
    """Your Chrome, as the fake extension: one X tab with one post."""
    if op == "open":
        return {"handle": "512"}
    if op == "url":
        return "https://x.com/home"
    return [{"native_id": "3000", "url": "/maya/status/3000", "author_handle": "maya", "text": "From Chrome"}]


def test_x_pages_you_browse_yourself_fill_the_feed_but_other_pages_do_not(client, brain):
    port = brain.relay.start(0)
    try:
        extension = FakeExtension(port)
        extension.recv()
        client.post("/relay/trust", json={"extension_id": EXTENSION_ID})
        extension.recv()
        records = [{"native_id": "4000", "url": "/bob/status/4000", "author_handle": "bob", "text": "Seen while browsing"}]
        extension.send({"type": "event", "event": "passive_records", "source_id": "x", "page_url": "https://x.com/settings", "records": records})
        extension.send({"type": "event", "event": "passive_records", "source_id": "x", "page_url": "https://x.com/home", "records": records})
        deadline = time.monotonic() + 3
        while client.get("/relay/poll").json()["status"]["passive_batches"] < 1 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert titles(page(client)).count("Seen while browsing") == 1
        assert client.get("/relay/poll").json()["status"]["passive_batches"] == 1
    finally:
        brain.relay.stop()


def test_damaged_state_files_are_rebuilt_without_breaking_the_feed(client, brain, paths):
    refreshed(client)
    before = set(ids(page(client)))
    (paths.compiled / "feed.json").write_text("{")
    (paths.lenses / "feed").mkdir(parents=True, exist_ok=True)
    (paths.lenses / "feed" / "current.json").write_text("")
    paths.tagging_state.write_text("[")
    paths.channel_cache.write_text("")
    rebuilt = Brain(paths, brain.gateway.settings, youtube_base=brain.fetcher.youtube_base)
    fresh = TestClient(create_app(rebuilt, TOKEN), headers={"x-moi-token": TOKEN})
    try:
        assert set(ids(page(fresh))) == before
        assert fresh.get("/lens/feed").status_code == 200
        assert json.loads((paths.compiled / "feed.json").read_text())["view_id"] == "feed"
    finally:
        rebuilt.http.close()


def test_settings_show_what_your_edits_changed(client):
    confirm(client, "no shorts", "rules")
    confirm(client, "I'm vegetarian", "memory")
    overview = client.get("/overview/feed").json()
    assert "* No shorts." in overview["sections"]["Rules"]
    assert "Vegetarian" in overview["memory"]["about_me.md"]


def test_a_new_view_from_a_description_becomes_a_tab_that_reads_its_own_sources(client, paths, services):
    assert client.post("/views", json={"view_id": "tech", "title": "Tech"}).status_code == 200
    (paths.views / "tech.md").write_text(f"# Tech\n\n## Sources\n* RSS: {services.base_url}/rss/tech.xml\n\n## Rules\n\n## Layout\n")
    confirm(client, "make it a magazine", "view", view_id="tech")
    assert [view["view_id"] for view in client.get("/views").json()] == ["feed", "tech"]
    shown = titles(refreshed(client, "tech"))
    assert "Open source database hits version 10" in shown
    assert "Senate debates the election budget" not in shown


def test_reading_an_article_in_one_feed_counts_for_its_copy_in_another(client, paths, services):
    (paths.views / "news.md").write_text(f"# News\n\n## Sources\n* RSS: {services.base_url}/rss/news.xml\n")
    refreshed(client)
    refreshed(client, "news")
    clock = FixedClock(datetime.now(UTC))
    client.app.state.brain.clock = clock
    chip = next(entry["item"]["item_id"] for entry in page(client)["items"] if entry["item"]["title"] == "New laptop chip doubles battery life")
    mark_seen(client, [chip])
    clock.moment += timedelta(hours=13)
    assert "New laptop chip doubles battery life" not in titles(page(client, "news"))


def test_many_things_at_once_never_break_or_duplicate_the_feed(client):
    refreshed(client)
    failures: list[str] = []
    stop = time.monotonic() + 2
    workers = [threading.Thread(target=busy_reader, args=(client, stop, failures)) for _ in range(4)]
    workers.append(threading.Thread(target=busy_refresher, args=(client, stop, failures)))
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    assert failures == []
    final = ids(tagging_done(client))
    assert len(final) == len(set(final))


def busy_reader(client: TestClient, stop: float, failures: list[str]) -> None:
    while time.monotonic() < stop:
        response = client.post("/view/feed", json={})
        if response.status_code != 200:
            failures.append(response.text)
            return
        shown = ids(response.json())
        if len(shown) != len(set(shown)):
            failures.append("duplicate items")
        if shown:
            client.post("/events", json={"events": [{"view_id": "feed", "item_id": shown[0], "event_kind": "open"}]})


def busy_refresher(client: TestClient, stop: float, failures: list[str]) -> None:
    while time.monotonic() < stop:
        response = client.post("/refresh", json={"view_id": "feed", "force": True})
        if response.status_code != 200:
            failures.append(response.text)
            return
        time.sleep(0.05)


@pytest.mark.parametrize("scope", ["memory", "rules", "sources", "layout"])
def test_each_chat_command_changes_only_its_own_part(client, paths, scope):
    before_view = (paths.views / "feed.md").read_text()
    before_memory = (paths.memory / "about_me.md").read_text()
    proposal = client.post("/edit", json={"view_id": "feed", "text": "no shorts and vegetarian and make it compact", "scope": scope}).json()
    client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    view_changed = (paths.views / "feed.md").read_text() != before_view
    memory_changed = (paths.memory / "about_me.md").read_text() != before_memory
    assert (view_changed, memory_changed) == {"memory": (False, True), "rules": (True, False), "sources": (False, False), "layout": (True, False)}[scope]


def test_an_undated_post_a_feed_keeps_listing_never_expires_or_comes_back_as_new(client, brain):
    clock = FixedClock(MORNING)
    brain.clock = clock
    undated = [{"native_id": "evergreen", "url": "https://blog.example/about", "title": "About this blog"}]
    [stored] = client.post("/ingest", json={"source_id": "rss:blog", "records": undated}).json()["items"]
    mark_seen(client, [stored["item_id"]])
    for day in (10, 20, 29, 38):
        clock.moment = MORNING + timedelta(days=day)
        client.post("/ingest", json={"source_id": "rss:blog", "records": undated})
        brain.store.expire(clock.moment)
    assert brain.store.get_item(stored["item_id"]) is not None
    [(_, seen_at)] = brain.store.items_with_seen(["rss:blog"], MORNING - timedelta(days=1))
    assert seen_at is not None


def test_a_feed_you_fixed_stops_warning_even_when_its_site_has_another_feed(paths, settings):
    feeds = {"/rss/index.xml": "news", "/rss/reviews.xml": "reviews"}
    view = "# Feed\n\n## Sources\n* RSS: https://www.example.com/rss/index.xml, https://www.example.com/rss/reviews.xm\n"
    write_view(paths, view)
    brain = Brain(paths, settings, http=httpx.Client(transport=httpx.MockTransport(site_feeds_for(feeds))))
    try:
        brain.refresh_feeds("feed", brain.compiler.compiled("feed"), True)
        assert any("reviews.xm returned 404" in warning for warning in brain.view_page("feed", []).warnings)
        write_view(paths, view.replace("reviews.xm", "reviews.xml"))
        brain.refresh_feeds("feed", brain.compiler.compiled("feed"), True)
        assert not any("reviews.xm returned 404" in warning for warning in brain.view_page("feed", []).warnings)
    finally:
        brain.http.close()


class SiteFeeds:
    """A site serving one small feed per known path and 404 for anything else."""

    def __init__(self, feeds: dict[str, str]):
        self.feeds = feeds

    def __call__(self, request: httpx.Request) -> httpx.Response:
        name = self.feeds.get(request.url.path)
        if name is None:
            return httpx.Response(404, text="not found")
        body = f'<rss version="2.0"><channel><title>{name}</title><item><guid>{name}1</guid><title>{name} story</title><link>https://www.example.com/{name}/1</link></item></channel></rss>'
        return httpx.Response(200, text=body)


def site_feeds_for(feeds: dict[str, str]) -> SiteFeeds:
    return SiteFeeds(feeds)


def test_a_view_file_that_is_not_utf8_does_not_break_the_other_views(client, paths):
    (paths.views / "notes.md").write_bytes("# Notes caf\xe9\n\n## Sources\n* X home timeline\n".encode("latin-1"))
    assert [view["view_id"] for view in client.get("/views").json()] == ["feed", "notes"]
    assert client.post("/view/feed", json={}).status_code == 200
    assert client.post("/view/notes", json={}).status_code == 200

