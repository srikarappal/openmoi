"""Test helpers shared by several test modules."""

import httpx


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
