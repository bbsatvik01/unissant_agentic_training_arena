"""Reading one trial for the projection: snapshot, stream rows and the D-021 recording (S5 6.2; WP-13).

`load_trial` reads the actor's own trial through the `arena_public` views and turns its event rows into the
projection's `StoredEvent`s, joining what a frame needs beyond the payload: an evidence event's release (the
exchanges it was released after, whether it was requested or scheduled, and its date, from the public packet's
requestable list) and `trial_ended`'s terminal record. `snapshot_of` and `recording_of` then hand everything to
`events.projections`, the only code that builds frames.
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
Mode = Literal["practice", "assessment"]


@dataclass(frozen=True)
class LoadedTrial:
    trial_id: UUID
    session_id: UUID
    mode: Mode
    status: str  # S6 status (C-45)
    reason_code: str | None
    exchanges_cap: int
    transcript_version: int
    started_ms: float
    packet: dict[str, Any]
    events: list[StoredEvent]

    @property
    def ended(self) -> bool:
        return self.status != "running"

    @property
    def viewer(self) -> Viewer:
        return Viewer(trial_ended=self.ended, mode=self.mode)

    def state(self, *, opening: bool = False) -> TrialState:
        return TrialState(
            trial_id=str(self.trial_id),
            status="running" if opening else self.status,
            reason_code=None if opening else self.reason_code,
            mode=self.mode,
            exchanges_cap=self.exchanges_cap,
            public_packet=self.packet,
        )


def stored_events(
    trial: UUID,
    rows: list[EventRow],
    packet: dict[str, Any],
    released: list[dict[str, Any]],
    execution_state: str | None,
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
                trial_id=str(trial),
                trial_kind="training",
                seq=row.seq,
                kind=row.kind,
                visibility=cast("Literal['live', 'debrief', 'internal']", row.visibility),
                transcript_version=row.transcript_version,
                turn_no=row.turn_no or None,
                payload=row.payload,
                created_at=iso(row.created_at),
                release=release,
                terminal_state=execution_state if row.kind == "trial_ended" else None,
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
    events = stored_events(trial, rows, packet, released, meta["execution_state"])
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
    its time from the session start, the end-of-trial snapshot once the trial ended, and the published debrief
    when there is one. The UI player
    (`web/src/lib/world/recording.ts`) reads exactly this shape."""
    return {
        "format": RECORDING_FORMAT,
        "trial_id": str(trial.trial_id),
        "case": _case(trial.packet),
        "snapshot": snapshot(trial.state(opening=True), [], Viewer(trial_ended=False, mode=trial.mode)),
        "events": recording_events(trial.events, trial.mode, trial.started_ms),
        # The trial's terminal state as its owner reads it after the end (S5 6.2): in assessment mode the coaching
        # withheld during the session is here, so a recording played from disk can show it (FE-DEB-4).
        "final_snapshot": snapshot_of(trial) if trial.ended else None,
        "debrief": debrief,
    }
