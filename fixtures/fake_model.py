"""A deterministic stand in for an OpenAI compatible model, keyed by the x-moi-task header.

Each task handler reads the JSON prompt the brain sent and answers the way a good model would
for the phrases our tests use. Unknown tasks echo the last user message as JSON.
"""

import hashlib
import html
import json
import math
import re
from typing import Any

SYNONYMS = {
    "politics": ("politic", "election", "senate", "congress"),
    "science": ("physics", "math", "telescope", "space", "science"),
    "technology": ("chip", "laptop", "database", "software"),
}
# Words the fake embedding model takes to mean the same thing, so search by meaning finds what shares no word.
MEANINGS = {
    "automobile": "car", "vehicle": "car", "cars": "car", "ev": "car", "sedan": "car",
    "canine": "dog", "puppy": "dog", "dogs": "dog",
    "physician": "doctor", "doctors": "doctor", "clinic": "doctor",
}
EMBED_DIMENSIONS = 384
EMBED_WORD = re.compile(r"[a-z0-9]+")
QUOTED = re.compile(r"\"([^\"]+)\"")
LIMIT = re.compile(r"at most (\d+) (?:posts )?from (\w+)")
HANDLE = re.compile(r"@([\w.]+)")
HIDE_TOPIC = re.compile(r"\b(?:hide|no)\s+(\w+)")
UNLESS = re.compile(r"\b(?:unless|except)\b.*\bfrom\s+(\w+)")
FIRST = re.compile(r"@?(\w+) (?:always )?first")
GROUP_BY = re.compile(r"\bgroup (?:\w+ )?by (source|topic|author|language)")
GROUP_FIELDS = {"source": "source_id", "topic": "topic", "author": "author_handle", "language": "lang"}
PIN = re.compile(r"\bpin (?:posts |items )?about (\w+)")
LESS_OF = re.compile(r"\bless (?:of )?(\w+)")
UNDER = re.compile(r"under \$([\d,.]+)(k?)")
MENTIONS = re.compile(r"only when it (?:mentions|says) (\w+)")
PRICE = re.compile(r"\$[\d,]+(?:\.\d+)?k?")
# Phrases that need a judgment: the question the fake model declares and the rule that tests its answer.
JUDGED_PHRASES = (
    (("only events", "events and birthdays"), "event", "Is this about an event or a birthday?", "yes_no", "eq", "no"),
    (("pets ok", "pets allowed"), "pets", "Does this listing allow pets?", "yes_no", "eq", "no"),
    (("rage bait", "angry", "anger"), "angry", "Is this written to make people angry?", "yes_no", "eq", "yes"),
    (("job changes",), "job_change", "Is this about someone starting a new job?", "yes_no", "eq", "no"),
)
JUDGE_WORDS = {
    "event": ("event", "birthday", "meetup", "party", "concert"),
    "angry": ("outrage", "furious", "disgrace", "destroyed"),
    "job_change": ("new role", "new job", "joined", "started at"),
}


def last_user_text(payload: dict[str, Any]) -> str:
    users = [message["content"] for message in payload.get("messages", []) if message.get("role") == "user"]
    return users[-1] if users else ""


def request_of(payload: dict[str, Any]) -> dict[str, Any]:
    return json.loads(last_user_text(payload))


def echo(payload: dict[str, Any], base_url: str) -> str:
    return json.dumps({"echo": last_user_text(payload)})


def judge(name: str, words: str) -> str:
    """The fake model's answer to one judgment: by keywords, a price as written, unknown when the item does not say."""
    if name == "pets":
        if "no pets" in words:
            return "no"
        return "yes" if any(phrase in words for phrase in ("pets ok", "pet friendly", "pets allowed")) else "unknown"
    if name == "price":
        match = PRICE.search(words)
        return match.group() if match else "unknown"
    if name in JUDGE_WORDS:
        return "yes" if any(word in words for word in JUDGE_WORDS[name]) else "no"
    return "unknown"


def tag(payload: dict[str, Any], base_url: str) -> str:
    request = request_of(payload)
    tags = []
    for item in request["items"]:
        words = f"{item['title']} {item['text']}".lower()
        topics = [topic for topic in request["topics"] if any(word in words for word in SYNONYMS.get(topic, (topic,)))]
        answers = {question["name"]: judge(question["name"], words) for question in request.get("questions", [])}
        tags.append({"item_id": item["item_id"], "topics": topics, "answers": answers})
    return json.dumps({"tags": tags})


