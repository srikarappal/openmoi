"""Actions and the policy gate: openMoi acting on a site for you, only as far as you allow.

Tier 0 changes only your own files (save, note) and needs no gate. Tier 1 is reversible and public (like, follow,
bookmark): your click, a rate cap and five seconds to undo. Tier 2 speaks for you (reply, post, repost, message, add
to cart): you confirm the exact text, target and site first. Tier 3 spends money or cannot be undone (place an order,
delete, cancel a paid plan): openMoi has no executor for it at all and only opens the page for you to do it yourself.

Every request carries its origin: your gesture, or a plan you approved. Content is never an origin: nothing a page,
post or model says can make a request. Each request and its outcome go to an audit log, .moi/actions.jsonl.
"""

import json
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, Field

from moi_brain.files import read_text

Tier = Literal[0, 1, 2, 3]
Origin = Literal["gesture", "plan"]
Outcome = Literal["done", "failed", "undone", "declined"]
MAX_TEXT = 2000
RATE_WINDOW = timedelta(hours=1)
# How many requests of a tier may go to one site in an hour.
RATE_CAPS = {1: 30, 2: 10}
UNDO_SECONDS = 5


class ActionKind(BaseModel):
    tier: Tier
    # The words you write go with it: a reply or a post.
    needs_text: bool = False
    # What undoes it, for tier 1.
    inverse: str | None = None
    label: str


KINDS: dict[str, ActionKind] = {
    "like": ActionKind(tier=1, inverse="unlike", label="Like"),
    "unlike": ActionKind(tier=1, inverse="like", label="Unlike"),
    "follow": ActionKind(tier=1, inverse="unfollow", label="Follow"),
    "unfollow": ActionKind(tier=1, inverse="follow", label="Unfollow"),
    "bookmark": ActionKind(tier=1, inverse="unbookmark", label="Bookmark"),
    "unbookmark": ActionKind(tier=1, inverse="bookmark", label="Remove bookmark"),
    "repost": ActionKind(tier=2, label="Repost"),
    "reply": ActionKind(tier=2, needs_text=True, label="Reply"),
    "message": ActionKind(tier=2, needs_text=True, label="Message"),
    "add_to_cart": ActionKind(tier=2, label="Add to cart"),
    "place_order": ActionKind(tier=3, label="Place the order"),
    "delete": ActionKind(tier=3, label="Delete"),
    "cancel_plan": ActionKind(tier=3, label="Cancel the plan"),
}


class ActionAnchor(BaseModel):
    """Where an action's control is on a page, from the page's spec: the control to click, how the page shows it
    worked, and for a reply the box to write in and the button that sends it."""

    select: str = Field(min_length=1, max_length=300)
    # The item's own part of its page (the post itself, not the post it replies to or the replies under it): the
    # control and its active state are looked for only inside it, and it must be there exactly once.
    within: str | None = Field(default=None, max_length=300)
    # Shows once the action worked (the Like button becomes Unlike).
    active_state: str | None = Field(default=None, max_length=300)
    # Or: an element whose text changes when the action worked (the cart count).
    changed: str | None = Field(default=None, max_length=300)
    input: str | None = Field(default=None, max_length=300)
    submit: str | None = Field(default=None, max_length=300)


class ActionRequest(BaseModel):
    item_id: str = Field(min_length=1, max_length=200)
    action: str = Field(min_length=1, max_length=40)
    text: str = Field(default="", max_length=MAX_TEXT)
    origin: Origin = "gesture"
    # For an origin of "plan": the plan you approved that asks for this.
    plan_id: str | None = Field(default=None, max_length=100)


class ActionDecision(BaseModel):
    request_id: str
    action: str
    label: str
    tier: Tier
    allowed: bool
    # Tier 2, or any public action a plan asks for: you see the exact action first.
    confirm: bool = False
    # Seconds you have to undo a tier 1 action before it is done.
    undo_seconds: int = 0
    reason: str = ""
    url: str = ""
    title: str = ""
    site: str = ""
    text: str = ""
    anchor: ActionAnchor | None = None
    # Who asked: your click, or an agent's plan you approved (the confirm sheet says so).
    origin: Origin = "gesture"
    plan_id: str | None = None


class ActionResult(BaseModel):
    request_id: str = Field(min_length=1, max_length=100)
    outcome: Outcome
    detail: str = Field(default="", max_length=500)


class AuditLog:
    """Every action request with its decision, and every outcome, one JSON line each. The file is read once and kept
    in memory after; the lock lets a check and the entry it leads to be one step (hold it around both)."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.cache: list[dict[str, object]] | None = None

    def loaded(self) -> list[dict[str, object]]:
        with self.lock:
            if self.cache is None:
                self.cache = []
                for line in read_text(self.path).splitlines():
                    try:
                        self.cache.append(json.loads(line))
                    except ValueError:
                        continue
            return self.cache

    def append(self, entry: dict[str, object]) -> None:
        with self.lock:
            entries = self.loaded()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry) + "\n")
            entries.append(entry)

    def entries(self) -> list[dict[str, object]]:
        with self.lock:
            return list(self.loaded())

    def recent_requests(self, site: str, tier: int, since: datetime) -> int:
        """Allowed requests of a tier to a site since a moment that reached the site or still may: what the rate cap
        counts. One you declined or undid in time never did."""
        with self.lock:
            entries = self.loaded()
            withdrawn = {entry.get("request_id") for entry in entries if entry.get("kind") == "result" and entry.get("outcome") in ("declined", "undone")}
            return sum(
                1
                for entry in entries
                if entry.get("kind") == "request" and entry.get("allowed") and entry.get("site") == site and entry.get("tier") == tier
                and str(entry.get("at", "")) >= since.isoformat() and entry.get("request_id") not in withdrawn
            )

    def request(self, request_id: str) -> dict[str, object] | None:
        with self.lock:
            return next((entry for entry in reversed(self.loaded()) if entry.get("kind") == "request" and entry.get("request_id") == request_id), None)

    def outcome(self, request_id: str) -> str | None:
        with self.lock:
            return next((str(entry.get("outcome")) for entry in self.loaded() if entry.get("kind") == "result" and entry.get("request_id") == request_id), None)


def plain_url(url: str) -> bool:
    """A link an action may open: web, with no user or password in it, no backslash and no dot segment (plain or
    percent encoded) in its path, so the site it names is the site that opens."""
    try:
        parts = urlsplit(url)
        segments = [unquote(segment) for segment in parts.path.split("/")]
        return parts.scheme in ("http", "https") and bool(parts.hostname) and parts.username is None and parts.password is None and "\\" not in unquote(url) and not any(segment in (".", "..") for segment in segments)
    except ValueError:
        return False


def new_request_id() -> str:
    return uuid.uuid4().hex


def policy_flag(action: str) -> str:
    """The write flag a site's policy gives an action: undoing one is allowed when doing it is (unlike goes with like)."""
    undone = action.removeprefix("un")
    return undone if action.startswith("un") and undone in KINDS else action


def state_key(action: str) -> str:
    """Where an item keeps what you did to it: acted:like is yes once liked and no once unliked."""
    return f"acted:{policy_flag(action)}"
