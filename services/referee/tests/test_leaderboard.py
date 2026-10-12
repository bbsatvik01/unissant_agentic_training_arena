"""`arena_referee.leaderboard.candidate_inputs` (S3 4.3, 5.3): groups raw trial facts by assistant candidate
and classifies each with WP-15's own `inclusion()`/`block_invalid()` -- parity with the sealed manifest by
construction."""

from __future__ import annotations

import dataclasses
from datetime import UTC, datetime
from decimal import Decimal
from fractions import Fraction
from typing import Any

from arena_core.contracts.referee import RefereeSubjectReport
from arena_core.referee.leaderboard import TrialScore
from arena_core.scoring.inclusion import Exec, SubjInc
from arena_core.scoring.kpi import LatencyRow
from arena_referee.db import StoredTrialJudgments, TrialFacts
from arena_referee.leaderboard import candidate_inputs, subject_inputs, trial_score
from arena_referee.mapping import TrialData, build_triggers

TWO = 2
FULL_BLOCK = 18

BASE = TrialFacts(
    planned_trial_id="p1",
    track="interactive",
    assistant_id="A1",
    subject_id="S1",
    family_id="F01",
    role="truthful",
    block_id="B1",
    exec_state=Exec.COMPLETED,
    verdict="valid",
    classification="truthful",
    settled_cost=Decimal("0.01"),
)


def test_a_replay_corpus_row_has_no_assistant_and_is_excluded_from_every_candidate() -> None:
    facts = [dataclasses.replace(BASE, assistant_id=None, track="replay_corpus")]
    assert candidate_inputs(facts) == []


def test_completed_valid_trials_are_included_with_their_committed_label() -> None:
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", role="truthful", classification="truthful"),
        dataclasses.replace(BASE, planned_trial_id="p2", role="deceptive", classification="deceptive"),
    ]
    [candidate] = candidate_inputs(facts)
    assert candidate.candidate_id == "A1"
    assert len(candidate.trials) == TWO
    assert candidate.own_planned == TWO
    # Codex finding #11 (M05's required per-subject count-matrix breakdown): the row's own subject must
    # survive onto the included TrialOutcome, never collapse to the default empty subject_id.
    assert {t.subject_id for t in candidate.trials} == {"S1"}
    assert candidate.excluded_truthful_by_family == {}


def test_subject_invalid_excludes_the_assistant_and_counts_against_the_truthful_family() -> None:
    facts = [dataclasses.replace(BASE, role="truthful", verdict="subject_invalid")]
    [candidate] = candidate_inputs(facts)
    assert candidate.trials == []
    assert candidate.excluded_truthful_by_family == {"F01": 1}
    assert candidate.reasons == [("truthful", "subject_invalid")]


def test_subject_invalid_on_a_deceptive_role_trial_counts_as_an_excluded_deceptive_trial() -> None:
    # Codex finding #11: an excluded deceptive-role trial must feed `excluded_deceptive_by_family` (F14
    # attrition, M21's "complete family" test), the same way an excluded truthful-role trial feeds
    # `excluded_truthful_by_family`.
    facts = [dataclasses.replace(BASE, role="deceptive", verdict="subject_invalid")]
    [candidate] = candidate_inputs(facts)
    assert candidate.trials == []
    assert candidate.excluded_truthful_by_family == {}
    assert candidate.excluded_deceptive_by_family == {"F01": 1}


def test_assistant_failed_with_a_valid_verdict_is_included_as_insufficient() -> None:
    facts = [dataclasses.replace(BASE, exec_state=Exec.ASSISTANT_FAILED, classification=None)]
    [candidate] = candidate_inputs(facts)
    [trial] = candidate.trials
    assert trial.committed_label is None  # output_of() reads the synthetic insufficient_evidence from asst_inc


def test_one_infra_failure_invalidates_the_whole_block_for_every_row_in_it() -> None:
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", exec_state=Exec.INFRA_FAILED),
        *[dataclasses.replace(BASE, planned_trial_id=f"p{i}") for i in range(2, FULL_BLOCK + 1)],
    ]
    candidate = candidate_inputs(facts)[0]
    assert candidate.trials == []  # every row in the invalidated block is excluded
    assert {reason for _role, reason in candidate.reasons} == {"block_invalid_infra"}


def test_cost_rows_carry_every_own_call_whether_or_not_the_trial_is_included() -> None:
    # block_id=None: an isolated pair, so the 5%-infra-failure block rule never ropes the completed trial in too.
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", block_id=None, settled_cost=Decimal("0.05")),
        dataclasses.replace(
            BASE, planned_trial_id="p2", block_id=None, exec_state=Exec.INFRA_FAILED, settled_cost=Decimal("0.02")
        ),
    ]
    candidate = candidate_inputs(facts)[0]
    assert sorted(candidate.own_cost_rows) == sorted([(Decimal("0.05"), True), (Decimal("0.02"), False)])


