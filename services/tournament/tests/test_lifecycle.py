"""`arena_tournament.lifecycle` against a fake `Connector` (the same stand-in `services/referee/tests/
test_db.py` uses): every S4 privileged function call it wraps, and the two refusals (`_call`'s own SQL
error mapping, `open_tournament`'s hidden-split refusal) it_tournament.py's happy path never reaches."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from typing import Any, cast
from uuid import uuid4

import psycopg
import pytest

from arena_core.agents.manifests import committed_manifest
from arena_core.db.pool import Connector
from arena_tournament import lifecycle
from arena_tournament.roster import PlannedRow


def run[T](aw: Awaitable[T]) -> T:
    async def _runner() -> T:
        return await aw

    return asyncio.run(_runner())


@asynccontextmanager
async def _noop_tx() -> AsyncIterator[None]:
    yield


class FakeCursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)


class FakeConn:
    def __init__(self, row: tuple[Any, ...] | None = None, *, error: Exception | None = None) -> None:
        self._row = row
        self._error = error
        self.executed: list[str] = []

    async def execute(self, query: str, _params: tuple[Any, ...] = ()) -> FakeCursor:
        self.executed.append(query)
        if self._error is not None:
            raise self._error
        return FakeCursor([self._row] if self._row is not None else [])

    def transaction(self) -> AsyncIterator[None]:
        return cast("AsyncIterator[None]", _noop_tx())


def connector(conn: FakeConn) -> Connector:
    @asynccontextmanager
    async def connect() -> AsyncIterator[FakeConn]:
        yield conn

    return cast("Connector", connect)


def test_register_candidate_returns_the_registered_id() -> None:
    cand_id = uuid4()
    conn = FakeConn((cand_id,))
    manifest = committed_manifest("A1")
    assert run(lifecycle.register_candidate(connector(conn), manifest)) == cand_id


def test_create_tournament_returns_the_new_id() -> None:
    tid = uuid4()
    conn = FakeConn((tid,))
    spec = lifecycle.TournamentSpec(name="it-lifecycle", split="dev", seed=1)
    assert run(lifecycle.create_tournament(connector(conn), spec)) == tid


def test_add_planned_trials_returns_the_count() -> None:
    planted = 2  # the function's own payload mapping is exercised by roster's own tests
    conn = FakeConn((planted,))
    rows = cast("list[PlannedRow]", [])
    assert run(lifecycle.add_planned_trials(connector(conn), uuid4(), rows)) == planted


def test_freeze_tournament_returns_the_roster_hash() -> None:
    conn = FakeConn(("a" * 64,))
    assert run(lifecycle.freeze_tournament(connector(conn), uuid4())) == "a" * 64


def test_open_tournament_dev_split_calls_the_function() -> None:
    conn = FakeConn()
    run(lifecycle.open_tournament(connector(conn), uuid4(), split="dev"))
    assert any("arena.open_tournament" in q for q in conn.executed)


def test_open_tournament_refuses_a_hidden_split_before_any_call() -> None:
    conn = FakeConn()
    with pytest.raises(lifecycle.LifecycleError) as exc_info:
        run(lifecycle.open_tournament(connector(conn), uuid4(), split="hidden"))
    assert exc_info.value.code == "AR001"
    assert "hidden-text scan" in exc_info.value.message
    assert conn.executed == []


def test_call_maps_a_sql_error_to_a_lifecycleerror() -> None:
    exc = psycopg.Error("negative control candidate")
    exc.sqlstate = "AR007"
    conn = FakeConn(error=exc)
    spec = lifecycle.TournamentSpec(name="it-lifecycle-error", split="dev", seed=1)
    with pytest.raises(lifecycle.LifecycleError) as exc_info:
        run(lifecycle.create_tournament(connector(conn), spec))
    assert exc_info.value.code == "AR007"
    assert exc_info.value.message == "negative control candidate"


def test_candidate_kinds_found_and_empty() -> None:
    a1, s1 = uuid4(), uuid4()

    class _MultiRowConn(FakeConn):
        async def execute(self, query: str, _params: tuple[Any, ...] = ()) -> FakeCursor:
            self.executed.append(query)
            return FakeCursor([(a1, "assistant"), (s1, "subject")])

    found = run(lifecycle.candidate_kinds(connector(_MultiRowConn()), [a1, s1]))
    assert found == {a1: "assistant", s1: "subject"}
    assert run(lifecycle.candidate_kinds(connector(FakeConn()), [])) == {}
