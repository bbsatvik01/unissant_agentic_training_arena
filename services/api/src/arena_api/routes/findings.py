"""`POST /api/trials/{id}/finding` (S5 5.4; C-27, D5, SG3-17): the investigator's commit. The body is the one
`Finding` object (any other field is 422); citations are checked by `finalize_trial` (422 when a cited turn is
not an answered, non-partial turn or a cited record is not an initial document or released record)."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from arena_api.routes.turns import after_step
from arena_api.state import ApiState, actor_db, api_state, error_response, identity
from arena_core.contracts.routes import FindingCommit
from arena_core.db.arena import ArenaDb
from arena_core.identity import DevIdentity
from arena_core.turns.orchestrator import TurnRefusedError

router = APIRouter()


@router.post("/api/trials/{trial_id}/finding", response_model=None)
async def commit_finding(
    trial_id: UUID,
    body: FindingCommit,
    db: Annotated[ArenaDb, Depends(actor_db)],
    state: Annotated[ApiState, Depends(api_state)],
    who: Annotated[DevIdentity, Depends(identity)],
) -> dict[str, Any] | JSONResponse:
    if await db.trial(trial_id) is None:
        raise HTTPException(status_code=404, detail="not_found")
    finding = body.finding.stored().model_dump(mode="json")
    try:
        result = await state.orchestrator(who.user_id).commit_finding(trial_id, finding, str(body.idem_key))
    except TurnRefusedError as exc:
        return error_response(exc)
    return await after_step(db, trial_id, {"commitment_hash": result["commitment_sha256"]})
