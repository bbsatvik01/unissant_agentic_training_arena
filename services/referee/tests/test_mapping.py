"""arena_referee.mapping: raw trial rows to the referee prompt builders' typed inputs (S2 7.1-7.3)."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from arena_core.agents.manifests import load_prompts, referee_manifest, with_hash
from arena_core.agents.referee_prompts import build_referee_assistant_prompt, build_referee_subject_prompt
from arena_core.agents.rubric import Rubric
from arena_core.contracts.adapter import adapt_subject_report
from arena_core.contracts.referee import RefereeSubjectReport, apply_quote_check
from arena_core.referee.pipeline import independent_label_rows
from arena_core.scoring.rubric import CHECKS
from arena_referee.mapping import (
    TrialData,
    adapted_cards,
    build_assistant_input,
    build_subject_input,
    build_triggers,
    material_fact_ids,
    trial_rows,
)

REPO = Path(__file__).resolve().parents[3]
F01_FILE = json.loads((REPO / "cases/dev/F01.json").read_text(encoding="utf-8"))
TRUTHFUL = F01_FILE["variants"]["truthful"]
# The referee manifest, computed fresh from the committed prompt files (S2 3.3); no rubric.v1 yet (S2 7.4), so
# the assistant prompt needs a development placeholder, as `test_referee_prompts.py` uses.
REFEREE = load_prompts(with_hash(referee_manifest(REPO)))


def _card(turn_no: int) -> dict[str, Any]:
    return {
        "schema_version": "card.v1",
        "turn_id": f"t{turn_no:02d}",
        "question": {"question_type": "open", "neutrality_issues": [], "assessment": "An open question."},
        "answer_category": "responsive",
        "flags": [],
        "follow_up": {
            "question": "What task took you there?",
            "tactic": "funnel_probe",
            "purpose": "Ask for the task.",
            "record_request": None,
        },
        "finding": {
            "label": "insufficient_evidence",
            "likelihood": "roughly_even_chance",
            "confidence": "low",
            "basis_flag_refs": [],
            "cited_turns": [],
            "cited_records": [],
            "corroboration_needed": ["the work order"],
            "rationale": "Not yet established.",
            "alternative_explanations": None,
            "last_revised_turn": turn_no,
        },
        "boundary_notice": False,
        "commit_requested": False,
        "card_seq": turn_no,
        "turn_no": turn_no,
        "candidate_sha256": "a" * 64,
        "validation": {"valid": True, "flags": {}, "demeanor_in_rationale": False},
        "latency_ms": 1200,
        "work_item": "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
        "transcript_version": 2 * turn_no,
    }


RELEASED_AFTER = 2


def _turn(turn_no: int, question: str, answer: str) -> dict[str, Any]:
    return {"turn_no": turn_no, "question": question, "answer": answer, "question_source": "investigator"}


def fixture() -> TrialData:
    return TrialData(
        trial_id="00000000-0000-0000-0000-00000000000a",
        split="dev",
        canonical_facts=TRUTHFUL["evaluator_packet"]["canonical_facts"],
        private_packet=TRUTHFUL["private_packet"],
        public_packet=TRUTHFUL["public_packet"],
        released=[
            {
                "record_id": "rec-01",
                "title": "Facilities work orders assigned to J. Pell, 12 March 2026",
                "content": {"body": "2 work orders.", "table": None},
                "released_after": RELEASED_AFTER,
                "date": None,
            }
        ],
        transcript=[
            _turn(1, "Why were you in B-12?", "I was checking the alarm."),
            _turn(2, "What task took you there?", "A work order for the humidity alarm."),
        ],
        cards=[_card(1), _card(2)],
        final_finding=None,
    )


def test_material_fact_ids_matches_the_family_file() -> None:
    expected = {f["id"] for f in TRUTHFUL["evaluator_packet"]["canonical_facts"] if f["material"]}
    assert material_fact_ids(fixture()) == frozenset(expected)
    assert expected  # F01 has at least one material fact


def test_build_subject_input_validates_and_carries_every_canonical_fact() -> None:
    inp = build_subject_input(fixture())
    assert len(inp.canonical_facts) == len(TRUTHFUL["evaluator_packet"]["canonical_facts"])
    assert [t.turn_no for t in inp.transcript] == [1, 2]
    assert inp.packet.role == "truthful"


def test_build_subject_input_renders_a_real_prompt() -> None:
    """End to end: the mapped input survives the real R1 prompt builder (WP-10), proving the shapes agree."""
    inp = build_subject_input(fixture())
    prompt = build_referee_subject_prompt(inp, REFEREE)
    assert "Jordan Pell" in prompt.system_instruction or "Jordan Pell" in prompt.user_message


def test_build_assistant_input_followups_come_from_cards_in_assistant_mode() -> None:
    data = fixture()
    report = RefereeSubjectReport.model_validate(
        {
            "schema_version": "ref_subj.v5",
            "turns": [
                {
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
                },
                {
                    "turn_id": "t02",
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
                },
            ],
            "trajectory": {"self_consistent": True, "conflicts": []},
        }
    )
    triggers = build_triggers(data, report, "assistant")
    inp = build_assistant_input(data, "assistant", triggers)
    assert [f.turn_id for f in inp.followups] == ["t01", "t02"]
    assert all(f.tactic is not None for f in inp.followups)

    inv_input = build_assistant_input(data, "investigator", triggers)
    assert [f.turn_id for f in inv_input.followups] == ["t01", "t02"]
    assert all(f.tactic is None for f in inv_input.followups)


def test_build_assistant_input_renders_a_real_prompt() -> None:
    data = fixture()
    report = RefereeSubjectReport.model_validate(
        {"schema_version": "ref_subj.v5", "turns": [], "trajectory": {"self_consistent": True, "conflicts": []}}
    )
    triggers = build_triggers(data, report, "assistant")
    inp = build_assistant_input(data, "assistant", triggers)
    prompt = build_referee_assistant_prompt(inp, REFEREE, dev_rubric=_dev_rubric())
    assert prompt.user_message


def test_build_assistant_input_carries_a_committed_finding_and_its_citations() -> None:
    """A later turn's committed finding (`arena.final_findings`) projects into R2/R3's input with its own
    cited turns and records, distinct from `None` (the no-finding-yet case the other tests use)."""
    data = replace(
        fixture(),
        final_finding={
            "label": "deceptive",
            "likelihood": "likely",
            "confidence": "moderate",
            "basis_flag_refs": [],
            "cited_turns": [2],
            "cited_records": ["rec-01"],
            "corroboration_needed": [],
            "rationale": "The work order does not match the stated task.",
            "alternative_explanations": None,
            "last_revised_turn": 2,
        },
    )
    triggers = build_triggers(
        data,
        RefereeSubjectReport.model_validate(
            {"schema_version": "ref_subj.v5", "turns": [], "trajectory": {"self_consistent": True, "conflicts": []}}
        ),
        "assistant",
    )
    inp = build_assistant_input(data, "assistant", triggers)
    assert inp.finding is not None
    assert inp.finding.label == "deceptive"
    assert inp.citations.cited_turns == [2]
    assert inp.citations.cited_records == ["rec-01"]


def _dev_rubric() -> Rubric:
    names = {
        "D1": "clarity and neutrality",
        "D2": "response relevance",
        "D3": "evidence-based follow-up",
        "D4": "testing alternative explanations",
        "D5": "supported closure",
    }
    return Rubric.model_validate(
        {
            "rubric_version": "rubric.v1",
            "dimensions": [
                {
                    "dim_id": dim,
                    "name": names[dim],
                    "anchors_0_to_4": [f"anchor {k}" for k in range(5)],
                    "subchecks": [{"id": s, "text": f"placeholder text of {s}", "na_when": None} for s in ids],
                }
                for dim, ids in CHECKS.items()
            ],
        }
    )


def test_trial_rows_includes_initial_documents_and_released_records() -> None:
    rows = trial_rows(fixture())
    assert "doc-01" in rows.records
    assert "rec-01" in rows.records
    assert rows.records["rec-01"].released_after == RELEASED_AFTER
    assert rows.turns[1].answer == "I was checking the alarm."


def test_adapted_cards_round_trips_through_the_scorer_adapter() -> None:
    cards = adapted_cards(fixture())
    assert [c.turn_no for c in cards] == [1, 2]
    assert all(c.valid for c in cards)


def test_quote_check_and_compliance_derivation_on_a_real_report() -> None:
    """Sanity: the full S2 7.2 label-derivation path (apply_quote_check, adapt_subject_report) runs clean on a
    report shaped for this fixture's two turns."""
    report = RefereeSubjectReport.model_validate(
        {
            "schema_version": "ref_subj.v5",
            "turns": [
                {
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
                    "evidence_quote": "checking the alarm",
                }
            ],
            "trajectory": {"self_consistent": True, "conflicts": []},
        }
    )
    answers = {"t01": "I was checking the alarm."}
    checked, invalid = apply_quote_check(report, answers)
    assert invalid == frozenset()
    labels = adapt_subject_report(checked, invalid)
    rows = independent_label_rows(labels)
    assert rows == [{"turn_no": 1, "label": "responsive", "compliant": True, "rationale": "checking the alarm"}]
