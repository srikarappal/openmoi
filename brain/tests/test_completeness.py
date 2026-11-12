"""Newest first pages: marked in Sources, read until the reader reaches what the brain stored before."""

import pytest

from moi_brain.compile import parse_sources

FOLLOWING = "https://x.com/i/lists/42"


@pytest.mark.parametrize(
    ("line", "ordered"),
    [
        (f"* Page: {FOLLOWING} (newest first)", [FOLLOWING]),
        (f"* Page: {FOLLOWING}, chronological", [FOLLOWING]),
        (f"* Page: {FOLLOWING} in order", [FOLLOWING]),
        (f"* Page: {FOLLOWING}", []),
        ("* Page: https://example.com/newest-first-deals", []),
    ],
)
def test_a_page_is_newest_first_only_when_its_line_says_so(line, ordered):
    [source], warnings = parse_sources(line, [])
    assert source.pages == [line.split()[2].rstrip(",")] and source.ordered == ordered and warnings == []


def test_page_sources_carry_whether_posts_come_newest_first(client, paths):
    (paths.views / "friends.md").write_text(f"# Friends\n\n## Sources\n* Page: {FOLLOWING} (newest first)\n* Page: https://www.instagram.com/\n")
    sources = {source["source_id"]: source for source in client.post("/refresh", json={"view_id": "friends"}).json()["page_sources"]}
    assert sources["page:x.com/i/lists/42"]["chronological"] is True
    assert sources["page:instagram.com"]["chronological"] is False


def test_ingest_says_which_records_the_source_had_before(client):
    first = [{"native_id": f"p{index}", "url": f"https://x.com/p/{index}", "text": f"Post {index}"} for index in range(3)]
    body = {"source_id": "page:x.com/i/lists/42", "page_url": FOLLOWING}
    assert client.post("/ingest", json={**body, "records": first}).json()["already"] == []
    again = [{"native_id": "new", "url": "https://x.com/p/new", "text": "New"}, {"url": "bad"}, first[1], {**first[2], "native_id": "renamed"}]
    assert client.post("/ingest", json={**body, "records": again}).json()["already"] == [2, 3]
    elsewhere = client.post("/ingest", json={"source_id": "page:other.example", "records": first, "page_url": "https://other.example/"}).json()
    assert elsewhere["already"] == []
