"""Google sign in through the system browser with a loopback redirect and PKCE, then YouTube subscriptions."""

import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.google import GoogleAccount, GoogleError, challenge_for


class FakeGoogle:
    """Google's token endpoint and YouTube API: codes, refreshes and two pages of subscriptions."""

    def __init__(self):
        self.token_calls: list[dict[str, str]] = []
        self.refuse = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            fields = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
            self.token_calls.append(fields)
            if self.refuse:
                return httpx.Response(400, json={"error": "invalid_grant"})
            refresh = {"refresh_token": "refresh-1"} if fields["grant_type"] == "authorization_code" else {}
            return httpx.Response(200, json={"access_token": f"access-{len(self.token_calls)}", "expires_in": 3600, **refresh})
        if request.url.path == "/youtube/v3/subscriptions":
            if request.headers["authorization"] != "Bearer access-1":
                return httpx.Response(401)
            if request.url.params.get("pageToken") == "two":
                return httpx.Response(200, json={"items": [{"snippet": {"resourceId": {"channelId": "UCb"}}}, {"snippet": {}}]})
            return httpx.Response(200, json={"items": [{"snippet": {"resourceId": {"channelId": "UCa"}}}, {"snippet": {"resourceId": {"channelId": "UCb"}}}], "nextPageToken": "two"})
        return httpx.Response(404)


@pytest.fixture
def google(tmp_path, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-1")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret-1")
    fake = FakeGoogle()
    http = httpx.Client(transport=httpx.MockTransport(fake))
    account = GoogleAccount(tmp_path / "google.json", http, auth_url="https://accounts.example/auth", token_url="https://accounts.example/token", api_base="https://api.example")
    yield account, fake, tmp_path
    http.close()


def browser_returns(auth_url: str, **override: str) -> dict[str, list[str]]:
    """What your browser does after you sign in: Google sends it back to openMoi's loopback address."""
    query = parse_qs(urlparse(auth_url).query)
    params = {"state": query["state"][0], "code": "code-1", **override}
    httpx.get(query["redirect_uri"][0], params=params, timeout=5)
    return query


def wait_for(account: GoogleAccount, status: str) -> None:
    deadline = time.monotonic() + 5
    while not account.status.startswith(status) and time.monotonic() < deadline:
        time.sleep(0.01)


def test_signing_in_through_the_browser_with_pkce_keeps_tokens_private(google):
    account, fake, tmp_path = google
    auth_url = account.start()
    query = browser_returns(auth_url)
    wait_for(account, "connected")
    assert account.status == "connected" and account.connected
    assert query["code_challenge_method"] == ["S256"] and query["scope"] == ["https://www.googleapis.com/auth/youtube.readonly"]
    assert urlparse(query["redirect_uri"][0]).hostname == "127.0.0.1"
    [exchange] = fake.token_calls
    assert challenge_for(exchange["code_verifier"]) == query["code_challenge"][0]
    assert (exchange["client_id"], exchange["client_secret"], exchange["code"]) == ("client-1", "secret-1", "code-1")
    assert oct((tmp_path / "google.json").stat().st_mode)[-3:] == "600"
    assert account.youtube_subscriptions() == ["UCa", "UCb"]


def test_a_redirect_from_someone_else_or_a_refusal_never_connects(google):
    account, fake, _ = google
    browser_returns(account.start(), state="forged")
    wait_for(account, "not connected")
    assert account.status == "not connected: the redirect did not match this sign in" and not account.connected
    browser_returns(account.start(), code="", error="access_denied")
    wait_for(account, "not connected")
    assert account.status == "not connected: access_denied"
    fake.refuse = True
    browser_returns(account.start())
    wait_for(account, "not connected")
    assert account.status.startswith("not connected: Google refused the sign in")


def test_an_expired_token_is_refreshed_and_missing_setup_is_explained(google, monkeypatch):
    account, fake, tmp_path = google
    with pytest.raises(GoogleError, match="not connected"):
        account.access_token()
    account.save({"access_token": "old", "refresh_token": "refresh-1", "expires_in": 0})
    assert account.access_token() == "access-1"
    assert fake.token_calls[-1] == {"client_id": "client-1", "client_secret": "secret-1", "grant_type": "refresh_token", "refresh_token": "refresh-1"}
    assert account.access_token() == "access-1"
    account.save({"access_token": "bad", "expires_in": 3600})
    with pytest.raises(GoogleError, match="did not list"):
        account.youtube_subscriptions()
    monkeypatch.delenv("GOOGLE_CLIENT_ID")
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET")
    with pytest.raises(GoogleError, match="GOOGLE_CLIENT_ID"):
        account.start()


class EndlessPages(FakeGoogle):
    """A YouTube API that always says there is another page."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/youtube/v3/subscriptions":
            return httpx.Response(200, json={"items": [{"snippet": {"resourceId": {"channelId": "UCa"}}}], "nextPageToken": "more"})
        return super().__call__(request)


def test_paging_stops_at_twenty_pages_and_a_public_client_needs_no_secret(google, monkeypatch, tmp_path):
    account, _, _ = google
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET")
    endless = EndlessPages()
    with httpx.Client(transport=httpx.MockTransport(endless)) as http:
        other = GoogleAccount(tmp_path / "other.json", http, token_url="https://accounts.example/token", api_base="https://api.example")
        other.save({"access_token": "old", "refresh_token": "r", "expires_in": 0})
        assert other.youtube_subscriptions() == ["UCa"]
        assert "client_secret" not in endless.token_calls[0]


def test_your_google_subscriptions_feed_youtube_subscriptions_and_refresh_daily(paths, settings, services, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-1")
    fake = FakeGoogle()
    http = httpx.Client(transport=httpx.MockTransport(fake))
    brain = Brain(paths, settings, http=http, youtube_base=services.base_url)
    brain.google = GoogleAccount(paths.google_tokens, http, token_url="https://accounts.example/token", api_base="https://api.example")
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    try:
        assert client.get("/google/status").json() == {"connected": False, "status": "not connected", "client": True}
        assert client.post("/google/connect").json()["auth_url"].startswith("https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1")
        brain.google.save({"access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600})
        (paths.views / "yt.md").write_text("# YT\n\n## Sources\n* YouTube: subscriptions\n")
        brain.refresh_subscriptions()
        assert brain.subscriptions() == ["UCa", "UCb"]
        assert brain.compiler.compiled("yt").source_ids() == ["youtube:uca", "youtube:ucb"]
        brain.google.save({"access_token": "bad", "expires_in": 3600})
        brain.refresh_subscriptions()
        assert brain.status_by_source()["youtube"] == "ok"
        paths.google_subscriptions.write_text('{"at": "bad", "channels": ["UCa"]}')
        brain.refresh_subscriptions()
        assert brain.status_by_source()["youtube"].startswith("YouTube did not list")
        assert brain.subscriptions() == ["UCa"]
        monkeypatch.delenv("GOOGLE_CLIENT_ID")
        refused = client.post("/google/connect")
        assert refused.status_code == 400 and "GOOGLE_CLIENT_ID" in refused.json()["detail"]
    finally:
        http.close()
