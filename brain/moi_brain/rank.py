"""Rules plus recency: the whole ranking of the MVP."""

from dataclasses import dataclass
from datetime import datetime
from operator import itemgetter
from typing import Literal

from moi_brain.compile import Condition, Rule
from moi_brain.items import JUDGED_PREFIX, Item, ViewItem, site_host, source_matches
from moi_brain.stories import UPDATE_KEY, story_key

PAGE_SIZE = 30
HALF_LIFE_HOURS = 24.0
RECENT_HOURS = 6.0
FIELD_LABELS = {"source_id": "source", "author_handle": "author", "author_in": "author", "media_kind": "media", "age_hours": "age"}
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
    if field.startswith(JUDGED_PREFIX):
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


def matches(condition: Condition | None, item: Item, now: datetime, circles: Circles = NO_CIRCLES) -> bool:
    if condition is None:
        return False
    wanted = wanted_values(condition)
    if condition.field == "author_in":
        return bool(circles.groups(item) & set(wanted))
    if condition.field == "age_hours":
        return bool(wanted) and compare_number(age_hours(item, now), condition.op, wanted[0])
    if condition.field.startswith(JUDGED_PREFIX) and condition.op in ("gt", "lt"):
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
    return matches(rule.when, item, now, circles) and not matches(rule.unless, item, now, circles)


def plain(value: object) -> str:
    """A rule's value as you would write it: 3000, not 3000.0."""
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def describe(condition: Condition) -> str:
    values = condition.value if isinstance(condition.value, list) else [condition.value]
    label = FIELD_LABELS.get(condition.field, condition.field.removeprefix(JUDGED_PREFIX))
    return f"{label} {', '.join(plain(value) for value in values)}"


def reasons(item: Item, boosts: list[Rule], now: datetime) -> list[str]:
    found = [f"boost: {describe(rule.when)}" for rule in boosts]
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
) -> tuple[list[ViewItem], bool]:
    """A page of view items with reasons, plus whether more remain beyond it.

    Order "recency" scores by a 24 h half life; order "page" keeps the given order. Boosts add on top of either.
    Excluded ids (already shown or seen) use up daily limits first: what you already read that day counts before
    anything newer competes for what is left.
    """
    scored: list[Scored] = []
    for position, item in enumerate(items):
        if any(rule.do == "hide" and applies(rule, item, now, circles) for rule in rules):
            continue
        boosts = [rule for rule in rules if rule.do == "boost" and applies(rule, item, now, circles)]
        base = 0.5 ** (age_hours(item, now) / HALF_LIFE_HOURS) if order == "recency" else 1 - position / (len(items) + 1)
        scored.append((base + sum(rule.weight for rule in boosts), item, boosts))
    scored.sort(key=itemgetter(0), reverse=True)
    scored, also = best_copy_per_story(scored, exclude_ids)
    already = [entry for entry in scored if entry[1].item_id in exclude_ids]
    candidates = [entry for entry in scored if entry[1].item_id not in exclude_ids]
    remaining = [entry for entry in apply_limits([*already, *candidates], rules, now, circles) if entry[1].item_id not in exclude_ids]
    page = [ViewItem(item=item, reasons=story_reasons(item, also, reasons(item, boosts, now))) for _, item, boosts in remaining[:limit]]
    return page, len(remaining) > limit
