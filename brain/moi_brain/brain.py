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
from moi_brain.extractor_gen import generate_spec
from moi_brain.extractors import ExtractorSpec, ExtractorStore
from moi_brain.feeds import YOUTUBE_BASE, FeedError, FeedFetcher
from moi_brain.items import Event, Item, ViewItem, normalize, rss_source_id, youtube_source_id
from moi_brain.lens_gen import generate_lens
from moi_brain.lenses import LENS_KINDS, LensStore, lens_key
from moi_brain.llm import Gateway
from moi_brain.memory import Memory
from moi_brain.rank import PAGE_SIZE, Order, rank
from moi_brain.store import Store
from moi_brain.tag import Tagger, rule_topics, watch_list

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
    layout_hash: str
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
        self.tagger = Tagger(self.store, self.gateway, paths.tagging_state, self.watch_list)
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

    def store_records(self, source_id: str, records: list[dict[str, Any]], page_url: str | None = None, tag_now: bool = False) -> list[Item]:
        """Normalize and store; new items are tagged by the background worker, or right away when tag_now is set.

        Returns every item in record order, new or already known.
        """
        now = self.clock()
        normalized = [normalize(source_id, record, now, page_url) for record in records]
        items = list({item.item_id: item for item in normalized if item}.values())
        known = self.store.get_items([item.item_id for item in items])
        fresh = [item for item in items if item.item_id not in known]
        if tag_now:
            fresh = self.tagger.tag(fresh, self.watch_list())
        self.store.upsert_items(fresh)
        if not tag_now:
            self.tagger.enqueue(fresh)
        fresh_by_id = {item.item_id: item for item in fresh}
        return [known.get(item.item_id) or fresh_by_id[item.item_id] for item in items]

    def watch_list(self) -> list[str]:
        return watch_list(self.compiler.all_compiled())

    def ingest(self, source_id: str, records: list[dict[str, Any]], page_url: str | None = None) -> list[Item]:
        self.source_status[source_id] = "ok"
        return self.store_records(source_id, records, page_url)

    def ingest_page(self, view_id: str, source_id: str, records: list[dict[str, Any]], page_url: str | None) -> tuple[list[Item], list[ViewItem]]:
        """A Mine page: its items in page order, filtered and boosted by the site view's rules.

        Topic rules need tags before the page can be shown, so those pages are tagged right away.
        """
        compiled = self.compiler.compiled(check_view_id(view_id))
        items = self.store_records(source_id, records, page_url, tag_now=bool(rule_topics(compiled.rules)))
        ranked, _ = rank(items, compiled.rules, self.clock(), limit=len(items), order="page")
        return items, ranked

    def lens_state(self, view_id: str, kind: str) -> tuple[bool, str]:
        """Whether the lens for this view and kind is stale, plus the layout hash it should be built for."""
        compiled = self.compiler.compiled(check_view_id(view_id))
        return self.lenses.is_stale(lens_key(view_id, kind), compiled.layout, compiled.layout_hash), compiled.layout_hash

    def generate_lens(self, view_id: str, kind: str, last_error: str | None) -> str:
        compiled = self.compiler.compiled(check_view_id(view_id))
        return generate_lens(self.gateway, compiled.layout, kind, self.paths.default_lens.read_text(), last_error)

    def accept_lens(self, view_id: str, kind: str, html: str) -> int:
        compiled = self.compiler.compiled(check_view_id(view_id))
        return self.lenses.save(lens_key(view_id, kind), html, compiled.layout_hash)

    def generate_extractor(self, url: str, skeleton: str, last_error: str | None) -> ExtractorSpec:
        return generate_spec(self.gateway, url, skeleton, last_error)

    def view_page(
        self, view_id: str, exclude_ids: list[str], limit: int = PAGE_SIZE, order: Order = "recency"
    ) -> ViewPage:
        compiled = self.compiler.compiled(view_id)
        self.tagger.ensure_current(self.watch_list(), self.clock())
        items = self.store.items_for_sources(compiled.source_ids(), self.clock() - VIEW_WINDOW)
        if rule_topics(compiled.rules) and self.tagger.healthy:
            items = [item for item in items if item.tagged]
        ranked, has_more = rank(items, compiled.rules, self.clock(), set(exclude_ids), limit, order)
        with self.lock:
            refreshing = view_id in self.refreshing or self.tagger.busy
        source_ids = set(compiled.source_ids())
        problems = [f"{source_id}: {status}" for source_id, status in self.source_status.items() if source_id in source_ids and status != "ok"]
        if not self.tagger.healthy:
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
            layout_hash=compiled.layout_hash,
            lens_stale=self.lenses.is_stale(lens_key(view_id, "feed"), compiled.layout, compiled.layout_hash),
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
            for kind in LENS_KINDS:
                key = lens_key(proposal.view_id, kind)
                if self.lenses.pointer(key).version:
                    self.lenses.rollback(key, compiled.layout_hash)
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
