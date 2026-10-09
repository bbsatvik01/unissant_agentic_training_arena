"""The packaged S1 schemas (v1.2) and the V1 validator that resolves them by `$id` (AC-S1-01)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from arena_core.scenario import schema

SPEC_SCHEMAS = Path(__file__).resolve().parents[4] / "docs" / "spec" / "schemas"


def test_packaged_schemas_are_byte_identical_to_the_spec_copies() -> None:
    packaged = schema.SCHEMA_DIR
    spec_names = sorted(p.name for p in SPEC_SCHEMAS.glob("*.schema.json"))
    assert spec_names == sorted(schema.SCHEMA_FILES)
    for name in spec_names:
        assert (packaged / name).read_bytes() == (SPEC_SCHEMAS / name).read_bytes(), name


def test_every_schema_is_draft_2020_12_and_registered_by_id() -> None:
    schemas = schema.load_schemas()
    for parsed in schemas.values():
        assert parsed["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        Draft202012Validator.check_schema(parsed)
        assert schema.registry().contents(parsed["$id"]) == schema.with_ecma_patterns(parsed)


def test_the_family_validator_accepts_the_seeds_through_ref_resolution(seeds: list[dict[str, Any]]) -> None:
    validator = schema.family_validator()
    assert validator.schema == schema.with_ecma_patterns(schema.load_schemas()[schema.CASE_FAMILY])
    for family in seeds:
        assert list(validator.iter_errors(family)) == []


def test_a_packet_error_is_reported_through_the_reference(seed: Callable[[str], dict[str, Any]]) -> None:
    family = seed("F01")
    family["variants"]["truthful"]["private_packet"]["limits"]["max_exchanges"] = 13
    errors = list(schema.family_validator().iter_errors(family))
    assert [list(e.absolute_path) for e in errors] == [
        ["variants", "truthful", "private_packet", "limits", "max_exchanges"]
    ]


def test_schema_enum_reads_the_catalogs() -> None:
    assert set(schema.schema_enum("case-family.schema.json", "violationType")) == {
        "unauthorized_area_entry",
        "sealed_material_access",
        "unregistered_visitor_escort",
        "tailgating_assist",
        "badge_sharing",
        "spare_credential_misuse",
        "key_misuse",
        "after_hours_property_removal",
        "alarm_bypass",
        "secured_door_propping",
        "escort_duty_breach",
        "access_record_alteration",
    }  # the 12-type catalog of S1 8.1 (schema v1.2)
    assert "context_change" in schema.schema_enum("public-packet.schema.json", "artifactKind")


@pytest.mark.parametrize(
    ("pattern", "python"),
    [
        ("^C-[0-9A-HJKMNP-TV-Z]{8}$", "^C-[0-9A-HJKMNP-TV-Z]{8}\\Z"),
        ("^(doc-0[1-4]|rec-0[1-6])$", "^(doc-0[1-4]|rec-0[1-6])\\Z"),
        ("^[$]x$", "^[$]x\\Z"),  # a `$` in a class is a literal
        ("^a\\$b$", "^a\\$b\\Z"),  # an escaped `$` is a literal
        ("^doc-", "^doc-"),
    ],
)
def test_ecma_pattern_anchors_only_at_the_true_end(pattern: str, python: str) -> None:
    assert schema.ecma_pattern(pattern) == python


def test_only_pattern_keywords_are_translated() -> None:
    node = {"pattern": "^a$", "properties": {"pattern": {"pattern": "^b$", "const": "c$"}}, "enum": ["d$"]}
    assert schema.with_ecma_patterns(node) == {
        "pattern": "^a\\Z",
        "properties": {"pattern": {"pattern": "^b\\Z", "const": "c$"}},
        "enum": ["d$"],
    }


def test_a_trailing_newline_never_matches_an_anchored_pattern(seed: Callable[[str], dict[str, Any]]) -> None:
    family = seed("F01")
    family["variants"]["truthful"]["public_packet"]["interview_context"]["interview_date"] += "\n"
    errors = list(schema.family_validator().iter_errors(family))
    assert [e.absolute_path[-1] for e in errors] == ["interview_date"]
