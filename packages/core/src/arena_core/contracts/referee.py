"""Referee outputs: `RefereeSubjectReport` ref_subj.v5 (J1, J2; S2 7.2, S3 3.8) and `RefereeAssistantReport`
ref_asst.v2 (J3, J4; S2 7.3, X-06).

Each model validates the S2 code checks that need only the report; the checks that need the trial (one entry
per subject turn, IDs exist, records were visible, one entry per submitted flag, follow-up and citation, every
rubric sub-check present) run when `RefSubjContext` or `RefAsstContext` is passed as validation context. A
failure is a schema failure and triggers the one repair (S2 10). Labels are words; S3's codes are display
abbreviations only (C-09).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, ValidationInfo, model_validator

from arena_core.contracts.citations import quote_ok
from arena_core.contracts.common import (
    Contract,
    Distinct,
    EvasionLabel,
    EvaSubtype,
    EvidenceQuote,
    FactId,
    FlagRef,
    PfqReason,
    QuestionType,
    RefAsstVersion,
    RefSubjVersion,
    TurnId,
    turn_no,
)

AskedFactStatus = Literal["known", "limited", "unknown", "non_disclosable"]
SubcheckResult = Literal["pass", "fail", "na"]
# The five sub-checks J4 answers per question (S2 7.3 Part 2); every other rubric sub-check is answered once.
PER_QUESTION_SUBCHECKS = frozenset({"1a", "1c", "1d", "2c", "2d"})
VisibleRecordId = Annotated[str, StringConstraints(pattern=r"^(doc|rec)-[0-9]{2}$")]
CiteId = Annotated[str, StringConstraints(pattern=r"^(t(0[1-9]|1[0-2])|doc-0[1-4]|rec-0[1-6])$")]
SubcheckId = Annotated[str, StringConstraints(pattern=r"^[1-5][a-e]$")]


def _raise(errors: list[str]) -> None:
    if errors:
        raise ValueError("; ".join(errors))


def label_reason_errors(turn: str, label: str, eva_subtype: str | None, pfq_reason: str | None) -> list[str]:
    """`eva_subtype` is non-null exactly when the label is evasion, `pfq_reason` exactly when it is
    poorly_framed_question (S2 7.2; AC-S3-3.4)."""
    errors: list[str] = []
    if (eva_subtype is not None) != (label == "evasion"):
        errors.append(f"{turn}.eva_subtype: non-null exactly when label is evasion (AC-S3-3.4)")
    if (pfq_reason is not None) != (label == "poorly_framed_question"):
        errors.append(f"{turn}.pfq_reason: non-null exactly when label is poorly_framed_question (AC-S3-3.4)")
    return errors


class SubjectTurnJudgment(Contract):
    turn_id: TurnId
    label: EvasionLabel
    eva_subtype: EvaSubtype | None
    pfq_reason: PfqReason | None
    requested_fact_ids: Annotated[list[FactId], Field(max_length=40), Distinct]
    asked_fact_status: AskedFactStatus
    uncertainty_expressed: bool
    innocent_explanation_offered: bool
    record_conflict_ids: Annotated[list[VisibleRecordId], Field(max_length=10), Distinct]
    no_contradiction: bool
    no_invention: bool
    violated_fact_ids: Annotated[list[FactId], Field(max_length=40), Distinct]
    uncertainty_respected: bool
    disclosure_policy_respected: bool
    in_character: bool
    style_followed: bool
    platform_attack: bool
    evidence_quote: EvidenceQuote

    @model_validator(mode="after")
    def _rules(self) -> Self:
        errors = label_reason_errors(self.turn_id, self.label, self.eva_subtype, self.pfq_reason)
        if self.violated_fact_ids and self.no_contradiction and self.no_invention:
            errors.append(
                f"{self.turn_id}.violated_fact_ids: non-empty only when no_contradiction or no_invention is false"
            )
        _raise(errors)
        return self


class TrajectoryConflict(Contract):
    turn_id: TurnId
    earlier_turn_ids: Annotated[list[TurnId], Field(min_length=1, max_length=11), Distinct]


class Trajectory(Contract):
    self_consistent: bool
    conflicts: Annotated[list[TrajectoryConflict], Field(max_length=12)]

    @model_validator(mode="after")
    def _rules(self) -> Self:
        errors: list[str] = []
        if self.self_consistent != (not self.conflicts):
            errors.append("trajectory.self_consistent: must equal conflicts being empty")
        later = [c.turn_id for c in self.conflicts]
        if len(set(later)) != len(later):
            errors.append("trajectory.conflicts: each later turn once")
        errors += [
            f"trajectory.conflicts[{i}].earlier_turn_ids: {e} does not precede {c.turn_id}"
            for i, c in enumerate(self.conflicts)
            for e in c.earlier_turn_ids
            if turn_no(e) >= turn_no(c.turn_id)
        ]
        _raise(errors)
        return self


@dataclass(frozen=True)
class RefSubjContext:
    """The trial R1 judged: its subject turn IDs in order, the variant's canonical fact IDs, and the visible
    documents (initial documents and the records released in this trial; S2 7.2, SG2-41)."""

    subject_turn_ids: tuple[str, ...]
    canonical_fact_ids: frozenset[str]
    visible_record_ids: frozenset[str]


class RefereeSubjectReport(Contract):
    schema_version: RefSubjVersion
    turns: Annotated[list[SubjectTurnJudgment], Field(max_length=12)]
    trajectory: Trajectory

    @model_validator(mode="after")
    def _rules(self, info: ValidationInfo) -> Self:
        ids = [t.turn_id for t in self.turns]
        errors: list[str] = []
        if ids != sorted(set(ids)):
            errors.append("turns: one entry per subject turn, in order")
        ctx = info.context
        if ctx is not None:
            if not isinstance(ctx, RefSubjContext):
                msg = f"validation context must be a RefSubjContext, not {type(ctx).__name__}"
                raise TypeError(msg)
            errors += _subject_context_errors(self, ctx)
        _raise(errors)
        return self


def _subject_context_errors(report: RefereeSubjectReport, ctx: RefSubjContext) -> list[str]:
    errors: list[str] = []
    if tuple(t.turn_id for t in report.turns) != ctx.subject_turn_ids:
        errors.append(f"turns: must be exactly {list(ctx.subject_turn_ids)} in order")
    for t in report.turns:
        errors += [
            f"{t.turn_id}.{field}: {f} is not a canonical fact of this variant"
            for field, values in (
                ("requested_fact_ids", t.requested_fact_ids),
                ("violated_fact_ids", t.violated_fact_ids),
            )
            for f in values
            if f not in ctx.canonical_fact_ids
        ]
        errors += [
            f"{t.turn_id}.record_conflict_ids: {r} is not an initial document or a record released in this trial"
            for r in t.record_conflict_ids
            if r not in ctx.visible_record_ids
        ]
    subject_turns = set(ctx.subject_turn_ids)
    errors += [
        f"trajectory.conflicts: {i} is not a subject turn"
        for c in report.trajectory.conflicts
        for i in (c.turn_id, *c.earlier_turn_ids)
        if i not in subject_turns
    ]
    return errors


def apply_quote_check(
    report: RefereeSubjectReport, answers: Mapping[str, str]
) -> tuple[RefereeSubjectReport, frozenset[str]]:
    """S2 7.2: an `evidence_quote` that is not a quote of its turn under `quote_ok` is replaced by an empty
    string and the turn is marked `quote_invalid`; the label stands. `answers`: turn ID -> committed answer."""
    invalid = frozenset(
        t.turn_id for t in report.turns if t.evidence_quote and not quote_ok(t.evidence_quote, answers[t.turn_id])
    )
    turns = [t.model_copy(update={"evidence_quote": ""}) if t.turn_id in invalid else t for t in report.turns]
    return report.model_copy(update={"turns": turns}), invalid


class FlagVerdict(Contract):
    flag_ref: FlagRef
    quote_relevant: bool
    claim_holds: bool
    content_based: bool
    no_outside_facts: bool


class FollowupVerdict(Contract):
    turn_id: TurnId
    question_type: QuestionType
    not_leading: bool
    well_framed: bool
    no_loaded_wording: bool
    on_objective: bool
    builds_on_previous: bool


class CitationVerdict(Contract):
    cite: CiteId
    supports_basis: bool


class SubcheckVerdict(Contract):
    id: SubcheckId
    result: SubcheckResult
    turn_ids: Annotated[list[TurnId], Field(max_length=4)]


@dataclass(frozen=True)
class RefAsstContext:
    """What R2 (or R3's investigator call) was given: the submitted flag references (citation-checked and
    deduplicated), the follow-up turns, the finding citations (`tNN`, `doc-NN`, `rec-NN`), the rubric's
    sub-check IDs, and the trial's transcript turns, which every deciding turn must be (S2 7.3)."""

    flag_refs: frozenset[str]
    followup_turn_ids: frozenset[str]
    citation_ids: frozenset[str]
    rubric_subcheck_ids: frozenset[str]
    transcript_turn_ids: frozenset[str]


