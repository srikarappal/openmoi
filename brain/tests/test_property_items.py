"""Property based tests for URL canonicalization, ids and record normalization in moi_brain.items."""

import re
from datetime import UTC, datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlparse

import pytest
from hypothesis import example, given, settings
from hypothesis import strategies as st

from moi_brain.items import (
    HOST_NOISE,
    ITEM_KINDS,
    SECOND_LEVEL,
    TRACKING_PARAMS,
    canonical_url,
    clean_text,
    host_label,
    is_tracking,
    make_item_id,
    normalize,
    rss_source_id,
    source_family,
    youtube_source_id,
)

FAST = settings(max_examples=150, deadline=None)
FEW = settings(FAST, max_examples=40)
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)
HEX_ID = re.compile(r"[0-9a-f]{32}")

SAFE_TEXT = st.text(alphabet=st.characters(blacklist_categories=["Cs"]), max_size=20)
LABEL = st.from_regex(r"[a-z0-9]([a-z0-9-]{0,6}[a-z0-9])?", fullmatch=True)
NAME_LABEL = LABEL.filter(lambda label: label not in HOST_NOISE and label not in SECOND_LEVEL)
TLD = st.sampled_from(["com", "org", "net", "io", "dev", "de"])


def join_host(labels: list[str], tld: str) -> str:
    return ".".join([*labels, tld])


def join_path(segments: list[str]) -> str:
    return "".join(f"/{segment}" for segment in segments)


HOST = st.builds(join_host, st.lists(LABEL, min_size=1, max_size=3), TLD)
PATH = st.lists(st.from_regex(r"[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,7}", fullmatch=True), max_size=4).map(join_path)
PLAIN_KEY = st.from_regex(r"[a-z][a-z0-9_]{0,6}", fullmatch=True)
KEY = st.one_of(PLAIN_KEY, st.sampled_from(sorted(TRACKING_PARAMS)), PLAIN_KEY.map(lambda key: f"utm_{key}"))
QUERY = st.lists(st.tuples(KEY, SAFE_TEXT), max_size=6)
FRAGMENT = st.one_of(st.just(""), st.from_regex(r"[a-z0-9]{1,8}", fullmatch=True))


def build_url(scheme: str, host: str, path: str, query: list[tuple[str, str]], fragment: str) -> str:
    query_text = f"?{urlencode(query)}" if query else ""
    fragment_text = f"#{fragment}" if fragment else ""
    return f"{scheme}://{host}{path}{query_text}{fragment_text}"


URL = st.builds(build_url, st.sampled_from(["http", "https"]), HOST, PATH, QUERY, FRAGMENT)


@FAST
@given(url=URL)
def test_canonical_url_is_idempotent(url):
    """Canonicalizing an already canonical URL changes nothing."""
    once = canonical_url(url)
    assert canonical_url(once) == once


@FAST
@given(scheme=st.sampled_from(["http", "https"]), host=HOST, path=PATH, raw_query=st.text(alphabet="ab=&;%+_.2F ~é", max_size=20))
def test_canonical_url_is_idempotent_on_raw_queries(scheme, host, path, raw_query):
    """Idempotence also holds for hand written queries with stray '&', '=', '%' or '+'."""
    once = canonical_url(f"{scheme}://{host}{path}?{raw_query}")
    assert canonical_url(once) == once


@FAST
@given(scheme=st.sampled_from(["http", "https"]), host=HOST, path=PATH, query=QUERY, fragment=FRAGMENT)
def test_canonical_url_drops_tracking_and_keeps_the_rest_in_order(scheme, host, path, query, fragment):
    """Tracking parameters and the fragment go; every other parameter stays with its value and order."""
    result = urlparse(canonical_url(build_url(scheme, host, path, query, fragment)))
    kept = parse_qsl(result.query, keep_blank_values=True)
    assert kept == [(key, value) for key, value in query if not is_tracking(key)]
    assert not any(is_tracking(key) for key, _ in kept)
    assert result.fragment == ""
    assert (result.scheme, result.netloc, result.path) == (scheme, host, path)


@FAST
@given(base=URL, path=PATH, query=QUERY)
def test_canonical_url_resolves_root_relative_links_on_the_base_host(base, path, query):
    """A link starting with '/' becomes an absolute URL on the base page's scheme and host."""
    query_text = f"?{urlencode(query)}" if query else ""
    link = f"{path or '/'}{query_text}"
    result = urlparse(canonical_url(link, base))
    assert (result.scheme, result.netloc) == (urlparse(base).scheme, urlparse(base).netloc)
    assert result.path == (path or "/")


@FAST
@given(source_id=SAFE_TEXT, native_id=SAFE_TEXT)
def test_make_item_id_is_stable_hex(source_id, native_id):
    """Item ids are deterministic 32 character lowercase hex strings."""
    item_id = make_item_id(source_id, native_id)
    assert HEX_ID.fullmatch(item_id)
    assert make_item_id(source_id, native_id) == item_id


@pytest.mark.xfail(strict=True, reason="make_item_id joins source and native id with ':' so ('a:b', 'c') and ('a', 'b:c') get the same id")
@FEW
@example(source_id="rss:a", middle="b", native_id="1")
@given(source_id=SAFE_TEXT, middle=SAFE_TEXT, native_id=SAFE_TEXT)
def test_make_item_id_separates_source_from_native_id(source_id, middle, native_id):
    """Different (source id, native id) pairs never share an item id."""
    assert make_item_id(f"{source_id}:{middle}", native_id) != make_item_id(source_id, f"{middle}:{native_id}")


