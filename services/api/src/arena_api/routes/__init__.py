"""arena-api routes (S5 5.5). Tournament and voice routes land with WP-17 and WP-22; static
serving with the hosted variant (WP-33)."""

from __future__ import annotations

from fastapi import APIRouter

from arena_api.routes import (
    cases,
    debrief,
    evidence,
    findings,
    leaderboards,
    me,
    progress,
    sessions,
    sse,
    telemetry,
    trust,
    turns,
)

router = APIRouter()
for module in (me, cases, sessions, turns, evidence, findings, sse, debrief, telemetry, leaderboards, progress, trust):
    router.include_router(module.router)

__all__ = ["router"]
