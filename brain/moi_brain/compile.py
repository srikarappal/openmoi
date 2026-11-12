"""Compile a view's .md file into the JSON the brain runs on every open.

Sources and layout are read deterministically. Rules in plain words are turned into
flat JSON by the fast model, cached by the hash of every file they depend on.
"""

import hashlib
import json
import re
import threading
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from moi_brain.config import Paths
from moi_brain.feeds import CHANNEL_ID, read_takeout
from moi_brain.files import read_text, write_atomic
from moi_brain.items import JUDGED_PREFIX, page_source_id, rss_source_id, watch_source_id, youtube_source_id
from moi_brain.lenses import SITE_PREFIX
from moi_brain.llm import Gateway, LlmError
from moi_brain.md import bullets, parse_sections, section_text
from moi_brain.memory import Memory

VIEW_ID = re.compile(r"^[\w.-]+$")
# Bump when compiled views change meaning, so caches from an older openMoi are compiled again.
COMPILER_VERSION = "11"
URL = re.compile(r"https?://[^\s,<>\"]+[^\s,<>\".;:)]")
HANDLE = re.compile(r"@[\w.-]*\w")
# A page whose posts come newest first (a Following tab, a chronological list) can be read until it reaches what was read before.
NEWEST_FIRST = re.compile(r"newest first|chronological|in order", re.IGNORECASE)
# "(assist)" reads a page only while you browse it yourself; "(pilot)" lets a reader tab read it.
READ_MODE = re.compile(r"\b(assist|pilot)\b", re.IGNORECASE)
X_LINE = re.compile(r"^(x|twitter)\b", re.IGNORECASE)
DEFAULT_BOOST = 3.0
FIXED_FIELDS = ("source_id", "author_handle", "author_in", "topic", "media_kind", "text", "age_hours")
JUDGMENT_NAME = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MAX_QUESTION = 200
CLOCK = re.compile(r"\b(\d{1,2}):(\d{2})\s*([ap])\.?m\b\.?|\b(\d{1,2}):(\d{2})\b|\b(\d{1,2})\s*([ap])\.?m\b\.?|\b(noon|midnight)\b")
EDITION_COUNT = re.compile(r"\b(\d+)\s+(?:items|posts|stories|things|cards)\b")
DURATION = re.compile(r"\b(\d+)\s*(minutes?|mins?|hours?|hrs?)\b")
MAX_EDITION_SIZE = 500
# A watched page is looked at this often unless its line says otherwise, and never more often than every five minutes.
WATCH_EVERY_MINUTES = 60
MIN_WATCH_MINUTES = 5
EVERY = re.compile(r"\bevery\s+(\d+)?\s*(minutes?|mins?|hours?|hrs?|days?)\b", re.IGNORECASE)
MAX_VISIT_MINUTES = 600
RETRY_AFTER_SECONDS = 60.0
RULES_PROMPT = """You turn rules written in plain words into JSON for openMoi, a personal feed reader.
Reply with one JSON object: {"rules": [<rule>, ...], "judgments": [<judgment>, ...], "summary": "<one short sentence>"}.

A rule is {"when": <condition>, "unless": <condition or null>, "do": "hide" | "boost" | "limit" | "summarize" | "note", "weight": <number>, "count_per_day": <integer or null>}.
A condition is {"field": <field>, "op": "eq" | "in" | "contains" | "gt" | "lt", "value": <string, number or list of strings>}.
Fields:
* source_id: where an item comes from. Use one of the given sources, or "x", "youtube" or "rss" for a whole family.
* author_handle: a handle without @, such as maya.
* author_in: who the author is to the person: "people" (named in their people file), "following" (an account they follow),
  "known" (either) or "stranger" (neither). Use eq. "Only people I know" hides author_in stranger.
* topic: one short lowercase word such as politics, crypto or sports. Items are tagged with every topic you use.
* media_kind: image, short_video, long_video or video. Shorts and reels are short_video.
* text: words in the title or text; use op contains.
* age_hours: hours since publishing; use gt or lt.
* judged:<name>: the answer to a question a model answers for every item, for what no field above can say: an event, a job
  change, a price or rent, pets allowed, written to make people angry. Declare each one you use in "judgments" as
  {"name": "<lowercase_name>", "question": "<a question about one item>", "answer": "yes_no" or "number"}.
  A yes_no answer is "yes", "no" or "unknown": test it with eq. A number answer (a price, rent, a count) is tested with gt or lt.
  To keep only items with a property ("only events"), hide the ones judged "no". When one rule keeps several kinds
  ("only events and birthdays"), declare one judgment whose question covers them all ("Is this about an event or a
  birthday?"), so a single hide rule keeps every one of them.

"hide", "no" and "never" mean do hide. "first" or "always show" mean boost with weight 10; "more of" means boost with weight 3.
"at most N a day" means limit with count_per_day N.
"summarize" reads the whole article or video and puts a short summary on its card ("summarize videos over 20 minutes":
when media_kind eq long_video). "note" writes a short note into the journal about items the person opens ("take notes on
what I read"). For these two "when" may be null, meaning every item.
"unless" or "except" becomes the unless condition.
Test source_id only when the rule names a whole source ("no X", "at most 20 from YouTube"). A kind of item ("likes and
trending notifications", "job posts", "ads") is a judgment, never a whole source. For example "Hide likes and trending
notifications" is the judgment {"name": "like_or_trend", "question": "Is this a like or a trending topic rather than a reply
or a mention?", "answer": "yes_no"} with a rule that hides judged:like_or_trend eq yes.
view_rules apply to this view. likes are boosts with weight 3 on that topic, author or source; dislikes are hides.
Skip lines that are not rules. The summary describes every rule in plain words."""


