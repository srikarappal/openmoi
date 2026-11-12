"""Rules plus recency: the whole ranking of the MVP."""

from dataclasses import dataclass
from datetime import datetime
from operator import itemgetter
from typing import Literal

from moi_brain.compile import AllOf, AnyOf, Condition, NotOf, Rule, When
from moi_brain.items import JUDGED_PREFIX, Item, ViewItem, site_host, source_matches
from moi_brain.ranker import Ranker, features, recency
from moi_brain.stories import UPDATE_KEY, story_key

PAGE_SIZE = 30
# A pinned item outranks anything boosts can reach.
PIN_SCORE = 1000.0
EXPLORE_EVERY = 10
EXTRA_FIELDS = ("lang", "reading_minutes", "ragebait")
RECENT_HOURS = 6.0
FIELD_LABELS = {"source_id": "source", "author_handle": "author", "author_in": "author", "media_kind": "media", "age_hours": "age", "reading_minutes": "reading time"}
Order = Literal["recency", "page"]
Scored = tuple[float, Item, list[Rule]]


@dataclass(frozen=True)
class Circles:
    """Who the person knows: handles from memory/people.md (on any site) and (site, handle) pairs they follow."""

    people: frozenset[str] = frozenset()
    following: frozenset[tuple[str, str]] = frozenset()

    def groups(self, item: Item) -> set[str]:
        handle = (item.author_handle or "").lower()
        found = set()
        if handle and handle in self.people:
            found |= {"people", "known"}
        if handle and (site_host(item.url), handle) in self.following:
            found |= {"following", "known"}
        return found or {"stranger"}

    @property
    def empty(self) -> bool:
        return not (self.people or self.following)


NO_CIRCLES = Circles()


def age_hours(item: Item, now: datetime) -> float:
    moment = item.published_at or item.fetched_at
    return max((now - moment).total_seconds() / 3600, 0.0)


def wanted_values(condition: Condition) -> list[str]:
    values = condition.value if isinstance(condition.value, list) else [condition.value]
    cleaned = [str(value).strip().lower() for value in values]
    return [value.lstrip("@") for value in cleaned] if condition.field == "author_handle" else cleaned


def item_values(field: str, item: Item) -> list[str]:
    if field.startswith(JUDGED_PREFIX) or field in EXTRA_FIELDS:
        return [item.extra.get(field, "").lower()]
    if field == "topic":
        return [topic.lower() for topic in item.topics]
    if field == "text":
        return [" ".join(part for part in (item.title, item.text) if part).lower()]
    if field == "author_handle":
        return [value.lower() for value in (item.author_handle, item.author_name) if value]
    return [(item.media_kind or "").lower()]


def compare_number(value: float, op: str, target: str) -> bool:
    try:
        number = float(target)
    except ValueError:
        return False
    if op == "gt":
        return value > number
    if op == "lt":
        return value < number
    return abs(value - number) < 0.5


def judged_number(item: Item, field: str, op: str, target: str) -> bool:
    """A number judgment compared with the rule's number; an unknown answer never matches either way."""
    try:
        value = float(item.extra.get(field, ""))
    except ValueError:
        return False
    return compare_number(value, op, target)


def matches(when: When | None, item: Item, now: datetime, circles: Circles = NO_CIRCLES) -> bool:
    """Whether a when holds for an item; no when holds for nothing."""
    if isinstance(when, AllOf):
        return all(matches(part, item, now, circles) for part in when.every)
    if isinstance(when, AnyOf):
        return any(matches(part, item, now, circles) for part in when.some)
    if isinstance(when, NotOf):
        return not matches(when.negated, item, now, circles)
    return condition_holds(when, item, now, circles) if when is not None else False


def condition_holds(condition: Condition, item: Item, now: datetime, circles: Circles) -> bool:
    wanted = wanted_values(condition)
    if condition.field == "author_in":
        return bool(circles.groups(item) & set(wanted))
    if condition.field == "age_hours":
        return bool(wanted) and compare_number(age_hours(item, now), condition.op, wanted[0])
    if (condition.field.startswith(JUDGED_PREFIX) or condition.field in EXTRA_FIELDS) and condition.op in ("gt", "lt"):
        return bool(wanted) and judged_number(item, condition.field, condition.op, wanted[0])
    if condition.field == "source_id":
        return any(source_matches(item.source_id, value) for value in wanted)
    values = item_values(condition.field, item)
    if condition.op == "contains":
        return any(want in value for value in values for want in wanted)
    if condition.op in ("eq", "in"):
        return any(value == want for value in values for want in wanted)
    return False


def applies(rule: Rule, item: Item, now: datetime, circles: Circles = NO_CIRCLES) -> bool:
    """A rule without a when (a summarize or note rule for every item) applies to all items its unless spares."""
    return (rule.when is None or matches(rule.when, item, now, circles)) and not matches(rule.unless, item, now, circles)


