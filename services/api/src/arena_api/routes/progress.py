"""`GET /api/progress` (S5 5.5, S6 4.8; KPI-1, S3 6.1): the user's own sessions in order and their KPI-1 figures.

KPI-1 for one participant is S3 6.1's per-participant pair: `pre` and `post` are the means of the scorable
pre-test and post-test session scores (the published `debrief.v1` rubric totals; an unscorable or unpublished
session has no score and is left out), `absolute_change = post - pre`, and `relative_change = (post - pre) / pre`,
null at a zero baseline. It is null until the protocol is complete (S6 4.8): both pre-tests and both post-tests
ended (`training.v_my_study`) and every one of their debriefs published, and then also when a phase has no
scorable session (attrition, SG2-38). The client formats; it computes nothing (FE-PRG-1).
"""

from __future__ import annotations

from fractions import Fraction
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends

from arena_api.state import actor_db
from arena_core.db.arena import ArenaDb

router = APIRouter()


def _score(debrief: dict[str, Any] | None) -> int | None:
    """A published debrief's rubric total, or None when it has none (unpublished, voice, unscorable)."""
    if not debrief or not debrief.get("scored"):
        return None
    rubric = debrief.get("rubric") or {}
    total = rubric.get("total")
    return int(total) if rubric.get("scorable") and isinstance(total, int) else None


def kpi1(pre: list[int], post: list[int]) -> dict[str, float | None] | None:
    """S3 6.1, one participant: means of the scorable test sessions per phase, and their change."""
    if not pre or not post:
        return None
    pre_m, post_m = Fraction(sum(pre), len(pre)), Fraction(sum(post), len(post))
    change = post_m - pre_m
    return {
        "pre": float(pre_m),
        "post": float(post_m),
        "absolute_change": float(change),
        "relative_change": float(change / pre_m) if pre_m > 0 else None,
    }


@router.get("/api/progress")
async def progress(db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any]:
    sessions = await db.my_sessions()
    study = await db.study()
    titles: dict[UUID, str] = {c["variant_id"]: c["public_packet"].get("title", "") for c in await db.dev_cases()}
    scores: dict[str, list[int]] = {"pre": [], "post": []}
    published = {"pre": 0, "post": 0}
    rows = []
    for s in sessions:
        if s["phase"] in scores:
            debrief = await db.debrief(s["session_id"])
            published[s["phase"]] += debrief is not None
            score = _score(debrief)
            if score is not None:
                scores[s["phase"]].append(score)
        rows.append(
            {
                "session_id": str(s["session_id"]),
                "trial_id": str(s["trial_id"]),
                "phase": s["phase"],
                "mode": s["mode"],
                "voice": s["voice"],
                "status": s["status"],
                "created_at": s["created_at"].isoformat(),
                "case_title": titles.get(s["variant_id"]) or None,
            }
        )
    complete = (
        study is not None
        and len(study["pre"]) > 0
        and len(study["post"]) > 0
        and study["pre_ended"] >= len(study["pre"])
        and study["post_ended"] >= len(study["post"])
        and published["pre"] >= len(study["pre"])
        and published["post"] >= len(study["post"])
    )
    return {"sessions": rows, "kpi1": kpi1(scores["pre"], scores["post"]) if complete else None}
