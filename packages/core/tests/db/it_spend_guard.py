"""Spend-guard integration suite (S5 3.6, 4.10; S2 AT-PORT-2, AT-PORT-4; D-012): the agent port and the guard client
against the REAL migrated S4 functions. `make db-test` runs it as its last step on the disposable Supabase Postgres
container it has just migrated (supabase/tests/harness/db_test.sh), with ARENA_IT_ADMIN_DSN naming that database's
admin; the port talks to the database through the three runtime roles (`set role`, as the pgTAP suite does), and the
model is always the zero-spend fake adapter: no test here can reach Vertex.

The tests run in file order on one database and each leaves the ledger consistent for the next: the first proves the
fail-closed $0 seed, later ones raise the ceiling to exactly what they need above the liability already held.
The file name does not match `test_*.py`, so `make test` (no database) never collects it; db-test names it explicitly.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import secrets
from collections.abc import AsyncIterator, Coroutine
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from decimal import Decimal
from pathlib import Path
from subprocess import CompletedProcess
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Tracer
from psycopg import AsyncConnection, sql
from psycopg.conninfo import make_conninfo
from pydantic import BaseModel, Field

from arena_core.db import calls
from arena_core.db.calls import GuardProtocolError, ModelCallRequest
from arena_core.db.pool import Connector, dsn_connector
from arena_core.providers.errors import (
    BudgetRefusedError,
    ErrorKind,
    InputTooLargeError,
    KillSwitchOnError,
    ProviderCallError,
    ProviderFailedError,
    StepInProgressError,
)
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.providers.types import AgentCall, AgentResult, CallContext, Message, Usage, request_bytes
from arena_core.spend import rates
from arena_core.spend.guard import DbSpendGuard, GuardSession, Reservation
from arena_core.spend.limits import ATTEMPTS, REPAIR_BYTES, CallType, ThinkingLevel, VertexModel
from arena_core.spend.memory import RunBudget
from tools import proc
from tools.check_cost_parity import parse_plan_json, run_plan_json

REPO_ROOT = Path(__file__).resolve().parents[4]
DSN_VAR = "ARENA_IT_ADMIN_DSN"
MODEL = VertexModel.FLASH_LITE_35
VALID = '{"verdict": "ok", "note": "fine"}'
USAGE = Usage(input_tokens=1_200, output_tokens=300, thinking_tokens=40)
TWO_SENDS = 2
PARALLEL, ROOM_FOR = 50, 10


class Reply(BaseModel):
    verdict: str = Field(max_length=10)
    note: str = Field(max_length=40)


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


@pytest.fixture(scope="module")
def admin_dsn() -> str:
    dsn = os.environ.get(DSN_VAR, "")
    if not dsn:
        msg = f"{DSN_VAR} is not set: this suite runs inside make db-test on a freshly migrated database"
        raise RuntimeError(msg)
    for role in sorted(RUNTIME_ROLES):  # logins exist before any test opens an event loop
        role_connector(dsn, role)
    return dsn


_ROLE_DSNS: dict[str, str] = {}
RUNTIME_ROLES = frozenset({"arena_public", "arena_subject", "arena_referee"})


def role_connector(admin: str, role: str) -> Connector:
    """The production connector (`dsn_connector`) logged in AS the runtime role, exactly as a role process connects
    (invoker_role() then reads session_user). The S4 roles are NOLOGIN; on this disposable database only, the admin
    gives each a login with a random password the first time a test needs it (S4-D4: the owner does this on the real
    project)."""
    if role not in RUNTIME_ROLES:
        msg = f"{role} is not a runtime role"
        raise ValueError(msg)
    if role not in _ROLE_DSNS:
        password = secrets.token_hex(24)

        async def grant_login() -> None:
            async with await AsyncConnection.connect(admin) as conn:
                await conn.execute(
                    sql.SQL("alter role {} login password {}").format(sql.Identifier(role), sql.Literal(password))
                )
                await conn.commit()

        run(grant_login())
        _ROLE_DSNS[role] = make_conninfo(admin, user=role, password=password)
    return dsn_connector(_ROLE_DSNS[role])


async def admin_rows(dsn: str, query: str, params: tuple[object, ...] = ()) -> list[tuple[Any, ...]]:
    async with await AsyncConnection.connect(dsn) as conn:
        cur = await conn.execute(query, params)
        rows = await cur.fetchall()
        await conn.commit()
        return rows


async def admin_exec(dsn: str, query: str, params: tuple[object, ...] = ()) -> None:
    async with await AsyncConnection.connect(dsn) as conn:
        await conn.execute(query, params)
        await conn.commit()


async def liability(dsn: str) -> Decimal:
    rows = await admin_rows(dsn, "select liability_usd from ops.budget_status() where bucket = 'global'")
    return Decimal(rows[0][0])


async def open_ceiling(dsn: str, headroom: Decimal) -> Decimal:
    """Set `global` to the current liability plus ``headroom``; return the new ceiling."""
    ceiling = await liability(dsn) + headroom
    await admin_exec(dsn, "select ops.set_bucket_ceiling('global', null, %s, 'integration test')", (ceiling,))
    return ceiling


async def reservation_row(dsn: str, rid: UUID) -> dict[str, Any]:
    rows = await admin_rows(
        dsn,
        "select bucket, input_bytes, purpose, reserved_usd, state, settled_usd, dispatched_at is not null, caller_role,"
        " idempotency_key from ops.budget_reservations where id = %s",
        (rid,),
    )
    keys = ("bucket", "input_bytes", "purpose", "reserved_usd", "state", "settled_usd", "dispatched", "role", "key")
    return dict(zip(keys, rows[0], strict=True))


async def call_rows(dsn: str, rid: UUID) -> list[tuple[Any, ...]]:
    return await admin_rows(
        dsn,
        "select seq, input_tokens, output_tokens, cost_usd, status, trace_id, span_id from ops.model_calls"
        " where reservation_id = %s order by seq",
        (rid,),
    )


def card_call(step_key: str, text: str = "Rate this turn.") -> AgentCall[Reply]:
    return AgentCall(
        model=MODEL,
        thinking=ThinkingLevel.MINIMAL,
        system="You are a coach. Reply with the JSON object only.",
        messages=(Message("user", text),),
        schema=Reply,
        context=CallContext(call_type=CallType.CARD, purpose="coach.card", step_key=step_key),
    )


def port(dsn: str, adapter: FakeAdapter, tracer: Tracer | None = None) -> AgentPort:
    guard = DbSpendGuard(role_connector(dsn, "arena_public"))
    return AgentPort(adapter, guard, PortOptions(sleep=_no_sleep, tracer=tracer))


async def _no_sleep(_seconds: float) -> None:
    return None


def step() -> str:
    return f"it-step:{uuid4()}"


def expected_bytes(call: AgentCall[Reply]) -> int:
    """What the port reserves: the first request's serialized bytes plus REPAIR_BYTES (D11)."""
    probe = FakeAdapter(script=[VALID])
    run(AgentPort(probe, RunBudget(Decimal(1000)), PortOptions()).run(call))
    return request_bytes(probe.requests[0]) + REPAIR_BYTES


