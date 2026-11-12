"""Integration for M3: generated lenses, generated extractors and Mine pages ranked by site views."""

import json

from conftest import wait_until_refreshed

SHOP_RECORDS = [
    {"native_id": "B0001", "url": "/dp/B0001", "title": "Dimmable LED desk lamp with USB port", "extra.price_text": "$24.99"},
    {"native_id": "B0002", "url": "/dp/B0002", "title": "Architect clamp lamp, matte black"},
    {"native_id": "B0003", "url": "/dp/B0003", "title": "Election year mug"},
]


def set_layout(paths, layout: str) -> None:
    view = paths.views / "feed.md"
    view.write_text(view.read_text().replace("## Layout\n", f"## Layout\n{layout}\n"))


def test_layout_makes_the_lens_stale_until_a_generated_lens_is_accepted(client, paths, services):
    assert client.post("/view/feed", json={}).json()["lens_stale"] is False
    client.post("/refresh", json={"view_id": "feed"})
    wait_until_refreshed(client)
    set_layout(paths, "Two column magazine, big images.")
    assert client.post("/view/feed", json={}).json()["lens_stale"] is True
    html = client.post("/lens/generate", json={"view_id": "feed"}).json()["html"]
    assert html.startswith("<!doctype html>")
    assert "Look: Two column magazine, big images." in html
    assert services.model_calls("lens") == []
    [call] = services.model_calls("lens_patch")
    prompt = call["payload"]["messages"][1]["content"]
    assert "New laptop chip" not in prompt
    assert json.loads(prompt)["layout"] == "Two column magazine, big images."
    assert client.post("/lens/accept", json={"view_id": "feed", "html": html}).json() == {"version": 1}
    assert client.get("/lens/feed").text == html
    assert client.post("/view/feed", json={}).json()["lens_stale"] is False
    assert client.get("/debug").json()["llm_calls"][-1]["contained_user_content"] is False


def test_retry_passes_the_last_error_to_the_model(client, paths, services):
    set_layout(paths, "FIXABLE cards")
    broken = client.post("/lens/generate", json={"view_id": "feed"}).json()["html"]
    assert "Look:" not in broken
    fixed = client.post("/lens/generate", json={"view_id": "feed", "last_error": "0 of 30 items rendered"}).json()["html"]
    assert "Look: FIXABLE cards" in fixed
    assert json.loads(services.model_calls("lens_patch")[-1]["payload"]["messages"][1]["content"])["last_error"] == "0 of 30 items rendered"


def test_a_layout_the_patch_cannot_reach_is_written_whole(client, paths, services):
    for layout in ("REWRITE as a grid", "BADPATCH as a grid"):
        set_layout(paths, layout)
        html = client.post("/lens/generate", json={"view_id": "feed"}).json()["html"]
        assert f"Look: {layout}" in html
    assert len(services.model_calls("lens_patch")) == 2 and len(services.model_calls("lens")) == 2


def test_rollback_after_a_generated_lens_returns_to_the_default(client, paths):
    set_layout(paths, "Compact list.")
    html = client.post("/lens/generate", json={"view_id": "feed"}).json()["html"]
    client.post("/lens/accept", json={"view_id": "feed", "html": html})
    proposal = client.post("/edit", json={"view_id": "feed", "text": "bring back the previous look"}).json()
    client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    assert "Look:" not in client.get("/lens/feed").text
    assert client.post("/view/feed", json={}).json()["lens_stale"] is False


def test_extractor_lookup_generate_and_accept(client, services):
    url = f"{services.base_url}/pages/shop.html?k=desk+lamp"
    assert client.get("/extractor", params={"url": url}).json() == {"spec": None}
    spec = client.post("/extractor/generate", json={"url": url, "skeleton": '<div data-component-type="s-search-result">{t:12}</div>'}).json()["spec"]
    assert spec["domain"] == "127.0.0.1"
    assert spec["path_pattern"] == "/pages/shop.html*"
    assert spec["item_root"] == "[data-component-type='s-search-result']"
    assert client.get("/extractor", params={"url": url}).json() == {"spec": None}
    saved = client.post("/extractor/accept", json=spec).json()["spec"]
    assert saved["version"] == 1
    assert client.get("/extractor", params={"url": url}).json()["spec"] == saved
    assert client.get("/extractor", params={"url": f"{services.base_url}/pages/listing.html"}).json() == {"spec": None}
    again = client.post("/extractor/accept", json=spec).json()["spec"]
    assert again["version"] == 2


