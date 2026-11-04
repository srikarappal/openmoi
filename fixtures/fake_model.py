"""A deterministic stand in for an OpenAI compatible model, keyed by the x-moi-task header.

Each task handler reads the prompt the brain sent and answers the way a good model would
for the phrases our tests use. Unknown tasks echo the last user message as JSON.
"""

import json
from typing import Any


def last_user_text(payload: dict[str, Any]) -> str:
    users = [message["content"] for message in payload.get("messages", []) if message.get("role") == "user"]
    return users[-1] if users else ""


def echo(payload: dict[str, Any], base_url: str) -> str:
    return json.dumps({"echo": last_user_text(payload)})


HANDLERS = {"echo": echo}


def model_reply(task: str, payload: dict[str, Any], base_url: str) -> str:
    return HANDLERS.get(task, echo)(payload, base_url)
