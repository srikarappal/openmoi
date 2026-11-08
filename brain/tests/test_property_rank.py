"""Property based tests for rank(): exclusions, limits, hiding, paging and reasons."""

from datetime import UTC, datetime, timedelta

from hypothesis import example, given, settings
from hypothesis import strategies as st

from moi_brain.compile import Condition, Rule
from moi_brain.items import Item, make_item_id
from moi_brain.rank import RECENT_HOURS, age_hours, applies, rank

FAST = settings(max_examples=150, deadline=None)
FEW = settings(FAST, max_examples=60)
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)
SOURCES = ["x", "rss:ars", "rss:verge", "youtube:veritasium"]
TOPICS = ["politics", "crypto", "art"]
OPS = ["eq", "in", "contains", "gt", "lt"]
FIELD_VALUES = {
    "source_id": st.sampled_from(["x", "rss", "youtube", "rss:ars", "rss:verge"]),
    "topic": st.sampled_from(TOPICS),
    "author_handle": st.sampled_from(["maya", "@maya", "Bob"]),
    "media_kind": st.sampled_from(["image", "short_video", "long_video"]),
    "text": st.sampled_from(["deal", "lamp", "news"]),
}


def make_item(index: int, source_id: str, hours_old: float, published: bool, topics: list[str], handle: str | None, media_kind: str | None, title: str) -> Item:
    moment = NOW - timedelta(hours=hours_old)
    return Item(
        item_id=make_item_id(source_id, str(index)),
        source_id=source_id,
        native_id=str(index),
        kind="post",
        url=f"https://e.com/{index}",
        title=title,
        author_handle=handle,
        media_kind=media_kind,
        published_at=moment if published else None,
        fetched_at=moment if not published else NOW,
        topics=topics,
    )


def numbered_items(specs: list[tuple]) -> list[Item]:
    return [make_item(index, *spec) for index, spec in enumerate(specs)]


ITEM_SPEC = st.tuples(
    st.sampled_from(SOURCES),
    st.integers(min_value=-4, max_value=120).map(lambda half_hours: half_hours / 2),
    st.booleans(),
    st.lists(st.sampled_from(TOPICS), max_size=2, unique=True),
    st.sampled_from([None, "maya", "bob"]),
    st.sampled_from([None, "image", "short_video", "long_video"]),
    st.sampled_from(["Lamp deal", "World news", "Art show", "Crypto deal"]),
)
ITEMS = st.lists(ITEM_SPEC, max_size=14).map(numbered_items)


def condition_for(field: str) -> st.SearchStrategy:
    if field == "age_hours":
        return st.builds(Condition, field=st.just(field), op=st.sampled_from(OPS), value=st.integers(min_value=0, max_value=48).map(float))
    values = FIELD_VALUES[field]
    return st.builds(Condition, field=st.just(field), op=st.sampled_from(OPS), value=st.one_of(values, st.lists(values, min_size=1, max_size=2)))


CONDITION = st.sampled_from([*sorted(FIELD_VALUES), "age_hours"]).flatmap(condition_for)
RULE = st.builds(
    Rule,
    when=CONDITION,
    unless=st.one_of(st.none(), CONDITION),
    do=st.sampled_from(["hide", "boost", "limit"]),
    weight=st.floats(min_value=0, max_value=10),
    count_per_day=st.one_of(st.none(), st.integers(min_value=0, max_value=3)),
)
RULES = st.lists(RULE, max_size=4)
ORDER = st.sampled_from(["recency", "page"])
LIMIT = st.integers(min_value=0, max_value=16)


def ids(page) -> list[str]:
    return [view_item.item.item_id for view_item in page]


def day_of(item: Item) -> str:
    return (item.published_at or item.fetched_at).astimezone().date().isoformat()


@FAST
@given(items=ITEMS, rules=RULES, picks=st.lists(st.integers(min_value=0, max_value=13)), limit=LIMIT, order=ORDER)
def test_rank_never_returns_excluded_ids(items, rules, picks, limit, order):
    """Items already rendered never come back."""
    excluded = {items[pick].item_id for pick in picks if pick < len(items)}
    page, _ = rank(items, rules, NOW, excluded, limit, order)
    assert not set(ids(page)) & excluded


@FAST
@given(items=ITEMS, rules=RULES, limit=LIMIT, order=ORDER)
def test_rank_page_is_a_bounded_prefix_and_has_more_is_consistent(items, rules, limit, order):
    """The page holds at most limit items, is the start of the full ranking and has_more says whether the full ranking is longer."""
    page, has_more = rank(items, rules, NOW, limit=limit, order=order)
    everything, rest = rank(items, rules, NOW, limit=len(items), order=order)
    assert len(page) <= limit
    assert page == everything[:limit]
    assert has_more == (len(everything) > limit)
    assert rest is False


