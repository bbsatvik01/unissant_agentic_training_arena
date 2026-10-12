"""`arena_core.db.voice` against a scripted connection: the SQL each call sends, the claim-reserve-open transaction
and its refusals (S5 7.2 step 3). `make db-test` runs the same functions against the migrated database
(services/subject voice tests and supabase/tests/015_voice.sql cover the SQL side)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any, cast
from uuid import uuid4

import psycopg
import pytest

from arena_core.db import voice as db_voice
from arena_core.db.calls import Conn
from arena_core.voice.protocol import Start

START = Start(uuid4(), uuid4(), uuid4(), "practice")
RES, VS = uuid4(), uuid4()
ORPHANS = 2


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class Cursor:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn
        self.row: tuple[Any, ...] | None = None

    async def execute(self, query: str, params: tuple[Any, ...] = ()) -> None:
        self.conn.sent.append((query, params))
        answer = self.conn.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        self.row = answer

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self.row


class FakeConn:
    def __init__(self, answers: list[Any]) -> None:
        self.answers = answers
        self.sent: list[tuple[str, tuple[Any, ...]]] = []
        self.transactions = 0
        self.rolled_back = 0

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.transactions += 1
        try:
            yield
        except BaseException:
            self.rolled_back += 1
            raise

    @asynccontextmanager
    async def cursor(self) -> AsyncIterator[Cursor]:
        yield Cursor(self)


def conn(*answers: object) -> tuple[Conn, FakeConn]:
    fake = FakeConn(list(answers))
    return cast("Conn", fake), fake


def test_open_claims_reserves_and_opens_in_one_transaction() -> None:
    c, fake = conn((True,), (json.dumps({"outcome": "reserved", "id": str(RES)}),), (str(VS),))
    opened = run(db_voice.open_voice(c, START))
    assert opened == db_voice.OpenedVoice(VS, RES)
    assert fake.transactions == 1
    assert [q.split("(")[0] for q, _ in fake.sent] == [
        "select training.claim_voice_ticket",
        "select ops.reserve_voice",
        "select training.open_voice_session",
    ]
    assert fake.sent[1][1] == (f"voice:{START.ticket_id}", "global", "voice.session", START.trial_id, START.user_id)


@pytest.mark.parametrize(
    ("answers", "code"),
    [
        ([(False,)], 4401),
        ([(True,), (json.dumps({"outcome": "refused", "reason": "per_user_cap"}),)], 4413),
        ([(True,), (json.dumps({"outcome": "reserved", "id": str(RES)}),), (None,)], 4401),
        ([(True,), (json.dumps({"outcome": "reserved", "id": str(RES)}),), psycopg.errors.RaiseException("q")], 4401),
    ],
)
def test_a_refused_open_rolls_back_with_its_close_code(answers: list[Any], code: int) -> None:
    c, fake = conn(*answers)
    with pytest.raises(db_voice.VoiceOpenRefusedError) as info:
        run(db_voice.open_voice(c, START))
    assert info.value.code == code
    assert fake.rolled_back == 1


def test_context_exchange_close_and_orphans_send_their_functions() -> None:
    c, fake = conn(
        (json.dumps({"voice_exchanges": []}),),
        (json.dumps({"outcome": "recorded", "released": [{"record_id": "rec-02", "kind": "record"}]}),),
        (None,),
        (ORPHANS,),
    )
    assert run(db_voice.voice_context(c, VS)) == {"voice_exchanges": []}
    lines = [{"role": "investigator", "text": "Where?", "partial": False}]
    assert run(db_voice.record_exchange(c, VS, 1, lines)) == ["rec-02"]
    run(db_voice.close_voice(c, VS, "guard:G3"))
    assert run(db_voice.close_orphans(c)) == ORPHANS
    assert [q.split("(")[0] for q, _ in fake.sent] == [
        "select subject.voice_context",
        "select training.record_voice_exchange",
        "select training.close_voice_session",
        "select training.close_orphan_voice_sessions",
    ]
    assert fake.sent[2][1] == (VS, "guard:G3")


def test_a_non_object_answer_is_refused() -> None:
    c, _ = conn((json.dumps([1]),))
    with pytest.raises(TypeError):
        run(db_voice.voice_context(c, VS))
