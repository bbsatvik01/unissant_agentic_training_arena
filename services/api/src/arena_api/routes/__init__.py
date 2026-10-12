"""arena-api routes (S5 5.5). Tournament, trust-center and voice routes land with WP-17, WP-20b and WP-22; static
serving with the hosted variant (WP-33)."""

from __future__ import annotations

from fastapi import APIRouter

from arena_api.routes import cases, debrief, evidence, findings, leaderboards, me, sessions, sse, telemetry, tts, turns

router = APIRouter()
for module in (me, cases, sessions, turns, evidence, findings, sse, debrief, telemetry, leaderboards, tts):
    router.include_router(module.router)

__all__ = ["router"]
