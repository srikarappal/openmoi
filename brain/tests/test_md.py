from moi_brain.md import body_text, bullets, parse_sections, replace_body, replace_section, section_text

VIEW = """# Feed

## Sources
* X home timeline
<!-- a comment
that spans lines -->
* RSS: https://a.com/rss

## Rules
No shorts.

## Layout
Two columns.
"""


def test_parse_sections_reads_title_and_bodies_without_comments():
    title, sections = parse_sections(VIEW)
    assert title == "Feed"
    assert sections == {"Sources": "* X home timeline\n\n* RSS: https://a.com/rss", "Rules": "No shorts.", "Layout": "Two columns."}


def test_parse_sections_of_empty_or_untitled_text():
    assert parse_sections("") == ("", {})
    assert parse_sections("## Only\nbody") == ("", {"Only": "body"})


def test_section_text_is_case_insensitive():
    _, sections = parse_sections(VIEW)
    assert section_text(sections, "rules") == "No shorts."
    assert section_text(sections, "missing") == ""


def test_bullets_and_plain_lines():
    assert bullets("* one\n- two\n+ three\n\n") == ["one", "two", "three"]
    assert bullets("first line\nsecond line") == ["first line", "second line"]
    assert bullets("") == []


def test_replace_section_in_the_middle_keeps_the_rest():
    updated = replace_section(VIEW, "rules", "* No shorts.\n* Hide politics.")
    title, sections = parse_sections(updated)
    assert title == "Feed"
    assert sections["Rules"] == "* No shorts.\n* Hide politics."
    assert sections["Layout"] == "Two columns."
    assert "## Rules" in updated


def test_replace_last_section_and_append_new_one():
    updated = replace_section(VIEW, "Layout", "Magazine.")
    assert parse_sections(updated)[1]["Layout"] == "Magazine."
    appended = replace_section(VIEW, "Match", "Same person.")
    assert parse_sections(appended)[1]["Match"] == "Same person."
    assert appended.endswith("Same person.\n")


def test_replace_body_keeps_the_title():
    assert replace_body("# dislikes\n\n* old\n", "* crypto\n* gossip") == "# dislikes\n\n* crypto\n* gossip\n"
    assert replace_body("no title here", "* new") == "* new\n"


def test_body_text_skips_title_and_comments():
    assert body_text("# likes\n<!-- hint -->\n* sourdough\n") == "* sourdough"
    assert body_text("") == ""


def test_headings_that_differ_only_in_case_read_and_edit_the_same_copy():
    text = "# Feed\n\n## Rules\n* first\n\n## rules\n* second\n"
    edited = replace_section(text, "Rules", "* fresh")
    assert section_text(parse_sections(edited)[1], "rules") == "* fresh"

