"""The agent port: one typed path for every model call (S5 3.2; S2 2, 10).

Adapted from TechnoMile `bh_core/providers/port.py` (`_structured` repair loop lines 246-262, `_with_retries` and
`_attempt_once` lines 462-567, `_charge` / `_record` lines 686-727; T6) and the typed turn of
`services/run/src/bh_run/tail/a2a.py` lines 221-240 (`typed_turn`, T10); ATTRIBUTIONS.md. What changed:

- one route only (Vertex, or the fake adapter in ARENA_MODEL_MODE=fake): no fail-over ladder, no free-tier cooldowns;
- one reservation per logical call, for all of its attempts, made in the database BEFORE anything is sent and
  priced on the request's measured UTF-8 bytes plus REPAIR_BYTES (D11); a request over the call type's byte limit
  raises InputTooLargeError before any reservation row exists, and no send may exceed the reserved bytes;
- at most ATTEMPTS (4) sends per call, whatever their reason (S5 3.4), of which at most one is a repair (TechnoMile
  allowed two repairs of three transient attempts each, nine sends);
- the repair re-prompt is built by measurement (S2 2, 10, SG2-25): the echoed reply is cut at a character boundary
  until the serialized repaired request fits the reserved bytes; the schema is never repeated as prompt text;
- one `ops.model_calls` row per attempt (`ops.record_usage`) and one `llm.<call_type>` span per attempt whose ids the
  row carries; one `ops.mark_dispatched` and one `ops.settle_reservation` per call: `committed` when every attempt's
  usage is known, `usage_unknown` (the full hold stays charged) when any attempt may have been billed without
  reported usage or its receipt could not be written, `released` only when nothing was dispatched.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import random
import time
from collections.abc import Awaitable, Callable, Coroutine
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any
from uuid import UUID

from opentelemetry.trace import Status, StatusCode, Tracer
from pydantic import BaseModel

from arena_core.agents.repair import MAX_TOKENS_REPAIR, output_errors, repair_message
from arena_core.db.calls import GUARD_ERRORS, ModelCallRequest, SettleOutcome, UsageReport, UsageResult, UsageStatus
from arena_core.policy import check_call_policy
from arena_core.providers.errors import (
    ErrorKind,
    InputTooLargeError,
    KillSwitchOnError,
    LedgerStalledError,
    PolicyRefusedError,
    ProviderBlockedError,
    ProviderCallError,
    ProviderFailedError,
    StepInProgressError,
    StructuredOutputError,
)
from arena_core.providers.retry import RetryPolicy
from arena_core.providers.structured import sent_schema
from arena_core.providers.telemetry import default_tracer, llm_span, span_ids
from arena_core.providers.types import (
    AgentCall,
    AgentResult,
    Message,
    ModelAdapter,
    ModelRequest,
    RawCompletion,
    Usage,
    request_bytes,
)
from arena_core.spend.guard import GuardSession, Reservation, SpendGuard
from arena_core.spend.limits import DEFAULT_TIMING, MAX_REPAIRS, REPAIR_BYTES, CallLimits

# S4 idempotency keys are 8..200 characters; the port appends ":<n>" with n <= MAX_KEY_ROUNDS.
STEP_KEY_MIN, STEP_KEY_MAX = 6, 190
# How many reservation keys one step may use: a restarted caller settles its dispatched hold and takes the next.
MAX_KEY_ROUNDS = 8
SEED_MASK = 0x7FFFFFFF  # Vertex GenerationConfig.seed is int32

TRUNCATED_NOTE = MAX_TOKENS_REPAIR
BLOCKED_NOTE = "Reply again with only the JSON object."
EMPTY_NOTE = repair_message(["reply: empty"])
# A settlement that cannot be written (a database error, a stalled write) leaves the hold charged in full.
LEDGER_FAILURES: tuple[type[Exception], ...] = (*GUARD_ERRORS, LedgerStalledError)
OVERRUN_MESSAGE = "usage overran the reservation; the kill switch is on"


def seed_for(trial: str, turn_no: int, purpose: str, attempt: int) -> int:
    """S2 1 seed rule (`sha256(trial:turn_id:purpose:attempt)[:4]`), masked to Vertex's int32 range."""
    digest = hashlib.sha256(f"{trial}:t{turn_no:02d}:{purpose}:{attempt}".encode()).digest()
    return int.from_bytes(digest[:4], "big") & SEED_MASK