def plain(value: object) -> str:
    """A rule's value as you would write it: 3000, not 3000.0."""
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def describe(when: When) -> str:
    """A when in a few words: "topic politics", "all of (topic ai, source rss)", "not author maya"."""
    if isinstance(when, AllOf):
        return f"all of ({'; '.join(describe(part) for part in when.every)})"
    if isinstance(when, AnyOf):
        return f"any of ({'; '.join(describe(part) for part in when.some)})"
    if isinstance(when, NotOf):
        return f"not {describe(when.negated)}"
    values = when.value if isinstance(when.value, list) else [when.value]
    label = FIELD_LABELS.get(when.field, when.field.removeprefix(JUDGED_PREFIX))
    return f"{label} {', '.join(plain(value) for value in values)}"


def reasons(item: Item, moved: list[Rule], now: datetime) -> list[str]:
    """Why an item is where it is: the rules that moved it, how recent it is and where it is from."""
    found = [f"{rule.do if rule.do != 'pin' else 'pinned'}: {describe(rule.when)}" for rule in moved if rule.when]
    if age_hours(item, now) <= RECENT_HOURS:
        found.append("recent")
    found.append(f"from {item.source_id}")
    return found


def story_reasons(item: Item, also: dict[str, list[str]], plain: list[str]) -> list[str]:
    """What an update adds comes first; where else the story appeared comes last."""
    first = [f"update: {item.extra[UPDATE_KEY]}"] if item.extra.get(UPDATE_KEY) else []
    return first + plain + ([f"also on {', '.join(also[item.item_id])}"] if item.item_id in also else [])


def apply_limits(scored: list[Scored], rules: list[Rule], now: datetime, circles: Circles = NO_CIRCLES) -> list[Scored]:
    """Keep at most count_per_day matching items per published day on your clock, best scored first.

    An item that one limit drops does not use up another limit's allowance."""
    limits = [(index, rule) for index, rule in enumerate(rules) if rule.do == "limit" and rule.count_per_day is not None]
    counts: dict[tuple[int, str], int] = {}
    kept = []
    for entry in scored:
        item = entry[1]
        day = (item.published_at or item.fetched_at).astimezone().date().isoformat()
        allowances = [((index, day), rule.count_per_day) for index, rule in limits if applies(rule, item, now, circles)]
        if all(counts.get(key, 0) < allowed for key, allowed in allowances):
            for key, _ in allowances:
                counts[key] = counts.get(key, 0) + 1
            kept.append(entry)
    return kept


def kept_share(items: list[Item], rules: list[Rule], now: datetime, circles: Circles = NO_CIRCLES) -> dict[str, float]:
    """For each source, the share of its items no hide rule removes: how many raw items it takes to show one."""
    totals: dict[str, int] = {}
    kept: dict[str, int] = {}
    for item in items:
        totals[item.source_id] = totals.get(item.source_id, 0) + 1
        if not any(rule.do == "hide" and applies(rule, item, now, circles) for rule in rules):
            kept[item.source_id] = kept.get(item.source_id, 0) + 1
    return {source_id: kept.get(source_id, 0) / total for source_id, total in totals.items()}


def best_copy_per_story(scored: list[Scored], shown: set[str] | frozenset[str]) -> tuple[list[Scored], dict[str, list[str]]]:
    """One item per story (its cluster, and every copy of one URL), in score order, with the other sources each kept
    copy appeared on. A copy already shown or seen stays its story's copy, so a newer copy never brings the same story
    back, unless the update pass found it adds something; otherwise the best scored copy the rules let through, so a
    story hidden in one source still shows from another source a rule allows."""
    keys: dict[str, str] = {}
    by_url: dict[str, str] = {}
    for _, item, _ in scored:
        keys[item.item_id] = by_url.setdefault(item.url, story_key(item))
    kept: dict[str, Item] = {}
    for _, item, _ in scored:
        if item.item_id in shown:
            kept.setdefault(keys[item.item_id], item)
    for _, item, _ in scored:
        kept.setdefault(keys[item.item_id], item)
    chosen = {item.item_id for item in kept.values()}
    updates = {item.item_id for _, item, _ in scored if item.item_id not in chosen and item.item_id not in shown and item.extra.get(UPDATE_KEY)}
    also: dict[str, set[str]] = {}
    for _, item, _ in scored:
        copy = kept[keys[item.item_id]]
        if item.item_id != copy.item_id and item.source_id != copy.source_id:
            also.setdefault(copy.item_id, set()).add(item.source_id)
    return [entry for entry in scored if entry[1].item_id in chosen | updates], {item_id: sorted(sources) for item_id, sources in also.items()}


