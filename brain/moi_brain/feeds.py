"""Rung 1 sources: RSS and Atom feeds plus YouTube channel feeds, with the channel page as YouTube's fallback."""

import csv
import html
import json
import re
from calendar import timegm
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import feedparser
import httpx

from moi_brain.files import read_json, write_atomic

YOUTUBE_BASE = "https://www.youtube.com"
USER_AGENT = "openMoi/0.1 (feed reader)"
CHANNEL_ID = re.compile(r"UC[\w-]{22}")
CHANNEL_FEED_LINK = re.compile(r"feeds/videos\.xml\?channel_id=(UC[\w-]{22})")
CHANNEL_JSON = re.compile(r'"(?:externalId|channelId)":"(UC[\w-]{22})"')
TAG = re.compile(r"<[^>]+>")
IMG_SRC = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.IGNORECASE)
INITIAL_DATA = re.compile(r"var ytInitialData = (\{.*?\});</script>", re.DOTALL)
RELATIVE_AGE = re.compile(r"(\d+) (second|minute|hour|day|week|month|year)s? ago")
AGE_SECONDS = {"second": 1, "minute": 60, "hour": 3_600, "day": 86_400, "week": 604_800, "month": 2_592_000, "year": 31_536_000}


class FeedError(Exception):
    """A feed or channel could not be read."""


def strip_html(value: str) -> str:
    return html.unescape(TAG.sub(" ", value or "")).strip()


def entry_time(entry: Any) -> str | None:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    return datetime.fromtimestamp(timegm(parsed), UTC).isoformat() if parsed else None


def entry_image(entry: Any, summary: str) -> str | None:
    for thumbnail in entry.get("media_thumbnail", []):
        if thumbnail.get("url"):
            return thumbnail["url"]
    for media in entry.get("media_content", []):
        if media.get("url") and (media.get("medium") == "image" or str(media.get("type", "")).startswith("image/")):
            return media["url"]
    for link in entry.get("links", []):
        if link.get("rel") == "enclosure" and str(link.get("type", "")).startswith("image/"):
            return link.get("href")
    match = IMG_SRC.search(summary)
    return match.group(1) if match else None


def entry_record(entry: Any, kind: str) -> dict[str, Any]:
    summary = entry.get("summary", "")
    link = entry.get("link", "")
    record = {
        "native_id": entry.get("yt_videoid") or entry.get("id") or link,
        "url": link,
        "title": html.unescape(entry.get("title") or ""),
        "text": strip_html(summary),
        "author_name": entry.get("author"),
        "image_url": entry_image(entry, summary),
        "published_at": entry_time(entry),
        "kind": kind,
    }
    if kind == "video":
        record["media_kind"] = "short_video" if "/shorts/" in link else "long_video"
    return record


def nested(node: Any, key: str) -> Iterator[Any]:
    """Every value stored under key anywhere inside parsed JSON."""
    if isinstance(node, dict):
        for name, value in node.items():
            if name == key:
                yield value
            yield from nested(value, key)
    elif isinstance(node, list):
        for value in node:
            yield from nested(value, key)


def published_from_age(label: str, now: datetime) -> str | None:
    """'3 days ago' becomes a time about three days before now."""
    match = RELATIVE_AGE.search(label)
    if not match:
        return None
    try:
        return (now - timedelta(seconds=int(match.group(1)) * AGE_SECONDS[match.group(2)])).isoformat()
    except OverflowError:
        return None


def page_video(video_id: str, title: str, age: str, image_url: str | None, author: str | None, now: datetime) -> dict[str, Any]:
    return {
        "native_id": video_id,
        "url": f"{YOUTUBE_BASE}/watch?v={video_id}",
        "title": title,
        "text": "",
        "author_name": author,
        "image_url": image_url,
        "published_at": published_from_age(age, now),
        "kind": "video",
        "media_kind": "long_video",
    }


def lockup_video(lockup: dict[str, Any], author: str | None, now: datetime) -> dict[str, Any] | None:
    if lockup.get("contentType") != "LOCKUP_CONTENT_TYPE_VIDEO" or not lockup.get("contentId"):
        return None
    meta = lockup.get("metadata", {}).get("lockupMetadataViewModel", {})
    age = " ".join(str(label) for label in nested(meta.get("metadata", {}), "accessibilityLabel"))
    images = lockup.get("contentImage", {}).get("thumbnailViewModel", {}).get("image", {}).get("sources", [])
    image_url = images[-1].get("url") if images else None
    return page_video(lockup["contentId"], meta.get("title", {}).get("content", ""), age, image_url, author, now)


def renderer_video(renderer: dict[str, Any], author: str | None, now: datetime) -> dict[str, Any] | None:
    if not renderer.get("videoId"):
        return None
    title = "".join(run.get("text", "") for run in renderer.get("title", {}).get("runs", []))
    images = renderer.get("thumbnail", {}).get("thumbnails", [])
    image_url = images[-1].get("url") if images else None
    return page_video(renderer["videoId"], title, renderer.get("publishedTimeText", {}).get("simpleText", ""), image_url, author, now)


