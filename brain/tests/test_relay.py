"""The relay hub over real WebSockets: who may connect, calls and replies, events."""

import json
import threading
import time

import pytest
from helpers import EXTENSION_ID, FakeExtension, pair
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State
from websockets.sync.client import connect

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
    """The paired extension connecting again with its secret."""
    if extension_id not in hub.trusted:
        return pair(hub, hub.port, extension_id)
    extension = FakeExtension(hub.port, extension_id, secret=hub.trusted[extension_id])
    welcome = extension.recv()
    assert welcome["type"] == "welcome" and "secret" not in welcome and extension.hub_is_genuine(welcome)
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
    assert hub.status() == {"connected": False, "extension_id": None, "waiting_for_approval": None, "unrecognized": None, "paired": False}


def test_a_new_extension_waits_for_approval_then_gets_the_passive_config(hub, tmp_path):
    extension = FakeExtension(hub.port)
    assert extension.recv() == {"type": "approval_needed", "extension_id": EXTENSION_ID}
    assert hub.status()["waiting_for_approval"] == EXTENSION_ID
    with pytest.raises(RelayError, match="not connected"):
        hub.call("open", {})
    hub.trust(EXTENSION_ID)
    welcome = extension.recv()
    assert (welcome["type"], welcome["passive"]) == ("welcome", passive_config()["passive"])
    assert extension.hub_is_genuine(welcome)
    assert hub.status() == {"connected": True, "extension_id": EXTENSION_ID, "waiting_for_approval": None, "unrecognized": None, "paired": True}
    saved = json.loads((tmp_path / "trusted.json").read_text())
    assert saved == {EXTENSION_ID: welcome["secret"]}
    assert (tmp_path / "trusted.json").stat().st_mode & 0o777 == 0o600


def test_an_approved_extension_is_welcomed_at_once_next_time(hub, tmp_path, events):
    paired = pair(hub, hub.port)
    paired.close()
    again = RelayHub(tmp_path / "trusted.json", events, passive_config)
    port = again.start(0)
    try:
        extension = FakeExtension(port, secret=paired.secret)
        welcome = extension.recv()
        assert welcome["type"] == "welcome" and "secret" not in welcome and extension.hub_is_genuine(welcome)
        assert again.connected
    finally:
        again.stop()


def test_a_program_posing_as_the_connected_paired_extension_is_turned_away(hub):
    paired = trusted_extension(hub)
    paired.answer_calls(second_answer)
    for impostor in (FakeExtension(hub.port), FakeExtension(hub.port, secret="00" * 32)):
        with pytest.raises(ConnectionClosed):
            impostor.recv()
    assert hub.call("url", {}) == "second"
    assert hub.status()["extension_id"] == EXTENSION_ID
    assert hub.status()["waiting_for_approval"] is None


def test_the_welcome_proves_the_hub_knows_the_secret(hub):
    paired = trusted_extension(hub)
    forged = {"type": "welcome", "proof": "0" * 64, "passive": []}
    assert not paired.hub_is_genuine(forged)
    assert not FakeExtension(hub.port, secret=None).hub_is_genuine({"type": "welcome", "proof": "x"})


def test_a_hello_without_a_proper_nonce_is_refused(hub):
    with connect(f"ws://127.0.0.1:{hub.port}/relay", origin=f"chrome-extension://{EXTENSION_ID}", legacy=True) as raw:
        assert json.loads(raw.recv(timeout=5))["type"] == "challenge"
        raw.send(json.dumps({"type": "hello", "nonce": "short"}))
        with pytest.raises(ConnectionClosed):
            raw.recv(timeout=5)


def test_a_trust_file_from_before_secrets_pairs_nobody(tmp_path, events):
    (tmp_path / "old.json").write_text(json.dumps([EXTENSION_ID]))
    assert RelayHub(tmp_path / "old.json", events, passive_config).trusted == {}
    (tmp_path / "broken.json").write_text("{half")
    assert RelayHub(tmp_path / "broken.json", events, passive_config).trusted == {}


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


def test_calls_on_a_replaced_connection_fail_at_once_instead_of_timing_out(hub):
    first = trusted_extension(hub)
    failures: list[str] = []
    caller = threading.Thread(target=record_failure, args=(hub, failures))
    started = time.monotonic()
    caller.start()
    wait_for(has_pending_calls, hub)
    second = trusted_extension(hub)
    caller.join(timeout=5)
    assert failures == ["Chrome reconnected before answering"]
    assert time.monotonic() - started < 2
    assert hub.pending == {}
    second.answer_calls(second_answer)
    assert hub.call("url", {}) == "second"
    first.close()


def test_push_config_sends_sources_to_a_connected_extension(hub):
    extension = trusted_extension(hub)
    hub.push_config()
    assert extension.recv() == {"type": "config", **passive_config()}


def explode(message: dict) -> None:
    raise RuntimeError("brain hiccup")


def test_garbage_from_the_extension_drops_its_connection(hub):
    extension = trusted_extension(hub)
    extension.connection.send("this is not json")
    wait_for(is_disconnected, hub)
    assert not hub.connected


def test_a_failing_event_handler_is_logged_and_the_connection_stays(tmp_path, capsys):
    hub = RelayHub(tmp_path / "trusted.json", explode, passive_config)
    hub.port = hub.start(0)
    try:
        extension = trusted_extension(hub)
        extension.send({"type": "event", "event": "mine"})
        extension.send({"type": "ping"})
        assert extension.recv() == {"type": "pong"}
        assert "relay event failed: brain hiccup" in capsys.readouterr().err
        assert hub.connected
    finally:
        hub.stop()


