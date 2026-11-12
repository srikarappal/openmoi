"""Watched pages: the text of a page compared with its last look. A change becomes one item holding what was added and
removed, so a view's rules decide whether it matters; noise such as "3 minutes ago" is not a change."""

import re
from datetime import datetime

from moi_brain.items import Item, clean_text, make_item_id, site_host

RELATIVE_TIME = re.compile(r"\b\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\s+ago\b|\bjust now\b", re.IGNORECASE)
MAX_WATCH_TEXT = 20_000
MAX_CHANGE_TEXT = 1_500


def watch_lines(text: str) -> list[str]:
    """The page's lines with spacing collapsed and relative times taken out, so only real changes differ."""
    lines = (" ".join(RELATIVE_TIME.sub("", line).split()) for line in text[:MAX_WATCH_TEXT].splitlines())
    return [line for line in lines if line]


def changed_lines(before: list[str], after: list[str]) -> tuple[list[str], list[str]]:
    """Lines added and lines removed, each in page order."""
    old, new = set(before), set(after)
    return [line for line in after if line not in old], [line for line in before if line not in new]


def change_item(source_id: str, url: str, title: str, added: list[str], removed: list[str], now: datetime) -> Item:
    parts = [f"Added: {' | '.join(added)}" if added else "", f"Removed: {' | '.join(removed)}" if removed else ""]
    text = clean_text("\n".join(part for part in parts if part), MAX_CHANGE_TEXT) or "The page changed."
    native_id = f"{url}@{now.isoformat()}"
    return Item(
        item_id=make_item_id(source_id, native_id),
        source_id=source_id,
        native_id=native_id,
        kind="link",
        url=url,
        title=f"{clean_text(title, 200) or site_host(url)} changed",
        text=text,
        published_at=now,
        fetched_at=now,
    )
