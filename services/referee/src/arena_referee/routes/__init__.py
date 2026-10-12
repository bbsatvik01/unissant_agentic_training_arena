"""arena-referee routes (S5 1.1). `console`, `review`, `score` and `debrief` land in WP-14; `admin` (the
isolation-gate runner) and `reveal` (reveal, corrections, the leaderboard they publish) land in WP-16.
`adjudicate` (the blinded validity-review surface, S3 4.2 item 2) is not WP-16's acceptance line and stays a
stub for whichever WP builds it."""

from __future__ import annotations

from fastapi import APIRouter

from arena_referee.routes import admin, console, debrief, reveal, review, score, tournaments

router = APIRouter()
router.include_router(console.router)
router.include_router(review.router)
router.include_router(score.router)
router.include_router(debrief.router)
router.include_router(admin.router)
router.include_router(reveal.router)
router.include_router(tournaments.router)

__all__ = ["router"]
