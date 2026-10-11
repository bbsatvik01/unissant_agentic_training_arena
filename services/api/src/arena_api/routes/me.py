"""`GET /api/me`, `POST /api/me/ack-ex4`, `GET /api/config` (S5 5.5; D10 CSRF cookie on `/api/me`, 10.3)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response

from arena_api.state import QUESTION_MAX_CHARS, actor_db, identity
from arena_core.db.arena import ArenaDb
from arena_core.http_guard import CSRF_COOKIE, new_csrf_token
from arena_core.identity import DevIdentity

router = APIRouter()
PRACTICE_BEFORE_POST = 3  # S3 6.1: three practice sessions before the post-tests


def _study(study: dict[str, Any] | None) -> dict[str, Any] | None:
    if study is None:
        return None
    pre_needed, post_needed = len(study["pre"]), len(study["post"])
    if study["pre_ended"] < pre_needed:
        nxt = "pre"
    elif study["practice_ended"] < PRACTICE_BEFORE_POST:
        nxt = "practice"
    elif study["post_ended"] < post_needed:
        nxt = "post"
    else:
        nxt = "done"
    return {
        "counterbalance": study["counterbalance"],
        "ended": {"pre": study["pre_ended"], "practice": study["practice_ended"], "post": study["post_ended"]},
        "next_phase": nxt,
    }


@router.get("/api/me")
async def get_me(
    response: Response,
    who: Annotated[DevIdentity, Depends(identity)],
    db: Annotated[ArenaDb, Depends(actor_db)],
) -> dict[str, Any]:
    token = new_csrf_token()
    response.set_cookie(CSRF_COOKIE, token, httponly=True, samesite="strict", path="/")
    acks = await db.acknowledgements()
    config = await db.public_config()
    ex4 = acks.get("ex4")
    return {
        "user_id": str(who.user_id),
        "display_name": who.display_name,
        "roles": sorted(who.roles),
        "quotas": {"text_sessions_per_day": config["text_sessions_per_user_day"]},
        "ex4_acknowledged": None if ex4 is None else ex4.isoformat(),
        "study": _study(await db.study()),
        "csrf_token": token,
    }


@router.post("/api/me/ack-ex4")
async def ack_ex4(db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, str]:
    return {"ex4_acknowledged": (await db.acknowledge("ex4")).isoformat()}


@router.get("/api/config")
async def get_config(request: Request, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    config = await db.public_config()
    return {
        "voice_available": False,
        "exhibition_enabled": False,
        "phoenix_url": request.app.state.phoenix_url,
        "question_max_chars": QUESTION_MAX_CHARS,
        "paused": config["paused"],
        "quotas": {
            "text_sessions_per_day": config["text_sessions_per_user_day"],
            "voice_sessions_per_day": config["voice_sessions_per_user_day"],
        },
        "planned_n": None,
    }
