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
# The commonest small words of each language. Headlines are short, so English needs many of its own: "on", "by",
# "new" and "how" are often the only ones a title has.
STOP_WORDS = {
    "en": set(
        "the a an and or but is are was were be been being of to in on at by for with from as it its this that these those "
        "you your we our they their he she his her i my me not no will can could would should how why what when who which "
        "new after over into about more than has have had do does did just now up out all one some says get gets got "
        "first year years day week makes made make there here so if".split()
    ),
    "es": set("el la los las de del que y a en por una un es con para se su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre".split()),
    "fr": set("le la les de des du et est une un pour dans que qui en au aux ne pas sur se ce il elle sont avec plus par son mais".split()),
    "de": set("der die das und ist nicht mit ein eine zu auf den dem des von sich im für auch es an sie wird werden bei nach wie aus".split()),
    "pt": set("o os a as de que e do da dos das em um uma para com não no na por mais se como mas foi ao ele ela seu sua ou".split()),
    "it": set("il lo gli la le di che e a un una per non sono del della dei in con si ha da al alla nel più ma come anche".split()),
}
# A title this short with one clear common word is enough to tell; longer text needs two.
SHORT_TEXT_WORDS = 12
# Spellings far commoner in English than in the other languages listed, worth half a common word each (two at most),
# so "Heat wave breaks records across southern Europe" reads as English and "in" no longer ties it with Italian.
ENGLISH_HINT = re.compile(r"th|w|gh|ing$|ed$|ly$")
MAX_HINTS = 2
OUTRAGE = {"outrage", "outrageous", "disgrace", "disgraceful", "destroyed", "destroys", "slams", "furious", "shocking", "insane", "unbelievable", "idiot", "idiots", "evil", "traitor", "pathetic", "disgusting"}
RAGE_JUDGMENTS = ("angry", "rage_bait", "ragebait", "anger")


def language(text: str) -> str:
    """A two letter guess by script, then by the commonest small words: the language with clearly the most of them,
    two at least (one in a short title); "und" when there is too little to tell or two languages tie."""
    for code, script in SCRIPTS:
        if len(script.findall(text)) >= 3:
            return code
    words = [word.lower() for word in WORD.findall(text)]
    hints = min(sum(len(word) > 2 and bool(ENGLISH_HINT.search(word)) for word in words), MAX_HINTS) / 2
    scores = sorted(((sum(word in stops for word in words) + (hints if code == "en" else 0), code) for code, stops in STOP_WORDS.items()), reverse=True)
    (best_score, best), (runner_up, _) = scores[0], scores[1]
    needed = 1 if len(words) <= SHORT_TEXT_WORDS else 2
    return best if best_score >= needed and best_score > runner_up else "und"


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


JUDGED_RAGE = 0.9


def with_judged_rage(extra: dict[str, str]) -> dict[str, str]:
    """Extra fields with ragebait raised to 0.9 when a rage bait judgment said yes: the model outranks the heuristic,
    whether it answered before enrichment or after."""
    if not any(extra.get(f"{JUDGED_PREFIX}{name}") == "yes" for name in RAGE_JUDGMENTS):
        return extra
    try:
        score = float(extra.get("ragebait", "0"))
    except ValueError:
        score = 0.0
    return {**extra, "ragebait": str(max(score, JUDGED_RAGE))}


def enrichment(item: Item) -> dict[str, str]:
    text = " ".join(part for part in (item.title, item.text) if part)
    score = str(ragebait_score(text))
    extra = {"lang": language(text), "reading_minutes": str(reading_minutes(text)), "ragebait": with_judged_rage({**item.extra, "ragebait": score})["ragebait"]}
    names = entities(text)
    return {**extra, "entities": ", ".join(names)} if names else extra


def enriched(item: Item) -> Item:
    return item.model_copy(update={"extra": {**item.extra, **enrichment(item)}})
