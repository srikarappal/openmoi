"""Test helpers shared by several test modules."""

import json
import threading

import httpx
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect


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
    """Speaks the relay protocol the way the Chrome extension does, over a real WebSocket."""

    def __init__(self, port: int, extension_id: str = EXTENSION_ID, origin_scheme: str = "chrome-extension"):
        self.connection = connect(f"ws://127.0.0.1:{port}/relay", origin=f"{origin_scheme}://{extension_id}", legacy=True)
        self.thread: threading.Thread | None = None

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
