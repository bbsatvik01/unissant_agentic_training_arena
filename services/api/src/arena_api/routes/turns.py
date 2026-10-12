"""`POST /api/trials/{id}/turns` (S5 5.2), `GET /api/trials/{id}/snapshot` (S5 6.2) and
`GET /api/trials/{id}/recording` (D-021).

The turn body is validated before anything is written (a 601-character question is 422, D11). The POST
response carries `last_seq` so a client that missed frames re-reads them (S6 5.1). A trial the actor does not
own is 404 (no existence oracle).
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter

from arena_api.state import ApiState, actor_db, api_state, error_response, identity
from arena_core.contracts.routes import TurnSubmit
from arena_core.contracts.snapshot import VoiceTrialSnapshot
from arena_core.db.arena import ArenaDb
from arena_core.events.load import LoadedTrial, load_recording, load_trial, snapshot_of
from arena_core.identity import DevIdentity
from arena_core.turns.orchestrator import TurnRefusedError

router = APIRouter()
VOICE_SNAPSHOT: TypeAdapter[VoiceTrialSnapshot] = TypeAdapter(VoiceTrialSnapshot)


async def owned(db: ArenaDb, trial_id: UUID) -> LoadedTrial:
    trial = await load_trial(db, trial_id)
    if trial is None:
        raise HTTPException(status_code=404, detail="not_found")
    return trial


async def after_step(db: ArenaDb, trial_id: UUID, result: dict[str, Any]) -> dict[str, Any]:
    trial = await owned(db, trial_id)
    snap = snapshot_of(trial)
    return {**result, "version": trial.transcript_version, "last_seq": snap["last_seq"], "status": trial.status}


@router.post("/api/trials/{trial_id}/turns", response_model=None)
async def post_turn(
    trial_id: UUID,
    body: TurnSubmit,
    db: Annotated[ArenaDb, Depends(actor_db)],
    state: Annotated[ApiState, Depends(api_state)],
    who: Annotated[DevIdentity, Depends(identity)],
) -> dict[str, Any] | JSONResponse:
    if await db.trial(trial_id) is None:
        raise HTTPException(status_code=404, detail="not_found")
    try:
        result = await state.orchestrator(who.user_id).run_turn(
            trial_id, body.question, list(body.release_ids), body.expected_version, str(body.idem_key)
        )
    except TurnRefusedError as exc:
        return error_response(exc)
    return await after_step(db, trial_id, result)


@router.get("/api/trials/{trial_id}/snapshot")
async def get_snapshot(trial_id: UUID, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    snap = snapshot_of(await owned(db, trial_id))
    meta = await db.trial(trial_id)
    if meta is None or not meta["voice"]:
        return snap
    # The voice branch (S5 7.7, SG4-39): the stored exchange windows are the transcript and their count is the
    # authority for the 12 cap; no turns, cards or coach updates exist in voice.
    exchanges = await db.voice_exchanges(trial_id)
    voice = {**snap, "channel": "voice", "voice_exchanges": exchanges, "exchanges_used": len(exchanges)}
    dumped: dict[str, Any] = VOICE_SNAPSHOT.dump_python(VOICE_SNAPSHOT.validate_python(voice), mode="json")
    return dumped


@router.get("/api/trials/{trial_id}/recording")
async def get_recording(trial_id: UUID, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    """D-021: the trial's full event history as `arena.recording.v1`, through the same projection and
    visibility rules as the live stream -- the owner's own training trial, a dev-split tournament trial, or
    a hidden-split tournament trial after its tournament reveals (`arena.events.load.load_recording`, shared
    with `make export-run`); before reveal a hidden trial answers 404 here, same as an unknown id. That 404
    is deliberate, not accidental: distinguishing it from a crash would itself leak which hidden ids are
    real, the existence oracle S4 9.1 exists to deny."""
    recording = await load_recording(db, trial_id)
    if recording is None:
        raise HTTPException(status_code=404, detail="not_found")
    return recording
