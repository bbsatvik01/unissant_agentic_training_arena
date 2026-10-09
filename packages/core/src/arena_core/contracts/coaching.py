"""Coaching outputs (S2 4.1, 4.6, 4.7) and the stored and wire card shapes (S5 6.2, S6 4.5; C-04, SG4-05).

Model output: `CoachingCard` (card.v1), `DeepUpdate` (deep.v1, candidate A1 only), `FinalFinding` (final.v1).
Each validates the S2 4.2-4.3 rules that need nothing but the output itself; the rules that need the trial run
when a `CitationContext` is passed as validation context (`CoachingCard.model_validate(raw, context=ctx)`), and
are skipped without one (a stored row is re-read without its trial).

Stored and wire: `StoredCard` is card.v1 plus its code-filled fields (S2 4.1): `card_seq`, `turn_no`,
`candidate_sha256`, `flags[].flag_ref`, `finding.last_revised_turn`, `validation`, `latency_ms`, `work_item`,
`transcript_version`; its finding is the `StoredFinding` (S2 4.8). The training wire card is the stored card
without candidate identifiers; the tournament wire card keeps `candidate_sha256` and adds `candidate_id`
(after reveal, or on a dev tournament). Three separate schemas, so the training schema refuses a frame that
carries an identifier (S5 6.5, S6 FE-COACH-8).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Self

from pydantic import Field, ValidationInfo, model_validator

from arena_core.contracts.common import (
    AlternativeExplanation,
    Assessment,
    CardVersion,
    CitableRecordId,
    Contract,
    DeepVersion,
    Distinct,
    FinalVersion,
    FlagKind,
    FlagRef,
    FollowUpQuestion,
    MissingFact,
    Purpose,
    QuestionType,
    Quote,
    RecordId,
    Sha256,
    TurnId,
    TurnNo,
    Uuid,
    turn_no,
    when,
)
from arena_core.contracts.findings import CitationContext, Finding, StoredFinding, finding_context_errors

NeutralityIssue = Literal[
    "presupposes_fact",
    "accusatory_wording",
    "demeanor_reference",
    "multiple_questions",
    "limits_options",
    "solicits_opinion",
    "emotionally_loaded",
    "pressure_or_inducement",
]
AnswerCategory = Literal["responsive", "non_responsive", "contradiction", "explicit_uncertainty", "possible_evasion"]
Tactic = Literal[
    "account_first_open",
    "funnel_probe",
    "evidence_topic",
    "evidence_source_vague",
    "evidence_specific",
    "unanticipated_detail",
    "reverse_order",
    "verifiable_detail",
    "clarify_contradiction",
    "alternative_explanation",
    "corroboration_request",
    "summary_check",
]
CoverageStatus = Literal[
    "not_yet_raised", "raised_not_tested", "consistent_with_account", "conflicts_with_account", "explained_innocently"
]
DisclosureStep = Literal["hold", "evidence_topic", "evidence_source_vague", "evidence_specific"]

GAP_KINDS = frozenset({"gap", "non_responsive", "possible_evasion"})


def _context(info: ValidationInfo) -> CitationContext | None:
    ctx = info.context
    if ctx is None or isinstance(ctx, CitationContext):
        return ctx
    msg = f"validation context must be a CitationContext, not {type(ctx).__name__}"
    raise TypeError(msg)


def _raise(errors: list[str]) -> None:
    if errors:
        raise ValueError("; ".join(errors))


class Question(Contract):
    question_type: QuestionType
    neutrality_issues: Annotated[list[NeutralityIssue], Field(max_length=4), Distinct]
    assessment: Annotated[Assessment, Field(description="One sentence on the question")]


# The claim fields of a flag and the kinds that need each one (S2 4.1); every other kind leaves it null.
CLAIM_FIELDS: dict[str, frozenset[str]] = {
    "missing_fact": GAP_KINDS,
    "conflict_turn_id": frozenset({"contradiction"}),
    "conflict_quote": frozenset({"contradiction"}),
    "conflict_record_id": frozenset({"evidence_conflict"}),
    "conflict_record_quote": frozenset({"evidence_conflict"}),
}
FLAG_KINDS = ("gap", "non_responsive", "possible_evasion", "contradiction", "evidence_conflict")


class Flag(Contract):
    """One card.v1 flag (S2 4.1): the claim fields its `kind` needs are non-null, every other one is null."""

    kind: FlagKind
    turn_id: TurnId
    quote: Annotated[Quote, Field(description="Exact span of the subject's answer in turn_id")]
    missing_fact: MissingFact | None
    conflict_turn_id: TurnId | None
    conflict_quote: Quote | None
    conflict_record_id: CitableRecordId | None
    conflict_record_quote: Quote | None

    @model_validator(mode="after")
    def _claim_fields(self) -> Self:
        for name, kinds in CLAIM_FIELDS.items():
            required = self.kind in kinds
            present = getattr(self, name) is not None
            if present != required:
                msg = f"{name}: {'required' if required else 'must be null'} for kind {self.kind}"
                raise ValueError(msg)
        return self


class FollowUp(Contract):
    question: FollowUpQuestion
    tactic: Tactic
    purpose: Purpose
    record_request: RecordId | None


def _card_errors(turn_id: str, flags: list[Flag], finding: Finding | StoredFinding) -> tuple[list[str], frozenset[str]]:
    """Checks a card can make on itself (S2 4.2-4.3); returns the errors and the card's own flag references."""
    current = turn_no(turn_id)
    own_refs = frozenset(f"{turn_id}.f{i}" for i in range(1, len(flags) + 1))
    errors: list[str] = []
    for i, flag in enumerate(flags):
        if turn_no(flag.turn_id) > current:
            errors.append(f"flags[{i}].turn_id: {flag.turn_id} is after the card's turn {turn_id}")
        if flag.conflict_turn_id is not None and turn_no(flag.conflict_turn_id) > current:
            errors.append(f"flags[{i}].conflict_turn_id: {flag.conflict_turn_id} is after the card's turn {turn_id}")
    errors += [
        f"finding.cited_turns[{i}]: turn {t} is after the card's turn {turn_id}"
        for i, t in enumerate(finding.cited_turns)
        if t > current
    ]
    for i, ref in enumerate(finding.basis_flag_refs):
        ref_turn = turn_no(ref.split(".")[0])
        if ref_turn > current or (ref_turn == current and ref not in own_refs):
            errors.append(f"finding.basis_flag_refs[{i}]: {ref} names no flag of this card or an earlier one")
    return errors, own_refs


