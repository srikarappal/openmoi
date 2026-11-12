"""Collections: Read later, Watch later and any list you name; offline copies, exports and highlights."""

import json
from datetime import UTC, datetime, timedelta

from conftest import TOKEN
from fastapi.testclient import TestClient
from helpers import FixedClock

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.collections import collection_name, collection_title, export_markdown, is_collection_name
from moi_brain.compile import parse_sources, source_ids
from moi_brain.items import normalize
from moi_brain.journal import matching_lines
from moi_brain.store import Store

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


def record(native_id: str, title: str, hours: float = 1.0, url: str | None = None) -> dict:
    return {"native_id": native_id, "url": url or f"https://blog.example/posts/{native_id}", "title": title, "text": f"Text of {title}", "published_at": (NOW - timedelta(hours=hours)).isoformat()}


def make_client(paths, settings, services, clock: FixedClock) -> TestClient:
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    return TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})


def ingest(client: TestClient, records: list[dict], source_id: str = "rss:blog") -> list[str]:
    return [item["item_id"] for item in client.post("/ingest", json={"source_id": source_id, "records": records}).json()["items"]]


def test_names_and_source_lines():
    assert [collection_name(text) for text in ("Read later", "read-later", " WATCH_LATER ", "!!")] == ["read_later", "read_later", "watch_later", ""]
    assert collection_title("read_later") == "Read later" and is_collection_name("read_later") and not is_collection_name("9lives")
    sources, warnings = parse_sources("* Collection: Read later, watch later\n* Collection: ???\n", [])
    assert source_ids(sources) == ["collection:read_later", "collection:watch_later"] and warnings == ["No collection named in: Collection: ???"]


def test_the_store_keeps_collections_and_never_expires_what_you_saved(tmp_path):
    store = Store(tmp_path / "moi.db")
    old, other = normalize("rss:a", record("1", "Old"), NOW - timedelta(days=60)), normalize("rss:a", record("2", "Other"), NOW - timedelta(days=60))
    store.upsert_items([old, other], listed_at=NOW - timedelta(days=60))
    assert store.add_to_collection("read_later", old.item_id, NOW) and not store.add_to_collection("read_later", old.item_id, NOW)
    store.add_to_collection("watch_later", other.item_id, NOW + timedelta(minutes=1))
    store.add_to_collection("read_later", other.item_id, NOW + timedelta(minutes=2))
    assert [item.title for item, _, _ in store.collection_items(["read_later"])] == ["Other", "Old"]
    assert [item.title for item, _, _ in store.collection_items(["read_later", "watch_later"])] == ["Other", "Old"]
    assert store.collections_of([old.item_id, other.item_id, "ghost"]) == {old.item_id: ["read_later"], other.item_id: ["read_later", "watch_later"]}
    assert store.collection_counts() == {"read_later": 2, "watch_later": 1}
    store.expire(NOW)
    assert set(store.get_items([old.item_id, other.item_id])) == {old.item_id, other.item_id}
    assert store.remove_from_collection("read_later", old.item_id) and not store.remove_from_collection("read_later", old.item_id)
    store.expire(NOW)
    assert store.get_item(old.item_id) is None and store.collection_items([]) == [] and store.collections_of([]) == {}


def test_saving_shows_in_a_collection_view_newest_first_even_when_seen_and_old(paths, settings, services):
    clock = FixedClock(NOW)
    client = make_client(paths, settings, services, clock)
    (paths.views / "later.md").write_text("# Later\n\n## Sources\n* Collection: read later\n\n## Rules\n* Hide politics.\n")
    (paths.views / "blog.md").write_text("# Blog\n\n## Sources\n* RSS: https://blog.example/rss\n")
    first, second, third = ingest(client, [record("1", "Lithium recycling scales up", 2), record("2", "Bread baking at home", 1), record("3", "Election day politics recap", 3)])
    saved = client.post("/collections", json={"name": "Read later", "item_id": first}).json()
    assert saved == {"name": "read_later", "title": "Read later", "count": 1, "views": ["later"]}
    clock.moment += timedelta(minutes=1)
    client.post("/collections", json={"name": "read_later", "item_id": second})
    client.post("/collections", json={"name": "read_later", "item_id": third})
    client.post("/events", json={"events": [{"view_id": "blog", "item_id": first, "event_kind": "seen"}]})
    clock.moment += timedelta(days=9)
    page = client.post("/view/later", json={}).json()
    assert [entry["item"]["title"] for entry in page["items"]] == ["Bread baking at home", "Lithium recycling scales up"]
    assert all(entry["collections"] == ["read_later"] for entry in page["items"])
    blog = client.post("/view/blog", json={}).json()
    assert blog["items"] == []
    clock.moment = NOW
    blog = client.post("/view/blog", json={}).json()
    assert {entry["item"]["item_id"]: entry["collections"] for entry in blog["items"]}[second] == ["read_later"]
    removed = client.post("/collections", json={"name": "read_later", "item_id": second, "saved": False}).json()
    assert removed["count"] == 2
    assert [entry["name"] for entry in client.get("/collections").json()] == ["read_later"]
    assert client.post("/collections", json={"name": "!!!", "item_id": first}).status_code == 400
    assert client.post("/collections", json={"name": "read later", "item_id": "ghost"}).status_code == 400


