"""The agent port (S5 3.2, 3.4, 3.6; S2 2, 10, AT-PORT-2, AT-PORT-4, AT-PORT-5) on the fake adapter and the in-memory
guard double. The same behaviour against the real migrated database is proven by tests/db/it_spend_guard.py
(`make db-test`)."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from decimal import Decimal
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Tracer
from pydantic import BaseModel, Field

from arena_core.contracts.subject import SubjectContext, SubjectTurn
from arena_core.db.calls import GuardProtocolError, ModelCallRequest, SettleOutcome, UsageReport, UsageResult
from arena_core.providers.errors import (
    BudgetRefusedError,
    ErrorKind,
    InputTooLargeError,
    KillSwitchOnError,
    PolicyRefusedError,
    ProviderBlockedError,
    ProviderCallError,
    ProviderFailedError,
    StepInProgressError,
    StructuredOutputError,
)
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import BLOCKED_NOTE, MAX_KEY_ROUNDS, TRUNCATED_NOTE, AgentPort, PortOptions, seed_for
from arena_core.providers.retry import RetryPolicy
from arena_core.providers.types import (
    AgentCall,
    AgentResult,
    CallContext,
    DataClass,
    Message,
    ModelRequest,
    RawCompletion,
    Usage,
    request_bytes,
)
from arena_core.spend import rates
from arena_core.spend.guard import GuardSession, Reservation
from arena_core.spend.limits import (
    ATTEMPTS,
    DEFAULT_TIMING,
    LIMITS,
    REPAIR_BYTES,
    REPAIR_ERROR_ITEM_BYTES,
    REPAIR_ERROR_ITEMS,
    CallType,
    ThinkingLevel,
    VertexModel,
)
from arena_core.spend.memory import RunBudget

VALID = '{"verdict": "ok", "note": "fine"}'
USAGE = Usage(input_tokens=1_000, output_tokens=200, thinking_tokens=20)
MODEL = VertexModel.FLASH_LITE_35
CEILING = Decimal(10)
TWO = 2
THREE = 3
INT32_MAX = 2**31 - 1


class Reply(BaseModel):
    verdict: str = Field(max_length=10)
    note: str = Field(max_length=40)


class Many(BaseModel):
    """Twelve required fields: an empty object fails with twelve validation errors."""

    a: int
    b: int
    c: int
    d: int
    e: int
    f: int
    g: int
    h: int
    i: int
    j: int
    k: int
    m: int


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def no_sleep(_seconds: float) -> None:
    return None


def card(text: str = "Rate this turn.", change: Callable[[CallContext], CallContext] | None = None) -> AgentCall[Reply]:
    context = CallContext(call_type=CallType.CARD, purpose="coach.card", step_key=f"step:{uuid4()}")
    return AgentCall(
        model=MODEL,
        thinking=ThinkingLevel.MINIMAL,
        system="You are a coach. Reply with the JSON object only.",
        messages=(Message("user", text),),
        schema=Reply,
        context=change(context) if change else context,
    )


def port(
    adapter: FakeAdapter,
    guard: RunBudget | None = None,
    *,
    tracer: Tracer | None = None,
    clock: Callable[[], float] = time.monotonic,
    roster: frozenset[str] | None = None,
) -> tuple[AgentPort, RunBudget]:
    budget = guard if guard is not None else RunBudget(CEILING)
    options = PortOptions(sleep=no_sleep, tracer=tracer, clock=clock, roster_manifest_shas=roster)
    return AgentPort(adapter, budget, options), budget


def unavailable() -> ProviderCallError:
    return ProviderCallError(ErrorKind.TRANSIENT, "HTTP 503", status=503)


# ---------------------------------------------------------------- the happy path and the guard order


def test_one_call_reserves_dispatches_records_one_row_and_settles_committed() -> None:
    adapter = FakeAdapter(script=[VALID], usage=USAGE)
    agent, budget = port(adapter)
    result = run(agent.run(card()))
    assert result.value == Reply(verdict="ok", note="fine")
    assert result.attempts == 1
    rid = result.reservation_id
    assert [op for op, _ in budget.ops] == ["reserve", "dispatch", "record", "settle"]
    held = budget.reservations[rid]
    want = rates.receipt_usd(MODEL, USAGE.input_tokens, USAGE.output_tokens)
    assert (held.state, held.settled_usd, result.cost_usd) == ("committed", want, want)
    assert result.usage == USAGE
    assert len(budget.rows) == 1


def test_the_reservation_prices_the_bytes_actually_sent_plus_the_repair_allowance() -> None:
    """AT-PORT-2: input_bytes = serialized request + REPAIR_BYTES, measured in UTF-8 bytes, not characters."""
    text = "€" * 1_000  # three bytes each
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter)
    result = run(agent.run(card(text)))
    sent = adapter.requests[0]
    measured = request_bytes(sent) + REPAIR_BYTES
    held = budget.reservations[result.reservation_id]
    assert held.input_bytes == measured
    assert request_bytes(sent) >= len(text.encode("utf-8")) > len(text)
    assert held.reserved_usd == rates.model_call_reservation(MODEL, CallType.CARD, measured)
    assert held.reserved_usd <= rates.model_call_reservation(MODEL, CallType.CARD, LIMITS[CallType.CARD].input_bytes)


def test_every_reservation_names_global_and_the_call_s_purpose_and_model() -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter)
    result = run(agent.run(card()))
    bucket, model, call_kind, purpose, *_ = budget.reservations[result.reservation_id].identity
    assert (bucket, model, call_kind, purpose) == ("global", MODEL.value, "card", "coach.card")


def test_the_request_carries_the_call_types_output_limit_seed_and_label() -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, _ = port(adapter)
    run(agent.run(card()))
    sent = adapter.requests[0]
    assert sent.max_output_tokens == LIMITS[CallType.CARD].output_tokens
    assert sent.labels == {"app": "unissant-arena"}
    assert 0 <= sent.seed <= INT32_MAX
    assert "maxLength" not in json.dumps(sent.json_schema)  # Vertex-filtered schema; lengths enforced in code
    assert "properties" not in sent.system  # the schema never travels as prompt text (S2 1)


def test_the_seed_rule_varies_with_the_attempt_and_stays_in_int32() -> None:
    seeds = {seed_for("trial", 3, "coach.card", attempt) for attempt in range(1, 5)}
    assert len(seeds) == ATTEMPTS
    assert all(0 <= s <= INT32_MAX for s in seeds)


# ---------------------------------------------------------------- attempt rule (S5 3.4, 3.6)


def test_invalid_json_three_times_makes_exactly_two_sends_then_structured_output_error() -> None:
    adapter = FakeAdapter(script=["nope", "nope", "nope", VALID], usage=USAGE)
    agent, budget = port(adapter)
    with pytest.raises(StructuredOutputError):
        run(agent.run(card()))
    assert len(adapter.requests) == TWO
    assert len(budget.rows) == TWO
    [held] = budget.reservations.values()
    assert held.state == "committed"


def test_a_503_four_times_makes_exactly_four_sends_and_never_a_fifth() -> None:
    adapter = FakeAdapter(script=[unavailable() for _ in range(ATTEMPTS + 1)], usage=USAGE)
    agent, budget = port(adapter)
    with pytest.raises(ProviderFailedError, match="after 4 attempt"):
        run(agent.run(card()))
    assert len(adapter.requests) == ATTEMPTS
    assert [r.seq for r in budget.rows] == [1, 2, 3, 4]
    assert len(adapter.script) == 1  # the fifth outcome was never asked for


def test_a_repair_and_two_transient_retries_still_stop_at_four() -> None:
    adapter = FakeAdapter(script=["nope", unavailable(), unavailable(), "nope", VALID])
    agent, _ = port(adapter)
    with pytest.raises(StructuredOutputError):
        run(agent.run(card()))
    assert len(adapter.requests) == ATTEMPTS


def test_a_schema_failure_then_a_valid_reply_succeeds_after_one_repair() -> None:
    adapter = FakeAdapter(script=['{"verdict": "far too long for ten"}', VALID])
    agent, _ = port(adapter)
    result = run(agent.run(card("question")))
    assert result.attempts == TWO
    repaired = adapter.requests[1].messages
    assert [m.role for m in repaired] == ["user", "model", "user"]
    assert repaired[0] == Message("user", "question")
    assert repaired[1].text == '{"verdict": "far too long for ten"}'
    assert repaired[2].text.endswith("Reply again with only the corrected JSON object.")


def test_the_repair_lists_at_most_ten_errors_of_at_most_100_bytes_and_never_echoes_values() -> None:
    secret = "CANARY-VALUE-" + "x" * 200
    reply = json.dumps({"a": secret})
    adapter = FakeAdapter(script=[reply, json.dumps(dict.fromkeys("abcdefghijkm", 1))])
    agent, _ = port(adapter)
    base = card()
    call = AgentCall(
        model=base.model,
        thinking=base.thinking,
        system=base.system,
        messages=base.messages,
        schema=Many,
        context=base.context,
    )
    run(agent.run(call))
    note = adapter.requests[1].messages[-1].text
    items = note.removesuffix(". Reply again with only the corrected JSON object.").split("; ")
    assert len(items) == REPAIR_ERROR_ITEMS
    assert all(len(item.encode("utf-8")) <= REPAIR_ERROR_ITEM_BYTES for item in items)
    assert "CANARY" not in note


def test_a_bad_request_is_not_retried() -> None:
    adapter = FakeAdapter(script=[ProviderCallError(ErrorKind.BAD_REQUEST, "HTTP 400", status=400), VALID])
    agent, budget = port(adapter)
    with pytest.raises(ProviderFailedError, match="HTTP 400"):
        run(agent.run(card()))
    assert len(adapter.requests) == 1
    assert next(iter(budget.reservations.values())).state == "committed"


def test_a_truncated_reply_gets_the_one_repair_with_the_cut_off_message() -> None:
    truncated = ProviderCallError(ErrorKind.TRUNCATED, "MAX_TOKENS", usage=USAGE, maybe_billed=True)
    adapter = FakeAdapter(script=[truncated, VALID])
    agent, _ = port(adapter)
    run(agent.run(card()))
    assert adapter.requests[1].messages[-1] == Message("user", TRUNCATED_NOTE)


def test_a_block_twice_raises_provider_blocked_after_two_sends() -> None:
    blocked = [ProviderCallError(ErrorKind.BLOCKED, "SAFETY", usage=USAGE, maybe_billed=True) for _ in range(3)]
    adapter = FakeAdapter(script=list(blocked))
    agent, _ = port(adapter)
    with pytest.raises(ProviderBlockedError):
        run(agent.run(card()))
    assert len(adapter.requests) == TWO
    assert adapter.requests[1].messages[-1] == Message("user", BLOCKED_NOTE)


def test_an_empty_reply_without_usage_is_repaired_and_settles_usage_unknown() -> None:
    empty = ProviderCallError(ErrorKind.EMPTY, "empty", maybe_billed=True)
    adapter = FakeAdapter(script=[empty, VALID], usage=USAGE)
    agent, budget = port(adapter)
    result = run(agent.run(card()))
    held = budget.reservations[result.reservation_id]
    assert (held.state, held.settled_usd) == ("usage_unknown", held.reserved_usd)


def test_a_reply_without_usage_settles_usage_unknown_at_the_full_hold() -> None:
    adapter = FakeAdapter(script=[VALID], usage=None)
    agent, budget = port(adapter)
    result = run(agent.run(card()))
    held = budget.reservations[result.reservation_id]
    assert (held.state, result.cost_usd) == ("usage_unknown", held.reserved_usd)


def test_timeouts_are_transient_maybe_billed_and_settle_usage_unknown() -> None:
    adapter = FakeAdapter(script=[VALID] * ATTEMPTS, delay_s=0.2)
    agent, budget = port(adapter)
    with pytest.raises(ProviderFailedError):
        run(agent.run(dataclasses.replace(card(), timeout_s=0.01)))
    assert len(adapter.requests) == ATTEMPTS
    assert {r.report.status for r in budget.rows} == {"timeout"}
    [held] = budget.reservations.values()
    assert (held.state, held.settled_usd) == ("usage_unknown", held.reserved_usd)


def test_the_deadline_bounds_every_attempt() -> None:
    ticks = iter(float(t) for t in range(100))
    adapter = FakeAdapter(script=[unavailable()] * ATTEMPTS)
    agent, _ = port(adapter, clock=lambda: next(ticks))
    with pytest.raises(ProviderFailedError, match="deadline"):
        run(agent.run(dataclasses.replace(card(), deadline_s=4.0)))
    assert 1 <= len(adapter.requests) < ATTEMPTS


def test_backoff_sleeps_between_transient_retries_only() -> None:
    slept: list[float] = []

    async def record_sleep(seconds: float) -> None:
        slept.append(seconds)

    adapter = FakeAdapter(script=[unavailable(), VALID])
    agent = AgentPort(adapter, RunBudget(CEILING), PortOptions(sleep=record_sleep))
    run(agent.run(card()))
    assert len(slept) == 1
    assert 0 <= slept[0] <= RetryPolicy().base_delay_s


# ---------------------------------------------------------------- input bound (D11, AT-PORT-4, AT-PORT-5)


def fit_text(limit: int) -> str:
    """User text whose request plus REPAIR_BYTES is exactly ``limit`` bytes."""
    probe = FakeAdapter(script=[VALID])
    agent, _ = port(probe, RunBudget(Decimal(1000)))
    run(agent.run(card("")))
    empty = request_bytes(probe.requests[0])
    return "a" * (limit - REPAIR_BYTES - empty)


def test_a_request_exactly_at_the_limit_is_sent_and_one_byte_over_is_refused_before_any_reservation() -> None:
    limit = LIMITS[CallType.CARD].input_bytes
    text = fit_text(limit)
    at_limit = FakeAdapter(script=[VALID])
    agent, budget = port(at_limit)
    result = run(agent.run(card(text)))
    assert budget.reservations[result.reservation_id].input_bytes == limit
    over = FakeAdapter(script=[VALID])
    agent, budget = port(over)
    with pytest.raises(InputTooLargeError, match="input_over_limit") as refused:
        run(agent.run(card(text + "a")))
    assert refused.value.request_bytes == limit + 1
    assert (budget.ops, over.requests) == ([], [])


@pytest.mark.parametrize(
    "reply",
    ["\\" * 6_000, '"' * 6_000, "\x01" * 6_000, "€" * 3_000],
    ids=["backslashes", "quotes", "control", "three-byte"],
)
def test_a_repair_echo_is_cut_until_the_serialized_request_fits_the_reserved_bytes(reply: str) -> None:
    adapter = FakeAdapter(script=[reply, VALID])
    agent, budget = port(adapter)
    result = run(agent.run(card("question")))
    reserved = budget.reservations[result.reservation_id].input_bytes
    first, repaired = adapter.requests
    assert request_bytes(repaired) <= reserved == request_bytes(first) + REPAIR_BYTES
    echo = repaired.messages[1].text
    assert echo
    assert reply.startswith(echo)
    assert len(echo) < len(reply)  # cut at a character boundary


def test_a_send_longer_than_the_reserved_bytes_is_never_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every send is measured again against the reservation; one that would exceed it raises before the adapter
    sees it, and the dispatched hold settles usage_unknown (never released)."""
    measured: list[int] = []

    def growing(request: ModelRequest) -> int:
        size = request_bytes(request)
        measured.append(size)
        return size if len(measured) == 1 else size + REPAIR_BYTES + 1

    monkeypatch.setattr("arena_core.providers.port.request_bytes", growing)
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter)
    with pytest.raises(InputTooLargeError, match="not sent"):
        run(agent.run(card()))
    assert adapter.requests == []
    [held] = budget.reservations.values()
    assert (held.state, held.dispatched) == ("usage_unknown", True)


