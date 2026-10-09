"""The one projection (S5 6.2): the only code that turns stored event rows into wire frames, and the only producer
of wire bytes.

`wire_deltas(rows, viewer)` filters the trial's stored events for the viewer, maps each persisted kind to its wire
type (C-17), validates the frame against the contract and serializes it, all in one call; it returns finished
SSE messages as `bytes`. No frame object leaves this module, so nothing can be subclassed, mutated or swapped
between projection and serialization, and `events.sse` writes only these bytes. There is no public function that
accepts a frame and returns wire bytes.

Threat model (D-016, a local team-run demo): this protects against our own code accidentally sending an
unprojected frame. Deliberate in-process circumvention through private names is out of reach of any Python API;
it is a lint violation instead (`tools/check_roles.py` bans importing frame models outside this module and
importing this module's private names).

The rows are `arena.trial_events` joined with what a frame needs beyond the payload (the release row of an
evidence event, the terminal record of `trial_ended`); WP-13 owns that query, the synthesized frames
(`subject.thinking`, `coach.working`, `notice`), the snapshot fold and the tournament scope.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import TypeAdapter

from arena_core.contracts.coaching import StoredCard
from arena_core.contracts.common import turn_no
from arena_core.contracts.events import TrialFrame

MAX_DELTA_BYTES = 16 * 1024
_FRAMES: TypeAdapter[TrialFrame] = TypeAdapter(TrialFrame)


@dataclass(frozen=True)
class Release:
    """The `arena.released_evidence` row behind an evidence event."""

    released_after_exchanges: int
    trigger: Literal["scheduled", "requested"]
    date: str | None


@dataclass(frozen=True)
class StoredEvent:
    """One `arena.trial_events` row of a training trial, with the joined columns its frame needs."""

    trial_id: str
    trial_kind: str
    seq: int
    kind: str
    visibility: Literal["live", "debrief", "internal"]
    transcript_version: int
    turn_no: int | None
    payload: Mapping[str, Any]
    created_at: str
    release: Release | None = None
    terminal_state: str | None = None


@dataclass(frozen=True)
class Viewer:
    """The trial's owner, as the stream sees them: whether the trial has ended (debrief rows open then)."""

    trial_ended: bool


def _visible(row: StoredEvent, viewer: Viewer) -> bool:
    """S5 6.1-6.2: `live` rows always, `debrief` rows after the trial ended, `internal` rows never."""
    return row.visibility == "live" or (row.visibility == "debrief" and viewer.trial_ended)


def _question(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    p = row.payload
    data = {"turn_no": p["turn_no"], "text": p["question"], "source": p["source"], "channel": p["channel"]}
    return [("question.accepted", data, row.seq)]


def _answer(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    p = row.payload
    data = {
        "turn_no": p["turn_no"],
        "text": p["answer"],
        "channel": p["channel"],
        "partial": p["partial"],
        "committed_at": row.created_at,
    }
    return [("subject.answer", data, row.seq)]


def _evidence(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    if row.release is None:
        msg = f"event {row.seq}: an evidence event needs its release row"
        raise ValueError(msg)
    p = row.payload
    data = {
        "record_id": p["record_id"],
        "title": p["title"],
        "kind": p["kind"],
        "doc_kind": p["doc_kind"],
        "date": row.release.date,
        "content": p["content"],
        "released_at_turn": row.release.released_after_exchanges,
        "trigger": row.release.trigger,
    }
    return [("evidence.released", data, row.seq)]


def _card(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    card = StoredCard.model_validate(dict(row.payload)).training_wire()
    return [("coach.card", {"turn_no": card.turn_no, "card": card.model_dump(mode="json")}, row.seq)]


def _deep(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    data = {"turn_no": turn_no(row.payload["as_of_turn"]), "update": dict(row.payload)}
    return [("coach.update", data, row.seq)]


def _unavailable(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    return [("coach.failed", {"turn_no": row.turn_no, "reason": row.payload["reason"]}, row.seq)]


def _finding(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    by = "investigator" if row.trial_kind == "training" else "assistant"
    data = {"by": by, "finding": dict(row.payload), "committed_at": row.created_at}
    return [("finding.committed", data, row.seq)]


def _ended(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    """S5 6.2 (SG4-02, X-15, C-45): status from the terminal record; a completed trial yields `trial.status`
    without a seq, then `trial.finalized` carrying the row's seq."""
    state = row.terminal_state
    if state is None:
        msg = f"event {row.seq}: trial_ended needs the trial's terminal record"
        raise ValueError(msg)
    if state == "completed":
        return [
            ("trial.status", {"status": "completed", "reason_code": None}, None),
            ("trial.finalized", {"commitment_hash": row.payload["commitment_sha256"]}, row.seq),
        ]
    return [("trial.status", {"status": state, "reason_code": row.payload.get("reason")}, row.seq)]


def _debrief(row: StoredEvent) -> list[tuple[str, dict[str, Any], int | None]]:
    return [("debrief.ready", {"session_id": row.payload["session_id"]}, row.seq)]


_MAPPING: dict[str, Callable[[StoredEvent], list[tuple[str, dict[str, Any], int | None]]]] = {
    "question_recorded": _question,
    "subject_turn": _answer,
    "evidence_released": _evidence,
    "clarification": _evidence,
    "coach_card": _card,
    "coach_deep": _deep,
    "coach_unavailable": _unavailable,
    "finding_committed": _finding,
    "trial_ended": _ended,
    "debrief_ready": _debrief,
}


def _message(row: StoredEvent, wire_type: str, data: dict[str, Any], seq: int | None) -> bytes:
    frame = _FRAMES.validate_python(
        {
            "v": 1,
            "seq": seq,
            "scope": "trial",
            "scope_id": row.trial_id,
            "type": wire_type,
            "ts": row.created_at,
            "transcript_version": row.transcript_version,
            "data": data,
        }
    )
    body = _FRAMES.dump_json(frame)
    if len(body) > MAX_DELTA_BYTES:
        msg = f"event {row.seq}: a delta of {len(body)} bytes exceeds {MAX_DELTA_BYTES} (S5 6.2)"
        raise ValueError(msg)
    head = b"" if seq is None else f"id: {seq}\n".encode()
    return head + b"data: " + body + b"\n\n"


def wire_deltas(rows: Iterable[object], viewer: Viewer) -> list[bytes]:
    """The SSE messages this viewer receives for these stored events, in order: projected, validated against
    the contract and serialized in this one call. Anything but a `StoredEvent` (a frame, a dict) raises TypeError; a
    row whose kind has no wire type is a defect and raises ValueError."""
    out: list[bytes] = []
    for row in rows:
        if not isinstance(row, StoredEvent):
            msg = f"wire_deltas projects stored events, not {type(row).__name__}"
            raise TypeError(msg)
        if not _visible(row, viewer):
            continue
        mapping = _MAPPING.get(row.kind)
        if mapping is None:
            msg = f"event {row.seq}: unknown event kind {row.kind!r}"
            raise ValueError(msg)
        out.extend(_message(row, wire_type, data, seq) for wire_type, data, seq in mapping(row))
    return out
