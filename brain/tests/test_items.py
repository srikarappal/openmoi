from datetime import UTC, datetime, timedelta, timezone

import pytest

from moi_brain.items import (
    page_source_id,
    canonical_url,
    host_label,
    make_item_id,
    normalize,
    parse_time,
    rss_source_id,
    site_source_id,
    source_family,
    source_matches,
    youtube_source_id,
)

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


def test_canonical_url_strips_tracking_and_fragment():
    assert canonical_url("https://a.com/x?utm_source=rss&id=3&fbclid=z&si=q#top") == "https://a.com/x?id=3"


def test_canonical_url_resolves_relative_links():
    assert canonical_url("/maya/status/1", "https://x.com/home") == "https://x.com/maya/status/1"


@pytest.mark.parametrize(
    ("url", "label"),
    [
        ("https://feeds.arstechnica.com/arstechnica/index", "arstechnica"),
        ("https://www.theverge.com/rss/index.xml", "theverge"),
        ("https://news.ycombinator.com/rss", "news.ycombinator"),
        ("https://alice.substack.com/feed", "alice.substack"),
        ("https://bob.substack.com/feed", "bob.substack"),
        ("https://feeds.bbci.co.uk/news/rss.xml", "bbci"),
        ("https://example.org", "example"),
        ("http://127.0.0.1:8899/rss/tech.xml", "tech"),
        ("http://localhost/feed.xml", "feed"),
        ("not a url", "feed"),
    ],
)
def test_host_label(url, label):
    assert host_label(url) == label


def test_source_ids():
    assert rss_source_id("https://feeds.arstechnica.com/arstechnica/index") == "rss:arstechnica"
    assert youtube_source_id("@Veritasium") == "youtube:veritasium"
    assert site_source_id("https://www.amazon.com/s?k=lamp") == "site:amazon.com"
    assert source_family("rss:arstechnica") == "rss"
    assert source_family("x") == "x"


@pytest.mark.parametrize(
    ("source_id", "wanted", "expected"),
    [
        ("youtube:veritasium", "youtube", True),
        ("youtube:veritasium", "youtube:veritasium", True),
        ("youtube:veritasium", "youtube:other", False),
        ("x", "x", True),
        ("xkcd", "x", False),
        ("rss:arstechnica", "rss:ars", False),
    ],
)
def test_source_matches(source_id, wanted, expected):
    assert source_matches(source_id, wanted) is expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2026-11-04T10:00:00Z", datetime(2026, 11, 4, 10, tzinfo=UTC)),
        ("2026-11-04T05:00:00-05:00", datetime(2026, 11, 4, 10, tzinfo=UTC)),
        ("Wed, 04 Nov 2026 10:00:00 GMT", datetime(2026, 11, 4, 10, tzinfo=UTC)),
        ("2026-11-04T10:00:00", datetime(2026, 11, 4, 10, tzinfo=UTC)),
        (1793786400, datetime(2026, 11, 4, 10, tzinfo=UTC)),
        (datetime(2026, 11, 4, 12, tzinfo=timezone(timedelta(hours=2))), datetime(2026, 11, 4, 10, tzinfo=UTC)),
        ("yesterday-ish", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_time(value, expected):
    assert parse_time(value) == expected


def test_normalize_full_record():
    record = {
        "native_id": "1001",
        "url": "/maya/status/1001?utm_campaign=x",
        "title": None,
        "text": "  hello \n  world  ",
        "author_name": "Maya R",
        "author_handle": "/Maya",
        "image_url": "/media/p.jpg",
        "published_at": "2026-11-04T10:00:00Z",
        "extra.price_text": "$20",
        "extra.empty": "",
    }
    item = normalize("x", record, NOW, "https://x.com/home")
    assert item is not None
    assert item.item_id == make_item_id("x", "1001")
    assert item.url == "https://x.com/maya/status/1001"
    assert item.text == "hello world"
    assert item.author_handle == "maya"
    assert item.kind == "post"
    assert item.image_url == "https://x.com/media/p.jpg"
    assert item.media_kind == "image"
    assert item.published_at == datetime(2026, 11, 4, 10, tzinfo=UTC)
    assert item.fetched_at == NOW
    assert item.extra == {"price_text": "$20"}


@pytest.mark.parametrize(
    "record",
    [
        {"title": "no url"},
        {"url": "https://a.com/1"},
        {"url": "  ", "title": "blank url"},
    ],
)
def test_normalize_drops_unusable_records(record):
    assert normalize("rss:a", record, NOW) is None


def test_normalize_defaults():
    item = normalize("rss:ars", {"url": "https://a.com/1", "title": "T", "kind": "nonsense", "author_handle": "@Ars"}, NOW)
    assert item.native_id == "https://a.com/1"
    assert item.kind == "article"
    assert item.author_handle == "ars"
    assert item.media_kind is None
    assert normalize("youtube:v", {"url": "https://y.com/1", "title": "T"}, NOW).kind == "video"
    assert normalize("site:amazon.com", {"url": "https://a.com/2", "title": "T"}, NOW).kind == "link"
    assert normalize("site:amazon.com", {"url": "https://a.com/3", "title": "T", "kind": "product"}, NOW).kind == "product"


def test_normalize_truncates_long_text():
    item = normalize("rss:a", {"url": "https://a.com/1", "title": "t" * 900, "text": "w " * 5000}, NOW)
    assert len(item.title) == 500
    assert len(item.text) <= 4000


def test_item_ids_are_stable_and_source_scoped():
    assert make_item_id("x", "1") == make_item_id("x", "1")
    assert make_item_id("x", "1") != make_item_id("rss:a", "1")
    assert len(make_item_id("x", "1")) == 32


def test_an_epoch_beyond_the_calendar_is_no_time():
    record = {"url": "https://a.com/1", "title": "t", "published_at": 1e20}
    assert normalize("rss:a", record, datetime.now(UTC)).published_at is None


@pytest.mark.parametrize(
    ("url", "source_id"),
    [
        ("https://www.instagram.com/", "page:instagram.com"),
        ("https://www.youtube.com/feed/subscriptions/", "page:youtube.com/feed/subscriptions"),
        ("http://127.0.0.1:8899/pages/endless.html", "page:127.0.0.1/pages/endless.html"),
        ("https://[oops/", "page:page"),
    ],
)
def test_page_source_id(url, source_id):
    assert page_source_id(url) == source_id



def test_facebook_tracking_trails_are_dropped_from_links():
    url = "https://www.facebook.com/maya/posts/pfbid0abc?__cft__[0]=AZW&__tn__=%2CO%2CP-R&ref=share&id=7"
    assert canonical_url(url) == "https://www.facebook.com/maya/posts/pfbid0abc?id=7"
