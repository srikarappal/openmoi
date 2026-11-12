"""The algorithm mirror: per source, what it showed you lately, how much your rules let through, how much came from
strangers or was judged angry, and how you used each view. Computed from what openMoi already stores, by today's rules."""

from datetime import datetime, timedelta
from operator import attrgetter

from pydantic import BaseModel, Field

from moi_brain.compile import CompiledView, Judgment
from moi_brain.items import JUDGED_PREFIX, Item
from moi_brain.rank import Circles, applies

MAX_DAYS = 30


class SourceMirror(BaseModel):
    source_id: str
    listed: int
    kept: int
    seen: int
    opened: int
    # Items with an author who is neither followed nor in your people file; None when no one is known on that site.
    strangers: int | None = None
    # For each yes or no judgment, how many items were judged yes.
    judged: dict[str, int] = Field(default_factory=dict)


class ViewMirror(BaseModel):
    view_id: str
    visits: int = 0
    extended: int = 0
    early: int = 0


class Mirror(BaseModel):
    days: int
    since: datetime
    sources: list[SourceMirror]
    views: list[ViewMirror]


def kept_by_some_view(item: Item, views: list[CompiledView], now: datetime, circles: Circles) -> bool:
    """An item counts as kept when at least one view that reads its source lets it through its hide rules."""
    readers = [view for view in views if item.source_id in view.source_ids()]
    return any(not any(rule.do == "hide" and applies(rule, item, now, circles) for rule in view.rules) for view in readers)


def build_mirror(
    days: int,
    now: datetime,
    entries: list[tuple[Item, datetime | None]],
    opened: set[str],
    views: list[CompiledView],
    judgments: list[Judgment],
    circles: Circles,
    moments: dict[str, dict[str, int]],
) -> Mirror:
    sources: dict[str, SourceMirror] = {}
    yes_no = [judgment.name for judgment in judgments if judgment.answer == "yes_no"]
    read = {source_id for view in views for source_id in view.source_ids()}
    for item, seen_at in entries:
        if item.source_id not in read:
            continue
        mirror = sources.setdefault(item.source_id, SourceMirror(source_id=item.source_id, listed=0, kept=0, seen=0, opened=0, judged={name: 0 for name in yes_no}))
        mirror.listed += 1
        mirror.kept += kept_by_some_view(item, views, now, circles)
        mirror.seen += seen_at is not None
        mirror.opened += item.item_id in opened
        if item.author_handle and not circles.empty:
            mirror.strangers = (mirror.strangers or 0) + ("stranger" in circles.groups(item))
        for name in yes_no:
            mirror.judged[name] += item.extra.get(f"{JUDGED_PREFIX}{name}") == "yes"
    used = [
        ViewMirror(view_id=view_id, visits=counts.get("visit", 0), extended=counts.get("extended", 0), early=counts.get("early", 0))
        for view_id, counts in sorted(moments.items())
    ]
    ordered = sorted(sorted(sources.values(), key=attrgetter("source_id")), key=attrgetter("listed"), reverse=True)
    return Mirror(days=days, since=now - timedelta(days=days), sources=ordered, views=used)
