"""Rules plus recency: the whole ranking of the MVP."""

from datetime import datetime
from operator import itemgetter
from typing import Literal

from moi_brain.compile import Condition, Rule
from moi_brain.items import Item, ViewItem, source_matches

PAGE_SIZE = 30
HALF_LIFE_HOURS = 24.0
RECENT_HOURS = 6.0
FIELD_LABELS = {"source_id": "source", "author_handle": "author", "media_kind": "media", "age_hours": "age"}
Order = Literal["recency", "page"]
Scored = tuple[float, Item, list[Rule]]


def age_hours(item: Item, now: datetime) -> float:
    moment = item.published_at or item.fetched_at
    return max((now - moment).total_seconds() / 3600, 0.0)


def wanted_values(condition: Condition) -> list[str]:
    values = condition.value if isinstance(condition.value, list) else [condition.value]
    cleaned = [str(value).strip().lower() for value in values]
    return [value.lstrip("@") for value in cleaned] if condition.field == "author_handle" else cleaned


def item_values(field: str, item: Item) -> list[str]:
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


def matches(condition: Condition | None, item: Item, now: datetime) -> bool:
    if condition is None:
        return False
    wanted = wanted_values(condition)
    if condition.field == "age_hours":
        return bool(wanted) and compare_number(age_hours(item, now), condition.op, wanted[0])
    if condition.field == "source_id":
        return any(source_matches(item.source_id, value) for value in wanted)
    values = item_values(condition.field, item)
    if condition.op == "contains":
        return any(want in value for value in values for want in wanted)
    if condition.op in ("eq", "in"):
        return any(value == want for value in values for want in wanted)
    return False


def applies(rule: Rule, item: Item, now: datetime) -> bool:
    return matches(rule.when, item, now) and not matches(rule.unless, item, now)


def describe(condition: Condition) -> str:
    values = condition.value if isinstance(condition.value, list) else [condition.value]
    return f"{FIELD_LABELS.get(condition.field, condition.field)} {', '.join(str(value) for value in values)}"


def reasons(item: Item, boosts: list[Rule], now: datetime) -> list[str]:
    found = [f"boost: {describe(rule.when)}" for rule in boosts]
    if age_hours(item, now) <= RECENT_HOURS:
        found.append("recent")
    found.append(f"from {item.source_id}")
    return found


def apply_limits(scored: list[Scored], rules: list[Rule], now: datetime) -> list[Scored]:
    """Keep at most count_per_day matching items per published day on your clock, best scored first.

    An item that one limit drops does not use up another limit's allowance."""
    limits = [(index, rule) for index, rule in enumerate(rules) if rule.do == "limit" and rule.count_per_day is not None]
    counts: dict[tuple[int, str], int] = {}
    kept = []
    for entry in scored:
        item = entry[1]
        day = (item.published_at or item.fetched_at).astimezone().date().isoformat()
        allowances = [((index, day), rule.count_per_day) for index, rule in limits if applies(rule, item, now)]
        if all(counts.get(key, 0) < allowed for key, allowed in allowances):
            for key, _ in allowances:
                counts[key] = counts.get(key, 0) + 1
            kept.append(entry)
    return kept


def rank(
    items: list[Item],
    rules: list[Rule],
    now: datetime,
    exclude_ids: set[str] | frozenset[str] = frozenset(),
    limit: int = PAGE_SIZE,
    order: Order = "recency",
) -> tuple[list[ViewItem], bool]:
    """A page of view items with reasons, plus whether more remain beyond it.

    Order "recency" scores by a 24 h half life; order "page" keeps the given order. Boosts add on top of either.
    Excluded ids (already rendered) still count toward daily limits.
    """
    scored: list[Scored] = []
    for position, item in enumerate(items):
        if any(rule.do == "hide" and applies(rule, item, now) for rule in rules):
            continue
        boosts = [rule for rule in rules if rule.do == "boost" and applies(rule, item, now)]
        base = 0.5 ** (age_hours(item, now) / HALF_LIFE_HOURS) if order == "recency" else 1 - position / (len(items) + 1)
        scored.append((base + sum(rule.weight for rule in boosts), item, boosts))
    scored.sort(key=itemgetter(0), reverse=True)
    remaining = [entry for entry in apply_limits(scored, rules, now) if entry[1].item_id not in exclude_ids]
    page = [ViewItem(item=item, reasons=reasons(item, boosts, now)) for _, item, boosts in remaining[:limit]]
    return page, len(remaining) > limit
