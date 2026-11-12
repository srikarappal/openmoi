"""SQLite storage for items and events. Everything else openMoi keeps is a file."""

import re
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

from moi_brain.enrich import with_judged_rage
from moi_brain.items import JUDGED_PREFIX, MAIL_ORDERS, Event, Item

ITEM_TTL = timedelta(days=30)
ITEM_COLUMNS = "item_id, source_id, url, published_at, fetched_at, seen_at, item_json"
# An item is one URL per source, so the same article in two sources is stored for both (a view shows it once).
# listed_at is the last time a source still listed it; items expire a month after that, not after first being seen.
ITEMS_TABLE = """
CREATE TABLE IF NOT EXISTS items (
    item_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    listed_at TEXT,
    seen_at TEXT,
    item_json TEXT NOT NULL,
    UNIQUE (source_id, url)
)
"""
EVENTS_TABLE = """
CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    view_id TEXT NOT NULL,
    item_id TEXT,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('open', 'seen', 'less_like_this'))
)
"""
# Accounts you follow, one row per list that names them; an account no list named for a month is dropped.
FOLLOWS_TABLE = """
CREATE TABLE IF NOT EXISTS follows (
    host TEXT NOT NULL,
    handle TEXT NOT NULL,
    list_url TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (host, handle, list_url)
)
"""
FOLLOW_LISTS_TABLE = "CREATE TABLE IF NOT EXISTS follow_lists (list_url TEXT PRIMARY KEY, read_at TEXT NOT NULL)"
# Each item's vector, for clustering and search; kind says how it was made, so vectors of two kinds are never compared.
VECTORS_TABLE = "CREATE TABLE IF NOT EXISTS vectors (item_id TEXT PRIMARY KEY, kind TEXT NOT NULL, vector BLOB NOT NULL)"
# Words of every item for search.
SEARCH_TABLE = "CREATE VIRTUAL TABLE IF NOT EXISTS items_search USING fts5(item_id UNINDEXED, title, text, author)"
# The last text of each watched page, to tell what changed.
WATCHES_TABLE = """
CREATE TABLE IF NOT EXISTS watches (
    url TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    changed_at TEXT
)
"""
# Items you keep in named lists, Read later and the like; an item in a list never expires.
COLLECTIONS_TABLE = """
CREATE TABLE IF NOT EXISTS collections (
    name TEXT NOT NULL,
    item_id TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (name, item_id)
)
"""
# Prices you saw for each product, one row per change or per day, for "the lowest you have seen".
PRICES_TABLE = """
CREATE TABLE IF NOT EXISTS prices (
    product_key TEXT NOT NULL,
    amount REAL NOT NULL,
    symbol TEXT NOT NULL,
    seen_at TEXT NOT NULL
)
"""
# How you used a view: a visit started, five more minutes taken, an edition opened before it came out.
MOMENTS_TABLE = """
CREATE TABLE IF NOT EXISTS moments (
    ts TEXT NOT NULL,
    view_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('visit', 'extended', 'early'))
)
"""
# What a mentions recipe found an item naming, and what it was looked up as in the recipe's target source: a target
# item once found (or found to be missing: resolved with no target), nothing while it waits.
ENTITY_LINKS_TABLE = """
CREATE TABLE IF NOT EXISTS entity_links (
    item_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    target_source_id TEXT NOT NULL,
    target_item_id TEXT,
    confidence REAL NOT NULL,
    resolved_at TEXT,
    PRIMARY KEY (item_id, entity, target_source_id)
)
"""
# Items a mentions recipe already read for names, with or without any, so none is read twice.
MENTION_CHECKS_TABLE = "CREATE TABLE IF NOT EXISTS mention_checks (item_id TEXT NOT NULL, target_source_id TEXT NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY (item_id, target_source_id))"
FOLLOW_TTL = timedelta(days=30)
HISTORY_PREFIX = "history:"
SEARCH_WORD = re.compile(r"[^\W_]+", re.UNICODE)
INDEXES = (
    "CREATE INDEX IF NOT EXISTS items_by_url ON items (url)",
    "CREATE INDEX IF NOT EXISTS items_by_source ON items (source_id, published_at)",
    "CREATE INDEX IF NOT EXISTS events_by_item ON events (item_id)",
    "CREATE INDEX IF NOT EXISTS prices_by_product ON prices (product_key, seen_at)",
)


