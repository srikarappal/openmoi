"""Lens generation: the smart model writes one self contained HTML file for a view's Layout text.

The model sees the layout words, the item schema, the helper API and the default lens. Never your items.
"""

import json

from moi_brain.items import ViewItem
from moi_brain.llm import Gateway
from moi_brain.lenses import LENS_KINDS

DEFAULT_LAYOUT = "Clean and readable."
HELPER_API = """moi.on_render((items, cursor) => {})   replace everything with these items
moi.on_append((items, cursor) => {})   add these items below, skipping item ids already shown
moi.ready()                            call once after registering both listeners; the host then sends the first render
moi.open(item_id)                      open the original
moi.more(cursor)                       ask for the next page when cursor is not null and the end of the list is visible
moi.seen(item_ids)                     report items that were visible for at least one second
moi.less_like_this(item_id)            the person wants fewer items like this one
Each entry of items is {"item": <Item>, "reasons": ["boost: author maya", "recent", "from x"]}; cursor is a string or null."""
SYSTEM_PROMPT = """You write lenses for openMoi, a personal feed reader: one self contained HTML document that renders items the way the person described.
Rules:
* Reply with only the HTML document.
* Inline all CSS and JavaScript. No external scripts, styles or fonts; only https images from item fields may load.
* Never use fetch, XMLHttpRequest, WebSocket, storage APIs, cookies, eval, forms or window.open.
* Talk to the host only through the global moi helper described in the request.
* Every item element carries data-item-id set to item.item_id; clicking it calls moi.open(item.item_id).
* Set text with textContent, never innerHTML: item text comes from the web.
* Handle missing fields, long text and every item kind: post, article, video, product, link.
* One article item whose extra.blocks is a JSON list of {type: h | p | img | quote | li, text, src} renders as a reader.
* Support light and dark mode with prefers-color-scheme.
Start from the example lens and change it to match the layout request. If last_error is set, your previous lens failed that check; fix it."""


def html_document(text: str) -> str:
    """The HTML document in a reply, dropping any prose before it."""
    lowered = text.lower()
    for marker in ("<!doctype", "<html"):
        index = lowered.find(marker)
        if index != -1:
            return text[index:].strip()
    index = text.find("<")
    return text[index:].strip() if index != -1 else text.strip()


def lens_messages(layout: str, kind: str, example: str, last_error: str | None) -> list[dict[str, str]]:
    payload = {
        "layout": layout.strip() or DEFAULT_LAYOUT,
        "kind": kind,
        "last_error": last_error,
        "helper_api": HELPER_API,
        "item_schema": ViewItem.model_json_schema(),
        "example_lens": example,
    }
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": json.dumps(payload)}]


def generate_lens(gateway: Gateway, layout: str, kind: str, example: str, last_error: str | None) -> str:
    if kind not in LENS_KINDS:
        raise ValueError(f"unknown lens kind {kind}")
    reply = gateway.complete_text("smart", "lens", lens_messages(layout, kind, example, last_error), contains_user_content=False)
    return html_document(reply)