class BadInput(ValueError):
    """A request named something that cannot exist, such as a view id with a slash."""


def judgment_name(raw: object) -> object:
    """A model's "Pets Allowed" or "pets-allowed" read as pets_allowed; anything else is left for validation to refuse."""
    return re.sub(r"[^a-z0-9_]+", "_", raw.strip().lower()).strip("_") if isinstance(raw, str) else raw


class Judgment(BaseModel):
    """A question the tagging pass answers for every item, so a rule can test what no fixed field says.
    Views that use one name share its answers: the first view to declare the name sets the question."""

    name: str = Field(pattern=JUDGMENT_NAME.pattern)
    question: str = Field(min_length=3, max_length=MAX_QUESTION)
    answer: Literal["yes_no", "number"] = "yes_no"

    @field_validator("name", mode="before")
    @classmethod
    def plain_name(cls, name: object) -> object:
        return judgment_name(name)

    @field_validator("question", mode="before")
    @classmethod
    def short_question(cls, question: object) -> object:
        return question.strip()[:MAX_QUESTION] if isinstance(question, str) else question


class Condition(BaseModel):
    field: str
    op: Literal["eq", "in", "contains", "gt", "lt"]
    value: str | float | list[str]

    @field_validator("field")
    @classmethod
    def known_field(cls, field: str) -> str:
        """A fixed field, or judged:<name> for a judgment the view declares."""
        if field.startswith(JUDGED_PREFIX):
            field = f"{JUDGED_PREFIX}{judgment_name(field.removeprefix(JUDGED_PREFIX))}"
        if field in FIXED_FIELDS or (field.startswith(JUDGED_PREFIX) and JUDGMENT_NAME.fullmatch(field.removeprefix(JUDGED_PREFIX))):
            return field
        raise ValueError(f"unknown field: {field}")


class Rule(BaseModel):
    # null only for summarize and note rules, meaning every item.
    when: Condition | None = None
    unless: Condition | None = None
    do: Literal["hide", "boost", "limit", "summarize", "note"]
    weight: float = 0.0
    count_per_day: int | None = None


class TimeSpec(BaseModel):
    """A view's Time section: when its editions come out, how big they are and how long one visit lasts."""

    editions: list[str] = Field(default_factory=list)  # "07:00" on your clock, sorted
    edition_size: int | None = None
    visit_minutes: int | None = None


class WatchRef(BaseModel):
    url: str
    every_minutes: int = WATCH_EVERY_MINUTES


def watch_minutes(rest: str) -> int:
    """"every 30 minutes", "every 2 hours", "every day" or nothing (once an hour)."""
    match = EVERY.search(rest)
    if match is None:
        return WATCH_EVERY_MINUTES
    unit = match.group(2).lower()
    scale = 60 * 24 if unit.startswith("d") else 60 if unit.startswith("h") else 1
    return max(int(match.group(1) or 1) * scale, MIN_WATCH_MINUTES)


