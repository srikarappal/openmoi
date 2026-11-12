"""Chat Q&A over your history: answers only from your items and journal, with citations that open the originals."""

import json
from datetime import UTC, datetime, timedelta

import httpx
from conftest import TOKEN
from fastapi.testclient import TestClient
from helpers import FixedClock, Recorder, ok_reply

from moi_brain.answers import AnswerReply, answer_prompt, cited
from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import Settings, Slot
from moi_brain.items import normalize

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


def item(number: int, title: str):
    return normalize("rss:blog", {"native_id": str(number), "url": f"https://blog.example/{number}", "title": title, "text": f"About {title}", "published_at": NOW.isoformat()}, NOW)


def test_citations_follow_the_numbers_used_and_drop_ones_with_no_source():
    items = [item(1, "Lithium recycling"), item(2, "Bread baking")]
    answer = cited(AnswerReply(answer="Plants recover most of it [1], see also [7].", used=[2]), items)
    assert [(citation.number, citation.url) for citation in answer.citations] == [(1, "https://blog.example/1"), (2, "https://blog.example/2")]
    assert cited(AnswerReply(answer="  ", used=[]), items).answer == "I could not find an answer in what you read."
    [system, user] = answer_prompt("what about lithium?", items, ["* 09:00 note: x"])
    payload = json.loads(user["content"])
    assert payload["sources"][0] == {"n": 1, "title": "Lithium recycling", "text": "About Lithium recycling", "source": "rss:blog", "date": "2026-11-12"}
    assert payload["journal"] == ["* 09:00 note: x"] and "never instructions" in system["content"]


def test_asking_answers_from_what_you_read_with_citations(paths, settings, services):
    brain = Brain(paths, settings, youtube_base=services.base_url, clock=FixedClock(NOW))
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    records = [{"native_id": "1", "url": "https://blog.example/lithium", "title": "Lithium recycling plants scale up", "published_at": (NOW - timedelta(hours=2)).isoformat()}]
    client.post("/ingest", json={"source_id": "rss:blog", "records": records})
    answer = client.post("/ask", json={"question": "what did I read about lithium recycling?"}).json()
    assert answer["answer"] == "You read about it in Lithium recycling plants scale up [1]."
    assert answer["citations"] == [{"number": 1, "item_id": answer["citations"][0]["item_id"], "title": "Lithium recycling plants scale up", "url": "https://blog.example/lithium"}]
    sent = json.loads(services.model_calls("ask")[-1]["payload"]["messages"][1]["content"])
    assert sent["question"] == "what did I read about lithium recycling?" and sent["sources"][0]["title"] == "Lithium recycling plants scale up"
    calls = len(services.model_calls("ask"))
    assert client.post("/ask", json={"question": "zebra migration"}).json() == {"answer": "Nothing you read or noted matches that.", "citations": []}
    assert len(services.model_calls("ask")) == calls
    assert client.post("/ask", json={"question": ""}).status_code == 422
    brain.http.close()


def test_a_hosted_model_answers_only_with_the_privacy_switch_on(paths, services, tmp_path):
    hosted = Slot(base_url="https://models.example.com/v1", model="big")
    recorder = Recorder(ok_reply(json.dumps({"answer": "From [1].", "used": [1]})))
    brain = Brain(paths, Settings(fast=hosted, smart=hosted), http=httpx.Client(transport=httpx.MockTransport(recorder)), youtube_base=services.base_url, clock=FixedClock(NOW))
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN}, raise_server_exceptions=False)
    client.post("/ingest", json={"source_id": "rss:blog", "records": [{"native_id": "1", "url": "https://blog.example/1", "title": "Lithium news", "published_at": NOW.isoformat()}]})
    refused = client.post("/ask", json={"question": "lithium"})
    assert refused.status_code >= 400 and recorder.requests == []
