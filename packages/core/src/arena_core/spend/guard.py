"""The spend-guard client: reserve, dispatch, record usage, settle against S4's ops.* functions (S5 4.6).

Adapted from TechnoMile `bh_core/providers/budget.py` (`RunBudget` reserve / check_admission / settle, T3) and
`providers/ledger.py` (`CostRecord`, T9; ATTRIBUTIONS.md): the in-memory per-run cap is replaced by S4's
transactional SQL, because four processes share one ceiling; the fail-closed semantics are kept (a refusal raises a
typed error before anything is sent), and the cost record becomes one `ops.model_calls` row per attempt written by
`ops.record_usage`. The in-memory class survives only as the unit-test double (`arena_core.spend.memory`).

The client never computes an amount for the database to trust: it passes the request's byte size and each attempt's
token counts; the database prices both, reads the kill switch and enforces the ceiling in the same transaction.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol
from uuid import UUID

from arena_core.db import calls
from arena_core.db.calls import GuardProtocolError, ModelCallRequest, SettleOutcome, UsageReport, UsageResult
from arena_core.db.pool import Connector
from arena_core.providers.errors import BudgetRefusedError, KillSwitchOnError

KILL_SWITCH = "kill_switch"


@dataclass(frozen=True)
class Reservation:
    id: UUID
    reserved_usd: Decimal
    existed: bool  # the key already named a reservation (a restarted caller finding its own, S5 5.1)
    state: str  # reserved | committed | released | usage_unknown
    dispatched: bool


def refusal(reason: str | None) -> BudgetRefusedError | KillSwitchOnError:
    """The typed error for a refusal the database returned."""
    if reason == KILL_SWITCH:
        msg = "the kill switch is on"
        return KillSwitchOnError(msg)
    return BudgetRefusedError(reason or "unknown")


def reservation_from(result: calls.ReserveResult) -> Reservation:
    """A reservation from `ops.reserve_model_call`'s answer, or the typed refusal raised."""
    if result.outcome == "refused":
        raise refusal(result.reason)
    if result.reservation_id is None or result.reserved_usd is None:
        msg = "reservation answer without id or amount"
        raise GuardProtocolError(msg)
    existed = result.outcome == "exists"
    return Reservation(
        id=result.reservation_id,
        reserved_usd=result.reserved_usd,
        existed=existed,
        state=(result.state or "reserved") if existed else "reserved",
        dispatched=result.dispatched,
    )


class GuardSession(Protocol):
    """One logical call's conversation with the guard (one connection for the call's lifetime)."""

    async def reserve(self, req: ModelCallRequest) -> Reservation: ...

    async def dispatch(self, reservation_id: UUID) -> None: ...

    async def record(self, report: UsageReport) -> UsageResult: ...

    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> Decimal: ...


class SpendGuard(Protocol):
    def session(self) -> AbstractAsyncContextManager[GuardSession]: ...


class _DbSession:
    def __init__(self, conn: calls.Conn) -> None:
        self._conn = conn

    async def reserve(self, req: ModelCallRequest) -> Reservation:
        return reservation_from(await calls.reserve_model_call(self._conn, req))

    async def dispatch(self, reservation_id: UUID) -> None:
        result = await calls.mark_dispatched(self._conn, reservation_id)
        if result.outcome == "refused":
            raise refusal(result.reason)
        if result.outcome != "dispatched":
            msg = f"reservation {reservation_id} cannot be dispatched: {result.outcome}"
            raise GuardProtocolError(msg)

    async def record(self, report: UsageReport) -> UsageResult:
        return await calls.record_usage(self._conn, report)

    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> Decimal:
        result = await calls.settle_reservation(self._conn, reservation_id, outcome)
        if result.outcome == "already_settled":
            msg = f"reservation {reservation_id} was already settled ({result.state})"
            raise GuardProtocolError(msg)
        return result.settled_usd


class DbSpendGuard:
    """The runtime guard: every call goes through S4's functions on the role's own credential."""

    def __init__(self, connect: Connector) -> None:
        self._connect = connect

    @asynccontextmanager
    async def _open(self) -> AsyncIterator[GuardSession]:
        async with self._connect() as conn:
            yield _DbSession(conn)

    def session(self) -> AbstractAsyncContextManager[GuardSession]:
        return self._open()
