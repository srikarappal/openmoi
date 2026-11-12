"""The TypeScript types the shell checks its own against are made from the brain's models, and are current."""

from moi_brain.config import REPO_DIR
from moi_brain.schema_ts import REPLIES, ts_type, typescript


def test_the_shell_has_the_current_types_of_what_the_brain_sends():
    generated = REPO_DIR / "shell" / "src" / "shared" / "brain_schema.ts"
    assert generated.read_text() == typescript(), "run: uv run python -m moi_brain.schema_ts > ../shell/src/shared/brain_schema.ts"
    assert all(f"export interface {name} {{" in generated.read_text() for name in REPLIES)


def test_json_schema_nodes_become_typescript():
    assert ts_type({"anyOf": [{"type": "string"}, {"type": "null"}]}) == "string | null"
    assert ts_type({"enum": ["a", "b"]}) == '"a" | "b"'
    assert ts_type({"type": "array", "items": {"$ref": "#/$defs/Item"}}) == "Array<Item>"
    assert ts_type({"type": "array", "prefixItems": [{"type": "string"}, {"type": "integer"}]}) == "[string, number]"
    assert ts_type({"type": "object", "additionalProperties": {"type": "number"}}) == "Record<string, number>"
    assert ts_type({"const": "plan"}) == '"plan"' and ts_type({}) == "unknown"
