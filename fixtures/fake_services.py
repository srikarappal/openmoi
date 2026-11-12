"""Fake outside world for tests: feeds, YouTube, an X style timeline, sample pages and a fake model.

Used in process by the brain's pytest suite and as a subprocess by the shell's Electron tests:
    python fixtures/fake_services.py --port 8899
"""

import argparse
import base64
import html
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from fake_model import embeddings, model_reply

PAGES_DIR = Path(__file__).resolve().parent / "pages"
# A 1 by 1 PNG, for lens images that go through the media proxy.
PIXEL_PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
CHANNEL_ID = "UCfakechannel00000000001"
TECH_ITEMS = [
    ("tech1", "New laptop chip doubles battery life", "Engineers explain the new design.", 1),
    ("tech2", "Election results shake up tech policy", "Politics and the election dominate the week.", 3),
    ("tech3", "A tour of the new space telescope images", "Stunning pictures from deep space.", 5),
    ("tech4", "Open source database hits version 10", "Faster queries and a new storage engine.", 30),
    ("tech5", "How solar panels got cheap", "A long look at manufacturing.", 50),
]
NEWS_ITEMS = [
    ("news1", "Senate debates the election budget", "Politics again, all day.", 2),
    ("tech1", "New laptop chip doubles battery life", "Same story as the tech feed.", 1),
    ("news3", "Local bakery wins national prize", "Sourdough fans rejoice.", 8),
]
VIDEOS = [
    ("VIDEO00001A", "watch", "Why the sky is blue, really", 4),
    ("SHORT00001B", "shorts", "One minute physics trick", 6),
    ("VIDEO00002C", "watch", "The surprising math of traffic", 20),
]


