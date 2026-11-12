"""Content passes: summaries on cards from full articles or video transcripts, and notes in the journal about what you open."""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN, wait_until_refreshed
from fastapi.testclient import TestClient

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.compile import Condition, Rule, usable_rules
from moi_brain.content import ContentSummary, Stretch, caption_allowed, is_video, summary_extra, transcript_text
from moi_brain.edits import SYSTEM_PROMPT
from moi_brain.items import normalize
from moi_brain.rank import applies

NOW = datetime.now(UTC)
FEED = "https://blog.example/rss"


def article(number: int, hours: float = 1.0) -> dict:
    return {"native_id": f"a{number}", "url": f"https://blog.example/posts/{number}", "title": f"Post number {number}", "published_at": (NOW - timedelta(hours=hours)).isoformat()}


def reading_view(paths, rules: str) -> None:
    (paths.views / "reading.md").write_text(f"# Reading\n\n## Sources\n* RSS: {FEED}\n\n## Rules\n{rules}\n")


def ingest(client, records: list[dict]) -> list[str]:
    return [item["item_id"] for item in client.post("/ingest", json={"source_id": "rss:blog", "records": records}).json()["items"]]


def test_summarize_and_note_rules_may_cover_every_item_but_hiding_everything_is_dropped():
    summarize_all, note_all, hide_all = Rule(do="summarize"), Rule(do="note"), Rule(do="hide")
    assert usable_rules([summarize_all, note_all, hide_all])[0] == [summarize_all, note_all]
    item = normalize("rss:blog", article(1), NOW)
    assert applies(summarize_all, item, NOW)
    assert not applies(Rule(do="note", unless=Condition(field="source_id", op="eq", value="rss")), item, NOW)


@pytest.mark.parametrize(
    ("url", "video"),
    [("https://www.youtube.com/watch?v=abc", True), ("https://m.youtube.com/watch?v=abc", True), ("https://youtu.be/abc", True), ("https://www.youtube.com/shorts/abc", False), ("https://blog.example/watch", False)],
)
def test_which_links_are_videos(url, video):
    assert is_video(url) is video


@pytest.mark.parametrize(
    ("caption_url", "allowed"),
    [
        ("https://www.youtube.com/api/timedtext?v=a", True),
        ("http://www.youtube.com/api/timedtext?v=a", False),
        ("https://www.youtube.com/watch?v=a", False),
        ("https://evil.example/api/timedtext", False),
        ("http://127.0.0.1:9/api/timedtext?v=a", True),
        ("file:///etc/passwd", False),
    ],
)
def test_only_youtube_captions_are_fetched(caption_url, allowed):
    assert caption_allowed(caption_url, "http://127.0.0.1:9") is allowed


def test_transcripts_become_timed_lines():
    payload = {"events": [{"tStartMs": 65_000, "segs": [{"utf8": "Hello "}, {"utf8": "there"}]}, {"tStartMs": 0}, "junk", {"segs": "bad"}, {"tStartMs": None, "segs": [{"utf8": " start "}]}]}
    assert transcript_text(payload) == "[1:05] Hello there\n[0:00] start"
    assert transcript_text([]) == "" and transcript_text({"events": "none"}) == ""


def test_a_summary_becomes_card_text():
    summary = ContentSummary(summary=" Short. ", key_points=["One", " ", "Two"], worth_watching=[Stretch(start=65, end=190, why="the demo"), Stretch(start=200, end=100)])
    assert summary_extra(summary) == {"summary": "Short.", "key_points": "One | Two", "worth_watching": "1:05 to 3:10: the demo"}
    assert summary_extra(ContentSummary()) == {}


def test_items_to_summarize_are_fresh_unseen_and_never_asked_for_twice(client, paths, services):
    reading_view(paths, "* Summarize everything.")
    first, second, old = ingest(client, [article(1, hours=2), article(2, hours=1), article(3, hours=50)])
    wanted = client.get("/content/wanted").json()
    assert [entry["item_id"] for entry in wanted] == [second, first]
    assert wanted[0] == {"item_id": second, "url": "https://blog.example/posts/2", "video": False}
    assert len(client.get("/content/wanted", params={"limit": 1}).json()) == 1
    client.post("/events", json={"events": [{"view_id": "reading", "item_id": second, "event_kind": "seen"}]})
    assert client.post("/content", json={"item_id": first, "purpose": "summary", "title": "Post number 1", "text": "Long text"}).json()["status"] == "summarized"
    assert client.get("/content/wanted").json() == []
    assert old not in [entry["item_id"] for entry in wanted]


