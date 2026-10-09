"""Event frames on the wire (S5 6.2, S6 5.2-5.3; C-17, D9, SG4-02, SG4-05).

The envelope is `{v, seq, scope, scope_id, type, ts, transcript_version, data}`. `seq` is the persisted row's
per-trial sequence and the SSE `id`; a synthesized frame (`subject.thinking`, `coach.working`, `trial.status`
outside its persisted pair, `notice`) carries `seq: null`. One model per wire type, so `data` is checked per
`type` and an unknown `type` validates against nothing.

`TrialFrame` is the trial stream's union (training wire card on `coach.card`); `ReplayFrame` is trial replay's
union for a visible tournament trial (tournament wire card). `TournamentFrame` is the tournament poll's frame set;
`TournamentPoll` is that route's response, `ReplayPage` the replay route's. Only `arena_core.events.projections`
constructs a frame model (S5 1.2 item 2, enforced by `tools/check_roles.py`): every class here whose name ends in
`Frame` is a frame model.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from arena_core.contracts.coaching import StoredDeepUpdate, TournamentWireCard, TrainingWireCard
from arena_core.contracts.common import (
    DATE,
    ArtifactKind,
    Contract,
    Exchanges,
    RecordId,
    Sha256,
    Timestamp,
    TurnNo,
    Uuid,
)
from arena_core.contracts.findings import StoredFinding

QuestionSource = Literal["investigator", "harness_fixed", "harness_fallback", "assistant_relay"]
TrialStatus = Literal[
    "running",
    "completed",
    "subject_quarantined",
    "assistant_failed",
    "infra_failed",
    "budget_skipped",
    "budget_truncated",
]
ExecutionState = Literal[
    "completed",
    "subject_quarantined",
    "assistant_failed",
    "infra_failed",
    "budget_skipped",
    "budget_truncated",
    "source_unavailable",
]
TournamentState = Literal["draft", "frozen", "running", "sealed", "scoring", "revealed"]
Track = Literal["replay_corpus", "replay", "interactive"]
Seq = Annotated[int, Field(ge=1)]
Version = Annotated[int, Field(ge=0)]
RecordDate = Annotated[str, StringConstraints(pattern=DATE)]
Text600 = Annotated[str, StringConstraints(min_length=1, max_length=600)]
Text900 = Annotated[str, StringConstraints(min_length=1, max_length=900)]


class TableContent(Contract):
    """S1 public-packet `table`: every row has one cell per column; no cell carries a bar or a line break."""

    columns: Annotated[
        list[Annotated[str, StringConstraints(min_length=1, max_length=40, pattern=r"^[^|\r\n]+$")]],
        Field(min_length=1, max_length=8),
    ]
    rows: Annotated[
        list[
            Annotated[
                list[Annotated[str, StringConstraints(max_length=200, pattern=r"^[^|\r\n]*$")]],
                Field(min_length=1, max_length=8),
            ]
        ],
        Field(min_length=1, max_length=30),
    ]

    @model_validator(mode="after")
    def _one_cell_per_column(self) -> Self:
        if any(len(row) != len(self.columns) for row in self.rows):
            msg = "rows: every row has exactly one cell per column (S1 V2)"
            raise ValueError(msg)
        return self


class Content(Contract):
    """S1's whole Content object (body plus optional table), never flattened (SG1-04)."""

    body: Annotated[str, StringConstraints(min_length=1, max_length=2000)]
    table: TableContent | None = None


# ---------------------------------------------------------------- data, one per wire type (S6 5.3)


class QuestionAccepted(Contract):
    turn_no: TurnNo
    text: Text600
    source: QuestionSource
    channel: Literal["text"]


class TurnRef(Contract):
    """`subject.thinking` and `coach.working`: the turn whose work started."""

    turn_no: TurnNo


class EvidenceReleased(Contract):
    record_id: RecordId
    title: Annotated[str, StringConstraints(min_length=5, max_length=120)]
    kind: Literal["record", "clarification", "context_change"]
    doc_kind: ArtifactKind | None
    date: RecordDate | None
    content: Content
    released_at_turn: Exchanges
    trigger: Literal["scheduled", "requested"]


class SubjectAnswer(Contract):
    turn_no: TurnNo
    text: Text900
    channel: Literal["text"]
    partial: bool
    committed_at: Timestamp


class CoachCard(Contract):
    turn_no: TurnNo
    card: TrainingWireCard


class TournamentCoachCard(Contract):
    turn_no: TurnNo
    card: TournamentWireCard


class CoachUpdate(Contract):
    turn_no: TurnNo
    update: StoredDeepUpdate


class CoachFailed(Contract):
    turn_no: TurnNo
    reason: Literal["timeout", "repair_failed"]


class FindingCommitted(Contract):
    by: Literal["investigator", "assistant"]
    finding: StoredFinding
    committed_at: Timestamp


class TrialStatusData(Contract):
    status: TrialStatus
    reason_code: Annotated[str, StringConstraints(min_length=1, max_length=80)] | None


class TrialFinalized(Contract):
    commitment_hash: Sha256


class DebriefReady(Contract):
    session_id: Uuid


class Notice(Contract):
    kind: Literal["paused", "quota"]
    text: Annotated[str, StringConstraints(min_length=1, max_length=300)]


