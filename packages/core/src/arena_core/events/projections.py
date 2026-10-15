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

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from pydantic import TypeAdapter

from arena_core.contracts.coaching import StoredCard
from arena_core.contracts.common import turn_no
from arena_core.contracts.events import CoachCard, HarnessFrame, TournamentFrame, TrialFrame
from arena_core.contracts.snapshot import TrialSnapshot

MAX_DELTA_BYTES = 16 * 1024
_FRAMES: TypeAdapter[TrialFrame] = TypeAdapter(TrialFrame)
# A harness trial's export (D-021) also carries a replay trial's `source_unavailable` end (`HarnessFrame`).
_HARNESS_FRAMES: TypeAdapter[HarnessFrame] = TypeAdapter(HarnessFrame)


def _frames(viewer: Viewer | None) -> TypeAdapter[Any]:
    return _HARNESS_FRAMES if viewer is not None and viewer.mode == "harness" else _FRAMES


_SNAPSHOT: TypeAdapter[TrialSnapshot] = TypeAdapter(TrialSnapshot)


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
    """The trial's owner, as the stream sees them: whether the trial has ended (debrief rows open then), and the
    session's mode (`coach.working` is a practice-only frame, S5 6.2; withheld unless the mode is known).

    `internal_visible` is never set by a browser-facing surface (every `internal` row stays hidden from any
    investigator or judge, S5 6.1): it exists only for the D-021 recording export of a tournament trial
    (`arena_tournament`, WP-17), whose turn and coaching events are *all* `internal` visibility (S4 `_emit`),
    and which the database's own `arena.trial_visible` already gated before any row reached this module (a
    dev-split trial, or a hidden one after reveal) -- this flag reads that same database decision, not a new
    one."""

    trial_ended: bool
    mode: Literal["practice", "assessment", "harness"] = "assessment"
    internal_visible: bool = False


def _visible(row: StoredEvent, viewer: Viewer) -> bool:
    """S5 6.1-6.2: `live` rows always, `debrief` rows after the trial ended, `internal` rows never -- except
    for the D-021 export viewer, which the database has already restricted to a dev or revealed tournament."""
    if row.visibility == "internal":
        return viewer.internal_visible
    return row.visibility == "live" or viewer.trial_ended  # the remaining case is "debrief"


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


