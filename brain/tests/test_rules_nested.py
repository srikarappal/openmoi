"""Richer rules: whens nested with all, any and not, and the actions demote, pin, group_by and summarize_only."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from conftest import wait_until_refreshed
from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st
from pydantic import ValidationError

from moi_brain.brain import NOBODY_KNOWN
from moi_brain.compile import MAX_NESTING, AllOf, AnyOf, Condition, NotOf, Rule, leaf_conditions, nesting, usable_rules
from moi_brain.items import normalize
from moi_brain.rank import describe, group_of, matches, rank
from moi_brain.tag import rule_topics

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)
POLITICS = {"field": "topic", "op": "eq", "value": "politics"}
FROM_ARS = {"field": "source_id", "op": "eq", "value": "rss:ars"}
KNOWN = {"field": "author_in", "op": "eq", "value": "known"}


def make_item(source_id: str, native_id: str, hours_old: float = 1.0, topics: list[str] | None = None, **fields):
    record = {"native_id": native_id, "url": f"https://e.com/{source_id}/{native_id}", "title": f"t{native_id}", "published_at": (NOW - timedelta(hours=hours_old)).isoformat(), **fields}
    return normalize(source_id, record, NOW).model_copy(update={"topics": topics or []})


def ids(page) -> list[str]:
    return [view_item.item.native_id for view_item in page]


def topic(name: str) -> Condition:
    return Condition(field="topic", op="eq", value=name)


def test_nested_whens_validate_round_trip_and_name_their_conditions():
    rule = Rule.model_validate({"when": {"all": [POLITICS, {"not": {"any": [FROM_ARS, KNOWN]}}]}, "do": "hide"})
    assert isinstance(rule.when, AllOf) and isinstance(rule.when.every[1], NotOf) and isinstance(rule.when.every[1].negated, AnyOf)
    dumped = json.loads(rule.model_dump_json())
    assert dumped["when"] == {"all": [POLITICS, {"not": {"any": [FROM_ARS, KNOWN]}}]}
    assert Rule.model_validate(dumped) == rule
    assert [condition.field for condition in rule.conditions()] == ["topic", "source_id", "author_in"]
    assert nesting(rule.when) == 3 and nesting(None) == 0 and leaf_conditions(None) == []


@pytest.mark.parametrize(
    "when",
    [
        {"all": []},
        {"any": []},
        {"all": [POLITICS], "any": [POLITICS]},
        {"not": POLITICS, "extra": 1},
        {"all": [{"field": "nonsense", "op": "eq", "value": "x"}]},
        {"all": [POLITICS] * 13},
        {"not": {"not": {"not": {"not": {"not": POLITICS}}}}},
    ],
)
def test_malformed_or_too_deep_whens_are_refused(when):
    with pytest.raises(ValidationError):
        Rule.model_validate({"when": when, "do": "hide"})


def test_four_levels_of_nesting_are_allowed():
    deepest = {"not": {"all": [{"any": [{"not": POLITICS}]}]}}
    assert nesting(Rule.model_validate({"when": deepest, "do": "hide"}).when) == MAX_NESTING


def test_all_any_and_not_hold_as_they_say():
    ars_politics = make_item("rss:ars", "a", topics=["politics"])
    verge_politics = make_item("rss:verge", "b", topics=["politics"])
    when = Rule.model_validate({"when": {"all": [POLITICS, {"not": FROM_ARS}]}, "do": "hide"}).when
    assert not matches(when, ars_politics, NOW) and matches(when, verge_politics, NOW)
    either = Rule.model_validate({"when": {"any": [FROM_ARS, {"field": "topic", "op": "eq", "value": "sports"}]}, "do": "hide"}).when
    assert matches(either, ars_politics, NOW) and not matches(either, verge_politics, NOW)


CONDITIONS = st.sampled_from([topic("politics"), topic("ai"), Condition(field="source_id", op="eq", value="rss:ars"), Condition(field="media_kind", op="eq", value="image")])
def all_of(parts: list) -> AllOf:
    return AllOf(every=parts)


def any_of(parts: list) -> AnyOf:
    return AnyOf(some=parts)


def not_of(part) -> NotOf:
    return NotOf(negated=part)


def combined(inner: st.SearchStrategy) -> st.SearchStrategy:
    return st.one_of(
        st.builds(all_of, st.lists(inner, min_size=1, max_size=3)),
        st.builds(any_of, st.lists(inner, min_size=1, max_size=3)),
        st.builds(not_of, inner),
    )


WHENS = st.recursive(CONDITIONS, combined, max_leaves=6)
ITEMS = st.builds(
    make_item,
    source_id=st.sampled_from(["rss:ars", "rss:verge", "x"]),
    native_id=st.just("1"),
    topics=st.lists(st.sampled_from(["politics", "ai", "sports"]), max_size=2),
    media_kind=st.sampled_from([None, "image"]),
)


@hypothesis_settings(max_examples=200, deadline=None)
@given(when=WHENS, item=ITEMS)
def test_nested_whens_follow_boolean_logic(when, item):
    """not flips, all is every part and any is some part, at every depth."""
    assert matches(NotOf(negated=when), item, NOW) is (not matches(when, item, NOW))
    assert matches(AllOf(every=[when, when]), item, NOW) is matches(when, item, NOW)
    assert matches(AnyOf(some=[when, NotOf(negated=when)]), item, NOW) is True
    assert matches(AllOf(every=[when, NotOf(negated=when)]), item, NOW) is False


def test_describe_reads_nested_whens_in_plain_words():
    when = Rule.model_validate({"when": {"all": [POLITICS, {"not": {"any": [FROM_ARS, KNOWN]}}]}, "do": "hide"}).when
    assert describe(when) == "all of (topic politics; not any of (source rss:ars; author known))"


def test_demote_lowers_pin_tops_and_reasons_say_so():
    items = [make_item("x", "new", 1, topics=["crypto"]), make_item("x", "mid", 5), make_item("x", "old", 40, topics=["space"]), make_item("x", "boosted", 3, topics=["ai"])]
    rules = [
        Rule(when=topic("crypto"), do="demote", weight=3),
        Rule(when=topic("space"), do="pin"),
        Rule(when=topic("ai"), do="boost", weight=10),
    ]
    page, _ = rank(items, rules, NOW)
    assert ids(page) == ["old", "boosted", "mid", "new"]
    assert page[0].reasons[0] == "pinned: topic space"
    assert page[-1].reasons[0] == "demote: topic crypto"


def test_group_by_keeps_each_group_together_in_order_of_its_best_item():
    items = [make_item("rss:a", "a1", 1), make_item("rss:b", "b1", 2), make_item("rss:a", "a2", 3), make_item("rss:b", "b2", 4), make_item("x", "x1", 5)]
    page, _ = rank(items, [Rule(do="group_by", group_field="source_id")], NOW)
    assert ids(page) == ["a1", "a2", "b1", "b2", "x1"]
    assert [view_item.group for view_item in page] == ["rss:a", "rss:a", "rss:b", "rss:b", "x"]
    only_x = Rule(when=Condition(field="source_id", op="eq", value="x"), do="group_by", group_field="source_id")
    page, _ = rank(items, [only_x], NOW)
    assert ids(page) == ["a1", "b1", "a2", "b2", "x1"] and page[-1].group == "x" and page[0].group is None


@pytest.mark.parametrize(
    ("field", "fields", "topics", "expected"),
    [
        ("topic", {}, ["ai", "space"], "ai"),
        ("topic", {}, [], "other"),
        ("author_handle", {"author_handle": "maya"}, [], "maya"),
        ("author_handle", {}, [], "unknown"),
        ("media_kind", {"media_kind": "image"}, [], "image"),
        ("media_kind", {}, [], "other"),
        ("lang", {}, [], "unknown"),
    ],
)
def test_group_values(field, fields, topics, expected):
    item = make_item("x", "1", topics=topics, **fields)
    assert group_of(item, [Rule(do="group_by", group_field=field)], NOW) == expected


def test_summarize_only_marks_its_items():
    items = [make_item("youtube", "v", 1), make_item("x", "p", 2)]
    page, _ = rank(items, [Rule(when=Condition(field="source_id", op="eq", value="youtube"), do="summarize_only")], NOW)
    assert {view_item.item.native_id: view_item.summary_only for view_item in page} == {"v": True, "p": False}


def test_usable_rules_for_the_new_actions():
    rules = [
        Rule(do="pin"),
        Rule(do="demote"),
        Rule(when=topic("ai"), do="demote", weight=-2),
        Rule(when=topic("ai"), do="boost", weight=-4),
        Rule(do="group_by"),
        Rule(do="group_by", group_field="url"),
        Rule(do="group_by", group_field="topic"),
        Rule(do="summarize_only"),
    ]
    usable, _ = usable_rules(rules)
    assert [(rule.do, rule.weight, rule.group_field) for rule in usable] == [
        ("demote", 2.0, None),
        ("demote", 4.0, None),
        ("group_by", 0.0, "topic"),
        ("summarize_only", 0.0, None),
    ]


def test_topics_and_judgments_inside_nested_whens_are_found():
    rule = Rule.model_validate({"when": {"any": [POLITICS, {"not": {"field": "judged:angry", "op": "eq", "value": "yes"}}]}, "unless": {"all": [{"field": "topic", "op": "eq", "value": "Sports"}]}, "do": "hide"})
    assert rule_topics([rule]) == {"politics", "sports"}
    assert usable_rules([rule])[0] == []


def test_nested_rules_and_new_actions_in_a_real_view(client, paths, services):
    view = (
        "# Feed\n\n## Sources\n"
        f"* RSS: {services.base_url}/rss/tech.xml\n* RSS: {services.base_url}/rss/news.xml\n\n"
        "## Rules\n* Hide politics unless it is from news or someone I know.\n* Pin posts about science.\n"
        "* Less of technology.\n* Group by source.\n"
    )
    (paths.views / "feed.md").write_text(view)
    client.post("/refresh", json={"view_id": "feed"})
    page = wait_until_refreshed(client)
    titles = [view_item["item"]["title"] for view_item in page["items"]]
    assert "Election results shake up tech policy" not in titles
    assert "Senate debates the election budget" in titles
    assert titles[0] == "A tour of the new space telescope images"
    groups = [view_item["group"] for view_item in page["items"]]
    assert groups == sorted(groups, key=groups.index)
    reasons = {view_item["item"]["title"]: view_item["reasons"] for view_item in page["items"]}
    assert reasons["A tour of the new space telescope images"][0] == "pinned: topic science"
    assert reasons["Open source database hits version 10"][0] == "demote: topic technology"
    assert NOBODY_KNOWN in page["warnings"]
    compiled = json.loads(next((paths.state / "compiled").glob("feed*.json")).read_text())
    assert {"any": [{"field": "source_id", "op": "eq", "value": "rss:news"}, {"field": "author_in", "op": "eq", "value": "known"}]} == compiled["rules"][0]["unless"]
