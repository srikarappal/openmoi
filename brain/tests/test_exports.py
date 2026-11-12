"""Data exports: your own Facebook posts and events and Amazon orders, read from the files the sites give you."""

import json
from datetime import UTC, datetime, timedelta

from moi_brain.exports import amazon_orders, facebook_events, facebook_posts, fixed_text, iso_time, read_export

POSTS = [
    {"timestamp": 1700000000, "data": [{"post": "CafÃ© opening tonight"}], "title": "Maya Kumar updated her status."},
    {"timestamp": 1700000500, "data": [{"post": "Read this"}], "attachments": [{"data": [{"external_context": {"url": "https://news.example/a"}}]}]},
    {"timestamp": 1700001000, "data": [{"update_timestamp": 1}], "title": ""},
    "junk",
]
EVENTS = {"your_events": [{"name": "Garden party", "start_timestamp": 1700100000, "place": {"name": "City Park"}}, {"name": "No place", "start_timestamp": "bad"}, {"place": {}}, 7]}
ORDERS = '"Order ID","Order Date","Currency","Unit Price","ASIN","Product Name"\n"111-1","2026-10-01T10:00:00Z","USD","24.99","B0CX1LAMP","Desk Lamp"\n"111-2","2026-10-02T10:00:00Z","","","B0NOPRICE","Cable"\n"111-3","2026-10-03","USD","5","","No asin"\n'


def test_facebook_mojibake_is_undone_and_correct_text_left_alone():
    assert fixed_text("CafÃ©") == "Café"
    assert fixed_text("Café ☕") == "Café ☕"
    assert fixed_text(None) == ""


def test_facebook_posts_become_records_with_a_link_when_they_shared_one():
    records = facebook_posts(POSTS)
    assert [record["text"] for record in records] == ["Café opening tonight", "Read this"]
    assert records[0]["title"] == "Maya Kumar updated her status." and records[0]["published_at"] == "2023-11-14T22:13:20+00:00"
    assert records[0]["url"].startswith("https://www.facebook.com/me/allactivity?moi_post=")
    assert records[1]["url"] == "https://news.example/a" and records[1]["title"] is None
    assert facebook_posts({"not": "a list"}) == []


def test_facebook_events_become_records():
    records = facebook_events(EVENTS)
    assert [(record["title"], record["text"]) for record in records] == [("Garden party", "At City Park"), ("No place", None)]
    assert records[0]["url"] == "https://www.facebook.com/events/search/?q=Garden%20party&start=1700100000"
    assert records[1]["published_at"] is None
    assert facebook_events("nothing") == []


def test_amazon_orders_become_product_records():
    records = amazon_orders(ORDERS)
    assert records == [
        {"native_id": "111-1:B0CX1LAMP", "url": "https://www.amazon.com/gp/your-account/order-details?orderID=111-1&asin=B0CX1LAMP", "title": "Desk Lamp", "published_at": "2026-10-01T10:00:00Z", "kind": "product", "extra.price_text": "USD 24.99"},
        {"native_id": "111-2:B0NOPRICE", "url": "https://www.amazon.com/gp/your-account/order-details?orderID=111-2&asin=B0NOPRICE", "title": "Cable", "published_at": "2026-10-02T10:00:00Z", "kind": "product"},
    ]


def test_a_dropped_file_is_recognized_by_its_name_and_shape():
    assert read_export("your_posts_1.json", json.dumps(POSTS))[0] == "facebook_posts"
    assert read_export("your_events.json", json.dumps(EVENTS))[0] == "facebook_events"
    assert read_export("Retail.OrderHistory.1.csv", ORDERS)[0] == "amazon_orders"
    assert read_export("notes.json", "{}") is None
    assert read_export("your_posts_1.json", "{broken") is None
    assert read_export("photo.png", "x") is None
    assert iso_time(None) is None and iso_time(10**20) is None


def test_a_dropped_export_fills_a_history_source_a_view_can_list(client, paths):
    (paths.views / "past.md").write_text("# Past\n\n## Sources\n* History: facebook and amazon\n* History: myspace\n")
    answer = client.post("/history", json={"name": "your_posts_1.json", "text": json.dumps(POSTS)}).json()
    assert answer == {"source_id": "history:facebook", "stored": 2}
    assert client.post("/history", json={"name": "Retail.OrderHistory.1.csv", "text": ORDERS}).json() == {"source_id": "history:amazon", "stored": 2}
    page = client.post("/view/past", json={"limit": 30}).json()
    assert sorted({entry["item"]["source_id"] for entry in page["items"]}) == ["history:amazon", "history:facebook"]
    assert "No history openMoi knows in: History: myspace (facebook or amazon)" in page["warnings"]
    assert client.app.state.brain.compiler.compiled("past").summary.startswith("Reading your facebook and amazon history.")
    refused = client.post("/history", json={"name": "notes.txt", "text": "x"})
    assert refused.status_code == 400 and "not a data export" in refused.json()["detail"]


def test_your_history_never_expires(client):
    client.post("/history", json={"name": "your_posts_1.json", "text": json.dumps(POSTS)})
    store = client.app.state.brain.store
    later = datetime.now(UTC) + timedelta(days=90)
    assert store.expire(later) == 0
    assert store.stats()["items"] == {"history:facebook": 2}


def test_odd_attachments_are_skipped():
    post = {"timestamp": 1, "data": [{"post": "Look"}], "attachments": ["junk", {"data": ["x", {"external_context": {"url": "ftp://old"}}, {"external_context": {"url": "https://ok.example"}}]}]}
    assert facebook_posts([post])[0]["url"] == "https://ok.example"


def test_repeat_orders_and_same_name_events_are_each_kept_and_counted_honestly(client):
    orders = '"Order ID","Order Date","ASIN","Product Name"\n"1","2026-09-01","B0COFFEE","Coffee"\n"2","2026-10-01","B0COFFEE","Coffee"\n"3","2026-11-01","B0COFFEE","Coffee"\n'
    assert client.post("/history", json={"name": "Retail.OrderHistory.1.csv", "text": orders}).json() == {"source_id": "history:amazon", "stored": 3}
    events = {"event_responses_v2": {"events_joined": [{"name": "Book club", "start_timestamp": 1700000000}, {"name": "Book club", "start_timestamp": 1700600000}], "events_declined": [{"name": "Gala", "start_timestamp": 1}]}}
    assert client.post("/history", json={"name": "your_event_responses.json", "text": json.dumps(events)}).json() == {"source_id": "history:facebook", "stored": 3}
    assert client.app.state.brain.store.stats()["items"] == {"history:amazon": 3, "history:facebook": 3}
    assert facebook_posts([{"timestamp": 1, "data": None, "title": "Shared a memory"}])[0]["title"] == "Shared a memory"
