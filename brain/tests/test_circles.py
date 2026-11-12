"""Who you know: following lists read into the brain, people from memory, and rules about strangers."""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN, wait_until_refreshed
from fastapi.testclient import TestClient
from helpers import FixedClock

from moi_brain.api import create_app
from moi_brain.brain import NOBODY_KNOWN, Brain
from moi_brain.compile import Condition, Rule, parse_sources
from moi_brain.items import normalize, profile_handle, site_host
from moi_brain.rank import Circles, describe, rank
from moi_brain.store import Store

NOW = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
LIST = "https://x.com/me/following"


def post(handle: str | None, number: int, site: str = "https://x.com") -> object:
    record = {"native_id": str(number), "url": f"{site}/{handle or 'news'}/status/{number}", "text": f"Post {number} by {handle}", "author_handle": handle}
    return normalize("x", record, NOW)


@pytest.mark.parametrize(
    ("url", "host"),
    [("https://www.instagram.com/p/1", "instagram.com"), ("https://mobile.twitter.com/maya", "x.com"), ("https://m.facebook.com/x", "facebook.com"), ("http://[bad", ""), ("", "")],
)
def test_one_site_whatever_the_link_looks_like(url, host):
    assert site_host(url) == host


@pytest.mark.parametrize(
    ("record", "account"),
    [
        ({"url": "/Maya", "title": "Maya K"}, ("x.com", "maya")),
        ({"url": "https://twitter.com/@ben", "title": "Ben"}, ("x.com", "ben")),
        ({"url": "https://www.instagram.com/maya.k/", "author_handle": "@Maya.K"}, ("instagram.com", "maya.k")),
        ({"url": "https://www.linkedin.com/in/maya-k/", "title": "Maya"}, ("linkedin.com", "maya-k")),
        ({"url": "https://www.facebook.com/profile.php?id=1000123", "title": "Ben"}, ("facebook.com", "1000123")),
        ({"url": "https://www.youtube.com/channel/UCabc", "title": "A channel"}, ("youtube.com", "ucabc")),
        ({"url": "https://www.youtube.com/@veritasium", "title": "Veritasium"}, ("youtube.com", "veritasium")),
        ({"url": "https://www.linkedin.com/in/", "title": "Nobody"}, None),
        ({"url": "/i/lists/42", "title": "A list"}, None),
        ({"url": "/", "title": "Home"}, None),
        ({"url": "javascript:alert(1)", "title": "Bad"}, None),
        ({"title": "No link"}, None),
    ],
)
def test_accounts_in_a_following_list(record, account):
    assert profile_handle(record, LIST) == account


def test_following_lines_are_read_but_never_count_as_item_sources():
    [source], warnings = parse_sources(f"* Following: {LIST}\n* Following: nowhere", [])
    assert source.following == [LIST] and source.pages == [] and warnings == ["No page address found in: Following: nowhere"]