@dataclass(frozen=True)
class PortOptions:
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    tracer: Tracer | None = None  # None: the global OpenTelemetry tracer (WP-07 installs the arena's provider)
    rng: random.Random = field(default_factory=random.SystemRandom)  # backoff jitter
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    clock: Callable[[], float] = time.monotonic
    roster_manifest_shas: frozenset[str] | None = None  # the frozen roster (AST-5); None outside a tournament
    ledger_timeout_s: float = 5.0  # the most one spend-guard write may take before the call fails (LedgerStalledError)


@dataclass
class _Run:
    sends: int = 0
    recorded: int = 0
    unknown: bool = False  # an attempt may have been billed without reported usage
    usage: Usage = field(default_factory=Usage)
    trace_id: str | None = None
    span_id: str | None = None


_Row = tuple[UsageStatus, int, str | None, str | None]  # status, latency ms, trace id, span id


@dataclass(frozen=True)
class _Live:
    """The guard session, the call's reservation and its running tally."""

    guard: GuardSession
    reservation: Reservation
    run: _Run


@dataclass(frozen=True)
class _Plan[T: BaseModel]:
    """Everything fixed for one logical call once its size is measured."""

    call: AgentCall[T]
    limits: CallLimits
    json_schema: dict[str, Any]
    reserved_bytes: int

    def request(self, messages: tuple[Message, ...], attempt: int) -> ModelRequest:
        ctx = self.call.context
        return ModelRequest(
            model=self.call.model,
            system=self.call.system,
            messages=messages,
            json_schema=self.json_schema,
            max_output_tokens=self.limits.output_tokens,
            thinking=self.call.thinking,
            seed=seed_for(str(ctx.trial_id or "none"), ctx.turn_no, ctx.purpose, attempt),
        )


@dataclass(frozen=True)
class _Failure:
    kind: str  # "schema", or an ErrorKind value
    note: str  # the repair's user turn
    reply: str  # the reply text to echo ("" when there is none)
    detail: str