def rank(
    items: list[Item],
    rules: list[Rule],
    now: datetime,
    exclude_ids: set[str] | frozenset[str] = frozenset(),
    limit: int = PAGE_SIZE,
    order: Order = "recency",
    circles: Circles = NO_CIRCLES,
    seen: set[str] | frozenset[str] = frozenset(),
    learned: Ranker | None = None,
    explore: bool = True,
) -> tuple[list[ViewItem], bool]:
    """A page of view items with reasons, plus whether more remain beyond it.

    Order "recency" scores by a 24 h half life, or by the learned model once it has learned enough; order "page" keeps
    the given order. Boosts add on top of either. With the learned model, every tenth place goes to an item outside your
    top topics unless the view turned exploring off.
    Excluded ids (already shown or seen) use up daily limits first: what you already read that day counts before
    anything newer competes for what is left. Seen ids, still shown, stay their story's copy.
    """
    scored: list[Scored] = []
    for position, item in enumerate(items):
        if any(rule.do == "hide" and applies(rule, item, now, circles) for rule in rules):
            continue
        moved = [rule for rule in rules if rule.do in ("pin", "boost", "demote") and applies(rule, item, now, circles)]
        boost_total = sum(rule.weight if rule.do == "boost" else -rule.weight for rule in moved if rule.do != "pin")
        if order == "page":
            base = 1 - position / (len(items) + 1)
        elif learned is not None and learned.trained:
            base = learned.item_score(item, now, boost_total)
        else:
            base = recency(item, now)
        pinned = PIN_SCORE if any(rule.do == "pin" for rule in moved) else 0.0
        scored.append((base + boost_total + pinned, item, moved))
    scored.sort(key=itemgetter(0), reverse=True)
    scored, also = best_copy_per_story(scored, set(exclude_ids) | set(seen))
    already = [entry for entry in scored if entry[1].item_id in exclude_ids]
    candidates = [entry for entry in scored if entry[1].item_id not in exclude_ids]
    remaining = [entry for entry in apply_limits([*already, *candidates], rules, now, circles) if entry[1].item_id not in exclude_ids]
    trained = learned is not None and learned.trained and order == "recency"
    explored: set[str] = set()
    if trained and explore:
        remaining, explored = with_explore(remaining, learned.top_topics())
    groups = {entry[1].item_id: group_of(entry[1], rules, now, circles) for entry in remaining}
    if any(groups.values()):
        remaining = grouped(remaining, groups)
    page = []
    for _, item, moved in remaining[:limit]:
        plain = reasons(item, moved, now) + (learned.reasons(features(item, now)) if trained else [])
        if item.item_id in explored:
            plain.append("explore: outside your usual topics")
        summary_only = any(rule.do == "summarize_only" and applies(rule, item, now, circles) for rule in rules)
        page.append(ViewItem(item=item, reasons=story_reasons(item, also, plain), group=groups[item.item_id], summary_only=summary_only))
    return page, len(remaining) > limit


def group_of(item: Item, rules: list[Rule], now: datetime, circles: Circles = NO_CIRCLES) -> str | None:
    """The value the first group_by rule that applies groups this item under, such as its source or first topic."""
    rule = next((rule for rule in rules if rule.do == "group_by" and rule.group_field and applies(rule, item, now, circles)), None)
    if rule is None or rule.group_field is None:
        return None
    if rule.group_field == "topic":
        return item.topics[0] if item.topics else "other"
    if rule.group_field == "author_handle":
        return item.author_handle or item.author_name or "unknown"
    if rule.group_field in EXTRA_FIELDS:
        return item.extra.get(rule.group_field) or "unknown"
    return str(getattr(item, rule.group_field, None) or "other")


def grouped(entries: list[Scored], groups: dict[str, str | None]) -> list[Scored]:
    """Every item still to show, one group's items together, before the page is cut: groups in the order their best
    item comes, items in score order inside each, so later pages continue the last group instead of starting the
    groups over."""
    members: dict[str | None, list[Scored]] = {}
    for entry in entries:
        members.setdefault(groups[entry[1].item_id], []).append(entry)
    return [entry for group in members.values() for entry in group]


def is_pinned(entry: Scored) -> bool:
    return any(rule.do == "pin" for rule in entry[2])


def outside_topics(entry: Scored, top_topics: set[str]) -> bool:
    """A tagged item none of whose topics is among your top ones; an item not tagged yet says nothing either way."""
    return bool(entry[1].topics) and not top_topics & set(entry[1].topics) and not is_pinned(entry)


def with_explore(entries: list[Scored], top_topics: set[str]) -> tuple[list[Scored], set[str]]:
    """Every tenth place goes to the best item outside your top topics, pulled forward, so your feed is not only more
    of the same; every other item keeps its order and a pinned item is never pushed down. Returns the new order and
    the items pulled forward that way."""
    if not top_topics:
        return entries, set()
    remaining = list(entries)
    ordered: list[Scored] = []
    explored: set[str] = set()
    while remaining:
        entry = remaining[0]
        if len(ordered) % EXPLORE_EVERY == EXPLORE_EVERY - 1 and not is_pinned(entry) and not outside_topics(entry, top_topics):
            pulled = next((candidate for candidate in remaining if outside_topics(candidate, top_topics)), None)
            if pulled is not None:
                entry = pulled
                explored.add(entry[1].item_id)
        remaining.remove(entry)
        ordered.append(entry)
    return ordered, explored
