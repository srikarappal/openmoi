"""All your data as one file, secrets left out, and deleting all of it but the exports, after which openMoi starts over."""

import sqlite3
import time
import zipfile

import pytest

import moi_brain.brain
from moi_brain.backup import CONFIRM


def test_a_backup_holds_everything_but_secrets_and_earlier_exports(brain, client, paths):
    client.post("/ingest", json={"source_id": "x", "records": [{"native_id": "1", "url": "https://x.com/a/status/1", "title": "Kept in the backup"}]})
    (paths.home / ".env").write_text("OPENROUTER_API_KEY=secret")
    (paths.state / "relay_trusted.json").write_text("{}")
    (paths.home / "exports").mkdir(exist_ok=True)
    (paths.home / "exports" / "earlier.md").write_text("old export")
    path = client.post("/data/export").json()["path"]
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        assert {"views/feed.md", ".moi/openmoi.db"} <= names
        assert not names & {".env", ".moi/relay_trusted.json", "exports/earlier.md"} and not any(name.endswith(("-wal", "-shm")) for name in names)
        archive.extract(".moi/openmoi.db", paths.home / "check")
    copy = sqlite3.connect(paths.home / "check" / ".moi" / "openmoi.db")
    assert "Kept in the backup" in copy.execute("SELECT item_json FROM items").fetchone()[0]
    copy.close()


def test_deleting_everything_keeps_only_the_exports_and_needs_the_exact_words(brain, client, paths, monkeypatch):
    ended = []
    monkeypatch.setattr(moi_brain.brain, "end_process", lambda: ended.append(True))
    (paths.home / ".env").write_text("OPENROUTER_API_KEY=secret")
    client.post("/data/export")
    assert client.post("/data/delete", json={"confirm": "delete"}).status_code == 400
    assert (paths.views / "feed.md").exists()
    removed = client.post("/data/delete", json={"confirm": CONFIRM}).json()["removed"]
    assert {".env", ".moi", "views", "memory"} <= set(removed)
    assert sorted(entry.name for entry in paths.home.iterdir()) == ["exports"] and any((paths.home / "exports").glob("openmoi_everything_*.zip"))
    deadline = time.monotonic() + 3
    while not ended and time.monotonic() < deadline:
        time.sleep(0.05)
    assert ended == [True]


@pytest.mark.parametrize("words", ["", "Delete everything", "delete everything now"])
def test_only_the_exact_words_delete(brain, client, words, monkeypatch):
    monkeypatch.setattr(moi_brain.brain, "end_process", lambda: None)
    assert client.post("/data/delete", json={"confirm": words}).status_code in (400, 422)
