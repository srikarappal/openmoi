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
from moi_brain.items import Item
from moi_brain.lenses import SITE_PREFIX
from moi_brain.llm import Gateway
from moi_brain.md import replace_body, replace_section
from moi_brain.memory import TOPIC_FILES

VIEW_SECTIONS = ("Sources", "Rules", "Layout")
MAX_PROPOSALS = 50
MAX_EDIT_TEXT = 6000
LensAction = Literal["rollback"]
SYSTEM_PROMPT = """You edit the plain text files that configure openMoi, a personal feed reader, for one person.
Reply with one JSON object:
{"edits": [{"file": "<path>", "section": "<heading or null>", "text": "<complete new text>"}], "lens_action": null, "reply": "<one short sentence>"}

Files you may edit, all given to you with their current content:
* views/<view>.md: sections "Sources", "Rules" and "Layout". For these give "section" and the complete new text of that section.
  Rules are plain words, one per line, each line starting with "* ". Layout describes the look in plain words.
* memory/about_me.md, memory/likes.md, memory/dislikes.md, memory/people.md: lists of lines starting with "* ".
  For these use "section": null and give the complete new list.

Keep every existing line unless the person asks to change or remove it. Add new lines in the same style.
Rules for this one view go in the view's Rules section. Facts about the person go in about_me.md.
Things they never want to see in any view go in dislikes.md; things they want more of everywhere go in likes.md.
How the view looks goes in Layout.
When the person reacts to an item with "less like this", add one short line naming what to avoid (its topic, author or kind) to dislikes.md, or to the view's Rules if it only concerns this view.
When they ask for the previous look back, reply with no edits and "lens_action": "rollback".
When nothing should change, reply with no edits.
The reply says in plain words what you changed."""


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

    def files(self, view_id: str) -> dict[str, str]:
        """The files an edit for this view may touch, with their current content."""
        paths = {f"views/{view_id}.md": self.paths.views / f"{view_id}.md"}
        paths |= {f"memory/{name}": self.paths.memory / name for name in TOPIC_FILES}
        return {file: path.read_text() if path.exists() else "" for file, path in paths.items()}

    def propose(self, view_id: str, request: str, item: Item | None) -> Proposal:
        files = self.files(view_id)
        payload = {"request": request, "view": view_id, "item": item_context(item), "files": files}
        messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": json.dumps(payload)}]
        reply = self.gateway.complete_json("fast", "edit", messages, True, EditReply)
        changes = [change for edit in reply.edits if (change := self.change_for(view_id, edit, files))]
        proposal = Proposal(
            proposal_id=uuid.uuid4().hex, view_id=view_id, changes=changes, lens_action=reply.lens_action, reply=reply.reply
        )
        with self.lock:
            self.proposals[proposal.proposal_id] = proposal
            while len(self.proposals) > MAX_PROPOSALS:
                self.proposals.popitem(last=False)
        return proposal

    def change_for(self, view_id: str, edit: FileEdit, files: dict[str, str]) -> Change | None:
        """The concrete change for one model edit, or None if it targets something it may not touch."""
        file = edit.file.strip().removeprefix("./")
        if file not in files:
            return None
        old = files[file]
        if file.startswith("views/"):
            section = next((name for name in VIEW_SECTIONS if edit.section and name.lower() == edit.section.strip().lower()), None)
            if section is None:
                return None
            new = replace_section(old or f"# {view_id.removeprefix(SITE_PREFIX)}\n", section, edit.text)
        else:
            new = replace_body(old or f"# {file.removeprefix('memory/').removesuffix('.md')}\n", edit.text)
        if new == old:
            return None
        return Change(file=file, old_text=old, new_text=new, diff=unified_diff(file, old, new))

    def apply(self, proposal_id: str) -> Proposal:
        """Write a proposal's changes, refusing if any file changed since it was proposed."""
        with self.lock:
            proposal = self.proposals.pop(proposal_id, None)
        if proposal is None:
            raise BadInput("That proposal is gone; ask again.")
        targets = [(self.paths.home / change.file, change) for change in proposal.changes]
        for path, change in targets:
            if (path.read_text() if path.exists() else "") != change.old_text:
                raise BadInput(f"{change.file} changed since this was proposed; ask again.")
        for path, change in targets:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(change.new_text)
        return proposal

    def discard(self, proposal_id: str) -> None:
        with self.lock:
            self.proposals.pop(proposal_id, None)
