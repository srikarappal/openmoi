"""Writing state and user files safely and reading caches that may be missing or damaged."""

import json
import os
import uuid
from pathlib import Path
from typing import Any


def write_atomic(path: Path, text: str) -> None:
    """Write through a temporary file and a rename, so a crash or a kill never leaves a half written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(text)
    os.replace(temporary, path)


def read_json(path: Path, default: Any) -> Any:
    """A state file's JSON, or default when it is missing or damaged; it is written again on the next change."""
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default
