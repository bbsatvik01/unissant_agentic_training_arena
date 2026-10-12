"""Database connections for a role (S5 6.4).

`Connector` is a factory of async READ COMMITTED connections on the role's own DSN (S4 functions refuse any other
isolation level), with prepared statements off (S4 2.2: the pooler runs in transaction mode).

- `dsn_connector` opens a fresh connection per use and closes it afterwards (one-shot scripts and tests).
- `PooledConnector` is what a role process uses: one small `psycopg_pool.AsyncConnectionPool`, opened on first use in
  the serving event loop. Against the hosted project a new connection costs about 0.6 s (TLS and auth) and a turn
  ran about 25 short transactions, so connecting per call was most of a turn's wall time (real pilot). A connection
  goes back to the pool exactly as `dsn_connector` would have left it closed: anything uncommitted is rolled back.
- `one_statement` runs one statement in its own transaction (optionally as an actor) in one network round trip:
  BEGIN (with the connection's own isolation level and options, READ COMMITTED for a role), the actor's
  transaction-local `set_config`, the statement and COMMIT are pipelined. The server sees the same statements in the
  same transaction as `conn.transaction()` sends them, in one round trip instead of four.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any

from psycopg import AsyncConnection, AsyncCursor, IsolationLevel, sql
from psycopg.pq import TransactionStatus
from psycopg_pool import AsyncConnectionPool

CONNECT_TIMEOUT_S = 5
Connector = Callable[[], AbstractAsyncContextManager[AsyncConnection[Any]]]

# Sized for one role process serving one or two investigators (S5 10; D-016): a turn holds at most a few connections
# at once (the request, the spend guard's session, an event stream poll). The pool waits as long as a fresh connect
# may take before refusing; idle connections above the minimum are closed after a minute, and every connection is
# replaced after ten minutes so a connection the network silently dropped does not live long.
POOL_MIN = 1
POOL_MAX = 6
POOL_MAX_IDLE_S = 60.0
POOL_MAX_LIFETIME_S = 600.0


def dsn_connector(dsn: str) -> Connector:
    """A connector that opens one connection on ``dsn`` per use and closes it afterwards."""

    @asynccontextmanager
    async def connect() -> AsyncIterator[AsyncConnection[Any]]:
        # S4 2.2: no prepared statements (Supavisor transaction mode does not keep them across transactions).
        # A stalled server is bounded too (libpq connect_timeout); the port bounds the whole session open as well.
        conn = await AsyncConnection.connect(dsn, prepare_threshold=None, connect_timeout=CONNECT_TIMEOUT_S)
        try:
            await conn.set_isolation_level(IsolationLevel.READ_COMMITTED)
            yield conn
        finally:
            await conn.close()

    return connect


def _status(conn: AsyncConnection[Any]) -> TransactionStatus:
    """Read afresh at each use (it changes with every statement)."""
    return conn.info.transaction_status


async def _end_checkout(conn: AsyncConnection[Any]) -> None:
    """Leave a connection as closing a fresh one would have. A connection that is not idle (a transaction its user
    left open, or a statement still running: a cancelled or abandoned one may hold its lock) is closed at once,
    which the server rolls back; nothing here waits on it, and the pool replaces it. An idle one gets its own
    transaction mode back."""
    if _status(conn) != TransactionStatus.IDLE:
        await conn.close()
        return
    if conn.autocommit:
        await conn.set_autocommit(False)


async def _configure(conn: AsyncConnection[Any]) -> None:
    await conn.set_isolation_level(IsolationLevel.READ_COMMITTED)


class PooledConnector:
    """A `Connector` over one `AsyncConnectionPool` per role process, opened lazily in the running event loop."""

    def __init__(self, dsn: str, *, min_size: int = POOL_MIN, max_size: int = POOL_MAX) -> None:
        self._dsn = dsn
        self._min, self._max = min_size, max_size
        self._pool: AsyncConnectionPool[AsyncConnection[Any]] | None = None
        self._lock: asyncio.Lock | None = None

    async def _get(self) -> AsyncConnectionPool[AsyncConnection[Any]]:
        if self._pool is not None:
            return self._pool
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._pool is None:
                pool: AsyncConnectionPool[AsyncConnection[Any]] = AsyncConnectionPool(
                    self._dsn,
                    min_size=self._min,
                    max_size=self._max,
                    kwargs={"prepare_threshold": None, "connect_timeout": CONNECT_TIMEOUT_S},
                    configure=_configure,
                    timeout=CONNECT_TIMEOUT_S,
                    max_idle=POOL_MAX_IDLE_S,
                    max_lifetime=POOL_MAX_LIFETIME_S,
                    open=False,
                )
                await pool.open()
                self._pool = pool
        return self._pool

    @asynccontextmanager
    async def _connection(self) -> AsyncIterator[AsyncConnection[Any]]:
        pool = await self._get()
        async with pool.connection() as conn:
            try:
                yield conn
            finally:
                await _end_checkout(conn)

    def __call__(self) -> AbstractAsyncContextManager[AsyncConnection[Any]]:
        return self._connection()

    async def close(self) -> None:
        if self._pool is not None:
            pool, self._pool = self._pool, None
            await pool.close()


async def close_connector(connect: Connector) -> None:
    """Close a role process's pool at shutdown; a per-use connector has nothing to close."""
    if isinstance(connect, PooledConnector):
        await connect.close()