class SourceRef(BaseModel):
    source_id: Literal["x", "youtube", "rss", "page"]
    page_type: str | None = None
    channels: list[str] = Field(default_factory=list)
    feeds: list[str] = Field(default_factory=list)
    # Any site's feed page (Instagram, Facebook, a YouTube home): read in a tab that keeps scrolling as you do.
    pages: list[str] = Field(default_factory=list)
    # The pages among them whose posts come newest first.
    ordered: list[str] = Field(default_factory=list)
    # Pages listing the accounts you follow, read about once a week to know who is a stranger.
    following: list[str] = Field(default_factory=list)
    # How a page asks to be read, when its line says: "assist" or "pilot".
    modes: dict[str, Literal["pilot", "assist"]] = Field(default_factory=dict)
    # Pages watched for changes: a change becomes an item your rules judge, and an alert if they keep it.
    watches: list[WatchRef] = Field(default_factory=list)


class CompiledView(BaseModel):
    view_id: str
    title: str
    file_hash: str
    sources: list[SourceRef] = Field(default_factory=list)
    rules: list[Rule] = Field(default_factory=list)
    judgments: list[Judgment] = Field(default_factory=list)
    time: TimeSpec = Field(default_factory=TimeSpec)
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
    judgments: list[Judgment] = Field(default_factory=list)
    summary: str = ""


class ViewInfo(BaseModel):
    view_id: str
    title: str


def check_view_id(view_id: str) -> str:
    if not VIEW_ID.fullmatch(view_id):
        raise BadInput(f"bad view id: {view_id}")
    return view_id


def parse_sources(body: str, takeout_channels: list[str]) -> tuple[list[SourceRef], list[str]]:
    """Bullets such as 'X home timeline', 'YouTube: @a, @b', 'RSS: https://...', 'Page: https://... (newest first)' or a bare feed URL."""
    has_x, channels, feeds, pages, ordered, following, watches, warnings = False, [], [], [], [], [], [], []
    modes: dict[str, Literal["pilot", "assist"]] = {}
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
        elif key == "page":
            found_pages = URL.findall(rest)
            pages += found_pages
            if NEWEST_FIRST.search(URL.sub("", rest)):
                ordered += found_pages
            if mode := READ_MODE.search(URL.sub("", rest)):
                modes |= {page: "assist" if mode.group(1).lower() == "assist" else "pilot" for page in found_pages}
            if not found_pages:
                warnings.append(f"No page address found in: {line}")
        elif key == "watch":
            found_watches = URL.findall(rest)
            watches += [WatchRef(url=url, every_minutes=watch_minutes(URL.sub("", rest))) for url in found_watches]
            if not found_watches:
                warnings.append(f"No page address found in: {line}")
        elif key == "following":
            found_lists = URL.findall(rest)
            following += found_lists
            if not found_lists:
                warnings.append(f"No page address found in: {line}")
        elif X_LINE.match(line):
            has_x = True
        else:
            warnings.append(f"Unknown source line: {line}")
    sources = [SourceRef(source_id="x", page_type="home_timeline")] if has_x else []
    if channels:
        sources.append(SourceRef(source_id="youtube", channels=list(dict.fromkeys(channels))))
    if feeds:
        sources.append(SourceRef(source_id="rss", feeds=list(dict.fromkeys(feeds))))
    if pages or following or watches:
        unique_watches = list({watch.url: watch for watch in watches}.values())
        sources.append(
            SourceRef(
                source_id="page",
                pages=list(dict.fromkeys(pages)),
                ordered=list(dict.fromkeys(ordered)),
                following=list(dict.fromkeys(following)),
                watches=unique_watches,
                modes=modes,
            )
        )
    return sources, warnings


def clock_time(match: re.Match[str]) -> str | None:
    """One time of day as HH:MM, or None for something like 25:00 or 13pm."""
    if match.group(8):
        return "12:00" if match.group(8) == "noon" else "00:00"
    if match.group(1) or match.group(6):
        hour, minute, half = int(match.group(1) or match.group(6)), int(match.group(2) or 0), match.group(3) or match.group(7)
        if not 1 <= hour <= 12 or minute > 59:
            return None
        hour = hour % 12 + (12 if half == "p" else 0)
    else:
        hour, minute = int(match.group(4)), int(match.group(5))
        if hour > 23 or minute > 59:
            return None
    return f"{hour:02d}:{minute:02d}"


