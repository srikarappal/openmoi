"""Paths and settings for one openMoi home folder."""

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field

from moi_brain.files import write_atomic

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
REPO_DIR = Path(__file__).resolve().parents[2]


class Slot(BaseModel):
    """One model endpoint speaking the OpenAI compatible chat API."""

    base_url: str
    model: str
    api_key_env: str | None = None
    input_cost_per_million: float = 0.0
    output_cost_per_million: float = 0.0
    extra: dict[str, Any] = Field(default_factory=dict)

    @property
    def is_local(self) -> bool:
        return urlparse(self.base_url).hostname in LOCAL_HOSTS


class Provider(BaseModel):
    """A known model provider: where it lives, which env variable holds its key, extra fields per slot."""

    base_url: str
    api_key_env: str | None = None
    fast_extra: dict[str, Any] = Field(default_factory=dict)
    smart_extra: dict[str, Any] = Field(default_factory=dict)


# The fast slot answers short JSON tasks, so reasoning stays off there; the smart slot writes code and reasons.
PROVIDERS = {
    "ollama": Provider(base_url="http://127.0.0.1:11434/v1"),
    "openrouter": Provider(
        base_url="https://openrouter.ai/api/v1",
        api_key_env="OPENROUTER_API_KEY",
        fast_extra={"reasoning": {"enabled": False}},
        smart_extra={"reasoning": {"enabled": True}},
    ),
}


def local_slot() -> Slot:
    return Slot(base_url=PROVIDERS["ollama"].base_url, model="llama3")


class Settings(BaseModel):
    fast: Slot = Field(default_factory=local_slot)
    smart: Slot = Field(default_factory=local_slot)
    allow_content_to_hosted: bool = False
    # Where signed packs of specs and site policy come from; none means no pack updates.
    pack_url: str | None = Field(default=None, pattern=r"^https://")


class ModelChange(BaseModel):
    """What /model asks for: a provider and model for one or both slots, or the privacy switch."""

    slot: Literal["fast", "smart", "both"] = "both"
    provider: Literal["openrouter", "ollama"] | None = None
    model: str | None = Field(default=None, min_length=1, max_length=200)
    allow_content_to_hosted: bool | None = None


class SlotInfo(BaseModel):
    provider: str
    model: str
    base_url: str
    local: bool
    key_ready: bool


class ModelInfo(BaseModel):
    fast: SlotInfo
    smart: SlotInfo
    allow_content_to_hosted: bool


def provider_of(slot: Slot) -> str:
    return next((name for name, provider in PROVIDERS.items() if provider.base_url == slot.base_url), "custom")


def slot_info(slot: Slot) -> SlotInfo:
    key_ready = slot.api_key_env is None or bool(os.environ.get(slot.api_key_env))
    return SlotInfo(provider=provider_of(slot), model=slot.model, base_url=slot.base_url, local=slot.is_local, key_ready=key_ready)


def model_info(settings: Settings) -> ModelInfo:
    return ModelInfo(fast=slot_info(settings.fast), smart=slot_info(settings.smart), allow_content_to_hosted=settings.allow_content_to_hosted)


def changed_slot(slot_name: str, current: Slot, change: ModelChange) -> Slot:
    """A known provider brings its address, key variable and per slot extras; otherwise only the model name changes."""
    provider_name = change.provider or provider_of(current)
    model = change.model or current.model
    provider = PROVIDERS.get(provider_name)
    if provider is None:
        return current.model_copy(update={"model": model})
    extra = provider.fast_extra if slot_name == "fast" else provider.smart_extra
    return Slot(base_url=provider.base_url, api_key_env=provider.api_key_env, model=model, extra=extra)


def apply_model_change(settings: Settings, change: ModelChange) -> Settings:
    updated = settings.model_copy(deep=True)
    if change.allow_content_to_hosted is not None:
        updated.allow_content_to_hosted = change.allow_content_to_hosted
    if change.provider or change.model:
        for slot_name in ("fast", "smart") if change.slot == "both" else (change.slot,):
            setattr(updated, slot_name, changed_slot(slot_name, getattr(updated, slot_name), change))
    return updated


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
    def editions(self) -> Path:
        return self.state / "editions.json"

    @property
    def mirror_state(self) -> Path:
        return self.state / "mirror.json"

    @property
    def extractor_health(self) -> Path:
        return self.state / "extractor_health.json"

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

    @property
    def site_policy(self) -> Path:
        return self.assets / "policy" / "sites.json"

    @property
    def pack_key(self) -> Path:
        return self.assets / "policy" / "pack_key.pub"

    @property
    def packs(self) -> Path:
        return self.state / "packs"

    @property
    def google_tokens(self) -> Path:
        return self.state / "google_tokens.json"

    @property
    def google_subscriptions(self) -> Path:
        return self.state / "youtube_subscriptions.json"


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


class SettingsFileError(ValueError):
    """config.json exists but does not hold valid settings."""


def load_settings(paths: Paths) -> Settings:
    if paths.settings_file.exists():
        try:
            return Settings.model_validate_json(paths.settings_file.read_text())
        except ValueError as error:
            detail = " ".join(str(error).split())[:200]
            raise SettingsFileError(
                f".moi/config.json could not be read ({detail}); openMoi uses its default models until you fix the file or run /model"
            ) from error
    settings = Settings()
    save_settings(paths, settings)
    return settings


def save_settings(paths: Paths, settings: Settings) -> None:
    paths.settings_file.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(paths.settings_file, settings.model_dump_json(indent=2))


def load_env_file(path: Path) -> list[str]:
    """KEY=VALUE lines from openMoi's own .env file into the environment.

    These win over variables already in your shell, so a stale key exported in a shell profile
    never shadows the one you gave openMoi. Returns the names it set; values are never logged.
    """
    if not path.exists():
        return []
    loaded = []
    for line in path.read_text().splitlines():
        name, separator, value = line.strip().removeprefix("export ").partition("=")
        name = name.strip()
        if not separator or not name or name.startswith("#"):
            continue
        os.environ[name] = value.strip().strip("'\"")
        loaded.append(name)
    return loaded
