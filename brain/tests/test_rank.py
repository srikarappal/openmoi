from datetime import UTC, datetime, timedelta

from moi_brain.compile import Condition, Rule
from moi_brain.items import normalize
from moi_brain.rank import age_hours, describe, matches, rank

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


def make_item(source_id, native_id, hours_old=1.0, **fields):
    record = {"native_id": native_id, "url": f"https://e.com/{source_id}/{native_id}", "title": f"t{native_id}"}
    record["published_at"] = (NOW - timedelta(hours=hours_old)).isoformat()
    record.update(fields)
    item = normalize(source_id, record, NOW)
    return item.model_copy(update={"topics": fields.get("topics", [])})


def rule(do, field, op, value, **extra):
    return Rule(when=Condition(field=field, op=op, value=value), do=do, **extra)


def ids(page):
    return [view_item.item.native_id for view_item in page]


def test_recency_orders_newest_first_without_rules():
    items = [make_item("x", "old", 30), make_item("x", "new", 1), make_item("x", "mid", 10)]
    page, has_more = rank(items, [], NOW)
    assert ids(page) == ["new", "mid", "old"]
    assert has_more is False


def test_hide_and_unless():
    items = [make_item("rss:ars", "a", topics=["politics"]), make_item("rss:verge", "b", topics=["politics"]), make_item("x", "c")]
    hide_politics = Rule(
        when=Condition(field="topic", op="eq", value="politics"),
        unless=Condition(field="source_id", op="eq", value="rss:ars"),
        do="hide",
    )
    page, _ = rank(items, [hide_politics], NOW)
    assert sorted(ids(page)) == ["a", "c"]


def test_boost_moves_items_up_and_explains_why():
    items = [make_item("x", "new", 1, author_handle="bob"), make_item("x", "maya_post", 40, author_handle="maya")]
    page, _ = rank(items, [rule("boost", "author_handle", "eq", "@Maya", weight=10)], NOW)
    assert ids(page) == ["maya_post", "new"]
    assert page[0].reasons == ["boost: author @Maya", "from x"]
    assert page[1].reasons == ["recent", "from x"]


def test_limit_keeps_best_per_day():
    items = [make_item("x", str(index), hours_old=index) for index in range(1, 6)] + [make_item("rss:a", "r", 1.5)]
    page, _ = rank(items, [rule("limit", "source_id", "eq", "x", count_per_day=2)], NOW)
    assert ids(page) == ["1", "r", "2"]


def test_limit_counts_per_published_day():
    items = [make_item("x", "today", 1), make_item("x", "today2", 2), make_item("x", "yesterday", 30)]
    page, _ = rank(items, [rule("limit", "source_id", "eq", "x", count_per_day=1)], NOW)
    assert ids(page) == ["today", "yesterday"]


def test_excluded_items_still_count_toward_limits():
    items = [make_item("x", str(index), hours_old=index) for index in range(1, 5)]
    first, _ = rank(items, [rule("limit", "source_id", "eq", "x", count_per_day=2)], NOW)
    rendered = {view_item.item.item_id for view_item in first}
    second, has_more = rank(items, [rule("limit", "source_id", "eq", "x", count_per_day=2)], NOW, rendered)
    assert ids(first) == ["1", "2"]
    assert second == []
    assert has_more is False


def test_paging_with_exclusions():
    items = [make_item("x", str(index), hours_old=index) for index in range(1, 8)]
    first, has_more = rank(items, [], NOW, limit=3)
    assert ids(first) == ["1", "2", "3"]
    assert has_more is True
    second, has_more = rank(items, [], NOW, {view_item.item.item_id for view_item in first}, limit=3)
    assert ids(second) == ["4", "5", "6"]
    assert has_more is True


def test_page_order_keeps_given_order_but_honors_boosts():
    items = [make_item("site:a", "first", 50), make_item("site:a", "second", 1), make_item("site:a", "third", 2, title="Lamp deal")]
    page, _ = rank(items, [], NOW, order="page")
    assert ids(page) == ["first", "second", "third"]
    boosted, _ = rank(items, [rule("boost", "text", "contains", "deal", weight=5)], NOW, order="page")
    assert ids(boosted) == ["third", "first", "second"]


def test_condition_fields():
    item = make_item("youtube:veritasium", "v", 3, author_name="Veritasium", media_kind="short_video", text="Physics of Traffic", topics=["Science"])
    assert matches(Condition(field="source_id", op="eq", value="youtube"), item, NOW)
    assert matches(Condition(field="source_id", op="in", value=["x", "youtube:veritasium"]), item, NOW)
    assert not matches(Condition(field="source_id", op="eq", value="rss"), item, NOW)
    assert matches(Condition(field="author_handle", op="eq", value="veritasium"), item, NOW)
    assert matches(Condition(field="media_kind", op="eq", value="short_video"), item, NOW)
    assert matches(Condition(field="topic", op="in", value=["science", "art"]), item, NOW)
    assert matches(Condition(field="text", op="contains", value="TRAFFIC"), item, NOW)
    assert not matches(Condition(field="text", op="eq", value="traffic"), item, NOW)
    assert matches(Condition(field="age_hours", op="gt", value=2), item, NOW)
    assert matches(Condition(field="age_hours", op="lt", value=4), item, NOW)
    assert not matches(Condition(field="age_hours", op="gt", value="soon"), item, NOW)
    assert not matches(Condition(field="topic", op="gt", value="a"), item, NOW)
    assert not matches(None, item, NOW)


def test_age_uses_fetch_time_when_unpublished_and_never_negative():
    unpublished = normalize("x", {"url": "https://e.com/1", "title": "t"}, NOW - timedelta(hours=2))
    assert age_hours(unpublished, NOW) == 2.0
    future = make_item("x", "f", hours_old=-5)
    assert age_hours(future, NOW) == 0.0


def test_describe():
    assert describe(Condition(field="author_handle", op="eq", value="maya")) == "author maya"
    assert describe(Condition(field="topic", op="in", value=["a", "b"])) == "topic a, b"
