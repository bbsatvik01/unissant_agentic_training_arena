"""`POST /internal/sessions/{id}/debrief`: run R3 (or the unscored branch, D7) and publish `debrief.v1`
(S5 5.4, D8). Idempotent per session; caller-token authorized by the D10 internal policy before this runs.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from arena_referee.debrief import SessionNotEndedError, publish_session_debrief

router = APIRouter(prefix="/internal")


@router.post("/sessions/{session_id}/debrief")
async def publish_debrief_route(session_id: UUID, request: Request) -> dict[str, Any]:
    state = request.app.state
    try:
        return dict(await publish_session_debrief(state.debrief_deps, state.prompt_context, str(session_id)))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SessionNotEndedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
