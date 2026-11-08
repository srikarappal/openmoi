"""Property based tests for the deterministic parts of compile: Sources parsing, source ids, rules cleanup and view ids."""

from pathlib import Path

import pytest
from hypothesis import assume, example, given, settings
from hypothesis import strategies as st

from moi_brain.compile import DEFAULT_BOOST, URL, BadInput, Condition, Rule, SourceRef, check_view_id, describe_sources, parse_sources, source_ids, usable_rules
from moi_brain.items import youtube_source_id

FAST = settings(max_examples=150, deadline=None)
FEW = settings(FAST, max_examples=40)
FAMILY_ORDER = {"x": 0, "youtube": 1, "rss": 2}

HOST = st.builds(".".join, st.lists(st.from_regex(r"[a-z][a-z0-9]{0,6}", fullmatch=True), min_size=2, max_size=3))
PATH = st.lists(st.from_regex(r"[a-z0-9]{1,6}", fullmatch=True), min_size=1, max_size=3).map("/".join)
HANDLE = st.from_regex(r"[a-z][a-z0-9_]{0,12}", fullmatch=True)
CHANNEL = st.from_regex(r"UC[A-Za-z0-9_-]{22}", fullmatch=True)
MARKER = st.sampled_from(["*", "-", "+"])


def feed_url(host: str, path: str, extension: str) -> str:
    return f"https://{host}/{path}{extension}"


FEED = st.builds(feed_url, HOST, PATH, st.sampled_from(["", ".xml", "/rss", "/feed.xml"]))


def handle_form(handle: str, as_url: bool) -> tuple[str, str]:
    return (f"https://www.youtube.com/@{handle}" if as_url else f"@{handle}", f"@{handle}")


def channel_form(channel: str, as_url: bool) -> tuple[str, str]:
    return (f"https://www.youtube.com/channel/{channel}" if as_url else channel, channel)


YOUTUBE_ENTRY = st.one_of(st.builds(handle_form, HANDLE, st.booleans()), st.builds(channel_form, CHANNEL, st.booleans()))
SOURCE_LINE = st.one_of(
    st.tuples(st.just("rss"), st.lists(FEED, min_size=1, max_size=3)),
    st.tuples(st.just("bare"), st.lists(FEED, min_size=1, max_size=1)),
    st.tuples(st.just("youtube"), st.lists(YOUTUBE_ENTRY, min_size=1, max_size=3)),
    st.tuples(st.just("x"), st.sampled_from([["X home timeline"], ["X"], ["Twitter: @maya"], ["x: following"]])),
)


def source_line(kind: str, parts: list) -> str:
    if kind == "rss":
        return f"RSS: {', '.join(parts)}"
    if kind == "bare":
        return parts[0]
    if kind == "youtube":
        return f"YouTube: {', '.join(written for written, _ in parts)}"
    return parts[0]


@FAST
@given(lines=st.lists(SOURCE_LINE, max_size=6), marker=MARKER)
def test_parse_sources_reads_back_every_listed_source(lines, marker):
    """Every feed, handle and channel id written in Sources comes back once, with X detected and no warnings."""
    body = "\n".join(f"{marker} {source_line(kind, parts)}" for kind, parts in lines)
    sources, warnings = parse_sources(body, [])
    by_family = {source.source_id: source for source in sources}
    feeds = [url for kind, parts in lines if kind in ("rss", "bare") for url in parts]
    channels = [channel for kind, parts in lines if kind == "youtube" for _, channel in parts]
    assert warnings == []
    assert ("x" in by_family) == any(kind == "x" for kind, _ in lines)
    assert by_family.get("rss", SourceRef(source_id="rss")).feeds == list(dict.fromkeys(feeds))
    listed = by_family.get("youtube", SourceRef(source_id="youtube")).channels
    assert sorted(listed) == sorted(set(channels))
    assert len(listed) == len(set(listed))


LABEL = st.sampled_from(["RSS", "rss", "YouTube", "youtube", "X", "Twitter", "Feeds", "https", ""])
LOOSE_LINE = st.builds(
    "".join,
    st.lists(st.one_of(LABEL, st.sampled_from([":", ",", " ", "@", "https://", "UC", ".", ")", "subscriptions"]), FEED, st.text(max_size=6)), max_size=6),
)


@FAST
@given(lines=st.lists(LOOSE_LINE, max_size=5), marker=st.sampled_from(["* ", "- ", ""]), takeout=st.lists(CHANNEL, max_size=3))
def test_parse_sources_never_raises_and_output_is_clean(lines, marker, takeout):
    """Any Sources text parses into at most one source per family, in x, youtube, rss order, without duplicates."""
    body = "\n".join(f"{marker}{line}" for line in lines)
    sources, warnings = parse_sources(body, takeout)
    families = [source.source_id for source in sources]
    assert families == sorted(set(families), key=FAMILY_ORDER.get)
    for source in sources:
        assert len(source.feeds) == len(set(source.feeds)) and len(source.channels) == len(set(source.channels))
        assert all(URL.fullmatch(feed) and feed in body for feed in source.feeds)
        assert all(channel in body or channel in takeout for channel in source.channels)
    assert all(isinstance(warning, str) and warning for warning in warnings)


