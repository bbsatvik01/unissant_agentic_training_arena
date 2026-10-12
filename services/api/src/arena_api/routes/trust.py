"""`GET /api/trust/{section}` (S5 5.5, S6 4.11): the trust center, from published data only.

- `isolation`: `arena.v_isolation_checks` rows (check, candidate, pass or fail, run time, commit; never evidence).
- `commitments`: for revealed tournaments only, each trial's commitment, its transcript and evidence hashes, the
  payload text and the revealed nonce, so the browser can recompute the commitment (FE-TRUST-1).
- `fairness`: the S3 8 audit published with the newest revealed assistant board (FA-1 to FA-6, per candidate
  and track); before any reveal, empty lists and `published: false`.
- `methodology`: calibration results are referee-only rows; `calibration` is empty until they are published.
- `budget`: the applied `global` ceiling, settled spend and open holds, spend by purpose label, and the planned
  case count. A ceiling of $0 means the budget plan is not applied (FE-TRUST-4); the client computes nothing.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends

from arena_api.state import ApiState, actor_db, api_state
from arena_core.db.arena import ArenaDb

router = APIRouter()
Section = Literal["isolation", "commitments", "fairness", "methodology", "budget"]


@router.get("/api/trust/{section}")
async def trust(
    section: Section, db: Annotated[ArenaDb, Depends(actor_db)], state: Annotated[ApiState, Depends(api_state)]
) -> dict[str, Any]:
    if section == "isolation":
        return {"checks": await db.isolation_checks()}
    if section == "commitments":
        return {"commitments": await db.revealed_commitments()}
    if section == "fairness":
        published = await db.fairness()
        if published is not None:
            return published
        return {
            "published": False,
            "style_fpr": [],
            "flag_rates": [],
            "demeanor": [],
            "tests": [],
            "negative_controls": [],
        }
    if section == "methodology":
        return {"calibration": []}
    return {**await db.budget_view(), "planned_n": state.planned_n}
