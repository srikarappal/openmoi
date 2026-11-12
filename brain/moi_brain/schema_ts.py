"""TypeScript types for what the brain sends the shell, made from its pydantic models through JSON Schema.

    uv run python -m moi_brain.schema_ts > ../shell/src/shared/brain_schema.ts

The shell keeps its own hand written types; a check in the shell (tests/unit/brain_schema_check.ts, compiled with the
rest) says each of these is assignable to them, so a field the brain renames or retypes breaks the build instead of
the app. A brain test regenerates this file and fails when the copy in the shell is stale.
"""

import json
import sys
from typing import Any

from pydantic import BaseModel

from moi_brain.actions import ActionDecision
from moi_brain.agents import AgentRun
from moi_brain.brain import (
    AppAccess,
    CollectionInfo,
    LookupStart,
    PeopleReply,
    SearchHit,
    ShopStart,
    ViewPage,
    ViewSchedule,
)
from moi_brain.edits import Proposal

# The replies the shell reads, by the name its own types use.
REPLIES: dict[str, type[BaseModel]] = {
    "ViewPage": ViewPage,
    "ViewSchedule": ViewSchedule,
    "ActionDecision": ActionDecision,
    "AgentRun": AgentRun,
    "Proposal": Proposal,
    "LookupStart": LookupStart,
    "PeopleReply": PeopleReply,
    "AppAccess": AppAccess,
    "ShopStart": ShopStart,
    "CollectionInfo": CollectionInfo,
    "SearchHit": SearchHit,
}
HEADER = "// Made by `uv run python -m moi_brain.schema_ts` from the brain's models; do not edit by hand.\n"


def ts_type(schema: dict[str, Any]) -> str:
    """The TypeScript for one JSON Schema node of a serialized model."""
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "const" in schema:
        return json.dumps(schema["const"])
    if "enum" in schema:
        return " | ".join(json.dumps(value) for value in schema["enum"])
    for key in ("anyOf", "oneOf"):
        if key in schema:
            return " | ".join(dict.fromkeys(ts_type(part) for part in schema[key]))
    kind = schema.get("type")
    if kind == "array":
        prefix = schema.get("prefixItems")
        if prefix:
            return f"[{', '.join(ts_type(part) for part in prefix)}]"
        inner = ts_type(schema.get("items", {}))
        return f"Array<{inner}>"
    if kind == "object":
        values = schema.get("additionalProperties")
        return f"Record<string, {ts_type(values) if isinstance(values, dict) else 'unknown'}>"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean", "null": "null"}.get(kind or "", "unknown")


def interface(name: str, schema: dict[str, Any]) -> str:
    """One model as an interface: every field the brain always sends (pydantic writes defaults too)."""
    if "enum" in schema:
        return f"export type {name} = {ts_type(schema)}\n"
    lines = [f"export interface {name} {{"]
    lines += [f"  {field}: {ts_type(spec)}" for field, spec in schema.get("properties", {}).items()]
    return "\n".join([*lines, "}"]) + "\n"


def typescript() -> str:
    definitions: dict[str, dict[str, Any]] = {}
    for name, model in REPLIES.items():
        schema = model.model_json_schema(mode="serialization", ref_template="#/$defs/{model}")
        definitions |= schema.pop("$defs", {})
        definitions[name] = schema
    return HEADER + "\n" + "\n".join(interface(name, definitions[name]) for name in sorted(definitions))


if __name__ == "__main__":
    sys.stdout.write(typescript())
