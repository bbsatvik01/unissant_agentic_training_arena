"""Caller-token client for `arena-referee`'s internal scoring and run-closing routes (S5 5.3, 5.5; C-42).

Mirrors `arena_api.referee_client`'s one-call-per-route shape (a caller token, one base URL, one timeout);
the D10 guard treats every `/internal/*` path alike (`arena_core.http_guard`), so these new routes need no
guard changes of their own. The corpus seal and the close call are each retried once on a transport failure
(SG3-24): both run once per tournament, so a lost response must not silently stop the job, and both are
idempotent at the referee (a stored seal; `arena.close_tournament_run`'s own state check).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import httpx

REFEREE_URL = "http://127.0.0.1:8082"
SCORE_TIMEOUT_S = 90.0  # one trial's R1 and R2, each with the port's own attempts and repair (S2 2)
# The block-boundary route runs R1 and R2 for every trial of the block sequentially, in one HTTP
# request/response cycle; the official lineup's block is at most 18 trials (S3: "nine pairings, two
# variants"), so the single-trial budget alone (a real bug, Codex round 1) would time out a real, non-fake
# block well before the referee finishes -- sized for the worst case, not the common one.
MAX_BLOCK_TRIALS = 18
BLOCK_SCORE_TIMEOUT_S = SCORE_TIMEOUT_S * MAX_BLOCK_TRIALS
LIFECYCLE_TIMEOUT_S = 10.0  # a database-only operation at the referee, no model call


class RefereeError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class RefereeClient:
    """One tournament job's caller-token conversation with `arena-referee` (S5 5.5's job-to-referee rows)."""

    def __init__(
        self, token: str, base_url: str = REFEREE_URL, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._token = token
        self._base_url = base_url
        self._transport = transport

    async def _post(self, path: str, *, timeout_s: float) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url, transport=self._transport, timeout=timeout_s
            ) as client:
                resp = await client.post(path, headers={"Authorization": f"Bearer {self._token}"})
        except httpx.HTTPError as exc:
            raise RefereeError(503, "referee_unreachable") from exc
        if resp.status_code != httpx.codes.OK:
            raise RefereeError(resp.status_code, resp.text[:200])
        body: dict[str, Any] = resp.json()
        return body

    async def _retry_once(self, call: Callable[[], Awaitable[dict[str, Any]]]) -> dict[str, Any]:
        try:
            return await call()
        # silent-ok: the retry is the point (SG3-24); the retry's own RefereeError propagates uncaught below
        except RefereeError:
            return await call()

    async def score_trial(self, trial: UUID) -> dict[str, Any]:
        """`POST /internal/trials/{id}/score`: R1 on a corpus transcript (with its initial verdict, S3 4.2),
        or R2 on a replay trial once its source's R1 is stored (S5 5.3)."""
        return await self._post(f"/internal/trials/{trial}/score", timeout_s=SCORE_TIMEOUT_S)

    async def score_block(self, tournament: UUID, block_no: int) -> dict[str, Any]:
        """R1 and R2 on every interactive trial of the block (C-42). Named by `(tournament, block_no)`, not
        the spec table's bare block id: `arena_public` has no grant to read a block's own id (only
        `arena.v_planned_trials.block_no`, S4 9.3), and this composite key is just as unique. A WP-17
        simplification over the literal S5 5.5 path; noted in the build report for WP-20a's admin console."""
        return await self._post(
            f"/internal/tournaments/{tournament}/blocks/{block_no}/score", timeout_s=BLOCK_SCORE_TIMEOUT_S
        )

    async def corpus_seal(self, tournament: UUID) -> dict[str, Any]:
        """`POST /internal/tournaments/{id}/corpus-seal` (SG2-27, SG3-24): idempotent at the referee."""
        return await self._retry_once(
            lambda: self._post(f"/internal/tournaments/{tournament}/corpus-seal", timeout_s=LIFECYCLE_TIMEOUT_S)
        )

    async def close(self, tournament: UUID) -> dict[str, Any]:
        """`POST /internal/tournaments/{id}/close` (SG3-24): `arena.close_tournament_run`, run once every
        planned trial has an execution record and the replay corpus (if any) is sealed."""
        return await self._retry_once(
            lambda: self._post(f"/internal/tournaments/{tournament}/close", timeout_s=LIFECYCLE_TIMEOUT_S)
        )
