"""Test helpers shared by several test modules."""

import json
import secrets
import threading

import httpx
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from moi_brain.relay import EXTENSION_PROOF, HUB_PROOF, proof


def ok_reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 1000, "completion_tokens": 100}})


class Recorder:
    """A fake transport that replays replies in order and keeps every request."""

    def __init__(self, *replies: httpx.Response):
        self.replies = list(replies)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.replies.pop(0)


EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"


class FakeExtension:
    """Speaks the relay protocol the way the Chrome extension does, over a real WebSocket.

    It answers the hub's challenge on connect, with a proof when it holds a pairing secret."""

    def __init__(self, port: int, extension_id: str = EXTENSION_ID, origin_scheme: str = "chrome-extension", secret: str | None = None):
        self.connection = connect(f"ws://127.0.0.1:{port}/relay", origin=f"{origin_scheme}://{extension_id}", legacy=True)
        self.thread: threading.Thread | None = None
        self.secret = secret
        self.nonce = secrets.token_hex(16)
        try:
            challenge = self.recv()
        except ConnectionClosed:
            return
        answer = proof(secret, EXTENSION_PROOF, challenge["nonce"]) if secret else None
        self.send({"type": "hello", "nonce": self.nonce, "proof": answer})

    def hub_is_genuine(self, welcome: dict) -> bool:
        """The check the real extension makes before it takes any call."""
        secret = self.secret or welcome.get("secret")
        return bool(secret) and welcome.get("proof") == proof(secret, HUB_PROOF, self.nonce)

    def recv(self, timeout: float = 5.0) -> dict:
        return json.loads(self.connection.recv(timeout=timeout))

    def send(self, message: dict) -> None:
        self.connection.send(json.dumps(message))

    def answer_calls(self, handler) -> None:
        """Answer every call in a background thread with handler(op, args), or an error if it raises."""
        self.thread = threading.Thread(target=self.serve, args=(handler,), daemon=True)
        self.thread.start()

    def serve(self, handler) -> None:
        try:
            for raw in self.connection:
                message = json.loads(raw)
                if message.get("type") != "call":
                    continue
                try:
                    reply = {"result": handler(message["op"], message["args"])}
                except Exception as error:
                    reply = {"error": str(error)}
                self.send({"type": "reply", "call_id": message["call_id"], **reply})
        except ConnectionClosed:
            pass

    def close(self) -> None:
        self.connection.close()


def pair(hub, port: int, extension_id: str = EXTENSION_ID) -> FakeExtension:
    """A first connection that you allow in the app; the extension keeps the secret the hub gives it."""
    extension = FakeExtension(port, extension_id)
    assert extension.recv()["type"] == "approval_needed"
    hub.trust(extension_id)
    welcome = extension.recv()
    assert welcome["type"] == "welcome" and extension.hub_is_genuine(welcome)
    extension.secret = welcome["secret"]
    return extension

