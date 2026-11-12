"""Agents: planned first, run only once approved, within a budget, traced, stoppable; their actions go through the gate."""

import json
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient
from helpers import FixedClock

from moi_brain.agents import (
    AgentRun,
    AgentRunner,
    Budget,
    ComposerReply,
    ItemSummary,
    PlanStep,
    load_runs,
)
from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.compile import BadInput
from moi_brain.config import REPO_DIR
from moi_brain.items import Item
from moi_brain.llm import InvalidReply

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
    _, client = agents
    plan = client.post("/agents", json={"kind": "shop", "request": "find a desk lamp and like the best"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    run = finished(client, plan["plan_id"])
    assert run["status"] == "done" and len(run["action_ids"]) == 1
    [pending] = client.get("/actions/pending").json()
    assert pending["action"] == "like" and pending["allowed"] and pending["confirm"] and pending["undo_seconds"] == 0
    assert (pending["origin"], pending["plan_id"], pending["text"]) == ("plan", plan["plan_id"], "")
    # The like goes to the composer's first pick; the reply it was talked into by what it read goes nowhere.
    assert pending["url"] == run["result"]["shortlist"][0]["url"]
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


def test_two_approves_at_once_start_one_run_and_stop_reaches_it(agents):
    brain, client = agents
    plan = client.post("/agents", json={"kind": "shop", "request": "ASK me then find a desk lamp"}).json()
    results = []
    start = threading.Barrier(6)

    def approve() -> None:
        start.wait()
        try:
            brain.approve_agent(plan["plan_id"])
            results.append("ran")
        except BadInput:
            results.append("refused")

    threads = [threading.Thread(target=approve) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == ["ran"] + ["refused"] * 5
    client.post(f"/agents/{plan['plan_id']}/stop")
    run = finished(client, plan["plan_id"])
    assert (run["status"], run["reason"], run["runs"]) == ("stopped", "you stopped it", 1)


def test_stop_counts_while_the_result_is_written_and_withdraws_what_waits_for_your_confirm(agents, monkeypatch):
    brain, client = agents
    composing, release = threading.Event(), threading.Event()
    compose = brain.compose

    def slow_compose(run, sources):
        composing.set()
        release.wait(5)
        return compose(run, sources)

    monkeypatch.setattr(brain, "compose", slow_compose)
    plan = client.post("/agents", json={"kind": "shop", "request": "find a desk lamp and like the best"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    assert composing.wait(5)
    client.post(f"/agents/{plan['plan_id']}/stop")
    release.set()
    run = finished(client, plan["plan_id"])
    assert (run["status"], run["reason"], run["action_ids"]) == ("stopped", "you stopped it", [])
    assert client.get("/actions/log").json() == []

    monkeypatch.setattr(brain, "compose", compose)
    liked = client.post("/agents", json={"kind": "shop", "request": "find a desk lamp and like the best"}).json()
    client.post(f"/agents/{liked['plan_id']}/approve")
    assert finished(client, liked["plan_id"])["status"] == "done"
    assert len(client.get("/actions/pending").json()) == 1
    client.post(f"/agents/{liked['plan_id']}/stop")
    assert client.get("/actions/pending").json() == []
    [result] = [entry for entry in client.get("/actions/log").json() if entry["kind"] == "result"]
    assert (result["outcome"], result["detail"]) == ("declined", "you stopped the agent")


def test_actions_waiting_when_openmoi_restarts_are_closed_not_left_open(agents, paths, settings, services, clock):
    _, client = agents
    plan = client.post("/agents", json={"kind": "shop", "request": "find a desk lamp and like the best"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    assert finished(client, plan["plan_id"])["status"] == "done"
    again = Brain(paths, settings, youtube_base=services.base_url, clock=clock)
    try:
        results = [entry for entry in again.audit.entries() if entry["kind"] == "result"]
        assert [(entry["outcome"], entry["detail"]) for entry in results] == [("declined", "openMoi restarted before you confirmed")]
        assert again.pending_plan_actions() == []
    finally:
        again.http.close()


def test_a_standing_task_starts_each_run_fresh_and_notifies_only_when_it_found_what_it_watches(agents, clock):
    _, client = agents
    quiet = client.post("/agents", json={"kind": "watch", "request": "NOTIFY me about desk lamp NOTHING"}).json()
    client.post(f"/agents/{quiet['plan_id']}/approve")
    run = finished(client, quiet["plan_id"])
    assert run["status"] == "done" and run["notices"] == [] and run["trace"][-1]["outcome"] == "tells you if it happened"
    plan = client.post("/agents", json={"kind": "watch", "request": "NOTIFY me about desk lamp deals"}).json()
    client.post(f"/agents/{plan['plan_id']}/approve")
    first = finished(client, plan["plan_id"])
    assert first["notices"] == ["Checked again."] and first["refs"]
    client.post("/ingest", json={"source_id": "x", "records": [{"native_id": "3", "url": "https://x.com/kim/status/1003", "title": "Desk lamp deals, new today", "published_at": NOW.isoformat()}]})
    clock.moment += timedelta(hours=25)
    client.post(f"/agents/{plan['plan_id']}/approve")
    second = finished(client, plan["plan_id"])
    assert second["runs"] == 2 and second["notices"] == ["Checked again."] and len(second["trace"]) == len(first["trace"])
    assert second["cost_usd"] == first["cost_usd"] == 0.0


def test_a_standing_task_that_failed_or_was_cut_off_by_a_restart_is_still_due(agents, clock, tmp_path, monkeypatch):
    brain, client = agents
    plan = client.post("/agents", json={"kind": "watch", "request": "NOTIFY me about desk lamp deals"}).json()

    def broken(item):
        raise OSError("disk full")

    monkeypatch.setattr(brain, "summarize_item", broken)
    client.post(f"/agents/{plan['plan_id']}/approve")
    run = finished(client, plan["plan_id"])
    assert (run["status"], run["reason"]) == ("failed", "disk full")
    clock.moment += timedelta(hours=25)
    assert client.get("/agents/due").json() == [plan["plan_id"]]
    cut = AgentRun(plan_id="w1", kind="watch", request="r", summary="s", steps=[], budget=Budget(), created_at=NOW, expires_at=NOW + timedelta(days=30), status="running")
    (tmp_path / "w1.json").write_text(cut.model_dump_json())
    [loaded] = load_runs(tmp_path).values()
    assert loaded.status == "stopped" and loaded.next_run_at == NOW


def test_plans_keep_to_their_step_budget(agents):
    brain, _ = agents
    steps = [PlanStep(tool="notify", args={"text": str(index)}) for index in range(5)]
    kept, dropped = brain.checked_steps(steps, ["feed"], Budget(max_steps=3))
    assert [step.args["text"] for step in kept] == ["0", "1", "2"]
    assert dropped == ["left out notify: beyond its budget of 3 steps"] * 2
    planned_like = brain.checked_steps([PlanStep(tool="propose_action", args={"action": "like"})], ["feed"], Budget())
    assert planned_like[1] == []


class FakeHost:
    """A brain for one runner: each model call costs a cent, and a summary can fail after its calls were paid."""

    def __init__(self, summarize_error: Exception | None = None):
        self.cost = 0.0
        self.summarize_error = summarize_error
        self.saved: list[str] = []
        self.items = {f"i{index}": Item(item_id=f"i{index}", source_id="x", native_id=str(index), url=f"https://x.com/a/status/{index}", title=f"Item {index}", kind="post", fetched_at=NOW) for index in range(30)}

    def clock(self) -> datetime:
        return NOW

    def spent(self) -> float:
        return self.cost

    def find_items(self, query, view_id, limit):
        return list(self.items.values())[:limit]

    def get_item(self, item_id):
        return self.items.get(item_id)

    def summarize_item(self, item):
        self.cost += 0.02
        if self.summarize_error:
            raise self.summarize_error
        return ItemSummary(summary="s")

    def compose(self, run, sources):
        self.cost += 0.01
        return ComposerReply(answer="a", shortlist=[])

    def save_run(self, run):
        self.saved.append(run.status)

    def cloud_for_this_thread(self, on):
        self.cloud = on


def runner_for(host: FakeHost, steps: list[dict]) -> AgentRunner:
    run = AgentRun(plan_id="p", kind="research", request="r", summary="s", steps=steps, budget=Budget(), created_at=NOW, expires_at=NOW + timedelta(hours=1), status="running")
    return AgentRunner(host, run)


def test_failed_model_calls_count_against_the_budget_and_read_limits_stay_in_range():
    host = FakeHost(InvalidReply("not JSON, twice"))
    runner = runner_for(host, [{"tool": "search_store", "args": {"query": "a", "limit": 20}}, {"tool": "read_item", "args": {"limit": -5}}, {"tool": "read_item", "args": {"limit": 500}}])
    runner.work()
    assert runner.run.status == "done" and runner.run.cost_usd == pytest.approx(0.04)
    assert [entry.ok for entry in runner.run.trace] == [True, False, False]
    paid = FakeHost()
    reading = runner_for(paid, [{"tool": "search_store", "args": {"query": "a", "limit": 20}}, {"tool": "read_item", "args": {"limit": 500}}])
    reading.run.budget.max_cost_usd = 1.0
    reading.work()
    assert reading.run.trace[1].outcome == "read 20 items" and reading.run.cost_usd == pytest.approx(0.41)


def test_an_unexpected_error_ends_the_run_as_failed_never_left_running():
    runner = runner_for(FakeHost(OSError("disk full")), [{"tool": "search_store", "args": {"query": "a"}}, {"tool": "read_item", "args": {"limit": 1}}])
    runner.work()
    assert (runner.run.status, runner.run.reason, len(runner.run.trace)) == ("failed", "disk full", 1)
    crashing = runner_for(FakeHost(), [{"tool": "search_store", "args": {"query": "a"}}])
    crashing.host.find_items = lambda *args: (_ for _ in ()).throw(RuntimeError("database is locked"))
    crashing.work()
    assert (crashing.run.status, crashing.run.reason) == ("failed", "database is locked")


def test_a_hosted_read_you_allow_holds_for_one_run_only(agents, clock):
    _, client = agents
    plan = client.post("/agents", json={"kind": "watch", "request": "NOTIFY me about desk lamp deals"}).json()
    assert client.post(f"/agents/{plan['plan_id']}/approve", json={"cloud": True}).json()["cloud"] is True
    assert finished(client, plan["plan_id"])["status"] == "done"
    clock.moment += timedelta(hours=25)
    assert client.post(f"/agents/{plan['plan_id']}/approve").json()["cloud"] is False
