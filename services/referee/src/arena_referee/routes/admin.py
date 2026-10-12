"""`/api/admin/isolation-gate` (S3 9; WP-16): `GET` reads the latest result for the running code version;
`POST /run` runs it fresh. An `admin` identity only -- WP-20a's admin console calls these; this route is
their backend. IG-4, IG-5 and IG-6's evidence is computed server-side from the database and the referee's
own filesystem (never from the request body, L6, L7); the body carries only what this process cannot see
for itself: IG-1, IG-2 and IG-3's own already-run report evidence.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from arena_core.identity import DevIdentity
from arena_core.scoring.ranking import IsolationResult
from arena_referee import admin_db, db
from arena_referee.identity_dep import require_admin_role
from arena_referee.isolation import IsolationGateRequest, run_isolation_gate

router = APIRouter(prefix="/api/admin")


def _git_sha(request: Request) -> str:
    sha: str | None = getattr(request.app.state, "git_sha", None)
    if not sha:
        msg = "the referee app was not configured with ARENA_GIT_SHA"
        raise RuntimeError(msg)
    return sha


def _result_json(result: IsolationResult) -> dict[str, object]:
    return {
        "passed": result.passed,
        "evidence_hash": result.evidence_hash,
        "items": {k: v[0] for k, v in result.items.items()},
    }


@router.get("/isolation-gate")
async def get_isolation_gate(
    request: Request, _identity: Annotated[DevIdentity, Depends(require_admin_role)]
) -> dict[str, object]:
    result = await db.fetch_isolation_result(request.app.state.connect, _git_sha(request))
    return _result_json(result)


def _as_report(body: dict[str, Any], key: str) -> tuple[bool, str]:
    """`bool("false")` is `True`: a JSON string would silently flip a failing suite to passing. `passed`
    must already be a JSON boolean."""
    item = body[key]
    passed = item["passed"]
    if not isinstance(passed, bool):
        msg = f"{key}.passed must be a boolean, not {type(passed).__name__}"
        raise TypeError(msg)
    return passed, str(item["report_text"])


def isolation_gate_request(body: dict[str, Any], git_sha: str) -> IsolationGateRequest:
    """`body`: `{"ig1": {"passed": bool, "report_text": "..."}, "ig2": {...}, "ig3": {...}}`. IG-4, IG-5 and
    IG-6 need nothing from the caller. Shared with `routes.reveal`'s gated open route, so the two never
    drift on how a report is parsed."""
    return IsolationGateRequest(
        git_sha=git_sha, ig1=_as_report(body, "ig1"), ig2=_as_report(body, "ig2"), ig3=_as_report(body, "ig3")
    )


@router.post("/isolation-gate/run")
async def run_isolation_gate_route(
    body: dict[str, Any], request: Request, _identity: Annotated[DevIdentity, Depends(require_admin_role)]
) -> dict[str, object]:
    try:
        request_obj = isolation_gate_request(body, _git_sha(request))
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result = await run_isolation_gate(request.app.state.connect, request_obj)
    return _result_json(result)


# ------------------------------------------------------------------ console reads and the validity review (S5 5.5)


@router.get("/budget")
async def get_budget(
    request: Request, _identity: Annotated[DevIdentity, Depends(require_admin_role)]
) -> dict[str, object]:
    """`ops.budget_status()` per bucket (ceiling, liability, open holds, headroom, kill switch). Read-only: the
    owner changes ceilings and the kill switch with the owner credential (S5 4.4, 4.8)."""
    return {"buckets": await admin_db.budget(request.app.state.connect)}


@router.get("/reviews")
async def get_reviews(
    request: Request, _identity: Annotated[DevIdentity, Depends(require_admin_role)]
) -> dict[str, object]:
    """S3 4.2 item 2's blinded queue: proposed `subject_invalid` verdicts awaiting a human (AC-S3-4.4)."""
    return {"reviews": await admin_db.pending_reviews(request.app.state.connect)}


class VerdictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: Literal["valid", "subject_invalid"]
    reason: str = Field(min_length=1, max_length=500)
    evidence_ref: str = Field(min_length=1, max_length=200)
    idem_key: str = Field(min_length=8, max_length=200)


@router.post("/reviews/{trial_id}")
async def post_verdict(
    trial_id: UUID,
    body: VerdictBody,
    request: Request,
    identity: Annotated[DevIdentity, Depends(require_admin_role)],
) -> dict[str, object]:
    """`ledger.adjudicate_validity` with the reviewer's id as `decided_by` (C-33); idempotent on `idem_key`."""
    verdict = admin_db.Verdict(
        trial_id=trial_id,
        verdict=body.verdict,
        reason=body.reason,
        evidence_ref=body.evidence_ref,
        decided_by=str(identity.user_id),
        idempotency_key=body.idem_key,
    )
    try:
        adjudication = await admin_db.adjudicate(request.app.state.connect, verdict)
    except psycopg.Error as exc:
        raise HTTPException(status_code=409, detail=exc.sqlstate or "refused") from exc
    return {"adjudication_id": adjudication, "trial_id": str(trial_id), "verdict": body.verdict}
