"""Rules that use model judgments: declared by the rules compiler, answered by the tagging pass, tested by ranking."""

import json
import math
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from conftest import wait_until_refreshed
from fastapi.testclient import TestClient
from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st
from pydantic import ValidationError

from moi_brain.api import create_app
from moi_brain.brain import Brain, needs_tags
from moi_brain.compile import CompiledView, Condition, Judgment, Rule, usable_rules
from moi_brain.items import normalize
from moi_brain.llm import Gateway
from moi_brain.rank import describe, matches, rank
from moi_brain.store import Store
from moi_brain.tag import Tagger, is_judged, normalize_answer, read_state, tag_prompt, watch_judgments

NOW = datetime.now(UTC)
EVENT = Judgment(name="event", question="Is this about an event or a birthday?")
PRICE = Judgment(name="price", question="What is the monthly rent in dollars?", answer="number")
PETS = Judgment(name="pets", question="Does this listing allow pets?")
FACEBOOK = "https://www.facebook.com/events"
FACEBOOK_ID = "page:facebook.com/events"


def make_item(native_id: str, text: str, extra: dict | None = None, source_id: str = "rss:a"):
    record = {"native_id": native_id, "url": f"https://a.com/{native_id}", "text": text, "published_at": (NOW - timedelta(hours=1)).isoformat()}
    item = normalize(source_id, record, NOW)
    return item.model_copy(update={"extra": extra or {}})


def hide_when(field: str, op: str, value) -> Rule:
    return Rule(when=Condition(field=field, op=op, value=value), do="hide")


