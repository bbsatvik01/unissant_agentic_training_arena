"""arena-referee routes (S5 1.1). `console`, `review`, `score` and `debrief` land in WP-14; `tournament`
(block score, corpus seal, close) lands in WP-17; `admin`, `adjudicate` and `reveal` land in WP-16 and
WP-20a."""

from __future__ import annotations

from fastapi import APIRouter

from arena_referee.routes import console, debrief, review, score, tournament

router = APIRouter()
router.include_router(console.router)
router.include_router(review.router)
router.include_router(score.router)
router.include_router(debrief.router)
router.include_router(tournament.router)

__all__ = ["router"]
