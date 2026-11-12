"""Apps on this Mac: source lines, records from Calendar, Mail, Notes and Files, the helper and its permissions, a
Today card that drops moved events, newsletters and orders, a Day board, and the real Swift helper when it builds."""

import json
import os
import shutil
import subprocess
import sys
import time
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
    start_of_day,
    web_copy,
)
from moi_brain.brain import Brain
from moi_brain.compile import AppRef, parse_sources
from moi_brain.config import REPO_DIR
from moi_brain.items import MAIL_ORDERS, Item, normalize
from moi_brain.mashups import day_related
from moi_brain.sharing import share_text

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
    assert [app.source_id for app in apps.apps][:4] == ["app:calendar", "app:mail", MAIL_ORDERS, "app:notes"]
    assert apps.apps[-1].source_id.startswith("app:files:") and AppRef(app="files", folders=["/a"]).source_id != AppRef(app="files", folders=["/b"]).source_id
    assert parse_sources("* Calendar: this week\n* Mail\n", [])[0][0].apps == [AppRef(app="calendar", days=7), AppRef(app="mail", what="newsletters")]
    assert parse_sources("* Files:\n", [])[1] == ["Files needs the folders to read, such as Files: ~/Documents/Papers"]


def test_app_records_keep_their_place_in_the_app_and_open_nowhere(tmp_path):
    [standup] = calendar_records([EVENTS[1]])
    assert standup["native_id"] == "e1@2026-11-12T16:00:00+00:00" and standup["url"] == "moi-app://calendar/e1%402026-11-12T16%3A00%3A00%2B00%3A00"
    assert standup["extra.when"].count(":") == 2 and standup["extra.attendees"] == ""
    me = {"name": "Me Myself", "email": "me@example.com", "me": True}
    [review] = calendar_records([{**EVENTS[0], "attendees": [*EVENTS[0]["attendees"], me]}])
    assert json.loads(review["extra.attendees"]) == [{"name": "Maya Kim", "email": "maya@example.com"}]
    assert calendar_records([{**EVENTS[1], "all_day": True}])[0]["extra.when"] == "all day"
    assert calendar_records([{**EVENTS[1], "id": None}, {**EVENTS[1], "start": ""}]) == []
    item = normalize("app:calendar", review, NOW)
    assert item is not None and item.url.startswith("moi-app://calendar/e2%40") and item.kind == "post"
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
    assert web_copy("no links here", "a.example") is None
    assert mail_records([{**MAIL[0], "id": None}, {**MAIL[0], "id": ""}], orders=False) == []


@pytest.mark.parametrize(
    ("body", "sender", "url"),
    [
        ("View in browser https://192.168.1.1/cgi-bin/reboot then https://news.batteryweekly.example/12", "hello@batteryweekly.example", "https://news.batteryweekly.example/12"),
        ("Read online: https://evil.example/login?magic=1", "hello@batteryweekly.example", None),
        ("https://localhost.batteryweekly.example.evil.example/x", "hello@batteryweekly.example", None),
        ("Your order https://www.shop.co.uk/orders/1", "orders@mail.shop.co.uk", "https://www.shop.co.uk/orders/1"),
        ("Your order https://other.co.uk/orders/1", "orders@mail.shop.co.uk", None),
    ],
)
def test_a_mail_points_its_card_only_at_its_senders_own_site(body, sender, url):
    assert web_copy(body, sender.rpartition("@")[2]) == url


@pytest.mark.parametrize(
    ("subject", "body", "order"),
    [
        ("Your order #123 has shipped", "Desk lamp, $24.99.", True),
        ("Order # 5512 confirmed", "Total $12.00", True),
        ("Version 2.0 has shipped!", "New features, $0 to upgrade? No price here", False),
        ("Complete your order and save 20%", "Your cart: lamp $24.99", False),
        ("Re: your order of the slides", "I paid $40 for the printing", False),
        ("Fwd: Your order #9 has shipped", "Lamp $24.99", False),
        ("Your order has shipped", "Thanks for shopping with us", False),
    ],
)
def test_only_order_confirmations_with_a_price_count_as_orders(subject, body, order):
    message = {"id": "<x@shop>", "subject": subject, "sender": "Shop <orders@shop.example>", "date": "2026-11-01T09:00:00.000Z", "unsubscribe": True, "body": body}
    assert len(mail_records([message], orders=True)) == int(order)


def test_the_calendar_day_starts_at_local_midnight_even_when_clocks_change(pacific_clock):
    assert start_of_day(datetime(2026, 11, 1, 20, 0, tzinfo=UTC)) == datetime(2026, 11, 1, 7, 0, tzinfo=UTC)
    assert start_of_day(datetime(2027, 3, 14, 20, 0, tzinfo=UTC)) == datetime(2027, 3, 14, 8, 0, tzinfo=UTC)


def test_a_helper_that_hangs_is_stopped_with_everything_it_started(tmp_path):
    marker = tmp_path / "child.pid"
    hung = tmp_path / "hung"
    hung.write_text(f"#!/bin/sh\nsleep 60 &\necho $! > {marker}\nwait\n")
    hung.chmod(0o755)
    started = time.monotonic()
    with pytest.raises(AppError) as stopped:
        MacHelper(hung).run("mail", {}, timeout=1)
    assert stopped.value.kind == "unavailable" and "did not answer in 1 s" in str(stopped.value) and time.monotonic() - started < 10
    child = int(marker.read_text())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and subprocess.run(["kill", "-0", str(child)], capture_output=True, check=False).returncode == 0:
        time.sleep(0.1)
    assert subprocess.run(["kill", "-0", str(child)], capture_output=True, check=False).returncode != 0


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
    assert client.post("/apps/allow", json={"capability": "contacts"}).status_code == 422


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


