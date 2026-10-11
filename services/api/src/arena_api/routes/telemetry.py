"""`POST /api/telemetry/kpi4` (S5 8.7; C-28) and `POST /api/telemetry/contract-violation` (S6 5.4: a log line,
never state)."""

from __future__ import annotations

import logging
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from arena_api.state import actor_db, error_response
from arena_core.contracts.routes import CardAck
from arena_core.db.arena import ArenaDb, ArenaError

router = APIRouter()
log = logging.getLogger("arena_api.telemetry")
MAX_REPORT_BYTES = 2048


@router.post("/api/telemetry/kpi4", response_model=None)
async def ack_card(body: CardAck, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any] | JSONResponse:
    try:
        stamped = await db.ack_card(UUID(body.trial_id), body.turn_no, body.client_valid)
    except ArenaError as exc:
        return error_response(exc)
    return {"recorded": stamped}


@router.post("/api/telemetry/contract-violation", status_code=204)
async def contract_violation(request: Request) -> None:
    body = (await request.body())[:MAX_REPORT_BYTES]
    log.warning("client projection check failed: %r", body.decode("utf-8", errors="replace"))
