"""The Brain composes storage, sources, compilation, ranking and lenses behind one object."""

import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any

import httpx
from pydantic import BaseModel

from moi_brain.compile import CompiledView, Compiler, check_view_id
from moi_brain.config import Paths, Settings, ensure_home
from moi_brain.edits import Editor, Proposal
from moi_brain.extractors import ExtractorSpec, ExtractorStore
from moi_brain.feeds import YOUTUBE_BASE, FeedError, FeedFetcher
from moi_brain.items import Event, Item, ViewItem, normalize, rss_source_id, youtube_source_id
from moi_brain.lenses import LensStore, lens_key
from moi_brain.llm import Gateway
from moi_brain.memory import Memory
from moi_brain.rank import PAGE_SIZE, Order, rank
from moi_brain.store import Store
from moi_brain.tag import Tagger, watch_list

PILOT_BUDGET = {"page_loads": 1, "scroll_steps": 5, "min_step_interval_ms": 1500}
FEED_INTERVAL = timedelta(minutes=5)
VIEW_WINDOW = timedelta(days=7)
X_DOMAIN = "x.com"
HTTP_TIMEOUT = 15.0


def utc_now() -> datetime:
    return datetime.now(UTC)


class PageSource(BaseModel):
    """A source the shell reads inside your session in a hidden source view."""

    source_id: str
    page_type: str
    start_url: str
    spec: ExtractorSpec
    budget: dict[str, int]


class ViewPage(BaseModel):
    view_id: str
    items: list[ViewItem]
    has_more: bool
    refreshing: bool
    caught_up: bool
    summary: str
    warnings: list[str]
    version: str
    lens_stale: bool = False


FeedReader = tuple[str, Callable[[], list[dict[str, Any]]]]


