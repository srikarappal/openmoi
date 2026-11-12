"""Near duplicates by simhash and similarity by vectors, with and without a model."""

import math

from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

from moi_brain.vectors import DIMENSIONS, cosine, hamming, hashed_vector, near_duplicates, packed, simhash, unpacked

STORY = "The Federal Reserve raised interest rates by half a point on Wednesday to fight stubborn inflation"


def test_a_copy_with_a_word_changed_is_a_near_duplicate_and_another_story_is_not():
    copy = STORY.replace("Wednesday", "Thursday")
    other = "A new playground opened in the city park with slides, swings and a climbing wall for kids"
    assert near_duplicates(simhash(STORY), simhash(STORY))
    assert hamming(simhash(STORY), simhash(copy)) < hamming(simhash(STORY), simhash(other))
    assert not near_duplicates(simhash(STORY), simhash(other))
    assert simhash("") == 0 and simhash("one") == simhash("ONE")


def test_vectors_put_texts_sharing_words_close():
    retelling = "Fed raises interest rates half a point to fight inflation"
    other = "A new playground opened in the city park with slides and swings"
    story = hashed_vector(STORY)
    assert len(story) == DIMENSIONS
    assert math.isclose(cosine(story, story), 1.0, rel_tol=1e-9)
    assert cosine(story, hashed_vector(retelling)) > 0.4 > cosine(story, hashed_vector(other))
    assert hashed_vector("") == [0.0] * DIMENSIONS
    assert cosine([1.0], [1.0, 0.0]) == 0.0


@hypothesis_settings(max_examples=100, deadline=None)
@given(text=st.text(alphabet="abc xyz", max_size=60))
def test_vectors_are_unit_length_or_empty_and_survive_packing(text):
    vector = hashed_vector(text)
    length = math.sqrt(sum(value * value for value in vector))
    assert math.isclose(length, 1.0, rel_tol=1e-6) or length == 0.0
    assert all(math.isclose(left, right, rel_tol=1e-6, abs_tol=1e-7) for left, right in zip(unpacked(packed(vector)), vector, strict=True))


def test_damaged_vector_bytes_read_as_no_vector():
    assert unpacked(b"") == [] and unpacked(b"abc") == []
