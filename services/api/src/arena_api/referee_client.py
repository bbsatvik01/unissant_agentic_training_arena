"""The caller-token client `arena-api` uses for `arena-referee`'s `POST /internal/sessions/{id}/debrief`
(S5 5.4, 5.5, C-42). The session id is the whole request; the referee returns the published debrief.v1 (running
R3 in resumable stages first when it is not published yet)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import httpx

REFEREE_URL = "http://127.0.0.1:8082"
DEBRIEF_TIMEOUT_S = 120.0  # two referee calls of up to 30 s each, with their retries (S2 2)

DebriefCall = Callable[[UUID], Awaitable[dict[str, Any]]]


class RefereeError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def referee_client(
    token: str, base_url: str = REFEREE_URL, transport: httpx.AsyncBaseTransport | None = None
) -> DebriefCall:
    async def debrief(session: UUID) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(base_url=base_url, transport=transport, timeout=DEBRIEF_TIMEOUT_S) as client:
                resp = await client.post(
                    f"/internal/sessions/{session}/debrief", headers={"Authorization": f"Bearer {token}"}
                )
        except httpx.HTTPError as exc:
            raise RefereeError(503, "referee_unreachable") from exc
        if resp.status_code != httpx.codes.OK:
            raise RefereeError(resp.status_code, resp.text[:200])
        body: dict[str, Any] = resp.json()
        return body

    return debrief
