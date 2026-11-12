"""Your own history from the data exports sites give you, read with no automation at all: Facebook's "Download your
information" (posts and events) and Amazon's order history. Each becomes records of a history source that views can
list like any other ("* History: facebook")."""

import csv
import hashlib
import io
import json
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import quote

ExportKind = Literal["facebook_posts", "facebook_events", "amazon_orders"]
SOURCE_IDS: dict[ExportKind, str] = {"facebook_posts": "history:facebook", "facebook_events": "history:facebook", "amazon_orders": "history:amazon"}
MAX_RECORDS = 5000


def fixed_text(value: object) -> str:
    """Facebook writes UTF-8 text as if each byte were a character; this undoes that, leaving correct text alone."""
    text = str(value or "")
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


def iso_time(seconds: object) -> str | None:
    try:
        return datetime.fromtimestamp(float(str(seconds)), UTC).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def short_id(*parts: object) -> str:
    return hashlib.sha256("\0".join(str(part) for part in parts).encode()).hexdigest()[:16]


def attachment_url(post: dict[str, Any]) -> str | None:
    for attachment in post.get("attachments", []) if isinstance(post.get("attachments"), list) else []:
        for data in attachment.get("data", []) if isinstance(attachment, dict) else []:
            url = data.get("external_context", {}).get("url") if isinstance(data, dict) else None
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                return url
    return None


def facebook_posts(payload: Any) -> list[dict[str, Any]]:
    """your_posts_1.json: a list of posts with a timestamp, the text under data and maybe a shared link."""
    records = []
    for post in payload if isinstance(payload, list) else []:
        if not isinstance(post, dict):
            continue
        text = " ".join(fixed_text(data.get("post")) for data in post.get("data", []) if isinstance(data, dict) and data.get("post")).strip()
        title = fixed_text(post.get("title"))
        if not (text or title):
            continue
        native_id = short_id(post.get("timestamp"), text, title)
        url = attachment_url(post) or f"https://www.facebook.com/me/allactivity?moi_post={native_id}"
        records.append({"native_id": native_id, "url": url, "title": title or None, "text": text or None, "published_at": iso_time(post.get("timestamp")), "kind": "post"})
    return records


def facebook_events(payload: Any) -> list[dict[str, Any]]:
    """your_events.json or event_invitations.json: events with a name, a start time and maybe a place."""
    if isinstance(payload, dict):
        payload = next((value for value in payload.values() if isinstance(value, list)), [])
    records = []
    for event in payload if isinstance(payload, list) else []:
        if not isinstance(event, dict) or not event.get("name"):
            continue
        name = fixed_text(event["name"])
        place = event.get("place", {}).get("name") if isinstance(event.get("place"), dict) else None
        native_id = short_id(name, event.get("start_timestamp"))
        records.append(
            {
                "native_id": native_id,
                "url": f"https://www.facebook.com/events/search/?q={quote(name)}",
                "title": name,
                "text": f"At {fixed_text(place)}" if place else None,
                "published_at": iso_time(event.get("start_timestamp")),
                "kind": "post",
            }
        )
    return records


def amazon_orders(text: str) -> list[dict[str, Any]]:
    """Retail.OrderHistory.1.csv: one row per product ordered, with its ASIN, name, price and date."""
    records = []
    for row in csv.DictReader(io.StringIO(text)):
        asin, name = (row.get("ASIN") or "").strip(), (row.get("Product Name") or "").strip()
        if not asin or not name:
            continue
        price = " ".join(part for part in ((row.get("Currency") or "").strip(), (row.get("Unit Price") or "").strip()) if part)
        record = {
            "native_id": f"{(row.get('Order ID') or '').strip()}:{asin}",
            "url": f"https://www.amazon.com/dp/{asin}",
            "title": name,
            "published_at": (row.get("Order Date") or "").strip() or None,
            "kind": "product",
        }
        if price:
            record["extra.price_text"] = price
        records.append(record)
    return records


def read_export(name: str, text: str) -> tuple[ExportKind, list[dict[str, Any]]] | None:
    """Which export a dropped file is, by its name and shape, with its records; None for anything else."""
    lowered = name.lower()
    if lowered.endswith(".csv") and "orderhistory" in lowered.replace("_", "").replace(".", ""):
        return "amazon_orders", amazon_orders(text)[:MAX_RECORDS]
    if not lowered.endswith(".json"):
        return None
    try:
        payload = json.loads(text)
    except ValueError:
        return None
    if "event" in lowered:
        return "facebook_events", facebook_events(payload)[:MAX_RECORDS]
    if "post" in lowered:
        return "facebook_posts", facebook_posts(payload)[:MAX_RECORDS]
    return None
