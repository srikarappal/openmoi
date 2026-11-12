"""Apps on this Mac: source lines, records from Calendar, Mail, Notes and Files, the helper and its permissions, a
Today card that drops moved events, newsletters and orders, a Day board, and the real Swift helper when it builds."""

import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from conftest import TOKEN, wait_until_refreshed
from fastapi.testclient import TestClient
from helpers import FixedClock

from moi_brain.api import create_app
from moi_brain.apps import (
    AppError,
    MacHelper,
    calendar_records,
    file_records,
    mail_records,
    notes_records,
    sender_parts,
    web_copy,
)
from moi_brain.brain import Brain
from moi_brain.compile import AppRef, parse_sources
from moi_brain.config import REPO_DIR
from moi_brain.items import MAIL_ORDERS, normalize

NOW = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)
FAKE_HELPER = REPO_DIR / "fixtures" / "fake_mac_helper.py"
EVENTS = [
    {"id": "e2", "title": "Lithium recycling review", "start": "2026-11-12T18:00:00Z", "end": "2026-11-12T18:30:00Z", "all_day": False, "location": "Room 4", "calendar": "Work", "notes": "", "attendees": [{"name": "Maya Kim", "email": "maya@example.com"}]},
    {"id": "e1", "title": "Standup", "start": "2026-11-12T16:00:00Z", "end": "2026-11-12T16:15:00Z", "all_day": False, "location": "", "calendar": "Work", "notes": "", "attendees": []},
]
MAIL = [
    {"id": "<n1@news>", "subject": "The Battery Weekly #12", "sender": "Battery Weekly <hello@batteryweekly.example>", "date": "2026-11-11T08:00:00.000Z", "unsubscribe": True, "body": "View this in your browser: https://batteryweekly.example/12\nLithium prices fell. Unsubscribe here https://batteryweekly.example/u"},
    {"id": "<p1@friend>", "subject": "Dinner?", "sender": "Sam <sam@example.com>", "date": "2026-11-11T09:00:00.000Z", "unsubscribe": False, "body": "Are you free Friday?"},
    {"id": "<o1@shop>", "subject": "Your order #123 has shipped", "sender": "Shop <orders@shop.example>", "date": "2026-09-01T09:00:00.000Z", "unsubscribe": True, "body": "Desk lamp, $24.99. Track it at https://shop.example/orders/123"},
]


def world(tmp_path: Path, status: dict | None = None, grant: dict | None = None, **data) -> Path:
    path = tmp_path / "apps.json"
    path.write_text(json.dumps({"status": status or {}, "grant": grant or {}, **data}))
    return path


def calls(world_path: Path) -> list[dict]:
    log = Path(f"{world_path}.log")
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


@pytest.fixture
def mac(paths, settings, services, tmp_path, monkeypatch):
    world_path = world(tmp_path, {"calendar": "not_asked", "mail": "allowed"}, {"calendar": "allowed"}, calendar=EVENTS, mail=MAIL)
    monkeypatch.setenv("MOI_FAKE_APPS", str(world_path))
    clock = FixedClock(NOW)
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock, mac_helper=FAKE_HELPER)
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    yield brain, client, world_path, clock
    brain.http.close()


def test_source_lines_name_apps_and_only_folders_inside_your_home(tmp_path):
    inside = Path.home() / "Documents"
    sources, warnings = parse_sources(f"* Calendar\n* Calendar: next 3 days\n* Mail: newsletters, orders\n* Notes\n* Files: {inside}, /etc, ~\n* Files: ~/Desktop\n", [])
    [apps] = sources
    assert [(app.app, app.what, app.days) for app in apps.apps] == [("calendar", "", 3), ("mail", "newsletters", 1), ("mail", "orders", 1), ("notes", "", 1), ("files", "", 1)]
    assert apps.apps[-1].folders == [str(inside.resolve()), str((Path.home() / "Desktop").resolve())]
    assert warnings == ["Files: /etc is not a folder inside your home folder, so it is not read.", "Files: ~ is not a folder inside your home folder, so it is not read."]
    assert [app.source_id for app in apps.apps] == ["app:calendar", "app:mail", MAIL_ORDERS, "app:notes", "app:files"]
    assert parse_sources("* Calendar: this week\n* Mail\n", [])[0][0].apps == [AppRef(app="calendar", days=7), AppRef(app="mail", what="newsletters")]
    assert parse_sources("* Files:\n", [])[1] == ["Files needs the folders to read, such as Files: ~/Documents/Papers"]


