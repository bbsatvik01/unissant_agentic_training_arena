"""`POST /api/sessions` and `GET /api/sessions/{id}` (S5 5.5; SG4-10: the phase is derived by the database).

A training session runs the configured coach and subject candidates (`ARENA_TRAINING_COACH`, default A1;
`ARENA_TRAINING_SUBJECT`, default S1), the newest registered version of each.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from arena_api.routes.cases import find_case
from arena_api.state import ApiState, actor_db, api_state, error_response, identity
from arena_core.contracts.routes import SessionCreate
from arena_core.db.arena import ArenaDb, ArenaError, SessionStart
from arena_core.identity import DevIdentity

router = APIRouter()
log = logging.getLogger("arena_api.sessions")


@router.post("/api/sessions", response_model=None)
async def start_session(
    body: SessionCreate,
    db: Annotated[ArenaDb, Depends(actor_db)],
    state: Annotated[ApiState, Depends(api_state)],
    who: Annotated[DevIdentity, Depends(identity)],
) -> dict[str, Any] | JSONResponse:
    if body.voice:
        raise HTTPException(status_code=422, detail="voice sessions are not available (WP-22)")
    case = await find_case(db, state, who, body.case_id)
    coach = await db.candidate("assistant", state.coach_name)
    subject = await db.candidate("subject", state.subject_name)
    if coach is None or subject is None:
        raise HTTPException(status_code=503, detail="the training coach or subject is not registered")
    start = SessionStart(case["variant_id"], body.mode, coach[0], subject[0], body.voice, str(body.idem_key))
    try:
        started = await db.start_session(start)
    except ArenaError as exc:
        log.info("session start refused: %s", exc.code)
        if "quota" in exc.message:
            return JSONResponse({"code": "quota"}, status_code=429)
        return error_response(exc)
    return {
        "session_id": started["session_id"],
        "trial_id": started["trial_id"],
        "phase": started["phase"],
        "mode": body.mode,
        "case_id": body.case_id,
    }


@router.get("/api/sessions/{session_id}")
async def get_session(session_id: UUID, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    for s in await db.my_sessions():
        if s["session_id"] == session_id:
            return {
                "session_id": str(s["session_id"]),
                "trial_id": str(s["trial_id"]),
                "phase": s["phase"],
                "voice": s["voice"],
                "mode": s["mode"],
                "status": s["status"],
                "exchanges": s["exchanges"],
                "created_at": s["created_at"].isoformat(),
            }
    raise HTTPException(status_code=404, detail="not_found")