def test_replies_from_a_waiting_extension_and_unknown_messages_are_ignored(hub):
    extension = trusted_extension(hub)
    stranger = FakeExtension(hub.port, OTHER_ID)
    assert stranger.recv()["type"] == "approval_needed"
    stranger.send({"type": "reply", "call_id": "x", "result": 1})
    extension.send({"type": "surprise"})
    extension.send({"type": "reply", "call_id": "unknown", "result": 1})
    extension.send({"type": "ping"})
    assert extension.recv() == {"type": "pong"}
    assert hub.connected


def test_sending_to_a_closed_connection_is_quiet(hub):
    extension = trusted_extension(hub)
    connection = hub.connection
    extension.close()
    wait_for(is_disconnected, hub)
    hub.send(connection, {"type": "config"})
    hub.push_config()


def test_stop_without_start_is_fine(tmp_path, events):
    RelayHub(tmp_path / "trusted.json", events, passive_config).stop()


def broken_config() -> dict:
    raise ValueError("a view file that does not parse")


def test_a_config_that_fails_still_welcomes_with_no_passive_sources(tmp_path, events, capsys):
    hub = RelayHub(tmp_path / "trusted.json", events, broken_config)
    hub.port = hub.start(0)
    try:
        extension = FakeExtension(hub.port)
        extension.recv()
        hub.trust(EXTENSION_ID)
        welcome = extension.recv()
        assert (welcome["type"], welcome["passive"]) == ("welcome", [])
        assert hub.connected
        assert "relay config failed" in capsys.readouterr().err
    finally:
        hub.stop()


def test_allowing_an_extension_that_is_not_connected_just_remembers_it(hub, tmp_path):
    hub.trust(EXTENSION_ID)
    assert not hub.connected
    assert EXTENSION_ID in json.loads((tmp_path / "trusted.json").read_text())


def test_allowing_while_the_extension_is_between_connections_pairs_its_next_one(hub):
    first = FakeExtension(hub.port)
    assert first.recv()["type"] == "approval_needed"
    first.close()
    wait_for(nobody_waiting, hub)
    hub.trust(EXTENSION_ID)
    second = FakeExtension(hub.port)
    welcome = second.recv()
    assert welcome["type"] == "welcome" and second.hub_is_genuine(welcome)
    assert welcome["secret"] == hub.trusted[EXTENSION_ID]


def test_the_allow_window_closes(hub, monkeypatch):
    hub.trust(EXTENSION_ID)
    monkeypatch.setattr("moi_brain.relay.APPROVAL_WINDOW_SECONDS", 0.0)
    assert FakeExtension(hub.port).recv()["type"] == "approval_needed"


def nobody_waiting(hub: RelayHub) -> bool:
    return hub.status()["waiting_for_approval"] is None


def test_with_the_paired_extension_gone_a_reset_extension_can_ask_again(hub):
    paired = trusted_extension(hub)
    paired.close()
    wait_for(is_disconnected, hub)
    reset = FakeExtension(hub.port)
    assert reset.recv()["type"] == "approval_needed"


def test_a_second_allow_for_a_connected_extension_keeps_its_secret(hub):
    paired = trusted_extension(hub)
    secret = hub.trusted[EXTENSION_ID]
    hub.trust(EXTENSION_ID)
    assert hub.trusted[EXTENSION_ID] == secret
    paired.close()
    wait_for(is_disconnected, hub)
    again = FakeExtension(hub.port, secret=paired.secret)
    assert again.recv()["type"] == "welcome"


def test_an_extension_paired_with_an_earlier_openmoi_is_told_to_pair_again_not_offered_allow(hub):
    hub.trusted[EXTENSION_ID] = "ab" * 32
    stale = FakeExtension(hub.port, secret="cd" * 32)
    assert stale.recv()["type"] == "approval_needed"
    assert hub.status()["unrecognized"] == EXTENSION_ID
    assert hub.status()["waiting_for_approval"] is None
    stale.close()
    reset = FakeExtension(hub.port)
    assert reset.recv()["type"] == "approval_needed"
    assert (hub.status()["unrecognized"], hub.status()["waiting_for_approval"]) == (None, EXTENSION_ID)
    hub.trust(EXTENSION_ID)
    assert reset.recv()["type"] == "welcome"
    assert hub.status()["unrecognized"] is None



def test_the_genuine_extension_connecting_clears_an_unrecognized_one(hub):
    secret = "ab" * 32
    hub.trusted[EXTENSION_ID] = secret
    stale = FakeExtension(hub.port, secret="cd" * 32)
    stale.recv()
    assert hub.status()["unrecognized"] == EXTENSION_ID
    genuine = FakeExtension(hub.port, secret=secret)
    assert genuine.recv()["type"] == "welcome"
    assert hub.status()["unrecognized"] is None


def test_allowing_a_connection_that_just_closed_lets_its_next_one_pair(hub):
    leaving = FakeExtension(hub.port)
    assert leaving.recv()["type"] == "approval_needed"
    candidate = hub.candidate[0]
    leaving.close()
    deadline = time.monotonic() + 3
    while candidate.state is State.OPEN and time.monotonic() < deadline:
        time.sleep(0.01)
    with hub.lock:
        hub.candidate = (candidate, EXTENSION_ID, "ab" * 16)
    hub.trust(EXTENSION_ID)
    assert not hub.connected
    back = FakeExtension(hub.port)
    welcome = back.recv()
    assert welcome["type"] == "welcome" and welcome["secret"] == hub.trusted[EXTENSION_ID]