def channel_page_videos(page: str, now: datetime) -> list[dict[str, Any]]:
    """Uploads listed on a channel's videos page, in either of the two shapes YouTube serves."""
    match = INITIAL_DATA.search(page)
    if not match:
        return []
    try:
        data = json.loads(match.group(1))
    except ValueError:
        return []
    author = next((meta.get("title") for meta in nested(data, "channelMetadataRenderer") if isinstance(meta, dict)), None)
    author = author if isinstance(author, str) else None
    videos = [video_from(lockup_video, lockup, author, now) for lockup in nested(data, "lockupViewModel")]
    videos += [video_from(renderer_video, renderer, author, now) for renderer in nested(data, "videoRenderer")]
    return list({video["native_id"]: video for video in videos if video}.values())


def video_from(builder: Callable[[dict[str, Any], str | None, datetime], dict[str, Any] | None], node: Any, author: str | None, now: datetime) -> dict[str, Any] | None:
    """One video, or None when the page has something of another shape under that key."""
    if not isinstance(node, dict):
        return None
    try:
        return builder(node, author, now)
    except (AttributeError, TypeError, IndexError, KeyError):
        return None


def read_takeout(path: Path) -> list[str]:
    """Channel ids from a Google Takeout subscriptions.csv."""
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        return [row["Channel Id"].strip() for row in csv.DictReader(handle) if (row.get("Channel Id") or "").strip()]


class FeedFetcher:
    """Reads public feeds with conditional GET; resolved YouTube handles are cached on disk."""

    def __init__(self, http: httpx.Client, channel_cache: Path, youtube_base: str = YOUTUBE_BASE):
        self.http = http
        self.channel_cache = channel_cache
        self.youtube_base = youtube_base.rstrip("/")
        self.validators: dict[str, dict[str, str]] = {}
        # The entries of each feed's last good read: a 304 means the feed still lists exactly those.
        self.entries: dict[str, list[dict[str, Any]]] = {}
        self.channels: dict[str, str] = read_json(channel_cache, {})

    def fetch_rss(self, feed_url: str) -> list[dict[str, Any]]:
        return self.read_entries(feed_url, "article")

    def fetch_youtube(self, channel: str) -> list[dict[str, Any]]:
        is_id = bool(CHANNEL_ID.fullmatch(channel))
        channel_id = channel if is_id else self.resolve_channel(channel)
        try:
            records = self.read_entries(f"{self.youtube_base}/feeds/videos.xml?channel_id={channel_id}", "video")
        except FeedError as error:
            records = self.read_channel_page(channel_id, error)
        handle = None if is_id else channel.lstrip("@").lower()
        return [record | {"author_handle": handle} for record in records]

    def read_channel_page(self, channel_id: str, feed_error: FeedError) -> list[dict[str, Any]]:
        """YouTube's feed server goes down for hours at a time; the channel's videos page lists the same uploads."""
        try:
            page = self.get(f"{self.youtube_base}/channel/{channel_id}/videos", {"accept-language": "en"}) or b""
        except FeedError as error:
            raise FeedError(f"{feed_error}; the channel page failed too: {error}") from error
        videos = channel_page_videos(page.decode("utf-8", errors="replace"), datetime.now(UTC))
        if not videos:
            raise FeedError(f"{feed_error}; the channel page listed no videos")
        return videos

    def resolve_channel(self, handle: str) -> str:
        key = handle.lstrip("@").lower()
        if key in self.channels:
            return self.channels[key]
        try:
            page = self.get(f"{self.youtube_base}/@{key}", {}) or b""
        except FeedError as error:
            raise FeedError(f"YouTube channel @{key} could not be loaded: {error}") from error
        text = page.decode("utf-8", errors="replace")
        match = CHANNEL_FEED_LINK.search(text) or CHANNEL_JSON.search(text)
        if not match:
            raise FeedError(f"YouTube channel @{key} has no channel id on its page")
        self.channels[key] = match.group(1)
        write_atomic(self.channel_cache, json.dumps(self.channels, indent=2))
        return match.group(1)

    def read_entries(self, feed_url: str, kind: str) -> list[dict[str, Any]]:
        """Entries of a feed; a page that is not a feed (say a site's HTML after it moved) is an error, not an empty feed.

        Cache validators are kept only after a good parse, so a broken feed is not hidden behind a 304 next time."""
        known = self.validators.get(feed_url, {})
        headers = {"if-none-match": known.get("etag"), "if-modified-since": known.get("last_modified")}
        response = self.fetch(feed_url, {key: value for key, value in headers.items() if value})
        if response.status_code == 304:
            return self.entries.get(feed_url, [])
        parsed = feedparser.parse(response.content)
        if not parsed.entries and (parsed.bozo or not parsed.version):
            raise FeedError(f"{feed_url} is not a readable feed")
        validators = {"etag": response.headers.get("etag"), "last_modified": response.headers.get("last-modified")}
        self.validators[feed_url] = {key: value for key, value in validators.items() if value}
        self.entries[feed_url] = [entry_record(entry, kind) for entry in parsed.entries]
        return self.entries[feed_url]

    def get(self, url: str, headers: dict[str, str]) -> bytes | None:
        """Body of a 200 response, None for 304 Not Modified, FeedError otherwise."""
        response = self.fetch(url, headers)
        return None if response.status_code == 304 else response.content

    def fetch(self, url: str, headers: dict[str, str]) -> httpx.Response:
        """A 200 or 304 response; anything else, or no answer, is a FeedError."""
        try:
            response = self.http.get(url, headers={"user-agent": USER_AGENT, **headers})
        except httpx.HTTPError as error:
            raise FeedError(f"{url}: {error}") from error
        if response.status_code not in (200, 304):
            raise FeedError(f"{url} returned {response.status_code}")
        return response
