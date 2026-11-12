"""Enrichment without a model: language, reading time, names and rage bait."""

from datetime import UTC, datetime

import pytest

from moi_brain.enrich import enriched, entities, language, ragebait_score, reading_minutes
from moi_brain.items import normalize

NOW = datetime(2026, 11, 12, tzinfo=UTC)


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("The council said that it was time for the new park to open with the plan", "en"),
        ("El gobierno dijo que la nueva ley es buena para los trabajadores de la ciudad", "es"),
        ("Le maire a dit que la nouvelle loi est une bonne chose pour les habitants", "fr"),
        ("Der Bürgermeister sagte, dass die neue Regel nicht gut ist und das ist ein Problem", "de"),
        ("新しい公園が今日オープンしました", "ja"),
        ("新的公园今天开放了", "zh"),
        ("Новый парк открылся сегодня", "ru"),
        ("ok", "und"),
    ],
)
def test_language_by_script_then_small_words(text, code):
    assert language(text) == code


def test_reading_time_names_and_rage_bait():
    assert reading_minutes("word " * 10) == 1 and reading_minutes("word " * 1150) == 5
    text = "Yesterday Maya Kumar met Ben Ito at the City Park cafe. Follow @maya.k and #localnews, $AAPL rose."
    assert entities(text) == ["Maya Kumar", "Ben Ito", "City Park", "@maya.k", "#localnews", "$AAPL"]
    assert entities("Nothing here") == []
    calm = ragebait_score("The council approved the park budget on Tuesday.")
    angry = ragebait_score("OUTRAGE: they DESTROYED the park!!! Absolute disgrace, these idiots")
    assert calm == 0.0 and angry == 1.0 and ragebait_score("") == 0.0
    assert 0 < ragebait_score("A shocking turn in the vote") < 1
    assert ragebait_score("Dimmable LED desk lamp with USB port") == 0.0


def test_enrichment_lands_on_the_item_and_a_model_judgment_outranks_the_heuristic():
    item = normalize("rss:a", {"native_id": "1", "url": "https://a.example/1", "title": "The park opened with the new playground for the kids"}, NOW)
    extra = enriched(item).extra
    assert extra == {"lang": "en", "reading_minutes": "1", "ragebait": "0.0"}
    judged = item.model_copy(update={"extra": {"judged:rage_bait": "yes"}})
    assert enriched(judged).extra["ragebait"] == "0.9"
    named = normalize("rss:a", {"native_id": "2", "url": "https://a.example/2", "text": "Maya Kumar opened it"}, NOW)
    assert enriched(named).extra["entities"] == "Maya Kumar"


def test_a_single_word_left_after_leading_words_is_no_name():
    assert entities("The Times reported it. Yesterday Paris was calm.") == []
