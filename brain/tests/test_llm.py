import json
import threading

import httpx
import pytest
from pydantic import BaseModel

from helpers import Recorder, ok_reply

from moi_brain.config import Settings, Slot
from moi_brain.llm import Gateway, LlmError, PrivacyBlocked, json_object_text, strip_fence

HOSTED = Slot(base_url="https://models.example.com/v1", model="big", api_key_env="MOI_TEST_KEY", input_cost_per_million=3.0, output_cost_per_million=15.0)


class Answer(BaseModel):
    answer: int


def hosted_gateway(tmp_path, recorder: Recorder, allow: bool) -> Gateway:
    settings = Settings(fast=HOSTED, smart=HOSTED, allow_content_to_hosted=allow)
    return Gateway(settings, tmp_path / "calls.jsonl", httpx.Client(transport=httpx.MockTransport(recorder)))


def local_gateway(tmp_path, services) -> Gateway:
    slot = Slot(base_url=f"{services.base_url}/llm/v1", model="fake")
    return Gateway(Settings(fast=slot, smart=slot), tmp_path / "calls.jsonl", httpx.Client(timeout=5))


def test_strip_fence_and_json_object_text():
    assert strip_fence("```json\n{\"a\": 1}\n```") == '{"a": 1}'
    assert strip_fence("```html\n<p>x</p>```") == "<p>x</p>"
    assert strip_fence("  plain  ") == "plain"
    assert json_object_text('Sure! Here it is: {"a": {"b": 2}} hope that helps') == '{"a": {"b": 2}}'
    assert json_object_text("no json") == "no json"


def test_local_slot_call_is_logged(tmp_path, services):
    gateway = local_gateway(tmp_path, services)
    content = gateway.complete("fast", "echo", [{"role": "user", "content": "hi"}], contains_user_content=True)
    assert json.loads(content) == {"echo": "hi"}
    call = services.model_calls("echo")[0]
    assert call["payload"]["model"] == "fake"
    assert call["payload"]["temperature"] == 0.2
    logged = gateway.recent_calls()
    assert logged[0]["task"] == "echo"
    assert logged[0]["contained_user_content"] is True
    assert logged[0]["error"] is None


def test_hosted_slot_refuses_your_content_without_the_switch(tmp_path):
    recorder = Recorder()
    gateway = hosted_gateway(tmp_path, recorder, allow=False)
    with pytest.raises(PrivacyBlocked):
        gateway.complete("fast", "tag", [{"role": "user", "content": "my items"}], contains_user_content=True)
    assert recorder.requests == []


def test_hosted_slot_allows_structure_only_calls_and_sends_the_key(tmp_path, monkeypatch):
    monkeypatch.setenv("MOI_TEST_KEY", "secret")
    recorder = Recorder(ok_reply("<html>lens</html>"))
    gateway = hosted_gateway(tmp_path, recorder, allow=False)
    assert gateway.complete_text("smart", "lens", [{"role": "user", "content": "layout"}], contains_user_content=False) == "<html>lens</html>"
    request = recorder.requests[0]
    assert request.headers["authorization"] == "Bearer secret"
    assert request.headers["x-moi-task"] == "lens"
    assert str(request.url) == "https://models.example.com/v1/chat/completions"
    assert gateway.recent_calls()[0]["cost_usd"] == pytest.approx(0.0045)


def test_hosted_slot_takes_content_when_the_switch_is_on(tmp_path):
    recorder = Recorder(ok_reply('{"answer": 4}'))
    gateway = hosted_gateway(tmp_path, recorder, allow=True)
    assert gateway.complete_json("fast", "math", [{"role": "user", "content": "2+2"}], True, Answer) == Answer(answer=4)
    assert json.loads(recorder.requests[0].content)["response_format"] == {"type": "json_object"}


def test_local_only_calls_no_hosted_model_at_all(tmp_path):
    recorder = Recorder(ok_reply("<html>lens</html>"))
    gateway = Gateway(Settings(fast=HOSTED, smart=HOSTED, local_only=True, embed=HOSTED), tmp_path / "calls.jsonl", httpx.Client(transport=httpx.MockTransport(recorder)))
    with pytest.raises(PrivacyBlocked, match="local only mode"):
        gateway.complete_text("smart", "lens", [{"role": "user", "content": "layout"}], contains_user_content=False)
    assert gateway.embed("embed", ["a"]) is None and recorder.requests == []


