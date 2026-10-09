"""`RunBudget`: the in-memory spend guard, a unit-test double only (S8 WP-05; S5 T3, X-05).

TechnoMile's `RunBudget` (`providers/budget.py`, T3) kept a per-run cap in memory. Here the same name is a test double
that mirrors S4's rules (amount formulas from `arena_core.spend.rates`, the ceiling, the kill switch, settle-once,
released only before dispatch, usage_unknown keeps the full hold) so the port's unit tests run without a database.
No runtime call reserves through it: every runtime process builds `DbSpendGuard` (X-05: no in-process ledger). The
integration tests prove the same behaviour against the real migrated database.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from uuid import UUID, uuid4

from arena_core.db.calls import GuardProtocolError, ModelCallRequest, SettleOutcome, UsageReport, UsageResult
from arena_core.providers.errors import BudgetRefusedError, KillSwitchOnError
from arena_core.spend import rates
from arena_core.spend.guard import GuardSession, Reservation
from arena_core.spend.limits import ATTEMPTS, LIMITS, CallType, VertexModel


@dataclass
class HeldReservation:
    key: str
    identity: tuple[object, ...]
    model: str
    input_bytes: int
    reserved_usd: Decimal
    state: str = "reserved"
    dispatched: bool = False
    settled_usd: Decimal | None = None


@dataclass(frozen=True)
class UsageRow:
    report: UsageReport
    cost_usd: Decimal

    @property
    def reservation_id(self) -> UUID:
        return self.report.reservation_id

    @property
    def seq(self) -> int:
        return self.report.seq


KILL_MESSAGE = "the kill switch is on"


class _MemorySession:
    """One call's session on the double: its own step claims, everything else delegated to the budget."""

    def __init__(self, budget: RunBudget) -> None:
        self.budget = budget
        self.claimed: set[str] = set()

    async def claim(self, step_key: str) -> bool:
        if step_key in self.budget.held_steps:
            return False
        self.budget.held_steps.add(step_key)
        self.claimed.add(step_key)
        return True

    async def reserve(self, req: ModelCallRequest) -> Reservation:
        return await self.budget.reserve(req)

    async def dispatch(self, reservation_id: UUID) -> None:
        await self.budget.dispatch(reservation_id)

    async def record(self, report: UsageReport) -> UsageResult:
        return await self.budget.record(report)

    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> Decimal:
        return await self.budget.settle(reservation_id, outcome)


@dataclass
class RunBudget:
    """In-memory guard with S4's semantics. ``ops`` logs every call for assertions (op name, reservation id)."""

    ceiling_usd: Decimal
    kill_switch: bool = False
    reservations: dict[UUID, HeldReservation] = field(default_factory=dict)
    rows: list[UsageRow] = field(default_factory=list)
    ops: list[tuple[str, UUID | None]] = field(default_factory=list)
    held_steps: set[str] = field(default_factory=set)

    def liability(self) -> Decimal:
        total = Decimal(0)
        for r in self.reservations.values():
            if r.state in ("reserved", "usage_unknown"):
                total += r.reserved_usd
            elif r.state == "committed" and r.settled_usd is not None:
                total += r.settled_usd
        return total

    @asynccontextmanager
    async def _open(self) -> AsyncIterator[GuardSession]:
        session = _MemorySession(self)
        try:
            yield session
        finally:
            self.held_steps -= session.claimed  # a session's steps end with it, as a database session's locks do

    def session(self) -> AbstractAsyncContextManager[GuardSession]:
        return self._open()

    async def reserve(self, req: ModelCallRequest) -> Reservation:
        identity: tuple[object, ...] = (
            req.bucket,
            req.model,
            req.call_kind,
            req.purpose,
            req.trial_id,
            req.actor_user_id,
            req.input_bytes,
        )
        for rid, held in self.reservations.items():
            if held.key == req.key:
                if held.identity != identity:
                    msg = "AR003: reservation key reused with different inputs"
                    raise GuardProtocolError(msg)
                self.ops.append(("reserve_exists", rid))
                return Reservation(rid, held.reserved_usd, True, held.state, held.dispatched)
        self.ops.append(("reserve", None))
        if self.kill_switch:
            raise KillSwitchOnError(KILL_MESSAGE)
        kind = CallType(req.call_kind)
        if not 1 <= req.input_bytes <= LIMITS[kind].input_bytes:
            msg = f"AR007: input of {req.input_bytes} bytes is outside the {req.call_kind} call's limit"
            raise GuardProtocolError(msg)
        amount = rates.model_call_reservation(VertexModel(req.model), kind, req.input_bytes)
        if self.liability() + amount > self.ceiling_usd:
            raise BudgetRefusedError("cap")
        rid = uuid4()
        self.reservations[rid] = HeldReservation(req.key, identity, req.model, req.input_bytes, amount)
        return Reservation(rid, amount, False, "reserved", False)

    async def dispatch(self, reservation_id: UUID) -> None:
        self.ops.append(("dispatch", reservation_id))
        held = self.reservations[reservation_id]
        if held.state != "reserved" or held.dispatched:
            msg = f"reservation {reservation_id} cannot be dispatched"
            raise GuardProtocolError(msg)
        if self.kill_switch:
            raise KillSwitchOnError(KILL_MESSAGE)
        held.dispatched = True

    async def record(self, report: UsageReport) -> UsageResult:
        self.ops.append(("record", report.reservation_id))
        held = self.reservations[report.reservation_id]
        if not held.dispatched or held.state != "reserved" or report.seq > ATTEMPTS or report.model != held.model:
            msg = "AR001/AR007: usage refused"
            raise GuardProtocolError(msg)
        if any(r.reservation_id == report.reservation_id and r.seq == report.seq for r in self.rows):
            msg = "AR003: usage report number reused"
            raise GuardProtocolError(msg)
        cost = rates.receipt_usd(VertexModel(report.model), report.input_tokens, report.output_tokens)
        self.rows.append(UsageRow(report, cost))
        spend = sum((r.cost_usd for r in self.rows if r.reservation_id == report.reservation_id), Decimal(0))
        overrun = spend > held.reserved_usd
        if overrun:
            self.kill_switch = True
        return UsageResult("overrun" if overrun else "recorded", cost, spend, held.reserved_usd, overrun)

    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> Decimal:
        self.ops.append(("settle", reservation_id))
        held = self.reservations[reservation_id]
        if held.state != "reserved":
            msg = "AR010: already settled"
            raise GuardProtocolError(msg)
        receipts = [r.cost_usd for r in self.rows if r.reservation_id == reservation_id]
        if outcome == "released" and (held.dispatched or receipts):
            msg = "AR001: a started reservation is not releasable"
            raise GuardProtocolError(msg)
        if outcome == "committed" and not receipts:
            msg = "AR007: a committed call needs its usage receipts"
            raise GuardProtocolError(msg)
        spent = sum(receipts, Decimal(0))
        amount = {"released": Decimal(0), "usage_unknown": max(held.reserved_usd, spent), "committed": spent}[outcome]
        held.state, held.settled_usd = outcome, amount
        return amount
