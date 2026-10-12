"""`arena_core.db.pool` against a real migrated database (make db-test, after the spend-guard suite): the pooled
connector and `one_statement`'s pipelined transaction keep the semantics of a fresh connection and
`conn.transaction()`: READ COMMITTED, the actor set for that transaction only, errors raised with their SQLSTATE and
the transaction rolled back, the connection's own mode restored, and nothing uncommitted surviving a checkout.
The file name does not match `test_*.py`, so `make test` (no database) never collects it; db-test names it explicitly.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Coroutine
from typing import Any, LiteralString
from uuid import uuid4

import psycopg
import pytest
from psycopg import AsyncConnection, sql
from psycopg.pq import TransactionStatus

from arena_core.db.arena import ArenaDb, ArenaError, SessionStart
from arena_core.db.pool import PooledConnector, one_statement

DSN_VAR = "ARENA_IT_ADMIN_DSN"
ACTOR = "00000000-0000-0000-0000-0000000000aa"


def _on(text: LiteralString, table: str) -> sql.Composed:
    """`text` with `{}` naming this test's own scratch table."""
    return sql.SQL(text).format(sql.Identifier(table))


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def admin_dsn() -> str:
    dsn = os.environ.get(DSN_VAR, "")
    if not dsn:
        msg = f"{DSN_VAR} is not set: this suite runs inside make db-test on a freshly migrated database"
        raise RuntimeError(msg)
    return dsn


async def _rows(conn: AsyncConnection[Any], query: str) -> list[tuple[Any, ...]]:
    cur = await conn.execute(query)
    rows = list(await cur.fetchall())
    await conn.rollback()
    return rows


def test_one_statement_is_one_read_committed_transaction_with_a_transaction_local_actor() -> None:
    async def body() -> None:
        async with await AsyncConnection.connect(admin_dsn(), prepare_threshold=None) as conn:
            cur = await one_statement(
                conn,
                "select current_setting('arena.actor_id', true), current_setting('transaction_isolation'),"
                " txid_current_if_assigned() is null",
                actor=ACTOR,
            )
            assert await cur.fetchall() == [(ACTOR, "read committed", True)]
            assert conn.info.transaction_status == TransactionStatus.IDLE
            assert conn.autocommit is False
            assert await _rows(conn, "select coalesce(current_setting('arena.actor_id', true), '')") == [("",)]

    run(body())


def test_one_statement_commits_a_write_and_rolls_back_a_failed_one() -> None:
    table = f"it_pool_{uuid4().hex[:8]}"

    async def body() -> None:
        async with await AsyncConnection.connect(admin_dsn(), prepare_threshold=None, autocommit=True) as admin:
            await admin.execute(_on("create table public.{} (n int primary key)", table))
            try:
                async with await AsyncConnection.connect(admin_dsn(), prepare_threshold=None) as conn:
                    await one_statement(conn, _on("insert into public.{} values (1)", table))
                    with pytest.raises(psycopg.errors.UniqueViolation):
                        await one_statement(conn, _on("insert into public.{} values (1)", table))
                    assert conn.info.transaction_status == TransactionStatus.IDLE
                    assert conn.autocommit is False
                    with pytest.raises(psycopg.errors.DivisionByZero):
                        await one_statement(conn, _on("insert into public.{} values (1 / 0)", table))
                    cur = await one_statement(conn, _on("select n from public.{}", table))
                    assert await cur.fetchall() == [(1,)]
                cur = await admin.execute(_on("select count(*) from public.{}", table))
                assert await cur.fetchall() == [(1,)]
            finally:
                await admin.execute(_on("drop table public.{}", table))

    run(body())


def test_one_statement_refuses_a_connection_already_in_a_transaction() -> None:
    async def body() -> None:
        async with await AsyncConnection.connect(admin_dsn(), prepare_threshold=None) as conn:
            await conn.execute("select 1")
            with pytest.raises(RuntimeError, match="outside any transaction"):
                await one_statement(conn, "select 2")
            await conn.rollback()

    run(body())


def test_the_pool_rolls_back_whatever_a_checkout_left_uncommitted() -> None:
    table = f"it_pool_{uuid4().hex[:8]}"

    async def body() -> None:
        async with await AsyncConnection.connect(admin_dsn(), prepare_threshold=None, autocommit=True) as admin:
            await admin.execute(_on("create table public.{} (n int)", table))
            pooled = PooledConnector(admin_dsn(), min_size=1, max_size=1)
            try:
                async with pooled() as conn:
                    await conn.execute(_on("insert into public.{} values (1)", table))
                async with pooled() as conn:
                    assert conn.info.transaction_status == TransactionStatus.IDLE
                    cur = await one_statement(conn, "select current_setting('transaction_isolation')")
                    assert await cur.fetchall() == [("read committed",)]
                cur = await admin.execute(_on("select count(*) from public.{}", table))
                assert await cur.fetchall() == [(0,)]
            finally:
                await pooled.close()
                await admin.execute(_on("drop table public.{}", table))

    run(body())


def test_an_s4_refusal_keeps_its_sqlstate_through_the_pooled_path() -> None:
    """`training.start_session` with no investigator identity: AR040, as ArenaDb always reported it."""

    async def body() -> None:
        pooled = PooledConnector(admin_dsn(), min_size=1, max_size=1)
        try:
            db = ArenaDb(pooled, actor=None)
            start = SessionStart(uuid4(), "practice", uuid4(), uuid4(), False, uuid4().hex)
            with pytest.raises(ArenaError) as refused:
                await db.start_session(start)
            assert refused.value.code == "AR040"
            async with pooled() as conn:
                assert conn.info.transaction_status == TransactionStatus.IDLE
                assert conn.autocommit is False
        finally:
            await pooled.close()

    run(body())
