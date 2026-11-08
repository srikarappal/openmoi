"""Extractor generation: the smart model turns a page skeleton (structure only, no text) into a listing spec."""

import json

from pydantic import BaseModel, Field

from moi_brain.extractors import ExtractorSpec, FieldRule, Pagination, page_domain, path_pattern_for
from moi_brain.llm import Gateway, LlmError

REQUIRED_FIELDS = ("url", "title")
EXAMPLE = {
    "item_root": "tr.athing",
    "native_id": {"select": ":scope", "take": "attr:id"},
    "fields": {
        "title": {"select": ".titleline > a", "take": "text"},
        "url": {"select": ".titleline > a", "take": "attr:href", "transform": "absolute_url"},
        "extra.site": {"select": ".sitestr", "take": "text", "optional": True},
    },
    "pagination": {"kind": "none"},
}
SYSTEM_PROMPT = f"""You write extractor specs for openMoi: JSON programs that pull the list of items out of a web page.
You get a skeleton of the page: tags and attributes only. Every text is replaced by {{t:N}} where N is its length,
and long runs of similar siblings are cut to three examples plus a count.
Reply with one JSON object:
{{"item_root": "<CSS selector matching each item>", "native_id": <field rule or null>, "fields": {{"<name>": <field rule>}}, "pagination": {{"kind": "none"}}}}
A field rule is {{"select": "<CSS selector inside the item, or :scope for the item itself>", "take": "text" or "attr:<name>",
"transform": null, "absolute_url", "iso_datetime", "regex:<pattern>" or "strip_prefix:<text>", "optional": true or false}}.
Fields: url (required: attr:href with transform absolute_url), title (required: the main link or heading text),
and optionally text, author_name, image_url (attr:src with absolute_url), published_at (attr:datetime),
extra.price_text, extra.rating_text, extra.site.
item_root must match every item and nothing else, usually the repeated element.
Prefer stable attributes (data attributes, ids, roles, semantic tags) over generated class names.
If last_error is set, your previous spec failed that check on the real page; fix it.
Example for a news listing:
{json.dumps(EXAMPLE)}"""


class ExtractorDraft(BaseModel):
    item_root: str = Field(min_length=1)
    native_id: FieldRule | None = None
    fields: dict[str, FieldRule]
    pagination: Pagination = Field(default_factory=Pagination)


def extractor_messages(url: str, skeleton: str, last_error: str | None) -> list[dict[str, str]]:
    """Only the site's domain goes with the skeleton: the path or query of a page you opened (a search, a profile,
    a sign in link) is yours and the hosted model writing selectors does not need it."""
    payload = {"site": page_domain(url), "skeleton": skeleton, "last_error": last_error}
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": json.dumps(payload)}]


def generate_spec(gateway: Gateway, url: str, skeleton: str, last_error: str | None) -> ExtractorSpec:
    """A listing spec for this page; domain and path pattern come from the URL, never from the model."""
    draft = gateway.complete_json("smart", "extractor", extractor_messages(url, skeleton, last_error), False, ExtractorDraft)
    missing = [name for name in REQUIRED_FIELDS if name not in draft.fields]
    if missing:
        raise LlmError(f"the spec has no {' or '.join(missing)} field")
    return ExtractorSpec(
        domain=page_domain(url),
        path_pattern=path_pattern_for(url),
        page_type="listing",
        item_root=draft.item_root,
        native_id=draft.native_id,
        fields=draft.fields,
        pagination=draft.pagination,
    )
