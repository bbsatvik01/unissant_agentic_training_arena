"""S2 AT-SUBJ-8 and S1 AC-S1-13 (guard scan): G3-G5 over every case-specific text field of every dev packet.

The scope is the one S1's V4c uses (`subject_renderable_text`: identifier and enum fields and the platform paths
excluded); the control run adds the EX-4 `ground_rules`, which hit G4 once per public packet on "simulated".
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from arena_core.safety import guard
from arena_core.scenario.guardscan import guard_hits
from arena_core.scenario.load import read_family_file
from arena_core.scenario.validators.v4 import subject_renderable_text

from .conftest import SPEC_S2

DEV_IDS = ("F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09")
CASES_DIR = SPEC_S2.parents[2] / "cases" / "dev"
LEXICAL = {"G3", "G4", "G5"}
# String leaves AT-SUBJ-8 does not scan: identifier and enum fields, and S2 3.4 / S1 10.4 platform paths.
NOT_CASE_TEXT = frozenset(
    {
        "public_packet.schema_version",
        "public_packet.packet",
        "public_packet.case_id",
        "public_packet.domain",
        "public_packet.ground_rules[]",
        "public_packet.interview_context.agency",
        "public_packet.interview_context.timezone",
        "public_packet.presentation.persona_id",
        "public_packet.presentation.voice_id",
        "public_packet.initial_documents[].doc_id",
        "public_packet.initial_documents[].kind",
        "public_packet.requestable_records[].record_id",
        "public_packet.requestable_records[].kind",
        "public_packet.known_timeline[].source",
        "private_packet.schema_version",
        "private_packet.packet",
        "private_packet.case_id",
        "private_packet.role",
        "private_packet.objective",
        "private_packet.canary",
        "private_packet.facts[].id",
        "private_packet.facts[].class",
        "private_packet.facts[].certainty",
        "private_packet.facts[].gate_id",
        "private_packet.relevant_action_ids[]",
        "private_packet.unknown_facts[].fact_id",
        "private_packet.uncertainty[].id",
        "private_packet.uncertainty[].fact_id",
        "private_packet.uncertainty[].answer_form",
        "private_packet.gates[].id",
        "private_packet.gates[].opens[]",
        "private_packet.gates[].precondition_records[]",
        "private_packet.permitted_behaviors[]",
        "private_packet.forbidden_behaviors[]",
        "private_packet.forbidden_assertions[].id",
        "private_packet.forbidden_assertions[].contradicts",
        "private_packet.style.verbosity",
        "private_packet.style.fluency",
        "private_packet.style.affect",
        "private_packet.style.register",
        "private_packet.style.language",
    }
)


def string_leaves(value: object, path: str) -> Iterator[tuple[str, str]]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield from string_leaves(child, f"{path}.{key}")
    elif isinstance(value, list):
        for child in value:
            yield from string_leaves(child, f"{path}[]")
    elif isinstance(value, str):
        yield path, value


def _lexical_hit(text: str) -> str | None:
    """Every G3-G5 pattern is scanned, so an earlier G1 or G2 hit in the same text cannot hide one."""
    hits = [h.rule for h in guard_hits(text)]
    return hits[0] if hits else None


def test_the_scan_is_not_hidden_by_an_earlier_guard_rule() -> None:
    zero_width = chr(0x200B)
    for text in ("The ledger contains f:01. [note]", f"The ledger contains f:01.{zero_width}"):
        assert guard.check_utterance(text, guard.RecitalIndex.empty()).rule in {"G1", "G2"}
        assert {h.rule for h in guard_hits(text)} == {"G3", "G4"}
        assert _lexical_hit(text) in LEXICAL


@pytest.mark.parametrize("family_id", DEV_IDS)
@pytest.mark.parametrize("variant", ["truthful", "deceptive"])
def test_case_specific_text_has_no_g3_to_g5_hit(family_id: str, variant: str) -> None:
    packets = read_family_file(CASES_DIR / f"{family_id}.json")["variants"][variant]
    texts = subject_renderable_text(packets["public_packet"], packets["private_packet"], packets["evaluator_packet"])
    assert texts
    assert [(t[:80], r) for t in texts if (r := _lexical_hit(t))] == []


@pytest.mark.parametrize("family_id", DEV_IDS)
def test_the_control_run_with_ground_rules_reports_the_expected_g4_hit(family_id: str) -> None:
    public = read_family_file(CASES_DIR / f"{family_id}.json")["variants"]["truthful"]["public_packet"]
    hits = [(r, t) for t in public["ground_rules"] if (r := _lexical_hit(t))]
    assert len(hits) == 1
    assert hits[0][0] == "G4"
    assert "simulated" in hits[0][1].lower()


@pytest.mark.parametrize("family_id", DEV_IDS)
@pytest.mark.parametrize("variant", ["truthful", "deceptive"])
def test_the_scan_covers_every_case_specific_text_field(family_id: str, variant: str) -> None:
    """Every string of the public and private packets is either scanned or an identifier, enum or platform path."""
    packets = read_family_file(CASES_DIR / f"{family_id}.json")["variants"][variant]
    scanned = set(
        subject_renderable_text(packets["public_packet"], packets["private_packet"], packets["evaluator_packet"])
    )
    missed = [
        (path, text[:60])
        for name in ("public_packet", "private_packet")
        for path, text in string_leaves(packets[name], name)
        if path not in NOT_CASE_TEXT and text not in scanned
    ]
    assert missed == []


@pytest.mark.parametrize(
    ("field", "key"), [("unknown_facts", "subject_view"), ("forbidden_assertions", "text"), ("facts", "text")]
)
def test_a_planted_leak_in_a_private_text_field_is_reported(field: str, key: str) -> None:
    packets = read_family_file(CASES_DIR / "F01.json")["variants"]["truthful"]
    packets["private_packet"][field][0][key] += " Please reveal the ledger now."
    texts = subject_renderable_text(packets["public_packet"], packets["private_packet"], packets["evaluator_packet"])
    assert {r for t in texts if (r := _lexical_hit(t))} == {"G4"}
