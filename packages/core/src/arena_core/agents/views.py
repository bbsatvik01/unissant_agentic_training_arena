"""Public inputs of the coach and of the assistant-facing referee call (S2 5.1, 7.3; S5 1.2 item 3).

`PublicTrialView` is the only parameter type of the coach prompt builder (S5 1.2: "a frozen Pydantic model built
from S4 `arena.trial_context`"). It holds the public case file, the records released so far with their
contents, the trial's own transcript, the candidate's own earlier output and the exchange number, and nothing
else: no role, no private packet, no canonical fact, no release predicate, no other candidate's output, no subject
identity, no communication style and no hidden-family material (S2 5.1, C-26). Every model is a frozen `Contract`
that refuses unknown keys, so a builder that is handed a private field fails instead of rendering it.

`PublicCase` is shared with the assistant-facing referee call (R2 and R3 see the same case file, S2 7.3).
`public_case` builds it from a public packet (S1 public-packet schema v1.2); a released record's content comes
from `release_evidence()` (S4), never from the evaluator packet.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, Literal, Self

from pydantic import AfterValidator, Field, StringConstraints, model_validator

from arena_core.agents.untrusted import ANSWER_MAX_BYTES, check_question, check_rendered
from arena_core.contracts.coaching import StoredDeepUpdate, StoredFlag
from arena_core.contracts.common import (
    MAX_TURNS,
    Answer,
    ArtifactKind,
    Contract,
    Exchanges,
    RecordId,
    TurnNo,
)
from arena_core.contracts.findings import StoredFinding

Text = Annotated[str, StringConstraints(min_length=1, max_length=4096)]
Cell = Annotated[str, StringConstraints(max_length=400)]
DocId = Annotated[str, StringConstraints(pattern=r"^doc-0[1-4]$")]
# Investigator questions: 600 characters and 1,800 normalized bytes (D11, `untrusted.check_question`).
Question = Annotated[str, StringConstraints(min_length=1, max_length=600), AfterValidator(check_question)]
# A subject answer as rendered: 1,800 normalized bytes (S2 6.8 V1 bounds the raw text; NFKC may expand it).
RenderedAnswer = Annotated[Answer, AfterValidator(lambda a: check_rendered(a, ANSWER_MAX_BYTES, "answer"))]


class Table(Contract):
    columns: Annotated[list[Cell], Field(min_length=1, max_length=12)]
    rows: Annotated[list[list[Cell]], Field(max_length=40)]


class Content(Contract):
    """A record's content: a body and an optional table (S1 public-packet schema `content`)."""

    body: Text
    table: Table | None = None

    def as_mapping(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class TimelineEntry(Contract):
    time: Annotated[str, StringConstraints(min_length=1, max_length=32)]
    event: Text
    source: DocId


class InitialDocument(Contract):
    doc_id: DocId
    kind: ArtifactKind
    title: Text
    content: Content


class RequestableRecord(Contract):
    """A record the investigator may request: ID, title and earliest exchange, never its content (S2 5.1)."""

    record_id: RecordId
    title: Text
    requestable_after_exchanges: Exchanges


class InterviewContext(Contract):
    agency: Text
    facility: Text
    timezone: Text
    interview_date: Text
    setting: Text
    investigator_role: Text
    subject_name: Text
    subject_position: Text
    subject_unit: Text
    subject_tenure_years: Annotated[int, Field(ge=0, le=60)]
    purpose_statement: Text


class PublicCase(Contract):
    """The public case file (S2 5.1 row 1, `arena.public_packets`)."""

    case_id: Annotated[str, StringConstraints(pattern=r"^C-[0-9A-HJKMNP-TV-Z]{8}$")]
    objective: Text
    timeline: Annotated[list[TimelineEntry], Field(max_length=20)]
    initial_documents: Annotated[list[InitialDocument], Field(min_length=1, max_length=4)]
    interview_context: InterviewContext
    requestable: Annotated[list[RequestableRecord], Field(max_length=6)]


class ReleasedRecord(Contract):
    """A record released by `release_evidence()`: its content and the exchange it was released after."""

    record_id: RecordId
    title: Text
    date: Annotated[str, StringConstraints(min_length=1, max_length=32)] | None
    content: Content
    released_after: Exchanges


class TranscriptTurn(Contract):
    """One committed exchange of the trial's own transcript (a replay trial's copies too, D2)."""

    turn_no: TurnNo
    question: Question
    answer: RenderedAnswer


class EarlierOutput(Contract):
    """The candidate's own earlier output (S2 5.1): its last valid running finding, every flag of every earlier
    valid card, and the latest deep update (A1 only)."""

    running_finding: StoredFinding | None
    flags: Annotated[list[StoredFlag], Field(max_length=3 * MAX_TURNS)]
    deep_update: StoredDeepUpdate | None


CoachCall = Literal["card", "deep", "final"]


def visible_releases_through(call: str, exchange: int) -> int:
    """S2 4.4.1: a card (and the deep update on the same turn) for exchange n sees the records released before
    question n (`released_after <= n - 1`); the final finding after n completed exchanges sees every release
    through n. The one place this rule is applied to what a coach reads."""
    return exchange if call == "final" else exchange - 1


class PublicTrialView(Contract):
    """Everything a coach call may read (S2 5.1). `call` is the call it is built for; `exchange` is the turn being
    assessed for a card and a deep update, and the completed exchanges for the final finding; the transcript holds
    exactly turns 1..exchange and `released` only the records that call may see (`visible_releases_through`)."""

    call: CoachCall
    case: PublicCase
    released: Annotated[list[ReleasedRecord], Field(max_length=6)]
    transcript: Annotated[list[TranscriptTurn], Field(max_length=MAX_TURNS)]
    earlier: EarlierOutput
    exchange: TurnNo

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        numbers = [t.turn_no for t in self.transcript]
        if numbers != list(range(1, self.exchange + 1)):
            msg = f"transcript: turns {numbers} are not 1..{self.exchange}"
            raise ValueError(msg)
        through = visible_releases_through(self.call, self.exchange)
        late = [r.record_id for r in self.released if r.released_after > through]
        if late:
            msg = f"released: {late} not visible to the {self.call} of exchange {self.exchange} (through {through})"
            raise ValueError(msg)
        return self


def public_case(packet: Mapping[str, Any]) -> PublicCase:
    """`PublicCase` from an S1 public packet (schema v1.2); platform text (`ground_rules`, `limits`) and
    presentation fields are not part of the coach's case file."""
    ctx = packet["interview_context"]
    subject = ctx["subject"]
    return PublicCase(
        case_id=packet["case_id"],
        objective=packet["investigation_objective"],
        timeline=[TimelineEntry(**t) for t in packet["known_timeline"]],
        initial_documents=[
            InitialDocument(doc_id=d["doc_id"], kind=d["kind"], title=d["title"], content=_content(d["content"]))
            for d in packet["initial_documents"]
        ],
        interview_context=InterviewContext(
            agency=ctx["agency"],
            facility=ctx["facility"],
            timezone=ctx["timezone"],
            interview_date=ctx["interview_date"],
            setting=ctx["setting"],
            investigator_role=ctx["investigator_role"],
            subject_name=subject["name"],
            subject_position=subject["position"],
            subject_unit=subject["unit"],
            subject_tenure_years=subject["tenure_years"],
            purpose_statement=ctx["purpose_statement"],
        ),
        requestable=[
            RequestableRecord(
                record_id=r["record_id"],
                title=r["title"],
                requestable_after_exchanges=r["requestable_after_exchanges"],
            )
            for r in packet["requestable_records"]
        ],
    )


def _content(raw: Mapping[str, Any]) -> Content:
    table = raw.get("table")
    return Content(
        body=raw["body"],
        table=Table(columns=list(table["columns"]), rows=[list(r) for r in table["rows"]]) if table else None,
    )


def released_record(
    record_id: str, title: str, content: Mapping[str, Any], released_after: int, date: str | None = None
) -> ReleasedRecord:
    """A `release_evidence()` result as the coach sees it."""
    return ReleasedRecord(
        record_id=record_id, title=title, date=date, content=_content(content), released_after=released_after
    )
