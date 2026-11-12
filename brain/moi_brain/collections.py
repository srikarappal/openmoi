"""Collections: lists of items you keep, such as Read later and Watch later. An item you save stays (it never expires)
until you take it out; a view reads a collection with a "Collection: read later" source line, and a collection can be
exported as Markdown or JSON."""

import json
import re
from datetime import datetime

from moi_brain.items import Item

COLLECTION_PREFIX = "collection:"
READ_LATER = "read_later"
WATCH_LATER = "watch_later"
NAME = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MAX_EXPORT_TEXT = 2000


def collection_name(text: str) -> str:
    """Read later, read-later and READ_LATER are all read_later; an empty name is refused by the caller."""
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:40]


def collection_title(name: str) -> str:
    return name.replace("_", " ").capitalize()


def is_collection_name(name: str) -> bool:
    return bool(NAME.fullmatch(name))


def export_markdown(title: str, entries: list[tuple[Item, datetime]], now: datetime) -> str:
    """A list you can read anywhere: one entry per item with its link, source, date and the start of its text."""
    lines = [f"# {title}", "", f"Exported from openMoi on {now:%Y-%m-%d}, {len(entries)} items.", ""]
    for item, added_at in entries:
        heading = (item.title or item.text or item.url).replace("\n", " ").strip()[:200]
        lines.append(f"## [{heading}]({item.url})")
        lines.append("")
        details = [item.source_id, item.author_name or item.author_handle, f"saved {added_at:%Y-%m-%d}"]
        lines.append(" · ".join(part for part in details if part))
        if item.extra.get("summary"):
            lines += ["", f"Summary: {item.extra['summary']}"]
        if item.text and item.text != item.title:
            lines += ["", item.text.strip()[:MAX_EXPORT_TEXT]]
        lines.append("")
    return "\n".join(lines)


def export_json(title: str, entries: list[tuple[Item, datetime]], now: datetime) -> str:
    items = [{**json.loads(item.model_dump_json()), "saved_at": added_at.isoformat()} for item, added_at in entries]
    return json.dumps({"title": title, "exported_at": now.isoformat(), "items": items}, indent=2, ensure_ascii=False)
