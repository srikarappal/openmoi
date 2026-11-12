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


class EditionBook:
    """When each view last finished reading for an edition, kept in .moi/editions.json."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        stored = read_json(path, {})
        self.reads: dict[str, dict[str, str]] = stored if isinstance(stored, dict) else {}

    def read_done_at(self, view_id: str, edition_at: datetime) -> datetime | None:
        """When the read for this edition finished, if it did."""
        with self.lock:
            entry = self.reads.get(view_id)
        if not isinstance(entry, dict) or entry.get("edition") != edition_at.isoformat():
            return None
        try:
            return datetime.fromisoformat(entry["done_at"])
        except (KeyError, TypeError, ValueError):
            return None

    def done(self, view_id: str, edition_at: datetime, now: datetime) -> None:
        with self.lock:
            self.reads[view_id] = {"edition": edition_at.astimezone().isoformat(), "done_at": now.isoformat()}
            snapshot = dict(self.reads)
        write_atomic(self.path, json.dumps(snapshot, indent=2))

    def current(self, view_id: str, spec: TimeSpec, now: datetime) -> Edition | None:
        """The edition on show now; one read late includes everything that read found."""
        at, upcoming = latest_edition(spec, now), next_edition(spec, now)
        if at is None or upcoming is None:
            return None
        done_at = self.read_done_at(view_id, at)
        return Edition(at=at, cutoff=max(at, done_at) if done_at else at, next_at=upcoming)

    def due(self, view_id: str, spec: TimeSpec, now: datetime, lead: timedelta) -> datetime | None:
        """The edition whose read should run now: the next one once its lead time began, else a recent one never read."""
        upcoming, latest = next_edition(spec, now), latest_edition(spec, now)
        if upcoming and now >= upcoming - lead and self.read_done_at(view_id, upcoming) is None:
            return upcoming
        if latest and now - latest < LATE_READ and self.read_done_at(view_id, latest) is None:
            return latest
        return None

