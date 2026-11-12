"""The Brain composes storage, sources, compilation, ranking and lenses behind one object."""

import json
import queue
import re
import sys
import threading
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from operator import itemgetter
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field, ValidationError

from moi_brain.compile import BadInput, CompiledView, Compiler, Judgment, Rule, ViewInfo, check_view_id
from moi_brain.answers import MAX_SOURCES, Answer, AnswerReply, answer_prompt, cited
from moi_brain.collections import READ_LATER, collection_name, collection_title, export_json, export_markdown, is_collection_name
from moi_brain.content import ContentSummary, caption_allowed, is_video, offline_blocks, summary_extra, summary_prompt, transcript_text
from moi_brain.config import ModelChange, ModelInfo, Paths, Settings, apply_model_change, ensure_home, model_info, save_settings
from moi_brain.editions import LEAD, LOCAL_LEAD, Edition, EditionBook
from moi_brain.enrich import enriched
from moi_brain.edits import VIEW_SECTIONS, EditScope, Editor, Proposal
from moi_brain.extractor_gen import generate_spec
from moi_brain.exports import SOURCE_IDS, read_export
from moi_brain.extractors import ExtractorSpec, ExtractorStore
from moi_brain.files import read_json, write_atomic
from moi_brain.google import GoogleAccount, GoogleError
from moi_brain.health import HealthBook, OracleReply, RunReport, Verdict, oracle_prompt
from moi_brain.feeds import YOUTUBE_BASE, FeedError, FeedFetcher, read_takeout
from moi_brain.journal import matching_lines, roll_up
from moi_brain.items import (
    HANDLE,
    Event,
    Item,
    ViewItem,
    is_private_host,
    normalize,
    page_source_id,
    profile_handle,
    rss_source_id,
    site_host,
    watch_source_id,
    youtube_source_id,
)
from moi_brain.lens_gen import LensVerdict, generate_lens, judge_lens
from moi_brain.lenses import LENS_KINDS, SITE_PREFIX, LensStore, lens_key
from moi_brain.llm import Gateway, LlmError
from moi_brain.md import parse_sections, section_text
from moi_brain.memory import JOURNAL_DAYS, TOPIC_FILES, Memory
from moi_brain.mirror import MAX_DAYS, Mirror, build_mirror
from moi_brain.packs import PackError, install, installed_pack, merged_policy, public_key, verified_pack
from moi_brain.policy import Mode, load_policy, policy_for
from moi_brain.rank import PAGE_SIZE, Circles, Order, applies, kept_share, rank
from moi_brain.ranker import Ranker, features
from moi_brain.relay import RelayHub
from moi_brain.store import Store
from moi_brain.tag import Tagger, is_judged, rule_topics, watch_judgments, watch_list
from moi_brain.shop import MAX_QUERY, ShopState, parse_price, price_note, product_key, search_urls, shop_source_id
from moi_brain.sharing import MAX_IMPORT, clean_import, people_names, session_reads, share_text, view_name
from moi_brain.stories import CLUSTER_WINDOW, Updater, assign_clusters, make_vectors, story_key, story_text
from moi_brain.vectors import HASHED, cosine, packed, unpacked
from moi_brain.watch import change_item, changed_lines, watch_lines

# A read scrolls a source page step by step at human pace; daily_steps caps how far it scrolls each source per day.
PILOT_BUDGET = {"page_loads": 1, "scroll_steps": 5, "min_step_interval_ms": 1500, "daily_steps": 200}
FEED_INTERVAL = timedelta(minutes=5)
VIEW_WINDOW = timedelta(days=7)
# What you saw stays in the view this long, so a new look or a reload shows the same feed instead of an empty one.
SEEN_KEEP = timedelta(hours=12)
# A following list is read again after this long; who you follow changes slowly.
FOLLOWS_EVERY = timedelta(days=7)
NOBODY_KNOWN = "Rules about people you know have no one to go on yet: add a Following source, or people to memory/people.md."
MIRROR_EVERY = timedelta(days=7)
SUBSCRIPTIONS_EVERY = timedelta(days=1)
# Items a summarize rule wants are summarized while they are this fresh and unseen.
CONTENT_WINDOW = timedelta(hours=48)
# When an item last could not be read or summarized; it is tried again a day later.
CONTENT_FAILED = "summary_failed_at"
CONTENT_RETRY = timedelta(hours=24)
OFFLINE_KEY = "offline_at"
OFFLINE_FAILED = "offline_failed_at"
MAX_EXPORT = 1000
MAX_HIGHLIGHT = 1000
WHITESPACE = re.compile(r"\s+")
MomentKind = Literal["visit", "extended", "early"]
X_DOMAIN = "x.com"
HTTP_TIMEOUT = 15.0
SEARCH_LIMIT = 20
MAX_SEARCH = 100
# Search reads this many candidates per result wanted, by words and by meaning, before ordering them.
SEARCH_DEPTH = 5
# The newest vectors searched by meaning; older items are still found by their words.
MAX_VECTOR_SCAN = 20_000
TEXT_WEIGHT = 0.6


def utc_now() -> datetime:
    return datetime.now(UTC)


class PageSource(BaseModel):
    """A source the shell reads inside your session in a reader tab. Without a spec the shell makes one from the page."""

    source_id: str
    page_type: str
    start_url: str
    spec: ExtractorSpec | None
    budget: dict[str, int]
    # Posts come newest first, so reaching what was read before means nothing newer was missed.
    chronological: bool = False
    # "follows": a page listing accounts you follow, read into who you know rather than into items.
    # "watch": a page whose text is compared with its last look.
    purpose: Literal["items", "follows", "watch"] = "items"
    # "assist": read only while you browse the page yourself in Chrome, never by a reader tab.
    mode: Mode = "pilot"
    # Also read the JSON the page fetches by itself (rung 2, openMoi's own session only).
    capture: bool = False


class ContentWanted(BaseModel):
    """An item to read in full: for a summarize rule (an article, or a video whose transcript is read), or for an
    offline copy of an article you saved to Read later."""

    item_id: str
    url: str
    video: bool
    purpose: Literal["summary", "offline"] = "summary"


class ShopStart(BaseModel):
    view_id: str
    query: str
    # A Shop view was made for this, from its template.
    created: bool = False


class CollectionInfo(BaseModel):
    name: str
    title: str
    count: int
    # Views that read this collection.
    views: list[str] = Field(default_factory=list)


class WatchAlert(BaseModel):
    view_id: str
    title: str
    text: str
    # False when the model was not answering, so the change could not be checked against the view's rules.
    checked: bool = True


class WatchReport(BaseModel):
    changed: bool
    alert: WatchAlert | None = None


class SearchHit(BaseModel):
    item: Item
    score: float


class ViewPage(BaseModel):
    view_id: str
    items: list[ViewItem]
    has_more: bool
    refreshing: bool
    caught_up: bool
    summary: str
    warnings: list[str]
    version: str
    layout_hash: str
    lens_stale: bool = False
    # Per source, the share of its items your rules let through, so the shell reads enough ahead.
    keep_rate: dict[str, float] = Field(default_factory=dict)
    # Feeds still being fetched for this view, apart from tagging.
    reading: bool = False
    # A view with editions: the one on show and when the next comes out.
    edition: datetime | None = None
    next_edition: datetime | None = None


class ViewSchedule(BaseModel):
    """A view with a Time section: its editions, a read due now and how long a visit lasts."""

    view_id: str
    title: str
    edition: datetime | None
    next_edition: datetime | None
    read_for: datetime | None
    visit_minutes: int | None


class PassiveRecords(BaseModel):
    """Records the extension read from a page you browsed yourself."""

    event: Literal["passive_records"]
    source_id: str
    page_url: str
    records: list[dict[str, Any]] = Field(max_length=200)


