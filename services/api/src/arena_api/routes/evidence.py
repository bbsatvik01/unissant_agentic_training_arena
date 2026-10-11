"""`POST /api/trials/{id}/evidence-requests` (S5 5.4; C-18, SG1-15, SG1-32): a release between turns."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from arena_api.state import ApiState, actor_db, api_state, error_response, identity
from arena_core.contracts.routes import EvidenceRequest, EvidenceResult
from arena_core.db.arena import ArenaDb
from arena_core.identity import DevIdentity
from arena_core.turns.orchestrator import TurnRefusedError

router = APIRouter()


@router.post("/api/trials/{trial_id}/evidence-requests", response_model=None)
async def request_evidence(
    trial_id: UUID,
    body: EvidenceRequest,
    db: Annotated[ArenaDb, Depends(actor_db)],
    state: Annotated[ApiState, Depends(api_state)],
    who: Annotated[DevIdentity, Depends(identity)],
) -> dict[str, Any] | JSONResponse:
    if await db.trial(trial_id) is None:
        raise HTTPException(status_code=404, detail="not_found")
    try:
        result = await state.orchestrator(who.user_id).request_evidence(
            trial_id, list(body.record_ids), str(body.idem_key)
        )
    except TurnRefusedError as exc:
        return error_response(exc)
    return EvidenceResult.model_validate(result).model_dump(mode="json")
