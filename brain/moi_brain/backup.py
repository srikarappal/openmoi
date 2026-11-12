"""All of your data in openMoi as one file to keep, and deleting all of it: yours to take and to end.

The backup holds your views, memory and journal, lenses, specs, settings, logs and a consistent copy of the database
of everything read; it leaves out secrets (your API keys file, Chrome's pairing and Google's tokens) and earlier
exports. Deleting removes everything openMoi keeps except the exports folder, so a backup you just made stays, and
the signed site packs, so a site the kill switch turned off stays off.

Deleting happens as a brain starts, before anything in it runs: the brain you asked only leaves a mark and ends, so
no thread of it writes a file back after the wipe."""

import os
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
# Left in the openMoi folder by a brain asked to delete everything; the next brain to start does it.
WIPE_MARK = ".delete_everything"


class WipeRefused(ValueError):
    """The folder does not look like an openMoi folder, so nothing in it is deleted."""


def wipeable(paths: Paths) -> None:
    """Only an openMoi folder (it holds .moi) that is not your whole home folder can be wiped."""
    home = paths.home.resolve()
    if home == Path.home().resolve() or not (home / ".moi").is_dir():
        raise WipeRefused(f"{home} does not look like an openMoi folder, so nothing was deleted")


def mark_wipe(paths: Paths) -> None:
    wipeable(paths)
    (paths.home / WIPE_MARK).write_text("delete everything at the next start\n")


def wipe_if_marked(paths: Paths) -> list[str] | None:
    """What a starting brain deletes when the last one was asked to; None when it was not."""
    if not (paths.home / WIPE_MARK).exists():
        return None
    removed = delete_everything(paths)
    return removed


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
    # Everything you have, in one file: yours alone, like the folder it came from.
    os.chmod(target, 0o600)
    return target


def delete_everything(paths: Paths) -> list[str]:
    """Removes everything in your openMoi folder but exports/ and the signed packs, secrets included, the mark last;
    returns what it removed."""
    wipeable(paths)
    removed = []
    for entry in sorted(paths.home.iterdir()):
        if entry.name in (KEPT, WIPE_MARK):
            continue
        if entry == paths.state:
            removed += clear_state(paths)
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        removed.append(entry.name)
    (paths.home / WIPE_MARK).unlink(missing_ok=True)
    return removed


def clear_state(paths: Paths) -> list[str]:
    """Everything in .moi but the packs."""
    removed = []
    for entry in sorted(paths.state.iterdir()):
        if entry == paths.packs:
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        removed.append(f".moi/{entry.name}")
    return removed