def test_a_repair_that_cannot_fit_even_without_the_echo_is_not_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("arena_core.providers.port.REPAIR_BYTES", 0)
    adapter = FakeAdapter(script=["nope", VALID])
    agent, _ = port(adapter)
    with pytest.raises(InputTooLargeError, match="repair turn alone"):
        run(agent.run(card()))
    assert len(adapter.requests) == 1


# ---------------------------------------------------------------- policy, refusals, kill switch


@pytest.mark.parametrize(
    ("change", "match"),
    [
        ({"model": VertexModel.FLASH_38}, "not allowed"),
        ({"timeout_s": 6.5}, "timeout"),
        ({"deadline_s": 0.0}, "deadline"),
        ({"messages": ()}, "at least one message"),
    ],
)
def test_a_call_outside_policy_is_refused_before_any_reservation(change: dict[str, Any], match: str) -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter)
    with pytest.raises(PolicyRefusedError, match=match):
        run(agent.run(dataclasses.replace(card(), **change)))
    assert (budget.ops, adapter.requests) == ([], [])


@pytest.mark.parametrize(
    ("change", "match"),
    [
        (lambda c: dataclasses.replace(c, purpose="referee_subject"), "purpose"),
        (lambda c: dataclasses.replace(c, data_class="subject_private"), "data class"),
        (lambda c: dataclasses.replace(c, candidate_manifest_sha="a" * 64), "roster"),
        (lambda c: dataclasses.replace(c, step_key="short"), "step key"),
    ],
)
def test_a_context_outside_policy_is_refused_before_any_reservation(
    change: Callable[[CallContext], CallContext], match: str
) -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter)
    with pytest.raises(PolicyRefusedError, match=match):
        run(agent.run(card(change=change)))
    assert budget.ops == []