@FAST
@given(items=ITEMS, rules=RULES, order=ORDER)
def test_rank_never_shows_hidden_items(items, rules, order):
    """No item on the page matches a hide rule."""
    page, _ = rank(items, rules, NOW, limit=len(items), order=order)
    hides = [rule for rule in rules if rule.do == "hide"]
    assert not any(applies(rule, view_item.item, NOW) for view_item in page for rule in hides)


@FAST
@given(items=ITEMS, rules=RULES, limit=LIMIT, order=ORDER)
def test_rank_respects_daily_limits(items, rules, limit, order):
    """For every limit rule, at most count_per_day matching items of one published local day are shown."""
    page, _ = rank(items, rules, NOW, limit=limit, order=order)
    for rule in rules:
        if rule.do != "limit" or rule.count_per_day is None:
            continue
        per_day: dict[str, int] = {}
        for view_item in page:
            if applies(rule, view_item.item, NOW):
                per_day[day_of(view_item.item)] = per_day.get(day_of(view_item.item), 0) + 1
        assert all(count <= rule.count_per_day for count in per_day.values())


@FAST
@given(items=ITEMS, rules=RULES, limit=st.integers(min_value=1, max_value=8), order=ORDER)
def test_rank_paging_loses_and_repeats_nothing(items, rules, limit, order):
    """Page one followed by page two (excluding page one) equals a single page twice as long."""
    first, _ = rank(items, rules, NOW, limit=limit, order=order)
    second, second_more = rank(items, rules, NOW, set(ids(first)), limit, order)
    both, both_more = rank(items, rules, NOW, limit=2 * limit, order=order)
    assert first + second == both
    assert second_more == both_more


@FAST
@given(items=ITEMS)
def test_rank_without_rules_orders_by_recency(items):
    """With no rules the newest item comes first and nothing is dropped."""
    page, has_more = rank(items, [], NOW, limit=len(items))
    ages = [age_hours(view_item.item, NOW) for view_item in page]
    assert ages == sorted(ages)
    assert sorted(ids(page)) == sorted(item.item_id for item in items)
    assert has_more is False


@FAST
@given(items=ITEMS, picks=st.sets(st.integers(min_value=0, max_value=13)))
def test_rank_page_order_without_rules_keeps_the_given_order(items, picks):
    """Order 'page' with no rules shows items in the order given, minus the excluded ones."""
    excluded = {items[pick].item_id for pick in picks if pick < len(items)}
    page, _ = rank(items, [], NOW, excluded, len(items), "page")
    assert ids(page) == [item.item_id for item in items if item.item_id not in excluded]


@FAST
@given(items=ITEMS, rules=RULES, order=ORDER)
def test_rank_reasons_explain_every_boost(items, rules, order):
    """Each shown item lists one reason per boost that applies, 'recent' when young and its source last."""
    page, _ = rank(items, rules, NOW, limit=len(items), order=order)
    for view_item in page:
        item = view_item.item
        boosts = [rule for rule in rules if rule.do == "boost" and applies(rule, item, NOW)]
        assert view_item.reasons[-1] == f"from {item.source_id}"
        assert sum(reason.startswith("boost: ") for reason in view_item.reasons) == len(boosts)
        assert ("recent" in view_item.reasons) == (age_hours(item, NOW) <= RECENT_HOURS)


def limit_rule(field: str, value: str, count: int) -> Rule:
    return Rule(when=Condition(field=field, op="eq", value=value), do="limit", count_per_day=count)


def greedy_ids(items: list[Item], rules: list[Rule], order: str) -> list[str]:
    """Reference: walk the ranking best first and keep an item only if every limit it matches still has room among kept items."""
    unlimited = [rule for rule in rules if rule.do != "limit"]
    limits = [rule for rule in rules if rule.do == "limit" and rule.count_per_day is not None]
    ranked, _ = rank(items, unlimited, NOW, limit=len(items), order=order)
    kept: list[str] = []
    counts: dict[tuple[int, str], int] = {}
    for view_item in ranked:
        keys = [(index, day_of(view_item.item)) for index, rule in enumerate(limits) if applies(rule, view_item.item, NOW)]
        if all(counts.get(key, 0) < limits[key[0]].count_per_day for key in keys):
            kept.append(view_item.item.item_id)
            for key in keys:
                counts[key] = counts.get(key, 0) + 1
    return kept


@FEW
@example(
    items=[
        make_item(0, "x", 1, True, ["art"], None, None, "a"),
        make_item(1, "x", 2, True, ["politics"], None, None, "b"),
        make_item(2, "rss:ars", 3, True, ["politics"], None, None, "c"),
    ],
    rules=[limit_rule("source_id", "x", 1), limit_rule("topic", "politics", 1)],
    order="recency",
)
@given(items=ITEMS, rules=RULES, order=ORDER)
def test_rank_limits_only_count_items_that_are_kept(items, rules, order):
    """'At most N a day' keeps the best N matching items that survive every other limit, not fewer."""
    page, _ = rank(items, rules, NOW, limit=len(items), order=order)
    assert ids(page) == greedy_ids(items, rules, order)
