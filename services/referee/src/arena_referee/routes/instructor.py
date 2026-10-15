"""Instructor mode on the referee origin (UI v2, owner D-036): `GET /api/instructor/class`,
`POST /api/instructor/assignments {user_id, case_id}` and `POST /api/trials/{id}/annotations {t_ms, text}`.

An `instructor` identity only (`require_instructor`; the role comes from the users allowlist file). The class is the
allowlist's investigators; an assignment names one of them and an active development case (404 otherwise); a note
goes on a training session's trial only (404 for any other id). The trial's owner sees the notes in the trial's
recording v2 (`arena-api`, `training.v_my_annotations`).
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from arena_core.contracts.routes import AnnotationCreate, AssignmentCreate
from arena_core.identity import DevIdentity
from arena_referee import instructor
from arena_referee.identity_dep import require_instructor

router = APIRouter()
Instructor = Annotated[DevIdentity, Depends(require_instructor)]


def _class(request: Request) -> list[instructor.Trainee]:
    return instructor.trainees(request.app.state.allowlist)


@router.get("/api/instructor/class")
async def get_class(request: Request, _who: Instructor) -> dict[str, Any]:
    return {"trainees": await instructor.class_progress(request.app.state.connect, _class(request))}


@router.post("/api/instructor/assignments")
async def post_assignment(body: AssignmentCreate, request: Request, who: Instructor) -> dict[str, Any]:
    user = UUID(str(body.user_id))
    if user not in {t.user_id for t in _class(request)}:
        raise HTTPException(status_code=404, detail="not_found")
    variant = await instructor.dev_variant(request.app.state.connect, body.case_id)
    if variant is None:
        raise HTTPException(status_code=404, detail="not_found")
    made = await instructor.assign(request.app.state.connect, user, variant, who.user_id)
    return {**made, "user_id": str(user), "case_id": body.case_id}


@router.post("/api/trials/{trial_id}/annotations")
async def post_annotation(trial_id: UUID, body: AnnotationCreate, request: Request, who: Instructor) -> dict[str, Any]:
    connect = request.app.state.connect
    if not await instructor.training_trial(connect, trial_id):
        raise HTTPException(status_code=404, detail="not_found")
    return await instructor.annotate(connect, trial_id, who.user_id, body.t_ms, body.text)
