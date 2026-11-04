import json

import httpx
import pytest

from moi_brain.compile import BadInput
from moi_brain.config import REPO_DIR, Paths, ensure_home
from moi_brain.edits import Editor, FileEdit
from moi_brain.llm import Gateway

VIEW = "# Feed\n\n## Sources\n* X\n\n## Rules\n* No shorts.\n\n## Layout\nCards.\n"


@pytest.fixture
def editor(tmp_path, settings):
    paths = Paths(home=tmp_path, assets=REPO_DIR)
    ensure_home(paths)
    (paths.views / "feed.md").write_text(VIEW)
    with httpx.Client(timeout=5) as http:
        yield Editor(paths, Gateway(settings, paths.llm_log, http))


def test_files_lists_the_view_and_memory_topic_files(editor):
    files = editor.files("feed")
    assert list(files) == ["views/feed.md", "memory/about_me.md", "memory/likes.md", "memory/dislikes.md", "memory/people.md"]
    assert files["views/feed.md"] == VIEW
    assert editor.files("tech")["views/tech.md"] == ""


def test_change_for_view_sections_and_memory_bodies(editor):
    files = editor.files("feed")
    rules = editor.change_for("feed", FileEdit(file="views/feed.md", section="rules", text="* No shorts.\n* Hide politics."), files)
    assert "## Rules\n* No shorts.\n* Hide politics.\n\n## Layout" in rules.new_text
    assert "+* Hide politics." in rules.diff
    memory = editor.change_for("feed", FileEdit(file="./memory/dislikes.md", text="* crypto"), files)
    assert memory.new_text == "# dislikes\n\n* crypto\n"
    new_view = editor.change_for("tech", FileEdit(file="views/tech.md", section="Sources", text="* X"), editor.files("tech"))
    assert new_view.new_text == "# tech\n\n## Sources\n* X\n"


@pytest.mark.parametrize(
    "edit",
    [
        FileEdit(file="views/other.md", section="Rules", text="* x"),
        FileEdit(file="memory/journal/20261104.md", text="* x"),
        FileEdit(file="../secrets.md", text="* x"),
        FileEdit(file="views/feed.md", section="Scripts", text="* x"),
        FileEdit(file="views/feed.md", section=None, text="* x"),
        FileEdit(file="views/feed.md", section="Rules", text="* No shorts."),
    ],
)
def test_change_for_refuses_other_files_sections_and_no_op_edits(editor, edit):
    assert editor.change_for("feed", edit, editor.files("feed")) is None


def test_propose_sends_files_and_item_then_apply_writes(editor, services):
    proposal = editor.propose("feed", "hide politics and maya first", None, ["* 09:30 opened: Sourdough tips (https://a.com/1)"])
    assert [change.file for change in proposal.changes] == ["views/feed.md"]
    assert proposal.reply == "Updated 1 file."
    request = json.loads(services.model_calls("edit")[0]["payload"]["messages"][1]["content"])
    assert request["files"]["views/feed.md"] == VIEW
    assert request["item"] is None
    assert request["recent_journal"] == ["* 09:30 opened: Sourdough tips (https://a.com/1)"]
    assert (editor.paths.views / "feed.md").read_text() == VIEW
    applied = editor.apply(proposal.proposal_id)
    written = (editor.paths.views / "feed.md").read_text()
    assert written == applied.changes[0].new_text
    assert "* Hide politics.\n* Posts from @maya always first." in written


def test_apply_refuses_unknown_reused_and_stale_proposals(editor):
    with pytest.raises(BadInput, match="gone"):
        editor.apply("nope")
    first = editor.propose("feed", "no shorts and hide politics", None, [])
    editor.apply(first.proposal_id)
    with pytest.raises(BadInput, match="gone"):
        editor.apply(first.proposal_id)
    stale = editor.propose("feed", "maya first", None, [])
    (editor.paths.views / "feed.md").write_text(VIEW + "\n")
    with pytest.raises(BadInput, match="changed since"):
        editor.apply(stale.proposal_id)


def test_discard_and_rollback_without_edits(editor):
    proposal = editor.propose("feed", "bring back the previous look", None, [])
    assert proposal.changes == []
    assert proposal.lens_action == "rollback"
    editor.discard(proposal.proposal_id)
    with pytest.raises(BadInput):
        editor.apply(proposal.proposal_id)


def test_proposals_are_bounded(editor, monkeypatch):
    monkeypatch.setattr("moi_brain.edits.MAX_PROPOSALS", 3)
    ids = [editor.propose("feed", "vegetarian", None, []).proposal_id for _ in range(5)]
    assert list(editor.proposals) == ids[-3:]