def wait_idle(tagger: Tagger, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while tagger.busy and time.monotonic() < deadline:
        time.sleep(0.01)


class Watched:
    """The tagger's changeable judgments, standing in for the brain's compiled views."""

    def __init__(self, judgments: list[Judgment]):
        self.judgments = judgments

    def __call__(self) -> list[Judgment]:
        return self.judgments


def topics() -> list[str]:
    return ["politics"]


@pytest.fixture
def watched() -> Watched:
    return Watched([EVENT])


@pytest.fixture
def tagger(tmp_path, settings, watched):
    with httpx.Client(timeout=5) as http:
        yield Tagger(Store(tmp_path / "db.sqlite"), Gateway(settings, tmp_path / "calls.jsonl", http), tmp_path / "tagged.json", topics, watched)


# Declaring judgments


def test_conditions_take_fixed_fields_or_a_judged_name():
    assert Condition(field="judged:pets", op="eq", value="no").field == "judged:pets"
    assert Condition(field="judged:job_change2", op="eq", value="yes").field == "judged:job_change2"
    assert Condition(field="judged:Pets Allowed", op="eq", value="no").field == "judged:pets_allowed"
    for bad in ("judged:", "judged:2pets", "judged:???", "weather", "extra.price", "Topic"):
        with pytest.raises(ValidationError):
            Condition(field=bad, op="eq", value="x")


def test_judgments_need_a_simple_name_and_a_real_question():
    assert Judgment(name="pets", question="Pets ok?").answer == "yes_no"
    assert Judgment(name=" Pets-Allowed ", question="  Pets ok?  ").model_dump() == {"name": "pets_allowed", "question": "Pets ok?", "answer": "yes_no"}
    assert len(Judgment(name="pets", question="Why? " * 100).question) == 200
    for name, question in (("2pets", "Pets ok?"), ("pets", "?"), ("a" * 41, "Pets ok?"), (7, "Pets ok?"), ("pets", None)):
        with pytest.raises(ValidationError):
            Judgment(name=name, question=question)


def test_a_model_naming_judgments_loosely_still_compiles(client, paths, services):
    reply = {
        "rules": [{"when": {"field": "judged:Pets Allowed", "op": "eq", "value": "no"}, "do": "hide"}],
        "judgments": [{"name": "Pets Allowed", "question": "Does it allow pets?", "answer": "yes_no"}],
        "summary": "Pets ok.",
    }
    services.queue_model_reply("compile_rules", json.dumps(reply))
    (paths.views / "hunt.md").write_text("# Hunt\n\n## Rules\n* Pets ok.\n")
    compiled = client.app.state.brain.compiler.compiled("hunt")
    assert [judgment.name for judgment in compiled.judgments] == ["pets_allowed"]
    assert compiled.rules[0].when.field == "judged:pets_allowed"


def test_usable_rules_keep_only_judgments_a_rule_tests_and_drop_rules_testing_undeclared_ones():
    declared_rule = hide_when("judged:event", "eq", "no")
    undeclared_rule = hide_when("judged:angry", "eq", "yes")
    unless_rule = Rule(when=Condition(field="topic", op="eq", value="politics"), unless=Condition(field="judged:price", op="lt", value=10), do="hide")
    rules, judgments = usable_rules([declared_rule, undeclared_rule, unless_rule], [EVENT, PETS, PRICE])
    assert rules == [declared_rule, unless_rule]
    assert judgments == [EVENT, PRICE]


def test_usable_rules_let_the_first_declaration_of_a_name_win():
    later = Judgment(name="event", question="Is it a concert?")
    assert usable_rules([hide_when("judged:event", "eq", "no")], [EVENT, later])[1] == [EVENT]


def test_the_rules_compiler_declares_judgments_from_plain_words(client, paths):
    (paths.views / "events.md").write_text(f"# Events\n\n## Sources\n* Page: {FACEBOOK}\n\n## Rules\n* Only events and birthdays.\n* Under $3k.\n")
    compiled = client.app.state.brain.compiler.compiled("events")
    assert [judgment.name for judgment in compiled.judgments] == ["event", "price"]
    assert [rule.when.field for rule in compiled.rules] == ["judged:event", "judged:price"]
    assert compiled.rules[1].when.value == 3000


def test_a_compile_that_breaks_keeps_the_previous_judgments(client, paths, services):
    brain = client.app.state.brain
    (paths.views / "events.md").write_text(f"# Events\n\n## Sources\n* Page: {FACEBOOK}\n\n## Rules\n* Only events and birthdays.\n")
    assert brain.compiler.compiled("events").judgments == [EVENT]
    services.queue_model_reply("compile_rules", None)
    (paths.views / "events.md").write_text(f"# Events\n\n## Sources\n* Page: {FACEBOOK}\n\n## Rules\n* Only events and birthdays.\n* No shorts.\n")
    broken = brain.compiler.compiled("events")
    assert broken.judgments == [EVENT]
    assert any("Rules not updated" in warning for warning in broken.warnings)


# Answers


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("Yes", "yes"), (" NO ", "no"), (True, "yes"), (False, "no"), ("maybe", "unknown"), (None, "unknown"), (1, "unknown"), ("", "unknown")],
)
def test_yes_no_answers_are_yes_no_or_unknown(raw, expected):
    assert normalize_answer(EVENT, raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("$2,800/mo", "2800"),
        ("3k", "3000"),
        ("3.5K a month", "3500"),
        (2800, "2800"),
        (12.5, "12.5"),
        ("-5", "-5"),
        (True, "unknown"),
        (None, "unknown"),
        ("n/a", "unknown"),
        (math.inf, "unknown"),
        (math.nan, "unknown"),
    ],
)
def test_number_answers_are_plain_numbers_or_unknown(raw, expected):
    assert normalize_answer(PRICE, raw) == expected


@hypothesis_settings(max_examples=200, deadline=None)
@given(raw=st.one_of(st.none(), st.booleans(), st.integers(), st.floats(allow_nan=True, allow_infinity=True), st.text(max_size=30)))
def test_any_answer_normalizes_to_something_a_rule_can_read(raw):
    assert normalize_answer(EVENT, raw) in ("yes", "no", "unknown")
    number = normalize_answer(PRICE, raw)
    assert number == "unknown" or math.isfinite(float(number))


def test_the_tag_prompt_asks_questions_only_when_rules_need_them():
    item = make_item("1", "Birthday party at noon")
    assert "questions" not in json.loads(tag_prompt([item], ["politics"])[1]["content"])
    asked = json.loads(tag_prompt([item], ["politics"], [EVENT, PRICE])[1]["content"])["questions"]
    assert asked == [EVENT.model_dump(), PRICE.model_dump()]