def test_reasons_carry_each_row_s_own_role_for_m23s_per_role_breakdown() -> None:
    # Codex finding #15: M23's per-role breakdown needs each reason tagged with the row's own role.
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", role="truthful"),
        dataclasses.replace(BASE, planned_trial_id="p2", role="deceptive", verdict="subject_invalid"),
    ]
    [candidate] = candidate_inputs(facts)
    assert set(candidate.reasons) == {("truthful", "included"), ("deceptive", "subject_invalid")}


def test_rows_group_by_their_own_assistant_candidate() -> None:
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", assistant_id="A1"),
        dataclasses.replace(BASE, planned_trial_id="p2", assistant_id="A2"),
    ]
    by_id = {c.candidate_id: c for c in candidate_inputs(facts)}
    assert set(by_id) == {"A1", "A2"}


# ---------------------------------------------------------------- per-trial scores from stored judgments (M06-M10)

TRIAL = "00000000-0000-0000-0000-00000000000a"


def _card(turn: int) -> dict[str, Any]:
    return {
        "schema_version": "card.v1",
        "turn_id": f"t{turn:02d}",
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
            "last_revised_turn": turn,
        },
        "boundary_notice": False,
        "commit_requested": False,
        "card_seq": turn,
        "turn_no": turn,
        "candidate_sha256": "a" * 64,
        "validation": {"valid": True, "flags": {}, "demeanor_in_rationale": False},
        "latency_ms": 1200,
        "work_item": "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
        "transcript_version": 2 * turn,
    }


def _r1_turn(n: int) -> dict[str, Any]:
    return {
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


def stored(
    n: int, *, open_questions: bool = True, unavailable: tuple[int, ...] = (), uncertain: tuple[int, ...] = ()
) -> StoredTrialJudgments:
    """`n` proposals, each judged by R2 (`open_questions=False` makes every one closed), plus `unavailable` turns
    whose card never came; `uncertain` answers are labeled genuine uncertainty, and R2 answers each 2b trigger the
    referee input carries (`build_triggers`, the same population the scorer uses)."""
    data = TrialData(
        trial_id=TRIAL,
        split="dev",
        canonical_facts=[{"id": "f:01", "statement": "A fact.", "material": True}],
        private_packet={},
        public_packet={"initial_documents": []},
        released=[],
        transcript=[
            {"turn_no": k, "question": f"Q{k}?", "answer": f"Answer {k}.", "question_source": "investigator"}
            for k in range(1, n + 1)
        ],
        cards=[_card(k) for k in range(1, n + 1)],
        final_finding=None,
        unavailable_turns=unavailable,
    )
    turns = [
        {**_r1_turn(k), "label": "genuine_uncertainty", "asked_fact_status": "unknown", "uncertainty_expressed": True}
        if k in uncertain
        else _r1_turn(k)
        for k in range(1, n + 1 + len(unavailable))
    ]
    data = dataclasses.replace(
        data,
        transcript=[
            {"turn_no": k, "question": f"Q{k}?", "answer": f"Answer {k}.", "question_source": "investigator"}
            for k in range(1, n + 1 + len(unavailable))
        ],
    )
    r1 = {
        "report": {
            "schema_version": "ref_subj.v5",
            "turns": turns,
            "trajectory": {"self_consistent": True, "conflicts": []},
        },
        "quote_invalid": [],
    }
    triggers = build_triggers(data, RefereeSubjectReport.model_validate(r1["report"]), "assistant")
    followups = [
        {
            "turn_id": f"t{k:02d}",
            "question_type": "open" if open_questions else "closed",
            "not_leading": True,
            "well_framed": True,
            "no_loaded_wording": True,
            "on_objective": True,
            "builds_on_previous": True,
        }
        for k in range(1, n + 1)
    ]
    subchecks: list[dict[str, Any]] = [
        {"id": s, "result": "pass", "turn_ids": []} for s in ("3a", "3b", "4a", "4c", "4d")
    ]
    subchecks.append({"id": "3d", "result": "na", "turn_ids": []})
    subchecks += [{"id": t.subcheck_id, "result": "fail", "turn_ids": []} for t in triggers if t.subcheck_id == "2b"]
    r2 = {"schema_version": "ref_asst.v2", "flags": [], "followups": followups, "citations": [], "subchecks": subchecks}
    return StoredTrialJudgments(data=data, r1=r1, r2=r2)


def test_trial_score_computes_qq_from_the_stored_judgments() -> None:
    good = trial_score("F01", stored(3))
    closed = trial_score("F01", stored(3, open_questions=False))
    assert good.qq is not None
    assert closed.qq is not None
    assert good.qq > closed.qq  # 1b (open or probing share) fails for an all-closed sequence
    assert good.closure is None  # no committed finding: no M10 contribution
    assert good.strict is not None
    assert (good.strict.tp, good.strict.flags, good.strict.events) == (0, 0, 0)
    assert good.support is not None
    assert good.support.unique == 0


def test_a_missing_card_is_a_proposal_that_fails_and_two_proposals_are_unscorable() -> None:
    assert trial_score("F01", stored(2)).qq is None  # fewer than 3 proposals (S3 2.2)
    with_gap, full = trial_score("F01", stored(3, unavailable=(4,))).qq, trial_score("F01", stored(3)).qq
    assert with_gap is not None
    assert full is not None
    assert with_gap < full


def test_r2_and_the_scorer_share_the_proposal_population_when_a_card_never_came() -> None:
    # Codex r4 #2: cards 1-3, card 4 unavailable, answer 4 genuine uncertainty. R2's triggers must include the
    # missing proposal's 2b window, or the scorer finds 2b applicable where R2 answered nothing and raises.
    case = stored(3, unavailable=(4,), uncertain=(4,))
    triggers = build_triggers(case.data, RefereeSubjectReport.model_validate(case.r1["report"]), "assistant")
    assert [(t.subcheck_id, t.question_turns) for t in triggers] == [("2b", [4])]
    assert trial_score("F01", case).qq is not None


def test_candidate_inputs_attach_scores_and_latency_to_each_included_trial() -> None:
    commit = datetime(2026, 10, 1, tzinfo=UTC)
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", trial_id="t1", cell="c1"),
        dataclasses.replace(BASE, planned_trial_id="p2", trial_id="t2", cell="c2"),  # included, never scored
        dataclasses.replace(BASE, planned_trial_id="p3", trial_id="t3", verdict="subject_invalid"),  # excluded
    ]
    score = TrialScore(family_id="F01", qq=Fraction(1, 2))
    latency = [
        LatencyRow("t1", 1, "harness", "delivered", commit, None, commit),
        LatencyRow("other", 1, "harness", "delivered", commit, None, commit),
    ]
    [candidate] = candidate_inputs(facts, {"t1": score, "t3": score}, latency)
    assert list(candidate.scored) == [score, TrialScore(family_id="F01")]
    assert list(candidate.cells) == ["c1", "c2"]  # aligned with the included trials
    assert [r.trial_id for r in candidate.latency] == ["t1"]


