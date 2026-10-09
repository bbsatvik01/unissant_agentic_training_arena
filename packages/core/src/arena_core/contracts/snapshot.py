"""The trial snapshot (`GET /api/trials/{id}/snapshot`; S6 5.3, S5 6.2 and 7.7; D9, SG4-03, SG4-39).

The absolute state the projection folds from the same frames the stream carries, read before the stream opens
with `after = last_seq`. REST, so no 16 KB limit. Two branches, exclusive by `channel`:

- text: `turns[]` with their answers, `voice_exchanges` empty, `exchanges_used` = answered turns;
- voice: `voice_exchanges[]` (`{exchange_no, lines[{role, text, partial}]}`, role-tagged and unpaired, D-016),
  `turns`, `cards`, `updates` and `coach_failures` empty, `exchanges_used` = stored windows (the cap's authority).

`transcript_version` on answers and releases lets the client apply the complete-card rule (S6 4.5, SG4-23) from
the snapshot exactly as from deltas. The snapshot never carries a role, a correct finding or a resolution (S6
FE-DEB-5): every model refuses unknown keys.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from arena_core.contracts.common import (
    DATE,
    Answer,
    ArtifactKind,
    Contract,
    Exchanges,
    RecordId,
    Sha256,
    Timestamp,
    TurnNo,
)
from arena_core.contracts.events import (
    CoachCard,
    CoachFailed,
    CoachUpdate,
    EvidenceReleased,
    QuestionSource,
    Text600,
    Text900,
    TrialStatus,
)
from arena_core.contracts.findings import StoredFinding

Version = Annotated[int, Field(ge=0)]


class SnapshotTurn(Contract):
    turn_no: TurnNo
    question: Text600
    source: QuestionSource
    answer: Answer | None
    partial: bool
    committed_at: Timestamp | None
    answer_version: Version | None


class SnapshotRelease(EvidenceReleased):
    transcript_version: Version


class RequestableRecord(Contract):
    """S1 public-packet `requestableRecord` (title and description are role-neutral)."""

    record_id: RecordId
    kind: ArtifactKind
    title: Annotated[str, StringConstraints(min_length=5, max_length=120)]
    description: Annotated[str, StringConstraints(min_length=10, max_length=300)]
    requestable_after_exchanges: Exchanges
    date: Annotated[str, StringConstraints(pattern=DATE)] | None = None


class VoiceLine(Contract):
    role: Literal["investigator", "subject"]
    text: Text900
    partial: bool


class VoiceExchange(Contract):
    exchange_no: TurnNo
    lines: Annotated[list[VoiceLine], Field(max_length=40)]


class _SnapshotFields(Contract):
    status: TrialStatus
    reason_code: Annotated[str, StringConstraints(min_length=1, max_length=80)] | None
    mode: Literal["practice", "assessment"]
    split: Literal["dev", "hidden"]
    exchanges_used: Exchanges
    exchanges_cap: TurnNo
    released: Annotated[list[SnapshotRelease], Field(max_length=6)]
    requestable: Annotated[list[RequestableRecord], Field(max_length=6)]
    finding: StoredFinding | None
    commitment_hash: Sha256 | None
    last_seq: Annotated[int, Field(ge=0)]

    @model_validator(mode="after")
    def _within_cap(self) -> Self:
        if self.exchanges_used > self.exchanges_cap:
            msg = f"exchanges_used: {self.exchanges_used} exceeds exchanges_cap {self.exchanges_cap}"
            raise ValueError(msg)
        return self


class TextTrialSnapshot(_SnapshotFields):
    channel: Literal["text"]
    turns: Annotated[list[SnapshotTurn], Field(max_length=12)]
    voice_exchanges: Annotated[list[VoiceExchange], Field(max_length=0)]
    cards: Annotated[list[CoachCard], Field(max_length=12)]
    updates: Annotated[list[CoachUpdate], Field(max_length=12)]
    coach_failures: Annotated[list[CoachFailed], Field(max_length=12)]

    @model_validator(mode="after")
    def _rules(self) -> Self:
        numbers = [t.turn_no for t in self.turns]
        if numbers != list(range(1, len(numbers) + 1)):
            msg = "turns: numbered 1..n in order"
            raise ValueError(msg)
        answered = sum(t.answer is not None for t in self.turns)
        if self.exchanges_used != answered:
            msg = f"exchanges_used: {self.exchanges_used} is not the {answered} answered turns"
            raise ValueError(msg)
        return self


class VoiceTrialSnapshot(_SnapshotFields):
    channel: Literal["voice"]
    turns: Annotated[list[SnapshotTurn], Field(max_length=0)]
    voice_exchanges: Annotated[list[VoiceExchange], Field(max_length=12)]
    cards: Annotated[list[CoachCard], Field(max_length=0)]
    updates: Annotated[list[CoachUpdate], Field(max_length=0)]
    coach_failures: Annotated[list[CoachFailed], Field(max_length=0)]

    @model_validator(mode="after")
    def _rules(self) -> Self:
        numbers = [e.exchange_no for e in self.voice_exchanges]
        if numbers != list(range(1, len(numbers) + 1)):
            msg = "voice_exchanges: numbered 1..n in order"
            raise ValueError(msg)
        if self.exchanges_used != len(numbers):
            msg = f"exchanges_used: {self.exchanges_used} is not the {len(numbers)} stored exchanges"
            raise ValueError(msg)
        return self


TrialSnapshot = TextTrialSnapshot | VoiceTrialSnapshot