class Brain:
    def __init__(
        self,
        paths: Paths,
        settings: Settings,
        http: httpx.Client | None = None,
        youtube_base: str = YOUTUBE_BASE,
        clock: Callable[[], datetime] = utc_now,
    ):
        ensure_home(paths)
        self.paths = paths
        self.clock = clock
        self.http = http or httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True)
        self.store = Store(paths.db)
        self.gateway = Gateway(settings, paths.llm_log, self.http)
        self.fetcher = FeedFetcher(self.http, paths.channel_cache, youtube_base)
        self.memory = Memory(paths)
        self.compiler = Compiler(paths, self.gateway, self.memory)
        self.tagger = Tagger(self.store, self.gateway, paths.tagging_state)
        self.editor = Editor(paths, self.gateway)
        self.extractors = ExtractorStore(paths.builtin_extractors, paths.extractors)
        self.lenses = LensStore(paths.default_lens, paths.lenses)
        self.lock = threading.Lock()
        self.refreshing: set[str] = set()
        self.source_status: dict[str, str] = {}
        self.fetched_at: dict[str, datetime] = {}

    def start_refresh(self, view_id: str, force: bool = False) -> list[PageSource]:
        """Refresh feed sources in a background thread; returns the page sources the shell should read."""
        compiled = self.compiler.compiled(view_id)
        with self.lock:
            already_running = view_id in self.refreshing
            self.refreshing.add(view_id)
        if not already_running:
            threading.Thread(target=self.refresh_feeds, args=(view_id, compiled, force), daemon=True).start()
        return self.page_sources(compiled)

    def refresh_feeds(self, view_id: str, compiled: CompiledView, force: bool) -> None:
        try:
            for source_id, reader in self.feed_readers(compiled):
                last = self.fetched_at.get(source_id)
                if not force and last and self.clock() - last < FEED_INTERVAL:
                    continue
                try:
                    self.store_records(source_id, reader())
                    self.source_status[source_id] = "ok"
                except FeedError as error:
                    self.source_status[source_id] = str(error)
                self.fetched_at[source_id] = self.clock()
        finally:
            with self.lock:
                self.refreshing.discard(view_id)

    def feed_readers(self, compiled: CompiledView) -> list[FeedReader]:
        readers: list[FeedReader] = []
        for source in compiled.sources:
            readers += [(youtube_source_id(channel), partial(self.fetcher.fetch_youtube, channel)) for channel in source.channels]
            readers += [(rss_source_id(feed), partial(self.fetcher.fetch_rss, feed)) for feed in source.feeds]
        return readers

    def page_sources(self, compiled: CompiledView) -> list[PageSource]:
        found = []
        for source in compiled.sources:
            if source.source_id != "x":
                continue
            spec = self.extractors.for_page_type(X_DOMAIN, source.page_type or "home_timeline")
            if spec and spec.start_url:
                found.append(PageSource(source_id="x", page_type=spec.page_type, start_url=spec.start_url, spec=spec, budget=PILOT_BUDGET))
        return found

    def store_records(self, source_id: str, records: list[dict[str, Any]], page_url: str | None = None) -> list[Item]:
        """Normalize, tag the new ones and store; returns every item with its topics, new or already known."""
        now = self.clock()
        normalized = [normalize(source_id, record, now, page_url) for record in records]
        items = list({item.item_id: item for item in normalized if item}.values())
        known = self.store.get_items([item.item_id for item in items])
        fresh = [item for item in items if item.item_id not in known]
        tagged = {item.item_id: item for item in self.tagger.tag(fresh, self.watch_list())}
        self.store.upsert_items(list(tagged.values()))
        return [known.get(item.item_id) or tagged[item.item_id] for item in items]

    def watch_list(self) -> list[str]:
        return watch_list(self.compiler.all_compiled())

    def ingest(self, source_id: str, records: list[dict[str, Any]], page_url: str | None = None) -> list[Item]:
        self.source_status[source_id] = "ok"
        return self.store_records(source_id, records, page_url)

    def view_page(
        self, view_id: str, exclude_ids: list[str], limit: int = PAGE_SIZE, order: Order = "recency"
    ) -> ViewPage:
        compiled = self.compiler.compiled(view_id)
        self.tagger.ensure_current(self.watch_list(), self.clock())
        items = self.store.items_for_sources(compiled.source_ids(), self.clock() - VIEW_WINDOW)
        ranked, has_more = rank(items, compiled.rules, self.clock(), set(exclude_ids), limit, order)
        with self.lock:
            refreshing = view_id in self.refreshing or self.tagger.retagging
        source_ids = set(compiled.source_ids())
        problems = [f"{source_id}: {status}" for source_id, status in self.source_status.items() if source_id in source_ids and status != "ok"]
        if self.tagger.status != "ok":
            problems.append(self.tagger.status)
        return ViewPage(
            view_id=view_id,
            items=ranked,
            has_more=has_more,
            refreshing=refreshing,
            caught_up=not has_more and not refreshing,
            summary=compiled.summary,
            warnings=[*compiled.warnings, *problems],
            version=compiled.file_hash,
            lens_stale=self.lenses.is_stale(view_id, compiled.layout, compiled.layout_hash),
        )

    def record_events(self, events: list[Event]) -> None:
        """Store events; every item you open also gets a line in today's journal."""
        now = self.clock()
        self.store.add_events(events, now)
        opened = self.store.get_items([event.item_id for event in events if event.event_kind == "open" and event.item_id])
        for item in opened.values():
            self.memory.append_journal(now, f"opened: {item.title or (item.text or '')[:80]} ({item.url})")

    def propose_edit(self, view_id: str, request: str, item_id: str | None) -> Proposal:
        item = self.store.get_item(item_id) if item_id else None
        return self.editor.propose(check_view_id(view_id), request, item)

    def apply_edit(self, proposal_id: str) -> Proposal:
        """Write the proposal, recompile its view now so problems show at once, roll the lens back if asked."""
        proposal = self.editor.apply(proposal_id)
        compiled = self.compiler.compiled(proposal.view_id)
        if proposal.lens_action == "rollback":
            self.lenses.rollback(lens_key(proposal.view_id, "feed"), compiled.layout_hash)
        self.tagger.ensure_current(self.watch_list(), self.clock())
        return proposal

    def lens_html(self, view_id: str, kind: str) -> str:
        return self.lenses.html(lens_key(check_view_id(view_id), kind))

    def debug(self) -> dict[str, Any]:
        with self.lock:
            refreshing = sorted(self.refreshing)
        return {
            "store": self.store.stats(),
            "sources": dict(self.source_status),
            "tagging": self.tagger.status,
            "refreshing": refreshing,
            "llm_calls": self.gateway.recent_calls(),
        }
