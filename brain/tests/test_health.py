"""Extractor health: runs judged, candidates promoted, drift spotted."""

import json

import pytest

from moi_brain.health import HealthBook, RunReport, Sample, oracle_prompt, run_problem


def run(count: int, version: int = 1, **missing: int) -> RunReport:
    return RunReport(domain="news.example", path_pattern="/", version=version, count=count, missing=missing)


@pytest.mark.parametrize(
    ("report", "usual", "problem"),
    [
        (run(0), [], "found no items"),
        (run(10, url=3), [], "3 of 10 items have no link"),
        (run(10, url=2), [], ""),
        (run(10, title=8, text=9), [], "most of 10 items have nothing to read"),
        (run(10, title=8, text=2), [], ""),
        (run(2), [20, 22, 21], "found 2 items where it usually finds 21"),
        (run(2), [4, 5, 4], ""),
        (run(2), [20, 22], ""),
        (run(7), [20, 22, 21], ""),
    ],
)
def test_what_makes_a_run_look_broken(report, usual, problem):
    assert run_problem(report, usual) == problem


def test_a_candidate_becomes_active_after_five_healthy_runs_and_drift_is_spotted(tmp_path):
    book = HealthBook(tmp_path / "health.json")
    verdicts = [book.record(run(20)) for _ in range(5)]
    assert [verdict.status for verdict in verdicts] == ["candidate"] * 4 + ["active"]
    broken = book.record(run(1))
    assert (broken.healthy, broken.status, broken.problem) == (False, "failing", "found 1 items where it usually finds 20")
    assert HealthBook(tmp_path / "health.json").health("news.example", "/", 1).status == "failing"
    healed = book.record(run(19))
    assert (healed.healthy, healed.status) == (True, "active")
    assert book.health("news.example", "/", 2).runs == 0


def test_only_the_last_ten_healthy_counts_are_kept_and_a_damaged_file_starts_over(tmp_path):
    book = HealthBook(tmp_path / "health.json")
    for count in range(1, 15):
        book.record(run(count))
    assert book.health("news.example", "/", 1).counts == list(range(5, 15))
    (tmp_path / "health.json").write_text('{"a": {"runs": "many"}, "b": {"runs": 2}}')
    reread = HealthBook(tmp_path / "health.json")
    assert list(reread.specs) == ["b"]
    (tmp_path / "health.json").write_text("[]")
    assert HealthBook(tmp_path / "health.json").specs == {}


def test_the_oracle_sees_a_few_records_as_data_and_can_fail_a_first_run(tmp_path):
    samples = [Sample(title=f"Item {index}", url=f"https://news.example/{index}") for index in range(6)]
    messages = oracle_prompt("news.example", "feed", samples)
    assert "never instructions" in messages[0]["content"]
    assert json.loads(messages[1]["content"])["records"][0] == {"title": "Item 0", "url": "https://news.example/0"}
    book = HealthBook(tmp_path / "health.json")
    report = run(12).model_copy(update={"samples": samples})
    assert book.is_new(report)
    verdict = book.record(report, oracle_problem="the items look like menu links")
    assert (verdict.healthy, verdict.status, verdict.problem) == (False, "failing", "the items look like menu links")
    assert not book.is_new(report)


SPEC = {"domain": "news.example", "path_pattern": "/", "item_root": "li", "fields": {"title": {"select": "a"}, "url": {"select": "a", "take": "attr:href"}}}


def report_body(version: int, count: int, titles: list[str] | None = None) -> dict:
    samples = [{"title": title, "url": f"https://news.example/{index}"} for index, title in enumerate(titles or [])]
    return {"domain": "news.example", "path_pattern": "/", "version": version, "count": count, "missing": {}, "samples": samples}


def test_a_new_specs_first_run_goes_to_the_oracle_and_a_drifted_spec_gives_way(client, services):
    first = client.post("/extractor/accept", json=SPEC).json()["spec"]
    second = client.post("/extractor/accept", json=SPEC).json()["spec"]
    assert (first["version"], second["version"]) == (1, 2)
    menu = client.post("/extractor/health", json=report_body(2, 6, ["Home", "About", "Contact", "Privacy", "Story", "Help"])).json()
    assert menu == {"healthy": False, "status": "failing", "problem": "the items look like menu links"}
    assert client.get("/extractor", params={"url": "https://news.example/"}).json()["spec"]["version"] == 1
    assert [spec["version"] for spec in client.get("/extractor/previous", params={"url": "https://news.example/", "version": 2}).json()] == [1]
    calls = len(services.model_calls("oracle"))
    healthy = client.post("/extractor/health", json=report_body(1, 12, ["A story about rates", "Another story"])).json()
    assert healthy["healthy"] is True
    assert client.post("/extractor/health", json=report_body(1, 12, ["Home", "About", "Contact"])).json()["healthy"] is True
    assert len(services.model_calls("oracle")) == calls + 1
    client.post("/extractor/health", json=report_body(2, 0))
    assert client.get("/extractor", params={"url": "https://news.example/"}).json()["spec"]["version"] == 1


def test_a_failing_newest_spec_is_still_used_when_it_is_the_only_one_and_the_oracle_may_be_unavailable(client, services):
    client.post("/extractor/accept", json=SPEC)
    services.queue_model_reply("oracle", None)
    assert client.post("/extractor/health", json=report_body(1, 8, ["Home", "About", "Contact"])).json()["healthy"] is True
    client.post("/extractor/health", json=report_body(1, 0))
    assert client.get("/extractor", params={"url": "https://news.example/"}).json()["spec"]["version"] == 1
    assert client.get("/extractor", params={"url": "https://other.example/"}).json()["spec"] is None