@asynccontextmanager
async def closing_lifespan(connect: Connector, _app: object = None) -> AsyncIterator[None]:
    """A FastAPI lifespan body that closes the role's pool when the server stops."""
    try:
        yield
    finally:
        await close_connector(connect)


def begin_statement(conn: AsyncConnection[Any]) -> str:
    """The BEGIN psycopg itself sends for this connection (`isolation_level`, `read_only`, `deferrable`), so the
    pipelined transaction runs with exactly the settings `conn.transaction()` would use: a role connection is READ
    COMMITTED, and a connection set to anything else still reaches S4's own refusal of it."""
    parts = ["BEGIN"]
    if conn.isolation_level is not None:
        parts.append("ISOLATION LEVEL " + IsolationLevel(conn.isolation_level).name.replace("_", " "))
    if conn.read_only is not None:
        parts.append("READ ONLY" if conn.read_only else "READ WRITE")
    if conn.deferrable is not None:
        parts.append("DEFERRABLE" if conn.deferrable else "NOT DEFERRABLE")
    return " ".join(parts)


async def one_statement(
    conn: AsyncConnection[Any], query: str | sql.Composed, params: Sequence[object] = (), *, actor: str | None = None
) -> AsyncCursor[Any]:
    """`query` in its own transaction (`begin_statement`: READ COMMITTED on a role connection), as `actor` when
    given (`set_config('arena.actor_id', ..., true)`, S4 2.3), in one round trip. Returns the cursor with the
    statement's rows already received. Any error is raised here as the statement raised it (a cancellation as a
    cancellation), and the connection is closed: the server rolls the transaction back and the pool replaces it."""
    if not conn.closed and _status(conn) != TransactionStatus.IDLE:
        msg = "one_statement needs a connection outside any transaction"
        raise RuntimeError(msg)
    # A closed connection (an earlier call failed on it) falls through to psycopg's own OperationalError below.
    task = asyncio.current_task()
    cancels_before = task.cancelling() if task is not None else 0
    autocommit = conn.autocommit
    await conn.set_autocommit(True)  # psycopg sends no BEGIN of its own: the block below names it
    try:
        async with conn.pipeline():
            await conn.execute(begin_statement(conn))
            if actor is not None:
                await conn.execute("select set_config('arena.actor_id', %s, true)", (actor,))
            cur = await conn.execute(query, params)
            await conn.execute("COMMIT")
    except BaseException as exc:
        # A failed or interrupted call never hands its connection back: a cancellation can land while the batch is
        # still on the wire (psycopg then fails to leave pipeline mode, "cannot exit pipeline mode while busy",
        # and that error replaces the cancellation), so what the connection still holds is unknown. Closing it ends
        # the transaction on the server (rolled back) and the pool replaces it.
        await conn.close()
        # Cancelled during this call (not an earlier cancellation its caller is already cleaning up after): that
        # cancellation, not the pipeline's own error, is what propagates.
        if task is not None and task.cancelling() > cancels_before and not isinstance(exc, asyncio.CancelledError):
            raise asyncio.CancelledError from exc
        raise
    finally:
        if _status(conn) == TransactionStatus.IDLE:
            await conn.set_autocommit(autocommit)
    return cur
