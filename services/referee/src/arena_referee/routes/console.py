"""`GET /api/me`, `GET /api/config`: console bootstrap on the referee origin (S5 5.5, SG4-11). Both need an
admin or trainer identity; D10's CSRF cookie is minted on `GET /api/me` (S5 10.3)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from arena_core.http_guard import CSRF_COOKIE, new_csrf_token
from arena_core.identity import DevIdentity
from arena_referee.identity_dep import require_console_role

router = APIRouter()


@router.get("/api/me")
async def get_me(
    response: Response, identity: Annotated[DevIdentity, Depends(require_console_role)]
) -> dict[str, object]:
    token = new_csrf_token()
    response.set_cookie(CSRF_COOKIE, token, httponly=True, samesite="strict", path="/")
    return {
        "user_id": str(identity.user_id),
        "display_name": identity.display_name,
        "roles": sorted(identity.roles),
        "csrf_token": token,
    }


@router.get("/api/config")
async def get_config(_identity: Annotated[DevIdentity, Depends(require_console_role)]) -> dict[str, object]:
    return {"phoenix_url": None, "paused": False}
