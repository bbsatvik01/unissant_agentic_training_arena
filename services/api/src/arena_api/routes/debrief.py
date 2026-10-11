"""`POST /api/sessions/{id}/debrief` and `GET /api/sessions/{id}/debrief` (S5 5.4).

POST runs inside the request: `arena-referee`'s internal route publishes the debrief (R3 in resumable stages,
idempotent per session) and returns it. GET reads `training.v_my_debrief`, `{"status": "scoring"}` until
published.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from arena_api.referee_client import RefereeError
from arena_api.state import ApiState, actor_db, api_state
from arena_core.db.arena import ArenaDb

router = APIRouter()
log = logging.getLogger("arena_api.debrief")


async def _own(db: ArenaDb, session_id: UUID) -> None:
    if not any(s["session_id"] == session_id for s in await db.my_sessions()):
        raise HTTPException(status_code=404, detail="not_found")


@router.post("/api/sessions/{session_id}/debrief")
async def run_debrief(
    session_id: UUID, db: Annotated[ArenaDb, Depends(actor_db)], state: Annotated[ApiState, Depends(api_state)]
) -> dict[str, Any]:
    await _own(db, session_id)
    try:
        published = await state.debrief(session_id)
    except RefereeError as exc:
        status = exc.status if exc.status in (404, 409, 503) else 502  # anything else is the referee's failure
        log.warning("a debrief failed at the referee: HTTP %d", exc.status)
        raise HTTPException(status_code=status, detail="referee_failed") from exc
    for trial in {s["trial_id"] for s in await db.my_sessions() if s["session_id"] == session_id}:
        state.signals.notify(trial)
    return published


@router.get("/api/sessions/{session_id}/debrief")
async def read_debrief(session_id: UUID, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    await _own(db, session_id)
    found = await db.debrief(session_id)
    return found if found is not None else {"status": "scoring"}