def _card_context_errors(
    flags: list[Flag], finding: Finding, record_request: str | None, ctx: CitationContext, own_refs: frozenset[str]
) -> list[str]:
    errors = finding_context_errors(finding, ctx, "finding", own_refs)
    errors += [
        f"flags[{i}].conflict_record_id: {f.conflict_record_id} is not an initial document or a record released "
        "before this card was requested"
        for i, f in enumerate(flags)
        if f.conflict_record_id is not None and f.conflict_record_id not in ctx.citable_records
    ]
    if record_request is not None and record_request not in ctx.requestable:
        errors.append(f"follow_up.record_request: {record_request} is not on the requestable list")
    return errors


class CoachingCard(Contract):
    """card.v1 as the model writes it (S2 4.1)."""

    schema_version: CardVersion
    turn_id: Annotated[TurnId, Field(description="The exchange being assessed, e.g. t07")]
    question: Question
    answer_category: AnswerCategory
    flags: Annotated[list[Flag], Field(max_length=3)]
    follow_up: FollowUp
    finding: Finding
    boundary_notice: bool
    commit_requested: bool

    @model_validator(mode="after")
    def _rules(self, info: ValidationInfo) -> Self:
        errors, own_refs = _card_errors(self.turn_id, self.flags, self.finding)
        ctx = _context(info)
        if ctx is not None:
            if turn_no(self.turn_id) != ctx.current_turn:
                errors.append(f"turn_id: {self.turn_id} is not the exchange this card was requested for")
            errors += _card_context_errors(self.flags, self.finding, self.follow_up.record_request, ctx, own_refs)
        _raise(errors)
        return self


class StoredFlag(Flag):
    flag_ref: FlagRef

    @classmethod
    def json_rules(cls) -> list[dict[str, Any]]:
        return [
            when("kind", [k for k in FLAG_KINDS if k in kinds], {name: {"type": "string"}}, {name: {"type": "null"}})
            for name, kinds in CLAIM_FIELDS.items()
        ]