def test_app_records_keep_their_place_in_the_app_and_open_nowhere(tmp_path):
    [standup] = calendar_records([EVENTS[1]])
    assert standup["url"] == "moi-app://calendar/e1" and standup["extra.when"].count(":") == 2 and standup["extra.attendees"] == ""
    [review] = calendar_records([EVENTS[0]])
    assert json.loads(review["extra.attendees"]) == [{"name": "Maya Kim", "email": "maya@example.com"}]
    assert calendar_records([{**EVENTS[1], "all_day": True}])[0]["extra.when"] == "all day"
    item = normalize("app:calendar", review, NOW)
    assert item is not None and item.url == "moi-app://calendar/e2" and item.kind == "post"
    assert normalize("rss:blog", {**review, "url": "moi-app://calendar/e2"}, NOW) is None
    assert normalize("app:calendar", {**review, "url": "moi-app://shell/rm"}, NOW) is None
    assert normalize("app:calendar", {**review, "url": "moi-app://calendar/../x y"}, NOW) is None
    [note] = notes_records([{"id": "x-coredata://n/1", "title": "Ideas", "body": "Try the lamp", "modified": "2026-11-10T08:00:00.000Z"}])
    assert note["url"] == "moi-app://notes/x-coredata%3A%2F%2Fn%2F1" and normalize("app:notes", note, NOW) is not None


def test_mail_gives_newsletters_to_read_and_orders_as_your_history():
    [letter] = mail_records(MAIL, orders=False)
    assert (letter["title"], letter["url"], letter["author_handle"], letter["kind"]) == ("The Battery Weekly #12", "https://batteryweekly.example/12", "hello@batteryweekly.example", "article")
    [order] = mail_records(MAIL, orders=True)
    assert (order["url"], order["extra.price_text"], order["kind"], order["extra.site"]) == ("https://shop.example/orders/123", "$24.99", "product", "shop.example")
    assert mail_records([{**MAIL[1], "unsubscribe": True}], orders=False)[0]["url"] == "moi-app://mail/%3Cp1%40friend%3E"
    assert sender_parts('"Maya Kim" <Maya@Example.com>') == ("Maya Kim", "maya@example.com") and sender_parts("x@y.z") == ("", "x@y.z")
    assert web_copy("no links here") is None


def test_files_come_only_from_the_folders_you_opted_into(tmp_path):
    folder = tmp_path / "papers"
    folder.mkdir()
    (folder / "notes.md").write_text("# Battery notes\nCells age with heat.")
    (folder / "scan.pdf").write_bytes(b"%PDF")
    found = file_records([{"path": str(folder / "notes.md"), "modified": "2026-11-10T08:00:00Z"}, {"path": str(folder / "scan.pdf"), "modified": "2026-11-09T08:00:00Z"}, {"path": "/etc/passwd"}], [str(folder)])
    assert [(record["title"], record["text"][:15]) for record in found] == [("notes.md", "# Battery notes"), ("scan.pdf", "")]


def test_the_helper_client_says_what_went_wrong(tmp_path, monkeypatch):
    with pytest.raises(AppError) as missing:
        MacHelper(tmp_path / "none").run("status", {})
    assert missing.value.kind == "unavailable" and "helper/build.sh" in str(missing.value)
    broken = tmp_path / "broken"
    broken.write_text("#!/bin/sh\necho not json\n")
    broken.chmod(0o755)
    with pytest.raises(AppError) as garbled:
        MacHelper(broken).run("status", {})
    assert garbled.value.kind == "unavailable"
    monkeypatch.setenv("MOI_FAKE_APPS", str(world(tmp_path, {"calendar": "denied"})))
    with pytest.raises(AppError) as refused:
        MacHelper(FAKE_HELPER).run("calendar", {})
    assert refused.value.kind == "permission"


def test_a_today_card_asks_for_calendar_once_you_allow_it_and_drops_moved_events(mac, paths):
    _, client, world_path, clock = mac
    (paths.views / "today.md").write_text("# Today\n\n## Sources\n* Calendar\n")
    client.post("/refresh", json={"view_id": "today", "force": True})
    page = wait_until_refreshed(client, "today")
    assert page["items"] == [] and "app:calendar: needs your permission: say /allow calendar. openMoi would read it to show today's meetings in your views. It reads events only and never changes them." in page["warnings"]
    assert client.get("/apps").json()["status"]["calendar"] == "not_asked"
    allowed = client.post("/apps/allow", json={"capability": "calendar"}).json()
    assert allowed["status"] == {"calendar": "allowed"} and allowed["message"].startswith("openMoi can read calendar now")
    client.post("/refresh", json={"view_id": "today", "force": True})
    page = wait_until_refreshed(client, "today")
    assert [entry["item"]["title"] for entry in page["items"]] == ["Standup", "Lithium recycling review"]
    assert not any("calendar" in warning for warning in page["warnings"])
    data = json.loads(world_path.read_text())
    data["calendar"] = [EVENTS[0]]
    world_path.write_text(json.dumps(data))
    client.post("/refresh", json={"view_id": "today", "force": True})
    assert [entry["item"]["title"] for entry in wait_until_refreshed(client, "today")["items"]] == ["Lithium recycling review"]
    clock.moment += timedelta(days=1)
    assert client.post("/view/today", json={}).json()["items"] == []
    assert {call["command"] for call in calls(world_path)} <= {"status", "request", "calendar"}
    assert [call["args"] for call in calls(world_path) if call["command"] == "request"] == [{"capability": "calendar"}]
    denied = client.post("/apps/allow", json={"capability": "notes"}).json()
    assert denied["status"] == {"notes": "denied"} and "System Settings" in denied["message"]
    assert client.post("/apps/allow", json={"capability": "files"}).status_code == 422


