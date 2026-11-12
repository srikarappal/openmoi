"""Sharing views as files: a friend's filter runs on your own sources and session, and yours travels without your people.

An imported file is untrusted text. Only a view's own sections (Sources, Rules, Layout, Time) are kept and it becomes a
proposal you confirm like any edit; its look is generated fresh from its Layout, never copied. A shared copy leaves out
rule lines naming people, your following lists and pages you watch.
"""

import re

from moi_brain.compile import HANDLE
from moi_brain.md import COMMENT, bullets, parse_sections, section_text

MAX_IMPORT = 20_000
KEPT_SECTIONS = ("Sources", "Match", "Rules", "Layout", "Time")
PERSONAL_SOURCES = re.compile(r"^\s*(following|watch)\s*:", re.IGNORECASE)
NAME = re.compile(r"[^a-z0-9_]+")
MAX_NAME = 40


def view_name(raw: str) -> str:
    """A file or title as a view id: "AI news (no hype).md" becomes ai_news_no_hype."""
    name = NAME.sub("_", raw.lower().removesuffix(".md")).strip("_")[:MAX_NAME].strip("_")
    return name or "shared_view"


def view_text(title: str, sections: dict[str, str]) -> str:
    parts = [f"# {title}"]
    for name in KEPT_SECTIONS:
        body = section_text(sections, name)
        if body:
            parts.append(f"## {name}\n{body}")
    return "\n\n".join(parts) + "\n"


def clean_import(text: str) -> tuple[str, str] | None:
    """(title, file text) with only a view's own sections, comments gone; None when it is no openMoi view."""
    title, sections = parse_sections(COMMENT.sub("", text[:MAX_IMPORT]))
    if not (bullets(section_text(sections, "sources")) or bullets(section_text(sections, "rules"))):
        return None
    title = " ".join(title.split())[:80] or "Shared view"
    return title, view_text(title, sections)


def session_reads(text: str) -> list[str]:
    """Source lines that read pages in your own session (X, Page, Watch, Following), to show before you confirm."""
    _, sections = parse_sections(text)
    return [line for line in bullets(section_text(sections, "sources")) if re.match(r"^\s*(x|twitter|page|watch|following)\b", line, re.IGNORECASE)]


def people_names(people: str) -> list[str]:
    """Names from memory/people.md, and each one's first name: "* Maya Kumar, my sister: @maya" gives Maya Kumar and Maya."""
    names: list[str] = []
    for line in bullets(people):
        name = re.split(r"[,:(]", HANDLE.sub("", line), maxsplit=1)[0].strip()
        if len(name) >= 2:
            names += [name, name.split()[0]]
    return list(dict.fromkeys(names))


def names_someone(line: str, names: list[str]) -> bool:
    return bool(HANDLE.search(line)) or any(re.search(rf"\b{re.escape(name)}\b", line, re.IGNORECASE) for name in names)


def share_text(text: str, names: list[str] | None = None) -> str:
    """Your view without rule lines that name people (a handle, or someone in your people file), your following
    lists or the pages you watch."""
    title, sections = parse_sections(text)
    kept = dict(sections)
    for name, body in sections.items():
        lowered = name.lower()
        if lowered == "rules":
            kept[name] = "\n".join(f"* {line}" for line in bullets(body) if not names_someone(line, names or []))
        elif lowered == "sources":
            kept[name] = "\n".join(f"* {line}" for line in bullets(body) if not PERSONAL_SOURCES.match(line))
    return view_text(title or "Shared view", kept)