def test_a_manifest_in_the_frozen_roster_passes() -> None:
    sha = "b" * 64
    adapter = FakeAdapter(script=[VALID])
    agent, _ = port(adapter, roster=frozenset({sha}))
    assert run(agent.run(card(change=lambda c: dataclasses.replace(c, candidate_manifest_sha=sha)))).attempts == 1


def test_a_refused_reservation_sends_nothing() -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, _ = port(adapter, RunBudget(Decimal(0)))
    with pytest.raises(BudgetRefusedError) as refused:
        run(agent.run(card()))
    assert refused.value.reason == "cap"
    assert adapter.requests == []


def test_the_kill_switch_at_reservation_sends_nothing() -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter, RunBudget(CEILING, kill_switch=True))
    with pytest.raises(KillSwitchOnError):
        run(agent.run(card()))
    assert (adapter.requests, budget.reservations) == ([], {})


class KillBeforeDispatch(RunBudget):
    async def reserve(self, req: ModelCallRequest) -> Reservation:
        found = await super().reserve(req)
        self.kill_switch = True
        return found


def test_the_kill_switch_at_dispatch_releases_the_hold_and_sends_nothing() -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter, KillBeforeDispatch(CEILING))
    with pytest.raises(KillSwitchOnError):
        run(agent.run(card()))
    [held] = budget.reservations.values()
    assert (held.state, held.settled_usd, adapter.requests) == ("released", Decimal(0), [])