def _assistant_finding_rules() -> list[dict[str, Any]]:
    """The stored assistant finding on a card or deep update: code-filled `last_revised_turn`, no alternatives,
    and a deceptive label rests on at least one basis flag (S2 4.1, 4.2, 4.8)."""

    def on_finding(properties: dict[str, Any]) -> dict[str, Any]:
        return {"properties": {"finding": {"type": "object", "properties": properties}}}

    filled = {"last_revised_turn": {"type": "integer"}, "alternative_explanations": {"type": "null"}}
    deceptive = {
        "if": on_finding({"label": {"const": "deceptive"}}),
        "then": on_finding({"basis_flag_refs": {"type": "array", "minItems": 1}}),
    }
    return [on_finding(filled), deceptive]


def _assistant_finding_errors(finding: StoredFinding, turn: str) -> list[str]:
    errors: list[str] = []
    last = finding.last_revised_turn
    if last is None or last > turn_no(turn):
        errors.append(f"finding.last_revised_turn: code-filled, at or before {turn}")
    if finding.alternative_explanations is not None:
        errors.append("finding.alternative_explanations: null on a card or deep update finding (S2 4.8)")
    if finding.label == "deceptive" and not finding.basis_flag_refs:
        errors.append("finding.basis_flag_refs: an assistant's deceptive finding needs at least one basis flag")
    return errors


class FlagCheck(Contract):
    """S2 4.4 post-check results for one flag (never repaired)."""

    citation_ok: bool
    demeanor_based: bool
    duplicate: bool


class CardValidation(Contract):
    """S2 4.1: schema validity after the one repair and the 4.4 results, one entry per `flag_ref`."""

    valid: bool
    flags: Annotated[
        dict[FlagRef, FlagCheck],
        Field(max_length=3, json_schema_extra={"additionalProperties": False}),
    ]
    demeanor_in_rationale: bool


class _CardFields(Contract):
    """card.v1 with its code-filled fields, without candidate identifiers (the training wire card's fields)."""

    schema_version: CardVersion
    turn_id: TurnId
    question: Question
    answer_category: AnswerCategory
    flags: Annotated[list[StoredFlag], Field(max_length=3)]
    follow_up: FollowUp
    finding: StoredFinding
    boundary_notice: bool
    commit_requested: bool
    card_seq: Annotated[int, Field(ge=1)]
    turn_no: TurnNo
    validation: CardValidation
    latency_ms: Annotated[int, Field(ge=0)]
    work_item: Uuid
    transcript_version: Annotated[int, Field(ge=0)]

    @model_validator(mode="after")
    def _rules(self) -> Self:
        errors, _ = _card_errors(self.turn_id, list(self.flags), self.finding)
        if self.turn_no != turn_no(self.turn_id):
            errors.append(f"turn_no: {self.turn_no} is not the turn of {self.turn_id}")
        refs = [f.flag_ref for f in self.flags]
        expected = [f"{self.turn_id}.f{i}" for i in range(1, len(self.flags) + 1)]
        if refs != expected:
            errors.append(f"flags[].flag_ref: {refs} must be {expected} (emission order, S2 1)")
        if set(self.validation.flags) != set(refs):
            errors.append("validation.flags: needs exactly one entry per flag_ref")
        errors += _assistant_finding_errors(self.finding, self.turn_id)
        _raise(errors)
        return self

    @classmethod
    def json_rules(cls) -> list[dict[str, Any]]:
        return _assistant_finding_rules()


class TrainingWireCard(_CardFields):
    """The card on a training `coach.card` frame and in a training snapshot (SG4-05)."""


class StoredCard(_CardFields):
    """The `coach_card` event payload (S2 4.1 code-filled fields; S4 `arena.trial_events`)."""

    candidate_sha256: Sha256

    def training_wire(self) -> TrainingWireCard:
        return TrainingWireCard(**self.model_dump(exclude={"candidate_sha256"}))

    def tournament_wire(self, candidate_id: str) -> TournamentWireCard:
        return TournamentWireCard(**self.model_dump(), candidate_id=candidate_id)


class TournamentWireCard(_CardFields):
    """The card on a tournament replay frame after reveal or on a dev tournament (SG4-05)."""

    candidate_sha256: Sha256
    candidate_id: Uuid


class CoverageEntry(Contract):
    record_id: RecordId
    status: CoverageStatus
    turn_ids: Annotated[list[TurnId], Field(max_length=4), Distinct]


