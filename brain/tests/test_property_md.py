"""Property based tests for the Markdown section helpers in moi_brain.md."""

import pytest
from hypothesis import assume, example, given, settings
from hypothesis import strategies as st

from moi_brain.md import HEADING, body_text, bullets, parse_sections, replace_body, replace_section, section_text

FAST = settings(max_examples=150, deadline=None)
FEW = settings(FAST, max_examples=30)

WORD = st.text(alphabet="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", min_size=1, max_size=8)
HEADING_NAME = st.lists(WORD, min_size=1, max_size=3).map(" ".join)
LINE_TEXT = st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789 #*+-.,:!?()'\"\t", max_size=30)
PLAIN_LINE = LINE_TEXT.filter(lambda line: not HEADING.match(line))
BODY = st.lists(PLAIN_LINE, max_size=6).map("\n".join)
TITLE = HEADING_NAME


def normalized(body: str) -> str:
    """What parse_sections hands back for a body written by replace_section: stripped, lines joined by newlines."""
    return "\n".join(body.strip().splitlines()).strip()


def render(title: str, sections: list[tuple[str, str]]) -> str:
    parts = [f"# {title}", ""] if title else []
    for heading, body in sections:
        parts += [f"## {heading}", body, ""]
    return "\n".join(parts)


def heading_first(heading: str, body: str) -> str:
    return f"# {heading}\n{body}"


