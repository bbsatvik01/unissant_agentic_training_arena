"""S2 3.1: a manifest hashes the schema a request actually carries, after `vertex_schema`."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from arena_core.agents.manifests import (
    OUTPUT_MODELS,
    CandidateManifest,
    committed_manifest,
    referee_manifest,
    with_hash,
)
from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.ids import canonical_sha256
from arena_core.providers import structured
from arena_core.providers.structured import sent_schema, vertex_schema

ALLOWED = structured._VERTEX_SCHEMA_KEYS  # the keyword set the provider documents


@dataclass
class FakeVertex:
    """Captures each request's generation config, as the fake model port does (S5 10.4)."""

    requests: list[tuple[str, list[Any], dict[str, Any]]] = field(default_factory=list)

    def generate_content(self, model: str, contents: list[Any], config: dict[str, Any]) -> str:
        self.requests.append((model, contents, config))
        return "{}"


def _send(client: FakeVertex, output: type[BaseModel]) -> dict[str, Any]:
    """What the port puts in a request for `output` (S2 1, Structured output)."""
    client.generate_content(
        "gemini-3.5-flash-lite",
        [{"role": "user", "parts": [{"text": "x"}]}],
        {"response_mime_type": "application/json", "response_json_schema": sent_schema(output)},
    )
    captured: dict[str, Any] = client.requests[-1][2]["response_json_schema"]
    return captured


def _keywords(node: object, out: set[str]) -> set[str]:
    if isinstance(node, list):
        for item in node:
            _keywords(item, out)
    elif isinstance(node, dict):
        for key, value in node.items():
            out.add(key)
            if key in ("properties", "$defs") and isinstance(value, dict):
                for sub in value.values():
                    _keywords(sub, out)
            elif key != "enum":
                _keywords(value, out)
    return out


# The committed manifests (what a roster registers), and the referee's as generated.
MANIFESTS = [*(committed_manifest(c) for c in ("A1", "A2", "A3", "S1", "S2", "S3")), with_hash(referee_manifest())]


@pytest.mark.parametrize("manifest", MANIFESTS, ids=[m.candidate_id for m in MANIFESTS])
def test_each_manifest_schema_hash_is_the_captured_request_schema(manifest: CandidateManifest) -> None:
    assert manifest.prompt is not None
    client = FakeVertex()
    for ref in manifest.prompt.output_schemas:
        captured = _send(client, OUTPUT_MODELS[(ref.name, ref.version)])
        assert ref.sha256 == canonical_sha256(captured)
        assert _keywords(captured, set()) <= ALLOWED
        assert "maxBytes" not in str(captured)
        assert "uniqueItems" not in str(captured)


def test_vertex_schema_drops_undocumented_keywords_and_keeps_names_and_enums() -> None:
    raw = {
        "type": "object",
        "properties": {"pattern": {"type": "string", "pattern": "^x$", "maxLength": 3, "maxBytes": 6}},
        "required": ["pattern"],
        "allOf": [{"if": {}}],
        "$defs": {"E": {"enum": ["maxLength", "const"], "const": "x", "default": "y"}},
    }
    assert vertex_schema(raw) == {
        "type": "object",
        "properties": {"pattern": {"type": "string"}},
        "required": ["pattern"],
        "$defs": {"E": {"enum": ["maxLength", "const"]}},
    }
    assert vertex_schema(vertex_schema(raw)) == vertex_schema(raw)


def _array_bounds(node: object, defs: dict[str, Any], out: list[tuple[str, bool, bool]]) -> None:
    """(item kind, has maxItems, has minItems) for every array in a sent schema."""
    if isinstance(node, list):
        for item in node:
            _array_bounds(item, defs, out)
    elif isinstance(node, dict):
        if node.get("type") == "array":
            items = node.get("items", {})
            ref = items.get("$ref", "").rsplit("/", 1)[-1]
            kind = "object" if ref or items.get("type") == "object" else str(items.get("type"))
            out.append((kind, "maxItems" in node, "minItems" in node))
        for key, value in node.items():
            if key != "enum":
                _array_bounds(value, defs, out)


def test_referee_reports_leave_object_list_bounds_to_validation() -> None:
    # Real pilot: Vertex answers HTTP 400 INVALID_ARGUMENT to ref_subj.v5 and ref_asst.v2 as sent with their
    # object-list bounds (gemini-3.1-flash-lite and gemini-3.5-flash-lite); the same schemas without the bounds on
    # lists of objects are served. The bound stays in the contract and is enforced by validation (one repair).
    for report in (RefereeSubjectReport, RefereeAssistantReport):
        bounds: list[tuple[str, bool, bool]] = []
        schema = sent_schema(report)
        _array_bounds(schema, schema.get("$defs", {}), bounds)
        assert [b for b in bounds if b[0] == "object"], report.__name__
        assert all(not b[1] and not b[2] for b in bounds if b[0] == "object"), report.__name__
        assert all(b[1] for b in bounds if b[0] != "object"), report.__name__  # scalar lists keep their bound
        assert "maxItems" in str(structured.lint_schema(report))  # the contract itself is still bounded


def test_candidate_schemas_keep_every_list_bound() -> None:
    for (name, _version), output in OUTPUT_MODELS.items():
        if name.startswith("Referee"):
            continue
        bounds: list[tuple[str, bool, bool]] = []
        _array_bounds(sent_schema(output), {}, bounds)
        assert all(b[1] for b in bounds), name


def test_a_referee_report_over_its_list_bound_still_fails_validation() -> None:
    turn: dict[str, Any] = {
        "turn_id": "t01",
        "label": "responsive",
        "eva_subtype": None,
        "pfq_reason": None,
        "requested_fact_ids": [],
        "asked_fact_status": "known",
        "uncertainty_expressed": False,
        "innocent_explanation_offered": False,
        "record_conflict_ids": [],
        "no_contradiction": True,
        "no_invention": True,
        "violated_fact_ids": [],
        "uncertainty_respected": True,
        "disclosure_policy_respected": True,
        "in_character": True,
        "style_followed": True,
        "platform_attack": False,
        "evidence_quote": "",
    }
    report = {"schema_version": "ref_subj.v5", "trajectory": {"self_consistent": True, "conflicts": []}}
    turns = [{**turn, "turn_id": f"t{n:02d}"} for n in range(1, 14)]
    RefereeSubjectReport.model_validate({**report, "turns": turns[:12]})
    with pytest.raises(ValidationError, match="at most 12 items"):
        RefereeSubjectReport.model_validate({**report, "turns": turns})
