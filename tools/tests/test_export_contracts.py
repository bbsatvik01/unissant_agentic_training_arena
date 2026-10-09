"""tools/export_contracts.py: deterministic files across processes, the drift check, and the TypeScript type
generator's subset (WP-02; S6 5.2)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from arena_core.contracts import export
from tools import export_contracts as ec
from tools import proc

REPO_ROOT = Path(__file__).resolve().parents[2]


def _tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def test_two_exports_in_two_processes_are_byte_identical_and_equal_the_committed_files(tmp_path: Path) -> None:
    trees = []
    for name in ("one", "two"):
        out = tmp_path / name
        result = proc.run("python", ["-m", "tools.export_contracts", "--root", str(out)], cwd=REPO_ROOT)
        assert result.returncode == 0, result.stderr
        trees.append(_tree(out))
    assert trees[0] == trees[1]
    assert set(trees[0]) == {str(p) for p in ec.expected_files()}
    for rel, data in trees[0].items():
        assert (REPO_ROOT / rel).read_bytes() == data, rel


def test_the_repository_has_no_drift() -> None:
    assert ec.drift(REPO_ROOT) == []
    assert ec.main(["--root", str(REPO_ROOT), "--check"]) == 0


@pytest.mark.gateproof
def test_check_fails_on_an_edited_a_missing_or_a_stale_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert ec.main(["--root", str(tmp_path)]) == 0
    assert ec.main(["--root", str(tmp_path), "--check"]) == 0
    edited = tmp_path / "contracts" / "events.schema.json"
    edited.write_text(
        edited.read_text(encoding="utf-8").replace('"maxLength": 600', '"maxLength": 6000'), encoding="utf-8"
    )
    (tmp_path / "web/src/lib/contracts/generated/types.ts").unlink()
    (tmp_path / "contracts" / "old.schema.json").write_text("{}\n", encoding="utf-8")
    assert ec.main(["--root", str(tmp_path), "--check"]) == 1
    err = capsys.readouterr().err
    for name in (
        "contracts/events.schema.json",
        "web/src/lib/contracts/generated/types.ts",
        "contracts/old.schema.json",
    ):
        assert name in err


def test_the_web_gets_the_wire_schemas_only() -> None:
    schemas = ec.web_files()["schemas.ts"]
    roots = {line.strip()[1:].split('"')[0] for line in schemas.splitlines() if line.startswith('  "')}
    assert roots == set(export.WIRE)
    assert "export interface WireTypes" in ec.web_files()["types.ts"]


@pytest.mark.parametrize(
    ("schema", "expected"),
    [
        ({"type": "string", "pattern": "^a$"}, "string"),
        ({"type": "integer", "minimum": 1}, "number"),
        ({"type": "number"}, "number"),
        ({"type": "boolean"}, "boolean"),
        ({"type": "null"}, "null"),
        ({"const": 1, "type": "integer"}, "1"),
        ({"enum": ["a", "b"], "type": "string"}, '"a" | "b"'),
        ({"anyOf": [{"type": "string"}, {"type": "null"}]}, "string | null"),
        ({"$ref": "#/$defs/Thing"}, "Thing"),
        ({"type": "array", "items": {"type": "string"}, "maxItems": 2}, "readonly (string)[]"),
        (
            {"type": "object", "patternProperties": {"^x$": {"type": "boolean"}}, "additionalProperties": False},
            "Readonly<Record<string, boolean>>",
        ),
        (
            {"type": "object", "additionalProperties": {"type": "integer"}, "propertyNames": {"enum": ["a"]}},
            'Readonly<Partial<Record<"a", number>>>',
        ),
        ({"type": "object", "additionalProperties": {"type": "integer"}}, "Readonly<Record<string, number>>"),
        (
            {"type": "string", "allOf": [{"if": {"properties": {}}, "then": {"properties": {}}, "else": {}}]},
            "string",
        ),
        (
            {"type": "object", "properties": {"a": {"type": "string"}, "b-c": {"type": "string"}}, "required": ["a"]},
            '{\n  readonly a: string;\n  readonly "b-c"?: string;\n}',
        ),
    ],
)
def test_ts_type_covers_the_pydantic_subset(schema: dict[str, Any], expected: str) -> None:
    assert ec.ts_type(schema, "x") == expected


@pytest.mark.parametrize(
    ("schema", "problem"),
    [
        ({"type": "string", "format": "uuid"}, "unsupported keywords"),
        ({"oneOf": [{"type": "string"}]}, "unsupported keywords"),
        ({"$ref": "other.json#/x"}, "only local"),
        ({"type": "array"}, "array without items"),
        ({"type": "object"}, "free-form object"),
        ({"type": "object", "patternProperties": {"a": {}, "b": {}}}, "one pattern"),
        ({"title": "nothing"}, "no type"),
        ({"type": "string", "allOf": [{"$ref": "#/$defs/X"}]}, "only if/then/else/properties"),
    ],
)
def test_ts_type_refuses_what_it_cannot_type(schema: dict[str, Any], problem: str) -> None:
    with pytest.raises(ec.GenerationError, match=problem):
        ec.ts_type(schema, "x")


def test_conflicting_definitions_across_wire_schemas_fail_the_export() -> None:
    one = {"title": "A", "$defs": {"Thing": {"type": "string"}}}
    two = {"title": "B", "$defs": {"Thing": {"type": "integer"}}}
    with pytest.raises(ec.GenerationError, match="differs"):
        ec.types_module({"a": one, "b": two})


def test_a_union_root_becomes_a_type_alias_and_a_model_root_an_interface() -> None:
    module = ec.types_module(
        {
            "u": {
                "title": "Either",
                "anyOf": [{"$ref": "#/$defs/A"}, {"type": "null"}],
                "$defs": {"A": {"type": "string"}},
            },
            "m": {"title": "M", "type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"]},
        }
    )
    assert "export type A = string;" in module
    assert "export type Either = A | null;" in module
    assert "export interface M {\n  readonly x: number;\n}" in module
    assert "  readonly u: Either;\n  readonly m: M;\n" in module
