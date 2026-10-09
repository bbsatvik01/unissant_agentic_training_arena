"""Flat bounded schema lint and structured-output parsing (TechnoMile T5, `providers/structured.py`).

`lint_schema` (TechnoMile lines 47-80, lifted unchanged; ATTRIBUTIONS.md) refuses an output schema the Gemini
decoder handles badly: an unbounded list, a free-form object, or a field with a default (every output field must
be required; an optional value is nullable, never defaulted, S2 1). Every model-facing contract passes it (WP-02).
`vertex_schema` and `parse_output` land with the agent port in WP-05.
"""

from typing import Any

from pydantic import BaseModel

from arena_core.providers.errors import ConfigError

_NAMED_SUBSCHEMAS = frozenset({"properties", "$defs"})


def _walk_schema(node: object, path: str, problems: list[str]) -> None:
    if isinstance(node, list):
        for i, item in enumerate(node):
            _walk_schema(item, f"{path}[{i}]", problems)
        return
    if not isinstance(node, dict):
        return
    kind = node.get("type")
    if kind == "array" and "maxItems" not in node:
        problems.append(f"{path}: unbounded list (set max_length)")
    if kind == "object" and "properties" not in node:
        problems.append(f"{path}: free-form object (use a model with declared fields)")
    properties = node.get("properties")
    if isinstance(properties, dict):
        optional = sorted(set(properties) - set(node.get("required", [])))
        if optional:
            # A default would let an empty or partial reply validate; use `X | None` without a default instead.
            problems.append(f"{path}: fields with defaults {optional} (every output field must be required)")
    for key, value in node.items():
        if key in _NAMED_SUBSCHEMAS and isinstance(value, dict):
            for name, sub in value.items():
                _walk_schema(sub, f"{path}.{key}.{name}", problems)
        elif key != "enum":
            _walk_schema(value, f"{path}.{key}", problems)


def lint_schema(schema: type[BaseModel]) -> dict[str, Any]:
    """Return the model's JSON schema, or raise ConfigError if it has an unbounded list or free-form object."""
    json_schema = schema.model_json_schema()
    problems: list[str] = []
    _walk_schema(json_schema, schema.__name__, problems)
    if problems:
        msg = f"schema {schema.__name__} is not a flat, bounded output schema: {'; '.join(problems)}"
        raise ConfigError(msg)
    return json_schema
