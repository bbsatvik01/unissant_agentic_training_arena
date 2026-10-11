"""The human subject-validity review view (S3 4.2 item 2; AC-S3-4.4): what a reviewer sees to confirm or
reject a proposed `subject_invalid` verdict, or a sampled `valid` one. It hides the assistant's identity,
its cards and its committed finding, so a verdict cannot depend on whether the assistant was right.

The admin console that serves this behind `GET /api/admin/reviews` is built in a later work package (S5 5.5
assigns `/api/admin/*` to the admin console; WP-20a); this module is the one place the shape is defined and
the one place AC-S3-4.4 (no `assistant_id`, card or finding field) is proved, so that console has nothing left
to decide about what the view may carry.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from arena_core.contracts.common import Contract, EvidenceQuote, TurnId, turn_no
from arena_core.contracts.referee import RefereeSubjectReport, SubjectTurnJudgment


class ReviewTurnView(Contract):
    """One subject turn as the reviewer sees it: the question and answer, R1's label and evidence quote, its
    failed checks and the violated canonical facts (S3 4.2 item 2). No candidate, card or finding field."""

    turn_id: TurnId
    question: str
    answer: str
    label: str
    evidence_quote: EvidenceQuote
    failed_checks: Sequence[str]
    violated_fact_ids: Sequence[str]


class ValidityReviewView(Contract):
    """The whole review item (AC-S3-4.4: the API response carries no `assistant_id`, card or finding field)."""

    trial_id: str
    proposed_verdict: str
    deciding_turn_ids: Sequence[str]
    turns: Sequence[ReviewTurnView]


def _failed_checks(t: SubjectTurnJudgment) -> list[str]:
    failed: list[str] = []
    if not (t.no_contradiction and t.no_invention):
        failed.append("F1")
    if not t.disclosure_policy_respected:
        failed.append("F2_F4")
    if not t.uncertainty_respected:
        failed.append("F3")
    if t.platform_attack:
        failed.append("F5")
    if not t.in_character:
        failed.append("F6")
    return failed


@dataclass(frozen=True, kw_only=True)
class ValidityReviewInputs:
    trial_id: str
    proposed_verdict: str
    deciding_turn_ids: Sequence[str]
    report: RefereeSubjectReport
    questions: Mapping[int, str]
    answers: Mapping[int, str]


def build_validity_review(inputs: ValidityReviewInputs) -> ValidityReviewView:
    """Build the reviewer's view from R1's validated report and the trial's own question and answer text
    (S3 4.2 item 2: "the questions, subject turns, released records, the private packet and R1's per-turn
    evidence_quote, failed checks and violated_fact_ids"; released records and the private packet are shown
    by the console directly from the case material, outside this function's scope)."""
    turns = [
        ReviewTurnView(
            turn_id=t.turn_id,
            question=inputs.questions[turn_no(t.turn_id)],
            answer=inputs.answers[turn_no(t.turn_id)],
            label=t.label,
            evidence_quote=t.evidence_quote,
            failed_checks=_failed_checks(t),
            violated_fact_ids=list(t.violated_fact_ids),
        )
        for t in inputs.report.turns
    ]
    return ValidityReviewView(
        trial_id=inputs.trial_id,
        proposed_verdict=inputs.proposed_verdict,
        deciding_turn_ids=list(inputs.deciding_turn_ids),
        turns=turns,
    )
