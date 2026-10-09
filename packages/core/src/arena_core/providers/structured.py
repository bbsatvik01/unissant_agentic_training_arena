"""Flat bounded schema lint and structured-output parsing (TechnoMile T5, `providers/structured.py`).

`lint_schema` (TechnoMile lines 47-80, lifted unchanged; ATTRIBUTIONS.md) refuses an output schema the Gemini
decoder handles badly: an unbounded list, a free-form object, or a field with a default (every output field must
be required; an optional value is nullable, never defaulted, S2 1). Every model-facing contract passes it (WP-02).

`vertex_schema` (TechnoMile lines 84-100, lifted unchanged) drops the keywords Vertex does not document, so lengths and
word counts are enforced by the Pydantic models in code (S2 1). `extract_json_text` and `parse_output` (lines 103-135)
are adapted: the reply either validates or it does not (no repair of truncated JSON, no defaults), and a failure
carries S2 10's repair error list: at most 10 `field.path: message` items of at most 100 bytes each, built from the
validator's location and message only, never from an input or output value.
"""

import json
import re
from typing import Any, cast

from pydantic import BaseModel, ValidationError

from arena_core.providers.errors import ConfigError
from arena_core.spend.limits import REPAIR_ERROR_ITEM_BYTES, REPAIR_ERROR_ITEMS

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
_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)


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
    """Drop JSON Schema keywords Vertex does not document (for example maxLength, default, const)."""
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


def vertex_root(json_schema: dict[str, Any]) -> dict[str, Any]:
    """`vertex_schema` of a whole model schema: a dict maps to a dict (the function's first branch for dicts)."""
    return cast("dict[str, Any]", vertex_schema(json_schema))


class OutputInvalidError(ValueError):
    """The reply did not validate. ``errors`` is the repair list (S2 10); ``str()`` joins it."""

    def __init__(self, errors: tuple[str, ...]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


def _cut_bytes(text: str, limit: int) -> str:
    """The longest prefix of ``text`` whose UTF-8 encoding is at most ``limit`` bytes (character boundary)."""
    return text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")


def _item(path: str, message: str) -> str:
    return _cut_bytes(f"{path}: {message}", REPAIR_ERROR_ITEM_BYTES)


def extract_json_text(text: str) -> str:
    """The JSON object in a reply: the whole reply, a fenced block, or the outermost {...} span."""
    stripped = text.strip()
    fenced = _FENCE.match(stripped)
    if fenced:
        return fenced.group(1)
    start, end = stripped.find("{"), stripped.rfind("}")
    if start == -1 or end < start:
        raise OutputInvalidError((_item("<root>", "no JSON object in the reply"),))
    return stripped[start : end + 1]


def parse_output[T: BaseModel](text: str, schema: type[T]) -> T:
    """Validate the reply against ``schema``; raise OutputInvalidError with the repair list on failure."""
    candidate = extract_json_text(text)
    try:
        json.loads(candidate)
    except ValueError:
        raise OutputInvalidError((_item("<root>", "the reply is not valid JSON"),)) from None
    try:
        return schema.model_validate_json(candidate)
    except ValidationError as exc:
        # loc and the error type's own message template; `input` and `ctx` values are never echoed (S2 10).
        items = tuple(
            _item(".".join(str(part) for part in err["loc"]) or "<root>", err["msg"])
            for err in exc.errors(include_url=False, include_input=False, include_context=False)[:REPAIR_ERROR_ITEMS]
        )
        raise OutputInvalidError(items) from None
