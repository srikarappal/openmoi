"""Paths and settings for one openMoi home folder."""

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from pydantic import BaseModel, Field

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
REPO_DIR = Path(__file__).resolve().parents[2]


class Slot(BaseModel):
    """One model endpoint speaking the OpenAI compatible chat API."""

    base_url: str
    model: str
    api_key_env: str | None = None
    input_cost_per_million: float = 0.0
    output_cost_per_million: float = 0.0

    @property
    def is_local(self) -> bool:
        return urlparse(self.base_url).hostname in LOCAL_HOSTS


def local_slot() -> Slot:
    return Slot(base_url="http://127.0.0.1:11434/v1", model="llama3")


class Settings(BaseModel):
    fast: Slot = Field(default_factory=local_slot)
    smart: Slot = Field(default_factory=local_slot)
    allow_content_to_hosted: bool = False


@dataclass(frozen=True)
class Paths:
    """Files you own live in home; generated state lives in home/.moi; shipped assets live in assets."""

    home: Path
    assets: Path

    @property
    def memory(self) -> Path:
        return self.home / "memory"

    @property
    def journal(self) -> Path:
        return self.memory / "journal"

    @property
    def views(self) -> Path:
        return self.home / "views"

    @property
    def takeout(self) -> Path:
        return self.home / "subscriptions.csv"

    @property
    def state(self) -> Path:
        return self.home / ".moi"

    @property
    def compiled(self) -> Path:
        return self.state / "compiled"

    @property
    def lenses(self) -> Path:
        return self.state / "lenses"

    @property
    def extractors(self) -> Path:
        return self.state / "extractors"

    @property
    def logs(self) -> Path:
        return self.state / "logs"

    @property
    def db(self) -> Path:
        return self.state / "openmoi.db"

    @property
    def settings_file(self) -> Path:
        return self.state / "config.json"

    @property
    def llm_log(self) -> Path:
        return self.logs / "llm_calls.jsonl"

    @property
    def tagging_state(self) -> Path:
        return self.state / "tagged_topics.json"

    @property
    def relay_trust(self) -> Path:
        return self.state / "relay_trusted.json"

    @property
    def channel_cache(self) -> Path:
        return self.state / "youtube_channels.json"

    @property
    def templates(self) -> Path:
        return self.assets / "templates"

    @property
    def default_lens(self) -> Path:
        return self.assets / "lenses" / "default" / "default.html"

    @property
    def builtin_extractors(self) -> Path:
        return self.assets / "extractors"


def load_paths() -> Paths:
    home = Path(os.environ.get("MOI_HOME", Path.home() / "openMoi")).expanduser()
    assets = Path(os.environ.get("MOI_ASSETS_DIR", REPO_DIR)).expanduser()
    return Paths(home=home, assets=assets)


def copy_missing(source_dir: Path, target_dir: Path) -> None:
    for source in source_dir.glob("*.md"):
        target = target_dir / source.name
        if not target.exists():
            shutil.copyfile(source, target)


def ensure_home(paths: Paths) -> None:
    """Create the folder layout and seed starter files without touching anything you wrote."""
    for directory in (paths.journal, paths.views, paths.compiled, paths.lenses, paths.extractors, paths.logs):
        directory.mkdir(parents=True, exist_ok=True)
    if not any(paths.views.glob("*.md")):
        copy_missing(paths.templates / "views", paths.views)
    copy_missing(paths.templates / "memory", paths.memory)


def load_settings(paths: Paths) -> Settings:
    if paths.settings_file.exists():
        return Settings.model_validate_json(paths.settings_file.read_text())
    settings = Settings()
    paths.settings_file.parent.mkdir(parents=True, exist_ok=True)
    paths.settings_file.write_text(settings.model_dump_json(indent=2))
    return settings
