"""Lens generation: the smart model changes the current lens for a view's Layout text.

Patch mode first: the model answers with small find and replace edits on the lens now live (the default lens when
there is none yet), which keeps what already works. When it asks for a rewrite, or its edits do not apply, it writes
the whole lens instead, starting from the example. The model sees the layout words, the item schema, the helper API,
the shared design tokens and lens code. Never your items.
"""

import base64
import json
import re

from pydantic import BaseModel, Field

from moi_brain.items import ViewItem
from moi_brain.llm import Gateway, InvalidReply, LlmError
from moi_brain.lenses import LENS_KINDS

DEFAULT_LAYOUT = "Clean and readable."
TOKEN_NAME = re.compile(r"(--[\w-]+)\s*:")
MAX_EDITS = 40
HELPER_API = """moi.on_render((items, cursor) => {})   replace everything with these items
moi.on_append((items, cursor) => {})   add these items below, skipping item ids already shown
moi.ready()                            call once after registering both listeners; the host then sends the first render
moi.open(item_id)                      open the original
moi.more(cursor)                       ask for the next page when cursor is not null and the end of the list is visible,
                                       also right after a render or append that leaves the end visible (observe the end again)
moi.seen(item_ids)                     report items that were visible for at least one second
moi.less_like_this(item_id)            the person wants fewer items like this one
moi.play(item_id)                      play a YouTube video in the host's player above the lens (on a click only)
moi.save(item_id) / moi.unsave(item_id) keep the item in Read later, or take it out (on a click only)
moi.lookup(item_id, entity)            look up a name the item mentions (from mentions, when can_look_up) in the view's
                                       store: one search page; call it from the click on a button with data-action
                                       "look_up" and data-entity set to the name, inside the item's data-item-id element
moi.open(related.item_id)              open an item shown with a card (entry of related), at its own address
moi.act(item_id, action, text)         ask openMoi to do one of item.available_actions on the item's site (like, follow,
                                       reply with text); call it from the click on a button whose data-action is that
                                       action, inside the item's data-item-id element: the host checks your click landed
                                       on exactly that control and ignores the call otherwise
Each entry of items is {"item": <Item>, "reasons": ["boost: author maya", "recent", "from x"], "related": [...], "mentions": [...]};
related lists items a recipe shows with the card (a copy of the story, the product in another store, what a post
mentions), each {item_id, title, url, price_text, label}; mentions lists names a post mentions, each {entity, status,
can_look_up}. cursor is a string or null."""
SYSTEM_PROMPT = """You write lenses for openMoi, a personal feed reader: one self contained HTML document that renders items the way the person described.
Rules:
* Reply with only the HTML document.
* Inline all CSS and JavaScript. No external scripts, styles or fonts; only https images from item fields may load.
* Never use fetch, XMLHttpRequest, WebSocket, storage APIs, cookies, eval, forms or window.open.
* Talk to the host only through the global moi helper described in the request.
* Every item element carries data-item-id set to item.item_id; clicking it calls moi.open(item.item_id).
* Set text with textContent, never innerHTML (except innerHTML = "" to clear): item text comes from the web.
* No inline event handler attributes such as onclick="...": use addEventListener in your script.
* Handle missing fields, long text and every item kind: post, article, video, product, link.
* item.source_id is "x", "youtube:<channel>", "rss:<site>" or "site:<domain>"; the part before ":" names the source, for layouts that group or label by source.
* One article item whose extra.blocks is a JSON list of {type: h | p | img | quote | li, text, src} renders as a reader.
* When an item has extra.summary (and for videos extra.worth_watching, such as "5:30 to 9:45: the test"), show them on its card.
  A summary made later arrives through moi.on_update(items => ...): refresh those items' cards in place, never re-render.
* Colors, fonts, radii and shadows come only from the shared design tokens the host defines before your styles (listed
  in design_tokens), used as var(--name). Never write a color: no #hex, rgb(), hsl() or color names, not even as a
  var() fallback or in a variable of your own. Light and dark mode come with the tokens.
* No forms, frames, link tags, script files, @import or addresses of other sites in markup or CSS.
Start from the example lens and change it to match the layout request. If last_error is set, your previous lens failed that check; fix it."""
RULES = SYSTEM_PROMPT.split("Rules:\n", 1)[1].rsplit("\nStart from", 1)[0]
PATCH_PROMPT = f"""You change a lens for openMoi, a personal feed reader: one self contained HTML document that renders items.
current_lens is the lens live now. Change it to match the layout request with small edits, keeping everything else.
Reply with one JSON object: {{"edits": [{{"find": "<text copied exactly from current_lens>", "replace": "<its new text>"}}], "rewrite": false}}.
Each find must appear exactly once in current_lens; include enough surrounding text to make it unique. Edits apply in order.
If the request needs a different lens altogether, reply {{"edits": [], "rewrite": true}}.
The lens must keep following these rules:
{RULES}
If last_error is set, the lens your last edits made failed that check; fix it."""