class AgentPort:
    """`AgentPort.run`: policy -> input bound -> reserve -> dispatch -> attempts -> settle (S5 3.2)."""

    def __init__(self, adapter: ModelAdapter, guard: SpendGuard, options: PortOptions | None = None) -> None:
        self._adapter = adapter
        self._guard = guard
        self._opts = options or PortOptions()

    async def run[T: BaseModel](self, call: AgentCall[T]) -> AgentResult[T]:
        """S5 3.1: every failure ends in a typed ProviderError. A database or guard-protocol error (psycopg errors,
        GuardProtocolError) surfaces as ProviderFailedError once the call's own cleanup has run; whatever the call
        could not settle stays held at its full amount. A cancellation propagates unchanged."""
        try:
            return await self._run(call)
        except GUARD_ERRORS as exc:
            msg = f"spend guard failed: {type(exc).__name__}"
            raise ProviderFailedError(msg) from exc

    async def _run[T: BaseModel](self, call: AgentCall[T]) -> AgentResult[T]:
        limits = check_call_policy(call, self._opts.roster_manifest_shas)
        if not STEP_KEY_MIN <= len(call.context.step_key) <= STEP_KEY_MAX:
            msg = f"step key must be {STEP_KEY_MIN}..{STEP_KEY_MAX} characters"
            raise PolicyRefusedError(msg)
        json_schema = sent_schema(call.schema)  # the one schema a request carries and a manifest hashes (S2 3.1)
        measured = request_bytes(_Plan(call, limits, json_schema, 0).request(call.messages, attempt=1))
        reserved_bytes = measured + REPAIR_BYTES
        if reserved_bytes > limits.input_bytes:
            msg = (
                f"input_over_limit: {measured} request bytes + {REPAIR_BYTES} repair bytes exceed the "
                f"{call.context.call_type.value} limit of {limits.input_bytes}"
            )
            raise InputTooLargeError(msg, request_bytes=reserved_bytes, limit_bytes=limits.input_bytes)
        plan = _Plan(call, limits, json_schema, reserved_bytes)
        started = self._opts.clock()
        # S2 2: the deadline bounds the whole call, from here to the last attempt.
        deadline = started + (call.deadline_s or DEFAULT_TIMING[call.context.call_type].deadline_s)
        async with AsyncExitStack() as stack:
            # Opening the session (a database connection) is a ledger operation too: bounded like every write.
            opened = await _bounded_write(stack.enter_async_context(self._guard.session()), self._opts.ledger_timeout_s)
            guard = _BoundedSession(opened, self._opts.ledger_timeout_s)
            reservation = await self._reserve(guard, call, reserved_bytes)
            try:
                await self._dispatch(guard, reservation, deadline)
            except BaseException as exc:
                await self._unwind_dispatch(guard, reservation, exc)
                raise
            run = _Run()
            try:
                value = await self._attempts(_Live(guard, reservation, run), plan, deadline)
            except BaseException as exc:
                await self._settle_failed(guard, reservation, run, exc)
                raise
            outcome: SettleOutcome = "usage_unknown" if run.unknown else "committed"
            cost = await guard.settle(reservation.id, outcome)
        if self._opts.clock() > deadline:
            # S2 2: the deadline bounds the whole call, its settlement included; the spend is already settled.
            msg = f"call deadline passed during settlement of reservation {reservation.id}"
            raise ProviderFailedError(msg)
        return AgentResult(
            value=value,
            attempts=run.sends,
            usage=run.usage,
            cost_usd=cost,
            latency_ms=(self._opts.clock() - started) * 1000,
            trace_id=run.trace_id,
            span_id=run.span_id,
            reservation_id=reservation.id,
        )

    # ------------------------------------------------------------------ reservation
    async def _reserve(self, guard: GuardSession, call: AgentCall[Any], input_bytes: int) -> Reservation:
        """Reserve under `<step_key>:<n>`, skipping keys whose reservation is settled (a finished earlier call).

        An OPEN reservation under the step belongs to a live call unless the caller says otherwise: the port alone
        cannot tell a live holder from a dead one, and the step's owner is its work item (S5 5.1, D3; one owner per
        request key, SG3-25). So without `context.recover` the call is refused (StepInProgressError) and nothing is
        settled or sent. With it (the work-item owner found its previous attempt dead), an undispatched hold is
        resumed and a dispatched one is settled usage_unknown, keeping its full hold, before the next key is used
        (S5 4.10 recovery, S2 AT-PORT-6)."""
        ctx = call.context
        for n in range(1, MAX_KEY_ROUNDS + 1):
            found = await guard.reserve(
                ModelCallRequest(
                    key=f"{ctx.step_key}:{n}",
                    bucket=ctx.bucket,
                    model=call.model.value,
                    call_kind=ctx.call_type.value,
                    purpose=ctx.purpose,
                    trial_id=ctx.trial_id,
                    actor_user_id=ctx.actor_user_id,
                    input_bytes=input_bytes,
                )
            )
            if not found.existed:
                return found
            if found.state != "reserved":
                continue
            if not ctx.recover:
                msg = f"step {ctx.step_key!r} has an open reservation; nothing reserved or sent"
                raise StepInProgressError(msg)
            if not found.dispatched:
                return found
            await guard.settle(found.id, "usage_unknown")
        msg = f"step {ctx.step_key!r} used all {MAX_KEY_ROUNDS} reservation keys"
        raise ProviderFailedError(msg)

    async def _dispatch(self, guard: GuardSession, reservation: Reservation, deadline: float) -> None:
        """`ops.mark_dispatched`, unless the deadline already passed while the reservation was made."""
        if self._opts.clock() >= deadline:
            msg = "call deadline reached before dispatch; nothing sent"
            raise ProviderFailedError(msg)
        await guard.dispatch(reservation.id)

    def _receipt_bound(self) -> float:
        """The outer bound around a receipt and its tally: past the inner write's own bound and its cleanup, so the
        write's session times out (and is marked stalled) first."""
        return self._opts.ledger_timeout_s + 2 * CLEANUP_S

    async def _unwind_dispatch(self, guard: GuardSession, reservation: Reservation, exc: BaseException) -> None:
        """Nothing was sent. A refused dispatch (the deadline, the kill switch) left the hold undispatched: release it.
        Any other failure (a cancellation, a lost connection) may have come after `ops.mark_dispatched` committed,
        and S4 refuses to release a dispatched hold: then it settles usage_unknown, keeping the full hold. The
        original exception is what propagates; a failed settlement rides along as a note."""
        try:
            await guard.settle(reservation.id, "released")
        except LEDGER_FAILURES as not_releasable:
            exc.add_note(f"reservation {reservation.id} not releasable ({type(not_releasable).__name__})")
            try:
                await guard.settle(reservation.id, "usage_unknown")
            except LEDGER_FAILURES as settle_exc:
                exc.add_note(f"settlement of reservation {reservation.id} failed: {type(settle_exc).__name__}")

    async def _settle_failed(
        self, guard: GuardSession, reservation: Reservation, run: _Run, exc: BaseException
    ) -> None:
        """Settle a call that ended in an exception: committed only when every send left a usage receipt and no
        attempt may have been billed unseen; usage_unknown otherwise (the hold was dispatched, so never released)."""
        complete = run.sends > 0 and run.recorded == run.sends and not run.unknown
        outcome: SettleOutcome = "committed" if complete else "usage_unknown"
        try:
            await guard.settle(reservation.id, outcome)
        except LEDGER_FAILURES as settle_exc:
            # The hold stays `reserved` and counts at its full amount against the ceiling: still fail-safe. The
            # call's own failure is what the caller acts on; the settlement failure rides along as a note.
            exc.add_note(f"settlement of reservation {reservation.id} failed: {type(settle_exc).__name__}")

    # ------------------------------------------------------------------ attempts
    async def _attempts[T: BaseModel](self, live: _Live, plan: _Plan[T], deadline: float) -> T:
        call, opts, run = plan.call, self._opts, live.run
        timeout = call.timeout_s or DEFAULT_TIMING[call.context.call_type].attempt_timeout_s  # S2 2 when unset
        request = plan.request(call.messages, attempt=1)
        repairs = transient_retries = 0
        failure: _Failure | None = None
        while run.sends < opts.retry.max_attempts:
            attempt_timeout = min(timeout, deadline - opts.clock())
            if attempt_timeout <= 0:
                msg = f"call deadline reached after {run.sends} attempt(s)"
                raise ProviderFailedError(msg)
            size = request_bytes(request)
            if size > plan.reserved_bytes:
                msg = f"request of {size} bytes exceeds the {plan.reserved_bytes} bytes reserved; not sent"
                raise InputTooLargeError(msg, request_bytes=size, limit_bytes=plan.reserved_bytes)
            result = await self._attempt(live, plan, request, attempt_timeout)
            current: _Failure
            if isinstance(result, RawCompletion):
                # The one validation and repair message (S2 10), shared with the prompt builders (agents.repair).
                value, errors = output_errors(call.schema, result.text, call.validation_context, call.salt)
                if value is None:
                    current = _Failure("schema", repair_message(errors), result.text, "schema validation failed")
                else:
                    if opts.clock() > deadline:
                        # S2 2: the deadline bounds the call, its receipt included; a late value is a failed call.
                        msg = f"call deadline passed before the reply was recorded ({run.sends} attempt(s))"
                        raise ProviderFailedError(msg)
                    return value
            else:
                current = _failure_of(result)
                if current.kind == ErrorKind.BAD_REQUEST:
                    raise ProviderFailedError(current.detail) from result
            failure = current
            if current.kind == ErrorKind.TRANSIENT:
                # S2 10: the same request again, same seed; the backoff never outlasts the call's deadline.
                if run.sends < opts.retry.max_attempts:
                    transient_retries += 1
                    delay = opts.retry.delay_s(transient_retries, opts.rng)
                    await opts.sleep(min(delay, max(0.0, deadline - opts.clock())))
                continue
            if repairs >= MAX_REPAIRS or run.sends >= opts.retry.max_attempts:
                break
            repairs += 1
            request = _repair(plan, current, attempt=run.sends + 1)
        raise _terminal(failure, run.sends)

    async def _send(
        self, request: ModelRequest, timeout_s: float
    ) -> tuple[RawCompletion | ProviderCallError, UsageStatus]:
        """The adapter call under the attempt timeout; a failure is handed back as the attempt's result."""
        try:
            async with asyncio.timeout(timeout_s):
                return await self._adapter.generate(request, timeout_s=timeout_s), "ok"
        except TimeoutError as exc:
            return _timed_out(timeout_s, exc), "timeout"
        except ProviderCallError as exc:
            return exc, "error"

    async def _record(
        self,
        live: _Live,
        request: ModelRequest,
        usage: Usage | None,
        row: tuple[UsageStatus, int, str | None, str | None],
    ) -> UsageResult:
        """Write the attempt's `ops.model_calls` row: (status, latency, trace id, span id) plus its tokens."""
        status, latency_ms, trace_id, span_id = row
        used = usage or Usage()
        receipt = await live.guard.record(
            UsageReport(
                reservation_id=live.reservation.id,
                seq=live.run.sends,
                model=request.model.value,
                input_tokens=used.input_tokens,
                output_tokens=used.output_tokens,
                thinking_tokens=used.thinking_tokens,
                status=status,
                latency_ms=latency_ms,
                trace_id=trace_id,
                span_id=span_id,
            )
        )
        live.run.recorded += 1
        live.run.usage = live.run.usage.add(used)
        return receipt

    async def _attempt(
        self, live: _Live, plan: _Plan[Any], request: ModelRequest, timeout_s: float
    ) -> RawCompletion | ProviderCallError:
        """One send inside its span; its usage receipt written before the span ends. Failures are returned."""
        run = live.run
        ctx = plan.call.context
        attributes: dict[str, str | int | float] = {
            "arena.call_type": ctx.call_type.value,
            "arena.purpose": ctx.purpose,
            "arena.data_class": ctx.data_class,
            "arena.attempt": run.sends + 1,
            "gen_ai.request.model": request.model.value,
            "gen_ai.request.max_tokens": request.max_output_tokens,
        }
        clock = self._opts.clock
        with llm_span(self._opts.tracer or default_tracer(), f"llm.{ctx.call_type.value}", attributes) as span:
            trace_id, span_id = span_ids(span)
            run.trace_id, run.span_id = trace_id, span_id
            run.sends += 1
            began = clock()
            try:
                result, status = await self._send(request, timeout_s)
            except asyncio.CancelledError:
                # The request may have been billed: its receipt (usage unknown) is written before the cancellation
                # propagates, so every send leaves its row and the call settles usage_unknown (S5 3.2, 3.6).
                run.unknown = True
                row: _Row = ("error", int((clock() - began) * 1000), trace_id, span_id)
                await _bounded_write(self._record(live, request, None, row), self._receipt_bound())
                raise
            usage = result.usage
            if usage is None and (isinstance(result, RawCompletion) or result.maybe_billed):
                run.unknown = True
            # The receipt and its tally complete even if the call is cancelled meanwhile (the row is the spend record).
            row = (status, int((clock() - began) * 1000), trace_id, span_id)
            receipt = await _bounded_write(self._record(live, request, usage, row), self._receipt_bound())
            if receipt.outcome == "overrun":
                # Receipts above the hold: the database turned the kill switch on (S4 8.3). Stop at once.
                raise KillSwitchOnError(OVERRUN_MESSAGE)
            if isinstance(result, ProviderCallError):
                span.set_status(Status(StatusCode.ERROR, result.kind.value))
        return result


