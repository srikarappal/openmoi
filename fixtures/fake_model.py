"""A deterministic stand in for an OpenAI compatible model, keyed by the x-moi-task header.

Each task handler reads the JSON prompt the brain sent and answers the way a good model would
for the phrases our tests use. Unknown tasks echo the last user message as JSON.
"""

import html
import json
import re
from typing import Any
from urllib.parse import urlparse

SYNONYMS = {
    "politics": ("politic", "election", "senate", "congress"),
    "science": ("physics", "math", "telescope", "space", "science"),
    "technology": ("chip", "laptop", "database", "software"),
}
QUOTED = re.compile(r"\"([^\"]+)\"")
LIMIT = re.compile(r"at most (\d+) (?:posts )?from (\w+)")
HANDLE = re.compile(r"@([\w.]+)")
HIDE_TOPIC = re.compile(r"\b(?:hide|no)\s+(\w+)")
UNLESS = re.compile(r"\b(?:unless|except)\b.*\bfrom\s+(\w+)")
FIRST = re.compile(r"@?(\w+) (?:always )?first")


def last_user_text(payload: dict[str, Any]) -> str:
    users = [message["content"] for message in payload.get("messages", []) if message.get("role") == "user"]
    return users[-1] if users else ""


def request_of(payload: dict[str, Any]) -> dict[str, Any]:
    return json.loads(last_user_text(payload))


def echo(payload: dict[str, Any], base_url: str) -> str:
    return json.dumps({"echo": last_user_text(payload)})


def tag(payload: dict[str, Any], base_url: str) -> str:
    request = request_of(payload)
    tags = []
    for item in request["items"]:
        words = f"{item['title']} {item['text']}".lower()
        topics = [topic for topic in request["topics"] if any(word in words for word in SYNONYMS.get(topic, (topic,)))]
        tags.append({"item_id": item["item_id"], "topics": topics})
    return json.dumps({"tags": tags})


def condition(field: str, op: str, value: Any) -> dict[str, Any]:
    return {"field": field, "op": op, "value": value}


def view_rule(line: str) -> dict[str, Any] | None:
    text = line.lower()
    if "short" in text:
        return {"when": condition("media_kind", "eq", "short_video"), "do": "hide"}
    if (match := LIMIT.search(text)) is not None:
        return {"when": condition("source_id", "eq", match.group(2)), "do": "limit", "count_per_day": int(match.group(1))}
    if (match := HANDLE.search(text)) is not None and "first" in text:
        return {"when": condition("author_handle", "eq", match.group(1)), "do": "boost", "weight": 10}
    if (match := HIDE_TOPIC.search(text)) is not None:
        unless = UNLESS.search(text)
        return {
            "when": condition("topic", "eq", match.group(1)),
            "unless": condition("source_id", "eq", f"rss:{unless.group(1)}") if unless else None,
            "do": "hide",
        }
    return None


def memory_rule(line: str, do: str) -> dict[str, Any]:
    quoted = QUOTED.search(line)
    if quoted:
        return {"when": condition("text", "contains", quoted.group(1).lower()), "do": do, "weight": 3 if do == "boost" else 0}
    topic = re.sub(r"[^\w]", "", line.split()[-1].lower())
    return {"when": condition("topic", "eq", topic), "do": do, "weight": 3 if do == "boost" else 0}


def compile_rules(payload: dict[str, Any], base_url: str) -> str:
    request = request_of(payload)
    rules = [rule for line in request["view_rules"] if (rule := view_rule(line))]
    rules += [memory_rule(line, "hide") for line in request["dislikes"]]
    rules += [memory_rule(line, "boost") for line in request["likes"]]
    summary = "; ".join(line.rstrip(".") for line in [*request["view_rules"], *request["dislikes"], *request["likes"]])
    return json.dumps({"rules": rules, "summary": f"{summary}." if summary else ""})


