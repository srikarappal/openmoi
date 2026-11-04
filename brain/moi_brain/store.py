"""SQLite storage for items and events. Everything else openMoi keeps is a file."""

import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path

from moi_brain.items import Event, Item

ITEM_TTL = timedelta(days=30)
SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    item_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    seen_at TEXT,
    item_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_by_source ON items (source_id, published_at);
CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    view_id TEXT NOT NULL,
    item_id TEXT,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('open', 'seen', 'less_like_this'))
);
CREATE INDEX IF NOT EXISTS events_by_item ON events (item_id);
"""


def iso(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment else None


class Store:
    """One shared connection guarded by a lock; the brain is a single user process."""

    def __init__(self, db_path: Path):
        self.connection = sqlite3.connect(db_path, check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock:
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.executescript(SCHEMA)

    def upsert_items(self, items: list[Item]) -> list[Item]:
        """Insert items that are new by id and by URL; returns only the new ones."""
        new_items = []
        with self.lock, self.connection:
            for item in items:
                cursor = self.connection.execute(
                    "INSERT OR IGNORE INTO items (item_id, source_id, url, published_at, fetched_at, item_json) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (item.item_id, item.source_id, item.url, iso(item.published_at), iso(item.fetched_at), item.model_dump_json()),
                )
                if cursor.rowcount:
                    new_items.append(item)
        return new_items

    def items_for_sources(self, source_ids: list[str], since: datetime) -> list[Item]:
        """Unseen items from these sources published (or fetched) after since."""
        if not source_ids:
            return []
        marks = ", ".join("?" for _ in source_ids)
        query = (
            f"SELECT item_json FROM items WHERE source_id IN ({marks}) "
            "AND seen_at IS NULL AND COALESCE(published_at, fetched_at) >= ?"
        )
        with self.lock:
            rows = self.connection.execute(query, (*source_ids, iso(since))).fetchall()
        return [Item.model_validate_json(row[0]) for row in rows]

    def recent_items(self, since: datetime) -> list[Item]:
        with self.lock:
            rows = self.connection.execute(
                "SELECT item_json FROM items WHERE seen_at IS NULL AND COALESCE(published_at, fetched_at) >= ?", (iso(since),)
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

    def add_events(self, events: list[Event], now: datetime) -> None:
        """Record events; a seen event also marks its item as seen everywhere."""
        with self.lock, self.connection:
            self.connection.executemany(
                "INSERT INTO events (ts, view_id, item_id, event_kind) VALUES (?, ?, ?, ?)",
                [(iso(now), event.view_id, event.item_id, event.event_kind) for event in events],
            )
            self.connection.executemany(
                "UPDATE items SET seen_at = ? WHERE item_id = ? AND seen_at IS NULL",
                [(iso(now), event.item_id) for event in events if event.event_kind == "seen" and event.item_id],
            )

    def expire(self, now: datetime) -> int:
        """Drop items older than the TTL unless you opened them."""
        with self.lock, self.connection:
            cursor = self.connection.execute(
                "DELETE FROM items WHERE fetched_at < ? AND item_id NOT IN "
                "(SELECT item_id FROM events WHERE event_kind = 'open' AND item_id IS NOT NULL)",
                (iso(now - ITEM_TTL),),
            )
        return cursor.rowcount

    def stats(self) -> dict[str, dict[str, int]]:
        with self.lock:
            sources = self.connection.execute(
                "SELECT source_id, COUNT(*), SUM(seen_at IS NOT NULL) FROM items GROUP BY source_id"
            ).fetchall()
            events = self.connection.execute("SELECT event_kind, COUNT(*) FROM events GROUP BY event_kind").fetchall()
        return {
            "items": {source_id: total for source_id, total, _ in sources},
            "seen": {source_id: seen for source_id, _, seen in sources},
            "events": dict(events),
        }
