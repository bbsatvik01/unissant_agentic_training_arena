"""R1/R3 label storage shaping, the S3 4.2 validity decision and `debrief.v1` assembly (S2 7.2, 7.5; S3 1.3,
3.8, 4.2, 5.7). Pure functions over already-validated S2 and S3 types; every database write and the agent
port call live in `arena_referee` (S3 1.5: "the scorer runs inside the local arena-referee process").
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from arena_core.contracts.adapter import Card, SubjectLabel, adapt_subject_report
from arena_core.contracts.common import Label
from arena_core.contracts.debrief import (
    Counts,
    Detection,
    Failures,
    KeyQuestion,
    Learning,
    Outcome,
    Provenance,
    Rubric,
    RubricCheck,
    RubricDimension,
    Scorecards,
    ScoredDebrief,
    SubjectRealism,
    Unsupported,
)
from arena_core.contracts.debrief import (
    EvidenceCoverage as DebriefEvidenceCoverage,
)
from arena_core.contracts.referee import RefereeSubjectReport
from arena_core.scoring.coverage import evidence_coverage, key_fact_ids
from arena_core.scoring.exact import DIMENSIONS
from arena_core.scoring.flags import BROAD, STRICT, TrialRows, evasion_counts, support_counts
from arena_core.scoring.inclusion import material_fact_ids, propose_validity
from arena_core.scoring.rubric import CHECKS, CheckResult, RubricResult

__all__ = [
    "ScoredDebriefInputs",
    "ValidityDecision",
    "assemble_scored_debrief",
    "decide_validity",
    "detection_payload",
    "independent_label_rows",
    "learning_payload",
    "subject_realism_payload",
]

# ---------------------------------------------------------------- R1 storage (S2 7.2)


def independent_label_rows(labels: Mapping[int, SubjectLabel]) -> list[dict[str, Any]]:
    """`sealed.record_independent_labels`'s `p_rows`: one `{turn_no, label, compliant, rationale}` per subject
    turn, in turn order. `labels`: `contracts.adapter.adapt_subject_report`'s result (keyed by `turn_no`)."""
    return [
        {"turn_no": n, "label": labels[n].label, "compliant": labels[n].compliant, "rationale": labels[n].rationale}
        for n in sorted(labels)
    ]


# ---------------------------------------------------------------- S3 4.2 validity


@dataclass(frozen=True)
class ValidityDecision:
    """`propose_validity`'s result with what the referee does next (S2 7.2, S3 4.2). `auto_recordable` is true
    only for an automatic `valid` (nothing proposed): the referee calls `ledger.adjudicate_validity` itself,
    `decided_by='auto_rule'`. A proposed `subject_invalid` is never auto-recorded; it waits for the blinded
    human review the admin console runs (S3 4.2 item 2), which this part does not implement."""

    verdict: str
    deciding_turns: tuple[str, ...]
    auto_recordable: bool
    reason: str


_AUTO_REASON = "auto_rule: no turn fails F5, F6 or F1 on a material fact"
_PENDING_REASON = "subject_invalid proposed; pending human review"


def decide_validity(report: RefereeSubjectReport, evaluator_packet: Mapping[str, Any]) -> ValidityDecision:
    verdict, deciding = propose_validity(report, material_fact_ids(evaluator_packet))
    auto = verdict == "valid"
    return ValidityDecision(
        verdict=verdict,
        deciding_turns=tuple(deciding),
        auto_recordable=auto,
        reason=_AUTO_REASON if auto else _PENDING_REASON,
    )


# ---------------------------------------------------------------- debrief.v1 (S3 5.7)


def outcome_payload(evaluator_packet: Mapping[str, Any], committed_label: Label | None) -> Outcome:
    """`outcome.role` and `correct_finding` are the same evaluator-packet field (a truthful variant's correct
    finding is truthful, a deceptive variant's is deceptive); `resolution` is the packet's `synopsis`."""
    role = evaluator_packet["role"]
    return Outcome(
        role=role, correct_finding=role, committed_label=committed_label, resolution=evaluator_packet["synopsis"]
    )


DimId = Literal["D1", "D2", "D3", "D4", "D5"]


def _check_result(c: str, r: CheckResult) -> RubricCheck:
    word: Literal["pass", "fail", "na"] = "na" if r.result is None else ("pass" if r.result else "fail")
    return RubricCheck(id=c, result=word, turns=list(r.turns))


def rubric_payload(result: RubricResult) -> Rubric:
    """S3 2.8's dimension scores and per-check verdicts, or the unscorable branch (SG2-38)."""
    if not result.scorable:
        return Rubric(scorable=False, unscorable_reason=result.unscorable_reason, total=None, dimensions=[])
    dimensions = [
        RubricDimension(
            dim_id=cast(DimId, d),
            score=result.dimensions[d],
            checks=[_check_result(c, result.checks[c]) for c in CHECKS[d]],
        )
        for d in DIMENSIONS
    ]
    return Rubric(scorable=True, unscorable_reason=None, total=result.total, dimensions=dimensions)


