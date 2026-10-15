"""Reading one trial for the projection: snapshot, stream rows and the D-021 recording (S5 6.2; WP-13, WP-17).

`load_trial` reads the actor's own training trial through the `arena_public` views and turns its event rows
into the projection's `StoredEvent`s, joining what a frame needs beyond the payload: an evidence event's
release (the exchanges it was released after, whether it was requested or scheduled, and its date, from the
public packet's requestable list) and `trial_ended`'s terminal record. `load_tournament_trial` reads a
tournament trial the same way (D-021: "every tournament trial must be exportable"; `arena_tournament`): every
one of its turn and coaching events is `internal` visibility (S4 `_emit`), which the database's own
`arena.trial_visible` has already restricted to a dev-split or revealed-hidden trial, so the export viewer
marks them visible instead of hiding them a second time for no one (`Viewer.internal_visible`). Both read a
variant's packet through `_packet`, dev split first then the hidden split's own visibility-checked projection
(`db.hidden_packet`, `arena.v_hidden_cases`) -- never before a hidden tournament's reveal, same rule as the
trial's own content. `snapshot_of` and `recording_of` then hand everything to `events.projections`, the only
code that builds frames.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
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

RECORDING_FORMAT = "arena.recording.v2"  # UI v2 amendment: v1 plus `world_events` (D-021)
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


async def _packet(db: ArenaDb, variant: UUID) -> dict[str, Any]:
    """S4/S6 visibility: `variant`'s packet from the dev case library, else the hidden split's own
    visibility-checked projection once some trial on it is visible (reveal, SCN-12), else `{}` (an
    unexportable trial still loads with no packet; `load_recording` then answers 404, same as an unknown id,
    no existence oracle, S4 9.1). A dev variant is never found in `hidden_packet` (`arena.v_hidden_cases`
    selects only `sealed.hidden_public_packets` rows), so the `or` never masks a real dev packet."""
    return await db.public_packet(variant) or await db.hidden_packet(variant) or {}


async def load_trial(db: ArenaDb, trial: UUID) -> LoadedTrial | None:
    """The actor's own training trial, or None (another user's or an unknown trial: no existence oracle)."""
    meta = await db.trial(trial)
    if meta is None:
        return None
    packet = await _packet(db, meta["variant_id"])
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
    packet = await _packet(db, meta["variant_id"])
    rows, released = await db.all_events(trial), await db.released(trial)
    meta = await db.tournament_trial(trial) or meta
    if meta["status"] != "running" and not any(r.kind == "trial_ended" for r in rows):
        rows, released = await db.all_events(trial), await db.released(trial)
    events = stored_events(TrialMeta(trial, str(meta["kind"]), meta["execution_state"]), rows, packet, released)
    status = s6_status(str(meta["status"]), meta["execution_state"])
    ended = [e for e in events if e.kind == "trial_ended"]
    reason = ended[-1].payload.get("reason") if ended and status not in ("running", "completed") else None
    started_at = meta["started_at"]
    if started_at is not None:
        started_ms = started_at.timestamp() * 1000
    elif rows:
        # A never-started attempt (budget_skipped, source_unavailable: S4 EF-05..EF-11) has no started_at,
        # but its own stop still writes a trial_ended row; anchoring playback to Unix epoch instead of that
        # row's own time (a real bug, Codex round 1) put every offset ~56 years into the future.
        started_ms = min(r.created_at for r in rows).timestamp() * 1000
    else:
        started_ms = datetime.now(UTC).timestamp() * 1000
    return LoadedTrial(
        trial_id=trial,
        session_id=None,
        mode="harness",
        status=status,
        reason_code=None if reason is None else str(reason),
        exchanges_cap=int(meta["max_exchanges"]),
        transcript_version=int(meta["transcript_version"]),
        started_ms=started_ms,
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


def recording_of(
    trial: LoadedTrial, debrief: dict[str, Any] | None, world_events: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """D-021 `arena.recording.v2`: the public case, the opening snapshot, every frame the owner saw live with
    its time from the session start, the end-of-trial snapshot once the trial ended, and the published debrief
    when there is one -- `arena.recording.v1`'s fields unchanged -- plus (UI v2 amendment) the 3D world's own
    telemetry, `world_events` `[{t_ms, kind, data}]` on the same clock as the frames' `at_ms`, in time order (a
    stable sort, so events of one time keep the order they were posted in). The UI player
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
        # The trial's terminal state as its owner reads it after the end (S5 6.2): in assessment mode the coaching
        # withheld during the session is here, so a recording played from disk can show it (FE-DEB-4).
        # Built without the debrief_ready row, so the snapshot's last_seq stays below it and the player keeps that
        # frame (a snapshot supersedes every frame at or below its last_seq). `trial.viewer` carries a harness
        # trial's internal visibility too.
        "final_snapshot": (
            snapshot(trial.state(), [e for e in trial.events if e.kind != "debrief_ready"], trial.viewer)
            if trial.ended
            else None
        ),
        "debrief": debrief,
        "world_events": sorted(world_events or [], key=lambda e: int(e["t_ms"])),
    }


async def load_recording(db: ArenaDb, trial: UUID) -> dict[str, Any] | None:
    """`GET /api/trials/{id}/recording` (D-021) and `make export-run`'s one shared loader: the owner's own
    training trial, or else a tournament trial -- `arena.trial_visible` has already restricted which one an
    `arena_public` caller may read (a dev-split trial, or a hidden one after reveal) regardless of the acting
    identity, so the same dev identity that exports a training trial can export a visible tournament trial
    too (`scripts/export_run.py`'s own docstring). `None` when `trial` is neither (another user's training
    trial, or an unknown id) -- or when it names a hidden-split variant whose tournament has not yet revealed:
    `_packet` falls back to `db.hidden_packet` (`arena.v_hidden_cases`) only once some trial on that variant
    is `arena.trial_visible`, so a hidden trial loads with an empty packet (and so answers 404 here, below)
    until reveal, same as `v_transcripts`/`v_trial_events`/`v_findings` already gate that trial's own
    content. Answering 404 there too, the same as an unknown id, is deliberate: a crash on `_case`'s
    `packet["interview_context"]` would both 500 and -- by distinguishing that 500 from this route's 404 on
    a genuinely unknown id -- leak whether a guessed id names a real hidden trial, the existence oracle S4
    9.1 exists to deny."""
    loaded = await load_trial(db, trial)
    if loaded is None:
        loaded = await load_tournament_trial(db, trial)
    if loaded is None or not loaded.packet:
        return None
    if loaded.session_id is None:  # a tournament trial: no session, so no debrief and no world telemetry
        return recording_of(loaded, None)
    return recording_of(loaded, await db.debrief(loaded.session_id), await db.world_events(trial))