class OpenGap(Contract):
    missing_fact: MissingFact
    first_seen_turn: TurnId


class DisclosurePlan(Contract):
    record_id: RecordId | None
    step: DisclosureStep


def _deep_errors(
    as_of_turn: str, finding: Finding | StoredFinding, coverage: list[CoverageEntry], gaps: list[OpenGap]
) -> list[str]:
    current = turn_no(as_of_turn)
    errors = [
        f"finding.cited_turns[{i}]: turn {t} is after as_of_turn {as_of_turn}"
        for i, t in enumerate(finding.cited_turns)
        if t > current
    ]
    ids = [c.record_id for c in coverage]
    if len(set(ids)) != len(ids):
        errors.append("evidence_coverage: each record at most once")
    errors += [
        f"evidence_coverage[{i}].turn_ids: {t} is after as_of_turn {as_of_turn}"
        for i, c in enumerate(coverage)
        for t in c.turn_ids
        if turn_no(t) > current
    ]
    errors += [
        f"open_gaps[{i}].first_seen_turn: {g.first_seen_turn} is after as_of_turn {as_of_turn}"
        for i, g in enumerate(gaps)
        if turn_no(g.first_seen_turn) > current
    ]
    return errors


class DeepUpdate(Contract):
    """deep.v1 as the model writes it (S2 4.6)."""

    schema_version: DeepVersion
    as_of_turn: TurnId
    finding: Finding
    evidence_coverage: Annotated[list[CoverageEntry], Field(max_length=8)]
    open_gaps: Annotated[list[OpenGap], Field(max_length=4)]
    disclosure_plan: DisclosurePlan

    @model_validator(mode="after")
    def _rules(self, info: ValidationInfo) -> Self:
        errors = _deep_errors(self.as_of_turn, self.finding, self.evidence_coverage, self.open_gaps)
        ctx = _context(info)
        if ctx is not None:
            if turn_no(self.as_of_turn) != ctx.current_turn:
                errors.append(f"as_of_turn: {self.as_of_turn} is not the exchange this update was requested for")
            errors += finding_context_errors(self.finding, ctx, "finding")
            released = sorted(r for r in ctx.citable_records if r.startswith("rec-"))
            listed = [c.record_id for c in self.evidence_coverage]
            if sorted(r for r in listed if r in released) != released:
                errors.append(f"evidence_coverage: must list every released record ({released}) exactly once")
            allowed = set(released) | ctx.requestable
            errors += [
                f"evidence_coverage[{i}].record_id: {r} is neither released nor requestable"
                for i, r in enumerate(listed)
                if r not in allowed
            ]
            plan = self.disclosure_plan.record_id
            if plan is not None and plan not in allowed:
                errors.append(f"disclosure_plan.record_id: {plan} is neither released nor requestable")
        _raise(errors)
        return self


class StoredDeepUpdate(Contract):
    """The `coach_deep` payload and the `coach.update` frame's update: deep.v1 with the stored finding (S2 4.8:
    completed citations and `last_revised_turn`, which the deep update's finding supersedes for display)."""

    schema_version: DeepVersion
    as_of_turn: TurnId
    finding: StoredFinding
    evidence_coverage: Annotated[list[CoverageEntry], Field(max_length=8)]
    open_gaps: Annotated[list[OpenGap], Field(max_length=4)]
    disclosure_plan: DisclosurePlan

    @model_validator(mode="after")
    def _rules(self) -> Self:
        errors = _deep_errors(self.as_of_turn, self.finding, self.evidence_coverage, self.open_gaps)
        errors += _assistant_finding_errors(self.finding, self.as_of_turn)
        _raise(errors)
        return self

    @classmethod
    def json_rules(cls) -> list[dict[str, Any]]:
        return _assistant_finding_rules()


class FinalFinding(Contract):
    """final.v1 (S2 4.7): the value `finalize_trial()` commits for an assistant."""

    schema_version: FinalVersion
    finding: Finding
    alternative_explanations: Annotated[list[AlternativeExplanation], Field(max_length=3)]

    @model_validator(mode="after")
    def _rules(self, info: ValidationInfo) -> Self:
        ctx = _context(info)
        if ctx is not None:
            _raise(finding_context_errors(self.finding, ctx, "finding"))
        return self