@FAST
@given(url=st.one_of(URL, st.from_regex(r"https?://(localhost|127\.0\.0\.1)(:[0-9]{2,4})?(/[a-z0-9.]{1,8}){0,3}", fullmatch=True)))
def test_host_label_is_never_empty(url):
    """Every feed URL gets a non empty name made of whole host labels: no empty parts and no top level domain."""
    label = host_label(url)
    assert label
    if "localhost" not in url and "127.0.0.1" not in url:
        host_parts = (urlparse(url).hostname or "").split(".")
        parts = label.split(".")
        assert "" not in parts
        assert all(part in host_parts for part in parts) or label == "feed"
        assert len(parts) < len(host_parts) or label == "feed"


@FAST
@given(noise=st.lists(st.sampled_from(sorted(HOST_NOISE)), max_size=2), name=NAME_LABEL, tld=TLD, second_level=st.sampled_from(["", "co.", "com.", "org."]), path=PATH)
def test_host_label_skips_noise_and_suffixes(noise, name, tld, second_level, path):
    """feeds.NAME.com, www.NAME.co.uk or m.NAME.org all name the feed after NAME."""
    host = ".".join([*noise, name]) + f".{second_level}{tld}"
    assert host_label(f"https://{host}{path}") == name


@FAST
@given(url=URL)
def test_host_label_ignores_host_case_and_www(url):
    """Host case and a leading 'www.' do not change the feed's name."""
    parts = urlparse(url)
    upper = parts._replace(netloc=f"WWW.{parts.netloc.upper()}").geturl()
    assert host_label(upper) == host_label(url)
    assert rss_source_id(upper) == rss_source_id(url)
    assert source_family(rss_source_id(url)) == "rss"


@FAST
@given(handle=st.from_regex(r"[A-Za-z0-9_.-]{1,20}", fullmatch=True))
def test_youtube_source_id_ignores_at_sign_and_case(handle):
    """'@Name', 'name' and 'NAME' all name the same YouTube source."""
    source_id = youtube_source_id(handle)
    assert youtube_source_id(f"@{handle}") == source_id
    assert youtube_source_id(handle.upper()) == source_id
    assert source_id == source_id.lower()
    assert source_family(source_id) == "youtube"


def padded(value: str | None, padding: str) -> str | None:
    return None if value is None else f"{padding}{value}{padding}"


RECORD = st.fixed_dictionaries(
    {
        "url": st.one_of(URL, st.sampled_from(["", "   ", "\n"]), st.none()),
        "title": st.one_of(st.none(), SAFE_TEXT, st.text(min_size=490, max_size=600, alphabet="ab ")),
        "text": st.one_of(st.none(), SAFE_TEXT),
    },
    optional={
        "native_id": st.one_of(st.none(), SAFE_TEXT),
        "kind": st.one_of(st.sampled_from(sorted(ITEM_KINDS)), SAFE_TEXT),
        "author_handle": st.builds(padded, SAFE_TEXT, st.sampled_from(["", " ", "@", "/"])),
        "image_url": st.one_of(st.none(), URL),
        "extra.price": st.one_of(st.none(), SAFE_TEXT),
    },
)
SOURCE_ID = st.sampled_from(["x", "rss:ars", "youtube:veritasium", "site:amazon.com"])


@FAST
@given(source_id=SOURCE_ID, record=RECORD)
def test_normalize_drops_exactly_the_unusable_records(source_id, record):
    """A record becomes an item if and only if it has a URL and some words."""
    usable = bool(clean_text(record.get("url"))) and bool(clean_text(record.get("title")) or clean_text(record.get("text")))
    assert (normalize(source_id, record, NOW) is not None) == usable


@FAST
@given(source_id=SOURCE_ID, record=RECORD)
def test_normalize_output_invariants(source_id, record):
    """Items carry a canonical URL, an id derived from source and native id, bounded text and a known kind."""
    item = normalize(source_id, record, NOW)
    if item is None:
        return
    assert item.url == canonical_url(item.url)
    assert not any(is_tracking(key) for key, _ in parse_qsl(urlparse(item.url).query, keep_blank_values=True))
    assert item.item_id == make_item_id(source_id, item.native_id)
    assert item.source_id == source_id
    assert item.kind in ITEM_KINDS
    assert record.get("kind") not in ITEM_KINDS or item.kind == record["kind"]
    assert item.title is None or len(item.title) <= 500
    assert item.text is None or len(item.text) <= 4000
    assert item.author_handle is None or (item.author_handle == item.author_handle.lower() and not item.author_handle.startswith(("@", "/")))
    assert set(item.extra) <= {"price"}
    assert normalize(source_id, record, NOW) == item


@FEW
@example(url="http://[oops/article")
@given(url=st.builds(build_url, st.sampled_from(["http", "https"]), st.text(alphabet="ab.[]:", min_size=1, max_size=8), PATH, st.just([]), st.just("")))
def test_normalize_never_raises_on_odd_links(url):
    """A feed entry with a malformed link is dropped or kept, never a crash that stops the whole refresh."""
    item = normalize("rss:ars", {"url": url, "title": "t"}, NOW)
    assert item is None or item.url


def iso_with_offset(moment: datetime, offset_minutes: int) -> str:
    return moment.replace(tzinfo=timezone(timedelta(minutes=offset_minutes))).isoformat()


@FEW
@example(published_at="0001-01-01T00:00:00+05:00")
@given(published_at=st.builds(iso_with_offset, st.datetimes(), st.integers(min_value=-23 * 60, max_value=23 * 60)))
def test_normalize_never_raises_on_published_at_text(published_at):
    """Any ISO 8601 published_at string either parses or is ignored; it never makes normalize raise."""
    item = normalize("x", {"url": "https://x.com/a/status/1", "title": "t", "published_at": published_at}, NOW)
    assert item is not None
