"""One gateway for every model call: two slots, a privacy switch and a call log."""

import json
import os
import threading
from collections import deque
from datetime import UTC, datetime
from operator import itemgetter
from pathlib import Path
from typing import Any, Literal, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from moi_brain.config import Settings, Slot
from moi_brain.vectors import normalized

SlotName = Literal["fast", "smart", "vision"]
ModelType = TypeVar("ModelType", bound=BaseModel)
TIMEOUT_SECONDS = 180.0
# Embedding runs while items are stored, so a model that hangs must not hold reading up for long.
EMBED_TIMEOUT_SECONDS = 20.0
MAX_ERROR_FEEDBACK = 1500


class LlmError(Exception):
    """A model call failed or returned something unusable."""


class InvalidReply(LlmError):
    """The model answered, twice, with something that is not the JSON asked for."""


class PrivacyBlocked(LlmError):
    """The call carries your content but its slot is hosted and the privacy switch is off."""


def strip_fence(content: str) -> str:
    """Remove a surrounding Markdown code fence if the model added one."""
    text = content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        text = text.rsplit("```", 1)[0]
    return text.strip()


def json_object_text(content: str) -> str:
    """The outermost JSON object in a reply, tolerating prose around it."""
    text = strip_fence(content)
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if start != -1 and end > start else text


# The call log keeps one older file beside it, so it never grows past about twice this.
MAX_LOG_BYTES = 5_000_000


def readable_line(line: str) -> dict[str, Any] | None:
    """One log line, or None for a line cut short by a crash."""
    try:
        return json.loads(line)
    except ValueError:
        return None


class Gateway:
    def __init__(self, settings: Settings, log_path: Path, http: httpx.Client):
        self.settings = settings
        self.log_path = log_path
        self.http = http
        self.log_lock = threading.Lock()

    def slot(self, slot_name: SlotName) -> Slot:
        slot = getattr(self.settings, slot_name)
        if slot is None:
            raise LlmError(f"no {slot_name} model is set up")
        return slot

    def complete(
        self,
        slot_name: SlotName,
        task: str,
        messages: list[dict[str, Any]],
        contains_user_content: bool,
        json_mode: bool = False,
    ) -> str:
        slot = self.slot(slot_name)
        if contains_user_content and not slot.is_local and not self.settings.allow_content_to_hosted:
            raise PrivacyBlocked(
                f"{task} needs your content but the {slot_name} slot is a hosted model; "
                "start a local model or allow it with /model privacy on"
            )
        payload: dict[str, Any] = {**slot.extra, "model": slot.model, "messages": messages, "temperature": 0.2}
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        headers = {"x-moi-task": task}
        if slot.api_key_env:
            headers["authorization"] = f"Bearer {os.environ.get(slot.api_key_env, '')}"
        try:
            response = self.http.post(
                f"{slot.base_url.rstrip('/')}/chat/completions", json=payload, headers=headers, timeout=TIMEOUT_SECONDS
            )
            response.raise_for_status()
            body = response.json()
            content = body["choices"][0]["message"]["content"]
        except httpx.ConnectError as error:
            self.log(task, slot_name, slot, {}, contains_user_content, str(error))
            raise LlmError(f"nothing is listening at {slot.base_url} for the {slot_name} slot; is the model server (Ollama) running?") from error
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as error:
            self.log(task, slot_name, slot, {}, contains_user_content, str(error))
            raise LlmError(f"{task} failed on the {slot_name} slot: {error}") from error
        self.log(task, slot_name, slot, body.get("usage") or {}, contains_user_content, None)
        return content or ""

    def embed(self, task: str, texts: list[str]) -> list[list[float]] | None:
        """Vectors from the embedding slot, unit length, in the order given; None when there is no slot, it may not see
        your content, or it failed (the caller then uses hashed vectors)."""
        slot = self.settings.embed
        if slot is None or not texts or (not slot.is_local and not self.settings.allow_content_to_hosted):
            return None
        headers = {"x-moi-task": task}
        if slot.api_key_env:
            headers["authorization"] = f"Bearer {os.environ.get(slot.api_key_env, '')}"
        try:
            response = self.http.post(f"{slot.base_url.rstrip('/')}/embeddings", json={"model": slot.model, "input": texts}, headers=headers, timeout=EMBED_TIMEOUT_SECONDS)
            response.raise_for_status()
            body = response.json()
            vectors = [entry["embedding"] for entry in sorted(body["data"], key=itemgetter("index"))]
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as error:
            self.log(task, "embed", slot, {}, True, str(error))
            return None
        self.log(task, "embed", slot, body.get("usage") or {}, True, None)
        return [normalized([float(value) for value in vector]) for vector in vectors] if len(vectors) == len(texts) else None

    def complete_json(
        self,
        slot_name: SlotName,
        task: str,
        messages: list[dict[str, Any]],
        contains_user_content: bool,
        model_type: type[ModelType],
    ) -> ModelType:
        """A reply validated against model_type, with one retry that shows the model its mistake."""
        conversation = list(messages)
        error_text = ""
        for _ in range(2):
            content = self.complete(slot_name, task, conversation, contains_user_content, json_mode=True)
            try:
                return model_type.model_validate_json(json_object_text(content))
            except ValidationError as error:
                error_text = str(error)[:MAX_ERROR_FEEDBACK]
                conversation = [
                    *conversation,
                    {"role": "assistant", "content": content},
                    {"role": "user", "content": f"That reply was invalid: {error_text}\nReply again with valid JSON only."},
                ]
        raise InvalidReply(f"{task} returned invalid JSON twice: {error_text}")

    def complete_text(
        self, slot_name: SlotName, task: str, messages: list[dict[str, str]], contains_user_content: bool
    ) -> str:
        return strip_fence(self.complete(slot_name, task, messages, contains_user_content))

    def log(
        self,
        task: str,
        slot_name: str,
        slot: Slot,
        usage: dict[str, Any],
        contains_user_content: bool,
        error: str | None,
    ) -> None:
        tokens_in = int(usage.get("prompt_tokens") or 0)
        tokens_out = int(usage.get("completion_tokens") or 0)
        cost = (tokens_in * slot.input_cost_per_million + tokens_out * slot.output_cost_per_million) / 1_000_000
        line = {
            "ts": datetime.now(UTC).isoformat(),
            "task": task,
            "slot": slot_name,
            "model": slot.model,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "cost_usd": round(cost, 6),
            "contained_user_content": contains_user_content,
            "error": error,
        }
        with self.log_lock:
            if self.log_path.exists() and self.log_path.stat().st_size > MAX_LOG_BYTES:
                os.replace(self.log_path, self.log_path.with_name(f"{self.log_path.name}.1"))
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(f"{json.dumps(line)}\n")

    def recent_calls(self, limit: int = 20) -> list[dict[str, Any]]:
        if not self.log_path.exists():
            return []
        with self.log_lock, self.log_path.open(encoding="utf-8") as handle:
            lines = deque(handle, maxlen=limit)
        return [call for call in (readable_line(line) for line in lines) if call is not None]
