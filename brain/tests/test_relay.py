"""The relay hub over real WebSockets: who may connect, calls and replies, events."""

import threading
import time

import pytest
from helpers import EXTENSION_ID, FakeExtension
from websockets.exceptions import ConnectionClosed

from moi_brain.relay import RelayError, RelayHub

OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba"


class EventLog:
    """Collects events the hub hands to the brain."""

    def __init__(self):
        self.events: list[dict] = []

    def __call__(self, message: dict) -> None:
        self.events.append(message)


def passive_config() -> dict:
    return {"passive": [{"source_id": "x", "url_prefix": "https://x.com/home"}]}


@pytest.fixture
def events():
    return EventLog()


@pytest.fixture
def hub(tmp_path, events):
    created = RelayHub(tmp_path / "trusted.json", events, passive_config)
    created.port = created.start(0)
    yield created
    created.stop()


def trusted_extension(hub: RelayHub, extension_id: str = EXTENSION_ID) -> FakeExtension:
    hub.trust(extension_id)
    extension = FakeExtension(hub.port, extension_id)
    assert extension.recv()["type"] == "welcome"
    return extension


def wait_for(check, subject, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not check(subject) and time.monotonic() < deadline:
        time.sleep(0.01)


def has_pending_calls(hub: RelayHub) -> bool:
    return bool(hub.pending)


def is_disconnected(hub: RelayHub) -> bool:
    return not hub.connected


def has_events(log: EventLog) -> bool:
    return bool(log.events)


def doubled(op: str, args: dict) -> dict:
    return {"op": op, "doubled": args["value"] * 2}


def missing_tab(op: str, args: dict) -> None:
    raise ValueError("No tab with id 7")


def second_answer(op: str, args: dict) -> str:
    return "second"


def test_web_pages_cannot_connect(hub):
    page = FakeExtension(hub.port, "evil.example", origin_scheme="https")
    with pytest.raises(ConnectionClosed):
        page.recv()
    assert hub.status() == {"connected": False, "extension_id": None, "waiting_for_approval": None, "paired": False}


def test_a_new_extension_waits_for_approval_then_gets_the_passive_config(hub, tmp_path):
    extension = FakeExtension(hub.port)
    assert extension.recv() == {"type": "approval_needed", "extension_id": EXTENSION_ID}
    assert hub.status()["waiting_for_approval"] == EXTENSION_ID
    with pytest.raises(RelayError, match="not connected"):
        hub.call("open", {})
    hub.trust(EXTENSION_ID)
    assert extension.recv() == {"type": "welcome", **passive_config()}
    assert hub.status() == {"connected": True, "extension_id": EXTENSION_ID, "waiting_for_approval": None, "paired": True}
    assert EXTENSION_ID in (tmp_path / "trusted.json").read_text()


def test_an_approved_extension_is_welcomed_at_once_next_time(hub, tmp_path, events):
    hub.trust(EXTENSION_ID)
    again = RelayHub(tmp_path / "trusted.json", events, passive_config)
    port = again.start(0)
    try:
        assert FakeExtension(port).recv()["type"] == "welcome"
        assert again.connected
    finally:
        again.stop()


def test_calls_reach_chrome_and_come_back(hub):
    extension = trusted_extension(hub)
    extension.answer_calls(doubled)
    assert hub.call("run", {"value": 21}) == {"op": "run", "doubled": 42}


def test_chrome_errors_and_silence_become_relay_errors(hub):
    extension = trusted_extension(hub)
    extension.answer_calls(missing_tab)
    with pytest.raises(RelayError, match="No tab with id 7"):
        hub.call("run", {"handle": "7"})
    extension.close()
    silent = trusted_extension(hub)
    with pytest.raises(RelayError, match="did not answer open within 0.2 s"):
        hub.call("open", {}, timeout=0.2)
    assert hub.pending == {}
    silent.close()


def test_a_disconnect_fails_waiting_calls(hub):
    extension = trusted_extension(hub)
    failures: list[str] = []
    caller = threading.Thread(target=record_failure, args=(hub, failures))
    caller.start()
    wait_for(has_pending_calls, hub)
    extension.close()
    caller.join(timeout=5)
    assert failures == ["Chrome disconnected"]
    wait_for(is_disconnected, hub)
    assert not hub.connected


def record_failure(hub: RelayHub, failures: list[str]) -> None:
    try:
        hub.call("open", {}, timeout=5)
    except RelayError as error:
        failures.append(str(error))


def test_events_from_the_approved_extension_reach_the_brain(hub, events):
    waiting = FakeExtension(hub.port, OTHER_ID)
    waiting.recv()
    waiting.send({"type": "event", "event": "mine", "url": "https://a.com"})
    extension = trusted_extension(hub)
    extension.send({"type": "event", "event": "passive_records", "source_id": "x", "records": []})
    wait_for(has_events, events)
    assert events.events == [{"type": "event", "event": "passive_records", "source_id": "x", "records": []}]


def test_ping_gets_pong_even_before_approval(hub):
    extension = FakeExtension(hub.port)
    extension.recv()
    extension.send({"type": "ping"})
    assert extension.recv() == {"type": "pong"}


def test_a_new_connection_replaces_the_old_one(hub):
    first = trusted_extension(hub)
    second = trusted_extension(hub)
    with pytest.raises(ConnectionClosed):
        first.recv(timeout=2)
    second.answer_calls(second_answer)
    assert hub.call("url", {}) == "second"


def test_push_config_sends_sources_to_a_connected_extension(hub):
    extension = trusted_extension(hub)
    hub.push_config()
    assert extension.recv() == {"type": "config", **passive_config()}
