"""`arena_core.db.pool` without a database: the pooled connector's lifecycle and checkout cleanup, and
`one_statement`'s control flow (the real protocol runs in `it_pool.py` under make db-test)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Coroutine
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, ClassVar, cast

import psycopg
import pytest
from psycopg import AsyncConnection, IsolationLevel
from psycopg.pq import TransactionStatus

from arena_core.db import pool as pool_mod
from arena_core.db.pool import PooledConnector, close_connector, closing_lifespan, dsn_connector, one_statement
from arena_core.db.scripted import BEGIN, ScriptedConnection

PROMPT_S = 1.0  # far below the stuck rollback's 10 s


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class _Rows:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows


class Conn(ScriptedConnection):
    def __init__(self, fail: BaseException | None = None) -> None:
        self.fail = fail
        self.log: list[str] = []

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.log.append("begin")
        try:
            yield
        except BaseException:
            self.log.append("rolled back")
            raise
        self.log.append("committed")

    async def statement(self, query: str, params: tuple[Any, ...] = ()) -> _Rows:
        self.log.append(query)
        if self.fail is not None and "boom" in query:
            raise self.fail
        return _Rows([(query, params)])


def _real(conn: Conn) -> AsyncConnection[Any]:
    return cast("AsyncConnection[Any]", conn)


def test_one_statement_runs_begin_actor_statement_commit_and_restores_the_mode() -> None:
    conn = Conn()
    cur = run(one_statement(_real(conn), "select 1", (2,), actor="a"))
    assert run(cur.fetchall()) == [("select 1", (2,))]
    assert conn.log == ["begin", "select set_config('arena.actor_id', %s, true)", "select 1", "committed"]
    assert conn.autocommit is False
    assert conn.info.transaction_status == TransactionStatus.IDLE


def test_one_statement_without_an_actor_sets_none() -> None:
    conn = Conn()
    run(one_statement(_real(conn), "select 1"))
    assert conn.log == ["begin", "select 1", "committed"]


def test_a_failed_statement_is_rolled_back_raised_and_the_mode_restored() -> None:
    conn = Conn(fail=ValueError("refused"))
    with pytest.raises(ValueError, match="refused"):
        run(one_statement(_real(conn), "select boom"))
    assert conn.log == ["begin", "select boom", "rolled back"]
    assert conn.autocommit is False
    assert conn.info.transaction_status == TransactionStatus.IDLE


def test_one_statement_refuses_a_connection_inside_a_transaction() -> None:
    conn = Conn()
    run(conn.execute(BEGIN))
    with pytest.raises(RuntimeError, match="outside any transaction"):
        run(one_statement(_real(conn), "select 1"))


class FakePool:
    created: ClassVar[list[FakePool]] = []

    def __init__(self, dsn: str, **kwargs: object) -> None:
        self.dsn, self.kwargs = dsn, kwargs
        self.opened = self.closed = 0
        self.conn = Conn()
        self.served: list[Conn] = []
        FakePool.created.append(self)

    async def open(self) -> None:
        await asyncio.sleep(0)  # a concurrent first use would create a second pool here without the lock
        self.opened += 1

    async def close(self) -> None:
        self.closed += 1

    def connection(self) -> AbstractAsyncContextManager[Conn]:
        @asynccontextmanager
        async def checkout() -> AsyncIterator[Conn]:
            if self.conn.closed:  # the pool replaces a connection that came back closed
                self.conn = Conn()
            if not self.served or self.served[-1] is not self.conn:
                self.served.append(self.conn)
            yield self.conn

        return checkout()


@pytest.fixture
def fake_pool(monkeypatch: pytest.MonkeyPatch) -> list[FakePool]:
    FakePool.created = []
    monkeypatch.setattr(pool_mod, "AsyncConnectionPool", FakePool)
    return FakePool.created


def test_the_pool_opens_once_lazily_even_under_concurrent_first_use(fake_pool: list[FakePool]) -> None:
    connector = PooledConnector("postgresql://x", min_size=1, max_size=2)
    assert fake_pool == []  # nothing is opened before the serving loop uses it

    async def use() -> None:
        async with connector() as conn:
            got: object = conn
            assert isinstance(got, Conn)

    async def body() -> None:
        await asyncio.gather(use(), use(), use())
        await use()

    run(body())
    assert len(fake_pool) == 1
    assert fake_pool[0].opened == 1
    kwargs = fake_pool[0].kwargs
    assert (kwargs["min_size"], kwargs["max_size"], kwargs["open"]) == (1, 2, False)
    assert kwargs["kwargs"] == {"prepare_threshold": None, "connect_timeout": pool_mod.CONNECT_TIMEOUT_S}
    assert kwargs["configure"] is pool_mod._configure


def test_a_checkout_leaves_nothing_uncommitted_and_the_connection_mode_restored(fake_pool: list[FakePool]) -> None:
    connector = PooledConnector("postgresql://x")

    async def body() -> None:
        async with connector() as conn:
            await conn.execute(BEGIN)
            await cast("Conn", conn).statement("insert")
            await conn.set_autocommit(True)
        async with connector() as conn:
            assert conn.info.transaction_status == TransactionStatus.IDLE
            assert conn.autocommit is False

    run(body())
    first, second = fake_pool[0].served
    assert first.closed  # closed, which the server rolls back; never committed
    assert first.log == ["begin", "insert", "rolled back"]
    assert not second.closed


def test_close_closes_the_pool_and_a_later_use_opens_a_new_one(fake_pool: list[FakePool]) -> None:
    connector = PooledConnector("postgresql://x")

    async def body() -> None:
        async with connector():
            pass
        await close_connector(connector)
        await connector.close()  # a second close is a no-op
        async with connector():
            pass

    run(body())
    assert [p.closed for p in fake_pool] == [1, 0]


def test_the_lifespan_closes_the_pool_and_a_per_use_connector_needs_nothing(fake_pool: list[FakePool]) -> None:
    connector = PooledConnector("postgresql://x")

    async def body() -> None:
        async with connector():
            pass
        async with closing_lifespan(connector):
            assert fake_pool[0].closed == 0
        await close_connector(dsn_connector("postgresql://x"))

    run(body())
    assert fake_pool[0].closed == 1


def test_configure_sets_read_committed() -> None:
    seen: list[object] = []

    class Configurable:
        async def set_isolation_level(self, level: object) -> None:
            seen.append(level)

    run(pool_mod._configure(cast("AsyncConnection[Any]", Configurable())))
    assert seen == [IsolationLevel.READ_COMMITTED]


@pytest.mark.parametrize(
    ("isolation", "read_only", "deferrable", "begin"),
    [
        (IsolationLevel.READ_COMMITTED, None, None, "BEGIN ISOLATION LEVEL READ COMMITTED"),
        (IsolationLevel.SERIALIZABLE, True, True, "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE"),
        (None, False, False, "BEGIN READ WRITE NOT DEFERRABLE"),
    ],
)
def test_the_pipelined_begin_carries_the_connections_own_settings(
    isolation: IsolationLevel | None, read_only: bool | None, deferrable: bool | None, begin: str
) -> None:
    conn = Conn()
    conn.isolation_level, conn.read_only, conn.deferrable = isolation, read_only, deferrable
    assert pool_mod.begin_statement(_real(conn)) == begin
    run(one_statement(_real(conn), "select 1"))
    assert conn.begun == [begin]


class Stuck(Conn):
    """A connection whose rollback would never finish (its lock held elsewhere)."""

    async def rollback(self) -> None:
        await asyncio.sleep(10)


@pytest.mark.parametrize("status", [TransactionStatus.INTRANS, TransactionStatus.INERROR, TransactionStatus.ACTIVE])
def test_a_checkout_that_is_not_idle_is_closed_at_once_never_waited_on(status: TransactionStatus) -> None:
    conn = Stuck()
    conn.info.transaction_status = status
    started = time.monotonic()
    run(pool_mod._end_checkout(_real(conn)))
    assert conn.closed
    assert time.monotonic() - started < PROMPT_S


class RollbackFails(Conn):
    """The statement fails with `primary`; the ROLLBACK after it fails too (the connection broke meanwhile)."""

    def __init__(self, primary: BaseException) -> None:
        super().__init__(fail=primary)

    async def execute(self, query: str, params: tuple[Any, ...] = ()) -> object:
        if query == "ROLLBACK":
            msg = "connection lost"
            raise psycopg.OperationalError(msg)
        return await super().execute(query, params)


class Refused(psycopg.Error):
    sqlstate = "AR040"


@pytest.mark.parametrize("primary", [Refused("no identity"), asyncio.CancelledError()])
def test_a_failed_rollback_keeps_the_statements_own_error_and_closes_the_connection(primary: BaseException) -> None:
    conn = RollbackFails(primary)
    with pytest.raises(type(primary)) as raised:
        run(one_statement(_real(conn), "select boom"))
    assert raised.value is primary
    assert conn.closed
