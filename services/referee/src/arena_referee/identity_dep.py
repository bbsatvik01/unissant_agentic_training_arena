"""The referee console's identity dependency (S5 9.3, 10.3): one acting user per run, resolved once at
startup into `app.state.identity`; every console route requires it to carry `admin` or `trainer`.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from arena_core.identity import DevIdentity

CONSOLE_ROLES = frozenset({"admin", "trainer"})


def require_console_role(request: Request) -> DevIdentity:
    identity: DevIdentity | None = getattr(request.app.state, "identity", None)
    if identity is None or not (identity.roles & CONSOLE_ROLES):
        raise HTTPException(status_code=403, detail="admin or trainer role required")
    return identity


def require_rater(request: Request) -> DevIdentity:
    """The trainer console's own review surface (S6 4.12): a `trainer` identity specifically."""
    identity: DevIdentity | None = getattr(request.app.state, "identity", None)
    if identity is None or "trainer" not in identity.roles:
        raise HTTPException(status_code=403, detail="trainer role required")
    return identity


def require_admin_role(request: Request) -> DevIdentity:
    """The admin console's own operator surface (S4 reveal and its corrections, the isolation-gate runner,
    WP-16): an `admin` identity specifically -- a `trainer` alone never reveals a tournament or runs the
    isolation gate."""
    identity: DevIdentity | None = getattr(request.app.state, "identity", None)
    if identity is None or "admin" not in identity.roles:
        raise HTTPException(status_code=403, detail="admin role required")
    return identity
