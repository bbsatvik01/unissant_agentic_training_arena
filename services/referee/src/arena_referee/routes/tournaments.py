"""The admin console's tournament lifecycle and reads (S5 5.5 admin table; S6 4.13): `GET /api/admin/tournaments`,
`GET /api/admin/tournaments/{id}` (with progress counts and the reveal preconditions as `[{name, passed}]`),
`POST /api/admin/tournaments` (create, idempotent by name), `.../{id}/roster`, `/freeze`, `/close`, `/scoring`
and `/publish`. Open, reveal and corrections are `routes.reveal`'s (one implementation each). Every route needs an
`admin` identity; every POST passed the D10 guard first. Each step is the S4 function itself, idempotent there:
a repeat returns the current state, and a refused transition is 409 with S4's reason code.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

from arena_core.identity import DevIdentity
from arena_referee import admin_db
from arena_referee.identity_dep import require_admin_role
from arena_referee.routes.reveal import publish_context, run_publish

router = APIRouter(prefix="/api/admin/tournaments")
Admin = Annotated[DevIdentity, Depends(require_admin_role)]


class TournamentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    split: Literal["dev", "hidden"]
    seed: int = Field(ge=0, le=2**62)
    max_exchanges: int = Field(default=12, ge=1, le=12)


class RosterRows(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[dict[str, Any]] = Field(min_length=1, max_length=2000)


class Publish(BaseModel):
    model_config = ConfigDict(extra="forbid")

    manifest_version: int = Field(default=1, ge=1)


async def _step(request: Request, sql: str, params: tuple[object, ...]) -> object:
    try:
        return await admin_db.call(request.app.state.connect, sql, params)
    except psycopg.Error as exc:
        # S4 refuses a transition its state does not allow (AR001), a key reused with other input (AR003) or a
        # bad argument (AR007): the admin sees S4's code, the tournament is unchanged.
        raise HTTPException(status_code=409, detail=exc.sqlstate or "refused") from exc


async def _detail(request: Request, tournament_id: UUID) -> dict[str, Any]:
    connect = request.app.state.connect
    found = await admin_db.tournament(connect, tournament_id)
    if found is None:
        raise HTTPException(status_code=404, detail="not_found")
    found["progress"] = await admin_db.progress(connect, tournament_id)
    found["preconditions"] = await admin_db.reveal_preconditions(connect, tournament_id)
    return found


@router.get("")
async def list_tournaments(request: Request, _admin: Admin) -> dict[str, Any]:
    return {"tournaments": await admin_db.tournaments(request.app.state.connect)}


@router.get("/{tournament_id}")
async def get_tournament(tournament_id: UUID, request: Request, _admin: Admin) -> dict[str, Any]:
    return await _detail(request, tournament_id)


@router.post("")
async def create_tournament(body: TournamentCreate, request: Request, _admin: Admin) -> dict[str, Any]:
    tid = await _step(
        request,
        "select arena.create_tournament(%s, %s, %s, 'global', %s::smallint)",
        (body.name, body.split, body.seed, body.max_exchanges),
    )
    return await _detail(request, UUID(str(tid)))


@router.post("/{tournament_id}/roster")
async def add_roster(tournament_id: UUID, body: RosterRows, request: Request, _admin: Admin) -> dict[str, Any]:
    added = await _step(request, "select arena.add_planned_trials(%s, %s)", (tournament_id, Jsonb(body.rows)))
    return {**await _detail(request, tournament_id), "added": added}


@router.post("/{tournament_id}/freeze")
async def freeze(tournament_id: UUID, request: Request, _admin: Admin) -> dict[str, Any]:
    await _step(request, "select arena.freeze_tournament(%s)", (tournament_id,))
    return await _detail(request, tournament_id)


@router.post("/{tournament_id}/close")
async def close(tournament_id: UUID, request: Request, _admin: Admin) -> dict[str, Any]:
    """Requires the replay corpus seal made earlier by the corpus-seal route; never seals it here (SG3-24)."""
    await _step(request, "select arena.close_tournament_run(%s)", (tournament_id,))
    return await _detail(request, tournament_id)


@router.post("/{tournament_id}/scoring")
async def begin_scoring(tournament_id: UUID, request: Request, _admin: Admin) -> dict[str, Any]:
    await _step(request, "select arena.begin_scoring(%s)", (tournament_id,))
    return await _detail(request, tournament_id)


@router.post("/{tournament_id}/publish")
async def publish(tournament_id: UUID, request: Request, _admin: Admin, body: Publish | None = None) -> dict[str, Any]:
    """S5 5.5: compute and insert the boards of a revealed manifest (idempotent: an existing board is kept).
    Reveal and corrections already publish right after sealing; this repeats it for manifest version 1 of a
    revealed tournament (a publish interrupted after the seal). A later version is published by its correction."""
    found = await admin_db.tournament(request.app.state.connect, tournament_id)
    if found is None:
        raise HTTPException(status_code=404, detail="not_found")
    if found["status"] != "revealed":
        raise HTTPException(status_code=409, detail="reveal the tournament first")
    if (body or Publish()).manifest_version != 1:
        raise HTTPException(status_code=409, detail="a corrected manifest is published by its correction")
    ctx = await publish_context(request, tournament_id)
    return await run_publish(request, tournament_id, ctx)