# How long an abandoned ledger write may take to unwind (its cancellation and the driver's rollback) before the call
# stops waiting for it; the session that ran it is never used again either way.
CLEANUP_S = 1.0


def _retrieve(task: asyncio.Future[Any]) -> None:
    """Consume a finished task's outcome so an abandoned write never surfaces as an unretrieved exception."""
    if not task.cancelled():
        task.exception()


async def _bounded_write[R](
    write: Coroutine[Any, Any, R], timeout_s: float, on_abandon: Callable[[], None] | None = None
) -> R:
    """Run one ledger operation (opening the session, a reservation, a dispatch, a receipt, a settlement) to completion
    even when the call is cancelled meanwhile, then re-raise the cancellation: a billed attempt always leaves its row,
    and a settled call its settlement (S5 3.2). Bounded: an operation still running after ``timeout_s`` is cancelled,
    given CLEANUP_S to unwind, and abandoned with LedgerStalledError, so a stalled database cannot hang a request.
    ``on_abandon`` runs whenever the operation is abandoned, whichever exception then propagates (the caller's own
    cancellation, or LedgerStalledError)."""
    task = asyncio.ensure_future(write)
    task.add_done_callback(_retrieve)
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout_s
    deferred: list[asyncio.CancelledError] = []
    while not task.done():
        remaining = end - loop.time()
        if remaining <= 0:
            if on_abandon is not None:
                on_abandon()
            task.cancel()
            await asyncio.wait({task}, timeout=CLEANUP_S)  # a cancelled task never raises out of wait
            stalled = LedgerStalledError(f"a spend-guard operation did not finish within {timeout_s}s")
            if deferred:
                deferred[0].add_note(str(stalled))
                raise deferred[0]
            raise stalled
        try:
            await asyncio.wait({task}, timeout=remaining)
        except asyncio.CancelledError as cancelled:
            deferred.append(cancelled)  # keep waiting for the write; the cancellation is delivered once it is done
    result = task.result()
    if deferred:
        raise deferred[0]
    return result


