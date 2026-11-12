"""Memory growth: the journal is searched by your words once it is too long to read whole, and finished months are
rolled into one summary file each, so prompts stay small however long you use openMoi. A rollup keeps every note and
says how often you opened each site; the day files it replaces are removed only after the summary is written."""

import math
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from moi_brain.files import read_text, write_atomic

DAY_FILE = re.compile(r"^(\d{4})(\d{2})(\d{2})\.md$")
SUMMARY_FILE = re.compile(r"^(\d{4})-(\d{2})\.summary\.md$")
LINK = re.compile(r"\((https?://[^)\s]+)\)\s*$")
WORD = re.compile(r"[a-z0-9]+")
MAX_MATCHES = 30
MIN_WORD = 3
# Words of a question that say nothing about what it asks for; the rest count more the rarer they are in the journal.
STOP_WORDS = frozenset(
    "the and for with from that this was were are what which who whom when where why how did does that's there their "
    "about into over after before than then them they you your read piece article post thing one some any all can could "
    "would should have has had not but its it's also just like again last week month year day opened note".split()
)


def journal_lines(folder: Path) -> list[str]:
    """Every journal line, oldest first: summaries of past months, then day files."""
    files = sorted(path for path in folder.glob("*.md") if SUMMARY_FILE.match(path.name)) + sorted(path for path in folder.glob("*.md") if DAY_FILE.match(path.name))
    return [line for path in files for line in read_text(path).splitlines() if line.startswith("* ")]


def matching_lines(folder: Path, question: str, limit: int = MAX_MATCHES) -> list[str]:
    """Journal lines sharing the question's telling words, best first: each shared word counts more the fewer lines
    hold it, so "lithium" outweighs "that" and "was". Newest first among equals."""
    wanted = {word for word in WORD.findall(question.lower()) if len(word) >= MIN_WORD and word not in STOP_WORDS}
    lines = journal_lines(folder)
    words_of = [set(WORD.findall(line.lower())) & wanted for line in lines]
    holding = Counter(word for words in words_of for word in words)
    scored = []
    for position, (line, words) in enumerate(zip(lines, words_of, strict=True)):
        if words:
            scored.append((round(sum(math.log(1 + len(lines) / holding[word]) for word in words), 6), position, line))
    return [line for _, _, line in sorted(scored, reverse=True)[:limit]]


def site_of(line: str) -> str:
    match = LINK.search(line)
    return (urlparse(match.group(1)).hostname or "").removeprefix("www.") if match else ""


def roll_up(folder: Path, before: datetime) -> list[str]:
    """Day files of months before the month of `before` become one summary per month: its notes, and opens counted
    per site. Returns the summary files written."""
    months: dict[str, list[Path]] = {}
    current = f"{before.astimezone():%Y-%m}"
    for path in folder.glob("*.md"):
        match = DAY_FILE.match(path.name)
        if match and f"{match.group(1)}-{match.group(2)}" < current:
            months.setdefault(f"{match.group(1)}-{match.group(2)}", []).append(path)
    written = []
    for month, paths in sorted(months.items()):
        lines = [line for path in sorted(paths) for line in read_text(path).splitlines() if line.startswith("* ")]
        notes = [line for line in lines if " note: " in line]
        sites = Counter(site for line in lines if " opened: " in line and (site := site_of(line)))
        summary_path = folder / f"{month}.summary.md"
        kept = [line for line in read_text(summary_path).splitlines() if line.startswith("* ")]
        opened = [f"* opened {count} from {site}" for site, count in sites.most_common()]
        write_atomic(summary_path, "\n".join([f"# {month}", "", *dict.fromkeys([*kept, *notes, *opened])]) + "\n")
        for path in paths:
            path.unlink()
        written.append(summary_path.name)
    return written
