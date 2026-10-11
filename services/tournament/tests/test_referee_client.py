"""RefereeClient: what it sends, how a non-200 or a transport failure maps to RefereeError, and the
one-retry behavior the corpus-seal and close calls lean on (SG3-24)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from uuid import uuid4

import httpx
import pytest

from arena_tournament.referee_client import (
    BLOCK_SCORE_TIMEOUT_S,
    MAX_BLOCK_TRIALS,
    SCORE_TIMEOUT_S,
    RefereeClient,
    RefereeError,
)

CALLER = "it-referee-client-caller"  # fixture value only, never a real credential
RETRY_ATTEMPTS = 2  # the one retry _retry_once makes (SG3-24): the first call plus its one retry


def run[T](awaitable: Awaitable[T]) -> T:
    async def wait() -> T:
        return await awaitable

    return asyncio.run(wait())


def transport(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def test_score_trial_posts_the_path_and_bearer_token_and_returns_the_body() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"decision": "valid"})

    trial = uuid4()
    client = RefereeClient(CALLER, transport=transport(handler))
    body = run(client.score_trial(trial))
    assert body == {"decision": "valid"}
    assert seen[0].url.path == f"/internal/trials/{trial}/score"
    assert seen[0].headers["authorization"] == f"Bearer {CALLER}"


def test_score_block_posts_the_tournament_and_block_no_path() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"scored": 2})

    tournament = uuid4()
    client = RefereeClient(CALLER, transport=transport(handler))
    assert run(client.score_block(tournament, 3)) == {"scored": 2}
    assert seen[0].url.path == f"/internal/tournaments/{tournament}/blocks/3/score"


@pytest.mark.parametrize(
    "response",
    [httpx.Response(409, json={"detail": "AR001: trial is not running"}), httpx.Response(500, text="boom")],
)
def test_a_non_200_response_raises_refereeerror_with_its_status_and_body(response: httpx.Response) -> None:
    client = RefereeClient(CALLER, transport=transport(lambda _r: response))
    with pytest.raises(RefereeError) as exc_info:
        run(client.score_trial(uuid4()))
    assert exc_info.value.status == response.status_code
    assert exc_info.value.detail == response.text[:200]


def test_a_transport_failure_raises_a_503_referee_unreachable_error() -> None:
    def boom(_r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = RefereeClient(CALLER, transport=transport(boom))
    with pytest.raises(RefereeError) as exc_info:
        run(client.score_trial(uuid4()))
    assert (exc_info.value.status, exc_info.value.detail) == (503, "referee_unreachable")


def test_corpus_seal_retries_once_after_a_single_failure_then_succeeds() -> None:
    attempts: list[int] = []

    def handler(_r: httpx.Request) -> httpx.Response:
        attempts.append(1)
        if len(attempts) == 1:
            return httpx.Response(409, json={"detail": "AR001: lost response, try again"})
        return httpx.Response(200, json={"corpus_sha256": "a" * 64})

    client = RefereeClient(CALLER, transport=transport(handler))
    assert run(client.corpus_seal(uuid4())) == {"corpus_sha256": "a" * 64}
    assert len(attempts) == RETRY_ATTEMPTS


def test_close_propagates_the_retrys_own_failure_when_it_also_fails() -> None:
    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(HTTPStatus.CONFLICT, json={"detail": "AR001: still running"})

    client = RefereeClient(CALLER, transport=transport(handler))
    with pytest.raises(RefereeError) as exc_info:
        run(client.close(uuid4()))
    assert exc_info.value.status == HTTPStatus.CONFLICT
    assert json.loads(exc_info.value.detail)["detail"] == "AR001: still running"


def test_score_block_budgets_enough_time_for_the_whole_blocks_trials_not_just_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real bug (Codex round 1): the block route runs R1 and R2 for every trial of the block sequentially
    in one HTTP cycle; a single trial's own timeout would abort a real (non-fake) block long before the
    referee finishes scoring it."""
    assert BLOCK_SCORE_TIMEOUT_S == SCORE_TIMEOUT_S * MAX_BLOCK_TRIALS
    assert BLOCK_SCORE_TIMEOUT_S > SCORE_TIMEOUT_S

    seen_timeouts: list[float] = []

    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"scored": []})

    client = RefereeClient(CALLER, transport=transport(handler))
    real_post = client._post

    async def spying_post(path: str, *, timeout_s: float) -> dict[str, object]:
        seen_timeouts.append(timeout_s)
        return await real_post(path, timeout_s=timeout_s)

    monkeypatch.setattr(client, "_post", spying_post)
    run(client.score_block(uuid4(), 1))
    assert seen_timeouts == [BLOCK_SCORE_TIMEOUT_S]
