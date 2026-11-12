"""Google data through Google's own sign in, in your system browser (Google blocks embedded browsers): the loopback
redirect of RFC 8252 with PKCE. openMoi listens on 127.0.0.1 for exactly one redirect, checks its state, trades the
code for tokens and keeps them readable only by you. With a client id in .env (GOOGLE_CLIENT_ID, and
GOOGLE_CLIENT_SECRET for a desktop client), "YouTube: subscriptions" is read from the YouTube API instead of a
Takeout file."""

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from moi_brain.files import read_json, write_atomic

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API_BASE = "https://www.googleapis.com"
SCOPE = "https://www.googleapis.com/auth/youtube.readonly"
WAIT_SECONDS = 300
MAX_PAGES = 20
DONE_PAGE = b"<html><body><p>openMoi is connected to Google. You can close this tab.</p></body></html>"
FAILED_PAGE = b"<html><body><p>openMoi could not connect to Google. Close this tab and try again.</p></body></html>"


class GoogleError(RuntimeError):
    """No client id, no sign in yet, or Google said no."""


class Redirect(HTTPServer):
    """The one redirect Google sends back to 127.0.0.1, with what it carried."""

    expected_state = ""
    code: str | None = None
    error: str | None = None


class RedirectHandler(BaseHTTPRequestHandler):
    server: Redirect

    def log_message(self, format: str, *args: Any) -> None:
        return None

    def do_GET(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        state, code = query.get("state", [""])[0], query.get("code", [""])[0]
        if state == self.server.expected_state and code:
            self.server.code = code
        else:
            self.server.error = query.get("error", ["the redirect did not match this sign in"])[0]
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(DONE_PAGE if self.server.code else FAILED_PAGE)


def challenge_for(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


class GoogleAccount:
    def __init__(self, token_file: Path, http: httpx.Client, auth_url: str = AUTH_URL, token_url: str = TOKEN_URL, api_base: str = API_BASE):
        self.token_file = token_file
        self.http = http
        self.auth_url = auth_url
        self.token_url = token_url
        self.api_base = api_base
        self.lock = threading.Lock()
        self.status = "not connected"
        # Each sign in is numbered: one you gave up on never reports over a newer one.
        self.attempt = 0

    @property
    def client_id(self) -> str:
        return os.environ.get("GOOGLE_CLIENT_ID", "")

    @property
    def connected(self) -> bool:
        return bool(read_json(self.token_file, {}).get("refresh_token"))

    def start(self) -> str:
        """The address to open in your browser; a thread waits for Google's redirect and finishes the sign in."""
        if not self.client_id:
            raise GoogleError("Add GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET) from a Google desktop OAuth client to openMoi's .env first.")
        verifier = secrets.token_urlsafe(64)
        server = Redirect(("127.0.0.1", 0), RedirectHandler)
        server.expected_state = secrets.token_urlsafe(24)
        server.timeout = WAIT_SECONDS
        redirect_uri = f"http://127.0.0.1:{server.server_address[1]}/callback"
        self.attempt += 1
        self.status = "waiting for you in the browser"
        threading.Thread(target=self.finish, args=(server, verifier, redirect_uri, self.attempt), daemon=True).start()
        query = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPE,
            "state": server.expected_state,
            "code_challenge": challenge_for(verifier),
            "code_challenge_method": "S256",
            "access_type": "offline",
            "prompt": "consent",
        }
        return f"{self.auth_url}?{urlencode(query)}"

    def finish(self, server: Redirect, verifier: str, redirect_uri: str, attempt: int) -> None:
        try:
            server.handle_request()
        finally:
            server.server_close()
        if not server.code:
            self.report(attempt, f"not connected: {server.error or 'no answer from the browser'}")
            return
        try:
            self.save(self.token_request({"grant_type": "authorization_code", "code": server.code, "code_verifier": verifier, "redirect_uri": redirect_uri}))
            self.report(attempt, "connected")
        except GoogleError as error:
            self.report(attempt, f"not connected: {error}")

    def report(self, attempt: int, status: str) -> None:
        if attempt == self.attempt:
            self.status = status

    def token_request(self, fields: dict[str, str]) -> dict[str, Any]:
        body = {"client_id": self.client_id, **fields}
        if secret := os.environ.get("GOOGLE_CLIENT_SECRET"):
            body["client_secret"] = secret
        try:
            response = self.http.post(self.token_url, data=body)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise GoogleError(f"Google refused the sign in: {error}") from error

    def save(self, answer: dict[str, Any]) -> None:
        with self.lock:
            stored = read_json(self.token_file, {})
            tokens = {
                "access_token": answer.get("access_token", ""),
                "refresh_token": answer.get("refresh_token") or stored.get("refresh_token", ""),
                "expires_at": time.time() + float(answer.get("expires_in", 3600)) - 60,
            }
            write_atomic(self.token_file, json.dumps(tokens), private=True)

    def access_token(self) -> str:
        tokens = read_json(self.token_file, {})
        if not tokens.get("refresh_token"):
            raise GoogleError("Google is not connected; use /google connect.")
        if tokens.get("access_token") and float(tokens.get("expires_at", 0)) > time.time():
            return tokens["access_token"]
        self.save(self.token_request({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]}))
        return read_json(self.token_file, {})["access_token"]

    def youtube_subscriptions(self) -> list[str]:
        """Channel ids of every YouTube channel you subscribe to, page by page."""
        channels: list[str] = []
        page = ""
        for _ in range(MAX_PAGES):
            params = {"part": "snippet", "mine": "true", "maxResults": "50", **({"pageToken": page} if page else {})}
            try:
                response = self.http.get(f"{self.api_base}/youtube/v3/subscriptions", params=params, headers={"authorization": f"Bearer {self.access_token()}"})
                response.raise_for_status()
                answer = response.json()
            except (httpx.HTTPError, ValueError) as error:
                raise GoogleError(f"YouTube did not list your subscriptions: {error}") from error
            channels += [entry["snippet"]["resourceId"]["channelId"] for entry in answer.get("items", []) if entry.get("snippet", {}).get("resourceId", {}).get("channelId")]
            page = answer.get("nextPageToken", "")
            if not page:
                break
        return list(dict.fromkeys(channels))
