"""Reading one trial for the projection: snapshot, stream rows and the D-021 recording (S5 6.2; WP-13, WP-17).

`load_trial` reads the actor's own training trial through the `arena_public` views and turns its event rows
into the projection's `StoredEvent`s, joining what a frame needs beyond the payload: an evidence event's
release (the exchanges it was released after, whether it was requested or scheduled, and its date, from the
public packet's requestable list) and `trial_ended`'s terminal record. `load_tournament_trial` reads a
tournament trial the same way (D-021: "every tournament trial must be exportable"; `arena_tournament`): every
one of its turn and coaching events is `internal` visibility (S4 `_emit`), which the database's own
`arena.trial_visible` has already restricted to a dev-split or revealed-hidden trial, so the export viewer
marks them visible instead of hiding them a second time for no one (`Viewer.internal_visible`). `snapshot_of`
and `recording_of` then hand everything to `events.projections`, the only code that builds frames.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, cast
from uuid import UUID

from arena_core.db.arena import ArenaDb, EventRow, iso
from arena_core.events.projections import (
    Release,
    StoredEvent,
    TrialState,
    Viewer,
    recording_events,
    s6_status,
    snapshot,
)

RECORDING_FORMAT = "arena.recording.v1"
Mode = Literal["practice", "assessment", "harness"]
TOURNAMENT_KINDS = frozenset({"interactive", "replay", "replay_corpus"})


@dataclass(frozen=True)
class LoadedTrial:
    trial_id: UUID
    session_id: UUID | None  # None: a tournament trial (no training session, D-021)
    mode: Mode
    status: str  # S6 status (C-45)
    reason_code: str | None
    exchanges_cap: int
    transcript_version: int
    started_ms: float
    packet: dict[str, Any]
    events: list[StoredEvent]
    internal_visible: bool = False

    @property
    def ended(self) -> bool:
        return self.status != "running"

    @property
    def viewer(self) -> Viewer:
        return Viewer(trial_ended=self.ended, mode=self.mode, internal_visible=self.internal_visible)

    def state(self, *, opening: bool = False) -> TrialState:
        return TrialState(
            trial_id=str(self.trial_id),
            status="running" if opening else self.status,
            reason_code=None if opening else self.reason_code,
            mode=self.mode,
            exchanges_cap=self.exchanges_cap,
            public_packet=self.packet,
        )


@dataclass(frozen=True)
class TrialMeta:
    """The trial-level facts `stored_events` folds into every row, bundled under the arg-count lint."""

    trial_id: UUID
    kind: str  # "training", or a tournament trial's own kind (interactive, replay, replay_corpus)
    execution_state: str | None


def stored_events(
    meta: TrialMeta, rows: list[EventRow], packet: dict[str, Any], released: list[dict[str, Any]]
) -> list[StoredEvent]:
    requestable = {r["record_id"]: r for r in packet.get("requestable_records", [])}
    after = {r["record_id"]: int(r["released_after_exchanges"]) for r in released}
    out: list[StoredEvent] = []
    for row in rows:
        release = None
        if row.kind in ("evidence_released", "clarification"):
            record = str(row.payload["record_id"])
            asked = requestable.get(record)
            release = Release(
                released_after_exchanges=after.get(record, 0),
                trigger="requested" if asked is not None else "scheduled",
                date=None if asked is None else asked.get("date"),
            )
        out.append(
            StoredEvent(
                trial_id=str(meta.trial_id),
                trial_kind=meta.kind,
                seq=row.seq,
                kind=row.kind,
                visibility=cast("Literal['live', 'debrief', 'internal']", row.visibility),
                transcript_version=row.transcript_version,
                turn_no=row.turn_no or None,
                payload=row.payload,
                created_at=iso(row.created_at),
                release=release,
                terminal_state=meta.execution_state if row.kind == "trial_ended" else None,
            )
        )
    return out


async def load_trial(db: ArenaDb, trial: UUID) -> LoadedTrial | None:
    """The actor's own training trial, or None (another user's or an unknown trial: no existence oracle)."""
    meta = await db.trial(trial)
    if meta is None:
        return None
    packet = await db.public_packet(meta["variant_id"]) or {}
    rows, released = await db.all_events(trial), await db.released(trial)
    # Read the trial again after its events: a terminal record commits with its trial_ended event, so this read
    # is at least as new as every row above (the trial cannot end between the reads unnoticed).
    meta = await db.trial(trial) or meta
    if meta["status"] != "running" and not any(r.kind == "trial_ended" for r in rows):
        # The trial ended between the reads: read its rows again, now that the end has committed.
        rows, released = await db.all_events(trial), await db.released(trial)
    events = stored_events(TrialMeta(trial, "training", meta["execution_state"]), rows, packet, released)
    status = s6_status(str(meta["status"]), meta["execution_state"])
    ended = [e for e in events if e.kind == "trial_ended"]
    reason = ended[-1].payload.get("reason") if ended and status not in ("running", "completed") else None
    return LoadedTrial(
        trial_id=trial,
        session_id=meta["session_id"],
        mode=cast("Mode", meta["mode"]),
        status=status,
        reason_code=None if reason is None else str(reason),
        exchanges_cap=int(meta["max_exchanges"]),
        transcript_version=int(meta["transcript_version"]),
        started_ms=meta["started_at"].timestamp() * 1000,
        packet=packet,
        events=events,
    )


async def load_tournament_trial(db: ArenaDb, trial: UUID) -> LoadedTrial | None:
    """A tournament trial (interactive, replay or replay_corpus), for the D-021 recording export
    (`arena_tournament`'s job holds no session; a harness-driven trial has none). None for an unknown trial,
    or a training one (`load_trial` owns those): no existence oracle beyond what `arena.v_trials` already
    shows an `arena_public` caller (S4 9.1)."""
    meta = await db.tournament_trial(trial)
    if meta is None or meta["kind"] not in TOURNAMENT_KINDS:
        return None
    packet = await db.public_packet(meta["variant_id"]) or {}
    rows, released = await db.all_events(trial), await db.released(trial)
    meta = await db.tournament_trial(trial) or meta
    if meta["status"] != "running" and not any(r.kind == "trial_ended" for r in rows):
        rows, released = await db.all_events(trial), await db.released(trial)
    events = stored_events(TrialMeta(trial, str(meta["kind"]), meta["execution_state"]), rows, packet, released)
    status = s6_status(str(meta["status"]), meta["execution_state"])
    ended = [e for e in events if e.kind == "trial_ended"]
    reason = ended[-1].payload.get("reason") if ended and status not in ("running", "completed") else None
    started_at = meta["started_at"]
    return LoadedTrial(
        trial_id=trial,
        session_id=None,
        mode="harness",
        status=status,
        reason_code=None if reason is None else str(reason),
        exchanges_cap=int(meta["max_exchanges"]),
        transcript_version=int(meta["transcript_version"]),
        started_ms=started_at.timestamp() * 1000 if started_at is not None else 0.0,
        packet=packet,
        events=events,
        internal_visible=True,
    )


def snapshot_of(trial: LoadedTrial) -> dict[str, Any]:
    return snapshot(trial.state(), trial.events, trial.viewer)


def _case(packet: dict[str, Any]) -> dict[str, Any]:
    """The recording's public case block (the UI player's `RecordingCase`): never a role, style or family id."""
    ctx = packet["interview_context"]
    return {
        "case_id": packet["case_id"],
        "title": packet["title"],
        "objective": packet["investigation_objective"],
        "domain": packet["domain"],
        "difficulty_level": packet["difficulty_level"],
        "subject": {"display_name": ctx["subject"]["name"], "position": ctx["subject"]["position"]},
        "setting": ctx["setting"],
        "initial_documents": [
            {"doc_id": d["doc_id"], "kind": d["kind"], "title": d["title"], "content": d["content"]}
            for d in packet["initial_documents"]
        ],
    }


def recording_of(trial: LoadedTrial, debrief: dict[str, Any] | None) -> dict[str, Any]:
    """D-021 `arena.recording.v1`: the public case, the opening snapshot, every frame the owner saw live with
    its time from the session start, and the published debrief when there is one. The UI player
    (`web/src/lib/world/recording.ts`) reads exactly this shape."""
    return {
        "format": RECORDING_FORMAT,
        "trial_id": str(trial.trial_id),
        "case": _case(trial.packet),
        "snapshot": snapshot(
            trial.state(opening=True),
            [],
            Viewer(trial_ended=False, mode=trial.mode, internal_visible=trial.internal_visible),
        ),
        "events": recording_events(trial.events, trial.mode, trial.started_ms, internal_visible=trial.internal_visible),
        "debrief": debrief,
    }
