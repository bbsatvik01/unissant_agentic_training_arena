"""Typed wrappers for the subject's own two S4 functions (S2 6.2, 6.7, 6.10; S5 5.1, 5.2).

`subject.turn_context` and `arena.record_subject_turn` are the whole SQL surface `arena_subject` holds EXECUTE
on (S4 section 12: the role has no table privileges at all). Kept apart from `db/calls.py` (the spend-guard
wrappers, WP-05): these two calls carry case content and a guard verdict, never a dollar amount, so they follow
the same shape (one `select <fn>(...)::text` per call, the jsonb result parsed with `json.loads`) without
borrowing that module's private helpers.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal, cast, get_args
from uuid import UUID

from psycopg.types.json import Jsonb

from arena_core.db.calls import Conn, GuardProtocolError

RecordOutcome = Literal["recorded", "quarantined"]


@dataclass(frozen=True)
class TurnContext:
    """`subject.turn_context(trial, work_item)`'s result: the subject's whole view for one open
    `subject_answer` work item at the current version (S2 6.2, 6.7)."""

    trial_id: UUID
    turn_no: int
    transcript_version: int
    exchanges: int
    private_packet: dict[str, Any]
    public_packet: dict[str, Any]
    transcript: list[dict[str, Any]]
    released_evidence: list[dict[str, Any]]
    disclosure_state: dict[str, Any]
    subject_manifest: dict[str, Any]


@dataclass(frozen=True)
class RecordResult:
    """`arena.record_subject_turn`'s result: the answer was recorded, or the guard rejected it and the trial was
    quarantined atomically (S2 6.10). `transcript_version` is absent on a quarantine (the SQL omits it)."""

    outcome: RecordOutcome
    turn_no: int
    transcript_version: int | None


@dataclass(frozen=True, kw_only=True)
class RecordSubjectTurn:
    """The arguments of `arena.record_subject_turn` (S2 6.10): `utterance` is `""` and `tag` is `None` only for
    a G0 (schema or provider-blocked) quarantine; a G1-G7 quarantine still carries the model's actual utterance
    and tag, so the offending artifact is stored in full."""

    trial_id: UUID
    work_item_id: UUID
    utterance: str
    tag: dict[str, Any] | None
    guard_result: dict[str, Any]


def _obj(raw: object, fn: str) -> dict[str, Any]:
    if not isinstance(raw, str):
        msg = f"{fn} returned {type(raw).__name__}, expected jsonb"
        raise GuardProtocolError(msg)
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        msg = f"{fn} returned a non-object"
        raise GuardProtocolError(msg)
    return cast("dict[str, Any]", parsed)


def _field(raw: dict[str, Any], key: str, fn: str) -> Any:  # noqa: ANN401 - the jsonb payload is untyped by design
    if key not in raw:
        msg = f"{fn}: missing {key}"
        raise GuardProtocolError(msg)
    return raw[key]


async def turn_context(conn: Conn, trial_id: UUID, work_item_id: UUID) -> TurnContext:
    """`subject.turn_context(trial, work_item)`. Raises (AR003, as `psycopg.Error`) when the work item is not the
    trial's open `subject_answer` item at the current version."""
    fn = "subject.turn_context"
    async with conn.transaction():
        cur = await conn.execute("select subject.turn_context(%s, %s)::text", (trial_id, work_item_id))
        row = await cur.fetchone()
    if row is None:
        msg = f"{fn} returned no row"
        raise GuardProtocolError(msg)
    raw = _obj(row[0], fn)
    try:
        return TurnContext(
            trial_id=UUID(str(_field(raw, "trial_id", fn))),
            turn_no=int(_field(raw, "turn_no", fn)),
            transcript_version=int(_field(raw, "transcript_version", fn)),
            exchanges=int(_field(raw, "exchanges", fn)),
            private_packet=_field(raw, "private_packet", fn),
            public_packet=_field(raw, "public_packet", fn),
            transcript=_field(raw, "transcript", fn),
            released_evidence=_field(raw, "released_evidence", fn),
            disclosure_state=_field(raw, "disclosure_state", fn),
            subject_manifest=_field(raw, "subject_manifest", fn),
        )
    except (TypeError, ValueError) as exc:
        msg = f"{fn}: malformed result ({exc})"
        raise GuardProtocolError(msg) from exc


async def record_subject_turn(conn: Conn, req: RecordSubjectTurn) -> RecordResult:
    """`arena.record_subject_turn(trial, work_item, utterance, tag_proposal, guard_result)` (S2 6.10)."""
    fn = "arena.record_subject_turn"
    async with conn.transaction():
        cur = await conn.execute(
            "select arena.record_subject_turn(%s, %s, %s, %s, %s)::text",
            (
                req.trial_id,
                req.work_item_id,
                req.utterance,
                None if req.tag is None else Jsonb(req.tag),
                Jsonb(req.guard_result),
            ),
        )
        row = await cur.fetchone()
    if row is None:
        msg = f"{fn} returned no row"
        raise GuardProtocolError(msg)
    raw = _obj(row[0], fn)
    outcome = _field(raw, "outcome", fn)
    if outcome not in get_args(RecordOutcome):
        msg = f"{fn}: unknown outcome {outcome!r}"
        raise GuardProtocolError(msg)
    version = raw.get("transcript_version")
    return RecordResult(
        outcome=cast("RecordOutcome", outcome),
        turn_no=int(_field(raw, "turn_no", fn)),
        transcript_version=None if version is None else int(version),
    )