def parse_time_section(body: str) -> tuple[TimeSpec, list[str]]:
    """Lines such as "Editions at 7:00 and 6pm", "Each edition has 15 items" or "A visit lasts 10 minutes"."""
    editions: list[str] = []
    size, visit, warnings = None, None, []
    for line in bullets(body):
        text = line.lower()
        if "edition" in text:
            times = [clock_time(match) for match in CLOCK.finditer(text)]
            count = EDITION_COUNT.search(text)
            if None in times or not (times or count):
                warnings.append(f"No time of day or size found in: {line}")
            editions += [found for found in times if found]
            size = min(int(count.group(1)), MAX_EDITION_SIZE) if count else size
        elif "visit" in text or "session" in text:
            duration = DURATION.search(text)
            if duration is None:
                warnings.append(f"No length found in: {line}")
                continue
            minutes = int(duration.group(1)) * (60 if duration.group(2).startswith("h") else 1)
            visit = min(max(minutes, 1), MAX_VISIT_MINUTES)
        else:
            warnings.append(f"Time line not understood: {line}")
    return TimeSpec(editions=sorted(set(editions)), edition_size=size or None, visit_minutes=visit), warnings


def source_ids(sources: list[SourceRef]) -> list[str]:
    ids = []
    for source in sources:
        if source.source_id == "x":
            ids.append("x")
        ids += [youtube_source_id(channel) for channel in source.channels]
        ids += [rss_source_id(feed) for feed in source.feeds]
        ids += [page_source_id(page) for page in source.pages]
        ids += [watch_source_id(watch.url) for watch in source.watches]
    return list(dict.fromkeys(ids))


def judged_names(rule: Rule) -> set[str]:
    return {condition.field.removeprefix(JUDGED_PREFIX) for condition in (rule.when, rule.unless) if condition and condition.field.startswith(JUDGED_PREFIX)}


def usable_rules(rules: list[Rule], judgments: list[Judgment] | None = None) -> tuple[list[Rule], list[Judgment]]:
    """Rules that can run, with the judgments they use: a boost without a weight gets the default, a limit without a count
    is dropped, so is a rule testing a judgment nobody declared; a judgment no rule tests is never asked."""
    declared = {judgment.name: judgment for judgment in reversed(judgments or [])}
    usable = []
    for rule in rules:
        if (rule.do == "limit" and not rule.count_per_day) or not judged_names(rule) <= declared.keys():
            continue
        if rule.when is None and rule.do in ("hide", "boost", "limit"):
            continue
        usable.append(rule.model_copy(update={"weight": rule.weight or DEFAULT_BOOST}) if rule.do == "boost" else rule)
    used = set().union(*(judged_names(rule) for rule in usable))
    return usable, [declared[name] for name in sorted(used)]


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
        if source.pages:
            parts.append(f"{len(source.pages)} page{'s' if len(source.pages) != 1 else ''}")
        if source.following:
            parts.append(f"{len(source.following)} following list{'s' if len(source.following) != 1 else ''}")
        if source.watches:
            parts.append(f"{len(source.watches)} watched page{'s' if len(source.watches) != 1 else ''}")
    if not parts:
        return "No sources yet."
    listed = parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"
    return f"Reading {listed}."


def cached_view(cache: Path) -> CompiledView | None:
    try:
        return CompiledView.model_validate_json(cache.read_text())
    except (OSError, ValueError):
        return None


