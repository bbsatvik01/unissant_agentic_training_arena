"""arena-api routes (S5 5.5). Voice routes land with WP-22; static serving with the hosted variant (WP-33)."""

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
    tournaments,
    trust,
    tts,
    turns,
)

router = APIRouter()
_MODULES = (
    me,
    cases,
    sessions,
    turns,
    evidence,
    findings,
    sse,
    debrief,
    telemetry,
    leaderboards,
    progress,
    tournaments,
    trust,
    tts,
)
for module in _MODULES:
    router.include_router(module.router)

__all__ = ["router"]