def rss_feed(base_url: str, name: str, entries: list[tuple[str, str, str, int]]) -> str:
    now = datetime.now(UTC)
    items = "".join(
        f"<item><guid>{guid}</guid><title>{title}</title><link>{base_url}/articles/{guid}?utm_source=rss</link>"
        f"<description>{text}</description><pubDate>{format_datetime(now - timedelta(hours=hours))}</pubDate></item>"
        for guid, title, text, hours in entries
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel><title>{name}</title>{items}</channel></rss>'


# A video's captions in YouTube's json3 shape: the demo is the part worth watching.
CAPTIONS = {
    "events": [
        {"tStartMs": 0, "segs": [{"utf8": "Welcome back to the channel"}]},
        {"tStartMs": 65_000, "segs": [{"utf8": "Here is the "}, {"utf8": "demo of the new battery"}]},
        {"tStartMs": 190_000, "segs": [{"utf8": "Thanks for watching"}]},
    ]
}
ARTICLE_PARAGRAPH = "The new chip doubles battery life by moving work to efficient cores and sleeping the radio between packets."


def article_page(path: str) -> str:
    """A long enough article for reader mode, titled by its path."""
    paragraphs = "".join(f"<p>Article {path}. {ARTICLE_PARAGRAPH} Paragraph {index}.</p>" for index in range(8))
    return f"<html><head><title>{path}</title></head><body><article><h1>{path}</h1>{paragraphs}</article></body></html>"


def youtube_feed(base_url: str) -> str:
    now = datetime.now(UTC)
    entries = "".join(
        f"<entry><id>yt:video:{video_id}</id><yt:videoId>{video_id}</yt:videoId><title>{title}</title>"
        f'<link rel="alternate" href="https://www.youtube.com/{"shorts/" + video_id if path == "shorts" else "watch?v=" + video_id}"/>'
        f"<author><name>Veritasium</name></author><published>{(now - timedelta(hours=hours)).isoformat()}</published>"
        f'<media:group><media:thumbnail url="https://i.ytimg.com/vi/{video_id}/hqdefault.jpg" width="480" height="360"/>'
        f"<media:description>About {title.lower()}</media:description></media:group></entry>"
        for video_id, path, title, hours in VIDEOS
    )
    return (
        '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" '
        'xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">'
        f"<title>Veritasium</title>{entries}</feed>"
    )


def tech_feed(base_url: str) -> str:
    return rss_feed(base_url, "Tech", TECH_ITEMS)


def news_feed(base_url: str) -> str:
    return rss_feed(base_url, "News", NEWS_ITEMS)


def photos_feed(base_url: str) -> str:
    """One post with an image in its description, served by this fake world."""
    now = format_datetime(datetime.now(UTC) - timedelta(hours=1))
    item = (
        f"<item><guid>photo1</guid><title>Sunset over the bay</title><link>{base_url}/articles/photo1</link>"
        f'<description>&lt;img src="{base_url}/images/pixel.png"&gt; A photo.</description><pubDate>{now}</pubDate></item>'
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel><title>Photos</title>{item}</channel></rss>'


def broken_feed(base_url: str) -> str:
    return "this is not a feed"


def channel_page(base_url: str) -> str:
    return (
        "<html><head><title>Veritasium</title>"
        f'<link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}">'
        "</head><body>channel</body></html>"
    )


def lockup(video_id: str, title: str, age: str) -> dict[str, Any]:
    return {
        "contentId": video_id,
        "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
        "contentImage": {"thumbnailViewModel": {"image": {"sources": [{"url": f"https://i.ytimg.com/vi/{video_id}/small.jpg"}, {"url": f"https://i.ytimg.com/vi/{video_id}/hq720.jpg"}]}}},
        "metadata": {"lockupMetadataViewModel": {
            "title": {"content": title},
            "metadata": {"contentMetadataViewModel": {"metadataRows": [{"metadataParts": [{"accessibilityLabel": "10 million views"}, {"accessibilityLabel": age}]}]}},
        }},
    }


def channel_videos_page(base_url: str) -> str:
    """The channel's videos tab as YouTube serves it: uploads inside the ytInitialData script, mostly as lockups."""
    data = {
        "metadata": {"channelMetadataRenderer": {"title": "Veritasium", "externalId": CHANNEL_ID}},
        "contents": {"tabs": [{"richGridRenderer": {"contents": [
            {"richItemRenderer": {"content": {"lockupViewModel": lockup("VIDEO00001A", "Why the sky is blue, really", "4 hours ago")}}},
            {"richItemRenderer": {"content": {"lockupViewModel": lockup("VIDEO00002C", "The surprising math of traffic", "3 days ago")}}},
            {"richItemRenderer": {"content": {"lockupViewModel": {"contentId": "PLAYLIST01", "contentType": "LOCKUP_CONTENT_TYPE_PLAYLIST"}}}},
            {"richItemRenderer": {"content": {"videoRenderer": {
                "videoId": "VIDEO00003D", "title": {"runs": [{"text": "Older layout video"}]},
                "publishedTimeText": {"simpleText": "2 weeks ago"}, "thumbnail": {"thumbnails": [{"url": "https://i.ytimg.com/vi/VIDEO00003D/hq.jpg"}]},
            }}}},
        ]}}]},
    }
    return f"<html><body><script>var ytInitialData = {json.dumps(data)};</script></body></html>"


ROUTES = {
    "/rss/tech.xml": ("application/rss+xml", tech_feed),
    "/rss/news.xml": ("application/rss+xml", news_feed),
    "/rss/broken.xml": ("application/rss+xml", broken_feed),
    "/rss/photos.xml": ("application/rss+xml", photos_feed),
    "/@veritasium": ("text/html", channel_page),
    "/feeds/videos.xml": ("application/atom+xml", youtube_feed),
    f"/channel/{CHANNEL_ID}/videos": ("text/html", channel_videos_page),
}


class Handler(BaseHTTPRequestHandler):
    server: "FakeServer"

    def log_message(self, format: str, *args: Any) -> None:
        return None

    def do_GET(self) -> None:
        services = self.server.services
        parts = urlparse(self.path)
        if not self.path.startswith(("/__requests", "/__hits")):
            services.record("GET", self.path, dict(self.headers), None)
        base = services.base_url
        if parts.path == "/__requests":
            task = parse_qs(parts.query).get("task", [None])[0]
            self.reply(200, "application/json", json.dumps([{"path": call["path"], "payload": call["payload"]} for call in services.model_calls(task)]))
        elif parts.path == "/__hits":
            prefix = parse_qs(parts.query).get("prefix", ["/"])[0]
            self.reply(200, "application/json", json.dumps(services.hits(prefix)))
        elif parts.path.startswith("/embed/"):
            video_id = html.escape(parts.path.removeprefix("/embed/"))
            self.reply(200, "text/html", f"<!doctype html><title>Player {video_id}</title><p>Playing {video_id}</p>")
        elif parts.path == "/images/pixel.png":
            self.reply_bytes(200, "image/png", PIXEL_PNG)
        elif parts.path.startswith("/canary/"):
            self.reply_bytes(200, "image/png", PIXEL_PNG)
        elif parts.path == "/pages/x_home_signed_in.html":
            self.signed_in_page()
        elif parts.path == "/feeds/videos.xml" and services.youtube_feed_down:
            self.reply(404, "text/html", "YouTube RSS Feeds server: not found")
        elif parts.path == "/rss/etag.xml":
            self.etag_feed(base)
        elif parts.path == "/watched":
            self.watched_page(parts.query)
        elif parts.path == "/drifting":
            self.drifting_page(parts.query)
        elif parts.path == "/api/timedtext":
            self.reply(200, "application/json", json.dumps(CAPTIONS))
        elif parts.path in ROUTES:
            content_type, render = ROUTES[parts.path]
            self.reply(200, content_type, render(base))
        elif parts.path.startswith("/pages/") and (PAGES_DIR / parts.path.removeprefix("/pages/")).is_file():
            self.reply(200, "text/html", (PAGES_DIR / parts.path.removeprefix("/pages/")).read_text())
        elif parts.path.startswith("/articles/"):
            self.reply(200, "text/html", article_page(parts.path))
        else:
            self.reply(404, "text/plain", "not found")

    def drifting_page(self, key: str) -> None:
        """A site that redesigns between looks: story-a markup at first, story-b markup from the second look on."""
        looks = self.server.services.count_look(f"drift:{key}")
        name = "story-a" if looks == 1 else "story-b"
        stories = "".join(f'<div class="{name}"><h3>Story {index} from the {name} design</h3><a href="/drifted/{name}/{index}">read</a></div>' for index in range(6))
        self.reply(200, "text/html", f"<html><head><title>Drifting news</title></head><body><main>{stories}</main></body></html>")

    def watched_page(self, key: str) -> None:
        """A page someone watches: no slots at the first look, a slot from the second look on (counted per query)."""
        looks = self.server.services.count_look(key)
        slot = "No slots this month" if looks == 1 else "Slot available on December 12"
        page = f"<html><head><title>Visa slots</title></head><body><main><h1>Appointments</h1><p>{slot}</p><p>Updated {looks} minutes ago</p></main></body></html>"
        self.reply(200, "text/html", page)

    def signed_in_page(self) -> None:
        """The X timeline only for a browser holding the session cookie; everyone else gets the login wall."""
        if "moi_session=1" in (self.headers.get("cookie") or ""):
            self.reply(200, "text/html", (PAGES_DIR / "x_home.html").read_text())
            return
        self.send_response(302)
        self.send_header("location", "/pages/x_login.html")
        self.send_header("content-length", "0")
        self.end_headers()

    def etag_feed(self, base: str) -> None:
        if self.headers.get("if-none-match") == '"v1"':
            self.send_response(304)
            self.end_headers()
            return
        body = rss_feed(base, "Etag", TECH_ITEMS[:1]).encode()
        self.send_response(200)
        self.send_header("content-type", "application/rss+xml")
        self.send_header("etag", '"v1"')
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        services = self.server.services
        length = int(self.headers.get("content-length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        services.record("POST", self.path, dict(self.headers), payload)
        if urlparse(self.path).path == "/llm/v1/embeddings":
            if services.embeddings_down:
                self.reply(500, "text/plain", "embedding model unavailable")
            else:
                self.reply(200, "application/json", json.dumps(embeddings(payload)))
            return
        if urlparse(self.path).path != "/llm/v1/chat/completions":
            self.reply(404, "text/plain", "not found")
            return
        task = self.headers.get("x-moi-task", "")
        time.sleep(services.model_delay)
        content = services.next_model_reply(task, payload)
        if content is None:
            self.reply(500, "text/plain", "model unavailable")
            return
        body = {"choices": [{"message": {"role": "assistant", "content": content}}], "usage": {"prompt_tokens": 100, "completion_tokens": 20}}
        self.reply(200, "application/json", json.dumps(body))

    def do_OTHER(self) -> None:
        """Any other method is recorded, so a test sees whatever reached this world, and answered empty."""
        self.server.services.record(self.command, self.path, dict(self.headers), None)
        self.reply_bytes(200, "text/plain", b"")

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = do_OTHER

    def reply(self, status: int, content_type: str, text: str) -> None:
        self.reply_bytes(status, content_type, text.encode())

    def reply_bytes(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class FakeServer(ThreadingHTTPServer):
    services: "FakeServices"


class FakeServices:
    """Runs the fake world on a local port; queued model replies override the default fake model."""

    def __init__(self, port: int = 0):
        self.server = FakeServer(("127.0.0.1", port), Handler)
        self.server.services = self
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.model_queue: dict[str, list[str | None]] = {}
        self.model_delay = 0.0
        self.youtube_feed_down = False
        self.embeddings_down = False
        self.looks: dict[str, int] = {}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def start(self) -> "FakeServices":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def record(self, method: str, path: str, headers: dict[str, str], payload: Any) -> None:
        with self.lock:
            self.requests.append({"method": method, "path": path, "headers": {key.lower(): value for key, value in headers.items()}, "payload": payload})

    def count_look(self, key: str) -> int:
        with self.lock:
            self.looks[key] = self.looks.get(key, 0) + 1
            return self.looks[key]

    def queue_model_reply(self, task: str, content: str | None) -> None:
        with self.lock:
            self.model_queue.setdefault(task, []).append(content)

    def next_model_reply(self, task: str, payload: dict[str, Any]) -> str | None:
        with self.lock:
            queued = self.model_queue.get(task)
            if queued:
                return queued.pop(0)
        return model_reply(task, payload, self.base_url)

    def hits(self, prefix: str) -> list[dict[str, Any]]:
        """Every request whose path starts with prefix, with its method and headers: what reached this world."""
        with self.lock:
            return [{"method": request["method"], "path": request["path"], "headers": request["headers"]} for request in self.requests if request["path"].startswith(prefix)]

    def model_calls(self, task: str | None = None) -> list[dict[str, Any]]:
        with self.lock:
            return [
                request for request in self.requests
                if request["path"].endswith("/chat/completions") and (task is None or request["headers"].get("x-moi-task") == task)
            ]

    def clear(self) -> None:
        with self.lock:
            self.requests.clear()
            self.model_queue.clear()
            self.model_delay = 0.0
            self.youtube_feed_down = False
            self.embeddings_down = False


def main() -> None:
    parser = argparse.ArgumentParser(description="openMoi fake services for tests")
    parser.add_argument("--port", type=int, default=8899)
    args = parser.parse_args()
    services = FakeServices(args.port)
    print(f"fake services on {services.base_url}", flush=True)
    services.server.serve_forever()


if __name__ == "__main__":
    main()