def test_extractor_generation_failures_are_llm_errors(client, services):
    services.queue_model_reply("extractor", json.dumps({"item_root": "li", "fields": {"title": {"select": "a"}}}))
    failed = client.post("/extractor/generate", json={"url": "https://e.com/", "skeleton": "<ul></ul>"})
    assert failed.status_code == 502
    assert "no url field" in failed.json()["detail"]
    assert client.post("/extractor/generate", json={"url": "https://e.com/", "skeleton": ""}).status_code == 422


def test_mine_ingest_keeps_page_order_and_applies_site_rules(client, paths):
    body = {"source_id": "site:shop.example", "records": SHOP_RECORDS, "page_url": "https://shop.example/s?k=lamp", "view_id": "site_shop.example"}
    first = client.post("/ingest", json=body).json()
    assert [view_item["item"]["native_id"] for view_item in first["view_items"]] == ["B0001", "B0002", "B0003"]
    assert first["view_items"][0]["item"]["url"] == "https://shop.example/dp/B0001"
    assert first["view_items"][0]["item"]["extra"]["price_text"] == "$24.99"
    assert first["view_items"][0]["item"]["extra"]["ragebait"] == "0.0"
    assert first["lens_stale"] is False
    (paths.views / "site_shop.example.md").write_text("# shop.example\n\n## Rules\n* Hide politics.\n\n## Layout\nCompact table.\n")
    second = client.post("/ingest", json={**body, "kind": "listing"}).json()
    assert [view_item["item"]["native_id"] for view_item in second["view_items"]] == ["B0001", "B0002"]
    assert second["lens_stale"] is True
    assert [view["view_id"] for view in client.get("/views").json()] == ["feed"]


def test_mine_lenses_are_per_kind(client, paths):
    (paths.views / "site_shop.example.md").write_text("# shop.example\n\n## Layout\nCompact table.\n")
    html = client.post("/lens/generate", json={"view_id": "site_shop.example", "kind": "listing"}).json()["html"]
    assert 'data-kind="listing"' in html
    client.post("/lens/accept", json={"view_id": "site_shop.example", "kind": "listing", "html": html})
    assert client.get("/lens/site_shop.example", params={"kind": "listing"}).text == html
    assert "Look:" not in client.get("/lens/site_shop.example", params={"kind": "article"}).text


def test_chat_on_a_site_view_creates_its_file(client, paths):
    proposal = client.post("/edit", json={"view_id": "site_shop.example", "text": "make it a compact table"}).json()
    [change] = proposal["changes"]
    assert change["file"] == "views/site_shop.example.md"
    client.post("/edit/apply", json={"proposal_id": proposal["proposal_id"]})
    assert (paths.views / "site_shop.example.md").read_text() == "# shop.example\n\n## Layout\nmake it a compact table\n"


def test_a_lens_keeps_the_layout_it_was_made_for_when_the_layout_changed_before_it_was_accepted(client, paths):
    set_layout(paths, "Two columns.")
    made = client.post("/lens/generate", json={"view_id": "feed"}).json()
    set_layout(paths, "Three columns.")
    assert client.post("/lens/accept", json={"view_id": "feed", "html": made["html"], "layout_hash": made["layout_hash"]}).json() == {"version": 1}
    assert client.post("/view/feed", json={}).json()["lens_stale"] is True
    again = client.post("/lens/generate", json={"view_id": "feed"}).json()
    assert again["layout_hash"] != made["layout_hash"]
    client.post("/lens/accept", json={"view_id": "feed", "html": again["html"], "layout_hash": again["layout_hash"]})
    assert client.post("/view/feed", json={}).json()["lens_stale"] is False
    assert client.post("/lens/accept", json={"view_id": "feed", "html": "<p>x</p>", "layout_hash": "not a hash!"}).status_code == 422
