"""SQLite storage for items and events. Everything else openMoi keeps is a file."""

import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

from moi_brain.items import JUDGED_PREFIX, Event, Item

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
# The last text of each watched page, to tell what changed.
WATCHES_TABLE = """
CREATE TABLE IF NOT EXISTS watches (
    url TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    changed_at TEXT
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
FOLLOW_TTL = timedelta(days=30)
INDEXES = (
    "CREATE INDEX IF NOT EXISTS items_by_url ON items (url)",
    "CREATE INDEX IF NOT EXISTS items_by_source ON items (source_id, published_at)",
    "CREATE INDEX IF NOT EXISTS events_by_item ON events (item_id)",
)


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
                else:
                    self.connection.execute(
                        "UPDATE items SET listed_at = ? WHERE item_id = ? OR (source_id = ? AND url = ?)",
                        (listed, item.item_id, item.source_id, item.url),
                    )
        return new_items

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
        """Items from these sources published (or fetched) after since, each with when you saw it."""
        if not source_ids:
            return []
        marks = ", ".join("?" for _ in source_ids)
        query = f"SELECT item_json, seen_at FROM items WHERE source_id IN ({marks}) AND COALESCE(published_at, fetched_at) >= ?"
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

    def update_tags(self, tagged: list[Item]) -> None:
        """Save tagging results: topics plus the judged answers, kept next to whatever else the item holds."""
        with self.lock, self.connection:
            for fresh in tagged:
                row = self.connection.execute("SELECT item_json FROM items WHERE item_id = ?", (fresh.item_id,)).fetchone()
                if row:
                    stored = Item.model_validate_json(row[0])
                    judged = {key: value for key, value in fresh.extra.items() if key.startswith(JUDGED_PREFIX)}
                    item = stored.model_copy(update={"topics": fresh.topics, "tagged": True, "extra": {**stored.extra, **judged}})
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
        """Drop items no source has listed for a month, unless you opened them."""
        with self.lock, self.connection:
            cursor = self.connection.execute(
                "DELETE FROM items WHERE COALESCE(listed_at, fetched_at) < ? AND item_id NOT IN "
                "(SELECT item_id FROM events WHERE event_kind = 'open' AND item_id IS NOT NULL)",
                (iso(now - ITEM_TTL),),
            )
        return cursor.rowcount

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
            self.connection.execute("DELETE FROM items WHERE source_id = ? AND url = ?", (item.source_id, item.url))
            self.connection.execute(
                f"INSERT INTO items ({ITEM_COLUMNS}, listed_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (item.item_id, item.source_id, item.url, iso(item.published_at), iso(item.fetched_at), item.model_dump_json(), iso(item.fetched_at)),
            )

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
