import json

import httpx
import pytest

from moi_brain.compile import BadInput, Compiler, Condition, Rule, SourceRef, check_view_id, describe_sources, parse_sources, usable_rules
from moi_brain.config import Paths, Settings, Slot
from moi_brain.llm import Gateway
from moi_brain.memory import Memory


def test_parse_sources_all_forms():
    body = (
        "* X home timeline\n"
        "* YouTube: @veritasium, @3blue1brown, https://www.youtube.com/@mkbhd\n"
        "* YouTube: https://www.youtube.com/channel/UCfakechannel00000000001\n"
        "* RSS: https://a.com/rss, https://b.com/feed.xml\n"
        "* https://c.com/atom.xml\n"
        "* RSS: https://a.com/rss\n"
        "* Facebook friends\n"
    )
    sources, warnings = parse_sources(body, [])
    assert sources == [
        SourceRef(source_id="x", page_type="home_timeline"),
        SourceRef(source_id="youtube", channels=["@veritasium", "@3blue1brown", "@mkbhd", "UCfakechannel00000000001"]),
        SourceRef(source_id="rss", feeds=["https://a.com/rss", "https://b.com/feed.xml", "https://c.com/atom.xml"]),
    ]
    assert warnings == ["Unknown source line: Facebook friends"]


def test_parse_sources_takeout_and_empty_youtube():
    sources, warnings = parse_sources("* YouTube: subscriptions\n* YouTube: nothing here", ["UCaaaaaaaaaaaaaaaaaaaaaa"])
    assert sources == [SourceRef(source_id="youtube", channels=["UCaaaaaaaaaaaaaaaaaaaaaa"])]
    assert warnings == ["No YouTube channels found in: YouTube: nothing here"]


def test_describe_sources():
    assert describe_sources([]) == "No sources yet."
    assert describe_sources([SourceRef(source_id="x")]) == "Reading X."
    both = [SourceRef(source_id="x"), SourceRef(source_id="youtube", channels=["@a"]), SourceRef(source_id="rss", feeds=["https://a", "https://b"])]
    assert describe_sources(both) == "Reading X, 1 YouTube channel and 2 RSS feeds."


@pytest.mark.parametrize("view_id", ["../etc", "a/b", "", "has space"])
def test_check_view_id_rejects_paths(view_id):
    with pytest.raises(BadInput):
        check_view_id(view_id)


def test_check_view_id_accepts_site_ids():
    assert check_view_id("site_amazon.com") == "site_amazon.com"


class CallCounter:
    """Wraps a callable and counts how often it runs."""

    def __init__(self, function):
        self.function = function
        self.calls = 0

    def __call__(self, *args):
        self.calls += 1
        return self.function(*args)


@pytest.fixture
def compiler(tmp_path, settings):
    paths = Paths(home=tmp_path, assets=tmp_path)
    for directory in (paths.views, paths.compiled, paths.memory, paths.logs):
        directory.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=5) as http:
        yield Compiler(paths, Gateway(settings, paths.llm_log, http), Memory(paths))


def write_view(compiler: Compiler, text: str, view_id: str = "feed") -> None:
    (compiler.paths.views / f"{view_id}.md").write_text(text)


def test_compiled_view_reads_sources_layout_and_source_ids(compiler):
    write_view(compiler, "# My Feed\n## Sources\n* X\n* YouTube: @veritasium\n* RSS: https://feeds.arstechnica.com/arstechnica/index\n## Layout\nMagazine, dark.\n")
    compiled = compiler.compiled("feed")
    assert compiled.title == "My Feed"
    assert compiled.layout == "Magazine, dark."
    assert compiled.source_ids() == ["x", "youtube:veritasium", "rss:arstechnica"]
    assert compiled.summary == "Reading X, 1 YouTube channel and 1 RSS feed."
    assert compiled.rules == []
    assert (compiler.paths.compiled / "feed.json").exists()


def test_views_without_rules_never_call_the_model(compiler, services):
    write_view(compiler, "# Feed\n## Sources\n* X\n## Rules\n<!-- nothing yet -->\n")
    compiler.compiled("feed")
    assert services.model_calls() == []


def test_compiled_is_cached_until_an_input_changes(compiler, monkeypatch):
    write_view(compiler, "# Feed\n## Sources\n* X\n")
    counter = CallCounter(compiler.compile)
    monkeypatch.setattr(compiler, "compile", counter)
    first = compiler.compiled("feed")
    assert compiler.compiled("feed") == first
    assert counter.calls == 1
    write_view(compiler, "# Feed\n## Sources\n* X\n* RSS: https://a.com/rss\n")
    assert compiler.compiled("feed").source_ids() == ["x", "rss:a"]
    assert counter.calls == 2
    compiler.paths.takeout.write_text("Channel Id,Channel Url,Channel Title\n")
    compiler.compiled("feed")
    assert counter.calls == 3
    (compiler.paths.memory / "dislikes.md").write_text("# dislikes\n\n* crypto\n")
    compiler.compiled("feed")
    assert counter.calls == 4


