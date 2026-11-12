"""Apps on this Mac (L8), read through moi_mac_helper, never clicked or typed into.

The helper answers one command per run with JSON. Calendar comes through EventKit; Mail and Notes through Apple Events
(JXA); Files from folders a view opts into. Each needs its own macOS permission, asked only when you say /allow, one
at a time; a source whose permission is missing reads nothing and its view says how to allow it. Nothing here writes
to an app.

Mail gives two sources: newsletters (messages with a List-Unsubscribe header) to read, and order confirmations, which
count as your own shopping history like an export.
"""

import json
import os
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from moi_brain.compile import AppName, AppRef
from moi_brain.config import REPO_DIR
from moi_brain.shop import parse_price

Capability = Literal["calendar", "mail", "notes"]
HELPER_TIMEOUT = 30
DEFAULT_HELPER = REPO_DIR / "helper" / "build" / "moi_mac_helper"
MAIL_DAYS = 14
ORDER_DAYS = 90
MAX_FILE_TEXT = 4000
TEXT_FILES = (".txt", ".md", ".markdown")
LINK = re.compile(r"https://[^\s<>\"')\]]+")
ORDER_SUBJECT = re.compile(r"\b(your order|order confirm\w*|order #|order number|has shipped|your receipt|purchase confirm\w*)\b", re.IGNORECASE)
# The text a newsletter's web copy link usually has nearby; the first link is the fallback.
WEB_COPY = re.compile(r"(view (it |this )?(in|on) (your |a )?(web )?browser|view online|read online|web version)", re.IGNORECASE)
WHY = {
    "calendar": "to show today's meetings in your views. It reads events only and never changes them.",
    "mail": "to read newsletters and order confirmations from your inbox. It reads messages only and never sends or moves one.",
    "notes": "to show your notes in a view. It reads them only and never changes them.",
}


