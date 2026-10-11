"""`/admin/tournaments/{id}/reveal`, `/admin/tournaments/{id}/corrections`, `/admin/tournaments/{id}/leaderboard`
(S3 4.4, 5.5-5.6; S4 6; WP-16): the operator's own reveal and correction actions, each followed by the
leaderboard they publish, and a read of that published board. Reveal and corrections need an `admin`
identity (`require_admin_role`); the leaderboard read is open to `admin` or `trainer`
(`require_console_role`) like the rest of the console. WP-20a's admin console calls these; this route is
their backend.
"""

from __future__ import annotations

from collections.abc import Coroutine
from typing import Annotated, Any, Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request

from arena_core.identity import DevIdentity
from arena_referee import db
from arena_referee.identity_dep import require_admin_role, require_console_role
from arena_referee.isolation import open_hidden_tournament
from arena_referee.reveal import PublishConfig, PublishContext, reveal_and_publish, seal_correction_and_publish
from arena_referee.routes.admin import isolation_gate_request

router = APIRouter(prefix="/admin/tournaments")

# AR020 (a precondition of reveal itself, e.g. the wrong tournament status or an unresolved review) and
# AR021 (a seal, commitment or ledger-chain verification failure) are both "reveal is blocked", not a
# caller error (422) and not a bug (500): the admin sees why and fixes the tournament state, never the gate.
_BLOCKED_SQLSTATES = frozenset({"AR020", "AR021"})


async def _publish_context(request: Request) -> PublishContext:
    """Built fresh for this call: the fixed `PublishConfig` from app startup, plus the isolation result read
    live for the running commit (a gate run between two reveals must change what the next one publishes,
    S3 9's own "the tournament's code version" scoping)."""
    config: PublishConfig | None = getattr(request.app.state, "publish_config", None)
    git_sha: str | None = getattr(request.app.state, "git_sha", None)
    if config is None or not git_sha:
        msg = "the referee app was not configured with a PublishConfig and ARENA_GIT_SHA"
        raise RuntimeError(msg)
    isolation = await db.fetch_isolation_result(request.app.state.connect, git_sha)
    qq_calibrated: bool = getattr(request.app.state, "qq_calibrated", False)
    return PublishContext(isolation=isolation, qq_calibrated=qq_calibrated, config=config)


def _as_json(result: db.RevealResult) -> dict[str, object]:
    return {
        "manifest_id": result.manifest_id,
        "manifest_sha256": result.manifest_sha256,
        "manifest_version": result.manifest_version,
    }


async def _run(coro: Coroutine[Any, Any, db.RevealResult], action: str) -> dict[str, object]:
    try:
        result = await coro
    except psycopg.Error as exc:
        if exc.sqlstate in _BLOCKED_SQLSTATES:
            raise HTTPException(status_code=409, detail=f"{action} blocked: {exc}") from exc
        raise
    return _as_json(result)


@router.post("/{tournament_id}/reveal")
async def reveal_route(
    tournament_id: UUID, request: Request, _identity: Annotated[DevIdentity, Depends(require_admin_role)]
) -> dict[str, object]:
    ctx = await _publish_context(request)
    return await _run(reveal_and_publish(request.app.state.connect, str(tournament_id), ctx), "reveal")


@router.post("/{tournament_id}/corrections")
async def correction_route(
    tournament_id: UUID, request: Request, _identity: Annotated[DevIdentity, Depends(require_admin_role)]
) -> dict[str, object]:
    ctx = await _publish_context(request)
    return await _run(seal_correction_and_publish(request.app.state.connect, str(tournament_id), ctx), "correction")


@router.get("/{tournament_id}/leaderboard")
async def leaderboard_route(
    tournament_id: UUID,
    request: Request,
    _identity: Annotated[DevIdentity, Depends(require_console_role)],
    label: Literal["original", "corrected"] = "original",
) -> dict[str, object]:
    """The published body verbatim (D-020: nothing added, nothing the spec lacks)."""
    body = await db.fetch_leaderboard(request.app.state.connect, str(tournament_id), label=label)
    if body is None:
        raise HTTPException(status_code=404, detail=f"no {label} leaderboard for tournament {tournament_id}")
    return dict(body)


@router.post("/{tournament_id}/open")
async def open_route(
    tournament_id: UUID,
    body: dict[str, Any],
    request: Request,
    _identity: Annotated[DevIdentity, Depends(require_admin_role)],
) -> dict[str, object]:
    """S1 L9, S3 9: the isolation gate (including the hidden-text scan) runs fresh, and `frozen` -> `running`
    only on a pass -- the one path to opening a tournament this process exposes; `body` is IG-1/2/3's
    report evidence, exactly `/admin/isolation-gate/run`'s shape."""
    git_sha: str | None = getattr(request.app.state, "git_sha", None)
    if not git_sha:
        msg = "the referee app was not configured with ARENA_GIT_SHA"
        raise RuntimeError(msg)
    try:
        gate_request = isolation_gate_request(body, git_sha)
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        result = await open_hidden_tournament(request.app.state.connect, str(tournament_id), gate_request)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except psycopg.Error as exc:
        # arena.open_tournament's own precondition (AR001: only a frozen tournament can start running).
        raise HTTPException(status_code=409, detail=f"open blocked: {exc}") from exc
    return {"opened": True, "passed": result.passed, "evidence_hash": result.evidence_hash}