def test_follows_are_stored_per_list_and_dropped_when_no_list_named_them_for_a_month(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    assert store.list_read_at(LIST) is None
    assert store.add_follows(LIST, [("x.com", "maya"), ("x.com", "maya"), ("x.com", "ben")], NOW) == 2
    store.add_follows("https://www.instagram.com/me/following", [("instagram.com", "maya")], NOW)
    assert store.follows() == {("x.com", "maya"), ("x.com", "ben"), ("instagram.com", "maya")}
    assert store.list_read_at(LIST) == NOW
    later = NOW + timedelta(days=31)
    store.add_follows(LIST, [("x.com", "maya")], later)
    assert store.follows() == {("x.com", "maya")}
    assert store.stats()["follows"] == {"x.com": 1}


def test_circles_say_who_an_author_is():
    circles = Circles(people=frozenset({"ana"}), following=frozenset({("x.com", "maya"), ("x.com", "ana")}))
    assert circles.groups(post("maya", 1)) == {"following", "known"}
    assert circles.groups(post("ana", 2)) == {"people", "following", "known"}
    assert circles.groups(post("maya", 3, "https://www.instagram.com")) == {"stranger"}
    assert circles.groups(post("ana", 4, "https://www.instagram.com")) == {"people", "known"}
    assert circles.groups(post(None, 5)) == {"stranger"}
    assert Circles().empty and not circles.empty


def test_rules_about_strangers_rank_by_circles():
    circles = Circles(following=frozenset({("x.com", "maya")}))
    items = [post("maya", 1), post("troll", 2)]
    hide_strangers = Rule(when=Condition(field="author_in", op="eq", value="stranger"), do="hide")
    page, _ = rank(items, [hide_strangers], NOW, circles=circles)
    assert [entry.item.author_handle for entry in page] == ["maya"]
    assert len(rank(items, [hide_strangers], NOW)[0]) == 0
    boost = Rule(when=Condition(field="author_in", op="in", value=["known", "people"]), do="boost", weight=5)
    assert rank(items, [boost], NOW, circles=circles)[0][0].reasons[0] == "boost: author known, people"
    assert describe(boost.when) == "author known, people"


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(datetime.now(UTC))


@pytest.fixture
def timed(paths, settings, services, clock):
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    yield TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    brain.http.close()


def friends_view(paths) -> None:
    (paths.views / "friends.md").write_text(f"# Friends\n\n## Sources\n* X home timeline\n* Following: {LIST}\n\n## Rules\n* Only people I know.\n")


def x_posts(client: TestClient, clock: FixedClock, handles: list[str]) -> None:
    records = [{"native_id": f"{handle}{index}", "url": f"/{handle}/status/{index}", "text": f"Hello from {handle}", "author_handle": handle, "published_at": clock.moment.isoformat()} for index, handle in enumerate(handles)]
    client.post("/ingest", json={"source_id": "x", "records": records, "page_url": "https://x.com/home"})


def authors(client: TestClient, view_id: str = "friends") -> list[str]:
    return sorted(entry["item"]["author_handle"] for entry in wait_until_refreshed(client, view_id)["items"])


def test_a_following_list_is_read_once_a_week(timed, paths, clock):
    friends_view(paths)
    kinds = {source["source_id"]: source["purpose"] for source in timed.post("/refresh", json={"view_id": "friends"}).json()["page_sources"]}
    assert kinds == {"x": "items", "page:x.com/me/following": "follows"}
    assert timed.post("/follows", json={"list_url": LIST, "records": [{"url": "/maya"}]}).json() == {"stored": 1}
    assert [source["source_id"] for source in timed.post("/refresh", json={"view_id": "friends"}).json()["page_sources"]] == ["x"]
    clock.moment += timedelta(days=7)
    assert "page:x.com/me/following" in [source["source_id"] for source in timed.post("/refresh", json={"view_id": "friends"}).json()["page_sources"]]
    passive = timed.app.state.brain.passive_sources()
    assert all(source.purpose == "items" for source in passive)


def test_only_people_i_know(timed, paths, clock):
    """Strangers and trends drop; accounts you follow and people in your memory stay. Before anyone is known, it says why the view is empty."""
    friends_view(paths)
    x_posts(timed, clock, ["maya", "troll", "brand", "ana"])
    empty = wait_until_refreshed(timed, "friends")
    assert empty["items"] == [] and NOBODY_KNOWN in empty["warnings"]
    timed.post("/follows", json={"list_url": LIST, "records": [{"url": "https://x.com/maya", "title": "Maya"}, {"url": "/i/lists/1", "title": "a list"}]})
    assert authors(timed) == ["maya"]
    (paths.memory / "people.md").write_text("# people\n\n* Ana, my sister: @ana on x.com\n")
    assert authors(timed) == ["ana", "maya"]
    assert NOBODY_KNOWN not in wait_until_refreshed(timed, "friends")["warnings"]


def test_a_mine_page_knows_your_circles_too(timed, paths):
    (paths.views / "site_x.com.md").write_text("# x.com\n\n## Rules\n* No strangers.\n")
    timed.post("/follows", json={"list_url": LIST, "records": [{"url": "https://x.com/maya"}]})
    records = [{"native_id": str(index), "url": f"https://x.com/{handle}/status/{index}", "text": "hi", "author_handle": handle} for index, handle in enumerate(["maya", "troll"])]
    body = {"source_id": "site:x.com", "records": records, "page_url": "https://x.com/search", "view_id": "site_x.com"}
    assert [entry["item"]["author_handle"] for entry in timed.post("/ingest", json=body).json()["view_items"]] == ["maya"]


def test_too_many_follows_in_one_call_are_refused(timed):
    assert timed.post("/follows", json={"list_url": LIST, "records": [{"url": "/a"}] * 5001}).status_code == 422