def _exactly_once(field: str, got: list[str], expected: frozenset[str]) -> list[str]:
    errors = [f"{field}: {g} listed twice" for g in sorted({g for g in got if got.count(g) > 1})]
    if missing := sorted(expected - set(got)):
        errors.append(f"{field}: missing {missing}")
    if extra := sorted(set(got) - expected):
        errors.append(f"{field}: {extra} were not submitted")
    return errors


class RefereeAssistantReport(Contract):
    schema_version: RefAsstVersion
    flags: Annotated[list[FlagVerdict], Field(max_length=36)]
    followups: Annotated[list[FollowupVerdict], Field(max_length=12)]
    citations: Annotated[list[CitationVerdict], Field(max_length=22)]
    subchecks: Annotated[list[SubcheckVerdict], Field(max_length=30)]

    @model_validator(mode="after")
    def _rules(self, info: ValidationInfo) -> Self:
        errors = [
            f"subchecks: {s.id} is answered per question, not once"
            for s in self.subchecks
            if s.id in PER_QUESTION_SUBCHECKS
        ]
        ctx = info.context
        if ctx is not None:
            if not isinstance(ctx, RefAsstContext):
                msg = f"validation context must be a RefAsstContext, not {type(ctx).__name__}"
                raise TypeError(msg)
            errors += _exactly_once("flags", [f.flag_ref for f in self.flags], ctx.flag_refs)
            errors += _exactly_once("followups", [f.turn_id for f in self.followups], ctx.followup_turn_ids)
            errors += _exactly_once("citations", [c.cite for c in self.citations], ctx.citation_ids)
            once = ctx.rubric_subcheck_ids - PER_QUESTION_SUBCHECKS
            errors += _exactly_once("subchecks", [s.id for s in self.subchecks], once)
            errors += [
                f"subchecks[{i}].turn_ids: {t} is not a turn of this transcript"
                for i, s in enumerate(self.subchecks)
                for t in s.turn_ids
                if t not in ctx.transcript_turn_ids
            ]
        _raise(errors)
        return self
