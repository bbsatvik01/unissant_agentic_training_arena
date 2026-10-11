"""Typed wrappers for S4's spend-guard functions, under S4's own names (S4 section 12; S5 4.6, C-30).

Each wrapper runs one `select ops.<function>(...)` inside its own transaction (a savepoint when the caller already
holds one), so a refusal the function RETURNS commits with the transaction, exactly as S4 designs it. The jsonb
result is read as text and parsed with `Decimal` for every number: money is S4's `ops.usd` (numeric(14, 6)), never a
float. Errors the functions RAISE (AR001, AR003, AR007, AR040, 42501) propagate as `psycopg.Error`: they are defects
or role violations, not outcomes a caller can act on.

The caller never supplies an amount (S5 4.6): reservations take a byte size, usage takes token counts, and the
database prices both.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, cast, get_args
from uuid import UUID

import psycopg
from psycopg import AsyncConnection

SettleOutcome = Literal["committed", "usage_unknown", "released"]
ReserveOutcome = Literal["reserved", "exists", "refused"]
DispatchOutcome = Literal["dispatched", "already_dispatched", "already_settled", "refused"]
UsageStatus = Literal["ok", "error", "timeout", "refused", "usage"]
VoiceKind = Literal["voice_session", "voice_probe"]
Conn = AsyncConnection[Any]


class GuardProtocolError(RuntimeError):
    """The guard refused an operation by raising, or answered with a shape this client does not know."""


# Every failure a guard operation can raise: the database's own errors (AR001, AR003, AR007, AR040, connection
# loss) and this client's protocol errors.
GUARD_ERRORS: tuple[type[Exception], ...] = (psycopg.Error, GuardProtocolError)


@dataclass(frozen=True)
class ReserveResult:
    outcome: ReserveOutcome
    reservation_id: UUID | None
    reserved_usd: Decimal | None
    state: str | None  # `exists` only: the stored reservation's state
    dispatched: bool  # `exists` only: whether it was dispatched
    reason: str | None  # `refused` only: kill_switch | cap | per_user_cap | voice_concurrency | voice_total_cap
    shutoff_usd: Decimal | None = None  # voice `reserved` only


@dataclass(frozen=True)
class DispatchResult:
    outcome: DispatchOutcome
    reason: str | None
    state: str | None


@dataclass(frozen=True)
class UsageResult:
    outcome: Literal["recorded", "exists", "overrun"]
    cost_usd: Decimal
    spend_usd: Decimal
    reserved_usd: Decimal
    shutoff: bool


@dataclass(frozen=True)
class SettleResult:
    outcome: str  # committed | usage_unknown | released | already_settled
    settled_usd: Decimal
    state: str | None  # already_settled only


@dataclass(frozen=True)
class AdmitResult:
    decision: Literal["admit", "skip"]
    reason: str | None
    free_usd: Decimal | None
    needed_usd: Decimal | None


@dataclass(frozen=True)
class BucketStatus:
    bucket: str
    parent: str | None
    ceiling_usd: Decimal
    liability_usd: Decimal
    open_usd: Decimal
    headroom_usd: Decimal
    kill_switch: bool


def _obj(text: object, fn: str) -> dict[str, Any]:
    if not isinstance(text, str):
        msg = f"{fn} returned {type(text).__name__}, expected jsonb"
        raise GuardProtocolError(msg)
    parsed = json.loads(text, parse_float=Decimal, parse_int=Decimal)
    if not isinstance(parsed, dict):
        msg = f"{fn} returned a non-object"
        raise GuardProtocolError(msg)
    return cast("dict[str, Any]", parsed)


def _dec(raw: dict[str, Any], key: str) -> Decimal | None:
    value = raw.get(key)
    return None if value is None else Decimal(value)


def _req_dec(raw: dict[str, Any], key: str, fn: str) -> Decimal:
    value = _dec(raw, key)
    if value is None:
        msg = f"{fn}: missing {key}"
        raise GuardProtocolError(msg)
    return value


def _uuid(raw: dict[str, Any], key: str) -> UUID | None:
    value = raw.get(key)
    return None if value is None else UUID(str(value))


def _outcome[T: str](raw: dict[str, Any], key: str, allowed: tuple[T, ...], fn: str) -> T:
    value = raw.get(key)
    for option in allowed:
        if value == option:
            return option
    msg = f"{fn}: unknown {key} {value!r}"
    raise GuardProtocolError(msg)


async def _call(conn: Conn, fn: str, sql: str, params: tuple[object, ...]) -> dict[str, Any]:
    async with conn.transaction():
        cur = await conn.execute(sql, params)
        row = await cur.fetchone()
    if row is None:
        msg = f"{fn} returned no row"
        raise GuardProtocolError(msg)
    return _obj(row[0], fn)


def _reserve_result(raw: dict[str, Any], fn: str) -> ReserveResult:
    outcome = cast("ReserveOutcome", _outcome(raw, "outcome", get_args(ReserveOutcome), fn))
    return ReserveResult(
        outcome=outcome,
        reservation_id=_uuid(raw, "id"),
        reserved_usd=_dec(raw, "reserved_usd"),
        state=raw.get("state"),
        dispatched=bool(raw.get("dispatched", False)),
        reason=raw.get("reason"),
        shutoff_usd=_dec(raw, "shutoff_usd"),
    )


@dataclass(frozen=True, kw_only=True)
class ModelCallRequest:
    """The arguments of `ops.reserve_model_call`: identifiers, a purpose label and a size, never an amount."""

    key: str
    bucket: str
    model: str
    call_kind: str
    purpose: str
    trial_id: UUID | None
    actor_user_id: UUID | None
    input_bytes: int


@dataclass(frozen=True, kw_only=True)
class UsageReport:
    """The arguments of `ops.record_usage`: one attempt's (or one voice report's) token counts."""

    reservation_id: UUID
    seq: int
    model: str
    input_tokens: int
    output_tokens: int  # thinking included
    thinking_tokens: int
    audio_input_tokens: int = 0
    audio_output_tokens: int = 0
    status: UsageStatus
    latency_ms: int | None
    trace_id: str | None
    span_id: str | None


@dataclass(frozen=True, kw_only=True)
class VoiceRequest:
    """The arguments of `ops.reserve_voice`."""

    key: str
    bucket: str
    kind: VoiceKind
    purpose: str
    trial_id: UUID | None
    actor_user_id: UUID | None


async def reserve_model_call(conn: Conn, req: ModelCallRequest) -> ReserveResult:
    """`ops.reserve_model_call(key, bucket, model, call_kind, purpose, trial, actor, input_bytes)`."""
    fn = "ops.reserve_model_call"
    raw = await _call(
        conn,
        fn,
        "select ops.reserve_model_call(%s, %s, %s, %s, %s, %s, %s, %s)::text",
        (req.key, req.bucket, req.model, req.call_kind, req.purpose, req.trial_id, req.actor_user_id, req.input_bytes),
    )
    return _reserve_result(raw, fn)


async def mark_dispatched(conn: Conn, reservation_id: UUID) -> DispatchResult:
    """`ops.mark_dispatched(reservation)`: the kill switch is read again."""
    fn = "ops.mark_dispatched"
    raw = await _call(conn, fn, "select ops.mark_dispatched(%s)::text", (reservation_id,))
    outcome = cast("DispatchOutcome", _outcome(raw, "outcome", get_args(DispatchOutcome), fn))
    return DispatchResult(outcome=outcome, reason=raw.get("reason"), state=raw.get("state"))


async def record_usage(conn: Conn, report: UsageReport) -> UsageResult:
    """`ops.record_usage(...)`: one `ops.model_calls` row per attempt (seq) or voice usage report."""
    fn = "ops.record_usage"
    raw = await _call(
        conn,
        fn,
        "select ops.record_usage(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)::text",
        (
            report.reservation_id,
            report.seq,
            report.model,
            report.input_tokens,
            report.output_tokens,
            report.thinking_tokens,
            report.audio_input_tokens,
            report.audio_output_tokens,
            report.status,
            report.latency_ms,
            report.trace_id,
            report.span_id,
        ),
    )
    return UsageResult(
        outcome=_outcome(raw, "outcome", ("recorded", "exists", "overrun"), fn),
        cost_usd=_req_dec(raw, "cost_usd", fn),
        spend_usd=_req_dec(raw, "spend_usd", fn),
        reserved_usd=_req_dec(raw, "reserved_usd", fn),
        shutoff=bool(raw.get("shutoff", False)),
    )


def _settle_result(raw: dict[str, Any], fn: str) -> SettleResult:
    outcome = raw.get("outcome")
    if outcome not in ("committed", "usage_unknown", "released", "already_settled"):
        msg = f"{fn}: unknown outcome {outcome!r}"
        raise GuardProtocolError(msg)
    return SettleResult(outcome=str(outcome), settled_usd=_req_dec(raw, "settled_usd", fn), state=raw.get("state"))


async def settle_reservation(conn: Conn, reservation_id: UUID, outcome: SettleOutcome) -> SettleResult:
    """`ops.settle_reservation(reservation, outcome)`: model calls only; settles once."""
    fn = "ops.settle_reservation"
    raw = await _call(conn, fn, "select ops.settle_reservation(%s, %s)::text", (reservation_id, outcome))
    return _settle_result(raw, fn)


async def reserve_voice(conn: Conn, req: VoiceRequest) -> ReserveResult:
    """`ops.reserve_voice(key, bucket, kind, purpose, trial, actor)` (arena_subject): the whole-session hold."""
    fn = "ops.reserve_voice"
    raw = await _call(
        conn,
        fn,
        "select ops.reserve_voice(%s, %s, %s, %s, %s, %s)::text",
        (req.key, req.bucket, req.kind, req.purpose, req.trial_id, req.actor_user_id),
    )
    return _reserve_result(raw, fn)


async def settle_voice_reservation(conn: Conn, reservation_id: UUID, outcome: SettleOutcome) -> SettleResult:
    """`ops.settle_voice_reservation(reservation, outcome)` (arena_subject), after the voice session closed."""
    fn = "ops.settle_voice_reservation"
    raw = await _call(conn, fn, "select ops.settle_voice_reservation(%s, %s)::text", (reservation_id, outcome))
    return _settle_result(raw, fn)


async def admit_unit(conn: Conn, bucket: str, high_cost_usd: Decimal) -> AdmitResult:
    """`ops.admit_unit(bucket, high_cost)`: admit only with 1.5 x the unit's high cost free; holds nothing."""
    fn = "ops.admit_unit"
    raw = await _call(conn, fn, "select ops.admit_unit(%s, %s)::text", (bucket, high_cost_usd))
    return AdmitResult(
        decision=_outcome(raw, "decision", ("admit", "skip"), fn),
        reason=raw.get("reason"),
        free_usd=_dec(raw, "free_usd"),
        needed_usd=_dec(raw, "needed_usd"),
    )


