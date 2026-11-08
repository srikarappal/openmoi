"""Property based tests for the pure feed helpers in moi_brain.feeds."""

import html
import json
from datetime import UTC, datetime
from operator import itemgetter

import pytest
from hypothesis import example, given, settings
from hypothesis import strategies as st

from moi_brain.feeds import AGE_SECONDS, TAG, YOUTUBE_BASE, channel_page_videos, entry_record, published_from_age, strip_html

FAST = settings(max_examples=150, deadline=None)
FEW = settings(FAST, max_examples=40)
NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)

SAFE_TEXT = st.text(alphabet=st.characters(blacklist_categories=["Cs"]), max_size=40)
PLAIN_TEXT = st.text(alphabet=st.characters(blacklist_categories=["Cs"], blacklist_characters="<>&"), max_size=40)
TAG_NAME = st.sampled_from(["p", "b", "i", "a href='https://a.com'", "span class=\"x\"", "br/", "div"])
NO_DIGITS = st.text(alphabet="abcdefghijklmnopqrstuvwxyz ,.•", max_size=20)
UNIT = st.sampled_from(sorted(AGE_SECONDS))
VIDEO_ID = st.from_regex(r"[A-Za-z0-9_-]{11}", fullmatch=True)


@FAST
@given(value=st.one_of(st.none(), SAFE_TEXT))
def test_strip_html_never_raises_and_is_stripped(value):
    """Any text or None gives a string without surrounding whitespace."""
    result = strip_html(value)
    assert result == result.strip()


@FAST
@given(value=SAFE_TEXT.filter(lambda value: "&" not in value))
def test_strip_html_leaves_no_tags(value):
    """Without entities to unescape, no '<...>' tag survives."""
    assert not TAG.search(strip_html(value))


@FAST
@given(value=PLAIN_TEXT, tag=TAG_NAME)
def test_strip_html_keeps_text_between_tags(value, tag):
    """Plain words keep their content whether or not they are wrapped in a tag."""
    assert strip_html(value) == value.strip()
    assert strip_html(f"<{tag}>{value}</{tag.split()[0]}>") == value.strip()


@FAST
@given(value=SAFE_TEXT)
def test_strip_html_reverses_escaping(value):
    """Escaped text comes back as the original text."""
    assert strip_html(html.escape(value)) == value.strip()


def age_label(prefix: str, count: int, unit: str, suffix: str) -> str:
    return f"{prefix}{count} {unit}{'' if count == 1 else 's'} ago{suffix}"


@FAST
@given(prefix=NO_DIGITS, count=st.integers(min_value=0, max_value=900), unit=UNIT, suffix=NO_DIGITS)
def test_published_from_age_subtracts_the_stated_age(prefix, count, unit, suffix):
    """'N units ago' anywhere in a label is exactly N units before now."""
    published = published_from_age(age_label(prefix, count, unit, suffix), NOW)
    assert (NOW - datetime.fromisoformat(published)).total_seconds() == count * AGE_SECONDS[unit]


@FAST
@given(label=NO_DIGITS)
def test_published_from_age_without_an_age_is_none(label):
    """Labels with no number are not dated."""
    assert published_from_age(label, NOW) is None


@FEW
@example(count=3000, unit="year")
@given(count=st.integers(min_value=0), unit=UNIT)
def test_published_from_age_never_raises(count, unit):
    """Any 'N units ago' label is dated or ignored, never a crash of the channel page fallback."""
    published = published_from_age(age_label("", count, unit, ""), NOW)
    assert published is None or datetime.fromisoformat(published) <= NOW


@FAST
@given(page=SAFE_TEXT, wrapped=st.booleans())
def test_channel_page_videos_never_raises_on_arbitrary_text(page, wrapped):
    """Any page, even one with a broken ytInitialData script, gives a list of videos and no error."""
    text = f"<script>var ytInitialData = {{{page}}};</script>" if wrapped else page
    assert isinstance(channel_page_videos(text, NOW), list)


def lockup(video_id: str, title: str, age: str) -> dict:
    return {
        "lockupViewModel": {
            "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
            "contentId": video_id,
            "contentImage": {"thumbnailViewModel": {"image": {"sources": [{"url": f"https://i.ytimg.com/vi/{video_id}/hq720.jpg"}]}}},
            "metadata": {"lockupMetadataViewModel": {"title": {"content": title}, "metadata": {"rows": [{"accessibilityLabel": age}]}}},
        }
    }


def renderer(video_id: str, title: str, age: str) -> dict:
    return {"videoRenderer": {"videoId": video_id, "title": {"runs": [{"text": title}]}, "publishedTimeText": {"simpleText": age}}}


def channel_page(data: object) -> str:
    return f"<html><script>var ytInitialData = {json.dumps(data)};</script></html>"


VIDEOS = st.lists(st.tuples(VIDEO_ID, SAFE_TEXT, st.integers(min_value=1, max_value=60), UNIT), max_size=6, unique_by=itemgetter(0))


