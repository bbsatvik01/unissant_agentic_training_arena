"""Coach Lab (D-036): read-only views of the Coach Gym registry for the UI.

- `GET /api/coach-lab/versions`: every coach version (the official coaches and the gym's challengers and
  promotions) with its status (champion, challenger, retired), parent, holdout metrics and promotion verdict.
- `GET /api/coach-lab/versions/{id}/lessons`: the playbook lessons rendered into that version, with each lesson's
  review status today; 404 for an unknown version.
- `GET /api/coach-lab/experiments`: every gym run, newest first, with the champion's and the challenger's holdout
  metrics (before and after) and GEPA's validation-score series.

The data is the committed `coachlab/` registry (dev-split runs only; no hidden case, no reference-only string),
read from the repository root `ApiState.coachlab_root`. Nothing here writes or calls a model.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException

from arena_api.state import ApiState, api_state
from arena_core.coachgym import registry

router = APIRouter()


@router.get("/api/coach-lab/versions")
async def versions(state: Annotated[ApiState, Depends(api_state)]) -> dict[str, Any]:
    return {"versions": registry.versions_view(state.coachlab_root)}


@router.get("/api/coach-lab/versions/{version_id}/lessons")
async def version_lessons(version_id: str, state: Annotated[ApiState, Depends(api_state)]) -> dict[str, Any]:
    found = registry.lessons_view(state.coachlab_root, version_id)
    if found is None:
        raise HTTPException(status_code=404, detail="unknown_version")
    return found


@router.get("/api/coach-lab/experiments")
async def experiments(state: Annotated[ApiState, Depends(api_state)]) -> dict[str, Any]:
    return {"experiments": registry.experiments_view(state.coachlab_root)}
