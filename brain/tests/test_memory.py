from datetime import UTC, datetime, timedelta

from moi_brain.config import REPO_DIR, Paths, ensure_home
from moi_brain.memory import Memory, journal_name

NOW = datetime(2026, 11, 4, 9, 30, tzinfo=UTC)


def make_memory(tmp_path) -> Memory:
    paths = Paths(home=tmp_path, assets=REPO_DIR)
    ensure_home(paths)
    return Memory(paths)


def test_seeded_files_read_as_empty_because_hints_are_comments(tmp_path):
    memory = make_memory(tmp_path)
    assert memory.likes() == ""
    assert memory.dislikes() == ""
    assert "## about_me.md\n(empty)" in memory.context(NOW)
    assert memory.context(NOW).endswith("## journal, recent\n(empty)")


def test_context_holds_every_topic_file(tmp_path):
    memory = make_memory(tmp_path)
    (memory.paths.memory / "about_me.md").write_text("# about me\n\n* Vegetarian.\n")
    (memory.paths.memory / "people.md").write_text("# people\n\n* Maya: x @maya\n")
    context = memory.context(NOW)
    assert "## about_me.md\n* Vegetarian." in context
    assert "## people.md\n* Maya: x @maya" in context


def test_journal_appends_one_file_per_day(tmp_path):
    memory = make_memory(tmp_path)
    memory.append_journal(NOW, "opened: First (https://a.com/1)")
    memory.append_journal(NOW + timedelta(minutes=5), "opened: Second (https://a.com/2)")
    memory.append_journal(NOW + timedelta(days=1), "opened: Tomorrow (https://a.com/3)")
    today = (memory.paths.journal / "20261104.md").read_text()
    assert today == "# 20261104\n\n* 09:30 opened: First (https://a.com/1)\n* 09:35 opened: Second (https://a.com/2)\n"
    assert journal_name(NOW + timedelta(days=1)) == "20261105.md"
    assert memory.journal_lines(NOW + timedelta(days=1))[-1] == "* 09:30 opened: Tomorrow (https://a.com/3)"


def test_journal_window_is_fourteen_days_and_capped(tmp_path):
    memory = make_memory(tmp_path)
    memory.append_journal(NOW - timedelta(days=20), "opened: Too old (https://a.com/old)")
    for index in range(70):
        memory.append_journal(NOW - timedelta(minutes=70 - index), f"opened: item {index} (https://a.com/{index})")
    lines = memory.journal_lines(NOW)
    assert len(lines) == 60
    assert lines[-1].endswith("item 69 (https://a.com/69)")
    assert not any("Too old" in line for line in lines)