class Overrun(RunBudget):
    async def record(self, report: UsageReport) -> UsageResult:
        await super().record(report)
        self.kill_switch = True
        return UsageResult("overrun", Decimal(1), Decimal(1), Decimal(0), True)


def test_an_overrun_receipt_stops_the_call_at_once() -> None:
    adapter = FakeAdapter(script=["nope", VALID], usage=USAGE)
    agent, budget = port(adapter, Overrun(CEILING))
    with pytest.raises(KillSwitchOnError, match="overran"):
        run(agent.run(card()))
    assert len(adapter.requests) == 1
    assert next(iter(budget.reservations.values())).state == "committed"


class BrokenSettle(RunBudget):
    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> Decimal:
        msg = f"database gone while settling {reservation_id} as {outcome}"
        raise GuardProtocolError(msg)


def test_a_failed_settlement_keeps_the_call_s_own_error_with_a_note() -> None:
    adapter = FakeAdapter(script=[ProviderCallError(ErrorKind.BAD_REQUEST, "HTTP 400", status=400)])
    agent, _ = port(adapter, BrokenSettle(CEILING))
    with pytest.raises(ProviderFailedError) as failed:
        run(agent.run(card()))
    assert any("settlement of reservation" in note for note in failed.value.__notes__)


# ---------------------------------------------------------------- recovery by key (S5 4.10, AT-PORT-6)


