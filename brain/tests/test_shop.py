"""Shop: your words searched in each store a view names, products ranked like items, and prices you saw kept."""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient
from helpers import FixedClock

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.items import normalize
from moi_brain.shop import Price, parse_price, price_note, product_key, search_urls, shop_source_id
from moi_brain.store import Store

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
STORE = "https://shop.example/search?q={query}"


@pytest.mark.parametrize(
    ("text", "price"),
    [
        ("$24.99", Price(amount=24.99, symbol="$")),
        ("Now $1,299.00, was $1,499", Price(amount=1299.0, symbol="$")),
        ("€ 39", Price(amount=39.0, symbol="€")),
        ("52.10 GBP", Price(amount=52.1, symbol="£")),
        ("₹2,499", Price(amount=2499.0, symbol="₹")),
        ("free shipping", None),
        ("", None),
    ],
)
def test_prices_are_read_from_store_text(text, price):
    assert parse_price(text) == price


def test_search_addresses_and_product_keys():
    assert search_urls(["https://www.amazon.com/s?k={query}", STORE], "desk lamp & shade") == [
        "https://www.amazon.com/s?k=desk+lamp+%26+shade",
        "https://shop.example/search?q=desk+lamp+%26+shade",
    ]
    assert search_urls([STORE], "   ") == []
    amazon = normalize("page:a", {"native_id": "1", "url": "https://www.amazon.com/Lamp-Thing/dp/B0001ABCDE/ref=sr_1?x=1", "title": "Lamp"}, NOW)
    other = normalize("page:b", {"native_id": "2", "url": "https://Shop.example/p/lamp?utm=1#top", "title": "Lamp"}, NOW)
    assert product_key(amazon) == "asin:B0001ABCDE" and product_key(other) == "shop.example/p/lamp"
    assert shop_source_id("https://www.shop.example/search/?q=desk+lamp") == "shop:shop.example/search?q=desk+lamp"


def test_a_price_note_needs_prices_from_more_than_one_day():
    day = timedelta(days=1)
    assert price_note(Price(amount=30, symbol="$"), [(30.0, NOW)]) == ""
    history = [(39.0, NOW - 3 * day), (24.99, NOW - 2 * day), (30.0, NOW)]
    assert price_note(Price(amount=30, symbol="$"), history) == "Lowest you saw: $24.99 on Nov 10"
    assert price_note(Price(amount=24.0, symbol="$"), history) == "The lowest you have seen since Nov 9"


def test_the_store_keeps_one_price_a_day_unless_it_changes(tmp_path):
    store = Store(tmp_path / "moi.db")
    assert store.record_prices([("asin:B1", 24.99, "$"), ("asin:B2", 10.0, "$")], NOW) == 2
    assert store.record_prices([("asin:B1", 24.99, "$")], NOW + timedelta(hours=2)) == 0
    assert store.record_prices([("asin:B1", 22.0, "$")], NOW + timedelta(hours=3)) == 1
    assert store.record_prices([("asin:B1", 22.0, "$")], NOW + timedelta(days=1)) == 1
    history = store.price_history(["asin:B1", "asin:none"])
    assert [amount for amount, _ in history["asin:B1"]] == [24.99, 22.0, 22.0] and "asin:none" not in history
    assert store.price_history([]) == {}


def make_client(paths, settings, services, clock):
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    return brain, TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})


def product(native_id: str, title: str, price: str) -> dict:
    return {"native_id": native_id, "url": f"https://shop.example/p/{native_id}", "title": title, "extra.price_text": price}


def test_shopping_makes_a_shop_view_reads_its_stores_and_notes_prices(paths, settings, services):
    clock = FixedClock(NOW)
    brain, client = make_client(paths, settings, services, clock)
    started = client.post("/shop", json={"query": "  desk   lamp "}).json()
    assert started == {"view_id": "shop", "query": "desk lamp", "created": True}
    assert "* Shop: amazon" in (paths.views / "shop.md").read_text()
    (paths.views / "shop.md").write_text(f"# Shop\n\n## Sources\n* Shop: {STORE}\n")
    sources = client.post("/refresh", json={"view_id": "shop"}).json()["page_sources"]
    assert [source["start_url"] for source in sources] == ["https://shop.example/search?q=desk+lamp"]
    source_id = sources[0]["source_id"]
    client.post("/ingest", json={"source_id": source_id, "page_url": sources[0]["start_url"], "records": [product("b", "Banker's lamp", "$52.10"), product("a", "LED desk lamp", "$24.99")]})
    page = client.post("/view/shop", json={}).json()
    assert [entry["item"]["title"] for entry in page["items"]] == ["Banker's lamp", "LED desk lamp"]
    assert all("price_note" not in entry["item"]["extra"] for entry in page["items"])
    clock.moment += timedelta(days=2)
    client.post("/ingest", json={"source_id": source_id, "page_url": sources[0]["start_url"], "records": [product("b", "Banker's lamp", "$48.00"), product("a", "LED desk lamp", "$29.99")]})
    notes = {entry["item"]["title"]: entry["item"]["extra"].get("price_note") for entry in client.post("/view/shop", json={}).json()["items"]}
    assert notes == {"Banker's lamp": "The lowest you have seen since Nov 12", "LED desk lamp": "Lowest you saw: $24.99 on Nov 12"}
    again = client.post("/shop", json={"query": "lamp shade", "view_id": "feed"}).json()
    assert again == {"view_id": "shop", "query": "lamp shade", "created": False}
    assert client.post("/view/shop", json={}).json()["items"] == []
    assert client.post("/shop", json={"query": "   "}).status_code == 400
    brain.http.close()


def test_intent_templates_start_watch_and_read_views(client, paths):
    client.post("/views", json={"view_id": "watch"})
    assert "* Collection: watch later" in (paths.views / "watch.md").read_text()
    client.post("/views", json={"view_id": "notes", "title": "Notes"})
    assert (paths.views / "notes.md").read_text().startswith("# Notes\n\n## Sources\n\n")