def test_an_article_you_save_to_read_later_gets_an_offline_copy_once(paths, settings, services):
    clock = FixedClock(NOW)
    client = make_client(paths, settings, services, clock)
    article, video = ingest(client, [record("1", "Long read"), record("v", "A video", url="https://www.youtube.com/watch?v=VIDEO00001A")])
    for item_id in (article, video):
        client.post("/collections", json={"name": "read later", "item_id": item_id})
    wanted = client.get("/content/wanted").json()
    assert wanted == [{"item_id": article, "url": "https://blog.example/posts/1", "video": False, "purpose": "offline"}]
    answer = client.post("/content", json={"item_id": article, "purpose": "offline", "title": "Long read", "text": "First paragraph.\n\n  Second paragraph.  \n"}).json()
    assert answer["status"] == "saved"
    assert json.loads(answer["item"]["extra"]["blocks"]) == [{"type": "p", "text": "First paragraph."}, {"type": "p", "text": "Second paragraph."}]
    assert client.get("/content/wanted").json() == []
    [other] = ingest(client, [record("2", "Empty page")])
    client.post("/collections", json={"name": "read later", "item_id": other})
    assert client.post("/content", json={"item_id": other, "purpose": "offline", "text": "  \n "}).json()["status"] == "empty"
    assert client.get("/content/wanted").json() == []
    clock.moment += timedelta(hours=25)
    assert [entry["item_id"] for entry in client.get("/content/wanted").json()] == [other]
    assert services.model_calls("summarize") == []


def test_exports_of_a_collection_and_of_a_view(paths, settings, services):
    clock = FixedClock(NOW)
    client = make_client(paths, settings, services, clock)
    (paths.views / "blog.md").write_text("# Blog\n\n## Sources\n* RSS: https://blog.example/rss\n")
    first, _ = ingest(client, [record("1", "Lithium recycling scales up"), record("2", "Bread baking at home")])
    client.post("/collections", json={"name": "read later", "item_id": first})
    markdown = client.post("/export", json={"collection": "read later"}).json()["path"]
    assert markdown.startswith(str(paths.home / "exports" / "read_later_")) and markdown.endswith(".md")
    text = open(markdown).read()
    assert text.startswith("# Read later\n") and "## [Lithium recycling scales up](https://blog.example/posts/1)" in text and "Bread" not in text
    data = json.loads(open(client.post("/export", json={"view_id": "blog", "format": "json"}).json()["path"]).read())
    assert data["title"] == "Blog" and {item["title"] for item in data["items"]} == {"Lithium recycling scales up", "Bread baking at home"}
    assert client.post("/export", json={}).status_code == 400
    assert client.post("/export", json={"format": "pdf", "collection": "x"}).status_code == 422
    assert "Summary: short" in export_markdown("T", [(normalize("rss:a", record("9", "T"), NOW).model_copy(update={"extra": {"summary": "short"}}), NOW)], NOW)