def search_row(item: Item) -> tuple[str, str, str, str]:
    return (item.item_id, item.title or "", item.text or "", " ".join(part for part in (item.author_name, item.author_handle) if part))


def rewritten(source_id: str) -> bool:
    """Sources whose items change where they live (events, notes, files, mail) and are taken as they are now."""
    return source_id.startswith("app:") or source_id == MAIL_ORDERS


def like_prefix(text: str) -> str:
    """Text for a LIKE pattern that matches only itself: its % and _ escaped."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def iso(moment: datetime | None) -> str | None:
    """Times are stored in UTC, so comparing the stored text compares the moments."""
    if moment is None:
        return None
    return (moment.astimezone(UTC) if moment.tzinfo else moment).isoformat()


class Store:
    """One shared connection guarded by a lock; the brain is a single user process."""

    def __init__(self, db_path: Path):
        self.connection = sqlite3.connect(db_path, check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock:
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.migrate()
            with self.connection:
                self.connection.execute(EVENTS_TABLE)
                self.connection.execute(FOLLOWS_TABLE)
                self.connection.execute(FOLLOW_LISTS_TABLE)
                self.connection.execute(MOMENTS_TABLE)
                self.connection.execute(WATCHES_TABLE)
                self.connection.execute(VECTORS_TABLE)
                self.connection.execute(COLLECTIONS_TABLE)
                self.connection.execute(PRICES_TABLE)
                self.connection.execute(ENTITY_LINKS_TABLE)
                self.connection.execute(MENTION_CHECKS_TABLE)
                self.index_for_search()
                for index in INDEXES:
                    self.connection.execute(index)

    def migrate(self) -> None:
        """Databases from before listed_at kept one row per URL across all sources; rebuild them in the new shape.

        All in one transaction and a copy a crash left half done is finished on the next start."""
        tables = {row[0] for row in self.connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(items)")}
        if "items" in tables and "listed_at" not in columns:
            moves = ["ALTER TABLE items RENAME TO items_before_listed_at"]
        elif "items_before_listed_at" in tables:
            moves = []
        else:
            self.connection.execute(ITEMS_TABLE)
            return
        moves += [
            "DROP INDEX IF EXISTS items_by_url",
            "DROP INDEX IF EXISTS items_by_source",
            ITEMS_TABLE,
            f"INSERT OR IGNORE INTO items ({ITEM_COLUMNS}, listed_at) SELECT {ITEM_COLUMNS}, fetched_at FROM items_before_listed_at",
            "DROP TABLE items_before_listed_at",
        ]
        self.connection.execute("BEGIN")
        try:
            for statement in moves:
                self.connection.execute(statement)
            self.connection.commit()
        except sqlite3.Error:
            self.connection.rollback()
            raise

    def index_for_search(self) -> None:
        """The search table, made and filled from the items on first use (a database from before search)."""
        exists = self.connection.execute("SELECT 1 FROM sqlite_master WHERE name = 'items_search'").fetchone()
        self.connection.execute(SEARCH_TABLE)
        if not exists:
            rows = self.connection.execute("SELECT item_json FROM items").fetchall()
            self.connection.executemany("INSERT INTO items_search (item_id, title, text, author) VALUES (?, ?, ?, ?)", [search_row(Item.model_validate_json(row[0])) for row in rows])

    def upsert_items(self, items: list[Item], listed_at: datetime | None = None) -> list[Item]:
        """Insert items new to their source; returns only those. Every item given counts as listed at listed_at
        (by default its own fetch time), new or not, so one a feed keeps listing never expires.
        A new copy of a URL you already saw is seen too."""
        new_items = []
        with self.lock, self.connection:
            for item in items:
                listed = iso(listed_at or item.fetched_at)
                cursor = self.connection.execute(
                    "INSERT OR IGNORE INTO items (item_id, source_id, url, published_at, fetched_at, listed_at, seen_at, item_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, (SELECT MIN(seen_at) FROM items WHERE url = ?), ?)",
                    (item.item_id, item.source_id, item.url, iso(item.published_at), iso(item.fetched_at), listed, item.url, item.model_dump_json()),
                )
                if cursor.rowcount:
                    new_items.append(item)
                    self.connection.execute("INSERT INTO items_search (item_id, title, text, author) VALUES (?, ?, ?, ?)", search_row(item))
                elif rewritten(item.source_id):
                    self.rewrite(item, listed)
                else:
                    self.connection.execute(
                        "UPDATE items SET listed_at = ? WHERE item_id = ? OR (source_id = ? AND url = ?)",
                        (listed, item.item_id, item.source_id, item.url),
                    )
        return new_items

    def rewrite(self, item: Item, listed: str | None) -> None:
        """An app item read again takes what the app says now (a renamed event, an edited note), keeping the answers
        tagging gave it while its words are the same. Called with the lock held."""
        row = self.connection.execute("SELECT item_json FROM items WHERE item_id = ?", (item.item_id,)).fetchone()
        if not row:
            return
        old = Item.model_validate_json(row[0])
        same = (old.title, old.text) == (item.title, item.text)
        kept = {key: value for key, value in old.extra.items() if same and key.startswith(JUDGED_PREFIX)}
        fresh = item.model_copy(update={"topics": old.topics if same else [], "tagged": old.tagged and same, "extra": {**item.extra, **kept}, "available_actions": old.available_actions})
        self.connection.execute(
            "UPDATE items SET published_at = ?, listed_at = ?, item_json = ? WHERE item_id = ?",
            (iso(fresh.published_at), listed, fresh.model_dump_json(), fresh.item_id),
        )
        self.connection.execute("DELETE FROM items_search WHERE item_id = ?", (fresh.item_id,))
        self.connection.execute("INSERT INTO items_search (item_id, title, text, author) VALUES (?, ?, ?, ?)", search_row(fresh))

    def items_by_url(self, source_id: str, urls: list[str]) -> dict[str, Item]:
        """Stored items of one source by URL, for records whose id changed but whose URL is known."""
        if not urls:
            return {}
        marks = ", ".join("?" for _ in urls)
        with self.lock:
            rows = self.connection.execute(f"SELECT item_json FROM items WHERE source_id = ? AND url IN ({marks})", (source_id, *urls)).fetchall()
        items = [Item.model_validate_json(row[0]) for row in rows]
        return {item.url: item for item in items}

    def items_for_sources(self, source_ids: list[str], since: datetime) -> list[Item]:
        """Items from these sources published (or fetched) after since, seen or not."""
        return [item for item, _ in self.items_with_seen(source_ids, since)]

    def items_with_seen(self, source_ids: list[str], since: datetime) -> list[tuple[Item, datetime | None]]:
        """Items from these sources published (or fetched) after since, each with when you saw it. Your own history
        (from data exports) is old by nature and always counts."""
        if not source_ids:
            return []
        marks = ", ".join("?" for _ in source_ids)
        query = (
            f"SELECT item_json, seen_at FROM items WHERE source_id IN ({marks}) "
            f"AND (COALESCE(published_at, fetched_at) >= ? OR source_id LIKE '{HISTORY_PREFIX}%')"
        )
        with self.lock:
            rows = self.connection.execute(query, (*source_ids, iso(since))).fetchall()
        return [(Item.model_validate_json(item_json), datetime.fromisoformat(seen_at) if seen_at else None) for item_json, seen_at in rows]

    def recent_items(self, since: datetime) -> list[Item]:
        """Unseen items after since, newest first, so a capped retag covers what you are about to read."""
        with self.lock:
            rows = self.connection.execute(
                "SELECT item_json FROM items WHERE seen_at IS NULL AND COALESCE(published_at, fetched_at) >= ? "
                "ORDER BY COALESCE(published_at, fetched_at) DESC",
                (iso(since),),
            ).fetchall()
        return [Item.model_validate_json(row[0]) for row in rows]

    def get_items(self, item_ids: list[str]) -> dict[str, Item]:
        if not item_ids:
            return {}
        marks = ", ".join("?" for _ in item_ids)
        with self.lock:
            rows = self.connection.execute(f"SELECT item_json FROM items WHERE item_id IN ({marks})", item_ids).fetchall()
        items = [Item.model_validate_json(row[0]) for row in rows]
        return {item.item_id: item for item in items}

    def get_item(self, item_id: str) -> Item | None:
        return self.get_items([item_id]).get(item_id)

    def update_topics(self, topics_by_id: dict[str, list[str]]) -> None:
        """Save tagging results; the items count as tagged from now on."""
        with self.lock, self.connection:
            for item_id, topics in topics_by_id.items():
                row = self.connection.execute("SELECT item_json FROM items WHERE item_id = ?", (item_id,)).fetchone()
                if row:
                    item = Item.model_validate_json(row[0]).model_copy(update={"topics": topics, "tagged": True})
                    self.connection.execute("UPDATE items SET item_json = ? WHERE item_id = ?", (item.model_dump_json(), item_id))

    def items_since(self, since: datetime) -> list[tuple[Item, datetime | None]]:
        """Every item from any source published (or fetched) after since, with when you saw it."""
        with self.lock:
            rows = self.connection.execute(
                "SELECT item_json, seen_at FROM items WHERE COALESCE(published_at, fetched_at) >= ?", (iso(since),)
            ).fetchall()
        return [(Item.model_validate_json(item_json), datetime.fromisoformat(seen_at) if seen_at else None) for item_json, seen_at in rows]

    def copy_to(self, target: Path) -> None:
        """A consistent copy of the whole database, taken while nothing writes."""
        with self.lock:
            copy = sqlite3.connect(target)
            try:
                self.connection.backup(copy)
            finally:
                copy.close()

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def unchecked_for_mentions(self, item_ids: list[str], target: str) -> list[str]:
        """The items not yet read for what they name, for one target source."""
        if not item_ids:
            return []
        marks = ", ".join("?" for _ in item_ids)
        with self.lock:
            done = {row[0] for row in self.connection.execute(f"SELECT item_id FROM mention_checks WHERE target_source_id = ? AND item_id IN ({marks})", (target, *item_ids))}
        return [item_id for item_id in item_ids if item_id not in done]

    def add_mentions(self, target: str, found: dict[str, list[str]], now: datetime) -> None:
        """What each item names, waiting to be looked up in the target source; the items count as read for names."""
        with self.lock, self.connection:
            self.connection.executemany(
                "INSERT OR IGNORE INTO entity_links (item_id, entity, target_source_id, target_item_id, confidence, resolved_at) VALUES (?, ?, ?, NULL, 0, NULL)",
                [(item_id, entity, target) for item_id, entities in found.items() for entity in entities],
            )
            self.connection.executemany(
                "INSERT OR REPLACE INTO mention_checks (item_id, target_source_id, checked_at) VALUES (?, ?, ?)",
                [(item_id, target, iso(now)) for item_id in found],
            )

    def mentions_of(self, item_ids: list[str], target: str) -> dict[str, list[tuple[str, str | None, float, datetime | None]]]:
        """Per item: (entity, target item id, confidence, resolved at) for what it names, in the order found."""
        if not item_ids:
            return {}
        marks = ", ".join("?" for _ in item_ids)
        with self.lock:
            rows = self.connection.execute(
                f"SELECT item_id, entity, target_item_id, confidence, resolved_at FROM entity_links WHERE target_source_id = ? AND item_id IN ({marks}) ORDER BY rowid",
                (target, *item_ids),
            ).fetchall()
        found: dict[str, list[tuple[str, str | None, float, datetime | None]]] = {}
        for item_id, entity, target_item_id, confidence, resolved_at in rows:
            found.setdefault(item_id, []).append((entity, target_item_id, confidence, datetime.fromisoformat(resolved_at) if resolved_at else None))
        return found

    def resolve_mention(self, item_id: str, entity: str, target: str, target_item_id: str | None, confidence: float, now: datetime) -> None:
        """A mention looked up: found as an item of the target source, or (no target item) not there."""
        with self.lock, self.connection:
            self.connection.execute(
                "UPDATE entity_links SET target_item_id = ?, confidence = ?, resolved_at = ? WHERE item_id = ? AND entity = ? AND target_source_id = ?",
                (target_item_id, confidence, iso(now), item_id, entity, target),
            )

    def family_state(self, ref: str) -> tuple[str, int] | None:
        """When the newest item of a source or its family was read and how many it holds, or None when it has none:
        what changes whenever it gains items."""
        with self.lock:
            row = self.connection.execute(
                "SELECT MAX(fetched_at), COUNT(*) FROM items WHERE source_id = ? OR source_id LIKE ? ESCAPE '\\' OR source_id LIKE ? ESCAPE '\\' OR source_id LIKE ? ESCAPE '\\'",
                (ref, *(f"{like_prefix(ref)}{separator}%" for separator in (":", "/", "?"))),
            ).fetchone()
        return (row[0], row[1]) if row and row[0] else None

    def items_from_family(self, ref: str, limit: int) -> list[Item]:
        """The newest items of a source or of its family (every search on shop:amazon.com), whatever their age."""
        with self.lock:
            rows = self.connection.execute(
                "SELECT item_json FROM items WHERE source_id = ? OR source_id LIKE ? ESCAPE '\\' OR source_id LIKE ? ESCAPE '\\' OR source_id LIKE ? ESCAPE '\\' "
                "ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT ?",
                (ref, *(f"{like_prefix(ref)}{separator}%" for separator in (":", "/", "?")), limit),
            ).fetchall()
        return [Item.model_validate_json(row[0]) for row in rows]

    def update_extra(self, item_id: str, values: dict[str, str]) -> None:
        with self.lock, self.connection:
            row = self.connection.execute("SELECT item_json FROM items WHERE item_id = ?", (item_id,)).fetchone()
            if row:
                item = Item.model_validate_json(row[0])
                item = item.model_copy(update={"extra": {**item.extra, **values}})
                self.connection.execute("UPDATE items SET item_json = ? WHERE item_id = ?", (item.model_dump_json(), item_id))

    def update_tags(self, tagged: list[Item]) -> None:
        """Save tagging results: topics plus the judged answers, kept next to whatever else the item holds."""
        with self.lock, self.connection:
            for fresh in tagged:
                row = self.connection.execute("SELECT item_json FROM items WHERE item_id = ?", (fresh.item_id,)).fetchone()
                if row:
                    stored = Item.model_validate_json(row[0])
                    judged = {key: value for key, value in fresh.extra.items() if key.startswith(JUDGED_PREFIX)}
                    item = stored.model_copy(update={"topics": fresh.topics, "tagged": True, "extra": with_judged_rage({**stored.extra, **judged})})
                    self.connection.execute("UPDATE items SET item_json = ? WHERE item_id = ?", (item.model_dump_json(), fresh.item_id))

    def add_events(self, events: list[Event], now: datetime) -> None:
        """Record events; a seen event marks its item and the same URL from other sources, as seen everywhere."""
        with self.lock, self.connection:
            self.connection.executemany(
                "INSERT INTO events (ts, view_id, item_id, event_kind) VALUES (?, ?, ?, ?)",
                [(iso(now), event.view_id, event.item_id, event.event_kind) for event in events],
            )
            self.connection.executemany(
                "UPDATE items SET seen_at = ? WHERE url = (SELECT url FROM items WHERE item_id = ?) AND seen_at IS NULL",
                [(iso(now), event.item_id) for event in events if event.event_kind == "seen" and event.item_id],
            )

    def expire(self, now: datetime) -> int:
        """Drop items no source has listed for a month, unless you opened them or keep them in a collection; your own
        history stays."""
        with self.lock, self.connection:
            cursor = self.connection.execute(
                f"DELETE FROM items WHERE COALESCE(listed_at, fetched_at) < ? AND source_id NOT LIKE '{HISTORY_PREFIX}%' AND item_id NOT IN "
                "(SELECT item_id FROM events WHERE event_kind = 'open' AND item_id IS NOT NULL) AND item_id NOT IN (SELECT item_id FROM collections)",
                (iso(now - ITEM_TTL),),
            )
            self.connection.execute("DELETE FROM items_search WHERE item_id NOT IN (SELECT item_id FROM items)")
            self.connection.execute("DELETE FROM vectors WHERE item_id NOT IN (SELECT item_id FROM items)")
        return cursor.rowcount

    def save_vectors(self, vectors: dict[str, tuple[str, bytes]]) -> None:
        with self.lock, self.connection:
            self.connection.executemany("INSERT OR REPLACE INTO vectors (item_id, kind, vector) VALUES (?, ?, ?)", [(item_id, kind, data) for item_id, (kind, data) in vectors.items()])

    def vectors_of(self, item_ids: list[str], kind: str) -> dict[str, bytes]:
        """Stored vectors of these items made the given way."""
        if not item_ids:
            return {}
        marks = ", ".join("?" for _ in item_ids)
        with self.lock:
            rows = self.connection.execute(f"SELECT item_id, vector FROM vectors WHERE kind = ? AND item_id IN ({marks})", (kind, *item_ids)).fetchall()
        return dict(rows)

    def vectors_by_kind(self, kind: str, limit: int) -> dict[str, bytes]:
        """The newest stored vectors made the given way, for searching by meaning."""
        with self.lock:
            rows = self.connection.execute("SELECT item_id, vector FROM vectors WHERE kind = ? ORDER BY rowid DESC LIMIT ?", (kind, limit)).fetchall()
        return dict(rows)

    def search(self, words: str, limit: int, family: str | None = None) -> list[tuple[Item, float]]:
        """Items matching any of the words, best first by bm25 (which puts items with more of them first), with their
        scores; with a family, only that source's items (or its family's: every search on shop:amazon.com), chosen
        before the limit. Each word is quoted, so FTS5 operators in the words are plain words."""
        terms = list(dict.fromkeys(f'"{word}"' for word in SEARCH_WORD.findall(words.lower())))
        if not terms:
            return []
        within, values = "", []
        if family is not None:
            within = " AND (items.source_id = ? OR items.source_id LIKE ? ESCAPE '\\' OR items.source_id LIKE ? ESCAPE '\\' OR items.source_id LIKE ? ESCAPE '\\')"
            values = [family, *(f"{like_prefix(family)}{separator}%" for separator in (":", "/", "?"))]
        with self.lock:
            found = self.connection.execute(
                "SELECT items.item_json, bm25(items_search) FROM items_search JOIN items ON items.item_id = items_search.item_id "
                f"WHERE items_search MATCH ?{within} ORDER BY bm25(items_search) LIMIT ?",
                (" OR ".join(terms), *values, limit),
            ).fetchall()
        return [(Item.model_validate_json(item_json), -score) for item_json, score in found]

    def add_follows(self, list_url: str, accounts: list[tuple[str, str]], now: datetime) -> int:
        """Accounts a following list named just now; the list counts as read and accounts gone a month are dropped."""
        with self.lock, self.connection:
            self.connection.executemany(
                "INSERT INTO follows (host, handle, list_url, seen_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (host, handle, list_url) DO UPDATE SET seen_at = excluded.seen_at",
                [(host, handle, list_url, iso(now)) for host, handle in set(accounts)],
            )
            self.connection.execute(
                "INSERT INTO follow_lists (list_url, read_at) VALUES (?, ?) ON CONFLICT (list_url) DO UPDATE SET read_at = excluded.read_at",
                (list_url, iso(now)),
            )
            self.connection.execute("DELETE FROM follows WHERE seen_at < ?", (iso(now - FOLLOW_TTL),))
        return len(set(accounts))

    def follows(self) -> frozenset[tuple[str, str]]:
        with self.lock:
            rows = self.connection.execute("SELECT DISTINCT host, handle FROM follows").fetchall()
        return frozenset((host, handle) for host, handle in rows)

    def list_read_at(self, list_url: str) -> datetime | None:
        with self.lock:
            row = self.connection.execute("SELECT read_at FROM follow_lists WHERE list_url = ?", (list_url,)).fetchone()
        return datetime.fromisoformat(row[0]) if row else None

    def watch_text(self, url: str) -> tuple[str, datetime] | None:
        """The text a watched page had at its last look, and when that was."""
        with self.lock:
            row = self.connection.execute("SELECT text, checked_at FROM watches WHERE url = ?", (url,)).fetchone()
        return (row[0], datetime.fromisoformat(row[1])) if row else None

    def save_watch(self, url: str, text: str, now: datetime, changed: bool) -> None:
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT INTO watches (url, text, checked_at, changed_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (url) DO UPDATE SET text = excluded.text, checked_at = excluded.checked_at, changed_at = COALESCE(excluded.changed_at, watches.changed_at)",
                (url, text, iso(now), iso(now) if changed else None),
            )

    def replace_item(self, item: Item) -> None:
        """One item per source and URL that always holds the latest version, unseen again: the latest change of a watched page."""
        with self.lock, self.connection:
            self.connection.execute("DELETE FROM items_search WHERE item_id IN (SELECT item_id FROM items WHERE source_id = ? AND url = ?)", (item.source_id, item.url))
            self.connection.execute("DELETE FROM items WHERE source_id = ? AND url = ?", (item.source_id, item.url))
            self.connection.execute("INSERT INTO items_search (item_id, title, text, author) VALUES (?, ?, ?, ?)", search_row(item))
            self.connection.execute(
                f"INSERT INTO items ({ITEM_COLUMNS}, listed_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (item.item_id, item.source_id, item.url, iso(item.published_at), iso(item.fetched_at), item.model_dump_json(), iso(item.fetched_at)),
            )

    def add_to_collection(self, name: str, item_id: str, now: datetime) -> bool:
        """True when the item was not in the collection yet."""
        with self.lock, self.connection:
            cursor = self.connection.execute("INSERT OR IGNORE INTO collections (name, item_id, added_at) VALUES (?, ?, ?)", (name, item_id, iso(now)))
        return cursor.rowcount > 0

    def remove_from_collection(self, name: str, item_id: str) -> bool:
        with self.lock, self.connection:
            cursor = self.connection.execute("DELETE FROM collections WHERE name = ? AND item_id = ?", (name, item_id))
        return cursor.rowcount > 0

    def collection_counts(self) -> dict[str, int]:
        """Each collection with how many of its items still exist."""
        with self.lock:
            rows = self.connection.execute(
                "SELECT name, COUNT(*) FROM collections JOIN items ON items.item_id = collections.item_id GROUP BY name ORDER BY name"
            ).fetchall()
        return dict(rows)

    def collection_items(self, names: list[str]) -> list[tuple[Item, datetime | None, datetime]]:
        """Items in these collections, newest saved first, each with when you saw it and when it was saved."""
        if not names:
            return []
        marks = ", ".join("?" for _ in names)
        with self.lock:
            rows = self.connection.execute(
                f"SELECT items.item_json, items.seen_at, MAX(collections.added_at) FROM collections JOIN items ON items.item_id = collections.item_id "
                f"WHERE collections.name IN ({marks}) GROUP BY items.item_id ORDER BY MAX(collections.added_at) DESC",
                names,
            ).fetchall()
        return [(Item.model_validate_json(item_json), datetime.fromisoformat(seen_at) if seen_at else None, datetime.fromisoformat(added_at)) for item_json, seen_at, added_at in rows]

    def collections_of(self, item_ids: list[str]) -> dict[str, list[str]]:
        """The collections each of these items is in."""
        if not item_ids:
            return {}
        marks = ", ".join("?" for _ in item_ids)
        with self.lock:
            rows = self.connection.execute(f"SELECT item_id, name FROM collections WHERE item_id IN ({marks}) ORDER BY name", item_ids).fetchall()
        found: dict[str, list[str]] = {}
        for item_id, name in rows:
            found.setdefault(item_id, []).append(name)
        return found

    def record_prices(self, prices: list[tuple[str, float, str]], now: datetime) -> int:
        """Prices seen now, by product key: kept when the price changed or the last one was seen on another day."""
        kept = 0
        with self.lock, self.connection:
            for key, amount, symbol in prices:
                last = self.connection.execute("SELECT amount, seen_at FROM prices WHERE product_key = ? ORDER BY seen_at DESC LIMIT 1", (key,)).fetchone()
                if last and last[0] == amount and datetime.fromisoformat(last[1]).date() == now.astimezone(UTC).date():
                    continue
                self.connection.execute("INSERT INTO prices (product_key, amount, symbol, seen_at) VALUES (?, ?, ?, ?)", (key, amount, symbol, iso(now)))
                kept += 1
        return kept

    def price_history(self, keys: list[str]) -> dict[str, list[tuple[float, str, datetime]]]:
        """Each product's prices as you saw them: amount, currency symbol and when."""
        if not keys:
            return {}
        marks = ", ".join("?" for _ in keys)
        with self.lock:
            rows = self.connection.execute(f"SELECT product_key, amount, symbol, seen_at FROM prices WHERE product_key IN ({marks}) ORDER BY seen_at", keys).fetchall()
        found: dict[str, list[tuple[float, str, datetime]]] = {}
        for key, amount, symbol, seen_at in rows:
            found.setdefault(key, []).append((amount, symbol, datetime.fromisoformat(seen_at)))
        return found

    def add_moment(self, view_id: str, kind: str, now: datetime) -> None:
        with self.lock, self.connection:
            self.connection.execute("INSERT INTO moments (ts, view_id, kind) VALUES (?, ?, ?)", (iso(now), view_id, kind))

    def moment_counts(self, since: datetime) -> dict[str, dict[str, int]]:
        with self.lock:
            rows = self.connection.execute("SELECT view_id, kind, COUNT(*) FROM moments WHERE ts >= ? GROUP BY view_id, kind", (iso(since),)).fetchall()
        counts: dict[str, dict[str, int]] = {}
        for view_id, kind, count in rows:
            counts.setdefault(view_id, {})[kind] = count
        return counts

    def fetched_since(self, since: datetime) -> list[tuple[Item, datetime | None]]:
        """Every item first read after since, with when you saw it: what the sources showed you lately."""
        with self.lock:
            rows = self.connection.execute("SELECT item_json, seen_at FROM items WHERE fetched_at >= ?", (iso(since),)).fetchall()
        return [(Item.model_validate_json(item_json), datetime.fromisoformat(seen_at) if seen_at else None) for item_json, seen_at in rows]

    def opened_since(self, since: datetime) -> set[str]:
        with self.lock:
            rows = self.connection.execute("SELECT DISTINCT item_id FROM events WHERE event_kind = 'open' AND ts >= ? AND item_id IS NOT NULL", (iso(since),)).fetchall()
        return {row[0] for row in rows}

    def stats(self) -> dict[str, dict[str, int]]:
        with self.lock:
            sources = self.connection.execute(
                "SELECT source_id, COUNT(*), SUM(seen_at IS NOT NULL) FROM items GROUP BY source_id"
            ).fetchall()
            events = self.connection.execute("SELECT event_kind, COUNT(*) FROM events GROUP BY event_kind").fetchall()
            follows = self.connection.execute("SELECT host, COUNT(DISTINCT handle) FROM follows GROUP BY host").fetchall()
        return {
            "items": {source_id: total for source_id, total, _ in sources},
            "seen": {source_id: seen for source_id, _, seen in sources},
            "events": dict(events),
            "follows": dict(follows),
        }