def learning_payload(report: RefereeSubjectReport, evaluator_packet: Mapping[str, Any]) -> Learning:
    """S3 5.7 learning scorecard: evidence coverage (6.1) and, per key question, the turns whose
    `requested_fact_ids` meet its `target_fact_ids`."""
    key = key_fact_ids(evaluator_packet)
    cov = evidence_coverage(report, key)
    key_questions = []
    for q in evaluator_packet["rubric"]["key_questions"]:
        turns = sorted({t for f in q["target_fact_ids"] for t in cov.by_fact.get(f, ())})
        key_questions.append(KeyQuestion(intent=q["intent"], addressed_turns=turns))
    return Learning(
        evidence_coverage=DebriefEvidenceCoverage(addressed=cov.addressed, key_facts=cov.key_facts),
        key_questions=key_questions,
    )


def detection_payload(
    cards: Iterable[Card],
    labels: Mapping[int, str],
    trial: TrialRows,
    verdicts: Mapping[tuple[str, int, str], Any],
) -> Detection:
    """S3 5.7 detection scorecard: the session coach's flags scored against the session's R3 labels (5.3), and
    its last valid card's running finding next to the case outcome.

    Raises `FlagScoringError` unchanged when a flag passed citation existence but J3 gave it no verdict: a
    schema failure upstream (S2 10) that the caller's own code check on the ref_asst.v2 report should have
    refused first; this never silently absorbs it."""
    cards = list(cards)
    strict = evasion_counts(cards, labels, trial, verdicts, kinds=STRICT)
    broad = evasion_counts(cards, labels, trial, verdicts, kinds=BROAD)
    support = support_counts(cards, trial, verdicts)
    last_valid = max((c for c in cards if c.valid), key=lambda c: c.turn_no, default=None)
    return Detection(
        evasion_strict=Counts(tp=strict.tp, flags=strict.flags, events=strict.events),
        evasion_broad=Counts(tp=broad.tp, flags=broad.flags, events=broad.events),
        unique_flags=support.unique,
        unsupported=Unsupported(
            citation=support.unsupported.get("citation", 0),
            demeanor=support.unsupported.get("demeanor", 0),
            claim=support.unsupported.get("claim", 0),
        ),
        coach_last_label=None if last_valid is None else cast(Label, last_valid.finding.label),
    )


def subject_realism_payload(labels: Mapping[int, SubjectLabel]) -> SubjectRealism:
    """S3 5.7 subject-realism scorecard: compliant turns and the per-check failure counts (3.8)."""
    values = list(labels.values())
    return SubjectRealism(
        turns=len(values),
        compliant=sum(1 for lab in values if lab.compliant),
        failures=Failures(
            F1=sum(1 for lab in values if not lab.f1),
            F2_F4=sum(1 for lab in values if not lab.f2_f4),
            F3=sum(1 for lab in values if not lab.f3),
            F5=sum(1 for lab in values if not lab.f5),
            F6=sum(1 for lab in values if not lab.f6),
        ),
    )


@dataclass(frozen=True, kw_only=True)
class ScoredDebriefInputs:
    """Everything `assemble_scored_debrief` needs, already adapted by the caller (`arena_referee`): R3's two
    validated reports, the session's own coach cards and transcript, and the provenance of record."""

    session_id: str
    evaluator_packet: Mapping[str, Any]
    committed_label: Label | None
    subject_report: RefereeSubjectReport
    quote_invalid: frozenset[str]
    rubric_result: RubricResult
    cards: Sequence[Card]
    flag_verdicts: Mapping[tuple[str, int, str], Any]
    trial_rows: TrialRows
    rubric_sha256: str
    r3_prompt_sha256: tuple[str, str]
    referee_model_ids: Sequence[str]
    scorer_git_sha: str


def assemble_scored_debrief(inputs: ScoredDebriefInputs) -> ScoredDebrief:
    """A scored text session's `debrief.v1` (S3 5.7, D8): built from `r3_subject`'s and `r3_investigator`'s
    already-validated outputs and the session's own coach cards. `quote_invalid` is `apply_quote_check`'s
    result on `subject_report`, used the same way storage uses it (S2 7.2 stored rationale)."""
    labels = adapt_subject_report(inputs.subject_report, inputs.quote_invalid)
    return ScoredDebrief(
        schema_version="debrief.v1",
        session_id=inputs.session_id,
        scored=True,
        outcome=outcome_payload(inputs.evaluator_packet, inputs.committed_label),
        rubric=rubric_payload(inputs.rubric_result),
        scorecards=Scorecards(
            learning=learning_payload(inputs.subject_report, inputs.evaluator_packet),
            detection=detection_payload(
                inputs.cards, {n: v.label for n, v in labels.items()}, inputs.trial_rows, inputs.flag_verdicts
            ),
            subject_realism=subject_realism_payload(labels),
        ),
        provenance=Provenance(
            rubric_sha256=inputs.rubric_sha256,
            r3_prompt_sha256=list(inputs.r3_prompt_sha256),
            referee_model_ids=list(inputs.referee_model_ids),
            scorer_git_sha=inputs.scorer_git_sha,
        ),
    )
