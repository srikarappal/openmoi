"""Chat edits: the model proposes new text for sections of your files, you confirm, then they are written."""

import difflib
import json
import threading
import uuid
from collections import OrderedDict
from typing import Literal

from pydantic import BaseModel, Field

from moi_brain.compile import BadInput
from moi_brain.config import Paths
from moi_brain.files import read_text, write_atomic
from moi_brain.items import Item
from moi_brain.lenses import SITE_PREFIX
from moi_brain.llm import Gateway
from moi_brain.md import replace_body, replace_section
from moi_brain.memory import TOPIC_FILES

VIEW_SECTIONS = ("Sources", "Rules", "Layout")
MAX_PROPOSALS = 50
# Memory files come back whole on every edit, so the cap leaves room for years of likes and dislikes.
MAX_EDIT_TEXT = 60_000
LensAction = Literal["rollback"]
EditScope = Literal["any", "memory", "rules", "sources", "layout", "view"]
SCOPE_SECTIONS = {"rules": "Rules", "sources": "Sources", "layout": "Layout"}
SCOPE_RULES = {
    "any": None,
    "memory": "Only change the memory files.",
    "rules": "Only change the Rules section of the view.",
    "sources": "Only change the Sources section of the view.",
    "layout": "Only change the Layout section of the view.",
    "view": "Write the view file's Sources, Rules and Layout sections from the request. Do not touch memory.",
}
SYSTEM_PROMPT = """You edit the plain text files that configure openMoi, a personal feed reader, for one person.
Reply with one JSON object:
{"edits": [{"file": "<path>", "section": "<heading or null>", "text": "<complete new text>"}], "lens_action": null, "reply": "<one short sentence>"}

recent_journal lists what the person opened lately; use it when the request refers to it.
Files you may edit, all given to you with their current content:
* views/<view>.md: sections "Sources", "Rules" and "Layout". For these give "section" and the complete new text of that section.
  Rules are plain words, one per line, each line starting with "* ".
  Layout describes the look in plain words, one idea per line. Add what the person asks for as new lines, close to their own words
  (for example "A separate section for each source."). Keep every existing Layout line unless the request names that exact look
  and asks to drop or change it: a request about one aspect (sections, sizes, colors) never removes lines about another (tile style).
* memory/about_me.md, memory/likes.md, memory/dislikes.md, memory/people.md: lists of lines starting with "* ".
  For these use "section": null and give the complete new list.

Keep every existing line unless the person asks to change or remove it. Add new lines in the same style.
Rules for this one view go in the view's Rules section. Facts about the person go in about_me.md.
Things they never want to see in any view go in dislikes.md; things they want more of everywhere go in likes.md.
How the view looks goes in Layout.
When the person reacts to an item with "less like this", add one short line naming what to avoid (its topic, author or kind) to dislikes.md, or to the view's Rules if it only concerns this view.
When they ask for the previous look back, reply with no edits and "lens_action": "rollback".
When nothing should change, reply with no edits.
When the request has only_change, edit nothing else.
The reply says in plain words what you changed."""


class StaleProposal(BadInput):
    """A file changed between proposing and applying; the request has to be asked again on top of it."""


class FileEdit(BaseModel):
    file: str
    section: str | None = None
    text: str = Field(max_length=MAX_EDIT_TEXT)


class EditReply(BaseModel):
    edits: list[FileEdit] = Field(default_factory=list)
    lens_action: LensAction | None = None
    reply: str = ""


class Change(BaseModel):
    file: str
    old_text: str
    new_text: str
    diff: str


class Proposal(BaseModel):
    proposal_id: str
    view_id: str
    changes: list[Change]
    lens_action: LensAction | None = None
    reply: str


def item_context(item: Item | None) -> dict[str, object] | None:
    if item is None:
        return None
    return {
        "title": item.title,
        "text": (item.text or "")[:300],
        "source_id": item.source_id,
        "author_handle": item.author_handle,
        "media_kind": item.media_kind,
        "topics": item.topics,
    }


