#!/usr/bin/env python3
"""A stand in for moi_mac_helper in tests: the same commands and answers, from a JSON world file.

MOI_FAKE_APPS names the world file: {"status": {"calendar": "not_asked", ...}, "grant": {"calendar": "allowed"},
"calendar": [...events], "mail": [...messages], "notes": [...notes], "files": [...files]}. A request for a
capability writes the granted status back, as macOS would remember it. Every call is appended to <world>.log, so a
test can see what openMoi asked and that it never asked to write.
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path


def when(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def calendar(events: list, args: dict) -> list:
    """Events overlapping the window asked for, as EventKit gives them."""
    start, end = when(args["from"]), when(args["to"])
    return [event for event in events if when(event["start"]) < end and when(event["end"]) > start][: args.get("limit", 200)]


def mail(messages: list, args: dict) -> list:
    """Messages since the time asked for, of the kind asked for, counting only those toward the limit, as the
    helper's script does."""
    since = when(args["since"])
    orders = re.compile(args.get("orders", "order"), re.IGNORECASE)
    found = []
    for message in messages:
        if when(message["date"]) < since:
            continue
        if args.get("mode") == "orders" and not orders.search(message.get("subject", "")):
            continue
        if args.get("mode") == "newsletters" and not message.get("unsubscribe"):
            continue
        found.append(message)
    return found[: args.get("limit", 50)]


def notes(entries: list, args: dict) -> list:
    return entries[: args.get("limit", 50)]


DATA_COMMANDS = {"calendar": calendar, "mail": mail, "notes": notes}


def answer(payload: dict) -> None:
    print(json.dumps(payload))
    sys.exit(0 if payload.get("ok") else 1)


def main() -> None:
    world_path = Path(os.environ["MOI_FAKE_APPS"])
    world = json.loads(world_path.read_text())
    command = sys.argv[1] if len(sys.argv) == 2 else ""
    raw = sys.stdin.read()
    try:
        args = json.loads(raw) if raw.strip() else {}
    except ValueError:
        answer({"ok": False, "kind": "bad_input", "error": "the arguments on stdin must be one JSON object"})
    with Path(f"{world_path}.log").open("a") as log:
        log.write(json.dumps({"command": command, "args": args}) + "\n")
    status = world.setdefault("status", {})
    if command == "status":
        answer({"ok": True, "data": {"calendar": status.get("calendar", "not_asked"), "mail": status.get("mail", "not_asked"), "notes": status.get("notes", "not_asked"), "files": "allowed"}})
    if command == "request":
        capability = args.get("capability")
        if capability not in DATA_COMMANDS:
            answer({"ok": False, "kind": "bad_input", "error": "capability must be calendar, mail or notes"})
        status[capability] = world.get("grant", {}).get(capability, "denied")
        world_path.write_text(json.dumps(world))
        answer({"ok": True, "data": {capability: status[capability]}})
    if command in DATA_COMMANDS:
        if status.get(command, "not_asked") != "allowed":
            answer({"ok": False, "kind": "permission", "error": f"{command.title()} access is {status.get(command, 'not_asked')}"})
        answer({"ok": True, "data": DATA_COMMANDS[command](world.get(command, []), args)})
    if command == "files":
        folders = args.get("folders") or []
        if not folders:
            answer({"ok": False, "kind": "bad_input", "error": "folders must list the folders you opted into"})
        inside = [entry for entry in world.get("files", []) if any(entry["path"].startswith(folder.rstrip("/") + "/") for folder in folders)]
        answer({"ok": True, "data": inside[: args.get("limit", 100)]})
    answer({"ok": False, "kind": "bad_input", "error": f"unknown command {command}"})


if __name__ == "__main__":
    main()
