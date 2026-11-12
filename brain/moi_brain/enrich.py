"""Enrichment computed at ingest, with no model: an item's language, how long it takes to read, the names it mentions
and how much it reads like rage bait. Rules and ranking can use them; a rage bait judgment from the model, when a view
asks one, outranks the heuristic."""

import re

from moi_brain.items import JUDGED_PREFIX, Item

WORDS_PER_MINUTE = 230
MAX_ENTITIES = 8
WORD = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)?|\d+", re.UNICODE)
NAME = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b")
# Capitalized words that start a sentence rather than a name: "The Federal Reserve" is the Federal Reserve.
LEADING = {"The", "A", "An", "This", "That", "These", "Those", "Yesterday", "Today", "Tomorrow", "On", "In", "At", "But", "And", "When", "After"}
TAG = re.compile(r"(?<!\w)([#@$][A-Za-z][\w.]{1,30})")
SCRIPTS = (("ja", re.compile(r"[\u3040-\u30ff]")), ("zh", re.compile(r"[\u4e00-\u9fff]")), ("ko", re.compile(r"[\uac00-\ud7af]")), ("ru", re.compile(r"[\u0400-\u04ff]")), ("ar", re.compile(r"[\u0600-\u06ff]")), ("hi", re.compile(r"[\u0900-\u097f]")))
STOP_WORDS = {
    "en": {"the", "and", "is", "of", "to", "in", "that", "it", "for", "with", "this", "was"},
    "es": {"el", "la", "de", "que", "y", "en", "los", "las", "por", "una", "es", "con"},
    "fr": {"le", "la", "les", "de", "des", "et", "est", "une", "pour", "dans", "que", "qui"},
    "de": {"der", "die", "das", "und", "ist", "nicht", "mit", "ein", "eine", "zu", "auf", "den"},
    "pt": {"o", "a", "os", "de", "que", "e", "do", "da", "em", "um", "uma", "para"},
    "it": {"il", "la", "di", "che", "e", "un", "una", "per", "non", "sono", "del", "della"},
}
OUTRAGE = {"outrage", "outrageous", "disgrace", "disgraceful", "destroyed", "destroys", "slams", "furious", "shocking", "insane", "unbelievable", "idiot", "idiots", "evil", "traitor", "pathetic", "disgusting"}
RAGE_JUDGMENTS = ("angry", "rage_bait", "ragebait", "anger")


def language(text: str) -> str:
    """A two letter guess by script, then by the commonest small words; "und" when there is too little to tell."""
    for code, script in SCRIPTS:
        if len(script.findall(text)) >= 3:
            return code
    words = [word.lower() for word in WORD.findall(text)]
    scores = {code: sum(word in stops for word in words) for code, stops in STOP_WORDS.items()}
    best = max(scores, key=scores.__getitem__)
    return best if scores[best] >= 2 else "und"


def reading_minutes(text: str) -> int:
    return max(1, round(len(WORD.findall(text)) / WORDS_PER_MINUTE))


def entities(text: str) -> list[str]:
    """Names of people, places and things in Title Case, plus #tags, @handles and $tickers, each once."""
    names = []
    for match in NAME.finditer(text):
        words = match.group(1).split()
        while words and words[0] in LEADING:
            words = words[1:]
        if len(words) >= 2:
            names.append(" ".join(words))
    found = names + [match.group(1) for match in TAG.finditer(text)]
    return list(dict.fromkeys(found))[:MAX_ENTITIES]


def ragebait_score(text: str) -> float:
    """0 to 1: outrage words, shouting in capitals and stacked exclamation marks."""
    words = WORD.findall(text)
    if not words:
        return 0.0
    outrage = sum(word.lower() in OUTRAGE for word in words)
    # Acronyms (LED, USB, NASA) are not shouting; a headline mostly in capitals is.
    shouting = max(sum(word.isupper() and len(word) > 4 for word in words) / len(words) - 0.1, 0.0)
    exclaims = text.count("!")
    return round(min(1.0, 0.35 * outrage + 1.5 * shouting + 0.1 * exclaims), 2)


def enrichment(item: Item) -> dict[str, str]:
    text = " ".join(part for part in (item.title, item.text) if part)
    score = ragebait_score(text)
    if any(item.extra.get(f"{JUDGED_PREFIX}{name}") == "yes" for name in RAGE_JUDGMENTS):
        score = max(score, 0.9)
    extra = {"lang": language(text), "reading_minutes": str(reading_minutes(text)), "ragebait": str(score)}
    names = entities(text)
    return {**extra, "entities": ", ".join(names)} if names else extra


def enriched(item: Item) -> Item:
    return item.model_copy(update={"extra": {**item.extra, **enrichment(item)}})