def bullet_lines(text: str, section: str | None) -> list[str]:
    if section:
        match = re.search(rf"^## {section}\s*$(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL | re.IGNORECASE)
        text = match.group(1) if match else ""
    return [line.strip() for line in text.splitlines() if line.strip().startswith("* ")]


def edit(payload: dict[str, Any], base_url: str) -> str:
    request = request_of(payload)
    ask = request["request"].lower()
    files = request["files"]
    view_file = f"views/{request['view']}.md"
    edits = []
    new_rules = []
    if "no shorts" in ask:
        new_rules.append("* No shorts.")
    if "hide politics" in ask:
        new_rules.append("* Hide politics.")
    if (match := FIRST.search(ask)) is not None:
        new_rules.append(f"* Posts from @{match.group(1)} always first.")
    if new_rules:
        edits.append({"file": view_file, "section": "Rules", "text": "\n".join(bullet_lines(files.get(view_file, ""), "Rules") + new_rules)})
    if "vegetarian" in ask:
        edits.append({"file": "memory/about_me.md", "section": None, "text": "\n".join([*bullet_lines(files.get("memory/about_me.md", ""), None), "* Vegetarian."])})
    if "less like this" in ask and request.get("item"):
        line = f"* Posts like \"{request['item']['title']}\""
        edits.append({"file": "memory/dislikes.md", "section": None, "text": "\n".join([*bullet_lines(files.get("memory/dislikes.md", ""), None), line])})
    if "column" in ask or "magazine" in ask or "compact" in ask:
        edits.append({"file": view_file, "section": "Layout", "text": request["request"]})
    rollback = "previous look" in ask
    reply = "Rolled the look back." if rollback else f"Updated {len(edits)} file{'s' if len(edits) != 1 else ''}."
    return json.dumps({"edits": edits, "lens_action": "rollback" if rollback else None, "reply": reply})


BROKEN_LENS = "<!doctype html><html><head></head><body><script>moi.ready()</script></body></html>"
FIELD = {"take": "text"}
LISTING_SPEC = {
    "item_root": "tr.athing",
    "native_id": {"select": ":scope", "take": "attr:id"},
    "fields": {
        "title": {"select": ".titleline > a", **FIELD},
        "url": {"select": ".titleline > a", "take": "attr:href", "transform": "absolute_url"},
        "extra.site": {"select": ".sitestr", **FIELD, "optional": True},
    },
}
SHOP_SPEC = {
    "item_root": "[data-component-type='s-search-result']",
    "native_id": {"select": ":scope", "take": "attr:data-asin"},
    "fields": {
        "title": {"select": "h2 a span", **FIELD},
        "url": {"select": "h2 a", "take": "attr:href", "transform": "absolute_url"},
        "image_url": {"select": "img.s-image", "take": "attr:src", "optional": True},
        "extra.price_text": {"select": ".a-price .a-offscreen", **FIELD, "optional": True},
        "extra.rating_text": {"select": ".a-icon-alt", **FIELD, "optional": True},
    },
}
NOTHING_SPEC = {"item_root": "div.no_such_thing", "fields": {"title": {"select": "a", **FIELD}, "url": {"select": "a", "take": "attr:href"}}}
SPECS_BY_PAGE = {"/pages/listing.html": LISTING_SPEC, "/pages/shop.html": SHOP_SPEC}


def lens(payload: dict[str, Any], base_url: str) -> str:
    """The example lens with a visible banner naming the layout; BROKEN layouts never render items, FIXABLE ones only on retry."""
    request = request_of(payload)
    layout = request["layout"]
    if "BROKEN" in layout or ("FIXABLE" in layout and not request["last_error"]):
        return BROKEN_LENS
    banner = f'<div id="look" data-kind="{request["kind"]}">Look: {html.escape(layout)}</div>'
    return "Here is your lens:\n```html\n" + request["example_lens"].replace("<body>", f"<body>{banner}", 1) + "\n```"


def extractor(payload: dict[str, Any], base_url: str) -> str:
    request = request_of(payload)
    return json.dumps(SPECS_BY_PAGE.get(urlparse(request["url"]).path, NOTHING_SPEC))


HANDLERS = {"echo": echo, "tag": tag, "compile_rules": compile_rules, "edit": edit, "lens": lens, "extractor": extractor}


def model_reply(task: str, payload: dict[str, Any], base_url: str) -> str:
    return HANDLERS.get(task, echo)(payload, base_url)
