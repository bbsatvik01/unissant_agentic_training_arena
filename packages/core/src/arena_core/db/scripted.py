"""`ScriptedConnection`: the transaction-control surface of a psycopg `AsyncConnection` for scripted test
connections (the pattern of `providers.fake`: test doubles live next to what they stand in for).

`db.pool.one_statement` drives a real connection with `info.transaction_status`, `autocommit`, `set_autocommit`,
`pipeline()` and the statements `BEGIN ISOLATION LEVEL READ COMMITTED`, `COMMIT` and `ROLLBACK`. A scripted
connection inherits this class and answers its own statements in `statement()`; the control statements are mapped
onto the subclass's own `transaction()` (entered on BEGIN, left on COMMIT or ROLLBACK), so a test that counts or
records transactions sees one per `one_statement` call, exactly as with `conn.transaction()`, and no control
statement ever reaches the recorded statements.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Any

from psycopg import IsolationLevel
from psycopg.pq import TransactionStatus

BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED"


@dataclass
class _Info:
    transaction_status: TransactionStatus = TransactionStatus.IDLE


class ScriptedConnection:
    """Mixin: subclasses implement `statement(query, params)` and `transaction()`."""

    autocommit: bool = False
    isolation_level: IsolationLevel | None = IsolationLevel.READ_COMMITTED
    read_only: bool | None = None
    deferrable: bool | None = None
    closed: bool = False
    _begun: list[str] | None = None

    @property
    def begun(self) -> list[str]:
        """Every BEGIN statement sent, in order."""
        if self._begun is None:
            self._begun = []
        return self._begun

    _tx: AbstractAsyncContextManager[Any] | None = None
    _info: _Info | None = None

    @property
    def info(self) -> _Info:
        if self._info is None:
            self._info = _Info()
        return self._info

    def transaction(self) -> AbstractAsyncContextManager[Any]:
        raise NotImplementedError

    async def statement(self, query: str, params: tuple[Any, ...] = ()) -> object:
        raise NotImplementedError

    async def set_autocommit(self, value: bool) -> None:
        self.autocommit = value

    @asynccontextmanager
    async def pipeline(self) -> AsyncIterator[None]:
        yield

    async def close(self) -> None:
        self.closed = True

    async def rollback(self) -> None:
        if self._tx is not None:
            await self._end(failed=True)

    async def _end(self, *, failed: bool) -> None:
        tx, self._tx = self._tx, None
        self.info.transaction_status = TransactionStatus.IDLE
        if tx is not None:
            if failed:
                await tx.__aexit__(RuntimeError, RuntimeError("rolled back"), None)
            else:
                await tx.__aexit__(None, None, None)

    async def execute(self, query: str, params: tuple[Any, ...] = ()) -> object:
        if query.startswith("BEGIN"):
            self.begun.append(query)
            self._tx = self.transaction()
            await self._tx.__aenter__()
            self.info.transaction_status = TransactionStatus.INTRANS
            return None
        if query in ("COMMIT", "ROLLBACK"):
            await self._end(failed=query == "ROLLBACK")
            return None
        try:
            return await self.statement(query, params)
        except BaseException:
            if self._tx is not None:
                self.info.transaction_status = TransactionStatus.INERROR
            raise
