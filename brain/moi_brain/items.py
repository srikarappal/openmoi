"""Item and event models plus normalization of raw records from any source."""

import hashlib
import ipaddress
import re
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import PurePosixPath
from typing import Any, Literal, get_args
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from pydantic import BaseModel, Field

ItemKind = Literal["post", "article", "video", "product", "link"]
EventKind = Literal["open", "seen", "less_like_this"]

ITEM_KINDS = set(get_args(ItemKind))
DEFAULT_KINDS: dict[str, ItemKind] = {"x": "post", "youtube": "video", "rss": "article", "site": "link"}
TRACKING_PARAMS = {"fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "ref_src", "si"}
HOST_NOISE = {"www", "feeds", "feed", "rss", "m"}
SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov"}
WHITESPACE = re.compile(r"\s+")
MAX_TEXT = 4000


class Item(BaseModel):
    item_id: str
    source_id: str
    native_id: str
    kind: ItemKind
    url: str
    title: str | None = None
    text: str | None = None
    author_name: str | None = None
    author_handle: str | None = None
    image_url: str | None = None
    media_kind: str | None = None
    published_at: datetime | None = None
    fetched_at: datetime
    topics: list[str] = Field(default_factory=list)
    tagged: bool = False
    available_actions: list[str] = Field(default_factory=list)
    extra: dict[str, str] = Field(default_factory=dict)


class ViewItem(BaseModel):
    item: Item
    reasons: list[str] = Field(default_factory=list)


class Event(BaseModel):
    view_id: str
    item_id: str | None = None
    event_kind: EventKind


def make_item_id(source_id: str, native_id: str) -> str:
    return hashlib.sha256(f"{source_id}:{native_id}".encode()).hexdigest()[:32]


def is_tracking(key: str) -> bool:
    return key.startswith("utm_") or key in TRACKING_PARAMS


def canonical_url(url: str, base_url: str | None = None) -> str:
    """Absolute URL without tracking parameters or fragment."""
    parts = urlparse(urljoin(base_url, url) if base_url else url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if not is_tracking(key)]
    return urlunparse(parts._replace(query=urlencode(query), fragment=""))


def is_local_host(hostname: str) -> bool:
    if hostname == "localhost":
        return True
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return True


def host_label(url: str) -> str:
    """The memorable part of a host: feeds.arstechnica.com becomes arstechnica.

    Feeds on a bare IP or localhost are named after their file instead: /rss/tech.xml becomes tech.
    """
    parts = urlparse(url)
    hostname = parts.hostname or ""
    if is_local_host(hostname):
        return PurePosixPath(parts.path).stem or "feed"
    labels = [label for label in hostname.split(".") if label and label not in HOST_NOISE]
    if len(labels) > 1:
        labels = labels[:-1]
    if len(labels) > 1 and labels[-1] in SECOND_LEVEL:
        labels = labels[:-1]
    return labels[-1] if labels else "feed"


def rss_source_id(feed_url: str) -> str:
    return f"rss:{host_label(feed_url)}"


def youtube_source_id(channel: str) -> str:
    return f"youtube:{channel.lstrip('@').lower()}"


def site_source_id(url: str) -> str:
    return f"site:{(urlparse(url).hostname or '').removeprefix('www.')}"


def source_family(source_id: str) -> str:
    return source_id.split(":", 1)[0]


def source_matches(source_id: str, wanted: str) -> bool:
    """Exact match, or a family match such as "youtube" for "youtube:veritasium"."""
    return source_id == wanted or source_id.startswith(f"{wanted}:")


def parse_time(value: Any) -> datetime | None:
    """ISO 8601, RFC 2822 or epoch seconds to an aware UTC datetime."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, (int, float)):
        moment = datetime.fromtimestamp(value, UTC)
    else:
        moment = parse_time_text(str(value).strip())
    if moment is None:
        return None
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def parse_time_text(text: str) -> datetime | None:
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        pass
    try:
        return parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None


def clean_text(value: Any, limit: int = MAX_TEXT) -> str | None:
    if value is None:
        return None
    text = WHITESPACE.sub(" ", str(value)).strip()
    return text[:limit] or None


def normalize(source_id: str, record: dict[str, Any], now: datetime, base_url: str | None = None) -> Item | None:
    """Turn one raw record into an Item; records without a URL or any words are dropped."""
    raw_url = clean_text(record.get("url"), 2000)
    title = clean_text(record.get("title"), 500)
    text = clean_text(record.get("text"))
    if not raw_url or not (title or text):
        return None
    url = canonical_url(raw_url, base_url)
    native_id = clean_text(record.get("native_id"), 500) or url
    kind = record.get("kind")
    image = clean_text(record.get("image_url"), 2000)
    handle = clean_text(record.get("author_handle"), 200)
    extra = {key.removeprefix("extra."): str(value) for key, value in record.items() if key.startswith("extra.") and value not in (None, "")}
    return Item(
        item_id=make_item_id(source_id, native_id),
        source_id=source_id,
        native_id=native_id,
        kind=kind if kind in ITEM_KINDS else DEFAULT_KINDS.get(source_family(source_id), "link"),
        url=url,
        title=title,
        text=text,
        author_name=clean_text(record.get("author_name"), 200),
        author_handle=handle.lstrip("@/").lower() if handle else None,
        image_url=urljoin(base_url, image) if image and base_url else image,
        media_kind=clean_text(record.get("media_kind"), 40) or ("image" if image else None),
        published_at=parse_time(record.get("published_at")),
        fetched_at=now,
        extra=extra,
    )
