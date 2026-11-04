import pytest

from moi_brain.compile import BadInput, Compiler, SourceRef, check_view_id, describe_sources, parse_sources
from moi_brain.config import Paths


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


def make_compiler(tmp_path) -> Compiler:
    paths = Paths(home=tmp_path, assets=tmp_path)
    for directory in (paths.views, paths.compiled):
        directory.mkdir(parents=True, exist_ok=True)
    return Compiler(paths)


def test_compiled_view_reads_sources_layout_and_source_ids(tmp_path):
    compiler = make_compiler(tmp_path)
    (tmp_path / "views" / "feed.md").write_text(
        "# My Feed\n## Sources\n* X\n* YouTube: @veritasium\n* RSS: https://feeds.arstechnica.com/arstechnica/index\n## Layout\nMagazine, dark.\n"
    )
    compiled = compiler.compiled("feed")
    assert compiled.title == "My Feed"
    assert compiled.layout == "Magazine, dark."
    assert compiled.source_ids() == ["x", "youtube:veritasium", "rss:arstechnica"]
    assert compiled.summary == "Reading X, 1 YouTube channel and 1 RSS feed."
    assert (tmp_path / ".moi" / "compiled" / "feed.json").exists()


def test_compiled_is_cached_until_an_input_changes(tmp_path, monkeypatch):
    compiler = make_compiler(tmp_path)
    view = tmp_path / "views" / "feed.md"
    view.write_text("# Feed\n## Sources\n* X\n")
    counter = CallCounter(compiler.compile)
    monkeypatch.setattr(compiler, "compile", counter)
    first = compiler.compiled("feed")
    second = compiler.compiled("feed")
    assert first == second
    assert counter.calls == 1
    view.write_text("# Feed\n## Sources\n* X\n* RSS: https://a.com/rss\n")
    assert compiler.compiled("feed").source_ids() == ["x", "rss:a"]
    assert counter.calls == 2
    (tmp_path / "subscriptions.csv").write_text("Channel Id,Channel Url,Channel Title\n")
    compiler.compiled("feed")
    assert counter.calls == 3


def test_takeout_subscriptions_expand_to_channels(tmp_path):
    compiler = make_compiler(tmp_path)
    (tmp_path / "subscriptions.csv").write_text(
        "Channel Id,Channel Url,Channel Title\nUCaaaaaaaaaaaaaaaaaaaaaa,http://y/a,A\nUCbbbbbbbbbbbbbbbbbbbbbb,http://y/b,B\n"
    )
    (tmp_path / "views" / "feed.md").write_text("# Feed\n## Sources\n* YouTube: subscriptions\n")
    assert compiler.compiled("feed").source_ids() == ["youtube:ucaaaaaaaaaaaaaaaaaaaaaa", "youtube:ucbbbbbbbbbbbbbbbbbbbbbb"]


def test_missing_view_compiles_to_an_empty_view(tmp_path):
    compiled = make_compiler(tmp_path).compiled("site_example.com")
    assert compiled.sources == []
    assert compiled.title == "site_example.com"


def test_view_infos_put_feed_first_and_skip_site_views(tmp_path):
    compiler = make_compiler(tmp_path)
    for name, text in {"tech": "# Tech\n", "feed": "# Feed\n", "site_amazon.com": "# Amazon\n", "notitle": "## Sources\n"}.items():
        (tmp_path / "views" / f"{name}.md").write_text(text)
    infos = compiler.view_infos()
    assert [(info.view_id, info.title) for info in infos] == [("feed", "Feed"), ("notitle", "notitle"), ("tech", "Tech")]


def test_layout_hash_tracks_layout_only(tmp_path):
    compiler = make_compiler(tmp_path)
    view = tmp_path / "views" / "feed.md"
    view.write_text("# Feed\n## Sources\n* X\n## Layout\nDense.\n")
    first = compiler.compiled("feed")
    view.write_text("# Feed\n## Sources\n* X\n* RSS: https://a.com/rss\n## Layout\nDense.\n")
    second = compiler.compiled("feed")
    assert first.file_hash != second.file_hash
    assert first.layout_hash == second.layout_hash