def test_tagging_answers_every_question_and_keeps_what_the_item_already_holds(tagger):
    party = make_item("1", "Birthday party at noon", {"price_text": "$5"})
    lecture = make_item("2", "Senate vote on the budget")
    tagged = {item.item_id: item for item in tagger.tag([party, lecture], ["politics"], [EVENT, PRICE])}
    assert tagged[party.item_id].extra == {"price_text": "$5", "judged:event": "yes", "judged:price": "unknown"}
    assert tagged[lecture.item_id].extra == {"judged:event": "no", "judged:price": "unknown"}
    assert tagged[lecture.item_id].topics == ["politics"]


def test_answers_the_model_skipped_or_made_up_are_settled(tagger, services):
    item = make_item("1", "Rooftop concert, $40")
    reply = {"tags": [{"item_id": item.item_id, "topics": [], "answers": {"price": 40, "invented": "yes"}}]}
    services.queue_model_reply("tag", json.dumps(reply))
    [tagged] = tagger.tag([item], ["politics"], [EVENT, PRICE])
    assert tagged.extra == {"judged:event": "unknown", "judged:price": "40"}
    services.queue_model_reply("tag", json.dumps({"tags": []}))
    [missing] = tagger.tag([item], ["politics"], [EVENT])
    assert missing.tagged and missing.extra == {"judged:event": "unknown"}


def test_the_worker_saves_answers_next_to_extracted_fields(tagger):
    item = make_item("1", "Meetup on Friday", {"site": "a.com"})
    tagger.store.upsert_items([item])
    tagger.enqueue([item])
    wait_idle(tagger)
    assert tagger.store.get_item(item.item_id).extra == {"site": "a.com", "judged:event": "yes"}


def test_a_new_or_reworded_question_sends_recent_items_back_but_an_unchanged_one_does_not(tagger, services, tmp_path):
    item = make_item("1", "Meetup on Friday")
    tagger.store.upsert_items([item])
    tagger.ensure_current(["politics"], NOW, [EVENT])
    wait_idle(tagger)
    assert len(services.model_calls("tag")) == 1
    assert json.loads((tmp_path / "tagged.json").read_text())["questions"] == {"event": EVENT.question}
    tagger.ensure_current(["politics"], NOW, [EVENT])
    wait_idle(tagger)
    assert len(services.model_calls("tag")) == 1
    tagger.ensure_current(["politics"], NOW, [EVENT.model_copy(update={"question": "Is this a concert?"})])
    wait_idle(tagger)
    assert len(services.model_calls("tag")) == 2
    tagger.ensure_current(["politics"], NOW, [])
    wait_idle(tagger)
    assert len(services.model_calls("tag")) == 2
    assert json.loads((tmp_path / "tagged.json").read_text())["questions"] == {}


def test_catching_up_judges_items_tagged_before_a_question_existed(tagger, services):
    item = make_item("1", "Meetup on Friday").model_copy(update={"tagged": True})
    tagger.store.upsert_items([item])
    tagger.tagged_topics, tagger.tagged_questions = ["politics"], {"event": EVENT.question}
    tagger.ensure_current(["politics"], NOW, [EVENT])
    wait_idle(tagger)
    assert tagger.store.get_item(item.item_id).extra == {"judged:event": "yes"}
    tagger.ensure_current(["politics"], NOW, [EVENT])
    wait_idle(tagger)
    assert len(services.model_calls("tag")) == 1


def test_saved_state_from_every_version_is_read(tmp_path):
    state = tmp_path / "state.json"
    state.write_text('["politics", "art"]')
    assert read_state(state) == (["politics", "art"], {})
    state.write_text('{"topics": ["art"], "questions": {"event": "Is it?"}}')
    assert read_state(state) == (["art"], {"event": "Is it?"})
    state.write_text('{"topics": ["art"], "questions": ["bad"]}')
    assert read_state(state) == (["art"], {})
    state.write_text("42")
    assert read_state(state)[1] == {}


def test_every_view_asks_its_judgments_once(watched):
    first = CompiledView(view_id="a", title="A", file_hash="h", judgments=[EVENT, PRICE])
    second = CompiledView(view_id="b", title="B", file_hash="h", judgments=[EVENT.model_copy(update={"question": "Concert?"}), PETS])
    assert watch_judgments([first, second]) == [EVENT, PETS, PRICE]