def unique_sections(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    seen: dict[str, tuple[str, str]] = {}
    for heading, body in pairs:
        seen.setdefault(heading.lower(), (heading, body))
    return list(seen.values())


SECTIONS = st.lists(st.tuples(HEADING_NAME, BODY), max_size=5).map(unique_sections)


@FAST
@given(title=TITLE, sections=SECTIONS, heading=HEADING_NAME, body=BODY)
def test_replace_section_reads_back_the_new_text(title, sections, heading, body):
    """After replacing a section, parsing the file gives back exactly the new body."""
    updated = replace_section(render(title, sections), heading, body)
    assert section_text(parse_sections(updated)[1], heading) == normalized(body)


@FAST
@given(title=TITLE, sections=SECTIONS, heading=HEADING_NAME, body=BODY)
def test_replace_section_keeps_title_and_other_sections(title, sections, heading, body):
    """Replacing one section leaves the title and every other section as they were."""
    text = render(title, sections)
    before_title, before = parse_sections(text)
    after_title, after = parse_sections(replace_section(text, heading, body))
    others_before = {name: value for name, value in before.items() if name.lower() != heading.lower()}
    others_after = {name: value for name, value in after.items() if name.lower() != heading.lower()}
    assert after_title == before_title
    assert others_after == others_before


@FAST
@given(title=TITLE, sections=SECTIONS, heading=HEADING_NAME, first=BODY, second=BODY)
def test_replace_section_twice_equals_once_with_last_text(title, sections, heading, first, second):
    """Replacing a section twice writes the same file as replacing it once with the last text."""
    text = render(title, sections)
    assert replace_section(replace_section(text, heading, first), heading, second) == replace_section(text, heading, second)


@FAST
@given(title=TITLE, sections=SECTIONS, heading=HEADING_NAME, body=BODY)
def test_replace_section_is_idempotent(title, sections, heading, body):
    """Applying the same section replacement again changes nothing."""
    once = replace_section(render(title, sections), heading, body)
    assert replace_section(once, heading, body) == once


@FAST
@given(
    title=TITLE,
    sections=SECTIONS,
    heading=HEADING_NAME,
    lines=st.lists(PLAIN_LINE, min_size=1, max_size=5),
    newline=st.sampled_from(["\n", "\r\n", "\r"]),
    padding=st.sampled_from(["", " ", "\t", "\n\n", " \r\n\t"]),
)
def test_replace_section_tolerates_odd_whitespace(title, sections, heading, lines, newline, padding):
    """Windows or old Mac line endings and blank padding around the text read back as the same lines."""
    body = padding + newline.join(lines) + padding
    updated = replace_section(render(title, sections), heading, body)
    assert section_text(parse_sections(updated)[1], heading) == normalized("\n".join(lines))
    assert updated.endswith("\n")
    assert "\r" not in updated


@FAST
@given(title=TITLE, sections=SECTIONS, heading=HEADING_NAME, body=BODY, deeper=st.lists(WORD, min_size=1, max_size=3))
def test_replace_section_treats_deeper_headings_as_text(title, sections, heading, body, deeper):
    """A '### sub' line inside the new text stays text: it neither starts nor ends a section."""
    text_with_sub = f"### {' '.join(deeper)}\n{body}"
    updated = replace_section(render(title, sections), heading, text_with_sub)
    assert section_text(parse_sections(updated)[1], heading) == normalized(text_with_sub)
    assert replace_section(updated, heading, body) == replace_section(render(title, sections), heading, body)


@FEW
@example(title="Feed", sections=[], heading="Rules", body="* old rule", level_one="Notes")
@given(title=TITLE, sections=SECTIONS, heading=HEADING_NAME, body=BODY, level_one=HEADING_NAME)
def test_replace_section_overwrites_text_below_a_level_one_line(title, sections, heading, body, level_one):
    """parse_sections reads a later '# X' line as part of the section, so replacing the section must overwrite it too."""
    assume(all(name.lower() != heading.lower() for name, _ in sections))
    text = render(title, [*sections, (heading, f"{body}\n# {level_one}\nleftover")])
    updated = replace_section(text, heading, "fresh")
    assert section_text(parse_sections(updated)[1], heading) == "fresh"


@FEW
@example(title="Feed", heading="Rules", first="* old", second="* also old")
@given(title=TITLE, heading=HEADING_NAME, first=BODY, second=BODY)
def test_replace_section_with_duplicate_heading_reads_back(title, heading, first, second):
    """When a hand edited file has the same heading twice, the replaced text is what parse_sections reads back."""
    text = render(title, [(heading, first), (heading, second)])
    updated = replace_section(text, heading, "fresh")
    assert section_text(parse_sections(updated)[1], heading) == "fresh"


@FEW
@example(title="Feed", heading="Rules", body="* No shorts.", other="Sources", other_body="* X home timeline")
@given(title=TITLE, heading=HEADING_NAME, body=BODY, other=HEADING_NAME, other_body=BODY)
def test_replace_section_ignores_headings_inside_comments(title, heading, body, other, other_body):
    """A commented out section is invisible to parse_sections, so replacing the live one keeps every section readable."""
    assume(len({other.lower(), heading.lower(), "layout"}) == 3)
    text = (
        f"# {title}\n\n<!--\n## {heading}\n* disabled\n-->\n\n"
        f"## {other}\n{other_body}\n\n## {heading}\n{body}\n\n## Layout\n<!-- Describe the look -->\nMagazine.\n"
    )
    after = parse_sections(replace_section(text, heading, "fresh"))[1]
    assert section_text(after, heading) == "fresh"
    assert section_text(after, other) == normalized(other_body)
    assert section_text(after, "Layout") == "Magazine."


@FAST
@given(text=st.text(max_size=300))
def test_parse_sections_never_raises_and_bodies_are_stripped(text):
    """Any text parses; the title and every section body come back without surrounding whitespace."""
    title, sections = parse_sections(text)
    assert title == title.strip()
    assert all(body == body.strip() for body in sections.values())
    assert all(heading == heading.strip() and heading for heading in sections)


@FAST
@given(title=TITLE, body=BODY, new_body=BODY)
def test_replace_body_keeps_title_and_reads_back(title, body, new_body):
    """replace_body keeps the title line and body_text then returns exactly the new text."""
    updated = replace_body(f"# {title}\n\n{body}\n", new_body)
    assert updated.splitlines()[0] == f"# {title}"
    assert body_text(updated) == normalized(new_body)
    assert parse_sections(updated)[0] == title


@FAST
@given(title=TITLE, body=BODY, first=BODY, second=BODY)
def test_replace_body_twice_equals_once_with_last_text(title, body, first, second):
    """Replacing a titled file's body twice is the same as replacing it once with the last text."""
    text = f"# {title}\n\n{body}\n"
    assert replace_body(replace_body(text, first), second) == replace_body(text, second)


@FEW
@example(body="* sourdough", new_body="## Food\n* bread")
@given(body=BODY, new_body=st.builds(heading_first, HEADING_NAME, BODY))
def test_replace_body_of_untitled_file_reads_back(body, new_body):
    """For a file without a title, body_text of the result is still the full new text."""
    assert body_text(replace_body(body, new_body)) == normalized(new_body)


@FAST
@given(items=st.lists(st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789 .,!?*+-", min_size=1, max_size=20).map(str.strip).filter(bool), min_size=1, max_size=6), marker=st.sampled_from(["*", "-", "+"]))
def test_bullets_round_trip(items, marker):
    """A rendered bullet list reads back as the same items in order."""
    assert bullets("\n".join(f"{marker} {item}" for item in items)) == items
