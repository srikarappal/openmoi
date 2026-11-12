"""The Time section: editions that give a feed its last item, when their reads are due, and visit lengths."""

import json
import re
from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN, wait_until_refreshed
from fastapi.testclient import TestClient
from helpers import FixedClock
from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.compile import TimeSpec, parse_time_section
from moi_brain.config import Settings, Slot
from moi_brain.editions import LATE_READ, EditionBook, latest_edition, next_edition

DAY = datetime(2026, 11, 10, tzinfo=UTC)
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def at(hour: int, minute: int = 0, days: int = 0) -> datetime:
    return DAY + timedelta(days=days, hours=hour, minutes=minute)


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(at(6, 0))


@pytest.fixture
def timed(paths, settings, services, clock):
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    yield TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    brain.http.close()


def morning_view(paths, time_lines: str, view_id: str = "morning") -> None:
    (paths.views / f"{view_id}.md").write_text(f"# Morning\n\n## Sources\n* X home timeline\n\n## Time\n{time_lines}\n")


def posts(client: TestClient, clock: FixedClock, names: list[str]) -> list[str]:
    records = [{"native_id": name, "url": f"/maya/status/{name}", "text": f"Post {name}", "published_at": clock.moment.isoformat()} for name in names]
    items = client.post("/ingest", json={"source_id": "x", "records": records, "page_url": "https://x.com/home"}).json()["items"]
    return [item["item_id"] for item in items]


def shown(client: TestClient, view_id: str = "morning", exclude: list[str] | None = None) -> dict:
    return client.post(f"/view/{view_id}", json={"exclude_ids": exclude or []}).json()


def texts(page: dict) -> list[str]:
    return sorted(entry["item"]["text"] for entry in page["items"])


def schedule_of(client: TestClient, view_id: str = "morning") -> dict:
    return next(entry for entry in client.get("/schedule").json() if entry["view_id"] == view_id)


# Reading the Time section


@pytest.mark.parametrize(
    ("lines", "expected"),
    [
        ("* Editions at 7:00 and 18:00.", TimeSpec(editions=["07:00", "18:00"])),
        ("* Editions at 7am, noon and 6:30 pm.", TimeSpec(editions=["07:00", "12:00", "18:30"])),
        ("* Edition at 9:05 a.m. and midnight", TimeSpec(editions=["00:00", "09:05"])),
        ("* Editions at 7:00 and 7 am.", TimeSpec(editions=["07:00"])),
        ("* Each edition has 15 items.", TimeSpec(edition_size=15)),
        ("* Editions of 2000 posts at 9:00.", TimeSpec(editions=["09:00"], edition_size=500)),
        ("* A visit lasts 10 minutes.", TimeSpec(visit_minutes=10)),
        ("* Sessions of 2 hours.", TimeSpec(visit_minutes=120)),
        ("* A visit lasts 9999 minutes.", TimeSpec(visit_minutes=600)),
        ("* A visit lasts 0 minutes.", TimeSpec(visit_minutes=1)),
        ("", TimeSpec()),
    ],
)
def test_time_lines_in_plain_words(lines, expected):
    assert parse_time_section(lines) == (expected, [])


@pytest.mark.parametrize(
    ("line", "warning"),
    [
        ("* Editions at 25:00.", "No time of day or size found in: Editions at 25:00."),
        ("* Edition at 13pm.", "No time of day or size found in: Edition at 13pm."),
        ("* Editions whenever.", "No time of day or size found in: Editions whenever."),
        ("* A visit, short please.", "No length found in: A visit, short please."),
        ("* Weekdays only.", "Time line not understood: Weekdays only."),
    ],
)
def test_time_lines_it_cannot_read_become_warnings(line, warning):
    spec, warnings = parse_time_section(line)
    assert spec == TimeSpec() and warnings == [warning]


def test_a_bad_time_next_to_a_good_one_keeps_the_good_one():
    spec, warnings = parse_time_section("* Editions at 7:00 and 25:00.")
    assert spec.editions == ["07:00"] and len(warnings) == 1


@hypothesis_settings(max_examples=300, deadline=None)
@given(body=st.text(alphabet=st.sampled_from(list("* edition visit at and 0123456789:apm noon\n minutes items")), max_size=120))
def test_any_time_section_reads_into_valid_times(body):
    spec, _ = parse_time_section(body)
    assert spec.editions == sorted(set(spec.editions)) and all(HHMM.match(clock) for clock in spec.editions)
    assert spec.edition_size is None or 1 <= spec.edition_size <= 500
    assert spec.visit_minutes is None or 1 <= spec.visit_minutes <= 600


def test_the_compiled_view_carries_its_time_and_warnings(client, paths):
    morning_view(paths, "* Editions at 7:00.\n* Each edition has 3 items.\n* Whenever.")
    compiled = client.app.state.brain.compiler.compiled("morning")
    assert compiled.time == TimeSpec(editions=["07:00"], edition_size=3)
    assert "Time line not understood: Whenever." in compiled.warnings


