"""The Chrome relay: the openMoi extension connects here and runs page operations in your own Chrome.

The app's calls go out to the extension and wait for its reply. Events come back the other way:
records from pages you browsed yourself plus pages you asked to see as Mine. Only an extension
you approved in the app may take calls or send events. Everything stays on 127.0.0.1.
"""

import json
import sys
import threading
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from websockets.exceptions import ConnectionClosed
from websockets.sync.server import Server, ServerConnection, serve

DEFAULT_PORT = 47321
CALL_TIMEOUT_SECONDS = 30.0
EXTENSION_ORIGIN = "chrome-extension://"

EventHandler = Callable[[dict[str, Any]], None]
ConfigSource = Callable[[], dict[str, Any]]


class RelayError(Exception):
    """Chrome is not connected, or a page operation in Chrome failed."""


class PendingCall:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: Any = None
        self.error: str | None = None


def extension_id_of(connection: ServerConnection) -> str | None:
    """The extension id from the Origin header; web pages and other clients get None."""
    origin = connection.request.headers.get("Origin", "") if connection.request else ""
    extension_id = origin.removeprefix(EXTENSION_ORIGIN).strip("/")
    return extension_id if origin.startswith(EXTENSION_ORIGIN) and extension_id.isalnum() else None


class RelayHub:
    def __init__(self, trust_file: Path, on_event: EventHandler, config: ConfigSource):
        self.trust_file = trust_file
        self.on_event = on_event
        self.config = config
        self.lock = threading.Lock()
        self.send_lock = threading.Lock()
        self.trusted: set[str] = set(json.loads(trust_file.read_text())) if trust_file.exists() else set()
        self.connection: ServerConnection | None = None
        self.extension_id: str | None = None
        self.candidate: tuple[ServerConnection, str] | None = None
        self.pending: dict[str, tuple[ServerConnection, PendingCall]] = {}
        self.server: Server | None = None

    def start(self, port: int = DEFAULT_PORT) -> int:
        """Listen on 127.0.0.1 in a background thread; returns the bound port."""
        self.server = serve(self.handle, "127.0.0.1", port)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self.server.socket.getsockname()[1]

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()

    @property
    def connected(self) -> bool:
        with self.lock:
            return self.connection is not None

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "connected": self.connection is not None,
                "extension_id": self.extension_id,
                "waiting_for_approval": self.candidate[1] if self.candidate else None,
                "paired": bool(self.trusted),
            }

    def handle(self, connection: ServerConnection) -> None:
        extension_id = extension_id_of(connection)
        if extension_id is None:
            connection.close(code=1008, reason="only the openMoi extension may connect")
            return
        if extension_id in self.trusted:
            self.activate(connection, extension_id)
        else:
            with self.lock:
                self.candidate = (connection, extension_id)
            self.send(connection, {"type": "approval_needed", "extension_id": extension_id})
        try:
            for raw in connection:
                self.receive(connection, json.loads(raw))
        except (ConnectionClosed, ValueError):
            pass
        finally:
            self.forget(connection)

    def activate(self, connection: ServerConnection, extension_id: str) -> None:
        """A new connection replaces the old one; calls sent on the old one will never be answered, so they fail now."""
        with self.lock:
            previous = self.connection
            self.connection = connection
            self.extension_id = extension_id
            self.candidate = None
        if previous is not None and previous is not connection:
            self.fail_calls(previous, "Chrome reconnected before answering")
            previous.close()
        self.send(connection, {"type": "welcome", **self.config()})

    def forget(self, connection: ServerConnection) -> None:
        """A closed connection fails every call still waiting on it."""
        with self.lock:
            if self.candidate and self.candidate[0] is connection:
                self.candidate = None
            if self.connection is connection:
                self.connection = None
        self.fail_calls(connection, "Chrome disconnected")

    def fail_calls(self, connection: ServerConnection, reason: str) -> None:
        with self.lock:
            failed = [call_id for call_id, (sent_on, _) in self.pending.items() if sent_on is connection]
            calls = [self.pending.pop(call_id)[1] for call_id in failed]
        for call in calls:
            call.error = reason
            call.done.set()

    def receive(self, connection: ServerConnection, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "ping":
            self.send(connection, {"type": "pong"})
            return
        with self.lock:
            active = connection is self.connection
        if not active:
            return
        if kind == "reply":
            with self.lock:
                entry = self.pending.pop(str(message.get("call_id")), None)
            if entry:
                call = entry[1]
                call.result = message.get("result")
                call.error = message.get("error")
                call.done.set()
        elif kind == "event":
            try:
                self.on_event(message)
            except Exception as error:
                print(f"relay event failed: {error}", file=sys.stderr)

    def send(self, connection: ServerConnection, message: dict[str, Any]) -> None:
        with self.send_lock:
            try:
                connection.send(json.dumps(message))
            except ConnectionClosed:
                pass

    def call(self, op: str, args: dict[str, Any], timeout: float = CALL_TIMEOUT_SECONDS) -> Any:
        """Run one operation in Chrome and wait for its answer."""
        call = PendingCall()
        call_id = uuid.uuid4().hex
        with self.lock:
            connection = self.connection
            if connection is None:
                raise RelayError("Chrome is not connected")
            self.pending[call_id] = (connection, call)
        self.send(connection, {"type": "call", "call_id": call_id, "op": op, "args": args})
        if not call.done.wait(timeout):
            with self.lock:
                self.pending.pop(call_id, None)
            raise RelayError(f"Chrome did not answer {op} within {timeout:g} s")
        if call.error:
            raise RelayError(call.error)
        return call.result

    def trust(self, extension_id: str) -> None:
        """Approve an extension; if it is waiting right now it becomes the connected one."""
        self.trusted.add(extension_id)
        self.trust_file.write_text(json.dumps(sorted(self.trusted)))
        with self.lock:
            candidate = self.candidate if self.candidate and self.candidate[1] == extension_id else None
        if candidate:
            self.activate(*candidate)

    def push_config(self) -> None:
        """Send the current passive sources to a connected extension."""
        with self.lock:
            connection = self.connection
        if connection is not None:
            self.send(connection, {"type": "config", **self.config()})
