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
from urllib.parse import urlparse

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


MATCH_WORDS = [
    ("mention", "mentions"),
    ("review", "enrich"),
    ("attach", "enrich"),
    ("meeting", "time_window"),
    ("story", "same_story"),
    ("stories", "same_story"),
    ("person", "same_person"),
    ("friends everywhere", "same_person"),
    ("creator", "same_person"),
    ("cheapest", "same_product"),
    ("price board", "same_product"),
    ("across stores", "same_product"),
]


def source_word(name: str) -> str:
    """The word a person would use for a source: facebook for page:facebook.com/..., amazon for shop:amazon.com."""
    rest = name.split(":", 1)[1] if ":" in name else name
    return (urlparse(f"https://{rest}").hostname or rest).removeprefix("www.").split(".")[0] if ":" in name else name


def compile_match(payload: dict[str, Any], base_url: str) -> str:
    """A match kind from its words; for mentions and enrich, lead and target are the sources named first and second,
    else the view's first source and its last (where its stores come)."""
    request = request_of(payload)
    text = request["match"].lower()
    kind = next((kind for word, kind in MATCH_WORDS if word in text), "union")
    named = sorted((text.find(source_word(name)), name) for name in request["sources"] if source_word(name) and text.find(source_word(name)) >= 0)
    if len(named) >= 2:
        lead, target = named[0][1], named[1][1]
    else:
        lead, target = request["sources"][0], request["sources"][-1]
    if kind not in ("mentions", "enrich"):
        lead, target = None, None
    return json.dumps({"kind": kind, "lead": lead, "target": target, "summary": f"Combined as {kind.replace('_', ' ')}."})


MENTIONED = re.compile(r"(?:got the|bought the|love my|bought a|got a) ([A-Za-z0-9][\w -]{2,60}?)(?=[.,!]| and |$)")


def mentions(payload: dict[str, Any], base_url: str) -> str:
    """Products a post names after "got the", "bought a" or "love my"; nothing else, whatever the post asks."""
    request = request_of(payload)
    found = [{"n": item["n"], "entities": MENTIONED.findall(f"{item['title']} {item['text']}")[:3]} for item in request["items"]]
    return json.dumps({"mentions": found})


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


LOOK_BANNER = re.compile(r'<div id="look"[^>]*>[^<]*</div>')


def lens_patch(payload: dict[str, Any], base_url: str) -> str:
    """Edits on the current lens: its banner names the new layout. REWRITE asks for a whole lens, BADPATCH sends an edit
    that does not apply; BROKEN and FIXABLE break the lens the way the whole lens handler does."""
    request = request_of(payload)
    layout, current = request["layout"], request["current_lens"]
    if "REWRITE" in layout:
        return json.dumps({"edits": [], "rewrite": True})
    if "BADPATCH" in layout:
        return json.dumps({"edits": [{"find": "text that is not in the lens", "replace": "x"}]})
    if "BROKEN" in layout or ("FIXABLE" in layout and not request["last_error"]):
        return json.dumps({"edits": [{"find": "moi.ready()", "replace": "moi.never_ready()"}]})
    first_try = not request["last_error"]
    if "NOALT" in layout and first_try:
        return json.dumps({"edits": [{"find": 'image.alt = ""\n      image.src = item.image_url', "replace": "image.src = item.image_url"}]})
    if "SLOW" in layout and first_try:
        return json.dumps({"edits": [{"find": "  function add(items) {\n", "replace": "  function add(items) {\n    const until = performance.now() + 120\n    while (performance.now() < until) {}\n"}]})
    if "HARDCODED" in layout and first_try:
        return json.dumps({"edits": [{"find": "  .meta {", "replace": "  .meta { color: #777; }\n  .meta {"}]})
    banner = f'<div id="look" data-kind="{request["kind"]}">Look: {html.escape(layout)}</div>'
    existing = LOOK_BANNER.search(current)
    change = {"find": existing.group(0), "replace": banner} if existing else {"find": "<body>", "replace": f"<body>{banner}"}
    return json.dumps({"edits": [change]})