# Edition arithmetic on your clock


def test_editions_wrap_around_midnight_on_your_clock(pacific_clock):
    spec = TimeSpec(editions=["07:00", "23:30"])
    local_quarter_past_midnight = datetime(2026, 11, 10, 8, 15, tzinfo=UTC)  # 00:15 in Los Angeles
    assert latest_edition(spec, local_quarter_past_midnight) == datetime(2026, 11, 10, 7, 30, tzinfo=UTC)
    assert next_edition(spec, local_quarter_past_midnight) == datetime(2026, 11, 10, 15, 0, tzinfo=UTC)
    assert latest_edition(TimeSpec(), local_quarter_past_midnight) is None


def test_the_edition_book_remembers_reads_and_moves_a_late_edition(tmp_path):
    book = EditionBook(tmp_path / "editions.json")
    spec = TimeSpec(editions=["07:00"])
    assert book.current("feed", spec, at(8)).cutoff == at(7)
    book.done("feed", at(7), at(6, 50))
    assert book.current("feed", spec, at(8)).cutoff == at(7)
    book.done("feed", at(7), at(7, 30))
    assert EditionBook(tmp_path / "editions.json").current("feed", spec, at(8)).cutoff == at(7, 30)
    assert book.current("feed", spec, at(8)).next_at == at(7, days=1)
    assert book.current("feed", TimeSpec(), at(8)) is None


def test_reads_are_due_in_the_lead_time_or_late_but_not_twice(tmp_path):
    book, spec, lead = EditionBook(tmp_path / "editions.json"), TimeSpec(editions=["07:00"]), timedelta(minutes=20)
    book.done("feed", at(7, days=-1), at(6, 50, days=-1))
    assert book.due("feed", spec, at(6, 30), lead) is None
    assert book.due("feed", spec, at(6, 41), lead) == at(7)
    book.done("feed", at(7), at(6, 55))
    assert book.due("feed", spec, at(6, 56), lead) is None
    assert book.due("feed", spec, at(9), lead) is None
    fresh = EditionBook(tmp_path / "other.json")
    assert fresh.due("feed", spec, at(9), lead) == at(7)
    assert fresh.due("feed", spec, at(7) + LATE_READ + timedelta(minutes=1), lead) is None


def test_a_damaged_edition_file_starts_over(tmp_path):
    (tmp_path / "editions.json").write_text('{"feed": "nonsense", "tech": {"edition": "x"}, "news": {"2026-11-10T07:00:00+00:00": "bad"}}')
    book = EditionBook(tmp_path / "editions.json")
    assert book.read_done_at("feed", at(7)) is None and book.reads["news"] == {}
    (tmp_path / "list.json").write_text("[1, 2]")
    assert EditionBook(tmp_path / "list.json").reads == {}
    book.reads["tech"] = {at(7).astimezone().isoformat(): {"done_at": "yesterday"}}
    assert book.read_done_at("tech", at(7)) is None


def test_a_file_from_before_per_edition_entries_is_read(tmp_path):
    seven = at(7).astimezone().isoformat()
    old = {"feed": {"edition": seven, "done_at": at(6, 50).isoformat(), "early_for": seven, "early": at(9).isoformat()}}
    (tmp_path / "editions.json").write_text(json.dumps(old))
    book = EditionBook(tmp_path / "editions.json")
    assert book.read_done_at("feed", at(7)) == at(6, 50) and book.opened_early_at("feed", at(7)) == at(9)


def test_two_editions_a_day_are_read_once_each_and_never_thrash(tmp_path):
    """Reading for 18:00 must not make the 7:00 read due again, and the 7:00 cutoff must stay put."""
    book, spec, lead = EditionBook(tmp_path / "editions.json"), TimeSpec(editions=["07:00", "18:00"]), timedelta(minutes=20)
    book.done("feed", at(7), at(6, 50))
    reads = 0
    for minute in range(40, 60):
        now = at(17, minute)
        if (due := book.due("feed", spec, now, lead)) is not None:
            reads += 1
            book.done("feed", due, now)
    assert reads == 1
    assert book.current("feed", spec, at(17, 59)).cutoff == at(7)
    assert book.current("feed", spec, at(18, 5)).cutoff == at(18)


def test_old_edition_entries_are_dropped(tmp_path):
    book = EditionBook(tmp_path / "editions.json")
    book.done("feed", at(7, days=-5), at(6, 50, days=-5))
    book.done("feed", at(7), at(6, 50))
    assert list(EditionBook(tmp_path / "editions.json").reads["feed"]) == [at(7).astimezone().isoformat()]


# Journeys


