"""The algorithm mirror and early openings: what each source showed you, what passed, and how you used your views."""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN, wait_until_refreshed
from fastapi.testclient import TestClient

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.compile import CompiledView, Condition, Judgment, Rule, SourceRef, TimeSpec
from moi_brain.editions import EditionBook
from moi_brain.items import normalize
from moi_brain.mirror import build_mirror
from moi_brain.rank import Circles

NOW = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
ANGRY = Judgment(name="angry", question="Is this written to make people angry?")
RENT = Judgment(name="rent", question="Rent?", answer="number")


class FixedClock:
    def __init__(self, moment: datetime):
        self.moment = moment

    def __call__(self) -> datetime:
        return self.moment


def item(source_id: str, number: int, handle: str | None = None, angry: str | None = None):
    record = {"native_id": str(number), "url": f"https://x.com/{handle or 'news'}/status/{number}", "text": f"Post {number}", "author_handle": handle}
    made = normalize(source_id, record, NOW)
    return made.model_copy(update={"extra": {"judged:angry": angry} if angry else {}})


def view(view_id: str, sources: list[SourceRef], rules: list[Rule]) -> CompiledView:
    return CompiledView(view_id=view_id, title=view_id, file_hash="h", sources=sources, rules=rules)


def test_the_mirror_counts_per_source_by_todays_rules():
    hide_angry = Rule(when=Condition(field="judged:angry", op="eq", value="yes"), do="hide")
    hide_strangers = Rule(when=Condition(field="author_in", op="eq", value="stranger"), do="hide")
    views = [view("feed", [SourceRef(source_id="x")], [hide_angry]), view("friends", [SourceRef(source_id="x")], [hide_strangers])]
    posts = [item("x", 1, "maya", "no"), item("x", 2, "troll", "yes"), item("x", 3, "maya", "yes"), item("x", 4, None, "no"), item("rss:gone", 5)]
    entries = [(posts[0], NOW), (posts[1], None), (posts[2], NOW), (posts[3], None), (posts[4], None)]
    circles = Circles(following=frozenset({("x.com", "maya")}))
    mirror = build_mirror(7, NOW, entries, {posts[0].item_id}, views, [ANGRY, RENT], circles, {"feed": {"visit": 3, "early": 1}})
    [x] = mirror.sources
    assert (x.source_id, x.listed, x.kept, x.seen, x.opened, x.strangers, x.judged) == ("x", 4, 3, 2, 1, 1, {"angry": 2})
    assert [entry.model_dump() for entry in mirror.views] == [{"view_id": "feed", "visits": 3, "extended": 0, "early": 1}]
    assert mirror.since == NOW - timedelta(days=7)


def test_strangers_are_only_counted_once_someone_is_known_and_sources_sort_by_how_much_they_showed():
    views = [view("feed", [SourceRef(source_id="x"), SourceRef(source_id="rss", feeds=["https://a.com/rss"])], [])]
    entries = [(item("rss:a", 1), None), (item("x", 2, "maya"), None), (item("x", 3, "ben"), None)]
    mirror = build_mirror(1, NOW, entries, set(), views, [], Circles(), {})
    assert [(entry.source_id, entry.listed, entry.strangers) for entry in mirror.sources] == [("x", 2, None), ("rss:a", 1, None)]


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(datetime.now(UTC).replace(microsecond=0))


@pytest.fixture
def timed(paths, settings, services, clock):
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    yield TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    brain.http.close()


def x_posts(client: TestClient, clock: FixedClock, texts: list[tuple[str, str]], start: int = 0) -> list[str]:
    records = [
        {"native_id": f"n{start + index}", "url": f"/{handle}/status/{start + index}", "text": text, "author_handle": handle, "published_at": clock.moment.isoformat()}
        for index, (handle, text) in enumerate(texts)
    ]
    return [entry["item_id"] for entry in client.post("/ingest", json={"source_id": "x", "records": records, "page_url": "https://x.com/home"}).json()["items"]]