class Compiler:
    """Caches compiled views by the hash of every file they read; a failed rules compile retries after a minute.

    Each view has its own lock, so a slow model compiling one view never holds up the others."""

    def __init__(self, paths: Paths, gateway: Gateway, memory: Memory):
        self.paths = paths
        self.gateway = gateway
        self.memory = memory
        self.locks_lock = threading.Lock()
        self.locks: dict[str, threading.Lock] = {}
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

    def all_compiled(self, use_model: bool = True) -> list[CompiledView]:
        """Every view; one that another thread is compiling right now comes as last compiled instead of waiting.
        Without use_model a stale view comes with its rules as last compiled: enough for its sources."""
        return [self.compiled(view_id, wait=False, use_model=use_model) for view_id in self.view_ids()]

    def view_lock(self, view_id: str) -> threading.Lock:
        with self.locks_lock:
            return self.locks.setdefault(view_id, threading.Lock())

    def view_text(self, view_id: str) -> str:
        path = self.paths.views / f"{check_view_id(view_id)}.md"
        return read_text(path)

    def input_hash(self, view_text: str) -> str:
        """Everything a compiled view depends on, plus the compiler's version, so a cached view made by an older
        openMoi (say with source ids named differently) is compiled again."""
        parts = [COMPILER_VERSION, view_text, read_text(self.paths.takeout), self.memory.likes(), self.memory.dislikes()]
        return hashlib.sha256("\0".join(parts).encode()).hexdigest()

    def compiled(self, view_id: str, wait: bool = True, use_model: bool = True) -> CompiledView:
        """The compiled view, recompiling only when one of its input files changed.

        A cache file that is damaged (a crash mid write, an older format) counts as missing and is rebuilt.
        Without wait, a view busy compiling elsewhere comes back as last compiled, or with its rules still to come."""
        view_text = self.view_text(view_id)
        file_hash = self.input_hash(view_text)
        cache = self.paths.compiled / f"{view_id}.json"
        if not use_model:
            cached = cached_view(cache)
            return cached if cached and cached.file_hash == file_hash else self.compile(view_id, view_text, file_hash, cached, use_model=False)[0]
        lock = self.view_lock(view_id)
        if not lock.acquire(blocking=wait):
            return cached_view(cache) or self.compile(view_id, view_text, file_hash, None, use_model=False)[0]
        try:
            previous = cached_view(cache)
            if previous and previous.file_hash == file_hash:
                return previous
            failure = self.failures.get(view_id)
            if failure and failure[0] == file_hash and time.monotonic() - failure[1] < RETRY_AFTER_SECONDS:
                return failure[2]
            compiled, succeeded = self.compile(view_id, view_text, file_hash, previous)
            if succeeded:
                write_atomic(cache, compiled.model_dump_json(indent=2))
                self.failures.pop(view_id, None)
            else:
                self.failures[view_id] = (file_hash, time.monotonic(), compiled)
            return compiled
        finally:
            lock.release()

    def compile(
        self, view_id: str, view_text: str, file_hash: str, previous: CompiledView | None, use_model: bool = True
    ) -> tuple[CompiledView, bool]:
        title, sections = parse_sections(view_text)
        sources, warnings = parse_sources(section_text(sections, "sources"), read_takeout(self.paths.takeout))
        time, time_warnings = parse_time_section(section_text(sections, "time"))
        warnings += time_warnings
        try:
            if not use_model:
                raise LlmError("still compiling")
            rules, judgments, rules_summary = self.compile_rules(section_text(sections, "rules"), sources)
            succeeded = True
        except LlmError as error:
            rules, judgments, rules_summary, succeeded = (previous.rules if previous else []), (previous.judgments if previous else []), "", False
            warnings.append(f"Rules not updated: {error}")
        compiled = CompiledView(
            view_id=view_id,
            title=title or view_id,
            file_hash=file_hash,
            sources=sources,
            rules=rules,
            judgments=judgments,
            time=time,
            layout=section_text(sections, "layout"),
            summary=" ".join(part for part in (describe_sources(sources), rules_summary) if part),
            warnings=warnings,
        )
        return compiled, succeeded

    def compile_rules(self, rules_text: str, sources: list[SourceRef]) -> tuple[list[Rule], list[Judgment], str]:
        likes, dislikes = self.memory.likes(), self.memory.dislikes()
        if not (bullets(rules_text) or bullets(likes) or bullets(dislikes)):
            return [], [], ""
        prompt = rules_prompt(rules_text, likes, dislikes, source_ids(sources))
        draft = self.gateway.complete_json("fast", "compile_rules", prompt, True, RulesDraft)
        rules, judgments = usable_rules(draft.rules, draft.judgments)
        return rules, judgments, draft.summary.strip()
