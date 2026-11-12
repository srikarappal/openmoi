"""Search and likeness: vectors made at ingest, bm25 search reordered by meaning, copies found by simhash or vectors,
and the labeled cluster check of the L2 exit."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient
from helpers import FixedClock, Recorder

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import REPO_DIR, Settings, Slot
from moi_brain.items import normalize
from moi_brain.llm import Gateway
from moi_brain.store import Store
from moi_brain.stories import CLUSTER_KEY, SIMHASH_KEY, LabeledStories, assign_clusters, evaluate_clusters, main, story_key
from moi_brain.vectors import HASHED, cosine, hashed_vector, unpacked

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)
LABELED = REPO_DIR / "fixtures" / "clusters" / "labeled_stories.json"
BODY = (
    "A powerful storm forced officials to close the Bay Bridge overnight as winds topped 70 miles per hour. Crews worked "
    "through the night to clear debris and the bridge is expected to reopen by the morning commute, the transit agency said "
    "in a statement. Drivers were told to use the tunnel instead."
)


def record(native_id: str, title: str, text: str = "", hours: float = 1.0) -> dict:
    return {"native_id": native_id, "url": f"https://example.com/{native_id}", "title": title, "text": text, "published_at": (NOW - timedelta(hours=hours)).isoformat()}


def item(source_id: str, native_id: str, title: str, text: str = ""):
    return normalize(source_id, record(native_id, title, text), NOW)


def embed_slot(services) -> Slot:
    return Slot(base_url=f"{services.base_url}/llm/v1", model="fake-embed")


def gateway_with(tmp_path, settings: Settings, transport: Recorder | None = None) -> Gateway:
    http = httpx.Client(transport=httpx.MockTransport(transport)) if transport else httpx.Client(timeout=5)
    return Gateway(settings, tmp_path / "calls.jsonl", http)


@pytest.fixture
def embedding_brain(paths, settings, services):
    created = Brain(paths, settings.model_copy(update={"embed": embed_slot(services)}), youtube_base=services.base_url, clock=FixedClock(NOW))
    yield created
    created.http.close()


def test_a_local_embedding_model_gives_unit_vectors_in_order(tmp_path, services, settings):
    gateway = gateway_with(tmp_path, settings.model_copy(update={"embed": embed_slot(services)}))
    vectors = gateway.embed("embed_items", ["red car", "automobile red", "puppy"])
    assert vectors is not None and len(vectors) == 3
    assert all(abs(sum(value * value for value in vector) - 1) < 1e-6 for vector in vectors)
    assert cosine(vectors[0], vectors[1]) > 0.99 and cosine(vectors[0], vectors[2]) < 0.1
    logged = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    assert logged[-1]["task"] == "embed_items" and logged[-1]["error"] is None


def test_embedding_gives_none_without_a_slot_when_privacy_blocks_or_the_model_fails(tmp_path, services, settings):
    assert gateway_with(tmp_path, settings).embed("embed_items", ["text"]) is None
    hosted = Slot(base_url="https://models.example.com/v1", model="embed")
    nothing_sent = Recorder()
    assert gateway_with(tmp_path, settings.model_copy(update={"embed": hosted}), nothing_sent).embed("embed_items", ["text"]) is None
    assert nothing_sent.requests == []
    allowed = Recorder(httpx.Response(200, json={"data": [{"index": 0, "embedding": [3.0, 4.0]}]}))
    assert gateway_with(tmp_path, settings.model_copy(update={"embed": hosted, "allow_content_to_hosted": True}), allowed).embed("embed_items", ["text"]) == [[0.6, 0.8]]
    short = Recorder(httpx.Response(200, json={"data": [{"index": 0, "embedding": [1.0]}]}))
    assert gateway_with(tmp_path, settings.model_copy(update={"embed": hosted, "allow_content_to_hosted": True}), short).embed("embed_items", ["a", "b"]) is None
    services.embeddings_down = True
    assert gateway_with(tmp_path, settings.model_copy(update={"embed": embed_slot(services)})).embed("embed_items", ["text"]) is None
    assert gateway_with(tmp_path, settings).embed("embed_items", []) is None


def test_store_search_ranks_items_with_more_of_the_words_first(tmp_path):
    store = Store(tmp_path / "moi.db")
    store.upsert_items([
        item("rss:a", "1", "Lithium battery recycling plant opens", "Lithium recycling at scale, lithium everywhere."),
        item("rss:a", "2", "Battery prices fall again"),
        item("rss:b", "3", "A walk in the park"),
    ])
    titles = [found.title for found, _ in store.search("lithium battery", 10)]
    assert titles == ["Lithium battery recycling plant opens", "Battery prices fall again"]
    assert [found.title for found, _ in store.search("battery prices", 10)][0] == "Battery prices fall again"
    assert len(store.search("battery battery", 1)) == 1
    assert all(score > 0 for _, score in store.search("battery", 10))
    assert store.search("", 10) == [] and store.search("!!! ???", 10) == []
    assert store.search('NEAR OR "* AND', 10) == []


def test_search_follows_replaced_and_expired_items_and_old_databases_are_indexed(tmp_path):
    store = Store(tmp_path / "moi.db")
    old = item("watch:x", "w", "Price list", "Widget costs 10 dollars")
    store.upsert_items([old], listed_at=NOW - timedelta(days=60))
    store.replace_item(item("watch:x", "w", "Price list", "Widget costs 12 dollars").model_copy(update={"item_id": "newer"}))
    assert [found.text for found, _ in store.search("widget", 10)] == ["Widget costs 12 dollars"]
    store.save_vectors({"newer": (HASHED, b"\0\0\0\0")})
    store.expire(NOW + timedelta(days=60))
    assert store.search("widget", 10) == [] and store.vectors_of(["newer"], HASHED) == {}
    store.upsert_items([item("rss:a", "1", "Garden tomatoes ripen early")])
    store.connection.execute("DROP TABLE items_search")
    store.connection.commit()
    reopened = Store(tmp_path / "moi.db")
    assert [found.title for found, _ in reopened.search("tomatoes", 10)] == ["Garden tomatoes ripen early"]


def test_ingest_stores_hashed_vectors_and_simhashes_without_a_model(brain):
    stored = brain.store_records("rss:a", [record("1", "Lithium battery recycling plant opens")])
    vectors = brain.store.vectors_of([stored[0].item_id], HASHED)
    assert cosine(unpacked(vectors[stored[0].item_id]), hashed_vector("Lithium battery recycling plant opens")) > 0.999
    assert len(stored[0].extra[SIMHASH_KEY]) == 16
    brain.store_records("rss:a", [record("1", "Lithium battery recycling plant opens")])
    assert len(brain.store.vectors_by_kind(HASHED, 10)) == 1


def test_ingest_uses_the_embedding_model_and_falls_back_to_hashed_when_it_fails(embedding_brain, services):
    first = embedding_brain.store_records("rss:a", [record("1", "Red car for sale")])[0]
    assert set(embedding_brain.store.vectors_of([first.item_id], "model:fake-embed")) == {first.item_id}
    services.embeddings_down = True
    second = embedding_brain.store_records("rss:a", [record("2", "Blue bike for sale")])[0]
    assert set(embedding_brain.store.vectors_of([second.item_id], HASHED)) == {second.item_id}
    assert embedding_brain.store.vectors_of([second.item_id], "model:fake-embed") == {}


def test_search_finds_by_words_and_with_a_model_by_meaning(embedding_brain, services):
    client = TestClient(create_app(embedding_brain, TOKEN), headers={"x-moi-token": TOKEN})
    embedding_brain.store_records("rss:a", [record("1", "Used automobile prices are falling"), record("2", "Garden tomatoes ripen early"), record("3", "Car insurance costs rise")])
    hits = client.get("/search", params={"q": "car"}).json()
    titles = [hit["item"]["title"] for hit in hits]
    assert titles[0] == "Car insurance costs rise"
    assert "Used automobile prices are falling" in titles and "Garden tomatoes ripen early" not in titles
    scores = [hit["score"] for hit in hits]
    assert scores == sorted(scores, reverse=True)
    assert len(client.get("/search", params={"q": "car", "limit": 1}).json()) == 1
    assert client.get("/search", params={"q": "zebra"}).json() == []
    assert client.get("/search").status_code == 422


def test_search_without_a_model_finds_words_only(client, brain):
    brain.store_records("rss:a", [record("1", "Used automobile prices are falling"), record("2", "Car insurance costs rise"), record("3", "Car prices and car loans")])
    titles = [hit["item"]["title"] for hit in client.get("/search", params={"q": "car prices", "limit": 500}).json()]
    assert titles[0] == "Car prices and car loans"
    assert "Used automobile prices are falling" in titles
    assert client.get("/search", params={"q": "  "}).json() == []


def test_retitled_copies_join_by_simhash_and_paraphrases_by_vectors():
    wire, copy = item("rss:wire", "1", "Storm closes Bay Bridge overnight", BODY), item("page:hn", "2", "Commuters face closures after winds", BODY)
    assert story_key(assign_clusters([copy], [assign_clusters([wire], [])[0]])[0]) == wire.item_id
    # A copy sharing no title word is found through its simhash band, which items stored before simhashes lack.
    assert CLUSTER_KEY not in assign_clusters([copy], [wire])[0].extra
    sharing_words = item("page:hn", "5", "Bay Bridge shut as storm hits", BODY)
    assert story_key(assign_clusters([sharing_words], [wire])[0]) == wire.item_id
    first, second = item("rss:wire", "3", "Automobile maker recalls two million vehicles over brakes"), item("page:hn", "4", "Car maker recalls two million cars over brakes")
    assert CLUSTER_KEY not in assign_clusters([second], [first])[0].extra
    alike = {first.item_id: [1.0, 0.0], second.item_id: [0.9, 0.43589]}
    assert story_key(assign_clusters([second], [first], alike)[0]) == first.item_id
    unlike = {first.item_id: [1.0, 0.0], second.item_id: [0.8, 0.6]}
    assert CLUSTER_KEY not in assign_clusters([second], [first], unlike)[0].extra


def test_numbers_and_sources_still_keep_stories_apart_whatever_the_vectors():
    fifteen, sixteen = item("rss:a", "1", "Apple announces iPhone 15 with a bigger camera", BODY), item("rss:b", "2", "Apple announces iPhone 16 with a bigger camera", BODY)
    same = {fifteen.item_id: [1.0], sixteen.item_id: [1.0]}
    assert CLUSTER_KEY not in assign_clusters([sixteen], [fifteen], same)[0].extra
    one, other = item("page:feed", "3", "Endless post at a birthday party", BODY), item("page:feed", "4", "Another post at a birthday party", BODY)
    assert CLUSTER_KEY not in assign_clusters([other], [one], {one.item_id: [1.0], other.item_id: [1.0]})[0].extra


def test_a_shortened_headline_joins_its_story_but_short_titles_do_not():
    long, short = item("rss:a", "1", "Python 3.15 released with faster startup and a new JIT"), item("page:hn", "2", "Python 3.15 released")
    assert story_key(assign_clusters([short], [long])[0]) == long.item_id
    assert CLUSTER_KEY not in assign_clusters([item("page:hn", "3", "Python released")], [long])[0].extra


def test_labeled_stories_from_three_sources_cluster_together(tmp_path, services, settings):
    """The L2 exit: the same story from three sources lands in one cluster in at least 90% of labeled cases, with no
    story merged into another."""
    labeled = LabeledStories.model_validate_json(LABELED.read_text())
    hashed = evaluate_clusters(labeled, gateway_with(tmp_path, settings), NOW)
    assert hashed.kind == HASHED and hashed.stories == 20 and hashed.rate >= 0.9 and hashed.false_merges == 0
    with_model = evaluate_clusters(labeled, gateway_with(tmp_path, settings.model_copy(update={"embed": embed_slot(services)})), NOW)
    assert with_model.kind == "model:fake-embed" and with_model.rate == 1.0 and with_model.false_merges == 0


def test_the_cluster_check_runs_from_the_command_line(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("MOI_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("MOI_ASSETS_DIR", str(tmp_path))
    assert main(["evaluate", str(LABELED)]) == 0
    score = json.loads(capsys.readouterr().out)
    assert score["stories"] == 20 and score["rate"] >= 0.9
    assert main([]) == 2


def test_chat_sees_older_journal_lines_that_match_and_old_months_roll_up(brain, services):
    journal = brain.paths.journal
    (journal / "20260310.md").write_text("# 20260310\n\n* 09:00 note: Lithium recycling: plants scale up. (https://news.example/lithium)\n* 10:00 opened: Cats (https://cats.example/1)\n")
    brain.propose_edit("feed", "what was that piece on lithium?", None)
    sent = json.loads(services.model_calls("edit")[-1]["payload"]["messages"][1]["content"])
    assert sent["older_journal"] == ["* 09:00 note: Lithium recycling: plants scale up. (https://news.example/lithium)"]
    assert brain.roll_up_journal() == ["2026-03.summary.md"]
    assert not (journal / "20260310.md").exists()
    brain.propose_edit("feed", "lithium again", None)
    sent = json.loads(services.model_calls("edit")[-1]["payload"]["messages"][1]["content"])
    assert sent["older_journal"] == ["* 09:00 note: Lithium recycling: plants scale up. (https://news.example/lithium)"]


def test_the_journal_keeps_its_recent_two_weeks_as_day_files(paths, settings, services):
    early_month = Brain(paths, settings, youtube_base=services.base_url, clock=FixedClock(datetime(2026, 11, 3, 12, 0, tzinfo=UTC)))
    (paths.journal / "20261025.md").write_text("# 20261025\n\n* 09:00 opened: Recent (https://recent.example/1)\n")
    (paths.journal / "20260910.md").write_text("# 20260910\n\n* 09:00 opened: Older (https://older.example/1)\n")
    assert early_month.roll_up_journal() == ["2026-09.summary.md"]
    assert (paths.journal / "20261025.md").exists()
    assert "Recent" in " ".join(early_month.memory.journal_lines(early_month.clock()))
    early_month.http.close()


def test_a_story_never_holds_two_items_of_one_source_even_through_a_chain():
    first = item("rss:a", "1", "Apple announces iPhone event date for September launch")
    other = item("rss:b", "2", "Apple announces iPhone event date for the September launch")
    later = item("rss:a", "3", "Apple iPhone launch: what to expect from the September event")
    placed = assign_clusters([first, other, later], [])
    assert story_key(placed[1]) == first.item_id
    assert story_key(placed[2]) == later.item_id
    stored_first, stored_other = assign_clusters([first, other], [])
    assert story_key(assign_clusters([later], [stored_first, stored_other])[0]) == later.item_id
    third_source = item("x", "4", "Apple announces iPhone event date for September launch")
    assert story_key(assign_clusters([third_source], [stored_first, stored_other])[0]) == first.item_id
    # Once you saw the story, the outlet's follow up joins it, for the update pass to judge.
    assert story_key(assign_clusters([later], [stored_first, stored_other], seen={stored_other.item_id})[0]) == first.item_id


def test_one_link_from_two_sources_is_one_hit(client, brain):
    shared = {"native_id": "1", "url": "https://news.example/story", "title": "Lithium recycling scales up", "published_at": NOW.isoformat()}
    brain.store_records("rss:a", [shared])
    brain.store_records("rss:b", [{**shared, "native_id": "9"}])
    hits = client.get("/search", params={"q": "lithium"}).json()
    assert [hit["item"]["url"] for hit in hits] == ["https://news.example/story"]