def html_document(text: str) -> str:
    """The HTML document in a reply, dropping any prose before it."""
    lowered = text.lower()
    for marker in ("<!doctype", "<html"):
        index = lowered.find(marker)
        if index != -1:
            return text[index:].strip()
    index = text.find("<")
    return text[index:].strip() if index != -1 else text.strip()


JUDGE_PROMPT = """You check a new lens for openMoi, a personal feed reader. You see a screenshot of the lens showing
made up test items, and the layout words the person asked for. Decide whether the look follows those words: columns,
grouping, density, what is shown or left out, emphasis. Ignore the made up text and images themselves.
Reply with one JSON object: {"matches": true or false, "problem": "<what does not follow the layout, one sentence, or empty>"}."""


class LensVerdict(BaseModel):
    verdict: str = "skipped"
    problem: str = ""


class JudgeReply(BaseModel):
    matches: bool = True
    problem: str = ""


class LensEdit(BaseModel):
    find: str = Field(min_length=1)
    replace: str


class LensPatch(BaseModel):
    edits: list[LensEdit] = Field(default_factory=list, max_length=MAX_EDITS)
    rewrite: bool = False


class LensPatchError(ValueError):
    """An edit whose text is not found exactly once in the lens."""


def token_names(tokens_css: str) -> list[str]:
    return list(dict.fromkeys(TOKEN_NAME.findall(tokens_css)))


def apply_edits(html: str, edits: list[LensEdit]) -> str:
    """The lens with each edit applied in turn; an edit whose find is missing or ambiguous fails the whole patch."""
    for number, change in enumerate(edits, start=1):
        found = html.count(change.find)
        if found != 1:
            raise LensPatchError(f"edit {number} finds its text {found} times instead of once")
        html = html.replace(change.find, change.replace, 1)
    return html


def lens_payload(layout: str, kind: str, last_error: str | None, tokens: list[str]) -> dict[str, object]:
    return {
        "layout": layout.strip() or DEFAULT_LAYOUT,
        "kind": kind,
        "last_error": last_error,
        "helper_api": HELPER_API,
        "design_tokens": tokens,
        "item_schema": ViewItem.model_json_schema(),
    }


def lens_messages(layout: str, kind: str, example: str, last_error: str | None, tokens: list[str] | None = None) -> list[dict[str, str]]:
    payload = {**lens_payload(layout, kind, last_error, tokens or []), "example_lens": example}
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": json.dumps(payload)}]


def patch_messages(layout: str, kind: str, current: str, last_error: str | None, tokens: list[str]) -> list[dict[str, str]]:
    payload = {**lens_payload(layout, kind, last_error, tokens), "current_lens": current}
    return [{"role": "system", "content": PATCH_PROMPT}, {"role": "user", "content": json.dumps(payload)}]


def generate_lens(gateway: Gateway, layout: str, kind: str, example: str, last_error: str | None, current: str | None = None, tokens_css: str = "") -> str:
    """The new lens: edits on `current` when given and they apply, else a whole lens written from `example`."""
    if kind not in LENS_KINDS:
        raise ValueError(f"unknown lens kind {kind}")
    tokens = token_names(tokens_css)
    if current:
        try:
            patch = gateway.complete_json("smart", "lens_patch", patch_messages(layout, kind, current, last_error, tokens), False, LensPatch)
            if patch.edits and not patch.rewrite:
                return apply_edits(current, patch.edits)
        except (InvalidReply, LensPatchError):
            pass
    reply = gateway.complete_text("smart", "lens", lens_messages(layout, kind, example, last_error, tokens), contains_user_content=False)
    return html_document(reply)


def judge_messages(layout: str, kind: str, screenshot: bytes) -> list[dict[str, object]]:
    image = f"data:image/png;base64,{base64.b64encode(screenshot).decode()}"
    request = json.dumps({"layout": layout.strip() or DEFAULT_LAYOUT, "kind": kind})
    content = [{"type": "text", "text": request}, {"type": "image_url", "image_url": {"url": image}}]
    return [{"role": "system", "content": JUDGE_PROMPT}, {"role": "user", "content": content}]


def judge_lens(gateway: Gateway, layout: str, kind: str, screenshot: bytes) -> LensVerdict:
    """The vision model's verdict on a screenshot of the lens with made up items: "matches", "differs" with what does
    not follow the layout, or "skipped" when there is no vision model or it did not answer. The screenshot holds no
    content of yours, so a hosted vision model may see it."""
    if gateway.settings.vision is None:
        return LensVerdict(verdict="skipped", problem="no vision model is set up")
    try:
        reply = gateway.complete_json("vision", "judge_lens", judge_messages(layout, kind, screenshot), False, JudgeReply)
    except LlmError as error:
        return LensVerdict(verdict="skipped", problem=str(error))
    return LensVerdict(verdict="matches") if reply.matches else LensVerdict(verdict="differs", problem=reply.problem.strip() or "it does not follow the layout")
