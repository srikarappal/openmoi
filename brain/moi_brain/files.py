"""Writing state and user files safely and reading caches that may be missing or damaged."""

import json
import os
import uuid
from pathlib import Path
from typing import Any


def write_atomic(path: Path, text: str, private: bool = False) -> None:
    """Write through a temporary file and a rename, so a crash or a kill never leaves a half written file.
    A private file (a secret) is readable only by you from the moment it exists."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600 if private else 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(temporary, path)


def read_text(path: Path) -> str:
    """A text file you wrote, or "" when it is missing; bytes that are not UTF-8 become replacement marks
    instead of breaking every view."""
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def read_json(path: Path, default: Any) -> Any:
    """A state file's JSON, or default when it is missing or damaged; it is written again on the next change."""
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default
