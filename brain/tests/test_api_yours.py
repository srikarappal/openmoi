"""Integration for M2: rules from plain words, chat edits, less like this, tagging and the journal."""

import time
from datetime import UTC, datetime, timedelta

from conftest import wait_until_refreshed

from moi_brain.config import Settings, Slot


def refreshed_page(client) -> dict:
    client.post("/refresh", json={"view_id": "feed"})
    return wait_until_refreshed(client)


def titles(page: dict) -> list[str]:
    return [view_item["item"]["title"] or view_item["item"]["text"] for view_item in page["items"]]


def ingest_x(client) -> None:
    records = [
        {"native_id": "1", "url": "https://x.com/bob/status/1", "author_handle": "bob", "text": "Bob says hi"},
        {"native_id": "2", "url": "https://x.com/maya/status/2", "author_handle": "maya", "text": "Maya at the market", "published_at": (datetime.now(UTC) - timedelta(days=3)).isoformat()},
    ]
    client.post("/ingest", json={"source_id": "x", "records": records})


def test_new_items_are_tagged_with_watched_topics(client):
    page = refreshed_page(client)
    topics = {view_item["item"]["native_id"]: view_item["item"]["topics"] for view_item in page["items"]}
    assert topics["tech1"] == ["technology"]
    assert topics["tech2"] == ["politics"]
    assert topics["news1"] == ["politics"]
    assert topics["tech3"] == ["science"]


def test_chat_edit_proposes_a_diff_and_applying_changes_the_feed(client, paths):
    page = refreshed_page(client)
    assert "One minute physics trick" in titles(page)
    proposal = client.post("/edit", json={"view_id": "feed", "text": "No shorts, hide politics"}).json()
    [change] = proposal["changes"]
    assert change["file"] == "views/feed.md"
    assert "+* No shorts." in change["diff"] and "+* Hide politics." in change["diff"]
    assert "No shorts" not in (paths.views / "feed.md").read_text()
    applied = client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]}).json()
    assert applied["proposal_id"] == proposal["proposal_id"]
    after = client.post("/view/feed", json={}).json()
    shown = titles(after)
    assert "One minute physics trick" not in shown
    assert not [title for title in shown if "Election" in title or "Senate" in title]
    assert "New laptop chip doubles battery life" in shown
    assert after["summary"] == "Reading X, 1 YouTube channel and 2 RSS feeds. No shorts; Hide politics."
    assert after["version"] != page["version"]


def test_hand_edits_work_the_same_as_chat_edits(client, paths):
    refreshed_page(client)
    ingest_x(client)
    view = (paths.views / "feed.md").read_text().replace("## Rules\n", "## Rules\n* Posts from @maya always first.\n")
    (paths.views / "feed.md").write_text(view)
    page = client.post("/view/feed", json={}).json()
    first = page["items"][0]
    assert first["item"]["author_handle"] == "maya"
    assert first["reasons"][0] == "boost: author maya"
    assert all(view_item["reasons"] for view_item in page["items"])


def test_less_like_this_writes_a_dislike_that_hides_the_item(client, paths):
    page = refreshed_page(client)
    bakery = next(view_item["item"] for view_item in page["items"] if view_item["item"]["title"].startswith("Local bakery"))
    proposal = client.post("/edit", json={"view_id": "feed", "text": "less like this", "item_id": bakery["item_id"]}).json()
    assert proposal["changes"][0]["file"] == "memory/dislikes.md"
    client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    assert 'Posts like "Local bakery wins national prize"' in (paths.memory / "dislikes.md").read_text()
    shown = titles(client.post("/view/feed", json={}).json())
    assert "Local bakery wins national prize" not in shown
    assert "New laptop chip doubles battery life" in shown


def test_a_rule_on_a_new_topic_retags_recent_items(client, paths):
    refreshed_page(client)
    view = (paths.views / "feed.md").read_text().replace("## Rules\n", "## Rules\n* Hide solar.\n")
    (paths.views / "feed.md").write_text(view)
    page = client.post("/view/feed", json={}).json()
    assert page["refreshing"] is True
    deadline = time.monotonic() + 5
    while page["refreshing"] and time.monotonic() < deadline:
        time.sleep(0.05)
        page = client.post("/view/feed", json={}).json()
    assert "How solar panels got cheap" not in titles(page)


def test_opening_an_item_writes_the_journal(client, paths):
    page = refreshed_page(client)
    item = page["items"][0]["item"]
    client.post("/events", json={"events": [{"view_id": "feed", "item_id": item["item_id"], "event_kind": "open"}]})
    [journal] = list(paths.journal.glob("*.md"))
    assert f"opened: {item['title']} ({item['url']})" in journal.read_text()


def test_stale_unknown_and_discarded_proposals_are_refused(client, paths):
    proposal = client.post("/edit", json={"view_id": "feed", "text": "no shorts"}).json()
    (paths.views / "feed.md").write_text((paths.views / "feed.md").read_text() + "\n")
    stale = client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    assert stale.status_code == 400
    assert "changed since" in stale.json()["detail"]
    assert client.post("/edit/apply", json={"proposal_id": "unknown"}).status_code == 400
    discarded = client.post("/edit", json={"view_id": "feed", "text": "no shorts"}).json()
    assert client.post("/edit/discard", json={"proposal_id": discarded["proposal_id"]}).json() == {"status": "discarded"}
    assert client.post("/edit/apply", json={"proposal_id": discarded["proposal_id"]}).status_code == 400
    assert client.post("/edit", json={"view_id": "feed", "text": ""}).status_code == 422


def test_edits_need_a_local_model_unless_you_allow_hosted(client, brain):
    brain.gateway.settings = Settings(fast=Slot(base_url="https://models.example.com/v1", model="big"), smart=brain.gateway.settings.smart)
    blocked = client.post("/edit", json={"view_id": "feed", "text": "no shorts"})
    assert blocked.status_code == 409
    assert blocked.json()["kind"] == "privacy"


def test_model_outage_reports_an_llm_error(client, services):
    services.queue_model_reply("edit", None)
    failed = client.post("/edit", json={"view_id": "feed", "text": "no shorts"})
    assert failed.status_code == 502
    assert failed.json()["kind"] == "llm"


def test_rollback_moves_the_lens_pointer(client, brain):
    brain.lenses.save("feed", "<p>one</p>", "h1")
    brain.lenses.save("feed", "<p>two</p>", "h2")
    proposal = client.post("/edit", json={"view_id": "feed", "text": "previous look please"}).json()
    client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    assert client.get("/lens/feed").text == "<p>one</p>"
