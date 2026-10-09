"""Review tasks (S3 7.3; SG4-09, SG4-11): what a rater sees and what a rater submits, one schema per task kind.

| Task | The rater sees | The rater submits |
| --- | --- | --- |
| T-RUB | public case file, released records with release turns, transcript, the question sequence being scored,
  the committed finding, the code-built trigger entries | the ref_asst.v2 per-question checks, other sub-checks,
  per-citation support |
| T-LAB | transcript, released records with release turns, the private ledger, permitted behaviors, canonical
  facts (the role is therefore implied) | per turn: label with `eva_subtype` or `pfq_reason`, and the F1-F6
  checks (the ref_subj.v5 fields) |
| T-FLAG | transcript, released records and the flags with their claims | per flag: the four J3 answers |

No item carries a role, an outcome, a candidate or participant identity, a phase, proxy verdicts or a date (the
trainer column of S6 5.4's visibility matrix); every model refuses unknown keys. The submitted fields are the
proxy's own output fields, reused from `referee`.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Self

from pydantic import ConfigDict, Field, StringConstraints, model_validator

from arena_core.contracts.coaching import StoredFlag
from arena_core.contracts.common import (
    ArtifactKind,
    CitableRecordId,
    Contract,
    Distinct,
    EvasionLabel,
    EvaSubtype,
    Exchanges,
    FactId,
    GateId,
    PfqReason,
    RecordId,
    TurnId,
    TurnNo,
    UncertaintyId,
    Uuid,
    when,
)
from arena_core.contracts.events import Content, QuestionSource, Text600, Text900
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import (
    CitationVerdict,
    FlagVerdict,
    FollowupVerdict,
    SubcheckVerdict,
    label_reason_errors,
)

Statement = Annotated[str, StringConstraints(min_length=5, max_length=300)]


class ReviewTurn(Contract):
    turn_no: TurnNo
    question: Text600
    answer: Text900 | None
    partial: bool


class ReviewRecord(Contract):
    """A released record with its release turn and whole content; no date (trainer review, S6 5.4)."""

    record_id: RecordId
    title: Annotated[str, StringConstraints(min_length=5, max_length=120)]
    kind: Literal["record", "clarification", "context_change"]
    doc_kind: ArtifactKind | None
    content: Content
    released_after_exchanges: Exchanges


class InitialDocument(Contract):
    doc_id: Annotated[str, StringConstraints(pattern=r"^doc-0[1-4]$")]
    kind: ArtifactKind
    title: Annotated[str, StringConstraints(min_length=5, max_length=120)]
    content: Content


class CaseFile(Contract):
    """The public case file (S1 public packet): what every investigator saw before the first question."""

    title: Annotated[str, StringConstraints(min_length=1, max_length=160)]
    investigation_objective: Annotated[str, StringConstraints(min_length=1, max_length=600)]
    initial_documents: Annotated[list[InitialDocument], Field(max_length=4)]


class ScoredQuestion(Contract):
    """One question of the sequence being scored: an investigator question (C-RUB) or an assistant proposal
    made after the answer of `turn_no` (C-QQ)."""

    turn_no: TurnNo
    question: Text600
    source: QuestionSource | Literal["assistant_proposal"]


class TriggerEntry(Contract):
    """A code-built applicability trigger (S2 7.2, C-12): IDs only, never a label word."""

    subcheck_id: Annotated[str, StringConstraints(pattern=r"^[1-5][a-e]$")]
    trigger_turns: Annotated[list[TurnNo], Field(max_length=2)]
    trigger_record: CitableRecordId | None
    question_turns: Annotated[list[TurnNo], Field(max_length=12)]


# Every trigger S3's applicability rules can produce for one 12-turn trial (S2 7.2, S3 1.5), so no task is
# ever refused or truncated: 2a per evasion turn (12), 2b per uncertainty turn (12), 3c per release (6), 3e per
# listed turn pair (at most 12 * 11 / 2 = 66) and per (turn, visible document) pair (12 turns x 10 records =
# 120), 4b per innocent explanation (12).
MAX_TRIGGERS = 12 + 12 + 6 + 66 + 120 + 12


class RubricItem(Contract):
    task: Literal["T-RUB"]
    item_id: Uuid
    instrument: Literal["C-RUB", "C-QQ"]
    case_file: CaseFile
    released: Annotated[list[ReviewRecord], Field(max_length=6)]
    transcript: Annotated[list[ReviewTurn], Field(max_length=12)]
    questions: Annotated[list[ScoredQuestion], Field(max_length=12)]
    finding: StoredFinding | None
    triggers: Annotated[list[TriggerEntry], Field(max_length=MAX_TRIGGERS)]


# The private ledger exactly as S1's private packet holds it (`ledgerFact`, `uncertaintyEntry`, `gate`), so the
# rater sees what the proxy saw (S2 7.2 renders the same entries): the referee passes the packet's entries as
# they are.


class LedgerFact(Contract):
    model_config = ConfigDict(serialize_by_alias=True)

    id: FactId
    fact_class: Annotated[Literal["FREE", "HOLD", "CORE", "PRIVATE"], Field(alias="class")]
    text: Statement
    certainty: Literal["certain", "approximate"]
    gate_id: GateId | None = None

    @model_validator(mode="after")
    def _gate(self) -> Self:
        if (self.gate_id is not None) != (self.fact_class == "HOLD"):
            msg = f"{self.id}.gate_id: present exactly when the fact is HOLD (S1 ledgerFact)"
            raise ValueError(msg)
        return self

    @classmethod
    def json_rules(cls) -> list[dict[str, Any]]:
        hold: dict[str, Any] = {"if": {"properties": {"class": {"const": "HOLD"}}}}
        hold["then"] = {"required": ["gate_id"], "properties": {"gate_id": {"type": "string"}}}
        hold["else"] = {"properties": {"gate_id": {"type": "null"}}}
        return [hold]


class UncertaintyEntry(Contract):
    id: UncertaintyId
    fact_id: FactId
    text: Annotated[str, StringConstraints(min_length=10, max_length=300)]
    answer_form: Literal["range", "unsure"]
    range_text: Annotated[str, StringConstraints(min_length=3, max_length=120)] | None = None

    @model_validator(mode="after")
    def _range(self) -> Self:
        if self.answer_form == "range" and self.range_text is None:
            msg = f"{self.id}.range_text: required when answer_form is range (S1 uncertaintyEntry)"
            raise ValueError(msg)
        return self

    @classmethod
    def json_rules(cls) -> list[dict[str, Any]]:
        rule: dict[str, Any] = {"if": {"properties": {"answer_form": {"const": "range"}}}}
        rule["then"] = {"required": ["range_text"], "properties": {"range_text": {"type": "string"}}}
        return [rule]


class Gate(Contract):
    id: GateId
    condition: Annotated[str, StringConstraints(min_length=20, max_length=300)]
    opens: Annotated[list[FactId], Field(min_length=1, max_length=4), Distinct]
    min_evidence_level: Annotated[int, Field(ge=1, le=4)]
    precondition_records: Annotated[list[CitableRecordId], Field(min_length=1, max_length=10), Distinct]


class CanonicalFact(Contract):
    id: FactId
    statement: Annotated[str, StringConstraints(min_length=10, max_length=300)]


class LabelItem(Contract):
    task: Literal["T-LAB"]
    item_id: Uuid
    initial_documents: Annotated[list[InitialDocument], Field(max_length=4)]
    released: Annotated[list[ReviewRecord], Field(max_length=6)]
    transcript: Annotated[list[ReviewTurn], Field(max_length=12)]
    facts: Annotated[list[LedgerFact], Field(max_length=30)]
    uncertainty: Annotated[list[UncertaintyEntry], Field(max_length=4)]
    gates: Annotated[list[Gate], Field(max_length=6)]
    permitted_behaviors: Annotated[list[Literal["omission", "deflection", "minimization"]], Field(max_length=3)]
    canonical_facts: Annotated[list[CanonicalFact], Field(max_length=40)]


class FlagItem(Contract):
    task: Literal["T-FLAG"]
    item_id: Uuid
    initial_documents: Annotated[list[InitialDocument], Field(max_length=4)]
    released: Annotated[list[ReviewRecord], Field(max_length=6)]
    transcript: Annotated[list[ReviewTurn], Field(max_length=12)]
    flags: Annotated[list[StoredFlag], Field(max_length=36)]


ReviewItem = RubricItem | LabelItem | FlagItem


class ReviewListEntry(Contract):
    item_id: Uuid
    task: Literal["T-RUB", "T-LAB", "T-FLAG"]
    submitted: bool


class ReviewList(Contract):
    """`GET /api/review/items`: the items assigned to this trainer."""

    items: Annotated[list[ReviewListEntry], Field(max_length=500)]


class LabelVerdict(Contract):
    """One turn of a T-LAB rating: the ref_subj.v5 label and F1-F6 fields (S3 3.8)."""

    turn_id: TurnId
    label: EvasionLabel
    eva_subtype: EvaSubtype | None
    pfq_reason: PfqReason | None
    no_contradiction: bool
    no_invention: bool
    uncertainty_respected: bool
    disclosure_policy_respected: bool
    in_character: bool
    platform_attack: bool

    @classmethod
    def json_rules(cls) -> list[dict[str, Any]]:
        return [
            when("label", ["evasion"], {"eva_subtype": {"type": "string"}}, {"eva_subtype": {"type": "null"}}),
            when(
                "label",
                ["poorly_framed_question"],
                {"pfq_reason": {"type": "string"}},
                {"pfq_reason": {"type": "null"}},
            ),
        ]

    @model_validator(mode="after")
    def _reasons(self) -> Self:
        if errors := label_reason_errors(self.turn_id, self.label, self.eva_subtype, self.pfq_reason):
            raise ValueError("; ".join(errors))
        return self


class RubricSubmission(Contract):
    task: Literal["T-RUB"]
    followups: Annotated[list[FollowupVerdict], Field(max_length=12)]
    subchecks: Annotated[list[SubcheckVerdict], Field(max_length=30)]
    citations: Annotated[list[CitationVerdict], Field(max_length=22)]


class LabelSubmission(Contract):
    task: Literal["T-LAB"]
    turns: Annotated[list[LabelVerdict], Field(max_length=12)]


class FlagSubmission(Contract):
    task: Literal["T-FLAG"]
    flags: Annotated[list[FlagVerdict], Field(max_length=36)]


ReviewSubmission = RubricSubmission | LabelSubmission | FlagSubmission
