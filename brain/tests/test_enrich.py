"""Enrichment without a model: language, reading time, names and rage bait."""

from datetime import UTC, datetime

import pytest

from moi_brain.enrich import enriched, entities, language, ragebait_score, reading_minutes, with_judged_rage
from moi_brain.items import normalize
from moi_brain.store import Store

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
        ("I bought a car and a house in a day", "en"),
        ("Researchers grow working kidney tissue in lab", "en"),
        ("Heat wave breaks records across southern Europe", "en"),
        ("Why some batteries die early", "en"),
        ("Não há acordo entre o governo e os sindicatos", "pt"),
        ("Il governo annuncia nuove misure per l'economia", "it"),
        ("In Italia la crescita rallenta", "it"),
        ("Wir werden das schaffen, sagt die Kanzlerin", "de"),
        ("Washington anuncia sanciones", "und"),
        ("Python 3.15", "und"),
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


def test_most_english_headlines_read_as_english_and_none_as_another_language():
    titles = [
        "Fed raises interest rates by half a point", "SpaceX lands Starship booster on launch tower arms", "New laptop chip doubles battery life",
        "Senate debates the election budget", "Local bakery wins national prize", "How solar panels got cheap", "Study finds four day work week boosts productivity",
        "Supreme Court hears arguments on social media age limits", "Volcano erupts in Iceland, flights diverted", "Amazon cuts prices on Kindle lineup ahead of holidays",
        "Museum returns stolen bronze statues to Nigeria", "Rare comet visible to the naked eye this weekend", "City council approves new bike lanes on Market Street",
        "Electric car sales overtake petrol in Norway for good", "Puppy rescued from flooded storm drain after six hours", "Open source database hits version 10",
        "A tour of the new space telescope images", "Election results shake up tech policy", "Why the sky is blue, really", "The surprising math of traffic",
    ]
    found = [language(title) for title in titles]
    assert found.count("en") >= 0.85 * len(titles) and set(found) <= {"en", "und"}


def test_a_rage_bait_judgment_that_comes_after_enrichment_still_raises_the_score(tmp_path):
    assert with_judged_rage({"ragebait": "0.2", "judged:angry": "yes"})["ragebait"] == "0.9"
    assert with_judged_rage({"ragebait": "0.95", "judged:angry": "yes"})["ragebait"] == "0.95"
    assert with_judged_rage({"ragebait": "lots", "judged:rage_bait": "yes"})["ragebait"] == "0.9"
    assert with_judged_rage({"ragebait": "0.2", "judged:angry": "no"}) == {"ragebait": "0.2", "judged:angry": "no"}
    store = Store(tmp_path / "moi.db")
    item = enriched(normalize("rss:a", {"native_id": "1", "url": "https://a.example/1", "title": "A calm headline about parks"}, NOW))
    store.upsert_items([item])
    assert store.get_item(item.item_id).extra["ragebait"] == "0.0"
    store.update_tags([item.model_copy(update={"topics": ["parks"], "extra": {**item.extra, "judged:angry": "yes"}})])
    assert store.get_item(item.item_id).extra["ragebait"] == "0.9"