# ---------------------------------------------------------------- trial-scope frames (S6 5.2 envelope)


class _TrialEnvelope(Contract):
    v: Literal[1]
    scope: Literal["trial"]
    scope_id: Uuid
    ts: Timestamp
    transcript_version: Version | None


class QuestionAcceptedFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["question.accepted"]
    data: QuestionAccepted


class SubjectThinkingFrame(_TrialEnvelope):
    seq: None
    type: Literal["subject.thinking"]
    data: TurnRef


class EvidenceReleasedFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["evidence.released"]
    data: EvidenceReleased


class SubjectAnswerFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["subject.answer"]
    data: SubjectAnswer


class CoachWorkingFrame(_TrialEnvelope):
    seq: None
    type: Literal["coach.working"]
    data: TurnRef


class CoachCardFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["coach.card"]
    data: CoachCard


class TournamentCoachCardFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["coach.card"]
    data: TournamentCoachCard


class CoachUpdateFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["coach.update"]
    data: CoachUpdate


class CoachFailedFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["coach.failed"]
    data: CoachFailed


class FindingCommittedFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["finding.committed"]
    data: FindingCommitted


class TrialStatusFrame(_TrialEnvelope):
    """Carries the `trial_ended` row's `seq` when the trial did not complete, `null` when `trial.finalized`
    follows (SG4-02, X-15)."""

    seq: Seq | None
    type: Literal["trial.status"]
    data: TrialStatusData


class TrialFinalizedFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["trial.finalized"]
    data: TrialFinalized


class DebriefReadyFrame(_TrialEnvelope):
    seq: Seq
    type: Literal["debrief.ready"]
    data: DebriefReady


class NoticeFrame(_TrialEnvelope):
    seq: None
    type: Literal["notice"]
    data: Notice


TrialFrame = (
    QuestionAcceptedFrame
    | SubjectThinkingFrame
    | EvidenceReleasedFrame
    | SubjectAnswerFrame
    | CoachWorkingFrame
    | CoachCardFrame
    | CoachUpdateFrame
    | CoachFailedFrame
    | FindingCommittedFrame
    | TrialStatusFrame
    | TrialFinalizedFrame
    | DebriefReadyFrame
    | NoticeFrame
)

# Trial replay of a visible tournament trial: the persisted frames of the trial scope, with the tournament card.
ReplayFrame = (
    QuestionAcceptedFrame
    | EvidenceReleasedFrame
    | SubjectAnswerFrame
    | TournamentCoachCardFrame
    | CoachUpdateFrame
    | CoachFailedFrame
    | FindingCommittedFrame
    | TrialStatusFrame
    | TrialFinalizedFrame
)


class ReplayPage(Contract):
    """`GET /api/trials/{id}/replay?after=S`: the trial's frames with `seq > S` (one page, at most 200)."""

    frames: Annotated[list[ReplayFrame], Field(max_length=200)]
    last: Annotated[int, Field(ge=0)]


# ---------------------------------------------------------------- tournament scope (polled; S6 5.3)

TrialRef = Annotated[int, Field(ge=1)]


class TournamentStatus(Contract):
    state: TournamentState


class TrialStarted(Contract):
    trial_ref: TrialRef
    trial_id: Uuid
    pairing: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    track: Track
    block: Annotated[int, Field(ge=1)]


class ReplayTurn(Contract):
    trial_ref: TrialRef
    turn_no: TurnNo


class TournamentTrialFinalized(Contract):
    trial_ref: TrialRef
    commitment_hash: Sha256


class TrialExecution(Contract):
    trial_ref: TrialRef
    state: ExecutionState


class _TournamentEnvelope(Contract):
    v: Literal[1]
    seq: Seq
    scope: Literal["tournament"]
    scope_id: Uuid
    ts: Timestamp


class TournamentStatusFrame(_TournamentEnvelope):
    type: Literal["tournament.status"]
    data: TournamentStatus


class TrialStartedFrame(_TournamentEnvelope):
    type: Literal["trial.started"]
    data: TrialStarted


class ReplayTurnFrame(_TournamentEnvelope):
    type: Literal["replay.turn"]
    data: ReplayTurn


class TournamentTrialFinalizedFrame(_TournamentEnvelope):
    type: Literal["trial.finalized"]
    data: TournamentTrialFinalized


class TrialExecutionFrame(_TournamentEnvelope):
    type: Literal["trial.execution"]
    data: TrialExecution


TournamentFrame = (
    TournamentStatusFrame | TrialStartedFrame | ReplayTurnFrame | TournamentTrialFinalizedFrame | TrialExecutionFrame
)


class ProgressRow(Contract):
    track: Track
    block: Annotated[int, Field(ge=1)]
    planned: Annotated[int, Field(ge=0)]
    counts_by_state: dict[ExecutionState, Annotated[int, Field(ge=0)]]


class TournamentEvents(Contract):
    """A dev or revealed tournament: frames after the global ledger cursor."""

    visibility: Literal["events"]
    frames: Annotated[list[TournamentFrame], Field(max_length=200)]
    last: Annotated[int, Field(ge=0)]


class TournamentCounts(Contract):
    """A hidden tournament before reveal: per-track, per-block counts only (D9, SG3-15)."""

    visibility: Literal["counts"]
    progress: list[ProgressRow]


TournamentPoll = TournamentEvents | TournamentCounts