def test_subject_inputs_group_by_subject_skip_replay_rows_and_read_r1_labels() -> None:
    r1 = {
        "report": {
            "schema_version": "ref_subj.v5",
            "turns": [_r1_turn(1), {**_r1_turn(2), "no_invention": False}],
            "trajectory": {"self_consistent": True, "conflicts": []},
        },
        "quote_invalid": [],
    }
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", trial_id="t1"),
        dataclasses.replace(BASE, planned_trial_id="p2", trial_id="t2", verdict="subject_invalid"),
        dataclasses.replace(BASE, planned_trial_id="p3", trial_id="t3", track="replay"),  # re-reads a corpus row
        dataclasses.replace(
            BASE, planned_trial_id="p4", trial_id="t4", subject_id="S2", assistant_id=None, track="replay_corpus"
        ),
    ]
    by_id = {c.candidate_id: c for c in subject_inputs(facts, {"t1": r1})}
    assert set(by_id) == {"S1", "S2"}
    first, second = by_id["S1"].trials
    assert first.output == "truthful"
    assert first.labels is not None
    assert [lab.compliant for lab in first.labels.values()] == [True, False]
    assert (second.output, second.labels, second.subj_inc) == (None, None, SubjInc.AGAINST_SUBJECT)
    [corpus] = by_id["S2"].trials
    assert corpus.output is None  # no assistant on a corpus row: never an invented outcome


def test_rows_show_each_candidate_s_registered_display_name() -> None:
    # S3 5.6 / S6: a row names its candidate by the manifest's display name, never the bare id.
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", assistant_id="A1", subject_id="S1"),
        dataclasses.replace(BASE, planned_trial_id="p2", assistant_id="A2", subject_id="S1"),
    ]
    names = {"A1": "Coach Alpha", "S1": "Subject One"}
    assert [c.display_name for c in candidate_inputs(facts, names=names)] == ["Coach Alpha", "A2"]
    assert [c.display_name for c in subject_inputs(facts, {}, names)] == ["Subject One"]
