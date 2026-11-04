"""Extractor specs: the JSON programs that turn a page into raw records."""

import re
from fnmatch import fnmatch
from operator import attrgetter
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field

UNSAFE_NAME = re.compile(r"[^\w.]+")


class FieldRule(BaseModel):
    select: str
    take: str = "text"
    transform: str | None = None
    optional: bool = False
    nth: int = 0


class Pagination(BaseModel):
    kind: Literal["none", "scroll"] = "none"
    step_px: int = 900


class ExtractorSpec(BaseModel):
    domain: str
    path_pattern: str = "/"
    page_type: str = "listing"
    version: int = 1
    start_url: str | None = None
    item_root: str
    native_id: FieldRule | None = None
    fields: dict[str, FieldRule]
    pagination: Pagination = Field(default_factory=Pagination)


def page_domain(url: str) -> str:
    return (urlparse(url).hostname or "").removeprefix("www.")


def looks_like_id(segment: str) -> bool:
    return any(character.isdigit() for character in segment) or len(segment) > 24


def path_pattern_for(url: str) -> str:
    """One spec per kind of page: '/' for a home page, else up to two path segments as a glob.

    /s?k=lamp becomes /s*, /r/python/top becomes /r/python* and an id like segment is globbed,
    so /dp/B0001 becomes /dp*.
    """
    segments = [segment for segment in urlparse(url).path.split("/") if segment]
    if not segments:
        return "/"
    kept = segments[:1] + [segment for segment in segments[1:2] if not looks_like_id(segment)]
    return f"/{'/'.join(kept)}*"


def spec_matches(spec: ExtractorSpec, url: str) -> bool:
    path = urlparse(url).path or "/"
    return spec.domain == page_domain(url) and fnmatch(path, spec.path_pattern)


def newest(specs: list[ExtractorSpec]) -> ExtractorSpec | None:
    return max(specs, key=attrgetter("version"), default=None)


def spec_file_name(spec: ExtractorSpec) -> str:
    key = UNSAFE_NAME.sub("_", f"{spec.domain}_{spec.path_pattern}").strip("_")
    return f"{key}.v{spec.version}.json"


class ExtractorStore:
    """Handwritten specs ship with the app; generated specs live in .moi/extractors with numbered versions."""

    def __init__(self, builtin_dir: Path, generated_dir: Path):
        self.builtin_dir = builtin_dir
        self.generated_dir = generated_dir

    def specs(self) -> list[ExtractorSpec]:
        paths = [*sorted(self.builtin_dir.glob("*.json")), *sorted(self.generated_dir.glob("*.json"))]
        return [ExtractorSpec.model_validate_json(path.read_text()) for path in paths]

    def for_page_type(self, domain: str, page_type: str) -> ExtractorSpec | None:
        return newest([spec for spec in self.specs() if spec.domain == domain and spec.page_type == page_type])

    def for_url(self, url: str) -> ExtractorSpec | None:
        return newest([spec for spec in self.specs() if spec_matches(spec, url)])

    def save(self, spec: ExtractorSpec) -> ExtractorSpec:
        """Store a spec as the next version for its domain and path pattern."""
        same_key = [known for known in self.specs() if (known.domain, known.path_pattern) == (spec.domain, spec.path_pattern)]
        current = newest(same_key)
        saved = spec.model_copy(update={"version": current.version + 1 if current else 1})
        (self.generated_dir / spec_file_name(saved)).write_text(saved.model_dump_json(indent=2))
        return saved