def unified_diff(file: str, old: str, new: str) -> str:
    return "\n".join(difflib.unified_diff(old.splitlines(), new.splitlines(), f"a/{file}", f"b/{file}", lineterm=""))


class Editor:
    def __init__(self, paths: Paths, gateway: Gateway):
        self.paths = paths
        self.gateway = gateway
        self.lock = threading.Lock()
        self.proposals: OrderedDict[str, Proposal] = OrderedDict()

    def files(self, view_id: str, scope: EditScope = "any") -> dict[str, str]:
        """The files an edit for this view and scope may touch, with their current content."""
        paths = {} if scope == "memory" else {f"views/{view_id}.md": self.paths.views / f"{view_id}.md"}
        if scope in ("any", "memory"):
            paths |= {f"memory/{name}": self.paths.memory / name for name in TOPIC_FILES}
        return {file: read_text(path) for file, path in paths.items()}

    def propose(self, view_id: str, request: str, item: Item | None, journal: list[str], scope: EditScope = "any") -> Proposal:
        """The model sees the request, the item reacted to, recent journal lines and every file it may edit."""
        files = self.files(view_id, scope)
        payload = {
            "request": request,
            "view": view_id,
            "only_change": SCOPE_RULES[scope],
            "item": item_context(item),
            "recent_journal": journal,
            "files": files,
        }
        messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": json.dumps(payload)}]
        reply = self.gateway.complete_json("fast", "edit", messages, True, EditReply)
        changes = self.changes_for(view_id, reply.edits, files, scope)
        proposal = Proposal(
            proposal_id=uuid.uuid4().hex, view_id=view_id, changes=changes, lens_action=reply.lens_action, reply=reply.reply
        )
        with self.lock:
            self.proposals[proposal.proposal_id] = proposal
            while len(self.proposals) > MAX_PROPOSALS:
                self.proposals.popitem(last=False)
        return proposal

    def change_for(self, view_id: str, edit: FileEdit, files: dict[str, str], scope: EditScope = "any") -> Change | None:
        """The concrete change for one model edit, or None if it targets something its scope does not allow."""
        file = edit.file.strip().removeprefix("./")
        if file not in files:
            return None
        old = files[file]
        if file.startswith("views/"):
            section = next((name for name in VIEW_SECTIONS if edit.section and name.lower() == edit.section.strip().lower()), None)
            if section is None or SCOPE_SECTIONS.get(scope, section) != section:
                return None
            new = replace_section(old or f"# {view_id.removeprefix(SITE_PREFIX)}\n", section, edit.text)
        else:
            new = replace_body(old or f"# {file.removeprefix('memory/').removesuffix('.md')}\n", edit.text)
        if new == old:
            return None
        return Change(file=file, old_text=old, new_text=new, diff=unified_diff(file, old, new))

    def changes_for(self, view_id: str, edits: list[FileEdit], files: dict[str, str], scope: EditScope = "any") -> list[Change]:
        """One change per file: edits to the same file build on each other instead of overwriting."""
        current = dict(files)
        for edit in edits:
            if change := self.change_for(view_id, edit, current, scope):
                current[change.file] = change.new_text
        return [
            Change(file=file, old_text=files[file], new_text=text, diff=unified_diff(file, files[file], text))
            for file, text in current.items()
            if text != files[file]
        ]

    def apply(self, proposal_id: str) -> Proposal:
        """Write a proposal's changes, refusing if any file changed since it was proposed."""
        with self.lock:
            proposal = self.proposals.pop(proposal_id, None)
            if proposal is None:
                raise BadInput("That proposal is gone; ask again.")
            targets = [(self.paths.home / change.file, change) for change in proposal.changes]
            for path, change in targets:
                if read_text(path) != change.old_text:
                    raise StaleProposal(f"{change.file} changed since this was proposed; ask again.")
            for path, change in targets:
                write_atomic(path, change.new_text)
        return proposal

    def discard(self, proposal_id: str) -> None:
        with self.lock:
            self.proposals.pop(proposal_id, None)