def _frame(
    row: StoredEvent, wire_type: str, data: dict[str, Any], seq: int | None, viewer: Viewer | None = None
) -> TrialFrame:
    frame: TrialFrame = _frames(viewer).validate_python(
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
    return frame


def _message(row: StoredEvent, wire_type: str, data: dict[str, Any], seq: int | None) -> bytes:
    body = _FRAMES.dump_json(_frame(row, wire_type, data, seq))
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


# ---------------------------------------------------------------- live stream, snapshot and recording (WP-13)

_COACHING = frozenset({"coach_card", "coach_unavailable"})


def _hints(row: StoredEvent, later: list[StoredEvent], viewer: Viewer) -> list[tuple[str, dict[str, Any], None]]:
    """S5 6.2 synthesized frames, sent without an SSE `id`: `subject.thinking` after a question whose answer has
    not arrived, and (practice only) `coach.working` after an answer whose card has not arrived. "Not arrived"
    reads the rows delivered with it, so a catch-up batch that already holds the answer sends no hint."""
    turn = row.payload.get("turn_no")
    if row.kind == "question_recorded":
        answered = any(
            r.kind in ("subject_turn", "trial_ended") and r.payload.get("turn_no", turn) == turn for r in later
        )
        return [] if answered else [("subject.thinking", {"turn_no": turn}, None)]
    if row.kind == "subject_turn" and viewer.mode == "practice":
        coached = any(r.kind in _COACHING or r.kind == "trial_ended" for r in later if r.turn_no in (turn, None))
        return [] if coached else [("coach.working", {"turn_no": turn}, None)]
    return []


def _projected(rows: list[StoredEvent], viewer: Viewer) -> list[tuple[StoredEvent, TrialFrame]]:
    visible = [row for row in rows if _visible(row, viewer)]
    out: list[tuple[StoredEvent, TrialFrame]] = []
    for i, row in enumerate(visible):
        mapping = _MAPPING.get(row.kind)
        if mapping is None:
            msg = f"event {row.seq}: unknown event kind {row.kind!r}"
            raise ValueError(msg)
        out.extend((row, _frame(row, t, d, s, viewer)) for t, d, s in mapping(row))
        out.extend((row, _frame(row, t, d, s, viewer)) for t, d, s in _hints(row, visible[i + 1 :], viewer))
    return out


def live_deltas(rows: Iterable[object], viewer: Viewer) -> list[bytes]:
    """The trial stream's SSE messages: `wire_deltas` plus the synthesized hint frames (S5 6.2)."""
    events: list[StoredEvent] = []
    for row in rows:
        if not isinstance(row, StoredEvent):
            msg = f"live_deltas projects stored events, not {type(row).__name__}"
            raise TypeError(msg)
        events.append(row)
    out: list[bytes] = []
    for row, frame in _projected(events, viewer):
        body = _FRAMES.dump_json(frame)
        if len(body) > MAX_DELTA_BYTES:
            msg = f"event {row.seq}: a delta of {len(body)} bytes exceeds {MAX_DELTA_BYTES} (S5 6.2)"
            raise ValueError(msg)
        head = b"" if frame.seq is None else f"id: {frame.seq}\n".encode()
        out.append(head + b"data: " + body + b"\n\n")
    return out


def notice_message(trial_id: str, ts: str, version: int, kind: Literal["paused", "quota"], text: str) -> bytes:
    """`notice` (S5 6.2): the kill switch turned on while the stream is open, or the quota is spent."""
    frame = _FRAMES.validate_python(
        {
            "v": 1,
            "seq": None,
            "scope": "trial",
            "scope_id": trial_id,
            "type": "notice",
            "ts": ts,
            "transcript_version": version,
            "data": {"kind": kind, "text": text},
        }
    )
    return b"data: " + _FRAMES.dump_json(frame) + b"\n\n"


def recording_events(
    rows: list[StoredEvent],
    mode: Literal["practice", "assessment", "harness"],
    start_ms: float,
    *,
    internal_visible: bool = False,
) -> list[dict[str, Any]]:
    """D-021: the frames the session's owner saw live, in order, each with `at_ms` from the session start. Each
    row is projected as it arrived (no lookahead), so the hint frames are where the live stream put them, and
    debrief-only rows (assessment coaching) stay out, as they did during the session. `internal_visible` is
    the tournament export's own case (`harness` mode): every row of such a trial is `internal`, so without it
    nothing would ever be visible (`Viewer`'s own docstring)."""
    live = Viewer(trial_ended=False, mode=mode, internal_visible=internal_visible)
    out: list[dict[str, Any]] = []
    for row in rows:
        for _, frame in _projected([row], live):
            at = max(0, round(_epoch_ms(row.created_at) - start_ms))
            out.append({"at_ms": at, "frame": _frames(live).dump_python(frame, mode="json")})
    return out


def _epoch_ms(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000


@dataclass(frozen=True)
class TrialState:
    """What the snapshot needs beyond the event rows: the trial's S6 status (C-45), mode, cap and packet."""

    trial_id: str
    status: str
    reason_code: str | None
    mode: Literal["practice", "assessment", "harness"]
    exchanges_cap: int
    public_packet: Mapping[str, Any]


def s6_status(status: str, execution_state: str | None) -> str:
    """C-45: S4 trial status plus the terminal record to S6's status."""
    if status in ("running", "planned"):
        return "running"
    if execution_state is None:
        msg = f"a {status} trial has no terminal record"
        raise ValueError(msg)
    return execution_state


def snapshot(state: TrialState, rows: list[StoredEvent], viewer: Viewer) -> dict[str, Any]:
    """`GET /api/trials/{id}/snapshot` (S5 6.2, D9): the absolute state folded from the same projected frames the
    stream carries, validated against the snapshot contract. REST, so no 16 KB limit."""
    turns: dict[int, dict[str, Any]] = {}
    released: list[dict[str, Any]] = []
    cards: list[dict[str, Any]] = []
    updates: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    finding: dict[str, Any] | None = None
    commitment: str | None = None
    last_seq = 0
    for row, frame in _projected(rows, viewer):
        data = _frames(viewer).dump_python(frame, mode="json")["data"]
        last_seq = max(last_seq, row.seq) if _visible(row, viewer) else last_seq
        if frame.type == "question.accepted":
            turns[data["turn_no"]] = {
                "turn_no": data["turn_no"],
                "question": data["text"],
                "source": data["source"],
                "answer": None,
                "partial": False,
                "committed_at": None,
                "answer_version": None,
                "question_seq": row.seq,
            }
        elif frame.type == "subject.answer":
            turn = turns[data["turn_no"]]
            turn.update(answer=data["text"], partial=data["partial"], committed_at=data["committed_at"])
            turn["answer_version"] = row.transcript_version
        elif frame.type == "evidence.released":
            released.append({**data, "transcript_version": row.transcript_version, "event_seq": row.seq})
        elif frame.type == "coach.card":
            cards.append({**data, "event_seq": row.seq})
        elif frame.type == "coach.update":
            updates.append(data)
        elif frame.type == "coach.failed":
            failures.append(data)
        elif frame.type == "finding.committed":
            finding = data["finding"]
        elif frame.type == "trial.finalized":
            commitment = data["commitment_hash"]
    released_ids = {r["record_id"] for r in released}
    requestable = [
        {
            k: r[k]
            for k in ("record_id", "kind", "title", "description", "requestable_after_exchanges", "date")
            if k in r
        }
        for r in state.public_packet.get("requestable_records", [])
        if r["record_id"] not in released_ids
    ]
    ordered = [turns[n] for n in sorted(turns)]
    body = {
        "channel": "text",
        "status": state.status,
        "reason_code": state.reason_code,
        "mode": state.mode,
        "split": "dev",
        "exchanges_used": sum(t["answer"] is not None for t in ordered),
        "exchanges_cap": state.exchanges_cap,
        "turns": ordered,
        "voice_exchanges": [],
        "released": released,
        "requestable": requestable,
        "cards": cards,
        "updates": updates,
        "coach_failures": failures,
        "finding": finding,
        "commitment_hash": commitment,
        "last_seq": last_seq,
    }
    dumped: dict[str, Any] = _SNAPSHOT.dump_python(_SNAPSHOT.validate_python(body), mode="json")
    return dumped


# ---------------------------------------------------------------- tournament scope (polled; S5 6.2, S6 4.9, 5.3)

_TOURNAMENT_FRAMES: TypeAdapter[TournamentFrame] = TypeAdapter(TournamentFrame)
# Every S4 tournament-lifecycle `ledger.append_event` type (`tournament_ledger.sql`) that becomes
# `tournament.status`, to the state it reports.
_TOURNAMENT_STATUS: dict[str, str] = {
    "tournament_created": "draft",
    "roster_frozen": "frozen",
    "tournament_running": "running",
    "tournament_sealed": "sealed",
    "tournament_scoring": "scoring",
    "tournament_revealed": "revealed",
}


@dataclass(frozen=True)
class LedgerRow:
    """One `ledger.v_events` row scoped to a tournament (S5 6.2, S6 4.9, 5.3). The caller (`arena_core.db.arena`,
    never this module's own SQL) joins in what a tournament frame needs beyond the payload: the trial's own
    planned position (`trial_ref`, an opaque per-tournament ordinal, `arena.planned_trials.position`), its
    track and block, its pairing for `trial.started` (the registered assistant and subject candidate names,
    S6 4.9's "A1 x S1"; a replay trial's subject is its corpus source's own, joined through
    `source_planned_trial_id`), and whether the trial ever actually started (`arena.v_trials.started_at is
    null`: a `budget_skipped` or `source_unavailable` attempt never reaches S4 `arena.start_trial`, so no
    `trial_started` row exists for it anywhere in the ledger -- `never_started` lets `tournament_frames`
    synthesize the one this scope's own contract still requires, S6 4.9's matrix). `trial_ref`, `track`,
    `block`, `pairing` and `never_started` are all at their default for a tournament-level row (one with no
    `trial_id` at all, such as `tournament_running`)."""

    seq: int
    event_type: str
    trial_id: str | None
    created_at: str
    payload: Mapping[str, Any]
    trial_ref: int | None = None
    track: str | None = None
    block: int | None = None
    pairing: str | None = None
    never_started: bool = False


def _started(row: LedgerRow) -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "trial.started",
            {
                "trial_ref": row.trial_ref,
                "trial_id": row.trial_id,
                "pairing": row.pairing,
                "track": row.track,
                "block": row.block,
            },
        )
    ]