class MineRequest(BaseModel):
    """You pressed Mine on a page in Chrome."""

    event: Literal["mine"]
    handle: str
    url: str
    title: str = ""


class Overview(BaseModel):
    """Everything /settings shows: the view's sections, memory, models, Chrome and where the files live."""

    home: str
    view_id: str
    view_file: str
    sections: dict[str, str]
    memory: dict[str, str]
    model: ModelInfo
    relay: dict[str, Any]


# (source id, the feed or channel it reads, the reader): two feeds on one site share a source id but not a reader.
FeedReader = tuple[str, str, Callable[[], list[dict[str, Any]]]]
MAX_RELAY_EVENTS = 50
MAX_RELAY_INBOX = 200
NEW_VIEW = "# {title}\n\n## Sources\n\n## Rules\n\n## Layout\n"


def url_prefix(url: str) -> str:
    """The part of a page URL a passive source matches on: no query, no fragment."""
    parts = urlparse(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def recently_failed(item: Item, now: datetime, key: str = CONTENT_FAILED) -> bool:
    """An item whose full read or summary (or offline copy, by its key) failed less than a day ago."""
    try:
        return now - datetime.fromisoformat(item.extra.get(key, "")) < CONTENT_RETRY
    except ValueError:
        return False


def edition_items(
    size: int,
    edition: Edition,
    entries: list[tuple[Item, datetime | None]],
    items: list[Item],
    shown: list[str],
    rules: list[Rule],
    now: datetime,
    long_seen: set[str],
    circles: Circles,
) -> list[Item]:
    """An edition's own items: what it already showed you or you saw since it came out, then the best of the rest up to its
    size. Those stay members on a reload, so reading the whole edition never empties it and never lets more in."""
    present = {item.item_id for item in items}
    fixed = ({item.item_id for item, seen_at in entries if seen_at and seen_at >= edition.at} | set(shown)) & present
    best, _ = rank(items, rules, now, long_seen | fixed, max(size - len(fixed), 0), circles=circles)
    members = fixed | {entry.item.item_id for entry in best}
    return [item for item in items if item.item_id in members]


def needs_tags(compiled: CompiledView) -> bool:
    """A view whose rules test topics or judgments shows an item only once the tagging pass has looked at it."""
    return bool(rule_topics(compiled.rules) or compiled.judgments)


def seen_long_ago(entries: list[tuple[Item, datetime | None]], seen_before: datetime) -> set[str]:
    """Ids of items you saw before seen_before: they still count toward daily limits but are not shown again."""
    return {item.item_id for item, seen_at in entries if seen_at and seen_at < seen_before}


class Brain:
    def __init__(
        self,
        paths: Paths,
        settings: Settings,
        http: httpx.Client | None = None,
        youtube_base: str = YOUTUBE_BASE,
        clock: Callable[[], datetime] = utc_now,
        settings_problems: list[str] | None = None,
    ):
        ensure_home(paths)
        self.paths = paths
        self.clock = clock
        self.settings_problems = list(settings_problems or [])
        self.http = http or httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True)
        self.store = Store(paths.db)
        self.editions = EditionBook(paths.editions)
        self.gateway = Gateway(settings, paths.llm_log, self.http)
        self.fetcher = FeedFetcher(self.http, paths.channel_cache, youtube_base)
        self.youtube_base = youtube_base
        self.memory = Memory(paths)
        self.google = GoogleAccount(paths.google_tokens, self.http)
        self.compiler = Compiler(paths, self.gateway, self.memory, self.subscriptions)
        self.tagger = Tagger(self.store, self.gateway, paths.tagging_state, self.watch_list, self.watch_judgments)
        self.updater = Updater(self.store, self.gateway)
        self.editor = Editor(paths, self.gateway)
        self.extractors = ExtractorStore(paths.builtin_extractors, paths.extractors, paths.packs / "extractors")
        self.policies = merged_policy(load_policy(paths.site_policy), installed_pack(paths.packs))
        self.health = HealthBook(paths.extractor_health)
        self.ranker = Ranker(paths.ranker)
        self.lenses = LensStore(paths.default_lens, paths.lenses)
        self.relay = RelayHub(paths.relay_trust, self.queue_relay_event, self.relay_config)
        self.relay_events: deque[MineRequest] = deque(maxlen=MAX_RELAY_EVENTS)
        # Events from Chrome are handled off the relay's socket thread, which also carries the replies calls wait for.
        self.relay_inbox: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=MAX_RELAY_INBOX)
        threading.Thread(target=self.relay_worker, daemon=True).start()
        self.passive_batches = 0
        self.lock = threading.Lock()
        self.journal_lock = threading.Lock()
        self.refreshing: set[str] = set()
        self.source_status: dict[tuple[str, str], str] = {}
        self.fetched_at: dict[tuple[str, str], datetime] = {}

    def start_refresh(self, view_id: str, force: bool = False) -> list[PageSource]:
        """Refresh feed sources in a background thread; returns the page sources the shell should read."""
        compiled = self.compiler.compiled(view_id)
        with self.lock:
            already_running = view_id in self.refreshing
            self.refreshing.add(view_id)
        if not already_running:
            threading.Thread(target=self.refresh_feeds, args=(view_id, compiled, force), daemon=True).start()
        self.relay.push_config()
        return self.page_sources(compiled)

    def refresh_feeds(self, view_id: str, compiled: CompiledView, force: bool) -> None:
        """Drops expired items, then reads every feed source not read in the last few minutes."""
        try:
            self.store.expire(self.clock())
            self.roll_up_journal()
            self.refresh_subscriptions()
            for source_id, location, reader in self.feed_readers(compiled):
                key = (source_id, location)
                last = self.fetched_at.get(key)
                if not force and last and self.clock() - last < FEED_INTERVAL:
                    continue
                try:
                    self.store_records(source_id, reader())
                    self.source_status[key] = "ok"
                except FeedError as error:
                    self.source_status[key] = str(error)
                except Exception as error:
                    print(f"refresh of {source_id} failed: {error!r}", file=sys.stderr)
                    self.source_status[key] = f"could not be stored: {error}"
                self.fetched_at[key] = self.clock()
        finally:
            with self.lock:
                self.refreshing.discard(view_id)

    def feed_readers(self, compiled: CompiledView) -> list[FeedReader]:
        readers: list[FeedReader] = []
        for source in compiled.sources:
            readers += [(youtube_source_id(channel), channel, partial(self.fetcher.fetch_youtube, channel)) for channel in source.channels]
            readers += [(rss_source_id(feed), feed, partial(self.fetcher.fetch_rss, feed)) for feed in source.feeds]
        return readers

    def judgment_conflicts(self, compiled: CompiledView) -> list[str]:
        """A question this view names that another view already asks differently: one name, one set of answers."""
        shared = {judgment.name: judgment for judgment in self.watch_judgments()}
        return [
            f'The question "{judgment.name}" is answered as another view asks it ("{shared[judgment.name].question}"); give it another name in one of the views.'
            for judgment in compiled.judgments
            if judgment.name in shared and shared[judgment.name] != judgment
        ]

    def usable_versions(self, url: str) -> list[ExtractorSpec]:
        """A page's specs, newest first, without those the oracle rejected for reading something else."""
        return [spec for spec in self.extractors.versions(url) if not self.health.health(spec.domain, spec.path_pattern, spec.version).rejected]

    def best_spec(self, url: str) -> ExtractorSpec | None:
        """The newest spec for a page that is not failing its health check, else the newest one not rejected."""
        versions = self.usable_versions(url)
        healthy = [spec for spec in versions if self.health.health(spec.domain, spec.path_pattern, spec.version).status != "failing"]
        return (healthy or versions or [None])[0]

    def previous_specs(self, url: str, version: int) -> list[ExtractorSpec]:
        """Earlier versions of a page's spec, newest first, at most two: the first fallback when a spec drifts."""
        return [spec for spec in self.usable_versions(url) if spec.version < version][:2]

    def report_extractor(self, report: RunReport) -> Verdict:
        """One run of a spec, judged. A new spec's first run also goes to the model, which says whether its items are
        the page's main items; a model that cannot be asked leaves that check out."""
        oracle_problem = ""
        if report.samples and self.health.is_new(report):
            try:
                answer = self.gateway.complete_json("fast", "oracle", oracle_prompt(report.domain, report.path_pattern, report.samples), True, OracleReply)
                oracle_problem = "" if answer.main_items else f"the items look like {answer.why.strip() or 'something other than the page items'}"
            except LlmError:
                oracle_problem = ""
        return self.health.record(report, oracle_problem)

    def watch_source(self, url: str) -> PageSource:
        return PageSource(source_id=watch_source_id(url), page_type="watch", start_url=url, spec=None, budget=self.budget_for(url), purpose="watch", mode=policy_for(self.policies, url).mode)

    def readable_in_a_tab(self, url: str) -> bool:
        """A page openMoi may open in a reader tab of its own: its site is active and not assist only."""
        policy = policy_for(self.policies, url)
        return policy.status == "active" and policy.mode == "pilot"

    def policy_warnings(self, compiled: CompiledView) -> list[str]:
        """Pages of this view that the site policy turned off, said once per site."""
        urls = [page for source in compiled.sources for page in [*source.pages, *source.following, *(watch.url for watch in source.watches)]]
        if any(source.source_id == "x" for source in compiled.sources):
            urls.append(f"https://{X_DOMAIN}/home")
        stopped = {site_host(url): policy_for(self.policies, url).status for url in urls if policy_for(self.policies, url).status != "active"}
        return [f"{site} is {status} by the site policy, so openMoi does not read it." for site, status in stopped.items()]

    def budget_for(self, url: str) -> dict[str, int]:
        return {**PILOT_BUDGET, "daily_steps": policy_for(self.policies, url).daily_steps}

    def page_sources(self, compiled: CompiledView) -> list[PageSource]:
        """Pages to read in your session, each by its site's policy: a removed site is never read; a page's own
        line may choose assist or pilot."""
        found = []
        for source in compiled.sources:
            if source.source_id != "x":
                continue
            spec = self.extractors.for_page_type(X_DOMAIN, source.page_type or "home_timeline")
            if spec and spec.start_url and policy_for(self.policies, spec.start_url).status == "active":
                policy = policy_for(self.policies, spec.start_url)
                found.append(PageSource(source_id="x", page_type=spec.page_type, start_url=spec.start_url, spec=spec, budget=self.budget_for(spec.start_url), mode=policy.mode))
        for url in self.shop_urls(compiled):
            if policy_for(self.policies, url).status == "active":
                found.append(PageSource(source_id=shop_source_id(url), page_type="listing", start_url=url, spec=self.best_spec(url), budget=self.budget_for(url), mode=policy_for(self.policies, url).mode))
        for source in compiled.sources:
            for page in source.pages:
                policy = policy_for(self.policies, page)
                if policy.status != "active":
                    continue
                found.append(
                    PageSource(
                        source_id=page_source_id(page),
                        page_type="listing",
                        start_url=page,
                        spec=self.best_spec(page),
                        budget=self.budget_for(page),
                        chronological=page in source.ordered,
                        mode=source.modes.get(page, policy.mode),
                        capture=policy.capture,
                    )
                )
            for watch in source.watches:
                if policy_for(self.policies, watch.url).status == "active":
                    found.append(self.watch_source(watch.url))
            for page in source.following:
                if policy_for(self.policies, page).status != "active":
                    continue
                read_at = self.store.list_read_at(page)
                if read_at is None or self.clock() - read_at >= FOLLOWS_EVERY:
                    spec = self.best_spec(page)
                    found.append(
                        PageSource(
                            source_id=page_source_id(page),
                            page_type="following",
                            start_url=page,
                            spec=spec,
                            budget=self.budget_for(page),
                            purpose="follows",
                            mode=policy_for(self.policies, page).mode,
                        )
                    )
        return found

    def passive_sources(self) -> list[PageSource]:
        """Page sources of every view, which the extension reads whenever you browse them yourself."""
        found = {
            source.source_id: source
            for compiled in self.compiler.all_compiled(use_model=False)
            for source in self.page_sources(compiled)
            if source.purpose == "items"
        }
        return list(found.values())

    def relay_config(self) -> dict[str, Any]:
        passive = [
            {"source_id": source.source_id, "url_prefix": url_prefix(source.start_url), "spec": source.spec.model_dump()}
            for source in self.passive_sources()
            if source.spec
        ]
        return {"passive": passive}

    def queue_relay_event(self, message: dict[str, Any]) -> None:
        """A flood of passive batches drops the newest rather than growing without end; a Mine press, which is cheap
        and which you are waiting for, goes straight through."""
        if message.get("event") == "mine":
            self.on_relay_event(message)
            return
        try:
            self.relay_inbox.put_nowait(message)
        except queue.Full:
            print("relay inbox full, dropping an event", file=sys.stderr)

    def relay_worker(self) -> None:
        while True:
            message = self.relay_inbox.get()
            try:
                self.on_relay_event(message)
            except Exception as error:
                print(f"relay event failed: {error!r}", file=sys.stderr)

    def on_relay_event(self, message: dict[str, Any]) -> None:
        """Passive records from a known source page are ingested; Mine requests wait for the app."""
        try:
            if message.get("event") == "mine":
                self.relay_events.append(MineRequest.model_validate(message))
                return
            records = PassiveRecords.model_validate(message)
        except ValidationError:
            return
        source = next((source for source in self.passive_sources() if source.source_id == records.source_id), None)
        if source and records.page_url.startswith(url_prefix(source.start_url)):
            self.ingest(records.source_id, records.records, records.page_url)
            self.passive_batches += 1

    def take_relay_events(self) -> list[MineRequest]:
        """Pops the waiting Mine requests one by one, so one that arrives meanwhile is never lost."""
        events = []
        while self.relay_events:
            events.append(self.relay_events.popleft())
        return events

    def relay_status(self) -> dict[str, Any]:
        return {**self.relay.status(), "passive_batches": self.passive_batches}

    def store_records(self, source_id: str, records: list[dict[str, Any]], page_url: str | None = None, tag_now: bool = False) -> list[Item]:
        """Normalize and store; new items are tagged by the background worker, or right away when tag_now is set.

        Returns every item in record order, new or already known.
        """
        now = self.clock()
        normalized = [normalize(source_id, record, now, page_url) for record in records]
        items = list({item.item_id: item for item in normalized if item}.values())
        known = self.store.get_items([item.item_id for item in items])
        recent = self.store.items_since(now - CLUSTER_WINDOW)
        new_items = [enriched(item) for item in items if item.item_id not in known]
        kind, vectors = self.item_vectors(new_items, [item for item, _ in recent])
        fresh = assign_clusters(new_items, [item for item, _ in recent], vectors, {item.item_id for item, seen_at in recent if seen_at})
        if tag_now:
            fresh, known = self.tag_now(fresh, known)
        stored = {item.item_id: item for item in self.store.upsert_items([*known.values(), *fresh], listed_at=now)}
        prices = [(product_key(item), price.amount, price.symbol) for item in items if (price := parse_price(item.extra.get("price_text", "")))]
        if prices:
            self.store.record_prices(prices, now)
        # A product listed again at another price shows the price it has now.
        for item in items:
            stored_item = known.get(item.item_id)
            if stored_item and item.extra.get("price_text") and item.extra["price_text"] != stored_item.extra.get("price_text"):
                self.store.update_extra(item.item_id, {"price_text": item.extra["price_text"]})
                known[item.item_id] = stored_item.model_copy(update={"extra": {**stored_item.extra, "price_text": item.extra["price_text"]}})
        self.store.save_vectors({item.item_id: (kind, packed(vectors[item.item_id])) for item in fresh if item.item_id in stored})
        self.check_updates(list(stored.values()), recent)
        if not tag_now:
            self.tagger.enqueue(list(stored.values()))
        same_url = self.store.items_by_url(source_id, [item.url for item in fresh if item.item_id not in stored])
        found = [known.get(item.item_id) or stored.get(item.item_id) or same_url.get(item.url) for item in items]
        return [item for item in found if item]

    def item_vectors(self, new_items: list[Item], recent: list[Item]) -> tuple[str, dict[str, list[float]]]:
        """Vectors of new items, made now, with the stored ones of recent items made the same way."""
        if not new_items:
            return HASHED, {}
        kind, made = make_vectors(self.gateway, [story_text(item) for item in new_items], "embed_items")
        vectors = {item_id: unpacked(data) for item_id, data in self.store.vectors_of([item.item_id for item in recent], kind).items()}
        return kind, vectors | {item.item_id: vector for item, vector in zip(new_items, made, strict=True)}

    def search(self, query: str, limit: int = SEARCH_LIMIT) -> list[SearchHit]:
        """Items matching your words by bm25, reordered by how close their vectors are to the query's; with an
        embedding model, items that say it in other words are found too."""
        limit = min(max(limit, 1), MAX_SEARCH)
        by_words = self.store.search(query, limit * SEARCH_DEPTH)
        best_words = max((score for _, score in by_words), default=0.0)
        text_scores = {item.item_id: score / best_words if best_words > 0 else 0.0 for item, score in by_words}
        found = {item.item_id: item for item, _ in by_words}
        kind, (query_vector,) = make_vectors(self.gateway, [query], "embed_query")
        stored = self.store.vectors_of(list(found), kind)
        if kind != HASHED:
            stored |= self.store.vectors_by_kind(kind, MAX_VECTOR_SCAN)
        closeness = {item_id: max(cosine(query_vector, unpacked(data)), 0.0) for item_id, data in stored.items()}
        if kind != HASHED:
            nearest = sorted(closeness, key=closeness.__getitem__, reverse=True)[: limit * SEARCH_DEPTH]
            found |= self.store.get_items([item_id for item_id in nearest if item_id not in found])
        scores = {item_id: TEXT_WEIGHT * text_scores.get(item_id, 0.0) + (1 - TEXT_WEIGHT) * closeness.get(item_id, 0.0) for item_id in found}
        # One hit per link: the same story from two sources shows once, its best scored copy.
        by_url: dict[str, str] = {}
        for item_id in sorted(found, key=scores.__getitem__, reverse=True):
            if scores[item_id] > 0:
                by_url.setdefault(found[item_id].url, item_id)
        return [SearchHit(item=found[item_id], score=round(scores[item_id], 4)) for item_id in list(by_url.values())[:limit]]

    def with_price_notes(self, ranked: list[ViewItem]) -> list[ViewItem]:
        """Products whose price you saw on other days say how this one compares: the lowest you saw, or that it is."""
        priced = {view_item.item.item_id: price for view_item in ranked if (price := parse_price(view_item.item.extra.get("price_text", "")))}
        if not priced:
            return ranked
        history = self.store.price_history([product_key(view_item.item) for view_item in ranked if view_item.item.item_id in priced])
        noted = []
        for view_item in ranked:
            note = price_note(priced[view_item.item.item_id], history.get(product_key(view_item.item), [])) if view_item.item.item_id in priced else ""
            noted.append(view_item.model_copy(update={"item": view_item.item.model_copy(update={"extra": {**view_item.item.extra, "price_note": note}})}) if note else view_item)
        return noted

    def check_updates(self, stored: list[Item], recent: list[tuple[Item, datetime | None]]) -> None:
        """A new copy of a story you saw goes to the update pass, compared with the copy you saw last. A copy of a link
        you saw is seen already and needs no comparing."""
        seen: dict[str, tuple[datetime, str]] = {}
        seen_urls = {item.url for item, seen_at in recent if seen_at}
        for item, seen_at in recent:
            if seen_at and seen_at >= seen.get(story_key(item), (seen_at, ""))[0]:
                seen[story_key(item)] = (seen_at, item.item_id)
        pairs = [(seen[story_key(item)][1], item.item_id) for item in stored if story_key(item) in seen and item.url not in seen_urls]
        if pairs:
            self.updater.enqueue(pairs)

    def tag_now(self, fresh: list[Item], known: dict[str, Item]) -> tuple[list[Item], dict[str, Item]]:
        """Tags new items and any stored ones the background worker has not reached yet, so a page shown at once is
        filtered by every rule; stored ones get their tags saved right away."""
        topics, judgments = self.watch_list(), self.watch_judgments()
        waiting = [item for item in known.values() if not item.tagged or not is_judged(item, judgments)]
        tagged = {item.item_id: item for item in self.tagger.tag([*fresh, *waiting], topics, judgments) if item.tagged}
        self.store.update_tags([tagged[item.item_id] for item in waiting if item.item_id in tagged])
        return [tagged.get(item.item_id, item) for item in fresh], {item_id: tagged.get(item_id, item) for item_id, item in known.items()}

    def watch_list(self) -> list[str]:
        return watch_list(self.compiler.all_compiled())

    def watch_judgments(self) -> list[Judgment]:
        return watch_judgments(self.compiler.all_compiled())

    def retag_if_needed(self) -> None:
        self.tagger.ensure_current(self.watch_list(), self.clock(), self.watch_judgments())

    def already_stored(self, source_id: str, records: list[dict[str, Any]], page_url: str | None = None) -> list[int]:
        """Positions of the records this source had stored before, by id or by URL: a reader of a newest first page
        stops once it reaches them."""
        normalized = [normalize(source_id, record, self.clock(), page_url) for record in records]
        items = [item for item in normalized if item]
        known = set(self.store.get_items([item.item_id for item in items]))
        known_urls = set(self.store.items_by_url(source_id, [item.url for item in items]))
        return [index for index, item in enumerate(normalized) if item and (item.item_id in known or item.url in known_urls)]

    def add_follows(self, list_url: str, records: list[dict[str, Any]]) -> int:
        """Accounts from a page listing who you follow; each becomes known on its own site."""
        accounts = [account for record in records if (account := profile_handle(record, list_url))]
        return self.store.add_follows(list_url, accounts, self.clock())

    def content_wanted(self, limit: int = 5) -> list[ContentWanted]:
        """Fresh unseen items a view's summarize rules want, newest first; one that failed once is not asked for again.
        A summarize_only item is wanted even once seen: its card waits for the summary. Articles saved to Read later
        without an offline copy come after them."""
        now = self.clock()
        circles = self.circles()
        found: dict[str, tuple[datetime, ContentWanted]] = {}
        for view_id in self.compiler.view_ids():
            compiled = self.compiler.compiled(view_id)
            rules = [rule for rule in compiled.rules if rule.do in ("summarize", "summarize_only")]
            if not rules:
                continue
            for item, seen_at in self.store.items_with_seen(compiled.source_ids(), now - CONTENT_WINDOW):
                if "summary" in item.extra or recently_failed(item, now) or item.source_id.startswith("history:") or not self.readable_in_a_tab(item.url):
                    continue
                matching = [rule for rule in rules if applies(rule, item, now, circles)]
                if matching and (not seen_at or any(rule.do == "summarize_only" for rule in matching)):
                    found[item.item_id] = (item.published_at or item.fetched_at, ContentWanted(item_id=item.item_id, url=item.url, video=is_video(item.url)))
        newest = [wanted for _, wanted in sorted(found.values(), key=itemgetter(0), reverse=True)]
        for item, _, _ in self.store.collection_items([READ_LATER]):
            if item.item_id in found or OFFLINE_KEY in item.extra or recently_failed(item, now, OFFLINE_FAILED) or is_video(item.url) or not self.readable_in_a_tab(item.url):
                continue
            newest.append(ContentWanted(item_id=item.item_id, url=item.url, video=False, purpose="offline"))
        return newest[:limit]

    def add_content(self, item_id: str, purpose: Literal["summary", "note", "offline"], title: str, text: str, caption_url: str | None) -> str:
        """The full text of an item, or its video's captions: a summary on its card, a note in today's journal, or an
        offline copy kept with the item (no model needed). Returns what happened: summarized, noted, saved, empty or
        the model's problem."""
        item = self.store.get_item(item_id)
        if item is None:
            raise BadInput("That item is gone.")
        if purpose == "offline":
            blocks = offline_blocks(text)
            if not blocks:
                self.store.update_extra(item_id, {OFFLINE_FAILED: self.clock().isoformat()})
                return "empty"
            self.store.update_extra(item_id, {"blocks": json.dumps(blocks), OFFLINE_KEY: self.clock().isoformat()})
            return "saved"
        if caption_url and caption_allowed(caption_url, self.youtube_base):
            text = self.captions(caption_url) or text
        if not text.strip():
            if purpose == "summary":
                self.store.update_extra(item_id, {CONTENT_FAILED: self.clock().isoformat()})
            return "empty"
        try:
            summary = self.gateway.complete_json("fast", "summarize", summary_prompt(item, title, text), True, ContentSummary)
        except LlmError as error:
            if purpose == "summary":
                self.store.update_extra(item_id, {CONTENT_FAILED: self.clock().isoformat()})
            return f"failed: {error}"
        if purpose == "summary":
            self.store.update_extra(item_id, summary_extra(summary))
            return "summarized"
        line = WHITESPACE.sub(" ", f"note: {title or item.title or item.url}: {summary.summary}").strip()
        self.memory.append_journal(self.clock(), f"{line} ({item.url})")
        return "noted"

    def ask(self, question: str) -> Answer:
        """Your question answered from the items you were shown and your journal, with citations. Nothing found means
        no model call at all."""
        items = [hit.item for hit in self.search(question, MAX_SOURCES)]
        journal = matching_lines(self.paths.journal, question, MAX_SOURCES)
        if not items and not journal:
            return Answer(answer="Nothing you read or noted matches that.")
        reply = self.gateway.complete_json("fast", "ask", answer_prompt(question, items, journal), True, AnswerReply)
        return cited(reply, items)

    def shop_urls(self, compiled: CompiledView) -> list[str]:
        """The store pages a view reads for what it last shopped for; none before you shop."""
        query = self.shop_state().queries.get(compiled.view_id, "")
        return search_urls([store for source in compiled.sources for store in source.stores], query) if query else []

    def shop_state(self) -> ShopState:
        try:
            return ShopState.model_validate(read_json(self.paths.state / "shop.json", {}))
        except ValueError:
            return ShopState()

    def shop(self, query: str, view_id: str | None = None) -> ShopStart:
        """Shopping for your words: in the view given when it has stores, else the first view that does, else a new
        Shop view from its template. The view then reads each store's search page for them."""
        query = WHITESPACE.sub(" ", query).strip()[:MAX_QUERY]
        if not query:
            raise BadInput("Say what to shop for, such as /shop desk lamp.")
        views = self.compiler.all_compiled(use_model=False)
        shopping = [compiled.view_id for compiled in views if any(source.stores for source in compiled.sources)]
        created = False
        if view_id in shopping:
            chosen = view_id
        elif shopping:
            chosen = shopping[0]
        else:
            chosen, created = self.create_view("shop", "Shop").view_id, True
        with self.lock:
            state = self.shop_state()
            state.queries[chosen] = query
            write_atomic(self.paths.state / "shop.json", state.model_dump_json())
        return ShopStart(view_id=chosen, query=query, created=created)

    def save_item(self, name: str, item_id: str, saved: bool = True) -> CollectionInfo:
        """Puts an item in a collection, or takes it out."""
        name = collection_name(name)
        if not is_collection_name(name):
            raise BadInput("A collection needs a name of letters and digits, such as read later.")
        if self.store.get_item(item_id) is None:
            raise BadInput("That item is gone.")
        if saved:
            self.store.add_to_collection(name, item_id, self.clock())
        else:
            self.store.remove_from_collection(name, item_id)
        return next(info for info in self.collections(include=name) if info.name == name)

    def collections(self, include: str | None = None) -> list[CollectionInfo]:
        """Every collection with items, and the views that read each."""
        counts = self.store.collection_counts()
        if include:
            counts.setdefault(include, 0)
        readers: dict[str, list[str]] = {}
        for compiled in self.compiler.all_compiled(use_model=False):
            for name in (name for source in compiled.sources for name in source.collections):
                readers.setdefault(name, []).append(compiled.view_id)
        return [CollectionInfo(name=name, title=collection_title(name), count=count, views=readers.get(name, [])) for name, count in sorted(counts.items())]

    def export(self, fmt: Literal["md", "json"], collection: str | None = None, view_id: str | None = None) -> Path:
        """A collection, or what a view shows now, as a Markdown or JSON file in exports/ of your openMoi folder."""
        now = self.clock()
        if collection:
            name = collection_name(collection)
            entries = [(item, added_at) for item, _, added_at in self.store.collection_items([name])]
            title, stem = collection_title(name), name
        elif view_id:
            page = self.view_page(check_view_id(view_id), [], MAX_EXPORT)
            entries = [(view_item.item, view_item.item.fetched_at) for view_item in page.items]
            title, stem = self.compiler.compiled(view_id).title, view_id
        else:
            raise BadInput("Say which collection or view to export.")
        text = export_markdown(title, entries, now) if fmt == "md" else export_json(title, entries, now)
        path = self.paths.home / "exports" / f"{stem}_{now.astimezone():%Y%m%d_%H%M%S}.{fmt}"
        path.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(path, text)
        return path

    def highlight(self, item_id: str, quote: str, note: str = "") -> str:
        """A passage you marked in something you read, with your note: a line in memory/highlights.md and today's
        journal, so chat can find it later."""
        item = self.store.get_item(item_id)
        if item is None:
            raise BadInput("That item is gone.")
        quote, note = WHITESPACE.sub(" ", quote).strip()[:MAX_HIGHLIGHT], WHITESPACE.sub(" ", note).strip()[:MAX_HIGHLIGHT]
        if not quote and not note:
            raise BadInput("Mark some text or write a note first.")
        title = WHITESPACE.sub(" ", item.title or item.text or item.url).strip()[:120]
        parts = [f'"{quote}"' if quote else "", f"note: {note}" if note else ""]
        line = f"highlight: {' '.join(part for part in parts if part)} from {title} ({item.url})"
        self.memory.add_highlight(self.clock(), line)
        self.memory.append_journal(self.clock(), line)
        return line

    def captions(self, caption_url: str) -> str:
        """A video's transcript from YouTube's caption address, or empty when it cannot be had."""
        try:
            response = self.http.get(caption_url, params={"fmt": "json3"})
            response.raise_for_status()
            return transcript_text(response.json())
        except (httpx.HTTPError, ValueError):
            return ""

    def notes_wanted(self, events: list[Event]) -> list[str]:
        """Items just opened that a note rule of their view covers."""
        now = self.clock()
        wanted = []
        opened = self.store.get_items([event.item_id for event in events if event.event_kind == "open" and event.item_id])
        for event in events:
            item = opened.get(event.item_id or "")
            if item is None or event.event_kind != "open" or not self.readable_in_a_tab(item.url):
                continue
            rules = [rule for rule in self.compiler.compiled(check_view_id(event.view_id)).rules if rule.do == "note"]
            if any(applies(rule, item, now, self.circles()) for rule in rules):
                wanted.append(item.item_id)
        return wanted

    def watches_due(self) -> list[PageSource]:
        """Watched pages whose time for another look has come, once each however many views watch them."""
        now = self.clock()
        due: dict[str, PageSource] = {}
        for compiled in self.compiler.all_compiled(use_model=False):
            for source in compiled.sources:
                for watch in source.watches:
                    last = self.store.watch_text(watch.url)
                    if policy_for(self.policies, watch.url).status != "active":
                        continue
                    if last is None or now - last[1] >= timedelta(minutes=watch.every_minutes):
                        due[watch.url] = self.watch_source(watch.url)
        return list(due.values())

    def watch_report(self, url: str, title: str, text: str) -> WatchReport:
        """A watched page's text now. The first look is the baseline; a change becomes the page's one change item, and an
        alert when a view that watches the page lets that item through its rules."""
        now = self.clock()
        lines = watch_lines(text)
        last = self.store.watch_text(url)
        before = last[0].splitlines() if last else None
        changed = before is not None and lines != before
        self.store.save_watch(url, "\n".join(lines), now, changed)
        if not changed:
            return WatchReport(changed=False)
        source_id = watch_source_id(url)
        added, removed = changed_lines(before or [], lines)
        item = enriched(change_item(source_id, url, title, added, removed, now))
        self.store.replace_item(item)
        kind, (vector,) = make_vectors(self.gateway, [story_text(item)], "embed_items")
        self.store.save_vectors({item.item_id: (kind, packed(vector))})
        alert = self.alert_for(item)
        self.tagger.enqueue([item])
        return WatchReport(changed=True, alert=alert)

    def alert_for(self, item: Item) -> WatchAlert | None:
        """The first view watching the page whose rules keep the change; topic and judged rules get it tagged at once.
        Each view's rules are waited for, so a compile running in another thread never lets an alert through unjudged."""
        watching = [view.view_id for view in self.compiler.all_compiled(use_model=False) if item.source_id in view.source_ids()]
        for view_id in watching:
            compiled = self.compiler.compiled(view_id)
            judged = item
            if needs_tags(compiled):
                [judged] = self.tagger.tag([item], self.watch_list(), self.watch_judgments())
                if not judged.tagged:
                    return WatchAlert(view_id=compiled.view_id, title=item.title or "", text=item.text or "", checked=False)
                self.store.update_tags([judged])
            ranked, _ = rank([judged], compiled.rules, self.clock(), circles=self.circles())
            if ranked:
                return WatchAlert(view_id=compiled.view_id, title=item.title or "", text=item.text or "")
        return None

    def circles(self) -> Circles:
        people = frozenset(handle.lstrip("@").lower() for handle in HANDLE.findall(self.memory.topic_text("people.md")))
        return Circles(people=people, following=self.store.follows())

    def ingest(self, source_id: str, records: list[dict[str, Any]], page_url: str | None = None) -> list[Item]:
        self.source_status[(source_id, source_id)] = "ok"
        return self.store_records(source_id, records, page_url)

    def ingest_page(self, view_id: str, source_id: str, records: list[dict[str, Any]], page_url: str | None) -> tuple[list[Item], list[ViewItem]]:
        """A Mine page: its items in page order, filtered and boosted by the site view's rules.

        Topic rules need tags before the page can be shown, so those pages are tagged right away.
        """
        compiled = self.compiler.compiled(check_view_id(view_id))
        items = self.store_records(source_id, records, page_url, tag_now=needs_tags(compiled))
        ranked, _ = rank(items, compiled.rules, self.clock(), limit=len(items), order="page", circles=self.circles())
        return items, ranked

    def lens_state(self, view_id: str, kind: str) -> tuple[bool, str]:
        """Whether the lens for this view and kind is stale, plus the layout hash it should be built for."""
        compiled = self.compiler.compiled(check_view_id(view_id))
        return self.lenses.is_stale(lens_key(view_id, kind), compiled.layout, compiled.layout_hash), compiled.layout_hash

    def generate_lens(self, view_id: str, kind: str, last_error: str | None) -> tuple[str, str]:
        """A new lens for the view's Layout as it is now, and the hash of that Layout, to accept it under."""
        compiled = self.compiler.compiled(check_view_id(view_id))
        current = self.lenses.html(lens_key(view_id, kind))
        tokens = self.paths.lens_tokens.read_text() if self.paths.lens_tokens.exists() else ""
        html = generate_lens(self.gateway, compiled.layout, kind, self.paths.default_lens.read_text(), last_error, current, tokens)
        return html, compiled.layout_hash

    def judge_lens(self, view_id: str, kind: str, screenshot: bytes) -> LensVerdict:
        compiled = self.compiler.compiled(check_view_id(view_id))
        return judge_lens(self.gateway, compiled.layout, kind, screenshot)

    def accept_lens(self, view_id: str, kind: str, html: str, layout_hash: str | None = None) -> int:
        """Makes a lens live, marked with the Layout it was made for: a Layout edited meanwhile still shows as stale."""
        compiled = self.compiler.compiled(check_view_id(view_id))
        return self.lenses.save(lens_key(view_id, kind), html, layout_hash or compiled.layout_hash)

    def generate_extractor(self, url: str, skeleton: str, last_error: str | None) -> ExtractorSpec:
        return generate_spec(self.gateway, url, skeleton, last_error)

    def view_page(
        self, view_id: str, exclude_ids: list[str], limit: int = PAGE_SIZE, order: Order = "recency"
    ) -> ViewPage:
        compiled = self.compiler.compiled(view_id)
        self.retag_if_needed()
        now = self.clock()
        shop_ids = [shop_source_id(url) for url in self.shop_urls(compiled)]
        entries = self.store.items_with_seen([*compiled.source_ids(), *shop_ids], now - VIEW_WINDOW)
        # A view of nothing but stores lists products in each store's own order.
        if compiled.sources and all(source.source_id == "shop" for source in compiled.sources):
            order = "page"
        kept_names = [name for source in compiled.sources for name in source.collections]
        kept_entries = self.store.collection_items(kept_names)
        kept = {item.item_id for item, _, _ in kept_entries}
        if kept_names:
            listed = {item.item_id for item, _ in entries}
            entries += [(item, seen_at) for item, seen_at, _ in kept_entries if item.item_id not in listed]
            # A view of nothing but collections lists them newest saved first.
            if all(source.source_id == "collection" for source in compiled.sources):
                order = "page"
        edition = self.editions.current(view_id, compiled.time, now) if compiled.time.editions else None
        if edition:
            entries = [(item, seen_at) for item, seen_at in entries if item.fetched_at <= edition.cutoff]
        items = [item for item, _ in entries]
        # What you keep in a collection stays until you take it out, seen or not.
        long_seen = seen_long_ago(entries, max(now - SEEN_KEEP, edition.at) if edition else now - SEEN_KEEP) - kept
        if needs_tags(compiled) and self.tagger.healthy:
            items = [item for item in items if item.tagged and is_judged(item, compiled.judgments)]
        circles = self.circles()
        if edition and compiled.time.edition_size:
            items = edition_items(compiled.time.edition_size, edition, entries, items, exclude_ids, compiled.rules, now, long_seen, circles)
        seen = {item.item_id for item, seen_at in entries if seen_at}
        ranked, has_more = rank(items, compiled.rules, now, set(exclude_ids) | long_seen, limit, order, circles, seen, self.ranker, compiled.explore)
        saved_in = self.store.collections_of([view_item.item.item_id for view_item in ranked])
        ranked = [view_item.model_copy(update={"collections": saved_in.get(view_item.item.item_id, [])}) for view_item in ranked]
        ranked = self.with_price_notes(ranked)
        with self.lock:
            reading = view_id in self.refreshing
            refreshing = reading or self.tagger.busy or self.updater.busy
        source_ids = set(compiled.source_ids())
        current = {(source_id, location) for source_id, location, _ in self.feed_readers(compiled)} | {(source_id, source_id) for source_id in source_ids}
        problems = [f"{source_id}: {status}" for source_id, status in self.status_by_source(current).items() if status != "ok"]
        if not self.tagger.healthy:
            problems.append(self.tagger.status)
        if circles.empty and any(condition.field == "author_in" for rule in compiled.rules for condition in rule.conditions()):
            problems.append(NOBODY_KNOWN)
        problems += self.policy_warnings(compiled) + self.judgment_conflicts(compiled)
        return ViewPage(
            view_id=view_id,
            items=ranked,
            has_more=has_more,
            refreshing=refreshing,
            caught_up=not has_more and not refreshing,
            summary=compiled.summary,
            warnings=[*compiled.warnings, *problems, *self.settings_problems],
            version=compiled.file_hash,
            layout_hash=compiled.layout_hash,
            lens_stale=self.lenses.is_stale(lens_key(view_id, "feed"), compiled.layout, compiled.layout_hash),
            keep_rate=kept_share(items, compiled.rules, now, circles),
            reading=reading,
            edition=edition.at if edition else None,
            next_edition=edition.next_at if edition else None,
        )

    def schedules(self) -> list[ViewSchedule]:
        """Views with a Time section; read_for is set while an edition's read is due. Never asks the model."""
        now = self.clock()
        lead = LOCAL_LEAD if self.model_settings().fast.local else LEAD
        found = []
        for compiled in self.compiler.all_compiled(use_model=False):
            time = compiled.time
            if not (time.editions or time.visit_minutes):
                continue
            edition = self.editions.current(compiled.view_id, time, now) if time.editions else None
            found.append(
                ViewSchedule(
                    view_id=compiled.view_id,
                    title=compiled.title,
                    edition=edition.at if edition else None,
                    next_edition=edition.next_at if edition else None,
                    read_for=self.editions.due(compiled.view_id, time, now, lead) if time.editions else None,
                    visit_minutes=time.visit_minutes,
                )
            )
        return found

    def open_early(self, view_id: str) -> None:
        """Show what arrived since the edition on show came out, now; it counts in the mirror as an early opening."""
        compiled = self.compiler.compiled(check_view_id(view_id))
        now = self.clock()
        edition = self.editions.current(view_id, compiled.time, now) if compiled.time.editions else None
        if edition is None:
            raise BadInput(f"{view_id} does not come out in editions")
        self.editions.open_early(view_id, edition.at, now)
        self.store.add_moment(view_id, "early", now)

    def add_moment(self, view_id: str, kind: MomentKind) -> None:
        self.store.add_moment(check_view_id(view_id), kind, self.clock())

    def mirror(self, days: int = 7) -> Mirror:
        now = self.clock()
        days = min(max(days, 1), MAX_DAYS)
        since = now - timedelta(days=days)
        views = self.compiler.all_compiled(use_model=False)
        return build_mirror(days, now, self.store.fetched_since(since), self.store.opened_since(since), views, self.watch_judgments(), self.circles(), self.store.moment_counts(since))

    def weekly_mirror(self) -> Mirror | None:
        """The last week's mirror, once a week. The first launch starts the week; a week with nothing to show stays quiet."""
        state = read_json(self.paths.mirror_state, None)
        shown = state.get("shown_at") if isinstance(state, dict) else None
        now = self.clock()
        try:
            started = datetime.fromisoformat(shown) if isinstance(shown, str) else None
        except ValueError:
            started = None
        if started is not None and now - started < MIRROR_EVERY:
            return None
        write_atomic(self.paths.mirror_state, json.dumps({"shown_at": now.isoformat()}))
        mirror = self.mirror(7)
        return mirror if state is not None and (mirror.sources or mirror.views) else None

    def schedule_done(self, view_id: str, edition: datetime) -> None:
        """The read for this edition finished; one that finished after the edition came out moves it to now."""
        self.editions.done(check_view_id(view_id), edition, self.clock())

    def record_events(self, events: list[Event]) -> None:
        """Store events, teach the ranker from them and give every item you open a line in today's journal."""
        now = self.clock()
        self.store.add_events(events, now)
        taught = self.store.get_items([event.item_id for event in events if event.item_id])
        self.ranker.learn((features(taught[event.item_id], now), event.event_kind) for event in events if event.item_id in taught)
        opened = self.store.get_items([event.item_id for event in events if event.event_kind == "open" and event.item_id])
        for item in opened.values():
            self.memory.append_journal(now, f"opened: {item.title or (item.text or '')[:80]} ({item.url})")

    def propose_edit(self, view_id: str, request: str, item_id: str | None, scope: EditScope = "any") -> Proposal:
        """Chat: the editor sees the last two weeks of the journal and older lines that share words with the request."""
        item = self.store.get_item(item_id) if item_id else None
        older = matching_lines(self.paths.journal, request)
        return self.editor.propose(check_view_id(view_id), request, item, self.memory.journal_lines(self.clock()), scope, older)

    def import_view(self, name: str, text: str | None, url: str | None) -> Proposal:
        """A view someone shared, from a dropped file or a link: cleaned to a view's own sections and proposed as a new
        view file you confirm. The proposal says which sources it would read in your session."""
        if url:
            text = self.fetch_shared(url)
        cleaned = clean_import(text or "")
        if cleaned is None:
            raise BadInput("That is not an openMoi view: it has no Sources or Rules section.")
        title, view_text = cleaned
        base = view_name(name or title)
        view_id = next(candidate for candidate in (base, *(f"{base}_{number}" for number in range(2, 100))) if not (self.paths.views / f"{candidate}.md").exists())
        reads = session_reads(view_text)
        reply = f"{title} as a new view, {view_id}. Its look is made fresh from its Layout."
        if reads:
            reply += f" It reads these in your own sessions: {'; '.join(reads)}."
        return self.editor.propose_file(view_id, view_text, reply)

    def fetch_shared(self, url: str) -> str:
        """A shared view from a public https link: no redirects, nothing on this machine or your network, at most 20k."""
        if not url.startswith("https://"):
            raise BadInput("A shared view link must start with https://.")
        if is_private_host(urlparse(url).hostname or ""):
            raise BadInput("A shared view link must point to a public site.")
        try:
            with self.http.stream("GET", url, follow_redirects=False) as response:
                if response.is_redirect:
                    raise BadInput("That link redirects; use the address it leads to.")
                response.raise_for_status()
                if not response.headers.get("content-type", "text/plain").startswith(("text/", "application/octet-stream")):
                    raise BadInput("That link is not a text file.")
                text = ""
                for chunk in response.iter_text():
                    text += chunk
                    if len(text) >= MAX_IMPORT:
                        break
        except httpx.HTTPError as error:
            raise BadInput(f"Could not fetch {url}: {error}") from error
        return text[:MAX_IMPORT]

    def import_history(self, name: str, text: str) -> tuple[str, int]:
        """A data export you dropped (Facebook posts or events, Amazon orders): its records stored under its history
        source. Returns the source id and how many items it holds now."""
        found = read_export(name, text)
        if found is None:
            raise BadInput("That file is not a data export openMoi knows: Facebook's your_posts or your_events JSON, or Amazon's order history CSV.")
        kind, records = found
        items = self.store_records(SOURCE_IDS[kind], records)
        return SOURCE_IDS[kind], len({item.item_id for item in items})

    def subscriptions(self) -> list[str]:
        """The channels "YouTube: subscriptions" means: your Google account's (refreshed daily), else a Takeout file's."""
        cached = read_json(self.paths.google_subscriptions, {})
        channels = cached.get("channels") if isinstance(cached, dict) else None
        if self.google.connected and isinstance(channels, list):
            return [str(channel) for channel in channels]
        return read_takeout(self.paths.takeout)

    def roll_up_journal(self) -> list[str]:
        """Months that ended before the journal's two recent weeks become one summary each; one refresh at a time does it."""
        if not self.journal_lock.acquire(blocking=False):
            return []
        try:
            return roll_up(self.paths.journal, self.clock() - timedelta(days=JOURNAL_DAYS))
        finally:
            self.journal_lock.release()

    def refresh_subscriptions(self) -> None:
        """With Google connected, your subscriptions are read again once a day; a failure keeps the last list."""
        if not self.google.connected:
            return
        cached = read_json(self.paths.google_subscriptions, {})
        try:
            last = datetime.fromisoformat(cached.get("at", "")) if isinstance(cached, dict) else None
        except ValueError:
            last = None
        if last and self.clock() - last < SUBSCRIPTIONS_EVERY:
            return
        try:
            channels = self.google.youtube_subscriptions()
        except GoogleError as error:
            self.source_status[("youtube", "subscriptions")] = str(error)
            return
        self.source_status[("youtube", "subscriptions")] = "ok"
        write_atomic(self.paths.google_subscriptions, json.dumps({"at": self.clock().isoformat(), "channels": channels}))

    def google_connect(self) -> str:
        try:
            return self.google.start()
        except GoogleError as error:
            raise BadInput(str(error)) from error

    def google_status(self) -> dict[str, Any]:
        return {"connected": self.google.connected, "status": self.google.status, "client": bool(self.google.client_id)}

    def update_packs(self) -> str:
        """Fetch the pack channel's newest pack and install it if it is signed with openMoi's key and newer."""
        url = self.gateway.settings.pack_url
        if not url:
            return "no pack channel"
        key = public_key(self.paths.pack_key)
        if key is None:
            return "packs are off: openMoi ships without a pack key"
        try:
            data = self.http.get(url).raise_for_status().content
            signature = self.http.get(f"{url}.sig").raise_for_status().content
            pack = verified_pack(data, signature, key)
        except (httpx.HTTPError, PackError) as error:
            return f"pack refused: {error}"
        current = installed_pack(self.paths.packs)
        if current and current.pack_version >= pack.pack_version:
            return f"pack v{current.pack_version} is current"
        install(pack, self.paths.packs)
        self.policies = merged_policy(load_policy(self.paths.site_policy), pack)
        return f"installed pack v{pack.pack_version}"

    def share_view(self, view_id: str) -> str:
        """A copy of a view to send to someone, in ~/openMoi/shared, without people, following lists or watched pages."""
        text = self.compiler.view_text(check_view_id(view_id))
        if not text:
            raise BadInput(f"There is no views/{view_id}.md to share.")
        target = self.paths.home / "shared" / f"{view_id}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(target, share_text(text, people_names(self.memory.topic_text("people.md"))))
        return str(target)

    def collection_view(self, name: str) -> ViewInfo:
        """A view that reads one collection, as a new tab: what you asked for by making a tab for it."""
        name = collection_name(name)
        if not is_collection_name(name):
            raise BadInput("A collection needs a name of letters and digits, such as read later.")
        path = self.paths.views / f"{name}.md"
        if path.exists():
            raise BadInput(f"views/{name}.md already exists")
        title = collection_title(name)
        write_atomic(path, f"# {title}\n\n## Sources\n* Collection: {title.lower()}\n\n## Rules\n\n## Layout\n")
        return ViewInfo(view_id=name, title=title)

    def create_view(self, view_id: str, title: str | None) -> ViewInfo:
        """A new empty view file, which becomes a new tab."""
        if check_view_id(view_id).startswith(SITE_PREFIX):
            raise BadInput("site_ views are made by Mine; pick another name")
        path = self.paths.views / f"{view_id}.md"
        if path.exists():
            raise BadInput(f"views/{view_id}.md already exists")
        # Watch, Read and Shop start from a template of their intent.
        intent = self.paths.templates / "intents" / f"{view_id}.md"
        path.write_text(intent.read_text() if intent.exists() else NEW_VIEW.format(title=title or view_id))
        return ViewInfo(view_id=view_id, title=title or view_id)

    def model_settings(self) -> ModelInfo:
        return model_info(self.gateway.settings)

    def update_model(self, change: ModelChange) -> ModelInfo:
        """Change a slot or the privacy switch; it is saved to .moi/config.json and used from the next call on."""
        settings = apply_model_change(self.gateway.settings, change)
        save_settings(self.paths, settings)
        self.gateway.settings = settings
        self.settings_problems = []
        self.tagger.retry_now()
        return model_info(settings)

    def overview(self, view_id: str) -> Overview:
        _, sections = parse_sections(self.compiler.view_text(view_id))
        return Overview(
            home=str(self.paths.home),
            view_id=view_id,
            view_file=f"views/{view_id}.md",
            sections={name: section_text(sections, name) for name in VIEW_SECTIONS},
            memory={name: self.memory.topic_text(name) for name in TOPIC_FILES},
            model=self.model_settings(),
            relay=self.relay_status(),
        )

    def apply_edit(self, proposal_id: str) -> Proposal:
        """Write the proposal, recompile its view now so problems show at once, roll the lens back if asked."""
        proposal = self.editor.apply(proposal_id)
        compiled = self.compiler.compiled(proposal.view_id)
        if proposal.lens_action == "rollback":
            for kind in LENS_KINDS:
                key = lens_key(proposal.view_id, kind)
                if self.lenses.pointer(key).version:
                    self.lenses.rollback(key, compiled.layout_hash)
        self.retag_if_needed()
        return proposal

    def lens_html(self, view_id: str, kind: str) -> str:
        return self.lenses.html(lens_key(check_view_id(view_id), kind))

    def status_by_source(self, current: set[tuple[str, str]] | None = None) -> dict[str, str]:
        """One status per source id; when several feeds share it, a problem with any of them wins over ok.
        With current, only feeds a view still lists count, so a feed you fixed or removed stops warning."""
        merged: dict[str, str] = {}
        for key, status in list(self.source_status.items()):
            if current is not None and key not in current:
                continue
            if status != "ok" or key[0] not in merged:
                merged[key[0]] = status
        return merged

    def debug(self) -> dict[str, Any]:
        with self.lock:
            refreshing = sorted(self.refreshing)
        return {
            "store": self.store.stats(),
            "sources": self.status_by_source(),
            "tagging": self.tagger.status,
            "relay": self.relay_status(),
            "ranker": {"events": self.ranker.state.events, "trained": self.ranker.trained},
            "refreshing": refreshing,
            "llm_calls": self.gateway.recent_calls(),
        }
