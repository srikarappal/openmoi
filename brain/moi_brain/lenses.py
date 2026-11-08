"""Lens files: the default lens plus numbered generated versions per view."""

import json
from pathlib import Path

from pydantic import BaseModel

from moi_brain.files import write_atomic

SITE_PREFIX = "site_"
LENS_KINDS = ("feed", "article", "listing")


class LensPointer(BaseModel):
    """Which version is live and which layout text the live lens was made for."""

    version: int = 0
    layout_hash: str | None = None


def lens_key(view_id: str, kind: str) -> str:
    """The folder of a view's lens; "@" cannot appear in a view id, so feed_article and feed@article never meet."""
    return view_id if kind == "feed" else f"{view_id}@{kind}"


class LensStore:
    def __init__(self, default_path: Path, lenses_dir: Path):
        self.default_path = default_path
        self.lenses_dir = lenses_dir
        self.move_old_folders()

    def move_old_folders(self) -> None:
        """Mine lenses used to live in site_<domain>_<kind>; they move to the folder lens_key names now."""
        for kind in LENS_KINDS[1:]:
            for folder in self.lenses_dir.glob(f"{SITE_PREFIX}*_{kind}"):
                target = self.lenses_dir / lens_key(folder.name.removesuffix(f"_{kind}"), kind)
                if folder.is_dir() and not target.exists():
                    folder.rename(target)

    def pointer(self, key: str) -> LensPointer:
        try:
            return LensPointer.model_validate_json((self.lenses_dir / key / "current.json").read_text())
        except (OSError, ValueError):
            return LensPointer()

    def html(self, key: str) -> str:
        version = self.pointer(key).version
        path = self.lenses_dir / key / f"v{version}.html"
        return path.read_text() if version and path.exists() else self.default_path.read_text()

    def versions(self, key: str) -> list[int]:
        return sorted(int(path.stem[1:]) for path in (self.lenses_dir / key).glob("v*.html") if path.stem[1:].isdigit())

    def save(self, key: str, html: str, layout_hash: str) -> int:
        """Store html as the next version and make it live."""
        folder = self.lenses_dir / key
        folder.mkdir(parents=True, exist_ok=True)
        version = max(self.versions(key), default=0) + 1
        write_atomic(folder / f"v{version}.html", html)
        self.write_pointer(key, LensPointer(version=version, layout_hash=layout_hash))
        return version

    def rollback(self, key: str, layout_hash: str) -> int:
        """Make the version before the live one current; 0 means back to the default lens."""
        current = self.pointer(key).version
        earlier = [version for version in self.versions(key) if version < current]
        version = max(earlier, default=0)
        self.write_pointer(key, LensPointer(version=version, layout_hash=layout_hash))
        return version

    def is_stale(self, key: str, layout: str, layout_hash: str) -> bool:
        """A non empty layout that the live lens was not made for."""
        return bool(layout.strip()) and self.pointer(key).layout_hash != layout_hash

    def write_pointer(self, key: str, pointer: LensPointer) -> None:
        write_atomic(self.lenses_dir / key / "current.json", json.dumps(pointer.model_dump(), indent=2))
