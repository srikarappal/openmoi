"""All your data as one file, secrets left out, and deleting all of it but the exports and the packs: marked by the
brain you asked, done by the next one before anything of it runs."""

import os
import sqlite3
import stat
import time
import zipfile
from pathlib import Path

import pytest

import moi_brain.brain
from moi_brain.__main__ import start_over_if_asked
from moi_brain.backup import CONFIRM, WIPE_MARK, WipeRefused, delete_everything
from moi_brain.config import Paths


def test_a_backup_holds_everything_but_secrets_and_earlier_exports_and_is_yours_alone(brain, client, paths):
    client.post("/ingest", json={"source_id": "x", "records": [{"native_id": "1", "url": "https://x.com/a/status/1", "title": "Kept in the backup"}]})
    (paths.home / ".env").write_text("OPENROUTER_API_KEY=secret")
    (paths.state / "relay_trusted.json").write_text("{}")
    (paths.home / "exports").mkdir(exist_ok=True)
    (paths.home / "exports" / "earlier.md").write_text("old export")
    path = client.post("/data/export").json()["path"]
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600 and stat.S_IMODE(os.stat(paths.home).st_mode) == 0o700
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        assert {"views/feed.md", ".moi/openmoi.db"} <= names
        assert not names & {".env", ".moi/relay_trusted.json", "exports/earlier.md"} and not any(name.endswith(("-wal", "-shm")) for name in names)
        archive.extract(".moi/openmoi.db", paths.home / "check")
    copy = sqlite3.connect(paths.home / "check" / ".moi" / "openmoi.db")
    assert "Kept in the backup" in copy.execute("SELECT item_json FROM items").fetchone()[0]
    copy.close()


def test_the_brain_you_ask_only_marks_the_wipe_and_ends_and_the_next_one_does_it(brain, client, paths, monkeypatch):
    ended = []
    monkeypatch.setattr(moi_brain.brain, "end_process", lambda: ended.append(True))
    (paths.home / ".env").write_text("OPENROUTER_API_KEY=secret")
    (paths.packs).mkdir(parents=True, exist_ok=True)
    (paths.packs / "pack.json").write_text("{}")
    client.post("/data/export")
    assert client.post("/data/delete", json={"confirm": "delete"}).status_code == 400
    assert client.post("/data/delete", json={"confirm": CONFIRM}).json() == {"status": "deleting"}
    assert (paths.views / "feed.md").exists() and (paths.home / WIPE_MARK).exists()
    assert start_over_if_asked(paths) == ""
    assert sorted(entry.name for entry in paths.home.iterdir()) == [".moi", "exports"]
    assert [entry.name for entry in paths.state.iterdir()] == ["packs"] and (paths.packs / "pack.json").exists()
    assert any((paths.home / "exports").glob("openmoi_everything_*.zip"))
    assert start_over_if_asked(paths) == ""
    deadline = time.monotonic() + 3
    while not ended and time.monotonic() < deadline:
        time.sleep(0.05)
    assert ended == [True]


@pytest.mark.parametrize("words", ["", "Delete everything", "delete everything now"])
def test_only_the_exact_words_delete(brain, client, words, monkeypatch):
    monkeypatch.setattr(moi_brain.brain, "end_process", lambda: None)
    assert client.post("/data/delete", json={"confirm": words}).status_code in (400, 422)


def test_a_folder_that_is_not_an_openmoi_folder_is_never_wiped(tmp_path, monkeypatch):
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "thesis.md").write_text("years of work")
    with pytest.raises(WipeRefused):
        delete_everything(Paths(home=plain, assets=tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: plain))
    (plain / ".moi").mkdir()
    with pytest.raises(WipeRefused):
        delete_everything(Paths(home=plain, assets=tmp_path))
    assert (plain / "thesis.md").exists()
    (plain / WIPE_MARK).write_text("x")
    assert start_over_if_asked(Paths(home=plain, assets=tmp_path)).startswith("Deleting everything did not finish")
    assert (plain / "thesis.md").exists()
