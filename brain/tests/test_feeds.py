import feedparser
import httpx
import pytest
from fake_services import CHANNEL_ID

from moi_brain.feeds import FeedError, FeedFetcher, entry_image, entry_record, read_takeout, strip_html


@pytest.fixture
def fetcher(tmp_path, services):
    with httpx.Client(timeout=5) as http:
        yield FeedFetcher(http, tmp_path / "channels.json", services.base_url)


def test_fetch_rss_reads_entries(fetcher, services):
    records = fetcher.fetch_rss(f"{services.base_url}/rss/tech.xml")
    assert len(records) == 5
    first = records[0]
    assert first["native_id"] == "tech1"
    assert first["title"] == "New laptop chip doubles battery life"
    assert first["url"].startswith(f"{services.base_url}/articles/tech1")
    assert first["kind"] == "article"
    assert first["published_at"].endswith("+00:00")


def test_conditional_get_returns_nothing_when_unchanged(fetcher, services):
    url = f"{services.base_url}/rss/etag.xml"
    assert len(fetcher.fetch_rss(url)) == 1
    assert fetcher.fetch_rss(url) == []
    etag_requests = [request for request in services.requests if request["path"] == "/rss/etag.xml"]
    assert etag_requests[-1]["headers"]["if-none-match"] == '"v1"'
    assert etag_requests[0]["headers"]["user-agent"].startswith("openMoi")


def test_broken_and_missing_feeds_raise(fetcher, services):
    with pytest.raises(FeedError, match="not a readable feed"):
        fetcher.fetch_rss(f"{services.base_url}/rss/broken.xml")
    with pytest.raises(FeedError, match="404"):
        fetcher.fetch_rss(f"{services.base_url}/rss/missing.xml")


def test_unreachable_host_raises(tmp_path):
    with httpx.Client(timeout=1) as http:
        with pytest.raises(FeedError):
            FeedFetcher(http, tmp_path / "c.json").fetch_rss("http://127.0.0.1:9/feed.xml")


def test_youtube_handle_resolves_once_and_marks_shorts(fetcher, services, tmp_path):
    records = fetcher.fetch_youtube("@veritasium")
    assert [record["media_kind"] for record in records] == ["long_video", "short_video", "long_video"]
    assert {record["author_handle"] for record in records} == {"veritasium"}
    assert records[0]["native_id"] == "VIDEO00001A"
    assert records[0]["image_url"] == "https://i.ytimg.com/vi/VIDEO00001A/hqdefault.jpg"
    assert (tmp_path / "channels.json").read_text().count(CHANNEL_ID) == 1
    fetcher.fetch_youtube("veritasium")
    assert len([request for request in services.requests if request["path"] == "/@veritasium"]) == 1


def test_youtube_channel_id_skips_resolution(fetcher, services):
    records = fetcher.fetch_youtube(CHANNEL_ID)
    assert len(records) == 3
    assert records[0]["author_handle"] is None
    assert not [request for request in services.requests if request["path"].startswith("/@")]


def test_unknown_youtube_handle_raises(fetcher):
    with pytest.raises(FeedError, match="could not be loaded"):
        fetcher.fetch_youtube("@nobody")


def test_channel_cache_is_reused_across_fetchers(tmp_path, services):
    (tmp_path / "channels.json").write_text(f'{{"veritasium": "{CHANNEL_ID}"}}')
    with httpx.Client(timeout=5) as http:
        FeedFetcher(http, tmp_path / "channels.json", services.base_url).fetch_youtube("@veritasium")
    assert not [request for request in services.requests if request["path"] == "/@veritasium"]


def test_read_takeout(tmp_path):
    path = tmp_path / "subscriptions.csv"
    assert read_takeout(path) == []
    path.write_text("Channel Id,Channel Url,Channel Title\nUCaaaaaaaaaaaaaaaaaaaaaa,u,A\n,u,blank\n")
    assert read_takeout(path) == ["UCaaaaaaaaaaaaaaaaaaaaaa"]


def test_entry_image_sources():
    media_content = feedparser.parse(
        '<rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel><item><title>a</title>'
        '<media:content url="https://i/a.jpg" medium="image"/></item></channel></rss>'
    ).entries[0]
    assert entry_image(media_content, "") == "https://i/a.jpg"
    enclosure = feedparser.parse(
        '<rss version="2.0"><channel><item><title>b</title><enclosure url="https://i/b.png" type="image/png" length="1"/></item></channel></rss>'
    ).entries[0]
    assert entry_image(enclosure, "") == "https://i/b.png"
    assert entry_image({}, '<p>x</p><img alt="" src="https://i/c.gif">') == "https://i/c.gif"
    assert entry_image({}, "<p>no image</p>") is None


def test_entry_titles_are_unescaped_even_when_double_escaped():
    parsed = feedparser.parse(
        '<rss version="2.0"><channel><item><title>AMD&amp;#8217;s &amp;amp; Intel&amp;#8216;s week</title><link>https://a.com/1</link></item></channel></rss>'
    ).entries[0]
    assert entry_record(parsed, "article")["title"] == "AMD\u2019s & Intel\u2018s week"


def test_entry_record_without_dates_or_links():
    record = entry_record({"title": "T", "summary": "<b>bold</b> &amp; plain"}, "article")
    assert record["text"] == "bold  & plain"
    assert record["published_at"] is None
    assert record["url"] == ""


def test_strip_html():
    assert strip_html("<p>a</p><br>b &lt;c&gt;") == "a  b <c>"
    assert strip_html(None) == ""
