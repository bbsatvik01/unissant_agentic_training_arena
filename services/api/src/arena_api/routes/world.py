"""`POST /api/trials/{id}/world-events` (UI v2; recording v2, D-021 amendment): one batch of the 3D world's own
telemetry (poses, camera, inputs, panels), so a recording replays the world exactly as the investigator saw it.

The body is at most 64 KB as sent (413 above it, before it is parsed) and is checked against `WorldEventBatch`
(422). Only the trial's owner may post, the same visibility as the trial (404 otherwise, no existence oracle).
Batches are stored append-only by `training.record_world_events`; the answer names the stored batch.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from arena_api.state import actor_db, error_response
from arena_core.contracts.routes import WORLD_BATCH_MAX_BYTES, WorldEventBatch
from arena_core.db.arena import ArenaDb, ArenaError

router = APIRouter()


@router.post("/api/trials/{trial_id}/world-events", response_model=None)
async def post_world_events(
    trial_id: UUID, request: Request, db: Annotated[ArenaDb, Depends(actor_db)]
) -> dict[str, Any] | JSONResponse:
    if await db.trial(trial_id) is None:
        raise HTTPException(status_code=404, detail="not_found")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > WORLD_BATCH_MAX_BYTES:  # stop reading at the limit: an oversized body is never buffered
            return JSONResponse({"code": "batch_too_large"}, status_code=413)
    try:
        batch = WorldEventBatch.model_validate_json(bytes(body))
    except ValidationError:
        return JSONResponse({"code": "invalid_request"}, status_code=422)
    try:
        batch_no = await db.record_world_events(trial_id, [e.model_dump(mode="json") for e in batch.events])
    except ArenaError as exc:
        return error_response(exc)
    return {"batch_no": batch_no, "accepted": len(batch.events)}