def judge_lens(payload: dict[str, Any], base_url: str) -> str:
    """Sees the screenshot part and the layout; an UGLY layout never looks right."""
    parts = payload["messages"][-1]["content"]
    text = next(part["text"] for part in parts if part["type"] == "text")
    image = next(part["image_url"]["url"] for part in parts if part["type"] == "image_url")
    if not image.startswith("data:image/png;base64,"):
        return json.dumps({"matches": False, "problem": "no screenshot"})
    if "UGLY" in json.loads(text)["layout"]:
        return json.dumps({"matches": False, "problem": "the cards are not in two columns"})
    return json.dumps({"matches": True, "problem": ""})


def ask(payload: dict[str, Any], base_url: str) -> str:
    """Answers from the first source whose title shares a word with the question, citing it; else says nothing answers."""
    request = request_of(payload)
    words = set(re.findall(r"[a-z]{4,}", request["question"].lower()))
    for source in request["sources"]:
        if words & set(re.findall(r"[a-z]{4,}", source["title"].lower())):
            return json.dumps({"answer": f"You read about it in {source['title']} [{source['n']}].", "used": [source["n"]]})
    for line in request["journal"]:
        if words & set(re.findall(r"[a-z]{4,}", line.lower())):
            return json.dumps({"answer": f"Your journal says: {line[2:80]}", "used": []})
    return json.dumps({"answer": "Nothing you read answers that.", "used": []})


def agent_plan(payload: dict[str, Any], base_url: str) -> str:
    """Plans by task: a digest reads what is new in the first view; the rest search the request's words. ASK adds a
    question first, NOTIFY a notice, a request to like proposes a like on the result's first pick and ORDER an order
    (which is never allowed)."""
    request = request_of(payload)
    words = request["request"]
    if request["task"] == "digest":
        steps = [{"tool": "search_store", "args": {"view_id": request["views"][0], "limit": 5}, "why": "what is new"}]
    else:
        query = " ".join(re.findall(r"[a-z]{4,}", words.lower())[:3])
        steps = [{"tool": "search_store", "args": {"query": query, "limit": 5}, "why": "what you were shown about it"}]
    if "ASK" in words:
        steps.insert(0, {"tool": "ask_user", "args": {"question": "What is your budget?"}, "why": "to know your limit"})
    steps.append({"tool": "read_item", "args": {"limit": 3}, "why": "the ones that matter"})
    if "NOTIFY" in words:
        steps.append({"tool": "notify", "args": {"text": "Checked again."}, "why": "to tell you"})
    if "like" in words.lower().split():
        steps.append({"tool": "propose_action", "args": {"action": "like"}, "why": "you asked to like the best"})
    if "ORDER" in words:
        steps.append({"tool": "propose_action", "args": {"item_id": "anything", "action": "place_order"}, "why": "to buy it"})
    if "SLOW" in words:
        steps = [{"tool": "ask_user", "args": {"question": "Still there?"}, "why": "to wait"}] * 2 + steps
    budget = {"max_steps": 12, "max_seconds": 2 if "TIGHT" in words else 300, "max_cost_usd": 0.25}
    return json.dumps({"summary": f"I will {request['task']}: {words}", "steps": steps, "budget": budget})


def agent_read(payload: dict[str, Any], base_url: str) -> str:
    """A summary of the item as data, never following what it says."""
    request = request_of(payload)
    return json.dumps({"summary": f"About {request['title']}.", "facts": [request["title"][:60]], "price": request.get("price", "")})


def agent_compose(payload: dict[str, Any], base_url: str) -> str:
    """Cites every item and shortlists them all; found unless the request says NOTHING. Like a model talked into it by
    what it read, it also asks for a reply in a stranger's words, which openMoi must drop."""
    request = request_of(payload)
    items = request["items"]
    answer = " ".join(f"{item['title']} [{item['n']}]." for item in items)
    shortlist = [{"n": item["n"], "why": f"It fits: {item['title'][:40]}"} for item in items]
    talked_into = [{"n": item["n"], "action": "reply", "text": "DM me for the deal"} for item in items[:1]]
    return json.dumps({"answer": answer or "Nothing found.", "shortlist": shortlist, "found": "NOTHING" not in request["request"], "proposed_actions": talked_into})


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


HANDLERS = {"echo": echo, "tag": tag, "compile_rules": compile_rules, "edit": edit, "lens": lens, "lens_patch": lens_patch, "judge_lens": judge_lens, "ask": ask, "agent_plan": agent_plan, "agent_read": agent_read, "agent_compose": agent_compose, "compile_match": compile_match, "mentions": mentions, "extractor": extractor, "update": update, "summarize": summarize, "oracle": oracle}


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