@FAST
@given(shape=st.sampled_from([lockup, renderer]), videos=VIDEOS, author=SAFE_TEXT, shelves=st.integers(min_value=1, max_value=2))
def test_channel_page_videos_reads_every_video_once(shape, videos, author, shelves):
    """Each video on the page appears once, in page order, with its watch URL, title, author and age."""
    contents = [shape(video_id, title, f"{count} {unit}s ago") for video_id, title, count, unit in videos] * shelves
    data = {"metadata": {"channelMetadataRenderer": {"title": author}}, "contents": contents}
    found = channel_page_videos(channel_page(data), NOW)
    assert [video["native_id"] for video in found] == [video_id for video_id, *_ in videos]
    for video, (video_id, title, count, unit) in zip(found, videos):
        assert video["url"] == f"{YOUTUBE_BASE}/watch?v={video_id}"
        assert (video["title"], video["author_name"], video["kind"]) == (title, author, "video")
        assert (NOW - datetime.fromisoformat(video["published_at"])).total_seconds() == count * AGE_SECONDS[unit]


def json_containers(children: st.SearchStrategy) -> st.SearchStrategy:
    return st.one_of(st.lists(children, max_size=3), st.dictionaries(st.sampled_from(["title", "runs", "text", "metadata", "sources", "url"]), children, max_size=3))


JSON_VALUE = st.recursive(st.one_of(st.none(), st.booleans(), st.integers(), SAFE_TEXT), json_containers, max_leaves=8)
KNOWN_KEY = st.sampled_from(["lockupViewModel", "videoRenderer", "channelMetadataRenderer"])


@FEW
@example(key="videoRenderer", value=None)
@given(key=KNOWN_KEY, value=JSON_VALUE)
def test_channel_page_videos_tolerates_unexpected_shapes(key, value):
    """A page whose JSON has an odd value under a known key yields no videos for it instead of raising."""
    assert isinstance(channel_page_videos(channel_page({"contents": [{key: value}]}), NOW), list)


def summary_html(words: str, image_url: str | None) -> str:
    image_tag = f'<img alt="" src="{image_url}">' if image_url else ""
    return f"<p>{html.escape(words)}</p>{image_tag}"


def youtube_link(video_id: str, short: bool) -> str:
    return f"https://www.youtube.com/shorts/{video_id}" if short else f"https://www.youtube.com/watch?v={video_id}"


def thumbnail_url(video_id: str) -> str:
    return f"https://i.ytimg.com/vi/{video_id}/hq.jpg"


ENTRY = st.fixed_dictionaries(
    {"raw_title": SAFE_TEXT, "words": SAFE_TEXT, "summary_image": st.one_of(st.none(), VIDEO_ID.map(thumbnail_url))},
    optional={
        "link": st.one_of(st.just(""), st.builds(youtube_link, VIDEO_ID, st.booleans())),
        "id": st.one_of(st.none(), SAFE_TEXT),
        "yt_videoid": st.one_of(st.none(), VIDEO_ID),
        "author": st.one_of(st.none(), SAFE_TEXT),
        "published_parsed": st.datetimes(min_value=datetime(1971, 1, 1), max_value=datetime(2100, 1, 1)).map(datetime.utctimetuple),
        "media_thumbnail": st.lists(st.fixed_dictionaries({"url": st.one_of(st.just(""), VIDEO_ID.map(thumbnail_url))}), max_size=2),
    },
)


@FAST
@given(spec=ENTRY, kind=st.sampled_from(["article", "video"]))
def test_entry_record_shape(spec, kind):
    """Every entry becomes a record with the same keys, its link, unescaped title and text, the best id, image and a UTC time."""
    entry = {key: value for key, value in spec.items() if key not in ("raw_title", "words", "summary_image")}
    entry |= {"title": html.escape(spec["raw_title"]), "summary": summary_html(spec["words"], spec["summary_image"])}
    record = entry_record(entry, kind)
    link = entry.get("link", "")
    expected_keys = {"native_id", "url", "title", "text", "author_name", "image_url", "published_at", "kind"}
    assert set(record) == (expected_keys | {"media_kind"} if kind == "video" else expected_keys)
    assert (record["url"], record["kind"], record["author_name"]) == (link, kind, entry.get("author"))
    assert record["native_id"] == (entry.get("yt_videoid") or entry.get("id") or link)
    assert record["title"] == spec["raw_title"]
    assert record["text"] == spec["words"].strip()
    if kind == "video":
        assert record["media_kind"] == ("short_video" if "/shorts/" in link else "long_video")
    thumbnails = [thumbnail["url"] for thumbnail in entry.get("media_thumbnail", []) if thumbnail["url"]]
    assert record["image_url"] == (thumbnails[0] if thumbnails else spec["summary_image"])
    if "published_parsed" in entry:
        published = datetime.fromisoformat(record["published_at"])
        assert published.utcoffset().total_seconds() == 0
        assert published.utctimetuple()[:6] == entry["published_parsed"][:6]
    else:
        assert record["published_at"] is None