def test_a_dispatched_hold_left_by_a_dead_process_is_settled_usage_unknown_and_the_next_key_used() -> None:
    call = card()
    budget = RunBudget(CEILING)
    first = FakeAdapter(script=[VALID])
    run(AgentPort(first, budget, PortOptions(sleep=no_sleep)).run(call))
    [(old_id, old)] = budget.reservations.items()
    old.state, old.settled_usd = "reserved", None  # as if the process died after dispatch
    budget.rows.clear()
    unowned = FakeAdapter(script=[VALID])
    with pytest.raises(StepInProgressError):  # an open hold is a live call's unless the step's owner says otherwise
        run(AgentPort(unowned, budget, PortOptions(sleep=no_sleep)).run(call))
    assert (unowned.requests, old.state) == ([], "reserved")
    result = run(AgentPort(FakeAdapter(script=[VALID]), budget, PortOptions(sleep=no_sleep)).run(recovering(call)))
    assert budget.reservations[old_id].state == "usage_unknown"
    assert budget.reservations[result.reservation_id].key == f"{call.context.step_key}:2"


def test_an_undispatched_hold_is_resumed_and_a_settled_one_skipped() -> None:
    call = card()
    budget = RunBudget(CEILING)
    run(AgentPort(FakeAdapter(script=[VALID]), budget, PortOptions(sleep=no_sleep)).run(call))
    second = run(AgentPort(FakeAdapter(script=[VALID]), budget, PortOptions(sleep=no_sleep)).run(call))
    assert budget.reservations[second.reservation_id].key.endswith(":2")
    held = budget.reservations[second.reservation_id]
    held.state, held.dispatched, held.settled_usd = "reserved", False, None
    budget.rows.clear()
    with pytest.raises(StepInProgressError):
        run(AgentPort(FakeAdapter(script=[VALID]), budget, PortOptions(sleep=no_sleep)).run(call))
    third = run(AgentPort(FakeAdapter(script=[VALID]), budget, PortOptions(sleep=no_sleep)).run(recovering(call)))
    assert third.reservation_id == second.reservation_id


def test_a_step_that_used_every_key_fails() -> None:
    call = card()
    budget = RunBudget(Decimal(100))
    for _ in range(MAX_KEY_ROUNDS):
        run(AgentPort(FakeAdapter(script=[VALID]), budget, PortOptions(sleep=no_sleep)).run(call))
    with pytest.raises(ProviderFailedError, match="reservation keys"):
        run(AgentPort(FakeAdapter(script=[VALID]), budget, PortOptions(sleep=no_sleep)).run(call))


# ---------------------------------------------------------------- spans (S5 3.6)


def test_one_llm_span_per_attempt_and_each_row_carries_its_span_s_ids() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    adapter = FakeAdapter(script=["nope", VALID])
    agent, budget = port(adapter, tracer=provider.get_tracer("t"))
    run(agent.run(card()))
    spans = exporter.get_finished_spans()
    assert [s.name for s in spans] == ["llm.card", "llm.card"]
    ids = [(f"{s.context.trace_id:032x}", f"{s.context.span_id:016x}") for s in spans if s.context is not None]
    assert ids == [(r.report.trace_id, r.report.span_id) for r in budget.rows]
    assert [s.attributes.get("arena.attempt") if s.attributes else None for s in spans] == [1, 2]


def test_a_failed_attempt_span_is_marked_error_without_the_message() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    adapter = FakeAdapter(script=[ProviderCallError(ErrorKind.TRANSIENT, "secret prompt echo", status=503), VALID])
    agent, _ = port(adapter, tracer=provider.get_tracer("t"))
    run(agent.run(card()))
    failed = exporter.get_finished_spans()[0]
    assert failed.status.description == "transient"
    assert not failed.events


