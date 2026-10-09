"""The exported contracts: deterministic, valid draft 2020-12, model-facing schemas flat and bounded (WP-02)."""

from __future__ import annotations

import json
from typing import Annotated

import pytest
from jsonschema import Draft202012Validator
from pydantic import BaseModel, Field

from arena_core.contracts import export
from arena_core.contracts.common import Contract
from arena_core.providers.errors import ConfigError
from arena_core.providers.structured import lint_schema

from .conftest import CONTRACTS_DIR


def test_exporting_twice_gives_identical_text() -> None:
    assert export.contract_files() == export.contract_files()


def test_the_committed_contracts_equal_a_fresh_export() -> None:
    for name, text in export.contract_files().items():
        assert (CONTRACTS_DIR / name).read_bytes() == text.encode("utf-8"), name


@pytest.mark.parametrize("name", sorted(n for n in export.contract_files() if n.endswith(".schema.json")))
def test_every_exported_schema_is_valid_draft_2020_12(name: str) -> None:
    schema = json.loads(export.contract_files()[name])
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$id"].endswith(name)
    Draft202012Validator.check_schema(schema)


@pytest.mark.parametrize("model", list(export.MODEL_FACING.values()), ids=lambda m: m.__name__)
def test_every_model_facing_schema_passes_lint_schema(model: type[BaseModel]) -> None:
    assert lint_schema(model) == model.model_json_schema()


def test_the_three_audiences_are_disjoint() -> None:
    stems = [*export.MODEL_FACING, *export.STORED, *export.WIRE]
    assert len(stems) == len(set(stems))
    assert "stored-card" not in export.WIRE
    assert {"events", "training-card", "tournament-card", "snapshot", "debrief.v1"} <= set(export.WIRE)


def test_the_card_schema_is_s2s_shape_with_enum_versions() -> None:
    card = export.schema_of("card.v1")
    version = card["properties"]["schema_version"]
    assert (version["type"], version["enum"]) == ("string", ["card.v1"])
    assert "const" not in version
    assert card["required"] == [
        "schema_version",
        "turn_id",
        "question",
        "answer_category",
        "flags",
        "follow_up",
        "finding",
        "boundary_notice",
        "commit_requested",
    ]
    assert card["$defs"]["Finding"]["required"] == [
        "label",
        "likelihood",
        "confidence",
        "basis_flag_refs",
        "cited_turns",
        "cited_records",
        "corroboration_needed",
        "rationale",
    ]
    for stem in ("deep.v1", "final.v1"):  # the identical Finding, carried in full (S2 4.6, 4.7)
        assert export.schema_of(stem)["$defs"]["Finding"] == card["$defs"]["Finding"]


class _Unbounded(Contract):
    items: list[str]


class _Defaulted(Contract):
    note: str | None = None


class _FreeForm(Contract):
    extra: dict[str, str]


class _Bounded(Contract):
    items: Annotated[list[str], Field(max_length=3)]
    note: str | None


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("model", "problem"),
    [(_Unbounded, "unbounded list"), (_Defaulted, "fields with defaults"), (_FreeForm, "free-form object")],
)
def test_lint_schema_fails_on_the_defects_it_exists_for(model: type[BaseModel], problem: str) -> None:
    with pytest.raises(ConfigError, match=problem):
        lint_schema(model)


def test_lint_schema_passes_a_flat_bounded_model() -> None:
    assert lint_schema(_Bounded)["required"] == ["items", "note"]
