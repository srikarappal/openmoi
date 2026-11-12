"""Memory as plain .md files: read whole into prompts and changed only by edits you confirm."""

from datetime import datetime, timedelta

from moi_brain.config import Paths
from moi_brain.files import read_text
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
        return body_text(read_text(path))

    def likes(self) -> str:
        return self.topic_text("likes.md")

    def dislikes(self) -> str:
        return self.topic_text("dislikes.md")

    def journal_lines(self, now: datetime) -> list[str]:
        now = now.astimezone()
        lines: list[str] = []
        for days_back in range(JOURNAL_DAYS - 1, -1, -1):
            path = self.paths.journal / journal_name(now - timedelta(days=days_back))
            if path.exists():
                lines += [line for line in read_text(path).splitlines() if line.startswith("* ")]
        return lines[-MAX_JOURNAL_LINES:]

    def add_highlight(self, now: datetime, line: str) -> None:
        """A highlight or note on what you read, kept in memory/highlights.md, newest last."""
        path = self.paths.memory / "highlights.md"
        if not path.exists():
            path.write_text("# Highlights\n\nPassages you marked and notes you wrote on what you read.\n\n")
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"* {now.astimezone():%Y-%m-%d} {line}\n")

    def append_journal(self, now: datetime, line: str) -> None:
        """One line in today's journal, named and timed on your clock: an item opened at 18:00 lands in today's file."""
        now = now.astimezone()
        path = self.paths.journal / journal_name(now)
        if not path.exists():
            path.write_text(f"# {now:%Y%m%d}\n\n")
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"* {now:%H:%M} {line}\n")
