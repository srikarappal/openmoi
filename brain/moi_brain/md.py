"""Small helpers for the Markdown files openMoi reads and edits."""

import re

COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
HEADING = re.compile(r"^(#{1,2})\s+(.*\S)\s*$")
BULLET = re.compile(r"^\s*[*+-]\s+(.*\S)\s*$")


def parse_sections(text: str) -> tuple[str, dict[str, str]]:
    """Title from the first '# ' line and the body under each '## ' heading, with comments removed."""
    title = ""
    sections: dict[str, list[str]] = {}
    current = None
    for line in COMMENT.sub("", text).splitlines():
        match = HEADING.match(line)
        if match and match.group(1) == "#" and not title:
            title = match.group(2)
        elif match and match.group(1) == "##":
            current = match.group(2)
            sections[current] = []
        elif current is not None:
            sections[current].append(line)
    return title, {heading: "\n".join(lines).strip() for heading, lines in sections.items()}


def section_text(sections: dict[str, str], name: str) -> str:
    """The body of the last heading with this name in any case: the copy replace_section edits."""
    found = [body for heading, body in sections.items() if heading.lower() == name.lower()]
    return found[-1] if found else ""


def body_text(text: str) -> str:
    """Everything after the title line, comments removed: the content of a memory file."""
    lines = COMMENT.sub("", text).splitlines()
    if lines and HEADING.match(lines[0]):
        lines = lines[1:]
    return "\n".join(lines).strip()


def bullets(body: str) -> list[str]:
    """Bullet items, or plain non empty lines when the body has no bullets."""
    lines = [line.strip() for line in body.splitlines() if line.strip()]
    found = [match.group(1) for line in lines if (match := BULLET.match(line))]
    return found or lines


def blank_comment(match: re.Match[str]) -> str:
    """A comment as just its line breaks, so line numbers stay the same."""
    return "\n" * match.group().count("\n")


def is_section_heading(line: str) -> bool:
    match = HEADING.match(line)
    return bool(match) and match.group(1) == "##"


def heading_index(lines: list[str], heading: str) -> int | None:
    """The last '## heading' line, the copy parse_sections reads when a heading appears twice."""
    found = None
    for index, line in enumerate(lines):
        match = HEADING.match(line)
        if match and match.group(1) == "##" and match.group(2).lower() == heading.lower():
            found = index
    return found


def replace_section(text: str, heading: str, body: str) -> str:
    """Replace the body under '## heading' (case insensitive), or append the section at the end.

    Headings inside comments are not sections and a '# ' line inside a section is part of its text,
    the same way parse_sections reads the file."""
    lines = text.rstrip().splitlines()
    visible = COMMENT.sub(blank_comment, text.rstrip()).splitlines()
    start = heading_index(visible, heading)
    body_lines = body.strip().splitlines()
    if start is None:
        return "\n".join([*lines, "", f"## {heading}", *body_lines]) + "\n"
    end = next((index for index in range(start + 1, len(visible)) if is_section_heading(visible[index])), len(lines))
    tail = ["", *lines[end:]] if end < len(lines) else []
    return "\n".join([*lines[: start + 1], *body_lines, *tail]) + "\n"


def replace_body(text: str, body: str) -> str:
    """Keep the title line of a file and replace everything under it.

    Without a title, a body that starts with a heading gets a blank first line, so it is not read as the title."""
    lines = text.splitlines()
    title = lines[0] if lines and HEADING.match(lines[0]) else None
    if title:
        return "\n".join([title, "", body.strip()]) + "\n"
    first_line = body.strip().splitlines()[0] if body.strip() else ""
    return ("\n" if HEADING.match(first_line) else "") + body.strip() + "\n"