def test_the_morning_edition_has_a_last_item(timed, paths, clock):
    """Read before 7:00, shown at 7:00, three items and then truly done; what arrives later waits for tomorrow."""
    morning_view(paths, "* Editions at 7:00.\n* Each edition has 3 items.")
    clock.moment = at(5, 30)
    assert schedule_of(timed)["read_for"] is None
    clock.moment = at(6, 45)
    assert schedule_of(timed)["read_for"] == at(7).isoformat().replace("+00:00", "Z")
    posts(timed, clock, ["a", "b", "c", "d"])
    timed.post("/schedule/done", json={"view_id": "morning", "edition": at(7).isoformat()})
    clock.moment = at(6, 55)
    early = shown(timed)
    assert early["items"] == [] and early["caught_up"] and early["next_edition"].startswith("2026-11-10T07:00")
    clock.moment = at(7, 5)
    edition = wait_until_refreshed(timed, "morning")
    assert len(edition["items"]) == 3 and not edition["has_more"] and edition["edition"].startswith("2026-11-10T07:00")
    first = [entry["item"]["item_id"] for entry in edition["items"]]
    timed.post("/events", json={"events": [{"view_id": "morning", "item_id": item_id, "event_kind": "seen"} for item_id in first]})
    clock.moment = at(7, 10)
    posts(timed, clock, ["late"])
    after = shown(timed)
    assert [entry["item"]["item_id"] for entry in after["items"]] == first
    assert shown(timed, exclude=first)["items"] == [] and shown(timed, exclude=first)["caught_up"]
    clock.moment = at(7, 5, days=1)
    tomorrow = shown(timed)
    assert texts(tomorrow) == ["Post d", "Post late"]


def test_a_read_the_mac_slept_through_runs_late_and_joins_the_edition(timed, paths, clock):
    morning_view(paths, "* Editions at 7:00.")
    clock.moment = at(7, 30)
    assert schedule_of(timed)["read_for"].startswith("2026-11-10T07:00")
    posts(timed, clock, ["a", "b"])
    clock.moment = at(7, 32)
    assert shown(timed)["items"] == []
    timed.post("/schedule/done", json={"view_id": "morning", "edition": at(7).isoformat()})
    assert texts(shown(timed)) == ["Post a", "Post b"]
    assert schedule_of(timed)["read_for"] is None


def test_what_you_read_in_the_last_edition_does_not_come_back_in_the_next(timed, paths, clock):
    morning_view(paths, "* Editions at 7:00 and 18:00.")
    clock.moment = at(6, 50)
    [item_id] = posts(timed, clock, ["a"])
    timed.post("/schedule/done", json={"view_id": "morning", "edition": at(7).isoformat()})
    clock.moment = at(17, 0)
    assert texts(shown(timed)) == ["Post a"]
    timed.post("/events", json={"events": [{"view_id": "morning", "item_id": item_id, "event_kind": "seen"}]})
    assert texts(shown(timed)) == ["Post a"]
    clock.moment = at(18, 5)
    assert shown(timed)["items"] == []


def test_the_schedule_lists_views_with_time_and_never_asks_the_model(timed, paths, services):
    morning_view(paths, "* Editions at 7:00.")
    (paths.views / "break.md").write_text("# Break\n\n## Sources\n* X home timeline\n\n## Rules\n* No shorts.\n\n## Time\n* A visit lasts 5 minutes.\n")
    calls = len(services.model_calls())
    entries = {entry["view_id"]: entry for entry in timed.get("/schedule").json()}
    assert set(entries) == {"morning", "break"}
    assert entries["break"] == {"view_id": "break", "title": "Break", "edition": None, "next_edition": None, "read_for": None, "visit_minutes": 5}
    assert entries["morning"]["next_edition"].startswith("2026-11-10T07:00")
    assert len(services.model_calls()) == calls


def test_a_local_fast_model_starts_reading_an_hour_ahead(paths, services, clock):
    morning_view(paths, "* Editions at 7:00.")
    clock.moment = at(6, 15)
    hosted = Slot(base_url="https://models.example/v1", model="hosted")
    for fast, expected in ((hosted, None), (Slot(base_url=f"{services.base_url}/llm/v1", model="local"), "2026-11-10T07:00")):
        brain = Brain(paths, Settings(fast=fast, smart=hosted), youtube_base=services.base_url, clock=clock)
        try:
            due = next(entry for entry in brain.schedules() if entry.view_id == "morning").read_for
            assert (due.isoformat()[:16] if due else None) == expected
        finally:
            brain.http.close()


def test_schedule_done_refuses_a_bad_view_id(timed):
    response = timed.post("/schedule/done", json={"view_id": "../x", "edition": at(7).isoformat()})
    assert response.status_code == 400


def test_time_is_changed_by_chat_with_its_own_scope(client, paths):
    proposal = client.post("/edit", json={"view_id": "feed", "text": "Editions at 7:00 and 18:00", "scope": "time"}).json()
    assert [change["file"] for change in proposal["changes"]] == ["views/feed.md"]
    client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    assert client.app.state.brain.compiler.compiled("feed").time.editions == ["07:00", "18:00"]
    rules_only = client.post("/edit", json={"view_id": "feed", "text": "Editions at 9:00", "scope": "rules"}).json()
    assert rules_only["changes"] == []
