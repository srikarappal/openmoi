"""Extractor and lens stores: the file backed pieces the shell asks for."""

import pytest

from moi_brain.config import REPO_DIR
from moi_brain.extractors import ExtractorSpec, ExtractorStore, FieldRule, path_pattern_for, spec_file_name, spec_matches
from moi_brain.lenses import LensStore, lens_key


def listing_spec(domain="news.example.com", pattern="/", version=1):
    return ExtractorSpec(domain=domain, path_pattern=pattern, version=version, item_root="li", fields={"title": FieldRule(select="a")})


@pytest.mark.parametrize(
    ("url", "pattern"),
    [
        ("https://news.ycombinator.com/", "/"),
        ("https://news.ycombinator.com", "/"),
        ("https://www.amazon.com/s?k=lamp", "/s*"),
        ("https://shop.example.com/category/lamps/page/2", "/category*"),
    ],
)
def test_path_pattern_for(url, pattern):
    assert path_pattern_for(url) == pattern


def test_spec_matches_domain_and_path():
    spec = listing_spec("amazon.com", "/s*")
    assert spec_matches(spec, "https://www.amazon.com/s?k=lamp")
    assert not spec_matches(spec, "https://www.amazon.com/dp/B000")
    assert not spec_matches(spec, "https://amazon.co.uk/s?k=lamp")


def test_builtin_x_spec_is_found(tmp_path):
    store = ExtractorStore(REPO_DIR / "extractors", tmp_path)
    spec = store.for_page_type("x.com", "home_timeline")
    assert spec.start_url == "https://x.com/home"
    assert store.for_url("https://x.com/home") == spec
    assert store.for_url("https://x.com/settings") is None


def test_saved_specs_get_increasing_versions(tmp_path):
    store = ExtractorStore(tmp_path / "builtin", tmp_path / "generated")
    (tmp_path / "builtin").mkdir()
    (tmp_path / "generated").mkdir()
    first = store.save(listing_spec(version=99))
    second = store.save(listing_spec())
    other = store.save(listing_spec(pattern="/item*"))
    assert (first.version, second.version, other.version) == (1, 2, 1)
    assert store.for_url("https://news.example.com/").version == 2
    assert store.for_url("https://news.example.com/item?id=3") == other
    assert sorted(path.name for path in (tmp_path / "generated").iterdir()) == [
        "news.example.com.v1.json",
        "news.example.com.v2.json",
        "news.example.com__item.v1.json",
    ]


def test_spec_file_name_is_safe():
    assert spec_file_name(listing_spec("a.com", "/../../etc*")) == "a.com__.._.._etc.v1.json"


def test_lens_key():
    assert lens_key("feed", "feed") == "feed"
    assert lens_key("site_amazon.com", "listing") == "site_amazon.com_listing"


def test_lens_store_versions_and_rollback(tmp_path):
    default = tmp_path / "default.html"
    default.write_text("<p>default</p>")
    store = LensStore(default, tmp_path / "lenses")
    assert store.html("feed") == "<p>default</p>"
    assert store.versions("feed") == []
    assert store.save("feed", "<p>one</p>", "hash1") == 1
    assert store.save("feed", "<p>two</p>", "hash2") == 2
    assert store.html("feed") == "<p>two</p>"
    assert store.versions("feed") == [1, 2]
    assert store.rollback("feed", "hash2") == 1
    assert store.html("feed") == "<p>one</p>"
    assert store.rollback("feed", "hash2") == 0
    assert store.html("feed") == "<p>default</p>"
    assert store.save("feed", "<p>three</p>", "hash3") == 3


def test_lens_staleness_follows_layout(tmp_path):
    store = LensStore(tmp_path / "default.html", tmp_path / "lenses")
    assert not store.is_stale("feed", "", "empty")
    assert store.is_stale("feed", "Magazine", "hash_magazine")
    store.save("feed", "<p>magazine</p>", "hash_magazine")
    assert not store.is_stale("feed", "Magazine", "hash_magazine")
    assert store.is_stale("feed", "Compact", "hash_compact")
    store.rollback("feed", "hash_compact")
    assert not store.is_stale("feed", "Compact", "hash_compact")


def test_default_lens_follows_the_contract():
    html = (REPO_DIR / "lenses" / "default" / "default.html").read_text()
    for call in ("moi.on_render", "moi.on_append", "moi.ready()", "moi.open(", "moi.more(", "moi.seen(", "moi.less_like_this(", "dataset.itemId"):
        assert call in html
    assert "innerHTML" not in html
