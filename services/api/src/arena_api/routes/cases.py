"""`GET /api/cases` and `GET /api/cases/{id}` (S5 5.5; C-37 one variant per family, X-08 KPI-1 case sets).

Everyone outside a pending KPI-1 test gets one development variant per family by the seeded draw
`variants_of(family)[int(sha256(f"{user_id}:{family}:{seed}")) mod n]`, variants sorted by id, over active
families without a case-set member; a sibling variant is never offered. A participant whose next phase is a
test gets that set's untested variants instead. A case that is not listed is 404 everywhere.
"""

from __future__ import annotations

import hashlib
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from arena_api.routes.me import _study
from arena_api.state import ApiState, actor_db, api_state, identity
from arena_core.db.arena import ArenaDb
from arena_core.identity import DevIdentity

router = APIRouter()


def draw(cases: list[dict[str, Any]], user_id: UUID, seed: str) -> list[dict[str, Any]]:
    """C-37: one variant per practice family for this user."""
    families: dict[str, list[dict[str, Any]]] = {}
    for case in cases:
        if not case["kpi1_set"]:
            families.setdefault(case["family_code"], []).append(case)
    out = []
    for family in sorted(families):
        variants = sorted(families[family], key=lambda c: str(c["variant_id"]))
        digest = hashlib.sha256(f"{user_id}:{family}:{seed}".encode()).hexdigest()
        out.append(variants[int(digest, 16) % len(variants)])
    return out


def assigned(
    cases: list[dict[str, Any]], study: dict[str, Any] | None, user_id: UUID, seed: str
) -> list[dict[str, Any]]:
    status = _study(study)
    if study is not None and status is not None and status["next_phase"] in ("pre", "post"):
        wanted = {str(v) for v in study[status["next_phase"]]} - {str(v) for v in study["tested"]}
        return [c for c in cases if str(c["variant_id"]) in wanted]
    return draw(cases, user_id, seed)


def card(case: dict[str, Any]) -> dict[str, Any]:
    """The case card (public packet fields only; never a role, style or family code)."""
    p = case["public_packet"]
    subject = p["interview_context"]["subject"]
    return {
        "case_id": p["case_id"],
        "title": p["title"],
        "objective": p["investigation_objective"],
        "domain": p["domain"],
        "difficulty_level": p["difficulty_level"],
        "subject": {"display_name": subject["name"], "position": subject["position"]},
        "facility": p["interview_context"]["facility"],
        "initial_documents": len(p["initial_documents"]),
        "requestable_records": len(p["requestable_records"]),
    }


async def assigned_cases(db: ArenaDb, state: ApiState, who: DevIdentity) -> list[dict[str, Any]]:
    return assigned(await db.dev_cases(), await db.study(), who.user_id, state.case_draw_seed)


async def find_case(db: ArenaDb, state: ApiState, who: DevIdentity, case_id: str) -> dict[str, Any]:
    for case in await assigned_cases(db, state, who):
        if case["public_packet"]["case_id"] == case_id:
            return case
    raise HTTPException(status_code=404, detail="not_found")


@router.get("/api/cases")
async def list_cases(
    db: Annotated[ArenaDb, Depends(actor_db)],
    state: Annotated[ApiState, Depends(api_state)],
    who: Annotated[DevIdentity, Depends(identity)],
) -> dict[str, Any]:
    return {"cases": [card(c) for c in await assigned_cases(db, state, who)]}


@router.get("/api/cases/{case_id}")
async def get_case(
    case_id: str,
    db: Annotated[ArenaDb, Depends(actor_db)],
    state: Annotated[ApiState, Depends(api_state)],
    who: Annotated[DevIdentity, Depends(identity)],
) -> dict[str, Any]:
    case = await find_case(db, state, who, case_id)
    return {"case": card(case), "brief": case["public_packet"]}