def test_highlights_go_to_memory_and_the_journal_where_chat_finds_them(paths, settings, services):
    client = make_client(paths, settings, services, FixedClock(NOW))
    [item_id] = ingest(client, [record("1", "Lithium recycling scales up")])
    line = client.post("/highlight", json={"item_id": item_id, "quote": " Plants now recover\n95% of the metal. ", "note": "check the source"}).json()["line"]
    assert line == 'highlight: "Plants now recover 95% of the metal." note: check the source from Lithium recycling scales up (https://blog.example/posts/1)'
    assert line in (paths.memory / "highlights.md").read_text()
    assert matching_lines(paths.journal, "what did I mark about lithium recovery?")[0].endswith(line)
    assert client.post("/highlight", json={"item_id": item_id, "quote": "  "}).status_code == 400
    assert client.post("/highlight", json={"item_id": "ghost", "quote": "x"}).status_code == 400


def test_a_tab_for_a_collection_reads_it(paths, settings, services):
    client = make_client(paths, settings, services, FixedClock(NOW))
    [item_id] = ingest(client, [record("1", "Lithium recycling scales up")])
    client.post("/collections", json={"name": "watch later", "item_id": item_id})
    assert client.post("/collections/view", json={"name": "Watch later"}).json() == {"view_id": "watch_later", "title": "Watch later"}
    assert [entry["item"]["item_id"] for entry in client.post("/view/watch_later", json={}).json()["items"]] == [item_id]
    assert client.get("/collections").json()[0]["views"] == ["watch_later"]
    assert client.post("/collections/view", json={"name": "watch later"}).status_code == 400
    assert client.post("/collections/view", json={"name": "!!"}).status_code == 400


def test_only_articles_without_a_copy_of_their_own_get_an_offline_copy(paths, settings, services):
    clock = FixedClock(NOW)
    client = make_client(paths, settings, services, clock)
    rich_blocks = json.dumps([{"type": "h", "text": "Heading"}, {"type": "img", "src": "https://a.example/i.png"}])
    article = {**record("1", "Long read"), "kind": "article"}
    rich = {**record("2", "Read in reader mode"), "kind": "article", "extra.blocks": rich_blocks}
    post = {**record("3", "A post"), "kind": "post"}
    product = {**record("4", "A lamp"), "kind": "product"}
    ids = ingest(client, [article, rich, post, product])
    for item_id in ids:
        client.post("/collections", json={"name": "read later", "item_id": item_id})
    assert [entry["item_id"] for entry in client.get("/content/wanted").json()] == [ids[0]]
    kept = client.post("/content", json={"item_id": ids[1], "purpose": "offline", "text": "flat text"}).json()
    assert kept["status"] == "saved" and json.loads(kept["item"]["extra"]["blocks"]) == json.loads(rich_blocks)


def test_a_read_view_summarizes_what_you_saved_however_old_and_seen(paths, settings, services):
    clock = FixedClock(NOW)
    client = make_client(paths, settings, services, clock)
    (paths.views / "read.md").write_text("# Read\n\n## Sources\n* Collection: read later\n\n## Rules\n* Summarize everything.\n")
    [item_id] = ingest(client, [{**record("1", "Long read", hours=200), "kind": "article"}])
    client.post("/collections", json={"name": "read later", "item_id": item_id})
    client.post("/events", json={"events": [{"view_id": "read", "item_id": item_id, "event_kind": "seen"}]})
    clock.moment += timedelta(days=5)
    wanted = client.get("/content/wanted").json()
    assert [(entry["item_id"], entry["purpose"]) for entry in wanted] == [(item_id, "summary")]


def test_highlights_survive_the_monthly_roll_up(paths, settings, services):
    clock = FixedClock(NOW - timedelta(days=60))
    client = make_client(paths, settings, services, clock)
    [item_id] = ingest(client, [record("1", "Lithium recycling scales up")])
    client.post("/highlight", json={"item_id": item_id, "quote": "Plants recover 95% of the metal."})
    clock.moment = NOW
    brain = client.app.state.brain
    assert brain.roll_up_journal()
    assert matching_lines(paths.journal, "what did I mark about recovery of metal?")[0].endswith("(https://blog.example/posts/1)")


def test_an_export_cannot_make_links_or_headings_of_its_own():
    item = normalize("rss:a", {"native_id": "1", "url": "https://a.example/x (1)", "title": "Prize](https://phish.example/login) [claim", "text": "## [Fake](https://evil)"}, NOW)
    text = export_markdown("T", [(item, NOW)], NOW)
    assert "## [Prize\\]\\(https://phish.example/login\\) \\[claim](https://a.example/x%20%281%29)" in text
    assert "\\#\\# \\[Fake\\]\\(https://evil\\)" in text