def test_update_tags_merges_answers_and_ignores_other_fields(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    item = make_item("1", "Meetup", {"site": "a.com"})
    store.upsert_items([item])
    fresh = item.model_copy(update={"topics": ["science"], "extra": {"judged:event": "yes", "site": "evil.com"}})
    store.update_tags([fresh, make_item("missing", "Gone")])
    saved = store.get_item(item.item_id)
    assert (saved.topics, saved.tagged, saved.extra) == (["science"], True, {"site": "a.com", "judged:event": "yes"})


# Ranking on answers


def test_rules_test_answers_by_equality_and_by_number():
    cheap = make_item("1", "Flat", {"judged:price": "2800", "judged:pets": "yes"})
    dear = make_item("2", "Loft", {"judged:price": "3500", "judged:pets": "no"})
    unknown = make_item("3", "Room", {"judged:price": "unknown", "judged:pets": "unknown"})
    over = Condition(field="judged:price", op="gt", value=3000)
    under = Condition(field="judged:price", op="lt", value=3000)
    no_pets = Condition(field="judged:pets", op="eq", value="No")
    either = Condition(field="judged:pets", op="in", value=["yes", "unknown"])
    assert [matches(over, item, NOW) for item in (cheap, dear, unknown)] == [False, True, False]
    assert [matches(under, item, NOW) for item in (cheap, dear, unknown)] == [True, False, False]
    assert [matches(no_pets, item, NOW) for item in (cheap, dear, unknown)] == [False, True, False]
    assert [matches(either, item, NOW) for item in (cheap, dear, unknown)] == [True, False, True]
    assert not matches(Condition(field="judged:price", op="gt", value="lots"), dear, NOW)
    assert not matches(Condition(field="judged:size", op="eq", value="no"), dear, NOW)


def test_ranking_hides_by_answers_and_explains_boosts_in_plain_words():
    items = [make_item("1", "Flat", {"judged:pets": "yes"}), make_item("2", "Loft", {"judged:pets": "no"})]
    boost = Rule(when=Condition(field="judged:pets", op="eq", value="yes"), do="boost", weight=5)
    page, _ = rank(items, [hide_when("judged:pets", "eq", "no"), boost], NOW)
    assert [entry.item.text for entry in page] == ["Flat"]
    assert page[0].reasons[0] == "boost: pets yes"
    assert describe(Condition(field="judged:price", op="lt", value=3000)) == "price 3000"


def test_a_view_needs_tags_for_topic_rules_or_judgments():
    plain = CompiledView(view_id="a", title="A", file_hash="h", rules=[hide_when("text", "contains", "x")])
    assert not needs_tags(plain)
    assert needs_tags(plain.model_copy(update={"judgments": [EVENT]}))
    assert needs_tags(plain.model_copy(update={"rules": [hide_when("topic", "eq", "art")]}))
    assert is_judged(make_item("1", "x", {"judged:event": "no"}), [EVENT])
    assert not is_judged(make_item("1", "x"), [EVENT])


# Journeys through the API


def facebook_posts() -> list[dict]:
    texts = ["Maya's birthday party on Saturday", "Look at my lunch", "Community meetup at the library", "Outrage: they destroyed the park"]
    published = NOW - timedelta(hours=2)
    return [
        {"native_id": f"fb{index}", "url": f"https://www.facebook.com/posts/{index}", "text": text, "published_at": (published + timedelta(minutes=index)).isoformat()}
        for index, text in enumerate(texts)
    ]


def view_texts(client, view_id: str) -> list[str]:
    page = wait_until_refreshed(client, view_id)
    return sorted(entry["item"]["text"] for entry in page["items"])


def test_facebook_unbundled_to_events_and_birthdays(client, paths):
    """You keep Facebook only for events and birthdays: the rest never reaches you, even before the model looked at it."""
    (paths.views / "events.md").write_text(f"# Events\n\n## Sources\n* Page: {FACEBOOK}\n\n## Rules\n* Only events and birthdays.\n")
    client.post("/ingest", json={"source_id": FACEBOOK_ID, "records": facebook_posts(), "page_url": FACEBOOK})
    assert view_texts(client, "events") == ["Community meetup at the library", "Maya's birthday party on Saturday"]


def test_a_hand_added_rule_judges_what_is_already_there(client, paths, services):
    """Adding "no rage bait" by hand asks the new question of recent items and hides the angry one."""
    (paths.views / "fb.md").write_text(f"# FB\n\n## Sources\n* Page: {FACEBOOK}\n\n## Rules\n* No shorts.\n")
    client.post("/ingest", json={"source_id": FACEBOOK_ID, "records": facebook_posts(), "page_url": FACEBOOK})
    assert len(view_texts(client, "fb")) == 4
    (paths.views / "fb.md").write_text(f"# FB\n\n## Sources\n* Page: {FACEBOOK}\n\n## Rules\n* No shorts.\n* Hide rage bait.\n")
    texts = view_texts(client, "fb")
    assert "Outrage: they destroyed the park" not in texts and len(texts) == 3
    asked = [json.loads(call["payload"]["messages"][-1]["content"]).get("questions", []) for call in services.model_calls("tag")]
    assert {"name": "angry", "question": "Is this written to make people angry?", "answer": "yes_no"} in asked[-1]


def test_apartment_hunt_across_two_sites(client, paths):
    """Two listing sites, one hunt: under $3k with pets ok; a listing that does not say about pets still shows."""
    craigslist, zillow = "https://sfbay.craigslist.org/search/apa", "https://www.zillow.com/homes/for_rent"
    (paths.views / "hunt.md").write_text(f"# Hunt\n\n## Sources\n* Page: {craigslist}\n* Page: {zillow}\n\n## Rules\n* Under $3,000 a month.\n* Pets ok.\n")
    listings = {
        "page:sfbay.craigslist.org/search/apa": ["Sunny 1BR $2,800, pets ok", "Loft $3,400, pets ok", "Studio $2,100, no pets"],
        "page:zillow.com/homes/for_rent": ["Garden flat $2,950", "Penthouse $9,000"],
    }
    for source_id, texts in listings.items():
        records = [{"native_id": text, "url": f"https://listings.example/{index}{source_id[-3:]}", "text": text} for index, text in enumerate(texts)]
        client.post("/ingest", json={"source_id": source_id, "records": records})
    assert view_texts(client, "hunt") == ["Garden flat $2,950", "Sunny 1BR $2,800, pets ok"]


def test_while_the_model_is_down_items_show_unjudged_with_a_warning(client, paths, services):
    (paths.views / "events.md").write_text(f"# Events\n\n## Sources\n* Page: {FACEBOOK}\n\n## Rules\n* Only events and birthdays.\n")
    client.app.state.brain.compiler.compiled("events")
    for _ in range(3):
        services.queue_model_reply("tag", None)
    client.post("/ingest", json={"source_id": FACEBOOK_ID, "records": facebook_posts(), "page_url": FACEBOOK})
    page = wait_until_refreshed(client, "events")
    assert len(page["items"]) == 4
    assert any(warning.startswith("Topic tagging paused") for warning in page["warnings"])


def test_a_mine_page_with_judged_rules_is_filtered_the_first_time_it_shows(client, paths):
    (paths.views / "site_listings.example.md").write_text("# listings.example\n\n## Rules\n* Pets ok.\n")
    records = [{"native_id": text, "url": f"https://listings.example/{index}", "title": text} for index, text in enumerate(["Flat, no pets", "House, pets ok", "Room"])]
    body = {"source_id": "site:listings.example", "records": records, "page_url": "https://listings.example/", "view_id": "site_listings.example"}
    shown = client.post("/ingest", json=body).json()["view_items"]
    assert [entry["item"]["title"] for entry in shown] == ["House, pets ok", "Room"]


def test_a_brain_restarted_on_old_state_rejudges_once(paths, services, settings):
    """An older openMoi left its tagging state as a plain topic list; the new questions still get asked."""
    paths.state.mkdir(parents=True, exist_ok=True)
    paths.tagging_state.write_text('["politics"]')
    (paths.views / "events.md").write_text(f"# Events\n\n## Sources\n* Page: {FACEBOOK}\n\n## Rules\n* Only events and birthdays.\n")
    brain = Brain(paths, settings, youtube_base=services.base_url)
    try:
        client = TestClient(create_app(brain, "t"), headers={"x-moi-token": "t"})
        client.post("/ingest", json={"source_id": FACEBOOK_ID, "records": facebook_posts(), "page_url": FACEBOOK})
        assert len(view_texts(client, "events")) == 2
    finally:
        brain.http.close()
