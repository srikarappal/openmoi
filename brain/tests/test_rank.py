from datetime import UTC, datetime, timedelta

from moi_brain.brain import seen_long_ago
from moi_brain.compile import Condition, Rule
from moi_brain.items import normalize
from moi_brain.rank import age_hours, describe, kept_share, matches, rank

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


def test_an_item_one_limit_drops_does_not_use_up_another_limit():
    items = [
        make_item("x", "maya1", 1, author_handle="maya"),
        make_item("x", "maya2", 2, author_handle="maya"),
        make_item("x", "bob", 3, author_handle="bob"),
    ]
    limits = [rule("limit", "source_id", "eq", "x", count_per_day=2), rule("limit", "author_handle", "eq", "maya", count_per_day=1)]
    page, _ = rank(items, limits, NOW)
    assert ids(page) == ["maya1", "bob"]


def test_limits_count_days_on_your_clock(pacific_clock):
    items = [make_item("x", "morning", 1), make_item("x", "last_evening", 9)]
    page, _ = rank(items, [rule("limit", "source_id", "eq", "x", count_per_day=1)], NOW)
    assert ids(page) == ["morning", "last_evening"]


def test_age_rules_compare_hours(pacific_clock):
    item = make_item("x", "a", 5)
    assert matches(Condition(field="age_hours", op="gt", value="4"), item, NOW)
    assert matches(Condition(field="age_hours", op="lt", value="6"), item, NOW)
    assert matches(Condition(field="age_hours", op="eq", value="5"), item, NOW)
    assert not matches(Condition(field="age_hours", op="eq", value="soon"), item, NOW)


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


def test_seen_long_ago_marks_only_items_seen_before_the_cutoff():
    long_seen, recently_seen, unseen = make_item("x", "3"), make_item("x", "4"), make_item("x", "5")
    entries = [(long_seen, NOW - timedelta(hours=13)), (recently_seen, NOW - timedelta(hours=1)), (unseen, None)]
    assert seen_long_ago(entries, NOW - timedelta(hours=12)) == {long_seen.item_id}


def test_one_copy_per_url_and_it_is_one_the_rules_let_through():
    politics = {"topics": ["politics"]}
    from_tech = make_item("rss:tech", "1", url="https://same.example/x", **politics)
    from_news = make_item("rss:news", "2", url="https://same.example/x", hours_old=3, **politics)
    hide_unless_news = Rule(when=Condition(field="topic", op="eq", value="politics"), unless=Condition(field="source_id", op="eq", value="rss:news"), do="hide")
    page, _ = rank([from_tech, from_news], [hide_unless_news], NOW)
    assert [entry.item.source_id for entry in page] == ["rss:news"]
    page, _ = rank([from_news, from_tech], [], NOW)
    assert [entry.item.native_id for entry in page] == ["1"]


def test_items_seen_long_ago_still_use_up_the_daily_limit():
    seen_this_morning = [make_item("x", "a", 9), make_item("x", "b", 8)]
    later = [make_item("x", "c", 1)]
    entries = [(item, NOW - timedelta(hours=13)) for item in seen_this_morning] + [(item, None) for item in later]
    hidden = seen_long_ago(entries, NOW - timedelta(hours=12))
    page, _ = rank([item for item, _ in entries], [rule("limit", "source_id", "eq", "x", count_per_day=2)], NOW, hidden)
    assert ids(page) == []


def test_a_story_already_shown_keeps_its_copy_when_a_newer_copy_arrives():
    shown = make_item("rss:hn", "h1", url="https://story.example/1", hours_old=3)
    newer = make_item("rss:lobsters", "l1", url="https://story.example/1", hours_old=1)
    first, _ = rank([shown], [], NOW)
    assert [entry.item.native_id for entry in first] == ["h1"]
    later, has_more = rank([shown, newer], [], NOW, {shown.item_id})
    assert later == [] and has_more is False


def test_kept_share_is_the_part_of_each_source_the_rules_let_through():
    items = [make_item("page:a", str(index), topics=["crypto"] if index % 4 == 0 else []) for index in range(8)] + [make_item("x", "x1")]
    hide_crypto = Rule(when=Condition(field="topic", op="eq", value="crypto"), do="hide")
    assert kept_share(items, [hide_crypto], NOW) == {"page:a": 0.75, "x": 1.0}
    assert kept_share([], [hide_crypto], NOW) == {}

