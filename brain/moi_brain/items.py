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
DEFAULT_KINDS: dict[str, ItemKind] = {"x": "post", "youtube": "video", "rss": "article", "site": "link", "page": "post", "watch": "link", "history": "post"}
TRACKING_PARAMS = {"fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "ref_src", "si"}
HOST_NOISE = {"www", "feeds", "feed", "rss", "m"}
WEB_SCHEMES = {"http", "https"}
SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov"}
WHITESPACE = re.compile(r"\s+")
MAX_TEXT = 4000
HANDLE = re.compile(r"@[\w.]*\w")
# Answers the tagging pass gives to the questions rules ask live in Item.extra under judged:<name>.
JUDGED_PREFIX = "judged:"


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
    # The value a group_by rule groups this item under; the lens heads each run of one group.
    group: str | None = None
    # A summarize_only rule matched: the card shows the summary in place of the item's own text.
    summary_only: bool = False


class Event(BaseModel):
    view_id: str
    item_id: str | None = None
    event_kind: EventKind


def make_item_id(source_id: str, native_id: str) -> str:
    return hashlib.sha256(f"{source_id}:{native_id}".encode()).hexdigest()[:32]


def is_tracking(key: str) -> bool:
    """utm_ tags, click ids and Facebook's __cft__ and __tn__ trails."""
    return key.startswith(("utm_", "__cft__", "__tn__")) or key in TRACKING_PARAMS


def canonical_url(url: str, base_url: str | None = None) -> str:
    """Absolute URL without tracking parameters or fragment."""
    parts = urlparse(urljoin(base_url, url) if base_url else url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if not is_tracking(key)]
    return urlunparse(parts._replace(query=urlencode(query), fragment=""))


def web_url(raw: str, base_url: str | None, keep_query: bool = False) -> str | None:
    """An absolute http(s) link (cleaned of tracking unless keep_query), or None for anything else or anything unparsable."""
    if not raw:
        return None
    try:
        url = urljoin(base_url, raw) if base_url else raw
        if urlparse(url).scheme.lower() not in WEB_SCHEMES:
            return None
        return url if keep_query else canonical_url(url)
    except ValueError:
        return None


def is_local_host(hostname: str) -> bool:
    if hostname == "localhost":
        return True
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return True


def is_private_host(hostname: str) -> bool:
    """localhost, or an address on this machine or a private network: never fetched for a shared link."""
    if hostname in ("localhost", "") or hostname.endswith(".local"):
        return True
    try:
        address = ipaddress.ip_address(hostname.strip("[]"))
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local or address.is_reserved


def host_label(url: str) -> str:
    """The memorable part of a host: feeds.arstechnica.com becomes arstechnica, alice.substack.com alice.substack.

    Noise like www and feeds goes, a meaningful subdomain stays, so two blogs on one platform get two names.
    Feeds on a bare IP or localhost are named after their file instead: /rss/tech.xml becomes tech.
    A URL too broken to parse is just "feed".
    """
    try:
        parts = urlparse(url)
        hostname = parts.hostname or ""
    except ValueError:
        return "feed"
    if is_local_host(hostname):
        return PurePosixPath(parts.path).stem or "feed"
    labels = [label for label in hostname.split(".") if label and label not in HOST_NOISE]
    if len(labels) > 1:
        labels = labels[:-1]
    if len(labels) > 1 and labels[-1] in SECOND_LEVEL:
        labels = labels[:-1]
    return ".".join(labels) if labels else "feed"


def rss_source_id(feed_url: str) -> str:
    return f"rss:{host_label(feed_url)}"


def page_source_id(url: str) -> str:
    """A page read as a feed: its host without www plus its path, so two pages of one site stay apart."""
    try:
        parts = urlparse(url)
    except ValueError:
        return "page:page"
    return f"page:{(parts.hostname or 'page').removeprefix('www.')}{parts.path.rstrip('/')}"


HOST_ALIASES = {"twitter.com": "x.com"}
HOST_PREFIXES = ("www.", "mobile.", "m.")
# First path parts of a profile link that are not handles.
NOT_HANDLES = {"i", "home", "explore", "settings", "search", "hashtag", "p", "reel", "reels", "stories", "watch", "pages"}
# Profile links that name the account in their second part: linkedin.com/in/maya, youtube.com/channel/UC..., /user/maya.
PROFILE_PREFIXES = {"in", "channel", "c", "user", "u", "company", "school", "people", "profile"}


def site_host(url: str) -> str:
    """The site a link belongs to, the same for www., mobile. and twitter.com links: x.com, instagram.com."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    for prefix in HOST_PREFIXES:
        host = host.removeprefix(prefix)
    return HOST_ALIASES.get(host, host)


def profile_handle(record: dict[str, Any], base_url: str | None) -> tuple[str, str] | None:
    """(site, handle) of an account in a following list: its handle field, else the first part of its profile link."""
    url = web_url(clean_text(record.get("url"), 2000) or "", base_url)
    if url is None:
        return None
    handle = clean_text(record.get("author_handle"), 200)
    if not handle:
        parts = [part for part in urlparse(url).path.split("/") if part]
        if parts and parts[0].lower() == "profile.php":
            handle = dict(parse_qsl(urlparse(url).query)).get("id")
        elif len(parts) > 1 and parts[0].lower() in PROFILE_PREFIXES:
            handle = parts[1]
        elif parts and parts[0].lower() not in NOT_HANDLES | PROFILE_PREFIXES:
            handle = parts[0]
    handle = handle.lstrip("@/").lower() if handle else ""
    return (site_host(url), handle) if handle else None


def watch_source_id(url: str) -> str:
    """A page watched for changes: named like a page source, so two watched pages of one site stay apart."""
    return f"watch:{page_source_id(url).removeprefix('page:')}"


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
        try:
            moment = datetime.fromtimestamp(value, UTC)
        except (OverflowError, OSError, ValueError):
            return None
    else:
        moment = parse_time_text(str(value).strip())
    if moment is None:
        return None
    try:
        return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)
    except OverflowError:
        return None


def parse_time_text(text: str) -> datetime | None:
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        pass
    try:
        return parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def clean_text(value: Any, limit: int = MAX_TEXT) -> str | None:
    if value is None:
        return None
    text = WHITESPACE.sub(" ", str(value)).strip()
    return text[:limit] or None


def normalize(source_id: str, record: dict[str, Any], now: datetime, base_url: str | None = None) -> Item | None:
    """Turn one raw record into an Item. Records without words, or without a web link, are dropped:
    a feed's javascript:, data: or file: link never becomes something you can click."""
    raw_url = clean_text(record.get("url"), 2000)
    title = clean_text(record.get("title"), 500)
    text = clean_text(record.get("text"))
    if not raw_url or not (title or text):
        return None
    url = web_url(raw_url, base_url)
    if url is None:
        return None
    native_id = clean_text(record.get("native_id"), 500) or url
    kind = record.get("kind")
    image = web_url(clean_text(record.get("image_url"), 2000) or "", base_url, keep_query=True)
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
        image_url=image,
        media_kind=clean_text(record.get("media_kind"), 40) or ("image" if image else None),
        published_at=parse_time(record.get("published_at")),
        fetched_at=now,
        extra=extra,
    )
