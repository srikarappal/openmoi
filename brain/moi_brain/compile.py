"""Compile a view's .md file into the JSON the brain runs on every open.

Sources and layout are read deterministically. Rules in plain words are turned into
flat JSON by the fast model, cached by the hash of every file they depend on.
"""

import hashlib
import re
import threading
from typing import Literal

from pydantic import BaseModel, Field

from moi_brain.config import Paths
from moi_brain.feeds import CHANNEL_ID, read_takeout
from moi_brain.items import rss_source_id, youtube_source_id
from moi_brain.lenses import SITE_PREFIX
from moi_brain.md import bullets, parse_sections, section_text

VIEW_ID = re.compile(r"^[\w.]+$")
URL = re.compile(r"https?://[^\s,<>\"]+[^\s,<>\".;:)]")
HANDLE = re.compile(r"@[\w.-]+")
X_LINE = re.compile(r"^(x|twitter)\b", re.IGNORECASE)


class BadInput(ValueError):
    """A request named something that cannot exist, such as a view id with a slash."""


class Condition(BaseModel):
    field: Literal["source_id", "author_handle", "topic", "media_kind", "text", "age_hours"]
    op: Literal["eq", "in", "contains", "gt", "lt"]
    value: str | float | list[str]


class Rule(BaseModel):
    when: Condition
    unless: Condition | None = None
    do: Literal["hide", "boost", "limit"]
    weight: float = 0.0
    count_per_day: int | None = None


class SourceRef(BaseModel):
    source_id: Literal["x", "youtube", "rss"]
    page_type: str | None = None
    channels: list[str] = Field(default_factory=list)
    feeds: list[str] = Field(default_factory=list)


class CompiledView(BaseModel):
    view_id: str
    title: str
    file_hash: str
    sources: list[SourceRef] = Field(default_factory=list)
    rules: list[Rule] = Field(default_factory=list)
    layout: str = ""
    summary: str = ""
    warnings: list[str] = Field(default_factory=list)

    @property
    def layout_hash(self) -> str:
        return hashlib.sha256(self.layout.encode()).hexdigest()

    def source_ids(self) -> list[str]:
        ids = []
        for source in self.sources:
            if source.source_id == "x":
                ids.append("x")
            ids += [youtube_source_id(channel) for channel in source.channels]
            ids += [rss_source_id(feed) for feed in source.feeds]
        return list(dict.fromkeys(ids))


class ViewInfo(BaseModel):
    view_id: str
    title: str


def check_view_id(view_id: str) -> str:
    if not VIEW_ID.fullmatch(view_id):
        raise BadInput(f"bad view id: {view_id}")
    return view_id


def parse_sources(body: str, takeout_channels: list[str]) -> tuple[list[SourceRef], list[str]]:
    """Bullets such as 'X home timeline', 'YouTube: @a, @b', 'RSS: https://...' or a bare feed URL."""
    has_x, channels, feeds, warnings = False, [], [], []
    for line in bullets(body):
        label, _, rest = line.partition(":")
        key = label.strip().lower()
        if URL.fullmatch(line.strip()) or key == "rss":
            feeds += URL.findall(line)
        elif key == "youtube":
            found = takeout_channels if "subscriptions" in rest.lower() else HANDLE.findall(rest) + CHANNEL_ID.findall(rest)
            channels += found
            if not found:
                warnings.append(f"No YouTube channels found in: {line}")
        elif X_LINE.match(line):
            has_x = True
        else:
            warnings.append(f"Unknown source line: {line}")
    sources = [SourceRef(source_id="x", page_type="home_timeline")] if has_x else []
    if channels:
        sources.append(SourceRef(source_id="youtube", channels=list(dict.fromkeys(channels))))
    if feeds:
        sources.append(SourceRef(source_id="rss", feeds=list(dict.fromkeys(feeds))))
    return sources, warnings


def describe_sources(sources: list[SourceRef]) -> str:
    parts = []
    for source in sources:
        if source.source_id == "x":
            parts.append("X")
        if source.channels:
            parts.append(f"{len(source.channels)} YouTube channel{'s' if len(source.channels) != 1 else ''}")
        if source.feeds:
            parts.append(f"{len(source.feeds)} RSS feed{'s' if len(source.feeds) != 1 else ''}")
    if not parts:
        return "No sources yet."
    listed = parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"
    return f"Reading {listed}."


class Compiler:
    def __init__(self, paths: Paths):
        self.paths = paths
        self.lock = threading.Lock()

    def view_infos(self) -> list[ViewInfo]:
        """Views shown as tabs: every views/*.md except per site files, Feed first."""
        infos = []
        for path in sorted(self.paths.views.glob("*.md")):
            if not path.stem.startswith(SITE_PREFIX) and VIEW_ID.fullmatch(path.stem):
                title, _ = parse_sections(path.read_text())
                infos.append(ViewInfo(view_id=path.stem, title=title or path.stem))
        return [info for info in infos if info.view_id == "feed"] + [info for info in infos if info.view_id != "feed"]

    def view_text(self, view_id: str) -> str:
        path = self.paths.views / f"{check_view_id(view_id)}.md"
        return path.read_text() if path.exists() else ""

    def input_hash(self, view_text: str) -> str:
        takeout = self.paths.takeout.read_text() if self.paths.takeout.exists() else ""
        return hashlib.sha256(f"{view_text}\0{takeout}".encode()).hexdigest()

    def compiled(self, view_id: str) -> CompiledView:
        """The compiled view, recompiling only when one of its input files changed."""
        view_text = self.view_text(view_id)
        file_hash = self.input_hash(view_text)
        cache = self.paths.compiled / f"{view_id}.json"
        with self.lock:
            previous = CompiledView.model_validate_json(cache.read_text()) if cache.exists() else None
            if previous and previous.file_hash == file_hash:
                return previous
            compiled = self.compile(view_id, view_text, file_hash)
            cache.write_text(compiled.model_dump_json(indent=2))
        return compiled

    def compile(self, view_id: str, view_text: str, file_hash: str) -> CompiledView:
        title, sections = parse_sections(view_text)
        sources, warnings = parse_sources(section_text(sections, "sources"), read_takeout(self.paths.takeout))
        return CompiledView(
            view_id=view_id,
            title=title or view_id,
            file_hash=file_hash,
            sources=sources,
            layout=section_text(sections, "layout"),
            summary=describe_sources(sources),
            warnings=warnings,
        )