def test_without_an_installed_provider_rows_carry_no_ids() -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter)
    run(agent.run(card()))
    assert (budget.rows[0].report.trace_id, budget.rows[0].report.span_id) == (None, None)


# ---------------------------------------------------------------- the guard protocol (a session per call)


class CountingGuard:
    def __init__(self) -> None:
        self.inner = RunBudget(CEILING)
        self.sessions = 0

    @asynccontextmanager
    async def _open(self) -> AsyncIterator[GuardSession]:
        self.sessions += 1
        async with self.inner.session() as session:
            yield session

    def session(self) -> AbstractAsyncContextManager[GuardSession]:
        return self._open()


def test_one_guard_session_per_logical_call() -> None:
    guard = CountingGuard()
    agent = AgentPort(FakeAdapter(script=["nope", VALID]), guard, PortOptions(sleep=no_sleep))
    run(agent.run(card()))
    assert guard.sessions == 1


# ---------------------------------------------------------------- Codex round 1: context, same seed, deadline, echo


SUBJECT_CTX = SubjectContext(
    fact_ids=frozenset({"f:01", "f:02"}),
    uncertainty_ids=frozenset({"u:01"}),
    closed_gate_ids=frozenset({"g:01"}),
    allowed_behaviors=frozenset({"responsive"}),
)


def subject_reply(*disclosed: str, withheld: tuple[str, ...] = ()) -> str:
    tag = {
        "disclosed": list(disclosed),
        "withheld": list(withheld),
        "uncertainty_used": [],
        "behavior": "responsive",
        "gates_opened": [],
    }
    return json.dumps({"utterance": "I went in to reset the freezer alarm.", "tag": tag})


def subject_call() -> AgentCall[SubjectTurn]:
    return AgentCall(
        model=VertexModel.FLASH_LITE_31,
        thinking=ThinkingLevel.MINIMAL,
        system="You play the subject.",
        messages=(Message("user", "Why were you in the store room?"),),
        schema=SubjectTurn,
        context=CallContext(
            call_type=CallType.SUBJECT,
            purpose="subject.answer",
            step_key=f"step:{uuid4()}",
            data_class="subject_private",
        ),
        validation_context=SUBJECT_CTX,
    )


def test_the_schema_s_context_rules_are_applied_and_repaired_without_echoing_the_value() -> None:
    """A fact ID the packet does not have passes the bare schema but fails with the call's SubjectContext (V2)."""
    adapter = FakeAdapter(script=[subject_reply("f:999"), subject_reply("f:01")])
    agent, _ = port(adapter)
    result = run(agent.run(subject_call()))
    assert result.value.tag.disclosed == ["f:01"]
    assert result.attempts == TWO
    note = adapter.requests[1].messages[-1].text
    assert "V2" in note
    assert "f:999" not in note


def test_a_custom_rule_message_never_echoes_model_values_and_an_unexpected_key_is_not_named() -> None:
    both = subject_reply("f:01", withheld=("f:01",))
    extra = json.dumps({**json.loads(subject_reply("f:01")), "PLANTED-KEY-NAME": 1})
    adapter = FakeAdapter(script=[both, subject_reply("f:01")])
    agent, _ = port(adapter)
    run(agent.run(subject_call()))
    note = adapter.requests[1].messages[-1].text
    assert ("V3" in note, "f:01" in note) == (True, False)
    adapter = FakeAdapter(script=[extra, subject_reply("f:01")])
    agent, _ = port(adapter)
    run(agent.run(subject_call()))
    note = adapter.requests[1].messages[-1].text
    assert "<unexpected field>" in note
    assert "PLANTED" not in note


def test_a_transient_retry_resends_the_identical_request_with_the_same_seed() -> None:
    adapter = FakeAdapter(script=[unavailable(), unavailable(), VALID])
    agent, _ = port(adapter)
    run(agent.run(card()))
    first, second, third = adapter.requests
    assert first == second == third


def test_a_retry_after_a_repair_that_filled_its_allowance_is_still_sent() -> None:
    """The repaired request is resent byte for byte, so a boundary-sized repair never grows past its reservation."""
    long_reply = "\\" * 6_000
    adapter = FakeAdapter(script=[long_reply, unavailable(), VALID])
    agent, budget = port(adapter)
    result = run(agent.run(card()))
    assert result.attempts == len(adapter.requests) == THREE
    repaired, retried = adapter.requests[1], adapter.requests[2]
    assert repaired == retried
    assert request_bytes(retried) <= budget.reservations[result.reservation_id].input_bytes


