"""`GET /api/leaderboards/{tournament_id}?board=assistant|subject[&label=original|corrected]` (S5 5.5, S6 4.10).

The published board body is passed through unchanged (WP-16's `arena_core.referee.leaderboard` output, read by the
UI's `parseBoard`); the client computes nothing. Boards exist only after reveal (S4 binds every leaderboard row to
the tournament's revealed manifest), and this route answers 409 `not_revealed` before it, so nothing about an
unrevealed tournament's results leaves the server; its progress counts are the tournament routes' (S5 6.2).
Without `label`, the board bound to the latest manifest is served (a corrected board supersedes the original);
`X-Arena-Board-Label` and `X-Arena-Manifest-Version` name which one it is.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from arena_api.state import actor_db
from arena_core.db.arena import ArenaDb

router = APIRouter()


@router.get("/api/leaderboards/{tournament_id}")
async def get_leaderboard(
    tournament_id: UUID,
    db: Annotated[ArenaDb, Depends(actor_db)],
    board: Annotated[Literal["assistant", "subject"], Query()],
    label: Annotated[Literal["original", "corrected"] | None, Query()] = None,
) -> JSONResponse:
    status = await db.tournament_status(tournament_id)
    if status is None:
        return JSONResponse({"code": "not_found"}, status_code=404)
    if status != "revealed":
        return JSONResponse({"code": "not_revealed", "status": status}, status_code=409)
    found = await db.leaderboard(tournament_id, board, label)
    if found is None:
        return JSONResponse({"code": "not_published"}, status_code=404)
    headers = {"X-Arena-Board-Label": found["label"], "X-Arena-Manifest-Version": str(found["manifest_version"])}
    return JSONResponse(found["body"], headers=headers)
