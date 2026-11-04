"""Memory as plain .md files: read whole into prompts and changed only by edits you confirm."""

from datetime import datetime, timedelta

from moi_brain.config import Paths
from moi_brain.md import body_text

TOPIC_FILES = ("about_me.md", "likes.md", "dislikes.md", "people.md")
JOURNAL_DAYS = 14
MAX_JOURNAL_LINES = 60


def journal_name(moment: datetime) -> str:
    return f"{moment:%Y%m%d}.md"


class Memory:
    def __init__(self, paths: Paths):
        self.paths = paths

    def topic_text(self, name: str) -> str:
        path = self.paths.memory / name
        return body_text(path.read_text()) if path.exists() else ""

    def likes(self) -> str:
        return self.topic_text("likes.md")

    def dislikes(self) -> str:
        return self.topic_text("dislikes.md")

    def journal_lines(self, now: datetime) -> list[str]:
        lines: list[str] = []
        for days_back in range(JOURNAL_DAYS - 1, -1, -1):
            path = self.paths.journal / journal_name(now - timedelta(days=days_back))
            if path.exists():
                lines += [line for line in path.read_text().splitlines() if line.startswith("* ")]
        return lines[-MAX_JOURNAL_LINES:]

    def append_journal(self, now: datetime, line: str) -> None:
        path = self.paths.journal / journal_name(now)
        if not path.exists():
            path.write_text(f"# {now:%Y%m%d}\n\n")
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"* {now:%H:%M} {line}\n")