# ---------------------------------------------------------------- 1. fail-closed seed (D-012)


def test_the_fresh_ceiling_is_zero_and_a_card_is_refused_with_cap_and_writes_nothing(admin_dsn: str) -> None:
    rows = run(admin_rows(admin_dsn, "select bucket, parent, ceiling_usd from ops.v_budget_status"))
    assert rows == [("global", None, Decimal(0))]
    adapter = FakeAdapter(script=[VALID], usage=USAGE)
    with pytest.raises(BudgetRefusedError) as refused:
        run(port(admin_dsn, adapter).run(card_call(step())))
    assert refused.value.reason == "cap"
    assert adapter.requests == []
    assert run(admin_rows(admin_dsn, "select count(*) from ops.model_calls")) == [(0,)]
    assert run(admin_rows(admin_dsn, "select count(*) from ops.budget_reservations")) == [(0,)]


# ---------------------------------------------------------------- 2. reservation and settlement (S5 3.6, AT-PORT-2)


def test_a_call_reserves_its_measured_bytes_dispatches_records_one_row_and_settles_committed(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    call = card_call(step(), "Ünïcödé question: was the door open? ✓")
    adapter = FakeAdapter(script=[VALID], usage=USAGE)
    result = run(port(admin_dsn, adapter, tracer=provider.get_tracer("it")).run(call))
    assert result.value == Reply(verdict="ok", note="fine")
    row = run(reservation_row(admin_dsn, result.reservation_id))
    measured = request_bytes(adapter.requests[0]) + REPAIR_BYTES
    assert row["input_bytes"] == measured  # bytes of the request actually sent, plus the repair allowance
    assert row["reserved_usd"] == rates.model_call_reservation(MODEL, CallType.CARD, measured)  # AT-PORT-2
    assert row["reserved_usd"] <= rates.model_call_reservation(MODEL, CallType.CARD, 128_000)
    assert (row["bucket"], row["purpose"], row["role"], row["dispatched"]) == (
        "global",
        "coach.card",
        "arena_public",
        True,
    )
    want_cost = rates.receipt_usd(MODEL, USAGE.input_tokens, USAGE.output_tokens)
    assert (row["state"], row["settled_usd"], result.cost_usd) == ("committed", want_cost, want_cost)
    rows = run(call_rows(admin_dsn, result.reservation_id))
    [span] = exporter.get_finished_spans()
    assert span.name == "llm.card"
    ctx = span.get_span_context()
    assert ctx is not None
    assert rows == [(1, 1_200, 300, want_cost, "ok", f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}")]


def test_a_repair_writes_one_row_per_attempt_under_one_reservation(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    adapter = FakeAdapter(script=["not json", VALID], usage=USAGE)
    result = run(port(admin_dsn, adapter).run(card_call(step())))
    assert result.attempts == TWO_SENDS
    rows = run(call_rows(admin_dsn, result.reservation_id))
    assert [r[0] for r in rows] == [1, 2]
    assert run(reservation_row(admin_dsn, result.reservation_id))["state"] == "committed"


def test_an_attempt_billed_without_usage_settles_usage_unknown_at_the_full_hold(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    adapter = FakeAdapter(script=[VALID], usage=None)
    result = run(port(admin_dsn, adapter).run(card_call(step())))
    row = run(reservation_row(admin_dsn, result.reservation_id))
    assert (row["state"], row["settled_usd"]) == ("usage_unknown", row["reserved_usd"])
    assert result.cost_usd == row["reserved_usd"]


def test_a_transient_failure_past_the_cap_makes_four_rows_and_settles(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    unavailable = [ProviderCallError(ErrorKind.TRANSIENT, "HTTP 503", status=503) for _ in range(5)]
    adapter = FakeAdapter(script=list(unavailable), usage=USAGE)
    key = step()
    with pytest.raises(ProviderFailedError, match="after 4 attempt"):
        run(port(admin_dsn, adapter).run(card_call(key)))
    assert len(adapter.requests) == ATTEMPTS
    rows = run(
        admin_rows(admin_dsn, "select state from ops.budget_reservations where idempotency_key = %s", (f"{key}:1",))
    )
    assert rows == [("committed",)]


# ---------------------------------------------------------------- 3. refusal at the ceiling, input bound


def test_the_guard_refuses_the_call_that_would_pass_the_ceiling(admin_dsn: str) -> None:
    call = card_call(step())
    one = rates.model_call_reservation(MODEL, CallType.CARD, expected_bytes(call))
    run(open_ceiling(admin_dsn, one))  # room for exactly one hold
    first = FakeAdapter(script=[VALID], usage=Usage())  # settles at $0 receipts
    blocker = FakeAdapter(script=[VALID], usage=None)  # usage_unknown: keeps its full hold
    run(port(admin_dsn, blocker).run(call))
    second = card_call(step())
    with pytest.raises(BudgetRefusedError) as refused:
        run(port(admin_dsn, first).run(second))
    assert refused.value.reason == "cap"
    assert first.requests == []
    status = run(admin_rows(admin_dsn, "select ceiling_usd, liability_usd from ops.budget_status()"))
    assert status[0][1] <= status[0][0]  # liability never above the ceiling


def test_an_oversized_request_is_refused_before_any_reservation_row(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    before = run(admin_rows(admin_dsn, "select count(*) from ops.budget_reservations"))
    adapter = FakeAdapter(script=[VALID])
    with pytest.raises(InputTooLargeError, match="input_over_limit"):
        run(port(admin_dsn, adapter).run(card_call(step(), "x" * 128_000)))
    assert run(admin_rows(admin_dsn, "select count(*) from ops.budget_reservations")) == before
    assert adapter.requests == []


def test_fifty_parallel_reservations_with_room_for_ten_admit_exactly_ten(admin_dsn: str) -> None:
    input_bytes = 20_000
    amount = rates.model_call_reservation(MODEL, CallType.CARD, input_bytes)
    run(open_ceiling(admin_dsn, amount * ROOM_FOR))
    connect = role_connector(admin_dsn, "arena_public")

    async def one(i: int) -> str:
        async with connect() as conn:
            req = ModelCallRequest(
                key=f"it-par:{uuid4()}:{i}",
                bucket="global",
                model=MODEL.value,
                call_kind="card",
                purpose="coach.card",
                trial_id=None,
                actor_user_id=None,
                input_bytes=input_bytes,
            )
            return (await calls.reserve_model_call(conn, req)).outcome

    async def all_of() -> list[str]:
        return await asyncio.gather(*(one(i) for i in range(PARALLEL)))

    outcomes = run(all_of())
    assert outcomes.count("reserved") == ROOM_FOR
    assert outcomes.count("refused") == PARALLEL - ROOM_FOR


# ---------------------------------------------------------------- 4. kill switch (S5 4.8, 4.10)


def test_with_the_kill_switch_on_a_call_is_refused_and_no_row_is_written(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    before = run(admin_rows(admin_dsn, "select count(*) from ops.model_calls"))
    run(admin_exec(admin_dsn, "select ops.set_kill_switch(true, 'integration test')"))
    try:
        adapter = FakeAdapter(script=[VALID], usage=USAGE)
        with pytest.raises(KillSwitchOnError):
            run(port(admin_dsn, adapter).run(card_call(step())))
        assert adapter.requests == []
        assert run(admin_rows(admin_dsn, "select count(*) from ops.model_calls")) == before
    finally:
        run(admin_exec(admin_dsn, "select ops.set_kill_switch(false, 'integration test done')"))


class _KillAfterReserve:
    """The real guard, with the kill switch turned on between the reservation and the dispatch."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._inner = DbSpendGuard(role_connector(dsn, "arena_public"))
        self.reserved: list[UUID] = []

    @asynccontextmanager
    async def _open(self) -> AsyncIterator[GuardSession]:
        async with self._inner.session() as session:
            outer = self

            class Flip:
                async def reserve(self, req: ModelCallRequest) -> Reservation:
                    found = await session.reserve(req)
                    outer.reserved.append(found.id)
                    await admin_exec(outer._dsn, "select ops.set_kill_switch(true, 'flip at dispatch')")
                    return found

                dispatch = session.dispatch
                record = session.record
                settle = session.settle

            yield Flip()

    def session(self) -> AbstractAsyncContextManager[GuardSession]:
        return self._open()


def test_a_kill_switch_turned_on_before_dispatch_releases_the_hold_and_sends_nothing(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    guard = _KillAfterReserve(admin_dsn)
    adapter = FakeAdapter(script=[VALID], usage=USAGE)
    try:
        with pytest.raises(KillSwitchOnError):
            run(AgentPort(adapter, guard, PortOptions(sleep=_no_sleep)).run(card_call(step())))
    finally:
        run(admin_exec(admin_dsn, "select ops.set_kill_switch(false, 'integration test done')"))
    assert adapter.requests == []
    row = run(reservation_row(admin_dsn, guard.reserved[0]))
    assert (row["state"], row["settled_usd"], row["dispatched"]) == ("released", Decimal(0), False)


# ---------------------------------------------------------------- 5. ownership, settle-once, recovery


def test_another_role_cannot_settle_or_record_on_a_reservation_it_did_not_make(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))

    async def scenario() -> None:
        async with role_connector(admin_dsn, "arena_subject")() as subject:
            req = ModelCallRequest(
                key=f"it-own:{uuid4()}",
                bucket="global",
                model=MODEL.value,
                call_kind="subject",
                purpose="subject.answer",
                trial_id=None,
                actor_user_id=None,
                input_bytes=10_000,
            )
            made = await calls.reserve_model_call(subject, req)
            assert made.reservation_id is not None
            rid = made.reservation_id
        async with role_connector(admin_dsn, "arena_public")() as public:
            for attempt in (calls.mark_dispatched(public, rid), calls.settle_reservation(public, rid, "released")):
                with pytest.raises(psycopg.Error) as refused:
                    await attempt
                assert refused.value.sqlstate == "AR040"
            with pytest.raises(psycopg.Error) as no_grant:
                await calls.settle_voice_reservation(public, rid, "released")
            assert no_grant.value.sqlstate == "42501"

    run(scenario())


def test_a_second_settlement_is_refused(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    result = run(port(admin_dsn, FakeAdapter(script=[VALID], usage=USAGE)).run(card_call(step())))
    guard = DbSpendGuard(role_connector(admin_dsn, "arena_public"))

    async def again() -> None:
        async with guard.session() as session:
            await session.settle(result.reservation_id, "usage_unknown")

    with pytest.raises(GuardProtocolError, match="already settled"):
        run(again())
    assert run(reservation_row(admin_dsn, result.reservation_id))["state"] == "committed"


def test_a_restarted_call_settles_its_dispatched_hold_usage_unknown_and_reserves_the_next_key(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    key = step()
    call = card_call(key)
    nbytes = expected_bytes(call)

    async def crashed_after_dispatch() -> UUID:
        async with role_connector(admin_dsn, "arena_public")() as conn:
            req = ModelCallRequest(
                key=f"{key}:1",
                bucket="global",
                model=MODEL.value,
                call_kind="card",
                purpose="coach.card",
                trial_id=None,
                actor_user_id=None,
                input_bytes=nbytes,
            )
            made = await calls.reserve_model_call(conn, req)
            assert made.reservation_id is not None
            assert (await calls.mark_dispatched(conn, made.reservation_id)).outcome == "dispatched"
            return made.reservation_id

    dead = run(crashed_after_dispatch())
    adapter = FakeAdapter(script=[VALID], usage=USAGE)
    with pytest.raises(StepInProgressError):  # without the owner's word, an open hold is a live call's
        run(port(admin_dsn, adapter).run(call))
    assert adapter.requests == []
    recovering = dataclasses.replace(call, context=dataclasses.replace(call.context, recover=True))
    result = run(port(admin_dsn, adapter).run(recovering))
    old = run(reservation_row(admin_dsn, dead))
    assert (old["state"], old["settled_usd"]) == ("usage_unknown", old["reserved_usd"])  # never released
    new = run(reservation_row(admin_dsn, result.reservation_id))
    assert (new["key"], new["state"]) == (f"{key}:2", "committed")


def test_a_live_call_s_step_is_never_recovered_from_under_it(admin_dsn: str) -> None:
    """Two processes on one step: the second finds the first's open reservation and is refused, so the first's
    dispatched hold is never settled usage_unknown and resent; once the first has settled, the next key is used."""
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    call = card_call(step())
    slow = FakeAdapter(script=[VALID], usage=USAGE, delay_s=0.5)
    fast = FakeAdapter(script=[VALID, VALID], usage=USAGE)

    async def overlapping() -> tuple[object, object]:
        first = asyncio.create_task(port(admin_dsn, slow).run(call))
        await asyncio.sleep(0.2)
        second = await asyncio.gather(port(admin_dsn, fast).run(call), return_exceptions=True)
        return await first, second[0]

    first, second = run(overlapping())
    assert isinstance(second, StepInProgressError)
    assert fast.requests == []
    assert isinstance(first, AgentResult)
    assert run(reservation_row(admin_dsn, first.reservation_id))["state"] == "committed"
    after = run(port(admin_dsn, fast).run(call))  # the step is free again: the next key is used
    assert run(reservation_row(admin_dsn, after.reservation_id))["key"] == f"{call.context.step_key}:2"


def test_the_voice_client_wrappers_reserve_and_settle_a_probe_hold_as_arena_subject(admin_dsn: str) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))

    async def scenario() -> tuple[calls.ReserveResult, calls.SettleResult]:
        async with role_connector(admin_dsn, "arena_subject")() as conn:
            req = calls.VoiceRequest(
                key=f"it-voice:{uuid4()}",
                bucket="global",
                kind="voice_probe",
                purpose="voice.probe",
                trial_id=None,
                actor_user_id=None,
            )
            held = await calls.reserve_voice(conn, req)
            assert held.reservation_id is not None
            return held, await calls.settle_voice_reservation(conn, held.reservation_id, "released")

    held, settled = run(scenario())
    assert (held.outcome, held.reserved_usd, held.shutoff_usd) == ("reserved", Decimal("0.424940"), Decimal("0.283293"))
    assert (settled.outcome, settled.settled_usd) == ("released", Decimal(0))


def test_admit_unit_and_budget_status_read_the_one_global_bucket(admin_dsn: str) -> None:
    ceiling = run(open_ceiling(admin_dsn, Decimal("3.00")))

    async def scenario() -> tuple[calls.AdmitResult, calls.AdmitResult, list[calls.BucketStatus]]:
        async with role_connector(admin_dsn, "arena_public")() as conn:
            yes = await calls.admit_unit(conn, "global", Decimal("2.00"))
            no = await calls.admit_unit(conn, "global", Decimal("2.01"))
            return yes, no, await calls.budget_status(conn)

    yes, no, status = run(scenario())
    assert (yes.decision, no.decision) == ("admit", "skip")
    assert [(s.bucket, s.parent, s.ceiling_usd, s.kill_switch) for s in status] == [("global", None, ceiling, False)]


# ---------------------------------------------------------------- 5b. every runtime role, its own login (S4 8.3)


ROLE_CALLS = [
    ("arena_public", "card", "coach.card", VertexModel.FLASH_LITE_35),
    ("arena_public", "deep", "coach.deep", VertexModel.FLASH_LITE_35),
    ("arena_public", "final", "coach.final", VertexModel.FLASH_LITE_31),
    ("arena_subject", "subject", "subject.answer", VertexModel.FLASH_LITE_31),
    ("arena_referee", "referee", "referee_subject", VertexModel.FLASH_LITE_31),
    ("arena_referee", "referee", "r3_investigator", VertexModel.FLASH_LITE_35),
]


@pytest.mark.parametrize(("role", "call_kind", "purpose", "model"), ROLE_CALLS)
def test_each_role_runs_the_whole_lifecycle_on_its_own_login_and_no_other_role_can_touch_it(
    admin_dsn: str, role: str, call_kind: str, purpose: str, model: VertexModel
) -> None:
    run(open_ceiling(admin_dsn, Decimal("1.00")))
    others = sorted(RUNTIME_ROLES - {role})

    async def lifecycle() -> tuple[UUID, calls.SettleResult]:
        async with role_connector(admin_dsn, role)() as conn:
            req = ModelCallRequest(
                key=f"it-role:{uuid4()}",
                bucket="global",
                model=model.value,
                call_kind=call_kind,
                purpose=purpose,
                trial_id=None,
                actor_user_id=None,
                input_bytes=12_000,
            )
            made = await calls.reserve_model_call(conn, req)
            assert (made.outcome, made.reservation_id is not None) == ("reserved", True)
            rid = made.reservation_id
            assert rid is not None
            for other in others:  # before dispatch, and again once the receipt exists
                async with role_connector(admin_dsn, other)() as foreign:
                    with pytest.raises(psycopg.Error) as refused:
                        await calls.mark_dispatched(foreign, rid)
                    assert refused.value.sqlstate == "AR040"
            assert (await calls.mark_dispatched(conn, rid)).outcome == "dispatched"
            report = calls.UsageReport(
                reservation_id=rid,
                seq=1,
                model=model.value,
                input_tokens=900,
                output_tokens=120,
                thinking_tokens=20,
                status="ok",
                latency_ms=40,
                trace_id=None,
                span_id=None,
            )
            assert (await calls.record_usage(conn, report)).outcome == "recorded"
            for other in others:
                async with role_connector(admin_dsn, other)() as foreign:
                    for attempt in (
                        calls.record_usage(foreign, dataclasses.replace(report, seq=2)),
                        calls.settle_reservation(foreign, rid, "committed"),
                    ):
                        with pytest.raises(psycopg.Error) as refused:
                            await attempt
                        assert refused.value.sqlstate == "AR040"
            settled = await calls.settle_reservation(conn, rid, "committed")
            again = await calls.record_usage(conn, report)  # the same report after settlement: exists, not an error
            assert again.outcome == "exists"
            with pytest.raises(psycopg.Error) as conflicting:
                await calls.record_usage(conn, dataclasses.replace(report, input_tokens=901))
            assert conflicting.value.sqlstate == "AR003"
            return rid, settled

    rid, settled = run(lifecycle())
    row = run(reservation_row(admin_dsn, rid))
    want = rates.receipt_usd(model, 900, 120)
    assert (row["role"], row["purpose"], row["state"], row["settled_usd"]) == (role, purpose, "committed", want)
    assert settled.settled_usd == want
    assert [r[0] for r in run(call_rows(admin_dsn, rid))] == [1]


# ---------------------------------------------------------------- 5c. the cap test (S5 4.10): simulate_d009 replayed

# Exports simulate_d009(PLAN["sealed"], PLAN["dev"], high=True)'s units in the order the simulation runs them, each
# with its admission cost and its calls (model id, call kind, and the tokens that settle at the modeled cost:
# liab_cost(c, high=True) x RETRY_FACTOR), plus the simulation's own outcome and available budget.
_SIM_EXPORT = """
import json, math, runpy, sys
m = runpy.run_path(sys.argv[1], run_name="cap_test")
lu, plan, think = m["LINEUPS"]["d009"], m["PLAN"], m["THINK"]
rf = m["RETRY_FACTOR"]
def call(c):
    return ["gemini-" + c.model, c.kind, math.ceil(c.tokens_in * 1.25 * rf),
            math.ceil((c.tokens_out * 1.25 + think[c.think][1]) * rf), c.tokens_in, c.tokens_out, c.think]
def unit(name, calls):
    high = sum(m["liab_cost"](c, True) for c in calls) * rf
    return {"name": name, "high_cost": repr(high), "calls": [call(c) for c in calls]}
units = [unit("experiments", m["experiment_calls"](True))]
units += [unit("dev_blocks", m["block_calls"](lu, True)) for _ in range(plan["dev"] // 2)]
units.append(unit("replay_corpus", [c for i in range(plan["sealed"]) for c in m["corpus_calls"](lu, i)]))
units += [unit("replay_transcripts", m["replay_scoring_calls"](lu, True)) for _ in range(plan["sealed"])]
units += [unit("interactive_blocks", m["block_calls"](lu, True)) for _ in range(plan["sealed"] // 2)]
sim = m["simulate_d009"](plan["sealed"], plan["dev"], True)
print(json.dumps({"units": units, "probes": m["LIVE_PROBE"][0], "set_aside": repr(sim["set_aside"]),
                  "cap": repr(m["CAP"]), "sim": {k: sim[k] for k in ("dev_blocks", "replay_corpus",
                  "replay_transcripts", "interactive_blocks", "truncated")}}))
"""


def simulation() -> dict[str, Any]:
    result = proc.run(
        "python", ["-I", "-B", "-c", _SIM_EXPORT, str(REPO_ROOT / "docs/research/synthesis/cost_model.py")]
    )
    assert result.returncode == 0, result.stderr
    parsed: dict[str, Any] = json.loads(result.stdout)
    return parsed


class Replay:
    """Drives units through the real guard as the tournament job would (admit, then reserve, dispatch, record,
    settle per call), checking after EVERY transition that liability is at or under the ceiling."""

    def __init__(self, admin: str) -> None:
        self.admin = admin
        self.checks = 0

    async def assert_within_ceiling(self, watch: calls.Conn) -> None:
        [status] = await calls.budget_status(watch)
        assert status.liability_usd <= status.ceiling_usd, status
        self.checks += 1

    async def unit(self, conn: calls.Conn, watch: calls.Conn, unit: dict[str, Any]) -> str:
        # The runtime estimator (S5 4.5), not the research script, sizes the admission; it must agree with it.
        estimate = rates.unit_high_cost([rates.ModeledCall(VertexModel(c[0]), c[4], c[5], c[6]) for c in unit["calls"]])
        modeled = Decimal(unit["high_cost"])
        assert modeled <= estimate <= modeled + Decimal("0.000001"), (unit["name"], estimate, modeled)
        admitted = await calls.admit_unit(conn, "global", estimate)
        if admitted.decision == "skip":
            return "budget_skipped"
        for model, kind, tokens_in, tokens_out, *_modeled in unit["calls"]:
            req = ModelCallRequest(
                key=f"it-cap:{uuid4()}",
                bucket="global",
                model=model,
                call_kind=kind,
                purpose={"subject": "subject.answer", "referee": "referee_assistant"}.get(kind, f"coach.{kind}"),
                trial_id=None,
                actor_user_id=None,
                input_bytes=LIMITS_BYTES[kind],  # the worst case the simulation reserves (liab_reservation)
            )
            held = await calls.reserve_model_call(conn, req)
            await self.assert_within_ceiling(watch)
            if held.outcome == "refused":
                assert held.reason == "cap"
                return "budget_truncated"
            assert held.reservation_id is not None
            await calls.mark_dispatched(conn, held.reservation_id)
            report = calls.UsageReport(
                reservation_id=held.reservation_id,
                seq=1,
                model=model,
                input_tokens=tokens_in,
                output_tokens=tokens_out,
                thinking_tokens=0,
                status="ok",
                latency_ms=1,
                trace_id=None,
                span_id=None,
            )
            receipt = await calls.record_usage(conn, report)
            assert receipt.outcome == "recorded"  # never an overrun
            await self.assert_within_ceiling(watch)
            await calls.settle_reservation(conn, held.reservation_id, "committed")
            await self.assert_within_ceiling(watch)
        return "completed"


LIMITS_BYTES = {"subject": 80_000, "card": 128_000, "deep": 128_000, "final": 128_000, "referee": 160_000}


def test_the_cap_test_replays_simulate_d009_through_the_guard_and_never_passes_the_ceiling(admin_dsn: str) -> None:
    sim = simulation()
    ceiling = plan_ceiling()
    run(
        admin_exec(
            admin_dsn, "select ops.set_bucket_ceiling('global', null, %s, 'cap test: the applied plan')", (ceiling,)
        )
    )
    # The simulation sets the demo and training ceilings aside before any unit runs (set_aside includes the non-model
    # allowance, which the applied ceiling already excludes); here they are one fixture hold, so the units see exactly
    # the simulation's available budget on top of whatever earlier tests left as liability.
    already = run(liability(admin_dsn))
    available = Decimal(sim["cap"]) - Decimal(sim["set_aside"])
    hold = (ceiling - already - available).quantize(Decimal("0.000001"))
    hold_key = f"it-cap-aside:{uuid4()}"
    run(
        admin_exec(
            admin_dsn,
            "insert into ops.budget_reservations (idempotency_key, bucket, kind, model, call_kind, input_bytes,"
            " purpose, caller_role, reserved_usd) values (%s, 'global', 'model_call', 'gemini-3.5-flash-lite', 'card',"
            " 1, 'cap test: demo and training set-aside', 'postgres', %s)",
            (hold_key, hold),
        )
    )
    replay = Replay(admin_dsn)
    outcomes: dict[str, list[str]] = {}

    async def drive() -> None:
        async with (
            role_connector(admin_dsn, "arena_public")() as conn,
            role_connector(admin_dsn, "arena_subject")() as subject,
            role_connector(admin_dsn, "arena_referee")() as watch,
        ):
            stopped = False
            units = sim["units"]
            first = await replay.unit(conn, watch, units[0])
            outcomes.setdefault("experiments", []).append(first)
            for _ in range(sim["probes"]):  # each day-1 Live probe holds its whole-session reservation
                probe = calls.VoiceRequest(
                    key=f"it-cap-probe:{uuid4()}",
                    bucket="global",
                    kind="voice_probe",
                    purpose="voice.probe",
                    trial_id=None,
                    actor_user_id=None,
                )
                held = await calls.reserve_voice(subject, probe)
                await replay.assert_within_ceiling(watch)
                assert held.outcome == "reserved", held
                assert held.reservation_id is not None
                await calls.settle_voice_reservation(subject, held.reservation_id, "usage_unknown")
                await replay.assert_within_ceiling(watch)
            skipped: set[str] = set()
            for unit in units[1:]:
                name = unit["name"]
                if stopped or name in skipped:
                    outcomes.setdefault(name, []).append("not_started")
                    continue
                outcome = await replay.unit(conn, watch, unit)
                outcomes.setdefault(name, []).append(outcome)
                if outcome == "budget_truncated":
                    stopped = True  # the simulation stops all work after a truncation
                elif outcome == "budget_skipped":
                    skipped.add(name)  # and leaves the rest of that phase

    try:
        run(drive())
    finally:
        run(
            admin_exec(
                admin_dsn,
                "update ops.budget_reservations set state = 'released', settled_usd = 0, settled_at = now()"
                " where idempotency_key = %s",
                (hold_key,),
            )
        )
    done = {name: results.count("completed") for name, results in outcomes.items()}
    expected = sim["sim"]
    assert done["dev_blocks"] == expected["dev_blocks"][0]
    assert done["replay_corpus"] == expected["replay_corpus"]
    assert done["replay_transcripts"] == expected["replay_transcripts"][0]
    assert done["interactive_blocks"] == expected["interactive_blocks"][0]
    not_admitted = [o for results in outcomes.values() for o in results if o in {"budget_skipped", "budget_truncated"}]
    if expected["interactive_blocks"][0] < expected["interactive_blocks"][1]:
        assert not_admitted, outcomes  # the unit the guard did not admit is recorded, never run past the ceiling
    assert replay.checks > len(sim["units"])


def test_a_unit_admitted_on_its_high_cost_but_short_of_a_call_s_worst_case_is_budget_truncated(admin_dsn: str) -> None:
    """Admission holds nothing (1.5 x the unit's high cost); each call still reserves its full worst case, so a unit
    can be admitted and then stopped mid-way: budget_truncated, with liability still under the ceiling."""
    referee = rates.ModeledCall(VertexModel.FLASH_LITE_35, 900, 300, "MINIMAL")
    high = rates.unit_high_cost([referee])
    unit = {
        "name": "one referee call",
        "high_cost": str(high),
        "calls": [["gemini-3.5-flash-lite", "referee", 900, 300, 900, 300, "MINIMAL"]],
    }
    worst = rates.model_call_reservation(VertexModel.FLASH_LITE_35, CallType.REFEREE, LIMITS_BYTES["referee"])
    headroom = rates.ADMIT_FACTOR * high + Decimal("0.001")  # admits (>= 1.5 x high) but is below the worst case
    assert headroom < worst
    run(open_ceiling(admin_dsn, headroom))
    replay = Replay(admin_dsn)

    async def drive() -> str:
        async with (
            role_connector(admin_dsn, "arena_public")() as conn,
            role_connector(admin_dsn, "arena_referee")() as watch,
        ):
            return await replay.unit(conn, watch, unit)

    assert run(drive()) == "budget_truncated"
    run(open_ceiling(admin_dsn, rates.ADMIT_FACTOR * high - Decimal("0.000001")))
    assert run(drive()) == "budget_skipped"  # under 1.5 x the high cost free: never started


# ---------------------------------------------------------------- 6. the budget plan (D-012, S5 4.4, 4.10)


def plan_cli(*args: str) -> CompletedProcess[str]:
    """`python -m scripts.budget_plan` with the owner DSN named by environment variable (never argv)."""
    return proc.run("python", ["-m", "scripts.budget_plan", *args, "--dsn-env", DSN_VAR], cwd=REPO_ROOT)


def plan_ceiling() -> Decimal:
    """The plan as the cost-parity gate reads it."""
    return parse_plan_json(run_plan_json(REPO_ROOT))["global"][1]


def test_apply_then_check_equals_the_cost_model_and_a_one_cent_edit_fails_the_check(admin_dsn: str) -> None:
    applied = plan_cli("--apply")
    assert applied.returncode == 0, applied.stderr
    checked = plan_cli("--check")
    assert checked.returncode == 0, checked.stderr
    rows = run(admin_rows(admin_dsn, "select bucket, parent, ceiling_usd from ops.v_budget_status"))
    assert rows == [("global", None, plan_ceiling())]
    # gateproof: a one-cent edit to the applied ceiling fails --check
    run(
        admin_exec(
            admin_dsn,
            "select ops.set_bucket_ceiling('global', null, %s, 'one cent')",
            (plan_ceiling() + Decimal("0.01"),),
        )
    )
    drifted = plan_cli("--check")
    assert drifted.returncode == 1
    assert "ceiling" in drifted.stderr
    assert plan_cli("--apply").returncode == 0


def test_apply_below_current_liability_exits_one_and_changes_nothing(admin_dsn: str) -> None:
    # A fixture hold larger than the plan's ceiling (written as the owner, in the shape a runtime reservation has).
    run(admin_exec(admin_dsn, "select ops.set_bucket_ceiling('global', null, 1000, 'integration test')"))
    run(
        admin_exec(
            admin_dsn,
            "insert into ops.budget_reservations (idempotency_key, bucket, kind, purpose, caller_role, reserved_usd)"
            " values (%s, 'global', 'voice_probe', 'voice.probe', 'arena_subject', 100)",
            (f"it-big:{uuid4()}",),
        )
    )
    refused = plan_cli("--apply")
    assert refused.returncode == 1
    rows = run(admin_rows(admin_dsn, "select ceiling_usd from ops.v_budget_status"))
    assert rows == [(Decimal(1000),)]  # nothing applied


def test_the_suite_never_held_a_liability_above_the_ceiling(admin_dsn: str) -> None:
    rows = run(admin_rows(admin_dsn, "select count(*) from ops.budget_reservations where overrun"))
    assert rows == [(0,)]
