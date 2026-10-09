"""Dev-case fixtures for the prompt builders (merged families in `cases/dev`, D-014; development data only).

A released record's content is taken from the family's evaluator packet here because the fixture plays the part of
`release_evidence()` (S4); product code never reads an evaluator packet in a public process.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

from arena_core.agents.manifests import PromptSet, load_prompts, official_manifests
from arena_core.agents.subject_prompts import SubjectPacket, SubjectTurnState
from arena_core.agents.views import (
    EarlierOutput,
    PublicTrialView,
    ReleasedRecord,
    TranscriptTurn,
    public_case,
    released_record,
)
from arena_core.contracts.coaching import (
    CardValidation,
    CoverageEntry,
    DisclosurePlan,
    FlagCheck,
    OpenGap,
    StoredDeepUpdate,
    StoredFlag,
)
from arena_core.contracts.findings import StoredFinding

REPO = Path(__file__).resolve().parents[4]
SALT = "c0ffee01"
REC01_AFTER = 2  # rec-01 is released after exchange 2 in the coach fixture
DEEP_AT = 2  # A1 wrote a deep update after that release


@cache
def family(fid: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((REPO / "cases" / "dev" / f"{fid}.json").read_text(encoding="utf-8"))
    return data


def variant(fid: str, role: str) -> dict[str, Any]:
    out: dict[str, Any] = family(fid)["variants"][role]
    return out


@cache
def prompts(candidate: str) -> PromptSet:
    return load_prompts(official_manifests()[candidate])


def packet(fid: str, role: str) -> SubjectPacket:
    return SubjectPacket.from_private_packet(variant(fid, role)["private_packet"], split="dev")


def release(fid: str, role: str, record_id: str, after: int) -> ReleasedRecord:
    art = next(a for a in variant(fid, role)["evaluator_packet"]["evidence_artifacts"] if a["artifact_id"] == record_id)
    return released_record(record_id, art["title"], art["content"], after, date=art.get("date"))


# A short F01 deceptive interview (development family).
F01_TURNS = [
    (
        "Can you describe, in your own words, what you did at the Halvern Street Annex"
        " on the afternoon of 12 March 2026?",
        "It was a busy shift. We were two technicians down, and Ines radioed me about a humidity alarm in the B wing.",
    ),
    ("Which room was the alarm for?", "She said B-10, the supply room. I reset the dehumidifier there."),
    (
        "The work order list shows WO-4478 for B-10 created at 14:31. What did you do between 14:05 and 14:31?",
        "I was in the B wing the whole time, checking that the alarm stayed clear.",
    ),
]


def transcript(n: int, turns: list[tuple[str, str]] = F01_TURNS) -> list[TranscriptTurn]:
    return [TranscriptTurn(turn_no=i, question=q, answer=a) for i, (q, a) in enumerate(turns[:n], start=1)]


def earlier_flag() -> StoredFlag:
    return StoredFlag(
        kind="gap",
        turn_id="t01",
        quote="It was a busy shift.",
        missing_fact="which room the subject entered and why",
        conflict_turn_id=None,
        conflict_quote=None,
        conflict_record_id=None,
        conflict_record_quote=None,
        flag_ref="t01.f1",
    )


def running(turn: int = 2) -> StoredFinding:
    return StoredFinding(
        label="insufficient_evidence",
        likelihood="roughly_even_chance",
        confidence="low",
        basis_flag_refs=["t01.f1"],
        cited_turns=[1, 2],
        cited_records=["doc-01"],
        corroboration_needed=["verify the work order for B-10", "check the radio log for 14:00-14:31"],
        rationale="The account names B-10 but the exception report lists no task in B-12.",
        alternative_explanations=None,
        last_revised_turn=turn,
    )


def deep(turn: int = 2) -> StoredDeepUpdate:
    return StoredDeepUpdate(
        schema_version="deep.v1",
        as_of_turn=f"t{turn:02d}",
        finding=running(turn),
        evidence_coverage=[CoverageEntry(record_id="rec-01", status="raised_not_tested", turn_ids=["t02"])],
        open_gaps=[OpenGap(missing_fact="what the subject did between 14:05 and 14:31", first_seen_turn="t02")],
        disclosure_plan=DisclosurePlan(record_id="rec-01", step="evidence_topic"),
    )


def coach_view(exchange: int = 3, *, with_deep: bool = True) -> PublicTrialView:
    """F01 deceptive at `exchange`: rec-01 released after exchange 2, one earlier flag, A1's deep update."""
    v = variant("F01", "deceptive")
    released = [release("F01", "deceptive", "rec-01", REC01_AFTER)] if exchange > REC01_AFTER else []
    earlier = EarlierOutput(
        running_finding=running() if exchange > 1 else None,
        flags=[earlier_flag()] if exchange > 1 else [],
        deep_update=deep(DEEP_AT) if with_deep and exchange > DEEP_AT else None,
    )
    return PublicTrialView(
        case=public_case(v["public_packet"]),
        released=released,
        transcript=transcript(exchange),
        earlier=earlier,
        exchange=exchange,
    )


def subject_state(
    n: int, released: dict[str, int] | None = None, opened: dict[str, int] | None = None
) -> SubjectTurnState:
    turns = F01_TURNS + [(f"Question {i}?", f"Answer {i}.") for i in range(4, 13)]
    return SubjectTurnState(
        n=n,
        transcript=transcript(n - 1, turns),
        question=turns[n - 1][0],
        released=released or {},
        opened_gates=opened or {},
        first_disclosed={"f:01": 1, "f:02": 1} if n > 1 else {},
    )


def validation_for(refs: list[str]) -> CardValidation:
    return CardValidation(
        valid=True,
        flags={r: FlagCheck(citation_ok=True, demeanor_based=False, duplicate=False) for r in refs},
        demeanor_in_rationale=False,
    )
