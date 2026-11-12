"""Watched pages: a baseline, changes that are real, one change item per page, and an alert when rules keep it."""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN, wait_until_refreshed
from fastapi.testclient import TestClient

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.compile import parse_sources
from moi_brain.watch import MAX_CHANGE_TEXT, change_item, changed_lines, watch_lines

VISA = "https://visa.example.gov/slots"
NOW = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)


class FixedClock:
    def __init__(self, moment: datetime):
        self.moment = moment

    def __call__(self) -> datetime:
        return self.moment


@pytest.mark.parametrize(
    ("line", "minutes"),
    [
        (f"* Watch: {VISA}", 60),
        (f"* Watch: {VISA} every 30 minutes", 30),
        (f"* Watch: {VISA}, every 2 hours", 120),
        (f"* Watch: {VISA} every day", 1440),
        (f"* Watch: {VISA} every 1 minute", 5),
        (f"* Watch: {VISA} every minute", 5),
    ],
)
def test_watch_lines_and_how_often(line, minutes):
    [source], warnings = parse_sources(line, [])
    assert [(watch.url, watch.every_minutes) for watch in source.watches] == [(VISA, minutes)] and warnings == []


def test_a_watched_page_is_a_source_of_its_view_once():
    [source], warnings = parse_sources(f"* Watch: {VISA}\n* Watch: {VISA} every 10 minutes\n* Watch: soon", [])
    assert [(watch.url, watch.every_minutes) for watch in source.watches] == [(VISA, 10)]
    assert warnings == ["No page address found in: Watch: soon"]


def test_noise_is_not_a_change():
    assert watch_lines("  Slots:   none \n\nUpdated 3 minutes ago\nChecked just now by the system\n") == ["Slots: none", "Updated", "Checked by the system"]
    noisy = "Posted an hour ago\nEdited 2 hr. ago\n5h\n12:40\n9:05 pm\nOpened a minute ago\nPrice 5h deal\n3 weeks ago"
    assert watch_lines(noisy) == ["Posted", "Edited", "Opened", "Price 5h deal"]
    assert watch_lines("a\n" * 20_000) == ["a"] * 10_000
    assert changed_lines(["a", "b", "c"], ["a", "c", "d", "e"]) == (["d", "e"], ["b"])


def test_a_change_item_says_what_was_added_and_removed():
    item = change_item("watch:visa.example.gov/slots", VISA, "", ["Slot Dec 12"], ["No slots"], NOW)
    assert (item.title, item.text, item.url, item.kind) == ("visa.example.gov changed", "Added: Slot Dec 12 Removed: No slots", VISA, "link")
    assert change_item("watch:a", VISA, "Visa slots", [], [], NOW).text == "The page changed."
    assert len(change_item("watch:a", VISA, "Visa", ["x" * 3000], [], NOW).text) == MAX_CHANGE_TEXT


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(datetime.now(UTC).replace(microsecond=0))


@pytest.fixture
def timed(paths, settings, services, clock):
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    yield TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    brain.http.close()


def report(client: TestClient, text: str, title: str = "Visa slots") -> dict:
    return client.post("/watches/report", json={"url": VISA, "title": title, "text": text}).json()


def test_watch_for_me_until_a_slot_opens(timed, paths, clock):
    """The page is checked about hourly; noise and changes your rules ignore stay quiet; the slot you wait for alerts you."""
    (paths.views / "visa.md").write_text(f"# Visa\n\n## Sources\n* Watch: {VISA}\n\n## Rules\n* Only when it mentions available.\n")
    sources = timed.post("/refresh", json={"view_id": "visa"}).json()["page_sources"]
    assert [(source["source_id"], source["purpose"]) for source in sources] == [("watch:visa.example.gov/slots", "watch")]
    assert [source["start_url"] for source in timed.get("/watches/due").json()] == [VISA]
    assert report(timed, "Appointments\nNo slots this month\nUpdated 2 minutes ago") == {"changed": False, "alert": None}
    assert timed.get("/watches/due").json() == []
    clock.moment += timedelta(minutes=61)
    assert len(timed.get("/watches/due").json()) == 1
    assert report(timed, "Appointments\nNo slots this month\nUpdated 9 minutes ago") == {"changed": False, "alert": None}
    clock.moment += timedelta(minutes=61)
    assert report(timed, "Appointments\nNo slots this week") == {"changed": True, "alert": None}
    clock.moment += timedelta(minutes=61)
    found = report(timed, "Appointments\nSlot available on December 12")
    assert found["changed"] is True
    assert found["alert"] == {"view_id": "visa", "title": "Visa slots changed", "text": "Added: Slot available on December 12 Removed: No slots this week", "checked": True}
    page = wait_until_refreshed(timed, "visa")
    assert [entry["item"]["text"] for entry in page["items"]] == ["Added: Slot available on December 12 Removed: No slots this week"]
    assert all(source.purpose == "items" for source in timed.app.state.brain.passive_sources())


def test_a_change_judged_by_the_model_alerts_at_once(timed, paths):
    (paths.views / "school.md").write_text("# School\n\n## Sources\n* Watch: https://school.example/news\n\n## Rules\n* Only events and birthdays.\n")
    timed.post("/watches/report", json={"url": "https://school.example/news", "title": "School news", "text": "Nothing new"})
    quiet = timed.post("/watches/report", json={"url": "https://school.example/news", "title": "School news", "text": "Lunch menu updated"}).json()
    assert quiet == {"changed": True, "alert": None}
    party = timed.post("/watches/report", json={"url": "https://school.example/news", "title": "School news", "text": "Class birthday party on Friday"}).json()
    assert party["alert"]["view_id"] == "school"


def test_a_page_nobody_watches_anymore_never_alerts(timed):
    assert report(timed, "Slots: none") == {"changed": False, "alert": None}
    assert report(timed, "Slot available") == {"changed": True, "alert": None}


def test_a_watched_page_too_long_is_refused(timed):
    assert timed.post("/watches/report", json={"url": VISA, "text": "x" * 100_001}).status_code == 422


def test_a_change_the_model_could_not_judge_alerts_as_unchecked(timed, paths, services):
    (paths.views / "school.md").write_text("# School\n\n## Sources\n* Watch: https://school.example/news\n\n## Rules\n* Only events and birthdays.\n")
    timed.post("/watches/report", json={"url": "https://school.example/news", "title": "School news", "text": "Nothing new"})
    timed.app.state.brain.compiler.compiled("school")
    for _ in range(3):
        services.queue_model_reply("tag", None)
    alert = timed.post("/watches/report", json={"url": "https://school.example/news", "title": "School news", "text": "Lunch menu updated"}).json()["alert"]
    assert alert["checked"] is False and alert["view_id"] == "school"


def test_a_change_item_is_enriched_and_searchable_like_any_item(timed):
    report(timed, "Appointments\nNo slots this month")
    report(timed, "Appointments\nThe slot for your visa interview is available on December 12")
    brain = timed.app.state.brain
    [(stored, _)] = [(entry, score) for entry, score in brain.store.search("interview", 5)]
    assert stored.extra["lang"] == "en" and "reading_minutes" in stored.extra
    assert set(brain.store.vectors_of([stored.item_id], "hashed")) == {stored.item_id}
    assert [hit["item"]["item_id"] for hit in timed.get("/search", params={"q": "visa interview"}).json()] == [stored.item_id]