def test_hybrid_lets_only_the_features_you_named_send_item_text(tmp_path):
    recorder = Recorder(ok_reply('{"answer": 4}'))
    gateway = Gateway(Settings(fast=HOSTED, smart=HOSTED, cloud_features=["summaries"]), tmp_path / "calls.jsonl", httpx.Client(transport=httpx.MockTransport(recorder)))
    assert gateway.complete_json("fast", "summarize", [{"role": "user", "content": "article"}], True, Answer) == Answer(answer=4)
    with pytest.raises(PrivacyBlocked):
        gateway.complete_json("fast", "tag", [{"role": "user", "content": "items"}], True, Answer)
    assert [request.headers["x-moi-task"] for request in recorder.requests] == ["summarize"]


def read_item_elsewhere(gateway: Gateway, answers: list[str]) -> None:
    """An agent_read call from a thread no run opted in."""
    try:
        gateway.complete_json("fast", "agent_read", [{"role": "user", "content": "item"}], True, Answer)
        answers.append("sent")
    except PrivacyBlocked:
        answers.append("blocked")


def test_an_agent_run_you_opt_in_may_send_item_text_on_its_own_thread_only(tmp_path):
    recorder = Recorder(ok_reply('{"answer": 4}'))
    gateway = hosted_gateway(tmp_path, recorder, allow=False)
    answers: list[str] = []
    gateway.cloud_for_this_thread(True)
    assert gateway.complete_json("fast", "agent_read", [{"role": "user", "content": "item"}], True, Answer) == Answer(answer=4)
    worker = threading.Thread(target=read_item_elsewhere, args=(gateway, answers))
    worker.start()
    worker.join()
    gateway.cloud_for_this_thread(False)
    with pytest.raises(PrivacyBlocked):
        gateway.complete_json("fast", "agent_read", [{"role": "user", "content": "item"}], True, Answer)
    assert answers == ["blocked"] and len(recorder.requests) == 1


def test_complete_json_retries_once_with_the_error(tmp_path):
    recorder = Recorder(ok_reply("not json at all"), ok_reply('```json\n{"answer": 7}\n```'))
    gateway = hosted_gateway(tmp_path, recorder, allow=True)
    assert gateway.complete_json("fast", "math", [{"role": "user", "content": "q"}], True, Answer).answer == 7
    retry_messages = json.loads(recorder.requests[1].content)["messages"]
    assert [message["role"] for message in retry_messages] == ["user", "assistant", "user"]
    assert "invalid" in retry_messages[-1]["content"]


def test_complete_json_gives_up_after_two_bad_replies(tmp_path):
    recorder = Recorder(ok_reply('{"answer": "seven"}'), ok_reply('{"wrong": 1}'))
    with pytest.raises(LlmError, match="invalid JSON twice"):
        hosted_gateway(tmp_path, recorder, allow=True).complete_json("fast", "math", [], True, Answer)


@pytest.mark.parametrize(
    "reply",
    [httpx.Response(500, text="boom"), httpx.Response(200, json={"choices": []}), httpx.Response(200, text="<html>")],
)
def test_model_failures_raise_and_are_logged(tmp_path, reply):
    gateway = hosted_gateway(tmp_path, Recorder(reply), allow=True)
    with pytest.raises(LlmError):
        gateway.complete("fast", "tag", [], True)
    assert gateway.recent_calls()[-1]["error"]


def test_unreachable_model_raises_llm_error(tmp_path):
    slot = Slot(base_url="http://127.0.0.1:9/v1", model="none")
    gateway = Gateway(Settings(fast=slot, smart=slot), tmp_path / "calls.jsonl", httpx.Client(timeout=1))
    with pytest.raises(LlmError, match="nothing is listening at http://127.0.0.1:9/v1 for the fast slot"):
        gateway.complete("fast", "tag", [], True)


def test_recent_calls_on_a_fresh_log(tmp_path):
    assert hosted_gateway(tmp_path, Recorder(), allow=True).recent_calls() == []


def test_the_call_log_rotates_and_skips_a_line_cut_short(tmp_path, monkeypatch):
    monkeypatch.setattr("moi_brain.llm.MAX_LOG_BYTES", 300)
    gateway = Gateway(Settings(), tmp_path / "calls.jsonl", httpx.Client())
    for index in range(10):
        gateway.log("tag", "fast", gateway.settings.fast, {"prompt_tokens": 1, "completion_tokens": 1}, False, None)
    assert (tmp_path / "calls.jsonl.1").exists()
    assert (tmp_path / "calls.jsonl").stat().st_size <= 600
    with (tmp_path / "calls.jsonl").open("a") as handle:
        handle.write('{"cut short')
    assert all(call["task"] == "tag" for call in gateway.recent_calls())