def condition(field: str, op: str, value: Any) -> dict[str, Any]:
    return {"field": field, "op": op, "value": value}


def judged_rule(text: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """A rule that needs a judgment, with the judgment it declares."""
    if (match := UNDER.search(text)) is not None:
        limit = float(match.group(1).replace(",", "")) * (1000 if match.group(2) else 1)
        judgment = {"name": "price", "question": "What is the price or monthly rent in dollars?", "answer": "number"}
        return {"when": condition("judged:price", "gt", limit), "do": "hide"}, judgment
    for phrases, name, question, answer, op, value in JUDGED_PHRASES:
        if any(re.search(rf"\b{re.escape(phrase)}\b", text) for phrase in phrases):
            return {"when": condition(f"judged:{name}", op, value), "do": "hide"}, {"name": name, "question": question, "answer": answer}
    return None


def view_rule(line: str) -> dict[str, Any] | None:
    text = line.lower()
    if "summarize" in text:
        return {"when": condition("source_id", "eq", "youtube") if "video" in text else None, "do": "summarize"}
    if "only summaries" in text:
        return {"when": condition("source_id", "eq", "youtube") if "video" in text else None, "do": "summarize_only"}
    if "take notes" in text:
        return {"when": None, "do": "note"}
    if (match := GROUP_BY.search(text)) is not None:
        return {"when": None, "do": "group_by", "group_field": GROUP_FIELDS[match.group(1)]}
    if (match := PIN.search(text)) is not None:
        return {"when": condition("topic", "eq", match.group(1)), "do": "pin"}
    if (match := LESS_OF.search(text)) is not None:
        return {"when": condition("topic", "eq", match.group(1)), "do": "demote", "weight": 3}
    if (match := MENTIONS.search(text)) is not None:
        return {"when": condition("source_id", "eq", "watch"), "unless": condition("text", "contains", match.group(1)), "do": "hide"}
    if any(phrase in text for phrase in ("people i know", "people i follow", "no strangers")):
        return {"when": condition("author_in", "eq", "stranger"), "do": "hide"}
    if "short" in text:
        return {"when": condition("media_kind", "eq", "short_video"), "do": "hide"}
    if (match := LIMIT.search(text)) is not None:
        return {"when": condition("source_id", "eq", match.group(2)), "do": "limit", "count_per_day": int(match.group(1))}
    if (match := HANDLE.search(text)) is not None and "first" in text:
        return {"when": condition("author_handle", "eq", match.group(1)), "do": "boost", "weight": 10}
    if (match := HIDE_TOPIC.search(text)) is not None:
        unless = UNLESS.search(text)
        spared = condition("source_id", "eq", f"rss:{unless.group(1)}") if unless else None
        if spared and "or someone i know" in text:
            spared = {"any": [spared, condition("author_in", "eq", "known")]}
        return {"when": condition("topic", "eq", match.group(1)), "unless": spared, "do": "hide"}
    return None


def memory_rule(line: str, do: str) -> dict[str, Any]:
    quoted = QUOTED.search(line)
    if quoted:
        return {"when": condition("text", "contains", quoted.group(1).lower()), "do": do, "weight": 3 if do == "boost" else 0}
    topic = re.sub(r"[^\w]", "", line.split()[-1].lower())
    return {"when": condition("topic", "eq", topic), "do": do, "weight": 3 if do == "boost" else 0}


def compile_rules(payload: dict[str, Any], base_url: str) -> str:
    request = request_of(payload)
    rules, judgments = [], []
    for line in request["view_rules"]:
        if (found := judged_rule(line.lower())) is not None:
            rules.append(found[0])
            judgments.append(found[1])
        elif (rule := view_rule(line)) is not None:
            rules.append(rule)
    rules += [memory_rule(line, "hide") for line in request["dislikes"]]
    rules += [memory_rule(line, "boost") for line in request["likes"]]
    summary = "; ".join(line.rstrip(".") for line in [*request["view_rules"], *request["dislikes"], *request["likes"]])
    return json.dumps({"rules": rules, "judgments": judgments, "summary": f"{summary}." if summary else ""})


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
    if "edition" in ask or "visit" in ask:
        edits.append({"file": view_file, "section": "Time", "text": f"* {request['request'].strip().rstrip('.')}."})
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
ENDLESS_SPEC = {
    "item_root": "div.stream-entry",
    "native_id": {"select": ":scope", "take": "attr:data-id"},
    "fields": {
        "title": {"select": "p", "take": "text"},
        "url": {"select": "a", "take": "attr:href", "transform": "absolute_url"},
        "author_handle": {"select": ".who", "take": "text", "optional": True},
        "published_at": {"select": "time", "take": "attr:datetime", "optional": True},
    },
    "pagination": {"kind": "scroll", "step_px": 900},
}
FOLLOWS_SPEC = {
    "item_root": "li.account",
    "fields": {"title": {"select": ".name", "take": "text"}, "url": {"select": "a", "take": "attr:href", "transform": "absolute_url"}},
    "pagination": {"kind": "scroll", "step_px": 900},
}
DRIFT_SPECS = {
    name: {"item_root": f"div.{name}", "fields": {"title": {"select": "h3", "take": "text"}, "url": {"select": "a", "take": "attr:href", "transform": "absolute_url"}}}
    for name in ("story-a", "story-b")
}
# Like a real model, the fake one only sees the page's skeleton (and its site), so it recognizes pages by their markup.
SPECS_BY_MARKER = {
    'class="athing"': LISTING_SPEC,
    "s-search-result": SHOP_SPEC,
    'class="stream-entry"': ENDLESS_SPEC,
    'class="account"': FOLLOWS_SPEC,
    'class="story-a"': DRIFT_SPECS["story-a"],
    'class="story-b"': DRIFT_SPECS["story-b"],
}


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
    skeleton = request["skeleton"]
    return json.dumps(next((spec for marker, spec in SPECS_BY_MARKER.items() if marker in skeleton), NOTHING_SPEC))


def summarize(payload: dict[str, Any], base_url: str) -> str:
    """A summary naming the title; a transcript with times gets its second to third stretch as worth watching."""
    request = request_of(payload)
    lines = [line for line in request["content"].splitlines() if line.strip()]
    stamps = [line for line in lines if re.match(r"^\[\d+:\d{2}\]", line)]
    seconds = [int(stamp[1:].split(":")[0]) * 60 + int(stamp.split(":")[1][:2]) for stamp in stamps]
    watching = [{"start": seconds[1], "end": seconds[2], "why": "the demo"}] if len(seconds) >= 3 else []
    return json.dumps({"summary": f"Summary of {request['title']}.", "key_points": [line[:40] for line in lines[:3]], "worth_watching": watching})


NAVIGATION = {"home", "about", "contact", "privacy", "terms", "help", "log in", "sign up"}


def oracle(payload: dict[str, Any], base_url: str) -> str:
    """Records whose titles are mostly site navigation are not the page's items."""
    titles = [record["title"].strip().lower() for record in request_of(payload)["records"]]
    navigation = sum(title in NAVIGATION for title in titles)
    main = navigation * 2 < len(titles)
    return json.dumps({"main_items": main, "why": "" if main else "menu links"})


def update(payload: dict[str, Any], base_url: str) -> str:
    """A new copy is an update when it says so ("update", "confirmed", "now"); anything else is a retelling."""
    new = request_of(payload)["new"]
    words = f"{new['title']} {new['text']}".lower()
    changed = any(word in words for word in ("update", "confirmed", " now "))
    return json.dumps({"update": changed, "what_changed": new["title"] if changed else ""})


HANDLERS = {"echo": echo, "tag": tag, "compile_rules": compile_rules, "edit": edit, "lens": lens, "extractor": extractor, "update": update, "summarize": summarize, "oracle": oracle}


def model_reply(task: str, payload: dict[str, Any], base_url: str) -> str:
    return HANDLERS.get(task, echo)(payload, base_url)


def embedding(text: str) -> list[float]:
    """A unit vector of the text's words, with words of one meaning on one dimension: "automobile" lands on "car"."""
    vector = [0.0] * EMBED_DIMENSIONS
    for word in EMBED_WORD.findall(text.lower()):
        meaning = MEANINGS.get(word, word)
        vector[int.from_bytes(hashlib.sha256(meaning.encode()).digest()[:4], "big") % EMBED_DIMENSIONS] += 1.0
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector] if length else vector


def embeddings(payload: dict[str, Any]) -> dict[str, Any]:
    texts = payload["input"] if isinstance(payload["input"], list) else [payload["input"]]
    data = [{"object": "embedding", "index": index, "embedding": embedding(text)} for index, text in enumerate(texts)]
    return {"object": "list", "data": data, "usage": {"prompt_tokens": sum(len(text.split()) for text in texts)}}