async def budget_status(conn: Conn) -> list[BucketStatus]:
    """`ops.budget_status()`: per-bucket ceiling, liability, open holds, headroom and the kill switch."""
    async with conn.transaction():
        cur = await conn.execute(
            "select bucket, parent, ceiling_usd, liability_usd, open_usd, headroom_usd, kill_switch"
            " from ops.budget_status() order by bucket"
        )
        rows = await cur.fetchall()
    return [
        BucketStatus(
            bucket=str(r[0]),
            parent=None if r[1] is None else str(r[1]),
            ceiling_usd=Decimal(r[2]),
            liability_usd=Decimal(r[3]),
            open_usd=Decimal(r[4]),
            headroom_usd=Decimal(r[5]),
            kill_switch=bool(r[6]),
        )
        for r in rows
    ]


async def set_bucket_ceiling(conn: Conn, *, name: str, parent: str | None, ceiling_usd: Decimal, note: str) -> None:
    """`ops.set_bucket_ceiling(name, parent, ceiling, note)`: owner credential only (scripts/budget_plan.py)."""
    async with conn.transaction():
        await conn.execute("select ops.set_bucket_ceiling(%s, %s, %s, %s)", (name, parent, ceiling_usd, note))


async def set_kill_switch(conn: Conn, *, on: bool, reason: str) -> None:
    """`ops.set_kill_switch(on, reason)`: owner credential only."""
    async with conn.transaction():
        await conn.execute("select ops.set_kill_switch(%s, %s)", (on, reason))