def _replay_turn(row: LedgerRow) -> list[tuple[str, dict[str, Any]]]:
    return [("replay.turn", {"trial_ref": row.trial_ref, "turn_no": row.payload["turn_no"]})]


def _trial_finalized(row: LedgerRow) -> list[tuple[str, dict[str, Any]]]:
    """S4 `arena.finalize_trial`'s own success payload already carries `state: "completed"` next to the
    commitment hash (`tournament_ledger.sql`'s `trial_finalized` append): a completed trial writes no
    separate `execution_recorded` row, so this is the only place that state ever reaches the ledger, and the
    matrix needs it exactly as it needs every other terminal state (S6 4.9)."""
    return [
        ("trial.execution", {"trial_ref": row.trial_ref, "state": row.payload["state"]}),
        ("trial.finalized", {"trial_ref": row.trial_ref, "commitment_hash": row.payload["commitment_sha256"]}),
    ]


def _trial_execution(row: LedgerRow) -> list[tuple[str, dict[str, Any]]]:
    return [("trial.execution", {"trial_ref": row.trial_ref, "state": row.payload["state"]})]


# Every ledger `event_type` naming a trial that still carries a tournament-scope frame (S6 5.3), keyed by
# that name; `_tournament_frames_for` dispatches here once it knows the row's own trial is framed at all.
_TRIAL_FRAME_BUILDERS: dict[str, Callable[[LedgerRow], list[tuple[str, dict[str, Any]]]]] = {
    "trial_started": _started,
    "replay_turn_copied": _replay_turn,
    "trial_finalized": _trial_finalized,
    "execution_recorded": _trial_execution,
}
# S4 never writes a real `trial_started` row for one of these (arena.start_trial's early-return and
# arena.record_execution_failure from `planned`, S4 EF-01, EF-09): `execution_recorded` is the only row this
# trial will ever contribute, so it is also the one row that must open the matrix cell for it.
_NEVER_STARTED_TERMINAL_EVENT = "execution_recorded"


