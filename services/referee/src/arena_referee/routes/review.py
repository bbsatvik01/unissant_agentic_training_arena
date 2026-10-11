"""`/api/review/items`: the blinded trainer review surface (S3 7.3; SG4-09, SG4-11). Thin HTTP adapters over
`arena_referee.review`, which validates and dispatches by task kind; a `trainer` identity only, scoped to
items assigned to that rater (`arena_referee.db.get_review_item` returns null for anyone else's item)."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from arena_core.contracts.review import ReviewList
from arena_core.identity import DevIdentity
from arena_referee import review
from arena_referee.identity_dep import require_rater

router = APIRouter(prefix="/api/review")


@router.get("/items")
async def list_items(request: Request, identity: Annotated[DevIdentity, Depends(require_rater)]) -> ReviewList:
    return await review.list_items(request.app.state.connect, identity.user_id)


@router.get("/items/{item_id}")
async def get_item(
    item_id: UUID, request: Request, identity: Annotated[DevIdentity, Depends(require_rater)]
) -> dict[str, Any]:
    try:
        item = await review.get_item(request.app.state.connect, item_id, identity.user_id)
    except review.ReviewItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail="no such review item") from exc
    return item.model_dump(mode="json")


@router.post("/items/{item_id}")
async def submit_item(
    item_id: UUID,
    submission: dict[str, Any],
    request: Request,
    identity: Annotated[DevIdentity, Depends(require_rater)],
) -> dict[str, Any]:
    try:
        return dict(await review.submit_item(request.app.state.connect, item_id, identity.user_id, submission))
    except review.ReviewItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail="no such review item") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
