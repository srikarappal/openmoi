"""Site policy: how each site may be read, assist pages, daily caps and sites turned off."""

import pytest
from conftest import wait_until_refreshed

from moi_brain.compile import parse_sources
from moi_brain.config import REPO_DIR, Paths
from moi_brain.policy import DEFAULT_POLICY, PolicyFile, SitePolicy, load_policy, policy_for

POLICY = PolicyFile(sites={"facebook.com": SitePolicy(mode="assist", daily_steps=60), "x.com": SitePolicy(daily_steps=200), "tiktok.com": SitePolicy(status="removed")})


@pytest.mark.parametrize(
    ("url", "site"),
    [
        ("https://www.facebook.com/events", "facebook.com"),
        ("https://m.facebook.com/events", "facebook.com"),
        ("https://business.facebook.com/x", "facebook.com"),
        ("https://twitter.com/home", "x.com"),
        ("https://www.tiktok.com/foryou", "tiktok.com"),
    ],
)
def test_a_site_and_its_subdomains_share_a_policy(url, site):
    assert policy_for(POLICY, url) == POLICY.sites[site]


def test_an_unknown_site_is_read_by_a_reader_tab_with_the_usual_cap():
    assert policy_for(POLICY, "https://news.example/") == DEFAULT_POLICY == SitePolicy(status="active", mode="pilot", daily_steps=200)


def test_the_built_in_policy_reads_facebook_only_while_you_browse_it(tmp_path):
    shipped = load_policy(Paths(home=tmp_path, assets=REPO_DIR).site_policy)
    assert policy_for(shipped, "https://www.facebook.com/").mode == "assist"
    assert policy_for(shipped, "https://www.instagram.com/").daily_steps == 60
    (tmp_path / "bad.json").write_text('{"sites": {"a.com": {"mode": "fast"}}}')
    assert load_policy(tmp_path / "bad.json") == PolicyFile()
    assert load_policy(tmp_path / "missing.json") == PolicyFile()


def test_a_page_line_chooses_assist_or_pilot():
    [source], _ = parse_sources("* Page: https://www.facebook.com/events (pilot)\n* Page: https://news.example/ (assist)\n* Page: https://other.example/", [])
    assert source.modes == {"https://www.facebook.com/events": "pilot", "https://news.example/": "assist"}


def friends_view(paths) -> None:
    sources = "\n".join(
        [
            "* X home timeline",
            "* Page: https://www.facebook.com/events",
            "* Page: https://www.facebook.com/groups/42 (pilot)",
            "* Page: https://www.tiktok.com/foryou",
            "* Watch: https://www.tiktok.com/@a",
            "* Following: https://www.tiktok.com/@me/following",
            "* Page: https://news.example/",
        ]
    )
    (paths.views / "friends.md").write_text(f"# Friends\n\n## Sources\n{sources}\n")


def test_page_sources_follow_the_site_policy(client, paths):
    client.app.state.brain.policies = POLICY
    friends_view(paths)
    sources = {source["start_url"]: source for source in client.post("/refresh", json={"view_id": "friends"}).json()["page_sources"]}
    assert sorted(sources) == ["https://news.example/", "https://www.facebook.com/events", "https://www.facebook.com/groups/42", "https://x.com/home"]
    assert sources["https://www.facebook.com/events"]["mode"] == "assist"
    assert sources["https://www.facebook.com/events"]["budget"]["daily_steps"] == 60
    assert sources["https://www.facebook.com/groups/42"]["mode"] == "pilot"
    assert (sources["https://news.example/"]["mode"], sources["https://news.example/"]["budget"]["daily_steps"]) == ("pilot", 200)
    assert client.get("/watches/due").json() == []
    page = wait_until_refreshed(client, "friends")
    assert "tiktok.com is removed by the site policy, so openMoi does not read it." in page["warnings"]


def test_x_itself_can_be_turned_off(client):
    client.app.state.brain.policies = PolicyFile(sites={"x.com": SitePolicy(status="paused")})
    assert [source["source_id"] for source in client.post("/refresh", json={"view_id": "feed"}).json()["page_sources"]] == []
    assert "x.com is paused by the site policy, so openMoi does not read it." in wait_until_refreshed(client)["warnings"]


def test_summaries_notes_watches_and_following_lists_keep_to_the_site_policy(client, paths):
    client.app.state.brain.policies = POLICY
    (paths.views / "fb.md").write_text(
        "# FB\n\n## Sources\n* Page: https://www.facebook.com/events\n* Watch: https://www.facebook.com/events/42\n"
        "* Following: https://www.facebook.com/me/friends\n* RSS: https://news.example/rss\n\n## Rules\n* Summarize everything.\n* Take notes on what I open.\n"
    )
    records = [{"native_id": "p1", "url": "https://www.facebook.com/maya/posts/1", "text": "Party"}]
    [fb_item] = [item["item_id"] for item in client.post("/ingest", json={"source_id": "page:facebook.com/events", "records": records}).json()["items"]]
    [news_item] = [item["item_id"] for item in client.post("/ingest", json={"source_id": "rss:news", "records": [{"native_id": "n1", "url": "https://news.example/1", "title": "News"}]}).json()["items"]]
    assert [entry["item_id"] for entry in client.get("/content/wanted").json()] == [news_item]
    opened = client.post("/events", json={"events": [{"view_id": "fb", "item_id": fb_item, "event_kind": "open"}, {"view_id": "fb", "item_id": news_item, "event_kind": "open"}]}).json()
    assert opened["notes"] == [news_item]
    sources = {source["purpose"]: source for source in client.post("/refresh", json={"view_id": "fb"}).json()["page_sources"]}
    assert (sources["watch"]["mode"], sources["watch"]["budget"]["daily_steps"]) == ("assist", 60)
    assert (sources["follows"]["mode"], sources["follows"]["budget"]["daily_steps"]) == ("assist", 60)
