"""`debrief.v1` (S3 5.7; D8, SG2-30, SG3-34, SG4-31): one document per ended development session.

Two exclusive branches on `scored`: a scored text session carries `rubric`, `scorecards` and `provenance`; an
unscored voice session (D7) carries only `schema_version`, `session_id`, `scored: false` and `outcome`. The
document holds the case outcome because the session has ended (the one exception to S6's visibility matrix);
it carries no candidate hash, participant pseudonym, fact ID or hidden-case content.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from arena_core.contracts.common import GIT_SHA, Contract, Distinct, Label, Sha256, TurnNo, UniqueItems, Uuid

DebriefVersion = Literal["debrief.v1"]
Count = Annotated[int, Field(ge=0)]
Turns = Annotated[list[TurnNo], Field(max_length=12), UniqueItems, Distinct]


class Outcome(Contract):
    role: Literal["truthful", "deceptive"]
    correct_finding: Literal["truthful", "deceptive"]
    committed_label: Label | None
    resolution: Annotated[str, StringConstraints(min_length=1, max_length=900)]


class RubricCheck(Contract):
    id: Annotated[str, StringConstraints(pattern=r"^[1-5][a-e]$")]
    result: Literal["pass", "fail", "na"]
    turns: Turns


class RubricDimension(Contract):
    dim_id: Literal["D1", "D2", "D3", "D4", "D5"]
    score: Annotated[int, Field(ge=0, le=4)]
    checks: Annotated[list[RubricCheck], Field(max_length=5)]


class Rubric(Contract):
    """A session with fewer than three questions is unscorable: `scorable` false, the reason, `total` null and
    no dimensions (S3 2.2, SG2-38)."""

    scorable: bool
    unscorable_reason: Annotated[str, StringConstraints(max_length=200)] | None
    total: Annotated[int, Field(ge=0, le=100)] | None
    dimensions: Annotated[list[RubricDimension], Field(max_length=5)]

    @model_validator(mode="after")
    def _branch(self) -> Self:
        if self.scorable and (self.total is None or self.unscorable_reason is not None):
            msg = "rubric: a scorable rubric has a total and no unscorable_reason"
            raise ValueError(msg)
        if not self.scorable and (self.total is not None or self.dimensions or not self.unscorable_reason):
            msg = "rubric: an unscorable rubric has a reason, a null total and no dimensions (SG2-38)"
            raise ValueError(msg)
        return self


class EvidenceCoverage(Contract):
    addressed: Count
    key_facts: Annotated[int, Field(ge=1)]


class KeyQuestion(Contract):
    intent: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    addressed_turns: Turns


class Learning(Contract):
    evidence_coverage: EvidenceCoverage
    key_questions: Annotated[list[KeyQuestion], Field(max_length=8)]


class Counts(Contract):
    tp: Count
    flags: Count
    events: Count


class Unsupported(Contract):
    citation: Count
    demeanor: Count
    claim: Count


class Detection(Contract):
    evasion_strict: Counts
    evasion_broad: Counts
    unique_flags: Count
    unsupported: Unsupported
    coach_last_label: Label | None


class Failures(Contract):
    F1: Count
    F2_F4: Count
    F3: Count
    F5: Count
    F6: Count


class SubjectRealism(Contract):
    turns: Annotated[int, Field(ge=0, le=12)]
    compliant: Annotated[int, Field(ge=0, le=12)]
    failures: Failures


class Scorecards(Contract):
    learning: Learning
    detection: Detection
    subject_realism: SubjectRealism


class Provenance(Contract):
    rubric_sha256: Sha256
    r3_prompt_sha256: Annotated[list[Sha256], Field(min_length=2, max_length=2)]
    referee_model_ids: Annotated[
        list[Annotated[str, StringConstraints(min_length=1, max_length=80)]], Field(min_length=1, max_length=2)
    ]
    scorer_git_sha: Annotated[str, StringConstraints(pattern=GIT_SHA)]


class ScoredDebrief(Contract):
    schema_version: DebriefVersion
    session_id: Uuid
    scored: Literal[True]
    outcome: Outcome
    rubric: Rubric
    scorecards: Scorecards
    provenance: Provenance


class UnscoredDebrief(Contract):
    """A voice session (D7): outcome and resolution only; no R3 ran and nothing was measured."""

    schema_version: DebriefVersion
    session_id: Uuid
    scored: Literal[False]
    outcome: Outcome


Debrief = ScoredDebrief | UnscoredDebrief
