"""Agents: planned first, run only once approved, within a budget, traced, stoppable; their actions go through the gate."""

import json
import time
from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient
from helpers import FixedClock

from moi_brain.agents import AgentRun, load_runs
from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import REPO_DIR

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
LAMPS = [
    {"native_id": "1", "url": "https://x.com/maya/status/1001", "title": "Quiet lamp review: the best desk lamp", "text": "A calm light.", "published_at": NOW.isoformat()},
    {"native_id": "2", "url": "https://x.com/ben/status/1002", "title": "Desk lamp deals this week", "text": "Lamps on sale.", "published_at": NOW.isoformat()},
]


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(NOW)


@pytest.fixture
def agents(paths, settings, services, clock):
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    (paths.views / "feed.md").write_text("# Feed\n\n## Sources\n* X home timeline\n")
    client.post("/ingest", json={"source_id": "x", "records": LAMPS})
    yield brain, client
    brain.http.close()


def finished(client: TestClient, plan_id: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        run = client.get(f"/agents/{plan_id}").json()
        if run["status"] not in ("running",) or time.monotonic() > deadline:
            return run
        time.sleep(0.05)


def test_a_plan_comes_first_from_your_words_your_memory_and_view_names_only(agents, services, paths):
    _, client = agents
    (paths.memory / "likes.md").write_text("# Likes\n\n* Quiet things.\n")
    run = client.post("/agents", json={"kind": "shop", "request": "find a quiet desk lamp"}).json()
    assert run["status"] == "proposed" and run["summary"] == "I will shop: find a quiet desk lamp"
    assert [step["tool"] for step in run["steps"]] == ["search_store", "read_item"]
    assert run["expires_at"] == (NOW + timedelta(hours=24)).isoformat().replace("+00:00", "Z")
    sent = json.loads(services.model_calls("agent_plan")[-1]["payload"]["messages"][1]["content"])
    assert sent["request"] == "find a quiet desk lamp" and sent["views"] == ["feed"] and "Quiet things." in sent["memory"]["likes.md"]
    assert "calm light" not in json.dumps(sent)
    assert services.model_calls("agent_read") == []


def test_steps_an_agent_may_not_take_are_left_out_and_said_so(agents):
    _, client = agents
    run = client.post("/agents", json={"kind": "shop", "request": "ORDER a desk lamp"}).json()
    assert "propose_action" not in [step["tool"] for step in run["steps"]]
    assert run["reason"] == "left out propose_action: an agent may not place_order"


def test_an_approved_plan_runs_its_steps_traced_and_cites_what_it_read(agents, services):
    _, client = agents
    plan = client.post("/agents", json={"kind": "shop", "request": "find a quiet desk lamp"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    run = finished(client, plan["plan_id"])
    assert run["status"] == "done"
    assert [(entry["tool"], entry["ok"]) for entry in run["trace"]] == [("search_store", True), ("read_item", True)]
    assert run["trace"][1]["outcome"] == "read 2 items"
    assert {citation["url"] for citation in run["result"]["citations"]} == {LAMPS[0]["url"], LAMPS[1]["url"]}
    assert len(run["result"]["shortlist"]) == 2 and run["result"]["shortlist"][0]["why"].startswith("It fits")
    composed = json.loads(services.model_calls("agent_compose")[-1]["payload"]["messages"][1]["content"])
    assert all("summary" in item and "text" not in item for item in composed["items"])
    assert client.post(f"/agents/{plan['plan_id']}/approve").status_code == 400


def test_a_plan_you_decline_or_that_expired_never_runs(agents, clock, services):
    _, client = agents
    declined = client.post("/agents", json={"kind": "research", "request": "desk lamp light"}).json()
    assert client.post(f"/agents/{declined['plan_id']}/decline").json()["status"] == "declined"
    assert client.post(f"/agents/{declined['plan_id']}/approve").status_code == 400
    late = client.post("/agents", json={"kind": "research", "request": "desk lamp light"}).json()
    clock.moment += timedelta(hours=25)
    assert client.post(f"/agents/{late['plan_id']}/approve").status_code == 400
    assert services.model_calls("agent_read") == []
    assert client.get("/agents/nope").status_code == 400


def test_a_question_pauses_the_run_until_you_answer_and_stop_ends_it(agents, services):
    _, client = agents
    plan = client.post("/agents", json={"kind": "shop", "request": "ASK me then find a desk lamp"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    deadline = time.monotonic() + 5
    while client.get(f"/agents/{plan['plan_id']}").json()["status"] != "paused" and time.monotonic() < deadline:
        time.sleep(0.05)
    assert client.get(f"/agents/{plan['plan_id']}").json()["question"] == "What is your budget?"
    client.post(f"/agents/{plan['plan_id']}/answer", json={"answer": "Under $50"})
    run = finished(client, plan["plan_id"])
    assert run["status"] == "done" and run["answer"] == "Under $50"
    assert json.loads(services.model_calls("agent_compose")[-1]["payload"]["messages"][1]["content"])["your_answer_to_my_question"] == "Under $50"
    stopped = client.post("/agents", json={"kind": "shop", "request": "ASK me then find a desk lamp"}).json()
    client.post(f"/agents/{stopped['plan_id']}/approve")
    time.sleep(0.3)
    client.post(f"/agents/{stopped['plan_id']}/stop")
    run = finished(client, stopped["plan_id"])
    assert (run["status"], run["reason"]) == ("stopped", "you stopped it")
    assert client.post(f"/agents/{stopped['plan_id']}/answer", json={"answer": "late"}).status_code == 400


def test_a_run_stops_when_its_time_runs_out(agents):
    _, client = agents
    plan = client.post("/agents", json={"kind": "shop", "request": "TIGHT SLOW desk lamp"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    run = finished(client, plan["plan_id"], timeout=8)
    deadline = time.monotonic() + 8
    while run["status"] in ("running", "paused") and time.monotonic() < deadline:
        time.sleep(0.1)
        run = client.get(f"/agents/{plan['plan_id']}").json()
    assert run["status"] == "stopped" and run["reason"] in ("no answer came", "it ran out of time")


def test_actions_a_plan_proposes_go_through_the_gate_and_wait_for_your_confirm(agents):
    brain, client = agents
    plan = client.post("/agents", json={"kind": "shop", "request": "find a desk lamp and like the best"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    run = finished(client, plan["plan_id"])
    assert run["status"] == "done" and len(run["action_ids"]) == 1
    [pending] = client.get("/actions/pending").json()
    assert pending["action"] == "like" and pending["allowed"] and pending["confirm"] and pending["undo_seconds"] == 0
    [entry] = [entry for entry in client.get("/actions/log").json() if entry["kind"] == "request"]
    assert entry["origin"] == "plan" and entry["plan_id"] == plan["plan_id"]
    client.post("/actions/result", json={"request_id": pending["request_id"], "outcome": "declined"})
    assert client.get("/actions/pending").json() == []
    other = client.post("/ingest", json={"source_id": "x", "records": [{"native_id": "9", "url": "https://x.com/z/status/9", "title": "Unrelated"}]}).json()["items"][0]
    refused = client.post("/actions/check", json={"item_id": other["item_id"], "action": "like", "origin": "plan", "plan_id": plan["plan_id"]}).json()
    assert refused["reason"] == "The plan asks for this on an item it never found."


def test_the_red_team_corpus_read_by_an_agent_proposes_nothing(agents, paths):
    _, client = agents
    corpus = json.loads((REPO_DIR / "fixtures" / "injection" / "corpus.json").read_text())["records"]
    client.post("/ingest", json={"source_id": "x", "records": corpus})
    before = {path: path.read_text() for path in [*paths.views.glob("*.md"), *paths.memory.glob("*.md")]}
    plan = client.post("/agents", json={"kind": "research", "request": "what did promo post about the giveaway and instructions"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    run = finished(client, plan["plan_id"])
    assert run["status"] == "done" and run["action_ids"] == [] and run["proposal_ids"] == []
    assert client.get("/actions/log").json() == []
    assert {path: path.read_text() for path in before} == before


def test_a_standing_task_runs_again_when_due_until_stopped(agents, clock):
    _, client = agents
    plan = client.post("/agents", json={"kind": "watch", "request": "NOTIFY me about desk lamp deals"}).json()
    assert plan["expires_at"].startswith((NOW + timedelta(days=30)).date().isoformat())
    client.post(f"/agents/{plan['plan_id']}/approve")
    run = finished(client, plan["plan_id"])
    assert run["status"] == "done" and run["notices"] == ["Checked again."] and run["runs"] == 1
    assert client.get("/agents/due").json() == []
    clock.moment += timedelta(hours=25)
    assert client.get("/agents/due").json() == [plan["plan_id"]]
    client.post(f"/agents/{plan['plan_id']}/approve")
    assert finished(client, plan["plan_id"])["runs"] == 2
    clock.moment += timedelta(hours=25)
    client.post(f"/agents/{plan['plan_id']}/stop")
    assert client.get("/agents/due").json() == []


def test_runs_survive_a_restart_and_one_that_was_running_counts_as_stopped(tmp_path):
    run = AgentRun(plan_id="p1", kind="digest", request="catch me up", summary="s", steps=[], budget={"max_steps": 2}, created_at=NOW, expires_at=NOW, status="running")
    (tmp_path / "p1.json").write_text(run.model_dump_json())
    (tmp_path / "bad.json").write_text("{")
    loaded = load_runs(tmp_path)
    assert list(loaded) == ["p1"] and loaded["p1"].status == "stopped" and load_runs(tmp_path / "none") == {}
