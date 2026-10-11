"""`/admin/isolation-gate` (S3 9; WP-16): `GET` reads the latest result for the running code version;
`POST /run` runs it. An `admin` identity only -- WP-20a's admin console calls these; this route is their
backend. IG-4 and IG-5's evidence is computed server-side from the database and the referee's own
filesystem (never from the request body, L6, L7); the body carries only what this process cannot see for
itself: IG-1, IG-2 and IG-3's own already-run report evidence, and IG-6's observed canary-hit counts.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request

from arena_core.identity import DevIdentity
from arena_core.scoring.ranking import IsolationResult
from arena_referee import db
from arena_referee.identity_dep import require_admin_role
from arena_referee.isolation import IsolationGateRequest, run_isolation_gate

router = APIRouter(prefix="/admin")


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
    item = body[key]
    return bool(item["passed"]), str(item["report_text"])


@router.post("/isolation-gate/run")
async def run_isolation_gate_route(
    body: dict[str, Any], request: Request, _identity: Annotated[DevIdentity, Depends(require_admin_role)]
) -> dict[str, object]:
    """`body`: `{"tournament_id": "...", "ig1": {"passed": bool, "report_text": "..."}, "ig2": {...},
    "ig3": {...}, "hits_by_candidate": {"<candidate_id>": <count>, ...}}`."""
    try:
        tournament_id = str(body["tournament_id"])
        request_obj = IsolationGateRequest(
            tournament_id=tournament_id,
            git_sha=_git_sha(request),
            ig1=_as_report(body, "ig1"),
            ig2=_as_report(body, "ig2"),
            ig3=_as_report(body, "ig3"),
            hits_by_candidate={str(k): int(v) for k, v in body.get("hits_by_candidate", {}).items()},
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result = await run_isolation_gate(request.app.state.connect, request_obj)
    return _result_json(result)