def test_the_backoff_never_outlasts_the_deadline() -> None:
    adapter = FakeAdapter(script=[unavailable() for _ in range(ATTEMPTS)])
    agent = AgentPort(adapter, RunBudget(CEILING), PortOptions(retry=RetryPolicy(base_delay_s=5.0, max_delay_s=5.0)))
    started = time.monotonic()
    with pytest.raises(ProviderFailedError):
        run(agent.run(dataclasses.replace(card(), deadline_s=0.05)))
    assert time.monotonic() - started < 1.0


# ---------------------------------------------------------------- Codex round 2: step ownership, timing, text, cancel


def recovering(call: AgentCall[Reply]) -> AgentCall[Reply]:
    return dataclasses.replace(call, context=dataclasses.replace(call.context, recover=True))


def test_a_second_live_call_on_the_same_step_is_refused_and_the_first_completes() -> None:
    budget = RunBudget(CEILING)
    call = card()
    slow = FakeAdapter(script=[VALID], delay_s=0.2)
    fast = FakeAdapter(script=[VALID])

    async def both() -> tuple[object, object]:
        first = asyncio.create_task(AgentPort(slow, budget, PortOptions(sleep=no_sleep)).run(call))
        await asyncio.sleep(0.05)  # the first holds the step and has dispatched
        second = asyncio.gather(AgentPort(fast, budget, PortOptions(sleep=no_sleep)).run(call), return_exceptions=True)
        return await first, (await second)[0]

    first, second = run(both())
    assert isinstance(first, AgentResult)
    assert isinstance(second, StepInProgressError)
    assert fast.requests == []
    assert [h.state for h in budget.reservations.values()] == ["committed"]


@pytest.mark.parametrize(
    ("call_type", "purpose", "data_class", "timeout"),
    [
        (CallType.SUBJECT, "subject.answer", "subject_private", 8.0),
        (CallType.CARD, "coach.card", "public", 6.0),
        (CallType.DEEP, "coach.deep", "public", 10.0),
        (CallType.FINAL, "coach.final", "public", 15.0),
        (CallType.REFEREE, "referee_assistant", "evaluator", 30.0),
    ],
)
def test_a_call_without_timing_uses_s2_s_attempt_timeout(
    call_type: CallType, purpose: str, data_class: DataClass, timeout: float
) -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, _ = port(adapter)
    model = VertexModel.FLASH_LITE_35
    base = card()
    context = CallContext(call_type=call_type, purpose=purpose, step_key=f"s:{uuid4()}", data_class=data_class)
    run(agent.run(dataclasses.replace(base, model=model, context=context)))
    assert adapter.timeouts == [timeout]
    assert DEFAULT_TIMING[call_type].attempt_timeout_s == timeout


def test_the_default_deadline_bounds_a_call_that_sets_none() -> None:
    ticks = iter(float(t) for t in range(0, 1000, 5))  # every clock read advances 5 s
    adapter = FakeAdapter(script=[unavailable()] * ATTEMPTS)
    agent, _ = port(adapter, clock=lambda: next(ticks))
    with pytest.raises(ProviderFailedError, match="deadline"):
        run(agent.run(card()))  # card: 12 s deadline (S2 2)
    assert len(adapter.requests) < ATTEMPTS


@pytest.mark.parametrize(
    "messages",
    [
        (cast("Message", {"role": "user", "text": "q"}),),
        (Message(cast("Any", "system"), "q"),),
        (Message("user", cast("str", {"inline_data": "audio"})),),
    ],
    ids=["not-a-message", "unknown-role", "non-text-part"],
)
def test_a_non_text_message_is_refused_before_any_reservation(messages: tuple[Message, ...]) -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter)
    with pytest.raises(PolicyRefusedError, match="text"):
        run(agent.run(dataclasses.replace(card(), messages=messages)))
    assert (budget.ops, adapter.requests) == ([], [])


def test_a_non_text_system_instruction_is_refused() -> None:
    agent, budget = port(FakeAdapter(script=[VALID]))
    with pytest.raises(PolicyRefusedError, match="text"):
        run(agent.run(dataclasses.replace(card(), system=cast("str", b"bytes"))))
    assert budget.ops == []


class Hanging(FakeAdapter):
    """Signals once a request is in flight, then never answers."""

    entered: asyncio.Event | None = None

    async def generate(self, request: ModelRequest, *, timeout_s: float) -> RawCompletion:
        self.requests.append(request)
        self.timeouts.append(timeout_s)
        if self.entered is not None:
            self.entered.set()
        await asyncio.Event().wait()
        raise AssertionError  # unreachable: the wait above never ends


def test_a_cancelled_attempt_still_writes_its_receipt_and_settles_usage_unknown() -> None:
    adapter = Hanging()
    budget = RunBudget(CEILING)
    agent = AgentPort(adapter, budget, PortOptions(sleep=no_sleep))

    async def cancel_mid_attempt() -> None:
        adapter.entered = asyncio.Event()
        task = asyncio.create_task(agent.run(card()))
        await adapter.entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(cancel_mid_attempt())
    [row] = budget.rows
    assert (row.seq, row.report.status, row.report.input_tokens) == (1, "error", 0)
    [held] = budget.reservations.values()
    assert (held.state, held.settled_usd) == ("usage_unknown", held.reserved_usd)