class AppError(Exception):
    """The helper could not read an app: no permission yet, the app or helper unavailable, or a bad request."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def helper_path() -> Path:
    return Path(os.environ.get("MOI_MAC_HELPER", DEFAULT_HELPER)).expanduser()


def app_url(app: AppName, native_id: str) -> str:
    return f"moi-app://{app}/{quote(native_id, safe='')[:600]}"


class MacHelper:
    """Runs the helper, one command per call."""

    def __init__(self, path: Path | None = None):
        self.path = path or helper_path()

    def run(self, command: str, args: dict[str, Any]) -> Any:
        if not self.path.exists():
            raise AppError("unavailable", "the Mac helper is not built yet: run helper/build.sh")
        try:
            done = subprocess.run([str(self.path), command], input=json.dumps(args), capture_output=True, text=True, timeout=HELPER_TIMEOUT, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise AppError("unavailable", f"the Mac helper did not answer: {error}") from error
        try:
            reply = json.loads(done.stdout)
        except ValueError as error:
            raise AppError("unavailable", f"the Mac helper answered something that is not JSON: {done.stdout[:200]}") from error
        if not isinstance(reply, dict) or not reply.get("ok"):
            raise AppError(str(reply.get("kind", "unavailable")) if isinstance(reply, dict) else "unavailable", str(reply.get("error", "")) if isinstance(reply, dict) else "")
        return reply.get("data")

    def status(self) -> dict[str, str]:
        found = self.run("status", {})
        return {str(name): str(value) for name, value in found.items()} if isinstance(found, dict) else {}

    def allow(self, capability: Capability) -> str:
        found = self.run("request", {"capability": capability})
        return str(found.get(capability, "unavailable")) if isinstance(found, dict) else "unavailable"


def local_when(start: datetime, end: datetime, all_day: bool) -> str:
    """When an event is, as your clock shows it: "10:00 to 10:30", or "all day"."""
    if all_day:
        return "all day"
    return f"{start.astimezone():%H:%M} to {end.astimezone():%H:%M}"


def calendar_records(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records = []
    for event in events:
        start, end = datetime.fromisoformat(event["start"]), datetime.fromisoformat(event["end"])
        attendees = [person for person in event.get("attendees", []) if isinstance(person, dict)]
        records.append({
            "native_id": event["id"],
            "url": app_url("calendar", event["id"]),
            "title": event.get("title") or "Busy",
            "text": " ".join(part for part in (event.get("location", ""), event.get("notes", "")[:500]) if part),
            "published_at": start.isoformat(),
            "kind": "post",
            "extra.when": local_when(start, end, bool(event.get("all_day"))),
            "extra.end": end.isoformat(),
            "extra.location": event.get("location", ""),
            "extra.calendar": event.get("calendar", ""),
            "extra.attendees": json.dumps([{"name": person.get("name", ""), "email": person.get("email", "")} for person in attendees]) if attendees else "",
        })
    return records


def sender_parts(sender: str) -> tuple[str, str]:
    """("Name", "address") from "Name <address>" or a bare address."""
    match = re.match(r"\s*\"?([^\"<]*)\"?\s*<([^>]+)>", sender)
    if match:
        return match.group(1).strip(), match.group(2).strip().lower()
    return "", sender.strip().lower()


def web_copy(body: str) -> str | None:
    """A newsletter's web copy, or an order's page: the link after "view in browser", else its first link."""
    marker = WEB_COPY.search(body)
    after = LINK.search(body, marker.end()) if marker else None
    found = after or LINK.search(body)
    return found.group(0) if found else None


def mail_records(messages: list[dict[str, Any]], orders: bool) -> list[dict[str, Any]]:
    """Newsletters (they carry a List-Unsubscribe header) as articles, or order confirmations as products."""
    records = []
    for message in messages:
        subject, body = message.get("subject", ""), message.get("body", "")
        is_order = bool(ORDER_SUBJECT.search(subject))
        if orders != is_order or (not orders and not message.get("unsubscribe")):
            continue
        name, address = sender_parts(message.get("sender", ""))
        price = parse_price(body)
        records.append({
            "native_id": message["id"],
            "url": web_copy(body) or app_url("mail", message["id"]),
            "title": subject,
            "text": body,
            "author_name": name or address,
            "author_handle": address,
            "published_at": message.get("date"),
            "kind": "product" if orders else "article",
            "extra.site": address.rpartition("@")[2],
            "extra.price_text": price.text() if orders and price else "",
        })
    return records


def notes_records(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"native_id": note["id"], "url": app_url("notes", note["id"]), "title": note.get("title", ""), "text": note.get("body", ""), "published_at": note.get("modified"), "kind": "article"}
        for note in notes
    ]


def file_text(path: Path) -> str:
    if path.suffix.lower() not in TEXT_FILES:
        return ""
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            return handle.read(MAX_FILE_TEXT)
    except OSError:
        return ""


def file_records(files: list[dict[str, Any]], folders: list[str]) -> list[dict[str, Any]]:
    """Files from opted in folders (only those, whatever the helper said), with the text of plain text files."""
    records = []
    for entry in files:
        path = Path(str(entry.get("path", "")))
        if not any(path.is_relative_to(folder) for folder in folders):
            continue
        records.append({
            "native_id": str(path),
            "url": app_url("files", str(path)),
            "title": path.name,
            "text": file_text(path),
            "published_at": entry.get("modified"),
            "kind": "link",
            "extra.folder": str(path.parent),
        })
    return records


def read_app(helper: MacHelper, ref: AppRef, now: datetime) -> list[dict[str, Any]]:
    """The records an app source has now: Calendar from the start of today, Mail since a while back, Notes, Files."""
    if ref.app == "calendar":
        today = now.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        return calendar_records(helper.run("calendar", {"from": today.isoformat(timespec="seconds"), "to": (today + timedelta(days=ref.days)).isoformat(timespec="seconds")}))
    if ref.app == "mail":
        orders = ref.what == "orders"
        since = now - timedelta(days=ORDER_DAYS if orders else MAIL_DAYS)
        return mail_records(helper.run("mail", {"since": since.isoformat(timespec="seconds"), "limit": 100}), orders)
    if ref.app == "notes":
        return notes_records(helper.run("notes", {"limit": 50}))
    return file_records(helper.run("files", {"folders": ref.folders, "limit": 100}), ref.folders)


def permission_text(app: str, kind: str, message: str) -> str:
    """What a view says about an app it cannot read."""
    if kind == "permission":
        return f"needs your permission: say /allow {app}. openMoi would read it {WHY.get(app, '')}".strip()
    if app in ("mail", "notes") and "not_running" in message:
        return f"open {app.title()} once, then say /allow {app}"
    return message or "could not be read"
