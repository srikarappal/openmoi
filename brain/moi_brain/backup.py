"""All of your data in openMoi as one file to keep, and deleting all of it: yours to take and to end.

The backup holds your views, memory and journal, lenses, specs, settings, logs and a consistent copy of the database
of everything read; it leaves out secrets (your API keys file, Chrome's pairing and Google's tokens) and earlier
exports. Deleting removes everything openMoi keeps except the exports folder, so a backup you just made stays."""

import shutil
import tempfile
import zipfile
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from moi_brain.config import Paths

CONFIRM = "delete everything"
KEPT = "exports"
SECRETS = (".env", ".moi/relay_trusted.json", ".moi/google_tokens.json")


def backup_name(now: datetime) -> str:
    return f"openmoi_everything_{now.astimezone():%Y%m%d_%H%M%S}.zip"


def export_everything(paths: Paths, copy_database: Callable[[Path], None], now: datetime) -> Path:
    """One zip in exports/ with everything but secrets and earlier exports; the database copied whole, not mid write."""
    target = paths.home / KEPT / backup_name(now)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        database = Path(scratch) / "openmoi.db"
        copy_database(database)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(paths.home.rglob("*")):
                relative = file.relative_to(paths.home)
                if not file.is_file() or file.is_symlink() or relative.parts[0] == KEPT or relative.as_posix() in SECRETS or relative.name.startswith(paths.db.name):
                    continue
                archive.write(file, relative.as_posix())
            archive.write(database, paths.db.relative_to(paths.home).as_posix())
    return target


def delete_everything(paths: Paths) -> list[str]:
    """Removes everything in your openMoi folder but exports/, secrets included; returns what it removed."""
    removed = []
    for entry in sorted(paths.home.iterdir()):
        if entry.name == KEPT:
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        removed.append(entry.name)
    return removed
