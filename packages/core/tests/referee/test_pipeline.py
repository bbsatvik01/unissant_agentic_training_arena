"""arena_core.referee.pipeline: R1 label-row shaping, the S3 4.2 validity decision and debrief.v1 assembly."""

from __future__ import annotations

from fractions import Fraction
from typing import Any

from arena_core.contracts.adapter import Card, adapt_card, adapt_subject_report, flag_key
from arena_core.contracts.citations import Turn
from arena_core.contracts.referee import FlagVerdict, RefereeSubjectReport
from arena_core.referee.pipeline import (
    ScoredDebriefInputs,
    assemble_scored_debrief,
    decide_validity,
    detection_payload,
    independent_label_rows,
    learning_payload,
    rubric_payload,
    subject_realism_payload,
    unscored_debrief,
)
from arena_core.scoring.flags import TrialRows
from arena_core.scoring.rubric import CheckResult, RubricResult

SHA = "a" * 64


def turn(n: int, **overrides: object) -> dict[str, Any]:
    base: dict[str, Any] = {
        "turn_id": f"t{n:02d}",
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
    if overrides.get("label") == "evasion":
        base["eva_subtype"] = "omission"
    base.update(overrides)
    return base


def report(turns: list[dict[str, Any]]) -> RefereeSubjectReport:
    return RefereeSubjectReport.model_validate(
        {"schema_version": "ref_subj.v5", "turns": turns, "trajectory": {"self_consistent": True, "conflicts": []}}
    )


EVAL_PACKET = {
    "role": "deceptive",
    "synopsis": "Pell entered B-12 without an assigned task and did not disclose it unprompted.",
    "canonical_facts": [{"id": "f:09", "material": False}, {"id": "f:24", "material": True}],
    "rubric": {
        "key_questions": [
            {"intent": "Why was entry made?", "target_fact_ids": ["f:09"]},
            {"intent": "What happened at the door?", "target_fact_ids": ["f:24"]},
        ]
    },
}


# ---------------------------------------------------------------- independent_label_rows


def test_independent_label_rows_in_turn_order_matches_compliance() -> None:
    r = report([turn(1), turn(2, label="evasion")])
    labels = adapt_subject_report(r, frozenset())
    rows = independent_label_rows(labels)
    assert rows == [
        {"turn_no": 1, "label": "responsive", "compliant": True, "rationale": "no quote given"},
        {"turn_no": 2, "label": "evasion", "compliant": True, "rationale": "no quote given"},
    ]


# ---------------------------------------------------------------- decide_validity (S3 4.2, FX-V01..V03)


def test_fx_v01_material_violation_proposes_subject_invalid_not_auto_recordable() -> None:
    r = report([turn(1, requested_fact_ids=["f:09"], violated_fact_ids=["f:24"], no_contradiction=False)])
    d = decide_validity(r, EVAL_PACKET)
    assert d.verdict == "subject_invalid"
    assert d.deciding_turns == ("t01",)
    assert d.auto_recordable is False


def test_fx_v02_non_material_violation_proposes_valid_and_is_auto_recordable() -> None:
    r = report([turn(1, requested_fact_ids=["f:09"], violated_fact_ids=["f:09"], no_contradiction=False)])
    d = decide_validity(r, EVAL_PACKET)
    assert d.verdict == "valid"
    assert d.deciding_turns == ()
    assert d.auto_recordable is True


def test_fx_v03_platform_attack_proposes_subject_invalid() -> None:
    r = report([turn(1, platform_attack=True)])
    d = decide_validity(r, EVAL_PACKET)
    assert d.verdict == "subject_invalid"
    assert d.auto_recordable is False


# ---------------------------------------------------------------- rubric_payload


def test_rubric_payload_unscorable_branch() -> None:
    result = RubricResult(
        scorable=False, unscorable_reason="fewer than 3 questions", checks={}, dimensions={}, total=None, qq=None
    )
    payload = rubric_payload(result)
    assert payload.scorable is False
    assert payload.unscorable_reason == "fewer than 3 questions"
    assert payload.total is None
    assert payload.dimensions == []


def test_rubric_payload_scorable_maps_every_check_and_dimension() -> None:
    checks = {
        "1a": CheckResult(True, ()),
        "1b": CheckResult(True, ()),
        "1c": CheckResult(False, (1, 2)),
        "1d": CheckResult(True, ()),
        "2a": CheckResult(None, ()),
        "2b": CheckResult(None, ()),
        "2c": CheckResult(True, ()),
        "2d": CheckResult(True, ()),
        "3a": CheckResult(True, ()),
        "3b": CheckResult(True, ()),
        "3c": CheckResult(None, ()),
        "3d": CheckResult(None, ()),
        "3e": CheckResult(None, ()),
        "4a": CheckResult(True, ()),
        "4b": CheckResult(None, ()),
        "4c": CheckResult(True, ()),
        "4d": CheckResult(True, ()),
        "5a": CheckResult(True, ()),
        "5b": CheckResult(True, ()),
        "5c": CheckResult(True, ()),
        "5d": CheckResult(True, ()),
        "5e": CheckResult(None, ()),
    }
    d1_score, total = 3, 95
    result = RubricResult(
        scorable=True,
        unscorable_reason=None,
        checks=checks,
        dimensions={"D1": d1_score, "D2": 4, "D3": 4, "D4": 4, "D5": 4},
        total=total,
        qq=Fraction(15, 16),
    )
    payload = rubric_payload(result)
    assert payload.scorable is True
    assert payload.total == total
    d1 = next(d for d in payload.dimensions if d.dim_id == "D1")
    assert d1.score == d1_score
    c1c = next(c for c in d1.checks if c.id == "1c")
    assert c1c.result == "fail"
    assert c1c.turns == [1, 2]
    d2 = next(d for d in payload.dimensions if d.dim_id == "D2")
    c2a = next(c for c in d2.checks if c.id == "2a")
    assert c2a.result == "na"


# ---------------------------------------------------------------- learning_payload (FX-K05 shape)


def test_learning_payload_evidence_coverage_and_key_questions() -> None:
    turns = [turn(1, requested_fact_ids=["f:09"]), turn(2, requested_fact_ids=["f:24"])]
    r = report(turns)
    payload = learning_payload(r, EVAL_PACKET)
    assert payload.evidence_coverage.addressed == len(turns)
    assert payload.evidence_coverage.key_facts == len(turns)
    intents = {q.intent: q.addressed_turns for q in payload.key_questions}
    assert intents["Why was entry made?"] == [1]
    assert intents["What happened at the door?"] == [2]


# ---------------------------------------------------------------- detection_payload


def _card(turn_no: int, kind: str, quote: str, demeanor: bool = False) -> Card:
    payload: dict[str, Any] = {
        "schema_version": "card.v1",
        "turn_id": f"t{turn_no:02d}",
        "question": {"question_type": "open", "neutrality_issues": [], "assessment": "An open question."},
        "answer_category": "responsive",
        "flags": [
            {
                "kind": kind,
                "turn_id": f"t{turn_no:02d}",
                "quote": quote,
                "flag_ref": f"t{turn_no:02d}.f1",
                "missing_fact": "the task that required entry",
                "conflict_turn_id": None,
                "conflict_quote": None,
                "conflict_record_id": None,
                "conflict_record_quote": None,
            }
        ],
        "follow_up": {
            "question": "What task required entry?",
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
        "candidate_sha256": SHA,
        "validation": {
            "valid": True,
            "flags": {f"t{turn_no:02d}.f1": {"citation_ok": True, "demeanor_based": demeanor, "duplicate": False}},
            "demeanor_in_rationale": False,
        },
        "latency_ms": 1500,
        "work_item": "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
        "transcript_version": 2 * turn_no,
    }
    return adapt_card(payload)


def test_detection_payload_supported_evasion_flag_counts_as_true_positive() -> None:
    card = _card(1, "possible_evasion", "A busy shift, that's all.")
    trial = TrialRows({1: Turn("A busy shift, that's all.")}, {})
    full_support = {
        "flag_ref": "t01.f1",
        "quote_relevant": True,
        "claim_holds": True,
        "content_based": True,
        "no_outside_facts": True,
    }
    verdicts = {flag_key(card.flags[0]): FlagVerdict.model_validate(full_support)}
    payload = detection_payload([card], {1: "evasion"}, trial, verdicts)
    assert payload.evasion_strict.tp == 1
    assert payload.evasion_strict.flags == 1
    assert payload.evasion_strict.events == 1
    assert payload.unique_flags == 1
    assert payload.unsupported.citation == 0
    assert payload.coach_last_label == "insufficient_evidence"


def test_detection_payload_no_valid_card_gives_null_coach_last_label() -> None:
    payload = detection_payload([], {}, TrialRows({}, {}), {})
    assert payload.coach_last_label is None
    assert payload.unique_flags == 0


# ---------------------------------------------------------------- subject_realism_payload


def test_subject_realism_counts_compliance_and_per_check_failures() -> None:
    turns = [turn(1), turn(2, platform_attack=True), turn(3, in_character=False)]
    r = report(turns)
    labels = adapt_subject_report(r, frozenset())
    payload = subject_realism_payload(labels)
    assert payload.turns == len(turns)
    assert payload.compliant == 1
    assert payload.failures.F5 == 1
    assert payload.failures.F6 == 1
    assert payload.failures.F1 == 0


# ---------------------------------------------------------------- end to end


def test_unscored_debrief_carries_only_outcome() -> None:
    d = unscored_debrief("00000000-0000-0000-0000-00000000000a", EVAL_PACKET, None)
    assert d.scored is False
    assert d.outcome.role == "deceptive"
    assert d.outcome.committed_label is None


def test_assemble_scored_debrief_end_to_end() -> None:
    turns = [turn(1, requested_fact_ids=["f:09"]), turn(2, requested_fact_ids=["f:24"]), turn(3)]
    r = report(turns)
    checks = dict.fromkeys(
        [
            "1a",
            "1b",
            "1c",
            "1d",
            "2a",
            "2b",
            "2c",
            "2d",
            "3a",
            "3b",
            "3c",
            "3d",
            "3e",
            "4a",
            "4b",
            "4c",
            "4d",
            "5a",
            "5b",
            "5c",
            "5d",
            "5e",
        ]
    )
    rubric_checks = {k: CheckResult(True, ()) for k in checks}
    full_score = 4
    total_score = 100
    rubric_result = RubricResult(
        scorable=True,
        unscorable_reason=None,
        checks=rubric_checks,
        dimensions=dict.fromkeys(("D1", "D2", "D3", "D4", "D5"), full_score),
        total=total_score,
        qq=Fraction(1),
    )
    git_sha = "b" * 40
    d = assemble_scored_debrief(
        ScoredDebriefInputs(
            session_id="00000000-0000-0000-0000-00000000000a",
            evaluator_packet=EVAL_PACKET,
            committed_label="deceptive",
            subject_report=r,
            quote_invalid=frozenset(),
            rubric_result=rubric_result,
            cards=[],
            flag_verdicts={},
            trial_rows=TrialRows({}, {}),
            rubric_sha256=SHA,
            r3_prompt_sha256=(SHA, SHA),
            referee_model_ids=["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
            scorer_git_sha=git_sha,
        )
    )
    assert d.scored is True
    assert d.outcome.committed_label == "deceptive"
    assert d.rubric.total == total_score
    assert d.scorecards.learning.evidence_coverage.addressed == len(turns) - 1
    assert d.scorecards.subject_realism.turns == len(turns)
    assert d.provenance.scorer_git_sha == git_sha


def test_fx_d01_debrief_carries_no_candidate_hash_pseudonym_or_fact_id() -> None:
    """FX-D01 (S3 5.7): one scored session's debrief.v1 validates against the schema and carries no
    candidate hash, participant pseudonym or fact ID."""
    turns = [turn(1, requested_fact_ids=["f:09"]), turn(2, requested_fact_ids=["f:24"]), turn(3)]
    r = report(turns)
    rubric_checks = {
        k: CheckResult(True, ())
        for k in [
            "1a",
            "1b",
            "1c",
            "1d",
            "2a",
            "2b",
            "2c",
            "2d",
            "3a",
            "3b",
            "3c",
            "3d",
            "3e",
            "4a",
            "4b",
            "4c",
            "4d",
            "5a",
            "5b",
            "5c",
            "5d",
            "5e",
        ]
    }
    full_score = 4
    rubric_result = RubricResult(
        scorable=True,
        unscorable_reason=None,
        checks=rubric_checks,
        dimensions=dict.fromkeys(("D1", "D2", "D3", "D4", "D5"), full_score),
        total=100,
        qq=Fraction(1),
    )
    d = assemble_scored_debrief(
        ScoredDebriefInputs(
            session_id="00000000-0000-0000-0000-00000000000a",
            evaluator_packet=EVAL_PACKET,
            committed_label="deceptive",
            subject_report=r,
            quote_invalid=frozenset(),
            rubric_result=rubric_result,
            cards=[],
            flag_verdicts={},
            trial_rows=TrialRows({}, {}),
            rubric_sha256=SHA,
            r3_prompt_sha256=(SHA, SHA),
            referee_model_ids=["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
            scorer_git_sha="b" * 40,
        )
    )
    dumped = d.model_dump_json()
    for forbidden in ("candidate_sha256", "candidate_id", "participant", '"P0', '"f:'):
        assert forbidden not in dumped, f"{forbidden!r} leaked into debrief.v1"
