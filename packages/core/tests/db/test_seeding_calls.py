"""Fake-connection unit tests for the owner-credential seeding wrappers (S1 10.5, S2 3.1, S4 2.3;
`scripts/seed_hosted.py`): the exact SQL text and parameter shape each one sends. The real functions, against
a migrated database with a real `auth` schema, run in db-test (`packages/core/tests/db/it_seed_hosted.py`)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any, cast
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from arena_core.db import calls
from arena_core.db.calls import GuardProtocolError


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class _Cursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self.rows[0] if self.rows else None


class _Conn:
    """A scripted stand-in for `calls.Conn` (a concrete `AsyncConnection`, not a protocol): cast at the call
    site, exactly as `test_arena_calls.py`'s `Script.connector()` casts its own fake (no real DB here)."""

    def __init__(self, rows: list[tuple[Any, ...]] | None = None) -> None:
        self.rows = rows if rows is not None else []
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self.transactions = 0

    async def execute(self, query: str, params: tuple[object, ...] = ()) -> _Cursor:
        self.executed.append((query, params))
        return _Cursor(self.rows)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.transactions += 1
        yield


def c(conn: _Conn) -> calls.Conn:
    return cast("calls.Conn", conn)


def test_ingest_case_family_sends_the_bundle_as_one_jsonb_argument_and_returns_the_id() -> None:
    family_id = uuid4()
    conn = _Conn([(family_id,)])
    result = run(calls.ingest_case_family(c(conn), {"family_code": "F01", "variants": []}))
    assert result == family_id
    assert conn.transactions == 1
    [(query, params)] = conn.executed
    assert "sealed.ingest_case_family" in query
    assert len(params) == 1
    assert isinstance(params[0], Jsonb)


def test_ingest_case_family_refuses_a_missing_row() -> None:
    with pytest.raises(GuardProtocolError):
        run(calls.ingest_case_family(c(_Conn([])), {}))


def test_register_candidate_sends_kind_name_version_positionally_and_the_manifest_as_jsonb() -> None:
    candidate_id = uuid4()
    conn = _Conn([(candidate_id,)])
    manifest = {"candidate_id": "A1", "kind": "assistant", "version": "1.0.0"}
    result = run(calls.register_candidate(c(conn), kind="assistant", name="A1", version="1.0.0", manifest=manifest))
    assert result == candidate_id
    [(query, params)] = conn.executed
    assert "arena.register_candidate" in query
    assert params[:3] == ("assistant", "A1", "1.0.0")
    assert isinstance(params[3], Jsonb)


def test_register_candidate_refuses_a_missing_row() -> None:
    with pytest.raises(GuardProtocolError):
        run(calls.register_candidate(c(_Conn([])), kind="assistant", name="A1", version="1.0.0", manifest={}))


def test_allowlist_user_inserts_the_id_and_email_once_and_commits() -> None:
    conn = _Conn()
    uid = uuid4()
    run(calls.allowlist_user(c(conn), user_id=uid, email="dev@arena.local"))
    assert conn.transactions == 1
    [(query, params)] = conn.executed
    assert "insert into auth.users" in query
    assert "on conflict (id) do nothing" in query
    assert params == (uid, "dev@arena.local")
