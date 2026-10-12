"""`/internal/voice/ws` admission (S5 7.1, 7.8): only arena-api's caller token opens it (no token, the tournament's
token or a browser are refused before the upgrade); an admitted leg whose first frame is not `start` closes 4400."""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from decimal import Decimal
from typing import Any, cast
from uuid import uuid4

import pytest
import uvicorn
from psycopg import AsyncConnection
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from arena_core.db import calls
from arena_core.db import voice as db_voice
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.memory import RunBudget
from arena_core.voice import protocol as p
from arena_core.voice.live import FakeLive
from arena_subject import voice_ws
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


def test_the_db_store_runs_each_call_on_its_own_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    marker = object()

    @contextlib.asynccontextmanager
    async def connect() -> AsyncIterator[AsyncConnection[Any]]:
        seen.append("connect")
        yield cast("AsyncConnection[Any]", marker)

    def record(name: str, result: object) -> Callable[..., Awaitable[object]]:
        async def call(conn: object, *args: object) -> object:
            assert conn is marker
            seen.append(name)
            del args
            return result

        return call

    opened = db_voice.OpenedVoice(uuid4(), uuid4())
    dispatched = calls.DispatchResult("dispatched", None, None)
    usage = calls.UsageResult("recorded", Decimal(0), Decimal(0), Decimal(1), shutoff=False)
    monkeypatch.setattr(db_voice, "open_voice", record("open", opened))
    monkeypatch.setattr(db_voice, "voice_context", record("context", {"a": 1}))
    monkeypatch.setattr(db_voice, "record_exchange", record("exchange", ["rec-01"]))
    monkeypatch.setattr(db_voice, "close_voice", record("close", None))
    monkeypatch.setattr(calls, "mark_dispatched", record("dispatch", dispatched))
    monkeypatch.setattr(calls, "record_usage", record("usage", usage))
    monkeypatch.setattr(calls, "settle_voice_reservation", record("settle", None))
    store = voice_ws.DbVoiceStore(connect)

    async def go() -> None:
        assert await store.open(p.Start(uuid4(), uuid4(), uuid4(), "practice")) == opened
        assert await store.dispatch(uuid4()) is True
        assert await store.context(uuid4()) == {"a": 1}
        assert await store.record_exchange(uuid4(), 1, []) == ["rec-01"]
        assert await store.record_usage(cast("calls.UsageReport", None)) == usage
        await store.close(uuid4(), "1000")
        await store.settle(uuid4(), "committed")

    asyncio.run(go())
    assert seen == [
        x for name in ("open", "dispatch", "context", "exchange", "usage", "close", "settle") for x in ("connect", name)
    ]
