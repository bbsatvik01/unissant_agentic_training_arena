"""The caller-token clients (S5 5.5, 10.2 item 4; D-024): what they send and how they map each answer."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from uuid import uuid4

import httpx
import pytest

from arena_api.referee_client import RefereeError, referee_client
from arena_api.subject_client import subject_client
from arena_core.turns.orchestrator import SubjectUnavailableError


def run[T](awaitable: Awaitable[T]) -> T:
    async def wait() -> T:
        return await awaitable

    return asyncio.run(wait())


def transport(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def test_subject_client_sends_trial_item_actor_and_the_bearer_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"outcome": "recorded", "turn_no": 2, "transcript_version": 4})

    trial, item, actor = uuid4(), uuid4(), uuid4()
    outcome = run(subject_client("tok", transport=transport(handler))(trial, item, actor))
    assert (outcome.outcome, outcome.turn_no) == ("recorded", 2)
    assert seen[0].url.path == "/internal/answer"
    assert seen[0].headers["authorization"] == "Bearer tok"
    assert json.loads(seen[0].content) == {"trial": str(trial), "work_item": str(item), "actor": str(actor)}


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(503, json={"detail": "budget_refused"}), "budget_refused"),
        (httpx.Response(409, json={"detail": "step_in_progress"}), "step_in_progress"),
        (httpx.Response(502, text="bad gateway"), "http_502"),
        (httpx.Response(500, json={"detail": {"nested": 1}}), "http_500"),
    ],
)
def test_subject_client_maps_refusals_to_their_code(response: httpx.Response, code: str) -> None:
    with pytest.raises(SubjectUnavailableError) as exc_info:
        run(subject_client("tok", transport=transport(lambda _r: response))(uuid4(), uuid4(), None))
    assert exc_info.value.code == code


def test_subject_client_transport_failure_is_unreachable() -> None:
    def boom(_r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with pytest.raises(SubjectUnavailableError) as exc_info:
        run(subject_client("tok", transport=transport(boom))(uuid4(), uuid4(), None))
    assert exc_info.value.code == "subject_unreachable"


def test_referee_client_posts_the_session_and_returns_the_debrief() -> None:
    session = uuid4()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/internal/sessions/{session}/debrief"
        assert request.headers["authorization"] == "Bearer tok"
        return httpx.Response(200, json={"schema_version": "debrief.v1"})

    assert run(referee_client("tok", transport=transport(handler))(session)) == {"schema_version": "debrief.v1"}


def test_referee_client_errors() -> None:
    with pytest.raises(RefereeError) as refused:
        run(referee_client("tok", transport=transport(lambda _r: httpx.Response(409, text="not ended")))(uuid4()))
    assert refused.value.status == HTTPStatus.CONFLICT

    def boom(_r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with pytest.raises(RefereeError) as down:
        run(referee_client("tok", transport=transport(boom))(uuid4()))
    assert down.value.status == HTTPStatus.SERVICE_UNAVAILABLE
