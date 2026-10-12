"""Flat bounded schema lint and structured-output parsing (TechnoMile T5, `providers/structured.py`).

`lint_schema` (TechnoMile lines 47-80, lifted unchanged; ATTRIBUTIONS.md) refuses an output schema the Gemini
decoder handles badly: an unbounded list, a free-form object, or a field with a default (every output field must
be required; an optional value is nullable, never defaulted, S2 1). Every model-facing contract passes it (WP-02).
`vertex_schema` (TechnoMile lines 17-41 and 84-100, lifted unchanged; ATTRIBUTIONS.md) keeps only the keywords
Vertex documents for `response_json_schema`; `sent_schema` is the one schema a request carries and a manifest
hashes (S2 3.1: "the canonical JSON Schema actually sent to Vertex, after `vertex_schema`"). `parse_output` lands
with the agent port in WP-05, which sends `sent_schema(model)`.
"""

from typing import Any

from pydantic import BaseModel

from arena_core.providers.errors import ConfigError

# Keywords Vertex accepts in response_json_schema (google-genai 2.24.0 GenerationConfig docs).
_VERTEX_SCHEMA_KEYS = frozenset(
    {
        "$id",
        "$defs",
        "$ref",
        "$anchor",
        "type",
        "format",
        "title",
        "description",
        "enum",
        "items",
        "prefixItems",
        "minItems",
        "maxItems",
        "minimum",
        "maximum",
        "anyOf",
        "oneOf",
        "properties",
        "additionalProperties",
        "required",
        "propertyOrdering",
    }
)
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


def vertex_schema(node: object) -> object:
    """Drop JSON Schema keywords Vertex does not document (e.g. maxLength, default, const)."""
    if isinstance(node, list):
        return [vertex_schema(item) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key not in _VERTEX_SCHEMA_KEYS:
            continue
        if key in _NAMED_SUBSCHEMAS and isinstance(value, dict):
            out[key] = {name: vertex_schema(sub) for name, sub in value.items()}
        elif key == "enum":
            out[key] = value
        else:
            out[key] = vertex_schema(value)
    return out


def _unbound_object_lists(node: object) -> object:
    """The schema with `maxItems`/`minItems` dropped from every list whose items are objects (a `$ref` or an object
    schema); lists of scalars keep their bounds."""
    if isinstance(node, list):
        return [_unbound_object_lists(item) for item in node]
    if not isinstance(node, dict):
        return node
    out = {key: (value if key == "enum" else _unbound_object_lists(value)) for key, value in node.items()}
    items = out.get("items")
    if out.get("type") == "array" and isinstance(items, dict) and ("$ref" in items or items.get("type") == "object"):
        out.pop("maxItems", None)
        out.pop("minItems", None)
    return out


def sent_schema(model: type[BaseModel]) -> dict[str, Any]:
    """The `response_json_schema` of a request for `model`: linted, then filtered by `vertex_schema`. A model that
    sets `UNBOUNDED_OBJECT_LISTS_SENT` (a schema Vertex refuses as too complex with its object-list bounds) is sent
    without them; the lint above still requires them in the contract, and validation enforces them."""
    out = vertex_schema(lint_schema(model))
    if getattr(model, "UNBOUNDED_OBJECT_LISTS_SENT", False):
        out = _unbound_object_lists(out)
    if not isinstance(out, dict):
        msg = f"schema {model.__name__} is not an object schema"
        raise ConfigError(msg)
    return out