@FAST
@given(takeout=st.lists(CHANNEL, max_size=4), marker=MARKER)
def test_youtube_subscriptions_line_reads_the_takeout(takeout, marker):
    """'YouTube: subscriptions' lists every Takeout channel once, or warns when the Takeout is empty."""
    sources, warnings = parse_sources(f"{marker} YouTube: my subscriptions", takeout)
    if takeout:
        assert sources == [SourceRef(source_id="youtube", channels=list(dict.fromkeys(takeout)))]
        assert warnings == []
    else:
        assert sources == []
        assert len(warnings) == 1


@FAST
@given(lines=st.lists(SOURCE_LINE, max_size=6))
def test_source_ids_are_unique_and_follow_the_sources(lines):
    """source_ids lists X first when present, names every channel and never repeats an id."""
    sources, _ = parse_sources("\n".join(f"* {source_line(kind, parts)}" for kind, parts in lines), [])
    ids = source_ids(sources)
    assert len(ids) == len(set(ids))
    assert ("x" in ids) == any(source.source_id == "x" for source in sources)
    assert not ids or "x" not in ids or ids[0] == "x"
    channels = [channel for source in sources for channel in source.channels]
    assert {youtube_source_id(channel) for channel in channels} <= set(ids)
    assert all(source_id == "x" or source_id.startswith(("youtube:", "rss:")) for source_id in ids)


@FAST
@given(lines=st.lists(SOURCE_LINE, max_size=6))
def test_describe_sources_counts_what_was_parsed(lines):
    """The summary names the number of channels and feeds that were read from Sources."""
    sources, _ = parse_sources("\n".join(f"* {source_line(kind, parts)}" for kind, parts in lines), [])
    summary = describe_sources(sources)
    assert summary.startswith("Reading ") or summary == "No sources yet."
    assert summary.endswith(".")
    for source in sources:
        if source.channels:
            assert f"{len(source.channels)} YouTube channel{'s' if len(source.channels) != 1 else ''}" in summary
        if source.feeds:
            assert f"{len(source.feeds)} RSS feed{'s' if len(source.feeds) != 1 else ''}" in summary


@FEW
@example(host="[oops]")
@given(host=st.text(alphabet="ab.[]:", min_size=1, max_size=8))
def test_source_ids_never_raise_for_parsed_sources(host):
    """Whatever feed URL parse_sources accepts, source_ids can name it; a typo should be a warning, not a crash."""
    sources, _ = parse_sources(f"* RSS: https://{host}/feed.xml", [])
    assert all(source_id.startswith("rss:") for source_id in source_ids(sources))


CONDITION = st.builds(Condition, field=st.sampled_from(["topic", "source_id", "text"]), op=st.sampled_from(["eq", "contains"]), value=st.sampled_from(["art", "x", "deal"]))
RULE = st.builds(
    Rule,
    when=CONDITION,
    unless=st.one_of(st.none(), CONDITION),
    do=st.sampled_from(["hide", "boost", "limit"]),
    weight=st.one_of(st.just(0.0), st.floats(min_value=-5, max_value=10, allow_nan=False)),
    count_per_day=st.one_of(st.none(), st.integers(min_value=0, max_value=5)),
)


@FAST
@given(rules=st.lists(RULE, max_size=6))
def test_usable_rules_can_all_run_and_settle(rules):
    """Usable rules never hold a countless limit or a weightless boost, keep their order and are a fixed point."""
    usable = usable_rules(rules)
    runnable = [rule for rule in rules if not (rule.do == "limit" and not rule.count_per_day)]
    assert len(usable) == len(runnable)
    for kept, original in zip(usable, runnable):
        expected_weight = (original.weight or DEFAULT_BOOST) if original.do == "boost" else original.weight
        assert kept == original.model_copy(update={"weight": expected_weight})
    assert usable_rules(usable) == usable


@FAST
@given(view_id=st.text(max_size=12))
def test_check_view_id_only_accepts_names_that_stay_in_views(view_id):
    """A view id is either rejected with BadInput or names a file directly inside the views folder."""
    try:
        accepted = check_view_id(view_id)
    except BadInput:
        return
    views = Path("/home/views")
    assert accepted == view_id
    assert (views / f"{accepted}.md").parent == views
    assert not any(character.isspace() or character in "/\\\0" for character in accepted)
