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

from arena_api.state import ApiState, actor_db, api_state, error_response, identity
from arena_core.contracts.routes import TurnSubmit
from arena_core.db.arena import ArenaDb
from arena_core.events.load import LoadedTrial, load_recording, load_trial, snapshot_of
from arena_core.identity import DevIdentity
from arena_core.turns.orchestrator import TurnRefusedError

router = APIRouter()


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
    return snapshot_of(await owned(db, trial_id))


@router.get("/api/trials/{trial_id}/recording")
async def get_recording(trial_id: UUID, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    """D-021: the trial's full event history as `arena.recording.v1`, through the same projection and
    visibility rules as the live stream -- the owner's own training trial, or a visible tournament trial
    (`arena.events.load.load_recording`, shared with `make export-run`, no existence oracle beyond what
    `arena.trial_visible` already grants an `arena_public` caller, S4 9.1)."""
    recording = await load_recording(db, trial_id)
    if recording is None:
        raise HTTPException(status_code=404, detail="not_found")
    return recording
