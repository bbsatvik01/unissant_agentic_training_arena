"""`POST /internal/trials/{id}/score`: R1 then R2 on an interactive trial (S2 7.1-7.3, S5 5.3; AT-REF-1
ordering). Caller-token authorized by the D10 internal policy before this runs; this WP's scope is the
interactive track only -- a corpus or replay trial (different call shapes, S5 5.3) is WP-16/WP-17's to wire
once the tournament job exists; this route refuses them with a clear error rather than mis-scoring.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from arena_referee import db
from arena_referee.scoring import score_trial

router = APIRouter(prefix="/internal")


@router.post("/trials/{trial_id}/score")
async def score_trial_route(trial_id: UUID, request: Request) -> dict[str, object]:
    state = request.app.state
    kind = await db.fetch_trial_kind(state.connect, str(trial_id))
    if kind is None:
        raise HTTPException(status_code=404, detail=f"no trial {trial_id}")
    if kind != "interactive":
        raise HTTPException(status_code=422, detail=f"trial {trial_id} has kind {kind!r}; only interactive is scored")
    try:
        result = await score_trial(state.scoring_deps, str(trial_id), state.prompt_context)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "verdict": result.validity.verdict,
        "auto_recordable": result.validity.auto_recordable,
    }
