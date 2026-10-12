"""`/internal/voice/ws` admission (S5 7.1, 7.8): only arena-api's caller token opens it (no token, the tournament's
token or a browser are refused before the upgrade); an admitted leg whose first frame is not `start` closes 4400."""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from decimal import Decimal
from typing import Any

import pytest
import uvicorn
from psycopg import AsyncConnection
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.memory import RunBudget
from arena_core.voice import protocol as p
from arena_core.voice.live import FakeLive
from arena_subject.app import PORT, AppState, create_app
from arena_subject.internal_auth import token_sha256

API, TOURNAMENT = "api-token", "tournament-token"


def no_db() -> AbstractAsyncContextManager[AsyncConnection[Any]]:
    """No database is reached on these paths."""
    raise AssertionError


def state() -> AppState:
    return AppState(
        connect=no_db,
        port=AgentPort(FakeAdapter(canned={}), RunBudget(Decimal(1)), PortOptions()),
        allowed_callers=frozenset({token_sha256(API), token_sha256(TOURNAMENT)}),
        live=FakeLive(),
        voice_callers=frozenset({token_sha256(API)}),
    )


def serve(test: Callable[[int], Awaitable[None]]) -> None:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])

    async def go() -> None:
        server = uvicorn.Server(uvicorn.Config(create_app(state()), log_level="warning", lifespan="off"))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        for _ in range(500):
            if server.started:
                break
            await asyncio.sleep(0.01)
        try:
            await test(port)
        finally:
            server.should_exit = True
            await task

    asyncio.run(go())


def leg(port: int, headers: dict[str, str]) -> connect:
    # The URL names the service's own address (its Host check); the socket goes to the test server's port.
    return connect(f"ws://127.0.0.1:{PORT}/internal/voice/ws", additional_headers=headers, host="127.0.0.1", port=port)


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": f"Bearer {TOURNAMENT}"},
        {"Authorization": f"Bearer {API}", "Origin": "http://127.0.0.1:8080"},
    ],
)
def test_only_the_api_token_opens_the_voice_route(headers: dict[str, str]) -> None:
    async def test(port: int) -> None:
        with pytest.raises(InvalidStatus):
            async with leg(port, headers):
                pass

    serve(test)


def test_an_admitted_leg_whose_first_frame_is_not_start_closes_4400() -> None:
    async def test(port: int) -> None:
        async with leg(port, {"Authorization": f"Bearer {API}"}) as ws:
            await ws.send(json.dumps({"type": "stop"}))
            with contextlib.suppress(ConnectionClosed):
                await ws.recv()
            assert ws.close_code == p.PROTOCOL

    serve(test)
