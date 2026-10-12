"""The S4 wrappers (arena_core.db.calls), the database guard client and the budget-plan step, on a stand-in
connection that answers as the S4 functions do. They prove the arguments sent, the parsing (money as Decimal, never
float) and the refusal mapping; tests/db/it_spend_guard.py proves the same paths against the real migrated functions."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Any, cast
from uuid import UUID

import psycopg
import pytest

from arena_core.db import calls, pool
from arena_core.db.calls import GuardProtocolError, ModelCallRequest, UsageReport
from arena_core.db.scripted import ScriptedConnection
from arena_core.providers.errors import BudgetRefusedError, KillSwitchOnError
from arena_core.spend import plan
from arena_core.spend.guard import DbSpendGuard, Reservation, refusal

RID = UUID("11111111-2222-3333-4444-555555555555")
GLOBAL_PLAN: plan.Plan = {"global": (None, Decimal("74.0"))}


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class Cursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self.rows[0] if self.rows else None

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows


class Conn(ScriptedConnection):
    """Answers `select ops.<fn>(...)` with the jsonb text registered for <fn>; records every statement."""

    def __init__(self, answers: dict[str, object]) -> None:
        self.answers: dict[str, Any] = answers
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self.transactions = 0

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.transactions += 1
        yield

    async def statement(self, query: str, params: tuple[object, ...] = ()) -> Cursor:
        self.executed.append((query, params))
        for name, answer in self.answers.items():
            if name in query:
                if isinstance(answer, BaseException):
                    raise answer
                if isinstance(answer, list):
                    return Cursor(answer)
                return Cursor([] if answer is None else [(json.dumps(answer) if isinstance(answer, dict) else answer,)])
        return Cursor([])


def conn(**answers: object) -> tuple[calls.Conn, Conn]:
    fake = Conn({f"ops.{name}": value for name, value in answers.items()})
    return cast("calls.Conn", fake), fake


def model_req(key: str = "k-0000001") -> ModelCallRequest:
    return ModelCallRequest(
        key=key,
        bucket="global",
        model="gemini-3.5-flash-lite",
        call_kind="card",
        purpose="coach.card",
        trial_id=None,
        actor_user_id=None,
        input_bytes=20_000,
    )


def report() -> UsageReport:
    return UsageReport(
        reservation_id=RID,
        seq=1,
        model="gemini-3.5-flash-lite",
        input_tokens=10,
        output_tokens=5,
        thinking_tokens=1,
        status="ok",
        latency_ms=12,
        trace_id=None,
        span_id=None,
    )


# ---------------------------------------------------------------- wrappers


def test_reserve_model_call_sends_sizes_not_amounts_and_parses_money_as_decimal() -> None:
    c, fake = conn(reserve_model_call={"outcome": "reserved", "id": str(RID), "reserved_usd": 0.0436})
    got = run(calls.reserve_model_call(c, model_req()))
    assert (got.outcome, got.reservation_id, got.reserved_usd) == ("reserved", RID, Decimal("0.0436"))
    assert isinstance(got.reserved_usd, Decimal)
    query, params = fake.executed[0]
    assert "ops.reserve_model_call(%s, %s, %s, %s, %s, %s, %s, %s)" in query
    assert params == ("k-0000001", "global", "gemini-3.5-flash-lite", "card", "coach.card", None, None, 20_000)
    assert fake.transactions == 1


def test_an_existing_reservation_reports_its_state_and_dispatch() -> None:
    answer = {"outcome": "exists", "id": str(RID), "reserved_usd": 1, "state": "reserved", "dispatched": True}
    c, _ = conn(reserve_model_call=answer)
    got = run(calls.reserve_model_call(c, model_req()))
    assert (got.outcome, got.state, got.dispatched) == ("exists", "reserved", True)


@pytest.mark.parametrize(
    ("answer", "match"),
    [
        ({"outcome": "maybe"}, "unknown outcome"),
        ([1, 2], "non-object"),
        (None, "no row"),
    ],
)
def test_an_unknown_answer_shape_is_a_protocol_error(answer: object, match: str) -> None:
    raw = answer if not isinstance(answer, list) else json.dumps(answer)
    c, _ = conn(reserve_model_call=raw)
    with pytest.raises(GuardProtocolError, match=match):
        run(calls.reserve_model_call(c, model_req()))


def test_a_non_text_answer_is_a_protocol_error() -> None:
    c, _ = conn(mark_dispatched=[(42,)])
    with pytest.raises(GuardProtocolError, match="expected jsonb"):
        run(calls.mark_dispatched(c, RID))


def test_record_usage_sends_every_token_count_and_reads_shutoff() -> None:
    answer = {
        "outcome": "recorded",
        "cost_usd": 0.000016,
        "spend_usd": 0.000016,
        "reserved_usd": 0.04,
        "shutoff": False,
    }
    c, fake = conn(record_usage=answer)
    got = run(calls.record_usage(c, report()))
    assert (got.cost_usd, got.shutoff) == (Decimal("0.000016"), False)
    assert fake.executed[0][1] == (RID, 1, "gemini-3.5-flash-lite", 10, 5, 1, 0, 0, "ok", 12, None, None)


def test_record_usage_without_an_amount_is_a_protocol_error() -> None:
    c, _ = conn(record_usage={"outcome": "recorded"})
    with pytest.raises(GuardProtocolError, match="missing cost_usd"):
        run(calls.record_usage(c, report()))


def test_settle_and_voice_and_admission_wrappers_parse_their_answers() -> None:
    c, fake = conn(
        settle_reservation={"outcome": "committed", "settled_usd": 0.01},
        reserve_voice={"outcome": "reserved", "id": str(RID), "reserved_usd": 0.42494, "shutoff_usd": 0.283293},
        settle_voice_reservation={"outcome": "already_settled", "state": "committed", "settled_usd": 0.1},
        admit_unit={"decision": "skip", "free_usd": 1, "needed_usd": 2.4, "reason": None},
    )
    assert run(calls.settle_reservation(c, RID, "committed")).settled_usd == Decimal("0.01")
    voice = calls.VoiceRequest(
        key="v-0000001", bucket="global", kind="voice_probe", purpose="voice.probe", trial_id=None, actor_user_id=None
    )
    held = run(calls.reserve_voice(c, voice))
    assert held.shutoff_usd == Decimal("0.283293")
    settled = run(calls.settle_voice_reservation(c, RID, "committed"))
    assert (settled.outcome, settled.state) == ("already_settled", "committed")
    admit = run(calls.admit_unit(c, "global", Decimal("1.6")))
    assert (admit.decision, admit.needed_usd) == ("skip", Decimal("2.4"))
    assert [q.split("(")[0].split()[-1] for q, _ in fake.executed] == [
        "ops.settle_reservation",
        "ops.reserve_voice",
        "ops.settle_voice_reservation",
        "ops.admit_unit",
    ]


def test_settle_with_an_unknown_outcome_is_a_protocol_error() -> None:
    c, _ = conn(settle_reservation={"outcome": "lost", "settled_usd": 0})
    with pytest.raises(GuardProtocolError, match="unknown outcome"):
        run(calls.settle_reservation(c, RID, "committed"))


def test_budget_status_and_the_owner_controls() -> None:
    c, fake = conn(budget_status=[("global", None, Decimal(74), Decimal(1), Decimal("0.5"), Decimal(73), False)])
    [status] = run(calls.budget_status(c))
    assert (status.bucket, status.parent, status.headroom_usd, status.kill_switch) == (
        "global",
        None,
        Decimal(73),
        False,
    )
    run(calls.set_bucket_ceiling(c, name="global", parent=None, ceiling_usd=Decimal(74), note="n"))
    run(calls.set_kill_switch(c, on=True, reason="r"))
    assert fake.executed[1] == ("select ops.set_bucket_ceiling(%s, %s, %s, %s)", ("global", None, Decimal(74), "n"))
    assert fake.executed[2] == ("select ops.set_kill_switch(%s, %s)", (True, "r"))


# ---------------------------------------------------------------- the database guard client


def guard_over(fake: Conn) -> DbSpendGuard:
    @asynccontextmanager
    async def connect() -> AsyncIterator[Any]:
        yield fake

    return DbSpendGuard(connect)


async def in_session(guard: DbSpendGuard, op: str, *args: object) -> object:
    async with guard.session() as session:
        return await getattr(session, op)(*args)


def test_the_guard_maps_a_cap_refusal_to_budget_refused_and_the_kill_switch_to_kill_switch_on() -> None:
    guard = guard_over(Conn({"ops.reserve_model_call": {"outcome": "refused", "reason": "cap"}}))
    with pytest.raises(BudgetRefusedError, match="cap"):
        run(in_session(guard, "reserve", model_req()))
    guard = guard_over(Conn({"ops.reserve_model_call": {"outcome": "refused", "reason": "kill_switch"}}))
    with pytest.raises(KillSwitchOnError):
        run(in_session(guard, "reserve", model_req()))
    assert isinstance(refusal(None), BudgetRefusedError)


def test_the_guard_returns_reservations_and_refuses_one_without_an_id() -> None:
    guard = guard_over(Conn({"ops.reserve_model_call": {"outcome": "reserved", "id": str(RID), "reserved_usd": 1}}))
    found = run(in_session(guard, "reserve", model_req()))
    assert isinstance(found, Reservation)
    assert (found.id, found.existed, found.state) == (RID, False, "reserved")
    guard = guard_over(Conn({"ops.reserve_model_call": {"outcome": "reserved"}}))
    with pytest.raises(GuardProtocolError, match="without id"):
        run(in_session(guard, "reserve", model_req()))


@pytest.mark.parametrize(
    ("answer", "error"),
    [
        ({"outcome": "refused", "reason": "kill_switch"}, KillSwitchOnError),
        ({"outcome": "already_dispatched"}, GuardProtocolError),
    ],
)
def test_dispatch_refusals(answer: dict[str, str], error: type[Exception]) -> None:
    guard = guard_over(Conn({"ops.mark_dispatched": answer}))
    with pytest.raises(error):
        run(in_session(guard, "dispatch", RID))


def test_dispatch_record_and_settle_pass_through() -> None:
    fake = Conn(
        {
            "ops.mark_dispatched": {"outcome": "dispatched"},
            "ops.record_usage": {"outcome": "recorded", "cost_usd": 0, "spend_usd": 0, "reserved_usd": 1},
            "ops.settle_reservation": {"outcome": "committed", "settled_usd": 0},
        }
    )
    guard = guard_over(fake)
    run(in_session(guard, "dispatch", RID))
    recorded = run(in_session(guard, "record", report()))
    assert isinstance(recorded, calls.UsageResult)
    assert recorded.outcome == "recorded"
    assert run(in_session(guard, "settle", RID, "committed")) == Decimal(0)


def test_a_second_settlement_is_refused_by_the_guard() -> None:
    fake = Conn({"ops.settle_reservation": {"outcome": "already_settled", "state": "committed", "settled_usd": 1}})
    with pytest.raises(GuardProtocolError, match="already settled"):
        run(in_session(guard_over(fake), "settle", RID, "usage_unknown"))


# ---------------------------------------------------------------- connections


def test_dsn_connector_opens_read_committed_and_always_closes(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[object] = []

    class FakeConnection:
        async def set_isolation_level(self, level: object) -> None:
            events.append(level)

        async def close(self) -> None:
            events.append("closed")

    async def connect(dsn: str, *, prepare_threshold: object, connect_timeout: object) -> FakeConnection:
        events.append(dsn)
        events.append(("prepare_threshold", prepare_threshold))
        events.append(("connect_timeout", connect_timeout))
        return FakeConnection()

    monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)

    async def use() -> None:
        async with pool.dsn_connector("postgresql://role@127.0.0.1:1/db")():
            raise RuntimeError

    with pytest.raises(RuntimeError):
        run(use())
    assert events == [
        "postgresql://role@127.0.0.1:1/db",
        ("prepare_threshold", None),  # S4 2.2: no prepared statements through the transaction-mode pooler
        ("connect_timeout", pool.CONNECT_TIMEOUT_S),
        psycopg.IsolationLevel.READ_COMMITTED,
        "closed",
    ]


# ---------------------------------------------------------------- the budget plan step (S5 4.4)


def test_apply_plan_sets_every_entry_in_one_transaction() -> None:
    c, fake = conn(set_bucket_ceiling=None)
    run(plan.apply_plan(c, {"global": (None, Decimal(74)), "child": ("global", Decimal(1))}))
    assert [p for _q, p in fake.executed] == [
        ("global", None, Decimal(74), plan.PLAN_NOTE),
        ("child", "global", Decimal(1), plan.PLAN_NOTE),
    ]


@pytest.mark.parametrize(
    ("rows", "problem"),
    [
        ([("global", None, Decimal("74.00"))], None),
        ([("global", None, Decimal("74.01"))], "ceiling 74.01, plan 74.0"),
        ([("global", "root", Decimal(74))], "parent 'root'"),
        ([], "in the plan but not in the database"),
        ([("global", None, Decimal(74)), ("extra", "global", Decimal(0))], "in the database but not in the plan"),
    ],
)
def test_plan_differences_compare_names_parents_and_ceilings_exactly(
    rows: list[tuple[Any, ...]], problem: str | None
) -> None:
    c, _ = conn(v_budget_status=rows)
    found = run(plan.plan_differences(c, GLOBAL_PLAN))
    assert (problem is None and found == []) or (problem is not None and any(problem in f for f in found))


class PlanConn(Conn):
    """A stand-in for the role's connection inside `plan.main`."""


