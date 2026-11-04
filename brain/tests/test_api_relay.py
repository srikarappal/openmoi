"""Integration for the Chrome relay through the brain's HTTP API."""

import time

import pytest
from helpers import EXTENSION_ID, FakeExtension

PASSIVE_RECORDS = [
    {"native_id": "77", "url": "https://x.com/maya/status/77", "author_handle": "maya", "text": "Read while you scrolled X yourself"},
]


@pytest.fixture
def relay_port(brain):
    port = brain.relay.start(0)
    yield port
    brain.relay.stop()


@pytest.fixture
def extension(client, relay_port):
    connected = FakeExtension(relay_port)
    assert connected.recv()["type"] == "approval_needed"
    client.post("/relay/trust", json={"extension_id": EXTENSION_ID})
    welcome = connected.recv()
    assert welcome["type"] == "welcome"
    connected.welcome = welcome
    yield connected
    connected.close()


def open_page(op: str, args: dict) -> dict:
    return {"op": op, "args": args, "handle": "512"}


def wait_for_passive(client, batches: int) -> dict:
    deadline = time.monotonic() + 3
    status = client.get("/relay/poll").json()["status"]
    while status["passive_batches"] < batches and time.monotonic() < deadline:
        time.sleep(0.02)
        status = client.get("/relay/poll").json()["status"]
    return status


def test_without_chrome_calls_fail_as_relay_errors(client, relay_port):
    assert client.get("/relay/poll").json() == {
        "status": {"connected": False, "extension_id": None, "waiting_for_approval": None, "passive_batches": 0},
        "events": [],
    }
    failed = client.post("/relay/call", json={"op": "open", "args": {"url": "https://x.com/home"}})
    assert failed.status_code == 503
    assert failed.json() == {"detail": "Chrome is not connected", "kind": "relay"}


def test_pairing_shows_up_in_the_poll_until_approved(client, relay_port):
    waiting = FakeExtension(relay_port)
    waiting.recv()
    assert client.get("/relay/poll").json()["status"]["waiting_for_approval"] == EXTENSION_ID
    assert client.post("/relay/trust", json={"extension_id": EXTENSION_ID}).json()["connected"] is True
    assert client.post("/relay/trust", json={"extension_id": "not-an-id"}).status_code == 422
    waiting.close()


def test_the_welcome_lists_page_sources_for_passive_reading(extension):
    [x_source] = extension.welcome["passive"]
    assert x_source["source_id"] == "x"
    assert x_source["url_prefix"] == "https://x.com/home"
    assert x_source["spec"]["item_root"] == "article[data-testid='tweet']"


def test_calls_are_forwarded_to_chrome(client, extension):
    extension.answer_calls(open_page)
    response = client.post("/relay/call", json={"op": "open", "args": {"url": "https://x.com/home", "background": True}})
    assert response.json() == {"result": {"op": "open", "args": {"url": "https://x.com/home", "background": True}, "handle": "512"}}
    assert client.post("/relay/call", json={"op": "delete_everything"}).status_code == 422


def test_passive_records_from_a_known_source_page_are_ingested(client, extension):
    extension.send({"type": "event", "event": "passive_records", "source_id": "x", "page_url": "https://x.com/home?ref=nav", "records": PASSIVE_RECORDS})
    assert wait_for_passive(client, 1)["passive_batches"] == 1
    texts = [view_item["item"]["text"] for view_item in client.post("/view/feed", json={}).json()["items"]]
    assert "Read while you scrolled X yourself" in texts


@pytest.mark.parametrize(
    "event",
    [
        {"type": "event", "event": "passive_records", "source_id": "x", "page_url": "https://x.com/settings", "records": PASSIVE_RECORDS},
        {"type": "event", "event": "passive_records", "source_id": "facebook", "page_url": "https://x.com/home", "records": PASSIVE_RECORDS},
        {"type": "event", "event": "passive_records", "source_id": "x", "page_url": "https://x.com/home", "records": "not a list"},
        {"type": "event", "event": "something_else"},
    ],
)
def test_other_passive_events_are_ignored(client, extension, event):
    extension.send(event)
    extension.send({"type": "ping"})
    assert extension.recv() == {"type": "pong"}
    assert client.get("/relay/poll").json()["status"]["passive_batches"] == 0
    assert client.post("/view/feed", json={}).json()["items"] == []


def test_mine_requests_wait_for_the_app_and_are_delivered_once(client, extension):
    extension.send({"type": "event", "event": "mine", "handle": "512", "url": "https://news.example.com/", "title": "News"})
    extension.send({"type": "ping"})
    extension.recv()
    assert client.get("/relay/poll").json()["events"] == [{"event": "mine", "handle": "512", "url": "https://news.example.com/", "title": "News"}]
    assert client.get("/relay/poll").json()["events"] == []


def test_debug_reports_the_relay(client, extension):
    assert client.get("/debug").json()["relay"]["connected"] is True
