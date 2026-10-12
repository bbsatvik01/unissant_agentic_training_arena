"""A tiny D10-aware HTTP client for arena-referee's console routes (S5 10.3): any operator script that needs
one authenticated admin-console transaction (`make isolation-reports`'s own `POST /api/admin/isolation-gate/run`,
or a one-off `scoring`/`reveal` call against a local dev tournament) reuses this instead of hand-rolling the
double-submit dance again. `GET /api/me` first, for the CSRF cookie and token the console mints there
(`arena_referee.routes.console.get_me`); the acting identity itself is the referee process's own one resolved
user (S5 10.3: "one acting user per run", `ARENA_DEV_USER`) -- this client names no bearer token or header for
it, only the Origin, Cookie and `X-Arena-CSRF` header `arena_core.http_guard` checks on every state-changing
request. Never retries: the caller decides that for itself.
"""

from __future__ import annotations

from typing import Any

import httpx

DEFAULT_BASE_URL = "http://127.0.0.1:8082"  # arena-referee (S5 10.1)


class AdminCallError(Exception):
    """The referee refused the call, or answered something other than 200; carries the status and body."""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"{status}: {body[:200]}")
        self.status = status
        self.body = body


async def admin_post(
    path: str,
    body: dict[str, Any] | None = None,
    *,
    base_url: str = DEFAULT_BASE_URL,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """One admin-console `POST` (S5 10.3's double submit): `GET /api/me` for the CSRF token, whose
    `Set-Cookie` the client's own jar keeps for the `POST` right behind it (never a per-request `cookies=`,
    deprecated in httpx 0.28: cookie persistence through that kwarg is ambiguous). Raises `AdminCallError` on
    anything but 200 from either call. `transport` is a test seam (`httpx.MockTransport`); a real caller
    never sets it."""
    async with httpx.AsyncClient(base_url=base_url, transport=transport) as client:
        me = await client.get("/api/me")
        if me.status_code != httpx.codes.OK:
            raise AdminCallError(me.status_code, me.text)
        token = str(me.json()["csrf_token"])
        resp = await client.post(path, json=body, headers={"Origin": base_url, "X-Arena-CSRF": token})
        if resp.status_code != httpx.codes.OK:
            raise AdminCallError(resp.status_code, resp.text)
        return dict(resp.json())