def test_a_truncated_reply_s_visible_text_is_echoed_by_the_repair() -> None:
    truncated = ProviderCallError(ErrorKind.TRUNCATED, "MAX_TOKENS", usage=USAGE, maybe_billed=True)
    truncated.reply_text = '{"verdict": "ok", "note": "cut of'
    adapter = FakeAdapter(script=[truncated, VALID])
    agent, _ = port(adapter)
    run(agent.run(card("question")))
    assert adapter.requests[1].messages == (
        Message("user", "question"),
        Message("model", truncated.reply_text),
        Message("user", TRUNCATED_NOTE),
    )


# ---------------------------------------------------------------- Codex round 3: deadline before dispatch, thinking


class SlowReserve(RunBudget):
    async def reserve(self, req: ModelCallRequest) -> Reservation:
        await asyncio.sleep(0.1)
        return await super().reserve(req)


def test_a_deadline_that_passes_while_reserving_releases_the_hold_and_sends_nothing() -> None:
    adapter = FakeAdapter(script=[VALID])
    budget = SlowReserve(CEILING)
    agent = AgentPort(adapter, budget, PortOptions(sleep=no_sleep))
    with pytest.raises(ProviderFailedError, match="before dispatch"):
        run(agent.run(dataclasses.replace(card(), deadline_s=0.02)))
    [held] = budget.reservations.values()
    assert (held.state, held.dispatched, adapter.requests) == ("released", False, [])


L31, L35 = VertexModel.FLASH_LITE_31, VertexModel.FLASH_LITE_35
DATA_CLASSES: dict[CallType, DataClass] = {
    CallType.CARD: "public",
    CallType.SUBJECT: "subject_private",
    CallType.REFEREE: "evaluator",
}


@pytest.mark.parametrize(
    ("call_type", "purpose", "model", "thinking", "allowed"),
    [
        (CallType.CARD, "coach.card", L35, ThinkingLevel.HIGH, False),
        (CallType.SUBJECT, "subject.answer", L31, ThinkingLevel.LOW, False),
        (CallType.REFEREE, "referee_subject", L31, ThinkingLevel.LOW, True),
        (CallType.REFEREE, "r3_subject", L31, ThinkingLevel.LOW, True),
        (CallType.REFEREE, "referee_assistant", L35, ThinkingLevel.MINIMAL, True),
        (CallType.REFEREE, "r3_investigator", L35, ThinkingLevel.MINIMAL, True),
        (CallType.REFEREE, "referee_subject", L31, ThinkingLevel.MINIMAL, False),
        (CallType.REFEREE, "referee_subject", L35, ThinkingLevel.LOW, False),
        (CallType.REFEREE, "referee_assistant", L35, ThinkingLevel.LOW, False),
        (CallType.REFEREE, "referee_assistant", L31, ThinkingLevel.MINIMAL, False),
    ],
)
def test_thinking_follows_the_call_type_and_the_referee_s_model_and_purpose(
    call_type: CallType, purpose: str, model: VertexModel, thinking: ThinkingLevel, allowed: bool
) -> None:
    adapter = FakeAdapter(script=[VALID])
    agent, budget = port(adapter)
    data_class = DATA_CLASSES[call_type]
    context = CallContext(call_type=call_type, purpose=purpose, step_key=f"s:{uuid4()}", data_class=data_class)
    call = dataclasses.replace(card(), model=model, thinking=thinking, context=context)
    if allowed:
        assert run(agent.run(call)).attempts == 1
    else:
        with pytest.raises(PolicyRefusedError, match="thinking"):
            run(agent.run(call))
        assert budget.ops == []


class SlowRecord(RunBudget):
    """Signals when a receipt write begins, then takes a while to finish it."""

    entered: asyncio.Event | None = None

    async def record(self, report: UsageReport) -> UsageResult:
        if self.entered is not None:
            self.entered.set()
        await asyncio.sleep(0.05)
        return await super().record(report)


def test_a_cancellation_during_the_receipt_write_still_completes_the_receipt_and_the_settlement() -> None:
    budget = SlowRecord(CEILING)
    agent = AgentPort(FakeAdapter(script=[VALID], usage=USAGE), budget, PortOptions(sleep=no_sleep))

    async def cancel_mid_receipt() -> None:
        budget.entered = asyncio.Event()
        task = asyncio.create_task(agent.run(card()))
        await budget.entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(cancel_mid_receipt())
    [row] = budget.rows
    assert (row.report.input_tokens, row.report.output_tokens) == (USAGE.input_tokens, USAGE.output_tokens)
    [held] = budget.reservations.values()
    assert (held.state, held.settled_usd) == ("committed", row.cost_usd)  # the known usage, not the full hold