def test_newsletters_and_orders_read_from_mail(mac, paths):
    _, client, _, _ = mac
    (paths.views / "letters.md").write_text("# Letters\n\n## Sources\n* Mail: newsletters\n")
    (paths.views / "orders.md").write_text("# Orders\n\n## Sources\n* Mail: orders\n")
    client.post("/refresh", json={"view_id": "letters", "force": True})
    [letter] = wait_until_refreshed(client, "letters")["items"]
    assert letter["item"]["url"] == "https://batteryweekly.example/12" and letter["item"]["source_id"] == "app:mail"
    client.post("/refresh", json={"view_id": "orders", "force": True})
    [order] = wait_until_refreshed(client, "orders")["items"]
    assert order["item"]["title"] == "Your order #123 has shipped" and order["item"]["source_id"] == MAIL_ORDERS


def test_a_day_board_puts_what_attendees_posted_and_what_is_about_each_meeting_with_it(mac, paths):
    _, client, world_path, _ = mac
    json_world = json.loads(world_path.read_text())
    json_world["status"]["calendar"] = "allowed"
    world_path.write_text(json.dumps(json_world))
    (paths.views / "day.md").write_text("# Day\n\n## Sources\n* Calendar\n* X home timeline\n\n## Match\nToday's meetings with related posts by attendees.\n")
    client.post("/ingest", json={"source_id": "x", "records": [
        {"native_id": "1", "url": "https://x.com/maya/status/1", "text": "Slides for tomorrow are up", "author_name": "Maya Kim", "author_handle": "maya", "published_at": NOW.isoformat()},
        {"native_id": "2", "url": "https://x.com/news/status/2", "title": "Lithium recycling plant opens", "author_name": "News", "author_handle": "news", "published_at": NOW.isoformat()},
        {"native_id": "3", "url": "https://x.com/cats/status/3", "text": "A cat", "author_name": "Cats", "author_handle": "cats", "published_at": NOW.isoformat()},
    ]})
    client.post("/refresh", json={"view_id": "day", "force": True})
    page = wait_until_refreshed(client, "day")
    cards = {entry["item"]["title"]: [(related["label"], related["title"][:20]) for related in entry["related"]] for entry in page["items"]}
    assert cards == {"Standup": [], "Lithium recycling review": [("from Maya Kim", "Slides for tomorrow "), ("about this", "Lithium recycling pl")]}
    (paths.views / "nocal.md").write_text("# No cal\n\n## Sources\n* X home timeline\n\n## Match\nToday's meetings with related posts.\n")
    assert any("A Day board needs Calendar" in warning for warning in client.post("/view/nocal", json={}).json()["warnings"])


def ask(target: Path, command: str, args: object) -> tuple[int, dict]:
    """One command to a built helper: its exit code and its answer."""
    done = subprocess.run([str(target), command], input=json.dumps(args), capture_output=True, text=True, timeout=60, check=False)
    return done.returncode, json.loads(done.stdout)


@pytest.mark.skipif(sys.platform != "darwin" or shutil.which("swiftc") is None, reason="the Swift helper builds on a Mac with swiftc")
def test_the_real_helper_builds_answers_without_asking_and_reads_only_opted_in_folders(tmp_path):
    target = tmp_path / "moi_mac_helper"
    subprocess.run([str(REPO_DIR / "helper" / "build.sh"), str(target)], check=True, capture_output=True, timeout=600)
    code, status = ask(target, "status", {})
    assert code == 0 and set(status["data"]) == {"calendar", "mail", "notes", "files"}
    assert status["data"]["calendar"] in {"allowed", "denied", "not_asked", "restricted", "unavailable"}
    assert ask(target, "delete", {}) == (1, {"ok": False, "kind": "bad_input", "error": "unknown command delete"})
    done = subprocess.run([str(target), "status"], input="not json", capture_output=True, text=True, timeout=60, check=False)
    assert json.loads(done.stdout)["kind"] == "bad_input"
    deep = tmp_path / "opted" / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (tmp_path / "opted" / "top.md").write_text("top")
    (deep / "far.md").write_text("far")
    (tmp_path / "opted" / "link.md").symlink_to("/etc/hosts")
    code, files = ask(target, "files", {"folders": [str(tmp_path / "opted")]})
    assert code == 0 and [entry["name"] for entry in files["data"]] == ["top.md"]
    code, calendar = ask(target, "calendar", {"from": "2026-11-12T00:00:00Z", "to": "2026-11-13T00:00:00Z"})
    assert (code == 0 and isinstance(calendar["data"], list)) or calendar["kind"] == "permission"
    assert ask(target, "calendar", {"from": "nope", "to": "x"})[1]["kind"] in {"bad_input", "permission"}
    assert os.access(target, os.X_OK) and b"NSCalendarsFullAccessUsageDescription" in target.read_bytes()
