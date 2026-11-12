"""Memory growth: searching a long journal and rolling finished months into summaries."""

from datetime import UTC, datetime

from moi_brain.journal import journal_lines, matching_lines, roll_up

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


def day(folder, name: str, lines: list[str]) -> None:
    (folder / name).write_text("\n".join([f"# {name[:-3]}", "", *lines]) + "\n")


def test_search_finds_what_you_read_by_your_words(tmp_path):
    day(tmp_path, "20261003.md", ["* 09:00 note: Lithium recycling: Redwood recovers 95% of lithium. (https://news.example/lithium)", "* 09:30 opened: Cats (https://www.cats.example/1)"])
    day(tmp_path, "20261110.md", ["* 10:00 opened: Lithium prices fall (https://markets.example/2)", "not a line"])
    found = matching_lines(tmp_path, "what was that piece on lithium recycling?")
    assert found[0].startswith("* 09:00 note: Lithium recycling")
    assert found[1].startswith("* 10:00 opened: Lithium prices")
    assert matching_lines(tmp_path, "an ok") == [] and matching_lines(tmp_path, "zebra") == []


def test_finished_months_roll_into_one_summary_with_notes_and_sites(tmp_path):
    day(tmp_path, "20261003.md", ["* 09:00 note: Lithium recycling: summary. (https://news.example/lithium)", "* 09:30 opened: Cats (https://www.cats.example/1)"])
    day(tmp_path, "20261004.md", ["* 10:00 opened: More cats (https://cats.example/2)", "* 11:00 opened: Plain line without a link"])
    day(tmp_path, "20261110.md", ["* 10:00 opened: This month (https://now.example/1)"])
    assert roll_up(tmp_path, NOW) == ["2026-10.summary.md"]
    assert (tmp_path / "2026-10.summary.md").read_text() == "# 2026-10\n\n* 09:00 note: Lithium recycling: summary. (https://news.example/lithium)\n* opened 2 from cats.example\n"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["2026-10.summary.md", "20261110.md"]
    assert journal_lines(tmp_path)[0].startswith("* 09:00 note: Lithium")
    assert matching_lines(tmp_path, "lithium")[0].startswith("* 09:00 note")
    day(tmp_path, "20261005.md", ["* 08:00 note: Late file: kept. (https://late.example/1)"])
    roll_up(tmp_path, NOW)
    assert "* 09:00 note: Lithium" in (tmp_path / "2026-10.summary.md").read_text()
    assert "* 08:00 note: Late file" in (tmp_path / "2026-10.summary.md").read_text()
    assert roll_up(tmp_path, NOW) == []