class _BoundedSession:
    """The call's guard session with every operation bounded by `_bounded_write`. After one operation stalls, the
    session's connection may still hold a cancelled statement, so it is never used again: every later operation is
    refused with LedgerStalledError, and whatever the call holds stays charged until it is reaped or recovered."""

    def __init__(self, session: GuardSession, timeout_s: float) -> None:
        self._session = session
        self._timeout_s = timeout_s
        self._stalled = False

    async def _run[R](self, write: Coroutine[Any, Any, R]) -> R:
        if self._stalled:
            write.close()
            msg = "the guard session stalled earlier in this call and is not reused"
            raise LedgerStalledError(msg)
        return await _bounded_write(write, self._timeout_s, self._abandon)

    def _abandon(self) -> None:
        """An operation was abandoned mid-flight: its connection is not used again in this call."""
        self._stalled = True

    async def reserve(self, req: ModelCallRequest) -> Reservation:
        """A reservation that completes while the call is being cancelled is not lost: a hold this call just made
        (never dispatched) is released, bounded, before the cancellation propagates (S5 3.2 lifecycle)."""
        made: list[Reservation] = []

        async def reserve_and_keep() -> Reservation:
            found = await self._session.reserve(req)
            made.append(found)
            return found

        try:
            return await self._run(reserve_and_keep())
        except asyncio.CancelledError as cancelled:
            if made and not made[0].existed and not self._stalled:
                try:
                    await self._run(self._session.settle(made[0].id, "released"))
                except LEDGER_FAILURES as release_failed:
                    cancelled.add_note(f"hold {made[0].id} not released: {type(release_failed).__name__}")
            raise

    async def dispatch(self, reservation_id: UUID) -> None:
        await self._run(self._session.dispatch(reservation_id))

    async def record(self, report: UsageReport) -> UsageResult:
        return await self._run(self._session.record(report))

    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> Decimal:
        return await self._run(self._session.settle(reservation_id, outcome))