def _tournament_frames_for(row: LedgerRow) -> list[tuple[str, dict[str, Any]]]:
    """The tournament-scope wire types and data for this row, in order (zero, one or two: a terminal row may
    also need the `trial.started` the ledger never recorded, or carries both an execution state and a
    finalization). Empty for a row this scope carries no frame for (S6 5.3: "no block-start frame... no
    referee.labeled or budget.* frame") -- a trial-scope event this tournament trial also wrote
    (`question_asked`, `evidence_released`, `subject_answered`, ...), a lifecycle or audit row with no wire
    type (`trial_retry`, `validity_adjudicated`, `manifest_corrected`), or any event of a `replay_corpus`
    trial, which S6 4.9 shows only as progress counts, dev split or revealed alike, never a wire frame (its
    corpus producer run stays internal)."""
    state = _TOURNAMENT_STATUS.get(row.event_type)
    if state is not None:
        return [("tournament.status", {"state": state})]
    if row.trial_ref is None or row.track == "replay_corpus":
        return []
    out: list[tuple[str, dict[str, Any]]] = []
    if row.never_started and row.event_type == _NEVER_STARTED_TERMINAL_EVENT:
        out.extend(_started(row))
    builder = _TRIAL_FRAME_BUILDERS.get(row.event_type)
    if builder is not None:
        out.extend(builder(row))
    return out


def tournament_frames(rows: Iterable[object], tournament_id: str, limit: int = 200) -> tuple[list[dict[str, Any]], int]:
    """`GET /api/tournaments/{id}/events?after=` (S5 6.2, S6 4.9, 5.3): the tournament's wire frames for these
    ledger rows (in ascending `seq` order), validated against `TournamentFrame` and dumped -- never a frame
    object leaves this module -- at most `limit` of them. Returns the frames and the ledger `seq` to resume
    after: the last row this call actually consumed, whether or not it produced a frame, so a filtered-out
    row (a trial-scope event, a replay-corpus trial) is never re-read on the next poll. A row's own frames
    (one or two) are never split across pages: a row that would push the page past `limit` is left entirely
    for the next call, so its frames are built exactly once, on the call that has room for all of them."""
    out: list[dict[str, Any]] = []
    last = 0
    for row in rows:
        if not isinstance(row, LedgerRow):
            msg = f"tournament_frames projects ledger rows, not {type(row).__name__}"
            raise TypeError(msg)
        built = _tournament_frames_for(row)
        if built:
            if len(out) + len(built) > limit:
                break
            for wire_type, data in built:
                frame = _TOURNAMENT_FRAMES.validate_python(
                    {
                        "v": 1,
                        "seq": row.seq,
                        "scope": "tournament",
                        "scope_id": tournament_id,
                        "type": wire_type,
                        "ts": row.created_at,
                        "data": data,
                    }
                )
                out.append(_TOURNAMENT_FRAMES.dump_python(frame, mode="json"))
        last = row.seq
    return out, last


def voice_coach_card_text(card: StoredCard, exchange_no: int) -> str:
    """A practice voice session's card (UI v2 amendment to D7) as the voice socket's text frame: the `coach.card`
    frame's own `data` (`{turn_no, card}`, the training wire card, checked against the same contract the trial
    stream uses) under `type: "coach.card"`, with the spoken exchange it coaches. The card is never stored as a
    trial event, so it has no `seq` and never travels on SSE (S5 7.7); the earpiece speaks it."""
    wire = card.training_wire()
    data = CoachCard.model_validate_json(json.dumps({"turn_no": wire.turn_no, "card": wire.model_dump(mode="json")}))
    return json.dumps(
        {"type": "coach.card", "exchange_no": exchange_no, "data": data.model_dump(mode="json")}, ensure_ascii=False
    )
