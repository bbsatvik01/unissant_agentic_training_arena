r"""The S1 JSON Schemas v1.2 (draft 2020-12) and the V1 validator that resolves them by `$id` (S1 9.1).

The four schema files are packaged with `arena_core.scenario` so a referee process can validate without
the repository's `docs/` tree; a test keeps them byte-identical to `docs/spec/schemas/` (the spec copy is
the source of truth). References between them resolve through a `referencing.Registry` keyed by each
schema's `$id`, so a `$ref` never touches the network or the file system.

JSON Schema patterns are ECMA-262 regular expressions, where `$` (without the multiline flag) matches only at
the end of the string; Python's `$` also matches before a final newline, so `"C-ABCDEFGH\n"` would pass
`^C-[0-9A-HJKMNP-TV-Z]{8}$`. The V1 validator therefore runs a copy of the schemas whose every anchor `$` is
`\Z` (`ecma_pattern`), so every ID and date pattern means exactly what the schema says.
"""

from __future__ import annotations

import functools
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from arena_core.ids import read_json_text

SCHEMA_FILES: tuple[str, ...] = (
    "case-family.schema.json",
    "evaluator-packet.schema.json",
    "private-packet.schema.json",
    "public-packet.schema.json",
)
CASE_FAMILY = "case-family.schema.json"
SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"  # packaged beside this module


@functools.cache
def load_schemas() -> dict[str, dict[str, Any]]:
    """File name -> parsed schema, each checked against the draft 2020-12 meta-schema."""
    package = SCHEMA_DIR
    out: dict[str, dict[str, Any]] = {}
    for name in SCHEMA_FILES:
        schema = read_json_text((package / name).read_text(encoding="utf-8"))
        if not isinstance(schema, dict):
            msg = f"{name} is not a JSON object"
            raise TypeError(msg)
        Draft202012Validator.check_schema(schema)
        out[name] = schema
    return out


@functools.cache
def ecma_pattern(pattern: str) -> str:
    r"""`pattern` with ECMA-262's `$` for Python's `re`: each `$` outside a character class and not escaped
    becomes `\Z`."""
    out: list[str] = []
    escaped = in_class = False
    for ch in pattern:
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        elif ch == "$" and not in_class:
            out.append("\\Z")
            continue
        out.append(ch)
    return "".join(out)


def with_ecma_patterns(node: object) -> object:
    """A copy of a schema whose every `pattern` keyword is translated by `ecma_pattern`."""
    if isinstance(node, dict):
        return {
            k: ecma_pattern(v) if k == "pattern" and isinstance(v, str) else with_ecma_patterns(v)
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [with_ecma_patterns(v) for v in node]
    return node


@functools.cache
def _validation_schemas() -> dict[str, dict[str, Any]]:
    """The packaged schemas as the V1 validator runs them (`with_ecma_patterns`)."""
    out: dict[str, dict[str, Any]] = {}
    for name, schema in load_schemas().items():
        translated = with_ecma_patterns(schema)
        if not isinstance(translated, dict):  # a schema file is an object (load_schemas)
            raise TypeError(name)
        out[name] = translated
    return out


@functools.cache
def registry() -> Registry[Any]:
    schemas = _validation_schemas()
    return Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas.values())


@functools.cache
def family_validator() -> Draft202012Validator:
    """Draft 2020-12 validator for `case-family.schema.json` with the packet schemas resolved by `$id`, and
    ECMA-262 `pattern` semantics (`ecma_pattern`)."""
    return Draft202012Validator(_validation_schemas()[CASE_FAMILY], registry=registry())


def schema_enum(schema_name: str, def_name: str) -> tuple[str, ...]:
    """The `enum` of `$defs/<def_name>` in one packaged schema (catalogs the sampler and brief read)."""
    values = load_schemas()[schema_name]["$defs"][def_name]["enum"]
    return tuple(str(v) for v in values)