def _timed_out(timeout_s: float, cause: TimeoutError) -> ProviderCallError:
    """A timed-out attempt: transient, and it may have been billed without reported usage."""
    error = ProviderCallError(ErrorKind.TRANSIENT, f"timeout after {timeout_s}s", maybe_billed=True)
    error.__cause__ = cause
    return error


def _encodable(text: str) -> str:
    """The text with anything UTF-8 cannot carry (an unpaired surrogate in a model reply) replaced by U+FFFD, so the
    echo can be measured and sent."""
    return text.encode("utf-8", errors="surrogatepass").decode("utf-8", errors="replace")


def _repair(plan: _Plan[Any], failure: _Failure, *, attempt: int) -> ModelRequest:
    """The repaired request: the original messages, the longest prefix of the previous reply that keeps the
    serialized request within the reserved bytes (character boundary), then the error turn (S2 10, SG2-25)."""
    original = plan.call.messages
    failure = dataclasses.replace(failure, reply=_encodable(failure.reply))

    def conversation(prefix_chars: int) -> ModelRequest:
        echo = (Message("model", failure.reply[:prefix_chars]),) if prefix_chars else ()
        return plan.request((*original, *echo, Message("user", failure.note)), attempt)

    def fits(prefix_chars: int) -> bool:
        return request_bytes(conversation(prefix_chars)) <= plan.reserved_bytes

    if not fits(0):
        msg = "the repair turn alone exceeds the reserved bytes; not sent"
        raise InputTooLargeError(msg, request_bytes=plan.reserved_bytes + 1, limit_bytes=plan.reserved_bytes)
    lo, hi = 0, len(failure.reply)  # invariant: fits(lo); the answer is the largest such prefix
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid - 1
    return conversation(lo)


def _failure_of(error: ProviderCallError) -> _Failure:
    notes = {ErrorKind.TRUNCATED: TRUNCATED_NOTE, ErrorKind.BLOCKED: BLOCKED_NOTE, ErrorKind.EMPTY: EMPTY_NOTE}
    return _Failure(error.kind, notes.get(error.kind, ""), error.reply_text, error.message)


def _terminal(failure: _Failure | None, sends: int) -> Exception:
    detail = f"after {sends} attempt(s): {failure.detail if failure else 'no attempt'}"
    if failure is None or failure.kind == ErrorKind.TRANSIENT:
        return ProviderFailedError(detail)
    if failure.kind == ErrorKind.BLOCKED:
        return ProviderBlockedError(detail)
    return StructuredOutputError(detail)
