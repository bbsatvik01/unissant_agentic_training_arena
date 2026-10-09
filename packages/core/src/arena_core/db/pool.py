"""Database connections for a role (S5 6.4).

WP-05 lands the one piece the spend guard needs: `Connector`, a factory of async connections, and `dsn_connector`,
which opens a fresh READ COMMITTED connection per use on the role's own DSN (S4 functions refuse any other isolation
level), with prepared statements off (S4 2.2: the pooler runs in transaction mode). The pooled connector and the
LISTEN connection land with the services that need them (WP-13).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any

from psycopg import AsyncConnection, IsolationLevel

Connector = Callable[[], AbstractAsyncContextManager[AsyncConnection[Any]]]


def dsn_connector(dsn: str) -> Connector:
    """A connector that opens one connection on ``dsn`` per use and closes it afterwards."""

    @asynccontextmanager
    async def connect() -> AsyncIterator[AsyncConnection[Any]]:
        # S4 2.2: no prepared statements (Supavisor transaction mode does not keep them across transactions).
        conn = await AsyncConnection.connect(dsn, prepare_threshold=None)
        try:
            await conn.set_isolation_level(IsolationLevel.READ_COMMITTED)
            yield conn
        finally:
            await conn.close()

    return connect