def main_with(monkeypatch: pytest.MonkeyPatch, rows: list[tuple[Any, ...]], argv: list[str]) -> tuple[int, PlanConn]:
    fake = PlanConn({"ops.v_budget_status": rows, "ops.set_bucket_ceiling": None})

    def connector(_dsn: str) -> pool.Connector:
        @asynccontextmanager
        async def connect() -> AsyncIterator[Any]:
            yield fake

        return connect

    monkeypatch.setattr(plan, "dsn_connector", connector)
    code = plan.main(lambda: GLOBAL_PLAN, argv, {"OWNER": "postgresql://owner@127.0.0.1:1/db"})
    return code, fake


def test_main_apply_then_reports_the_applied_plan(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    code, fake = main_with(monkeypatch, [("global", None, Decimal("74.0"))], ["--apply", "--dsn-env", "OWNER"])
    assert code == 0
    assert any("set_bucket_ceiling" in q for q, _ in fake.executed)
    assert "applied: global=74.0" in capsys.readouterr().out


def test_main_check_fails_on_a_one_cent_difference(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    code, fake = main_with(monkeypatch, [("global", None, Decimal("74.01"))], ["--check", "--dsn-env", "OWNER"])
    assert code == 1
    assert not any("set_bucket_ceiling" in q for q, _ in fake.executed)
    assert "ceiling 74.01" in capsys.readouterr().err


def test_main_refuses_a_missing_dsn_and_reports_a_database_refusal(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert plan.main(lambda: GLOBAL_PLAN, ["--check", "--dsn-env", "NOPE"], {}) == 1
    assert "NOPE is not set" in capsys.readouterr().err

    def refused(_dsn: str) -> pool.Connector:
        @asynccontextmanager
        async def connect() -> AsyncIterator[Any]:
            yield Conn({"ops.set_bucket_ceiling": psycopg.errors.RaiseException("below liability")})

        return connect

    monkeypatch.setattr(plan, "dsn_connector", refused)
    assert plan.main(lambda: GLOBAL_PLAN, ["--apply", "--dsn-env", "OWNER"], {"OWNER": "x"}) == 1
    assert "below liability" in capsys.readouterr().err


def test_main_reports_a_broken_plan(capsys: pytest.CaptureFixture[str]) -> None:
    def broken() -> plan.Plan:
        msg = "cost_model.py --plan-json exited 1"
        raise ValueError(msg)

    assert plan.main(broken, ["--check", "--dsn-env", "OWNER"], {"OWNER": "x"}) == 1
    assert "exited 1" in capsys.readouterr().err


class NotReleasable(psycopg.Error):
    sqlstate = "AR001"  # S4: a dispatched hold cannot be released


class Stalls(Conn):
    """A connection whose `ops.mark_dispatched` never answers (the request is cancelled meanwhile)."""

    async def statement(self, query: str, params: tuple[object, ...] = ()) -> Cursor:
        if "ops.mark_dispatched" in query:
            await asyncio.sleep(10)
        return await super().statement(query, params)


def test_a_cancelled_dispatch_still_settles_usage_unknown_on_a_fresh_connection() -> None:
    """S5 4.10 through the real guard client: the request is cancelled during dispatch, then the port's unwind runs
    in the same (cancelled) task: release refused, then usage_unknown. Every failed write closes its connection
    (db.pool.one_statement), so each next write returns that checkout and takes a fresh one; and the earlier
    cancellation never turns the refusal into a cancellation."""
    reserved = {"outcome": "reserved", "id": str(RID), "reserved_usd": 1}
    opened = [
        Stalls({"ops.reserve_model_call": reserved}),
        Conn({"ops.settle_reservation": NotReleasable("dispatched")}),
        Conn({"ops.settle_reservation": {"outcome": "usage_unknown", "settled_usd": 1}}),
    ]
    pending = list(opened)
    slot = asyncio.Semaphore(1)  # a one-connection pool: a closed checkout must be returned before the next one

    @asynccontextmanager
    async def connect() -> AsyncIterator[Any]:
        async with asyncio.timeout(1):
            await slot.acquire()
        try:
            yield pending.pop(0)
        finally:
            slot.release()

    async def body() -> Decimal:
        me = asyncio.current_task()
        assert me is not None
        async with DbSpendGuard(connect).session() as session:
            found = await session.reserve(model_req())
            asyncio.get_running_loop().call_later(0.05, me.cancel)
            with pytest.raises(asyncio.CancelledError):
                await session.dispatch(found.id)
            with pytest.raises(NotReleasable):
                await session.settle(found.id, "released")
            settled = await session.settle(found.id, "usage_unknown")
        me.uncancel()
        return settled

    assert run(body()) == Decimal(1)
    assert [c.closed for c in opened] == [True, True, False]
    assert opened[2].executed[-1][1] == (RID, "usage_unknown")
