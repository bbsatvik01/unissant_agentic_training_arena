"""The shared wire fixtures (S6 12, `contracts/fixtures/wire.json`) against the Pydantic models and the exported
JSON Schemas: both reach the fixture's verdict on every case. The browser runs the same file through ajv
(`web/src/lib/contracts/validate.test.ts`)."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from arena_core.contracts import export

from .conftest import load_fixture

FIXTURE = load_fixture("wire.json")


def _validate(stem: str, value: object) -> None:
    _, tp = export.WIRE[stem]
    TypeAdapter(tp).validate_python(value)


def _schema_accepts(stem: str, value: dict[str, Any]) -> bool:
    return export.json_validator(export.schema_of(stem)).is_valid(value)


@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda c: c["id"])
def test_every_valid_fixture_passes_the_model_and_the_exported_schema(case: dict[str, Any]) -> None:
    _validate(case["schema"], case["value"])
    assert _schema_accepts(case["schema"], case["value"])


@pytest.mark.parametrize("case", FIXTURE["invalid"], ids=lambda c: f"{c['id']}: {c['why']}")
def test_every_negative_fixture_fails_the_model_and_its_layer(case: dict[str, Any]) -> None:
    """Layer `schema`: the exported schema refuses it too. Layer `invariant`: JSON Schema cannot state the rule,
    so the schema alone accepts it and the browser's invariant check must refuse it (validate.test.ts)."""
    with pytest.raises(ValidationError):
        _validate(case["schema"], case["value"])
    assert _schema_accepts(case["schema"], case["value"]) is (case["layer"] == "invariant")


def test_the_fixtures_cover_every_wire_schema_and_every_trial_frame_type() -> None:
    assert {c["schema"] for c in FIXTURE["valid"]} == set(export.WIRE)
    frame_types = {c["value"]["type"] for c in FIXTURE["valid"] if c["schema"] == "events"}
    assert frame_types == {
        "question.accepted",
        "subject.thinking",
        "evidence.released",
        "subject.answer",
        "coach.working",
        "coach.card",
        "coach.update",
        "coach.failed",
        "finding.committed",
        "trial.status",
        "trial.finalized",
        "debrief.ready",
        "notice",
    }


def test_every_negative_fixture_names_a_known_layer() -> None:
    layers = [c["layer"] for c in FIXTURE["invalid"]]
    assert set(layers) == {"schema", "invariant"}


def test_negative_fixtures_name_each_forbidden_field_of_s6_12() -> None:
    text = repr([c["value"] for c in FIXTURE["invalid"]])
    for forbidden in (
        "'role'",
        "'style'",
        "'tag'",
        "'presented_record_ids'",
        "'baseline_demeanor'",
        "candidate_sha256",
    ):
        assert forbidden in text