def test_a_recurring_meeting_shows_each_day_and_a_renamed_one_shows_its_new_name(mac, paths):
    _, client, world_path, clock = mac
    data = json.loads(world_path.read_text())
    data["status"]["calendar"] = "allowed"
    data["calendar"] = [{**EVENTS[1], "id": "rec1"}, {**EVENTS[1], "id": "rec1", "start": "2026-11-13T16:00:00Z", "end": "2026-11-13T16:15:00Z"}]
    world_path.write_text(json.dumps(data))
    (paths.views / "today.md").write_text("# Today\n\n## Sources\n* Calendar\n")
    client.post("/refresh", json={"view_id": "today", "force": True})
    assert [entry["item"]["title"] for entry in wait_until_refreshed(client, "today")["items"]] == ["Standup"]
    data["calendar"][0]["title"] = "Standup, moved to the big room"
    world_path.write_text(json.dumps(data))
    client.post("/refresh", json={"view_id": "today", "force": True})
    assert [entry["item"]["title"] for entry in wait_until_refreshed(client, "today")["items"]] == ["Standup, moved to the big room"]
    clock.moment += timedelta(days=1)
    client.post("/refresh", json={"view_id": "today", "force": True})
    [tomorrow] = wait_until_refreshed(client, "today")["items"]
    assert tomorrow["item"]["title"] == "Standup" and tomorrow["item"]["published_at"].startswith("2026-11-13")


def test_each_view_keeps_its_own_calendar_window_and_folders(mac, paths, tmp_path):
    brain, client, world_path, _ = mac
    data = json.loads(world_path.read_text())
    data["status"]["calendar"] = "allowed"
    data["calendar"] = [*EVENTS, {**EVENTS[1], "id": "offsite", "title": "Offsite", "start": "2026-11-17T16:00:00Z", "end": "2026-11-17T20:00:00Z"}]
    documents, desktop = Path.home() / "Documents" / "moi_test_a", Path.home() / "Desktop" / "moi_test_b"
    data["files"] = [{"path": f"{documents}/secret.txt", "modified": "2026-11-12T08:00:00Z"}, {"path": f"{desktop}/b.txt", "modified": "2026-11-12T08:00:00Z"}]
    world_path.write_text(json.dumps(data))
    (paths.views / "week.md").write_text("# Week\n\n## Sources\n* Calendar: next 7 days\n")
    (paths.views / "today.md").write_text("# Today\n\n## Sources\n* Calendar\n")
    client.post("/refresh", json={"view_id": "week", "force": True})
    assert "Offsite" in [entry["item"]["title"] for entry in wait_until_refreshed(client, "week")["items"]]
    client.post("/refresh", json={"view_id": "today"})
    assert [entry["item"]["title"] for entry in wait_until_refreshed(client, "today")["items"]] == ["Standup", "Lithium recycling review"]
    (paths.views / "a.md").write_text(f"# A\n\n## Sources\n* Files: {documents}\n")
    (paths.views / "b.md").write_text(f"# B\n\n## Sources\n* Files: {desktop}\n")
    client.post("/refresh", json={"view_id": "a", "force": True})
    page = wait_until_refreshed(client, "a")
    assert page["items"] == [] and any("say /allow files" in warning for warning in page["warnings"])
    assert client.post("/apps/allow", json={"capability": "files"}).json()["status"] == {"files": "allowed"}
    assert client.get("/apps").json()["status"]["files"] == "allowed"
    client.post("/refresh", json={"view_id": "a", "force": True})
    assert [entry["item"]["title"] for entry in wait_until_refreshed(client, "a")["items"]] == ["secret.txt"]
    client.post("/refresh", json={"view_id": "b"})
    assert [entry["item"]["title"] for entry in wait_until_refreshed(client, "b")["items"]] == ["b.txt"]
    assert not brain.readable_in_a_tab("moi-app://files/x") and not brain.readable_in_a_tab("moi-app://notes/1")


def test_a_shared_view_leaves_out_the_folders_it_reads(paths):
    shared = share_text("# A\n\n## Sources\n* Files: ~/Documents/Papers\n* Calendar\n")
    assert "Papers" not in shared and "* Calendar" in shared


def test_a_day_board_matches_attendees_by_full_name_or_by_a_mail_from_their_address():
    event = Item(item_id="e", source_id="app:calendar", native_id="e", kind="post", url="moi-app://calendar/e", title="Budget sync", fetched_at=NOW,
                 extra={"attendees": json.dumps([{"name": "Sam", "email": "sam@company.com"}, {"name": "Maya Kim", "email": "maya@example.com"}])})
    cat = Item(item_id="c", source_id="x", native_id="c", kind="post", url="https://x.com/sam/status/1", text="my cat", author_name="sam", author_handle="sam", fetched_at=NOW)
    mail = Item(item_id="m", source_id="app:mail", native_id="m", kind="article", url="moi-app://mail/m", title="Numbers", author_name="Sam", author_handle="sam@company.com", fetched_at=NOW)
    maya = Item(item_id="k", source_id="x", native_id="k", kind="post", url="https://x.com/maya/status/2", text="slides", author_name="Maya Kim", author_handle="maya", fetched_at=NOW)
    assert [(related.item_id, related.label) for related in day_related(event, [cat, mail, maya])] == [("m", "from Sam"), ("k", "from Maya Kim")]
