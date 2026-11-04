"""Rung 1 sources: RSS and Atom feeds plus YouTube channel feeds."""

import csv
import html
import json
import re
from calendar import timegm
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import feedparser
import httpx

YOUTUBE_BASE = "https://www.youtube.com"
USER_AGENT = "openMoi/0.1 (feed reader)"
CHANNEL_ID = re.compile(r"UC[\w-]{22}")
CHANNEL_FEED_LINK = re.compile(r"feeds/videos\.xml\?channel_id=(UC[\w-]{22})")
CHANNEL_JSON = re.compile(r'"(?:externalId|channelId)":"(UC[\w-]{22})"')
TAG = re.compile(r"<[^>]+>")
IMG_SRC = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.IGNORECASE)


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
        if media.get("medium") == "image" or str(media.get("type", "")).startswith("image/"):
            return media.get("url")
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
        self.channels: dict[str, str] = json.loads(channel_cache.read_text()) if channel_cache.exists() else {}

    def fetch_rss(self, feed_url: str) -> list[dict[str, Any]]:
        return self.read_entries(feed_url, "article")

    def fetch_youtube(self, channel: str) -> list[dict[str, Any]]:
        is_id = bool(CHANNEL_ID.fullmatch(channel))
        channel_id = channel if is_id else self.resolve_channel(channel)
        records = self.read_entries(f"{self.youtube_base}/feeds/videos.xml?channel_id={channel_id}", "video")
        handle = None if is_id else channel.lstrip("@").lower()
        return [record | {"author_handle": handle} for record in records]

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
        self.channel_cache.write_text(json.dumps(self.channels, indent=2))
        return match.group(1)

    def read_entries(self, feed_url: str, kind: str) -> list[dict[str, Any]]:
        known = self.validators.get(feed_url, {})
        headers = {"if-none-match": known.get("etag"), "if-modified-since": known.get("last_modified")}
        body = self.get(feed_url, {key: value for key, value in headers.items() if value})
        if body is None:
            return []
        parsed = feedparser.parse(body)
        if parsed.bozo and not parsed.entries:
            raise FeedError(f"{feed_url} is not a readable feed")
        return [entry_record(entry, kind) for entry in parsed.entries]

    def get(self, url: str, headers: dict[str, str]) -> bytes | None:
        """Body of a 200 response, None for 304 Not Modified, FeedError otherwise."""
        try:
            response = self.http.get(url, headers={"user-agent": USER_AGENT, **headers})
        except httpx.HTTPError as error:
            raise FeedError(f"{url}: {error}") from error
        if response.status_code == 304:
            return None
        if response.status_code != 200:
            raise FeedError(f"{url} returned {response.status_code}")
        validators = {"etag": response.headers.get("etag"), "last_modified": response.headers.get("last-modified")}
        self.validators[url] = {key: value for key, value in validators.items() if value}
        return response.content
