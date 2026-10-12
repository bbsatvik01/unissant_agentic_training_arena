"""`GET /api/tournaments` (S6 4.9), `GET /api/tournaments/{id}` and `GET /api/tournaments/{id}/events?after=`
(S5 6.2; S6 4.9, 5.3; D9). The investigator's own read of the arena: the tournament list with the global
ceiling's reserved and settled spend next to it (S6 4.9's own wording; `ops.v_budget_status` through
`ArenaDb.budget_view`, D-013), a tournament's lifecycle state and progress counts, and the poll on the global
ledger cursor that a hidden tournament answers with counts only until it is revealed (D9).
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from arena_api.state import actor_db
from arena_core.db.arena import ArenaDb

router = APIRouter()


@router.get("/api/tournaments")
async def list_tournaments(db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    return {"tournaments": await db.tournaments(), "budget": await db.budget_view()}


@router.get("/api/tournaments/{tournament_id}")
async def get_tournament(tournament_id: UUID, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    status = await db.tournament_status(tournament_id)
    if status is None:
        raise HTTPException(status_code=404, detail="not_found")
    return {"status": status, "progress": await db.tournament_progress(tournament_id)}


@router.get("/api/tournaments/{tournament_id}/events")
async def tournament_events(
    tournament_id: UUID,
    db: Annotated[ArenaDb, Depends(actor_db)],
    after: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, Any]:
    status = await db.tournament_status(tournament_id)
    if status is None:
        raise HTTPException(status_code=404, detail="not_found")
    split = await db.tournament_split(tournament_id)
    if split == "hidden" and status != "revealed":
        # D9: a hidden tournament before reveal answers counts only -- no trial id, text, card or flag count.
        return {"visibility": "counts", "progress": await db.tournament_progress(tournament_id)}
    frames, last = await db.tournament_events(tournament_id, after)
    return {"visibility": "events", "frames": frames, "last": last}
