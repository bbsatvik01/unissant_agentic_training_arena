"""The in-memory guard double mirrors S4's rules (so the port's unit tests mean what the database means), and the
rate mirror reproduces the database's formulas (S5 4.3; S4 draft fix 1)."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest

from arena_core.db.calls import GuardProtocolError, ModelCallRequest, UsageReport
from arena_core.providers.errors import BudgetRefusedError, KillSwitchOnError
from arena_core.spend import rates
from arena_core.spend.limits import ATTEMPTS, LIMITS, CallType, VertexModel
from arena_core.spend.memory import RunBudget

MODEL = VertexModel.FLASH_LITE_35


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def req(key: str = "key-00001", input_bytes: int = 10_000, purpose: str = "coach.card") -> ModelCallRequest:
    return ModelCallRequest(
        key=key,
        bucket="global",
        model=MODEL.value,
        call_kind="card",
        purpose=purpose,
        trial_id=None,
        actor_user_id=None,
        input_bytes=input_bytes,
    )


def usage(rid: UUID, seq: int = 1, tokens: int = 100, model: str = MODEL.value) -> UsageReport:
    return UsageReport(
        reservation_id=rid,
        seq=seq,
        model=model,
        input_tokens=tokens,
        output_tokens=tokens,
        thinking_tokens=0,
        status="ok",
        latency_ms=1,
        trace_id=None,
        span_id=None,
    )


def test_the_reservation_formula_rounds_each_attempt_up_to_the_micro_dollar() -> None:
    # 6,001 bytes on 3.5-flash-lite: 6,001 x 0.30 + 1,600 x 2.50 = 5,800.3 -> 5,801 micro-dollars per attempt.
    assert rates.model_call_reservation(MODEL, CallType.CARD, 6_001) == Decimal("0.023204")
    assert rates.receipt_usd(MODEL, 6_001, 1_600) == Decimal("0.005801")
    assert ATTEMPTS * rates.receipt_usd(MODEL, 6_001, 1_600) <= rates.model_call_reservation(
        MODEL, CallType.CARD, 6_001
    )


def test_the_seeded_worst_cases_match_s5_4_3() -> None:
    table = {
        (CallType.SUBJECT, VertexModel.FLASH_LITE_31): "0.089600",
        (CallType.CARD, VertexModel.FLASH_LITE_35): "0.169600",
        (CallType.REFEREE, VertexModel.FLASH_LITE_35): "0.232000",
    }
    for (call_type, model), want in table.items():
        assert rates.model_call_reservation(model, call_type, LIMITS[call_type].input_bytes) == Decimal(want)


def test_a_key_reused_with_other_inputs_is_refused_and_the_same_inputs_find_it() -> None:
    budget = RunBudget(Decimal(1))
    first = run(budget.reserve(req()))
    again = run(budget.reserve(req()))
    assert (again.id, again.existed) == (first.id, True)
    with pytest.raises(GuardProtocolError, match="AR003"):
        run(budget.reserve(req(purpose="experiment.latency")))


def test_input_outside_the_call_s_limit_is_refused() -> None:
    with pytest.raises(GuardProtocolError, match="AR007"):
        run(RunBudget(Decimal(1)).reserve(req(input_bytes=LIMITS[CallType.CARD].input_bytes + 1)))


def test_the_ceiling_counts_open_holds_and_committed_receipts() -> None:
    budget = RunBudget(Decimal(1))
    one = rates.model_call_reservation(MODEL, CallType.CARD, 10_000)
    budget.ceiling_usd = one * 2
    a = run(budget.reserve(req("key-a0001")))
    run(budget.dispatch(a.id))
    run(budget.record(usage(a.id)))
    run(budget.settle(a.id, "committed"))
    b = run(budget.reserve(req("key-b0001")))
    settled = budget.reservations[a.id].settled_usd
    assert settled is not None
    assert budget.liability() == settled + b.reserved_usd
    budget.ceiling_usd = budget.liability() + one - Decimal("0.000001")  # one micro-dollar short of a third hold
    with pytest.raises(BudgetRefusedError, match="cap"):
        run(budget.reserve(req("key-c0001")))


def test_dispatch_record_and_settle_follow_s4s_rules() -> None:
    budget = RunBudget(Decimal(1))
    held = run(budget.reserve(req()))
    with pytest.raises(GuardProtocolError, match="AR001"):
        run(budget.record(usage(held.id)))  # never dispatched
    run(budget.dispatch(held.id))
    with pytest.raises(GuardProtocolError, match="cannot be dispatched"):
        run(budget.dispatch(held.id))
    with pytest.raises(GuardProtocolError, match="AR001"):
        run(budget.settle(held.id, "released"))  # a started reservation is not releasable
    with pytest.raises(GuardProtocolError, match="AR007"):
        run(budget.settle(held.id, "committed"))  # no receipts
    with pytest.raises(GuardProtocolError, match="AR001/AR007"):
        run(budget.record(usage(held.id, seq=ATTEMPTS + 1)))
    with pytest.raises(GuardProtocolError, match="AR001/AR007"):
        run(budget.record(usage(held.id, model="gemini-3.1-flash-lite")))
    run(budget.record(usage(held.id)))
    with pytest.raises(GuardProtocolError, match="AR003"):
        run(budget.record(usage(held.id)))
    assert run(budget.settle(held.id, "usage_unknown")) == held.reserved_usd
    with pytest.raises(GuardProtocolError, match="AR010"):
        run(budget.settle(held.id, "committed"))


def test_receipts_above_the_hold_turn_the_kill_switch_on() -> None:
    budget = RunBudget(Decimal(1))
    held = run(budget.reserve(req()))
    run(budget.dispatch(held.id))
    result = run(budget.record(usage(held.id, tokens=1_000_000)))
    assert (result.outcome, result.shutoff, budget.kill_switch) == ("overrun", True, True)
    with pytest.raises(KillSwitchOnError):
        run(budget.reserve(req("key-other")))


def test_the_kill_switch_refuses_dispatch() -> None:
    budget = RunBudget(Decimal(1))
    held = run(budget.reserve(req()))
    budget.kill_switch = True
    with pytest.raises(KillSwitchOnError):
        run(budget.dispatch(held.id))
    assert run(budget.settle(held.id, "released")) == Decimal(0)