def test_takeout_subscriptions_expand_to_channels(compiler):
    compiler.paths.takeout.write_text(
        "Channel Id,Channel Url,Channel Title\nUCaaaaaaaaaaaaaaaaaaaaaa,http://y/a,A\nUCbbbbbbbbbbbbbbbbbbbbbb,http://y/b,B\n"
    )
    write_view(compiler, "# Feed\n## Sources\n* YouTube: subscriptions\n")
    assert compiler.compiled("feed").source_ids() == ["youtube:ucaaaaaaaaaaaaaaaaaaaaaa", "youtube:ucbbbbbbbbbbbbbbbbbbbbbb"]


def test_missing_view_compiles_to_an_empty_view(compiler):
    compiled = compiler.compiled("site_example.com")
    assert compiled.sources == []
    assert compiled.title == "site_example.com"


def test_view_infos_put_feed_first_and_skip_site_views(compiler):
    for name, text in {"tech": "# Tech\n", "feed": "# Feed\n", "site_amazon.com": "# Amazon\n", "notitle": "## Sources\n"}.items():
        write_view(compiler, text, name)
    infos = compiler.view_infos()
    assert [(info.view_id, info.title) for info in infos] == [("feed", "Feed"), ("notitle", "notitle"), ("tech", "Tech")]
    assert compiler.view_ids() == ["feed", "notitle", "site_amazon.com", "tech"]
    assert len(compiler.all_compiled()) == 4


def test_layout_hash_tracks_layout_only(compiler):
    write_view(compiler, "# Feed\n## Sources\n* X\n## Layout\nDense.\n")
    first = compiler.compiled("feed")
    write_view(compiler, "# Feed\n## Sources\n* X\n* RSS: https://a.com/rss\n## Layout\nDense.\n")
    second = compiler.compiled("feed")
    assert first.file_hash != second.file_hash
    assert first.layout_hash == second.layout_hash


def test_rules_in_plain_words_compile_to_json(compiler, services):
    write_view(
        compiler,
        "# Feed\n## Sources\n* X\n* RSS: https://feeds.arstechnica.com/arstechnica/index\n"
        "## Rules\n* No shorts.\n* Hide politics unless it comes from arstechnica.\n* At most 20 posts from x a day.\n* Posts from @maya always first.\n",
    )
    compiled = compiler.compiled("feed")
    assert [rule.do for rule in compiled.rules] == ["hide", "hide", "limit", "boost"]
    assert compiled.rules[1].unless == Condition(field="source_id", op="eq", value="rss:arstechnica")
    assert compiled.rules[2].count_per_day == 20
    assert compiled.rules[3].weight == 10
    assert compiled.summary.startswith("Reading X and 1 RSS feed. No shorts; Hide politics")
    [call] = services.model_calls("compile_rules")
    prompt = json.loads(call["payload"]["messages"][1]["content"])
    assert prompt["sources"] == ["x", "rss:arstechnica"]
    assert prompt["view_rules"][0] == "No shorts."


def test_likes_and_dislikes_apply_to_every_view(compiler):
    (compiler.paths.memory / "dislikes.md").write_text("# dislikes\n\n<!-- hint -->\n* crypto\n")
    (compiler.paths.memory / "likes.md").write_text("# likes\n\n* sourdough\n")
    write_view(compiler, "# Tech\n## Sources\n* X\n", "tech")
    rules = compiler.compiled("tech").rules
    assert [(rule.do, rule.when.value, rule.weight) for rule in rules] == [("hide", "crypto", 0.0), ("boost", "sourdough", 3.0)]


def test_failed_rule_compile_keeps_previous_rules_and_retries_later(compiler, services):
    write_view(compiler, "# Feed\n## Sources\n* X\n## Rules\n* No shorts.\n")
    good = compiler.compiled("feed")
    write_view(compiler, "# Feed\n## Sources\n* X\n## Rules\n* No shorts.\n* Hide politics.\n")
    services.queue_model_reply("compile_rules", None)
    failed = compiler.compiled("feed")
    assert failed.rules == good.rules
    assert failed.warnings[0].startswith("Rules not updated:")
    assert compiler.compiled("feed") is failed
    assert len(services.model_calls("compile_rules")) == 2
    compiler.failures.clear()
    assert len(compiler.compiled("feed").rules) == 2


def test_usable_rules_fill_boost_weight_and_drop_countless_limits():
    boost = Rule(when=Condition(field="topic", op="eq", value="art"), do="boost")
    limit = Rule(when=Condition(field="source_id", op="eq", value="x"), do="limit")
    hide = Rule(when=Condition(field="topic", op="eq", value="crypto"), do="hide")
    assert usable_rules([boost, limit, hide]) == [boost.model_copy(update={"weight": 3.0}), hide]
