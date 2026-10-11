"""Raw database rows (plain dicts, already fetched) to the referee prompt builders' typed inputs (S2 7.1-7.3,
7.5) and to the scorer's `TrialRows` (S3 1.3.1). Pure: no database or model call, so these are unit-tested
without a connection. `arena_referee.db` does the actual SELECTs and hands this module their results.

One `TrialData` shape serves R1, R2 and R3 alike (an interactive trial or a training trial reads the same
columns); the caller decides `mode` ("assistant" for R2, "investigator" for R3's `r3_investigator`).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from arena_core.agents.post_checks import j3_flags
from arena_core.agents.referee_prompts import (
    CanonicalFact,
    FindingCitations,
    FindingProjection,
    FollowUpLine,
    RefereeAssistantInput,
    RefereeSubjectInput,
)
from arena_core.agents.subject_prompts import SubjectPacket
from arena_core.agents.triggers import Timing, assistant_questions, derive_triggers, investigator_questions
from arena_core.agents.views import ReleasedRecord, TranscriptTurn, public_case, released_record
from arena_core.contracts.adapter import Card, adapt_card
from arena_core.contracts.citations import Record, Turn, content_text
from arena_core.contracts.coaching import StoredCard, StoredFlag
from arena_core.contracts.common import turn_id
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import RefereeSubjectReport
from arena_core.contracts.review import TriggerEntry
from arena_core.scoring.flags import TrialRows

Mode = Literal["assistant", "investigator"]


@dataclass(frozen=True, kw_only=True)
class TrialData:
    """Everything one trial's R1/R2 (or R3's two calls) read, already fetched as plain rows."""

    trial_id: str
    split: Literal["dev", "hidden"]
    canonical_facts: Sequence[Mapping[str, Any]]  # the evaluator packet's own rows (id, statement, material)
    private_packet: Mapping[str, Any]
    public_packet: Mapping[str, Any]
    released: Sequence[Mapping[str, Any]]  # record_id, title, content, released_after, date
    transcript: Sequence[Mapping[str, Any]]  # turn_no, question, answer, question_source
    cards: Sequence[Mapping[str, Any]]  # raw coach_card event payloads, in turn order
    final_finding: Mapping[str, Any] | None


def material_fact_ids(data: TrialData) -> frozenset[str]:
    return frozenset(f["id"] for f in data.canonical_facts if f["material"])


def available_after(data: TrialData) -> dict[str, int]:
    """Every visible document's availability: 0 for an initial document, its release exchange for a record
    (S2 7.2 SG2-41: initial documents and released records are one population). Used to build R2's trigger
    entries and, for a training session, 3e's contradiction availability (S3 2.2) -- never 3c's, which reads
    only `record_released_after` (initial documents are never "released", S3 2.2's 3c trigger)."""
    out = {d["doc_id"]: 0 for d in data.public_packet["initial_documents"]}
    out.update({r["record_id"]: r["released_after"] for r in data.released})
    return out


def record_released_after(data: TrialData) -> dict[str, int]:
    """Only the records actually released (`rec-NN`), for S3 2.2's 3c trigger (`rubric.triggers_from`'s
    `released_after`): an initial document is visible from the start, never a 3c release."""
    return {r["record_id"]: r["released_after"] for r in data.released}


def _stored_cards(data: TrialData) -> list[StoredCard]:
    return [StoredCard.model_validate(c) for c in data.cards]


def _transcript_turns(data: TrialData) -> list[TranscriptTurn]:
    return [TranscriptTurn(turn_no=t["turn_no"], question=t["question"], answer=t["answer"]) for t in data.transcript]


def _released_records(data: TrialData) -> list[ReleasedRecord]:
    return [
        released_record(r["record_id"], r["title"], r["content"], r["released_after"], r.get("date"))
        for r in data.released
    ]


def build_subject_input(data: TrialData) -> RefereeSubjectInput:
    """R1's and `r3_subject`'s input (S2 7.1, 7.2): no tag, coaching or identity type (AT-REF-1)."""
    case = public_case(data.public_packet)
    packet = SubjectPacket.from_private_packet(data.private_packet, data.split)
    return RefereeSubjectInput(
        canonical_facts=[CanonicalFact(id=f["id"], statement=f["statement"]) for f in data.canonical_facts],
        packet=packet,
        initial_documents=case.initial_documents,
        released=_released_records(data),
        transcript=_transcript_turns(data),
    )


def _finding_and_citations(
    final_finding: Mapping[str, Any] | None,
) -> tuple[FindingProjection | None, FindingCitations]:
    if final_finding is None:
        return None, FindingCitations(cited_turns=[], cited_records=[])
    stored = StoredFinding.model_validate(final_finding)
    projection = FindingProjection.of(stored)
    citations = FindingCitations(cited_turns=stored.cited_turns, cited_records=stored.cited_records)
    return projection, citations


def build_assistant_input(data: TrialData, mode: Mode, triggers: Sequence[TriggerEntry]) -> RefereeAssistantInput:
    """R2's (`mode="assistant"`) or `r3_investigator`'s (`mode="investigator"`) input (S2 7.1, 7.3, 7.5): no
    private, evaluator, role, identity, label or fidelity type (AT-REF-1); `triggers` are code-built IDs only
    (C-12), never a label word."""
    stored_cards = _stored_cards(data)
    flags: Sequence[StoredFlag] = j3_flags(stored_cards)
    followups: list[FollowUpLine]
    if mode == "assistant":
        followups = [
            FollowUpLine(turn_id=sc.turn_id, tactic=sc.follow_up.tactic, question=sc.follow_up.question)
            for sc in stored_cards
        ]
    else:
        followups = [
            FollowUpLine(turn_id=turn_id(t["turn_no"]), tactic=None, question=t["question"])
            for t in data.transcript
            if t["question_source"] == "investigator"
        ]
    finding, citations = _finding_and_citations(data.final_finding)
    return RefereeAssistantInput(
        mode=mode,
        case=public_case(data.public_packet),
        released=_released_records(data),
        transcript=_transcript_turns(data),
        flags=list(flags),
        followups=followups,
        finding=finding,
        citations=citations,
        triggers=list(triggers),
    )


def build_triggers(data: TrialData, report: RefereeSubjectReport, mode: Mode) -> list[TriggerEntry]:
    """The trigger entries R2 (or `r3_investigator`) receives, derived by code from R1's validated report
    (S2 7.2, C-12)."""
    available = available_after(data)
    questions: dict[int, Timing]
    if mode == "assistant":
        questions = assistant_questions(sc.turn_no for sc in _stored_cards(data))
    else:
        questions = investigator_questions(
            t["turn_no"] for t in data.transcript if t["question_source"] == "investigator"
        )
    return derive_triggers(report, available, questions)


def trial_rows(data: TrialData) -> TrialRows:
    """S3 1.3.1's `TrialRows`: the trial's own committed turns and records, initial documents included."""
    turns = {t["turn_no"]: Turn(answer=t["answer"], partial=False) for t in data.transcript}
    records = {d["doc_id"]: Record(content_text(d["content"])) for d in data.public_packet["initial_documents"]}
    records.update(
        {r["record_id"]: Record(content_text(r["content"]), released_after=r["released_after"]) for r in data.released}
    )
    return TrialRows(turns, records)


def adapted_cards(data: TrialData) -> list[Card]:
    """The trial's cards as S3's scorer adapter reads them (for the debrief's detection scorecard)."""
    return [adapt_card(c) for c in data.cards]


def question_sources(data: TrialData) -> dict[int, str]:
    """Turn -> `question_source` (S3 1.3: never inferred from wording)."""
    return {t["turn_no"]: t["question_source"] for t in data.transcript}


def investigator_turn_numbers(data: TrialData) -> list[int]:
    return [t["turn_no"] for t in data.transcript if t["question_source"] == "investigator"]