def test_a_week_of_x_in_the_mirror(timed, paths, clock):
    """X showed four posts, your rules kept two, one came from a stranger, two were angry, you saw two and opened one."""
    (paths.views / "feed.md").write_text("# Feed\n\n## Sources\n* X home timeline\n* Following: https://x.com/me/following\n\n## Rules\n* Hide rage bait.\n")
    timed.post("/follows", json={"list_url": "https://x.com/me/following", "records": [{"url": "https://x.com/maya"}]})
    ids = x_posts(timed, clock, [("maya", "Lovely day"), ("troll", "They DESTROYED it, outrage"), ("maya", "Garden photos"), ("maya", "Furious about the bus")])
    page = wait_until_refreshed(timed)
    assert len(page["items"]) == 2
    timed.post("/events", json={"events": [{"view_id": "feed", "item_id": ids[0], "event_kind": "seen"}, {"view_id": "feed", "item_id": ids[2], "event_kind": "seen"}, {"view_id": "feed", "item_id": ids[0], "event_kind": "open"}]})
    timed.post("/moments", json={"view_id": "feed", "kind": "visit"})
    timed.post("/moments", json={"view_id": "feed", "kind": "extended"})
    mirror = timed.get("/mirror").json()
    assert mirror["sources"] == [{"source_id": "x", "listed": 4, "kept": 2, "seen": 2, "opened": 1, "strangers": 1, "judged": {"angry": 2}}]
    assert mirror["views"] == [{"view_id": "feed", "visits": 1, "extended": 1, "early": 0}]
    clock.moment += timedelta(days=8)
    assert timed.get("/mirror").json()["sources"] == []
    assert timed.get("/mirror", params={"days": 99}).json()["days"] == 30
    assert timed.get("/mirror", params={"days": 0}).json()["days"] == 1


def test_the_weekly_mirror_comes_once_a_week_once_there_is_something_to_show(timed, paths, clock):
    """The first launch starts the week; a week with nothing read stays quiet; a damaged state file starts over."""
    assert timed.get("/mirror/weekly").json() is None
    clock.moment += timedelta(days=7)
    assert timed.get("/mirror/weekly").json() is None
    (paths.views / "feed.md").write_text("# Feed\n\n## Sources\n* X home timeline\n")
    x_posts(timed, clock, [("maya", "Hello")])
    assert timed.get("/mirror/weekly").json() is None
    clock.moment += timedelta(days=7)
    assert timed.get("/mirror/weekly").json()["sources"][0]["listed"] == 1
    assert timed.get("/mirror/weekly").json() is None
    paths.mirror_state.write_text('{"shown_at": "a while ago"}')
    assert timed.get("/mirror/weekly").json() is not None
    paths.mirror_state.write_text("[]")
    assert timed.get("/mirror/weekly").json() is not None


def test_opening_an_edition_early_shows_what_came_since_and_counts(timed, paths, clock):
    first = (clock.moment - timedelta(hours=1)).astimezone()
    (paths.views / "feed.md").write_text(f"# Feed\n\n## Sources\n* X home timeline\n\n## Time\n* Editions at {first:%H:%M}.\n")
    x_posts(timed, clock, [("maya", "Arrived after the edition")])
    assert wait_until_refreshed(timed)["items"] == []
    assert timed.post("/view/feed/early").json() == {"status": "open"}
    assert [entry["item"]["text"] for entry in wait_until_refreshed(timed)["items"]] == ["Arrived after the edition"]
    assert timed.get("/mirror").json()["views"] == [{"view_id": "feed", "visits": 0, "extended": 0, "early": 1}]
    (paths.views / "plain.md").write_text("# Plain\n\n## Sources\n* X home timeline\n")
    assert timed.post("/view/plain/early").status_code == 400
    assert timed.post("/moments", json={"view_id": "feed", "kind": "binge"}).status_code == 422


def test_an_early_opening_belongs_to_its_edition_and_survives_its_read(tmp_path):
    book, spec = EditionBook(tmp_path / "editions.json"), TimeSpec(editions=["07:00"])
    seven = datetime(2026, 11, 10, 7, 0, tzinfo=UTC)
    book.open_early("feed", seven, seven + timedelta(hours=3))
    book.done("feed", seven + timedelta(days=1), seven + timedelta(hours=23, minutes=40))
    assert book.opened_early_at("feed", seven) == seven + timedelta(hours=3)
    assert EditionBook(tmp_path / "editions.json").current("feed", spec, seven + timedelta(hours=5)).cutoff == seven + timedelta(hours=3)
    assert book.current("feed", spec, seven + timedelta(days=1, hours=1)).cutoff == seven + timedelta(days=1)
    book.reads["feed"][seven.astimezone().isoformat()]["early"] = "soon"
    assert book.opened_early_at("feed", seven) is None