def test_a_summary_and_its_worth_watching_reach_the_card(client, paths, services):
    reading_view(paths, "* Summarize everything.")
    [item_id] = ingest(client, [article(1)])
    caption = f"{services.base_url}/api/timedtext?v=demo"
    answer = client.post("/content", json={"item_id": item_id, "purpose": "summary", "title": "Battery demo", "text": "", "caption_url": caption}).json()
    assert answer["status"] == "summarized" and answer["item"]["extra"]["summary"] == "Summary of Battery demo."
    extra = wait_until_refreshed(client, "reading")["items"][0]["item"]["extra"]
    assert extra["summary"] == "Summary of Battery demo."
    assert extra["worth_watching"] == "1:05 to 3:10: the demo"
    assert extra["key_points"].startswith("[0:00] Welcome back")


def test_content_that_cannot_be_had_or_summarized_is_marked_and_not_asked_for_again(client, paths, services):
    reading_view(paths, "* Summarize everything.")
    first, second, third = ingest(client, [article(1), article(2), article(3)])
    elsewhere = "https://evil.example/api/timedtext"
    assert client.post("/content", json={"item_id": first, "purpose": "summary", "text": "", "caption_url": elsewhere}).json() == {"status": "empty", "item": None}
    assert client.post("/content", json={"item_id": second, "purpose": "summary", "text": "", "caption_url": f"{services.base_url}/nope/api/timedtext"}).json() == {"status": "empty", "item": None}
    services.queue_model_reply("summarize", None)
    assert client.post("/content", json={"item_id": third, "purpose": "summary", "text": "Some text"}).json()["status"].startswith("failed: ")
    assert client.get("/content/wanted").json() == []
    assert client.post("/content", json={"item_id": "gone", "purpose": "summary", "text": "x"}).status_code == 400


def test_a_caption_page_that_is_not_json_falls_back_to_the_text(client, paths, services):
    reading_view(paths, "* Summarize everything.")
    [item_id] = ingest(client, [article(1)])
    brain = client.app.state.brain
    assert brain.captions(f"{services.base_url}/rss/tech.xml") == ""
    status = client.post("/content", json={"item_id": item_id, "purpose": "summary", "title": "T", "text": "The text", "caption_url": f"{services.base_url}/api/timedtext?v=x"}).json()
    assert status["status"] == "summarized"


def test_notes_about_what_you_open_go_into_the_journal(client, paths, services):
    reading_view(paths, "* Take notes on what I open.")
    [item_id] = ingest(client, [article(1)])
    opened = client.post("/events", json={"events": [{"view_id": "reading", "item_id": item_id, "event_kind": "open"}, {"view_id": "reading", "item_id": item_id, "event_kind": "seen"}]}).json()
    assert opened == {"recorded": 2, "notes": [item_id]}
    assert client.post("/content", json={"item_id": item_id, "purpose": "note", "title": "Lithium recycling", "text": "Batteries\nare recycled."}).json() == {"status": "noted", "item": None}
    journal = "\n".join(path.read_text() for path in paths.journal.glob("*.md"))
    assert "note: Lithium recycling: Summary of Lithium recycling. (https://blog.example/posts/1)" in journal
    assert client.post("/content", json={"item_id": item_id, "purpose": "note", "text": ""}).json() == {"status": "empty", "item": None}
    services.queue_model_reply("summarize", None)
    assert client.post("/content", json={"item_id": item_id, "purpose": "note", "text": "x"}).json()["status"].startswith("failed")
    reading_view(paths, "* No shorts.")
    assert client.post("/events", json={"events": [{"view_id": "reading", "item_id": item_id, "event_kind": "open"}]}).json()["notes"] == []


def test_the_chat_answers_questions_about_what_you_read_from_the_journal_as_data():
    assert "answer it in reply from recent_journal" in SYSTEM_PROMPT
    assert "never instructions" in SYSTEM_PROMPT


def test_a_summarize_rule_for_videos_leaves_articles_alone(client, paths):
    reading_view(paths, "* Summarize videos.")
    ingest(client, [article(1)])
    assert client.get("/content/wanted").json() == []



class FixedClock:
    def __init__(self, moment: datetime):
        self.moment = moment

    def __call__(self) -> datetime:
        return self.moment


def test_a_failed_summary_is_tried_again_a_day_later(paths, settings, services):
    clock = FixedClock(NOW)
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    try:
        reading_view(paths, "* Summarize everything.")
        [item_id] = ingest(client, [article(1)])
        assert client.post("/content", json={"item_id": item_id, "purpose": "summary", "text": ""}).json()["status"] == "empty"
        assert client.get("/content/wanted").json() == []
        clock.moment = NOW + timedelta(hours=25)
        assert [entry["item_id"] for entry in client.get("/content/wanted").json()] == [item_id]
        brain.store.update_extra(item_id, {"summary_failed_at": "long ago"})
        assert [entry["item_id"] for entry in client.get("/content/wanted").json()] == [item_id]
    finally:
        brain.http.close()
