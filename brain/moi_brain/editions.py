"""Editions: a view with edition times shows what was read by its latest edition, so its feed has a last item.

Reading for an edition starts a little before it is due (longer when a slow local model has to tag what was read),
so the edition is ready on time. A read the Mac slept through runs late, and the edition then includes it.
"""

import json
import threading
from datetime import datetime, time, timedelta
from pathlib import Path

from pydantic import BaseModel

from moi_brain.compile import TimeSpec
from moi_brain.files import read_json, write_atomic

LEAD = timedelta(minutes=20)
LOCAL_LEAD = timedelta(minutes=60)
# An edition whose read never happened (the Mac was asleep) is still read this long after it was due.
LATE_READ = timedelta(hours=12)
KEEP_EDITIONS = timedelta(days=3)


class Edition(BaseModel):
    at: datetime  # when it came out
    cutoff: datetime  # items read by then are in it
    next_at: datetime


def edition_moments(spec: TimeSpec, now: datetime) -> list[datetime]:
    """Every edition from yesterday to tomorrow on your clock, in order."""
    local = now.astimezone()
    moments = []
    for days in (-1, 0, 1):
        day = local.date() + timedelta(days=days)
        for clock in spec.editions:
            hour, minute = (int(part) for part in clock.split(":"))
            moments.append(datetime.combine(day, time(hour, minute)).astimezone())
    return sorted(moments)


def latest_edition(spec: TimeSpec, now: datetime) -> datetime | None:
    past = [moment for moment in edition_moments(spec, now) if moment <= now]
    return past[-1] if past else None


def next_edition(spec: TimeSpec, now: datetime) -> datetime | None:
    return next((moment for moment in edition_moments(spec, now) if moment > now), None)


def moment_of(value: object) -> datetime | None:
    try:
        return datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def editions_of(entry: object) -> dict[str, dict[str, str]]:
    """A view's entries per edition; a file from before kept one entry per view, which is read into this shape."""
    if not isinstance(entry, dict):
        return {}
    if "edition" in entry or "early_for" in entry:
        found: dict[str, dict[str, str]] = {}
        if isinstance(entry.get("edition"), str) and isinstance(entry.get("done_at"), str):
            found.setdefault(entry["edition"], {})["done_at"] = entry["done_at"]
        if isinstance(entry.get("early_for"), str) and isinstance(entry.get("early"), str):
            found.setdefault(entry["early_for"], {})["early"] = entry["early"]
        return found
    return {key: value for key, value in entry.items() if isinstance(value, dict)}


class EditionBook:
    """Per view and per edition, when its read finished and when you opened it early, kept in .moi/editions.json.
    Entries older than a few days are dropped."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        stored = read_json(path, {})
        self.reads: dict[str, dict[str, dict[str, str]]] = {view_id: editions_of(entry) for view_id, entry in stored.items()} if isinstance(stored, dict) else {}

    def moment(self, view_id: str, edition_at: datetime, key: str) -> datetime | None:
        with self.lock:
            entry = self.reads.get(view_id, {}).get(edition_at.astimezone().isoformat(), {})
        return moment_of(entry.get(key))

    def note(self, view_id: str, edition_at: datetime, key: str, now: datetime) -> None:
        with self.lock:
            editions = self.reads.setdefault(view_id, {})
            editions.setdefault(edition_at.astimezone().isoformat(), {})[key] = now.isoformat()
            oldest = now - KEEP_EDITIONS
            self.reads[view_id] = {name: entry for name, entry in editions.items() if (moment_of(name) or now) >= oldest}
            write_atomic(self.path, json.dumps(self.reads, indent=2))

    def read_done_at(self, view_id: str, edition_at: datetime) -> datetime | None:
        """When the read for this edition finished, if it did."""
        return self.moment(view_id, edition_at, "done_at")

    def done(self, view_id: str, edition_at: datetime, now: datetime) -> None:
        self.note(view_id, edition_at, "done_at", now)

    def opened_early_at(self, view_id: str, edition_at: datetime) -> datetime | None:
        return self.moment(view_id, edition_at, "early")

    def open_early(self, view_id: str, edition_at: datetime, now: datetime) -> None:
        """You chose to see what arrived since this edition came out, without waiting for the next one."""
        self.note(view_id, edition_at, "early", now)

    def current(self, view_id: str, spec: TimeSpec, now: datetime) -> Edition | None:
        """The edition on show now; one read late includes everything that read found, one you opened early what came since."""
        at, upcoming = latest_edition(spec, now), next_edition(spec, now)
        if at is None or upcoming is None:
            return None
        cutoff = max([at, *(moment for moment in (self.read_done_at(view_id, at), self.opened_early_at(view_id, at)) if moment)])
        return Edition(at=at, cutoff=cutoff, next_at=upcoming)

    def due(self, view_id: str, spec: TimeSpec, now: datetime, lead: timedelta) -> datetime | None:
        """The edition whose read should run now: the next one once its lead time began, else a recent one never read."""
        upcoming, latest = next_edition(spec, now), latest_edition(spec, now)
        if upcoming and now >= upcoming - lead and self.read_done_at(view_id, upcoming) is None:
            return upcoming
        if latest and now - latest < LATE_READ and self.read_done_at(view_id, latest) is None:
            return latest
        return None

