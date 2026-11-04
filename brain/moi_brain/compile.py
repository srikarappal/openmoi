"""Compile a view's .md file into the JSON the brain runs on every open.

Sources and layout are read deterministically. Rules in plain words are turned into
flat JSON by the fast model, cached by the hash of every file they depend on.
"""

import hashlib
import json
import re
import threading
import time
from typing import Literal

from pydantic import BaseModel, Field

from moi_brain.config import Paths
from moi_brain.feeds import CHANNEL_ID, read_takeout
from moi_brain.items import rss_source_id, youtube_source_id
from moi_brain.lenses import SITE_PREFIX
from moi_brain.llm import Gateway, LlmError
from moi_brain.md import bullets, parse_sections, section_text
from moi_brain.memory import Memory

VIEW_ID = re.compile(r"^[\w.]+$")
URL = re.compile(r"https?://[^\s,<>\"]+[^\s,<>\".;:)]")
HANDLE = re.compile(r"@[\w.-]+")
X_LINE = re.compile(r"^(x|twitter)\b", re.IGNORECASE)
DEFAULT_BOOST = 3.0
RETRY_AFTER_SECONDS = 60.0
RULES_PROMPT = """You turn rules written in plain words into JSON for openMoi, a personal feed reader.
Reply with one JSON object: {"rules": [<rule>, ...], "summary": "<one short sentence>"}.

A rule is {"when": <condition>, "unless": <condition or null>, "do": "hide" | "boost" | "limit", "weight": <number>, "count_per_day": <integer or null>}.
A condition is {"field": <field>, "op": "eq" | "in" | "contains" | "gt" | "lt", "value": <string, number or list of strings>}.
Fields:
* source_id: where an item comes from. Use one of the given sources, or "x", "youtube" or "rss" for a whole family.
* author_handle: a handle without @, such as maya.
* topic: one short lowercase word such as politics, crypto or sports. Items are tagged with every topic you use.
* media_kind: image, short_video, long_video or video. Shorts and reels are short_video.
* text: words in the title or text; use op contains.
* age_hours: hours since publishing; use gt or lt.

"hide", "no" and "never" mean do hide. "first" or "always show" mean boost with weight 10; "more of" means boost with weight 3.
"at most N a day" means limit with count_per_day N.
"unless" or "except" becomes the unless condition.
view_rules apply to this view. likes are boosts with weight 3 on that topic, author or source; dislikes are hides.
Skip lines that are not rules. The summary describes every rule in plain words."""


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
        return source_ids(self.sources)


class RulesDraft(BaseModel):
    rules: list[Rule] = Field(default_factory=list)
    summary: str = ""


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


def source_ids(sources: list[SourceRef]) -> list[str]:
    ids = []
    for source in sources:
        if source.source_id == "x":
            ids.append("x")
        ids += [youtube_source_id(channel) for channel in source.channels]
        ids += [rss_source_id(feed) for feed in source.feeds]
    return list(dict.fromkeys(ids))


def usable_rules(rules: list[Rule]) -> list[Rule]:
    """Rules that can run: a boost without a weight gets the default, a limit without a count is dropped."""
    usable = []
    for rule in rules:
        if rule.do == "limit" and not rule.count_per_day:
            continue
        usable.append(rule.model_copy(update={"weight": rule.weight or DEFAULT_BOOST}) if rule.do == "boost" else rule)
    return usable


def rules_prompt(rules_text: str, likes: str, dislikes: str, sources: list[str]) -> list[dict[str, str]]:
    payload = {"view_rules": bullets(rules_text), "likes": bullets(likes), "dislikes": bullets(dislikes), "sources": sources}
    return [{"role": "system", "content": RULES_PROMPT}, {"role": "user", "content": json.dumps(payload)}]


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
    """Caches compiled views by the hash of every file they read; a failed rules compile retries after a minute."""

    def __init__(self, paths: Paths, gateway: Gateway, memory: Memory):
        self.paths = paths
        self.gateway = gateway
        self.memory = memory
        self.lock = threading.Lock()
        self.failures: dict[str, tuple[str, float, CompiledView]] = {}

    def view_ids(self) -> list[str]:
        return [path.stem for path in sorted(self.paths.views.glob("*.md")) if VIEW_ID.fullmatch(path.stem)]

    def view_infos(self) -> list[ViewInfo]:
        """Views shown as tabs: every views/*.md except per site files, Feed first."""
        infos = []
        for view_id in self.view_ids():
            if not view_id.startswith(SITE_PREFIX):
                title, _ = parse_sections(self.view_text(view_id))
                infos.append(ViewInfo(view_id=view_id, title=title or view_id))
        return [info for info in infos if info.view_id == "feed"] + [info for info in infos if info.view_id != "feed"]

    def all_compiled(self) -> list[CompiledView]:
        return [self.compiled(view_id) for view_id in self.view_ids()]

    def view_text(self, view_id: str) -> str:
        path = self.paths.views / f"{check_view_id(view_id)}.md"
        return path.read_text() if path.exists() else ""

    def input_hash(self, view_text: str) -> str:
        takeout = self.paths.takeout.read_text() if self.paths.takeout.exists() else ""
        parts = [view_text, takeout, self.memory.likes(), self.memory.dislikes()]
        return hashlib.sha256("\0".join(parts).encode()).hexdigest()

    def compiled(self, view_id: str) -> CompiledView:
        """The compiled view, recompiling only when one of its input files changed."""
        view_text = self.view_text(view_id)
        file_hash = self.input_hash(view_text)
        cache = self.paths.compiled / f"{view_id}.json"
        with self.lock:
            previous = CompiledView.model_validate_json(cache.read_text()) if cache.exists() else None
            if previous and previous.file_hash == file_hash:
                return previous
            failure = self.failures.get(view_id)
            if failure and failure[0] == file_hash and time.monotonic() - failure[1] < RETRY_AFTER_SECONDS:
                return failure[2]
            compiled, succeeded = self.compile(view_id, view_text, file_hash, previous)
            if succeeded:
                cache.write_text(compiled.model_dump_json(indent=2))
                self.failures.pop(view_id, None)
            else:
                self.failures[view_id] = (file_hash, time.monotonic(), compiled)
        return compiled

    def compile(self, view_id: str, view_text: str, file_hash: str, previous: CompiledView | None) -> tuple[CompiledView, bool]:
        title, sections = parse_sections(view_text)
        sources, warnings = parse_sources(section_text(sections, "sources"), read_takeout(self.paths.takeout))
        try:
            rules, rules_summary = self.compile_rules(section_text(sections, "rules"), sources)
            succeeded = True
        except LlmError as error:
            rules, rules_summary, succeeded = (previous.rules if previous else []), "", False
            warnings.append(f"Rules not updated: {error}")
        compiled = CompiledView(
            view_id=view_id,
            title=title or view_id,
            file_hash=file_hash,
            sources=sources,
            rules=rules,
            layout=section_text(sections, "layout"),
            summary=" ".join(part for part in (describe_sources(sources), rules_summary) if part),
            warnings=warnings,
        )
        return compiled, succeeded

    def compile_rules(self, rules_text: str, sources: list[SourceRef]) -> tuple[list[Rule], str]:
        likes, dislikes = self.memory.likes(), self.memory.dislikes()
        if not (bullets(rules_text) or bullets(likes) or bullets(dislikes)):
            return [], ""
        prompt = rules_prompt(rules_text, likes, dislikes, source_ids(sources))
        draft = self.gateway.complete_json("fast", "compile_rules", prompt, True, RulesDraft)
        return usable_rules(draft.rules), draft.summary.strip()
