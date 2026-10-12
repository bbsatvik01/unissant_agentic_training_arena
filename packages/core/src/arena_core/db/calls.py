"""Typed wrappers for S4 functions, under S4's own names (S4 section 12; S5 4.6's `db/calls.py`, C-30).

Two independent sets of wrappers share this module, each under its own connection style:

Spend guard (S5 3, 4; WP-05): each wrapper runs one ``select ops.<function>(...)`` inside its own
transaction (a savepoint when the caller already holds one), over the ASYNC pool (S5 6.4, ``db/pool.py``;
``AsyncConnection``) the long-running api/subject/referee services use. A refusal the function RETURNS
commits with the transaction, exactly as S4 designs it. The jsonb result is read as text and parsed with
``Decimal`` for every number: money is S4's ``ops.usd`` (numeric(14, 6)), never a float. Errors the
functions RAISE (AR001, AR003, AR007, AR040, 42501) propagate as ``psycopg.Error``: they are defects or role
violations, not outcomes a caller can act on. The caller never supplies an amount: reservations take a byte
size, usage takes token counts, and the database prices both.

Observability mirror and pump (S4 8.4; S5 4.6's `db/calls.py`, C-30; WP-07): ``ops.mirror_spans``,
``ops.set_export_state``, ``ops.record_trace_summary``, ``ops.prune_trace_mirror``, a reader for
``ops.v_exportable_spans``, and a reader for already-``exported``-but-not-yet-``verified`` rows (direct
``ops.trace_mirror`` select; ``arena_referee``'s grant reaches the whole table, not just the view). A plain,
SYNCHRONOUS connection (``SqlConnection``, satisfied by ``psycopg.Connection``): ``make traces-push`` is a
one-shot CLI, so a throwaway sync connection per run is simplest (D-016) and needs no pool. Every wrapper
here assumes the connection's cursor returns plain tuple rows (``psycopg``'s default): a caller that
configured a non-tuple ``row_factory`` must pass a cursor-scoped override instead. Every write runs through
``_run``: on a failed statement the connection is rolled back before the exception propagates. PostgreSQL
leaves a connection in "current transaction is aborted" after any failed statement; a long-lived connection
(``PostgresMirrorSink`` holds one across many flushes) that is never rolled back after one failure would
refuse every later statement too (verified via the psycopg docs, Context7 `/psycopg/psycopg`, "Transactions
management").

Later work packages add the rest of this file's wrappers (turn work, review queue, ...) under the same S4
names as they need them.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Protocol, cast, get_args
from uuid import UUID

import psycopg
from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from arena_core.observability.processors import SpanRow

# ============================================================================================= spend guard
# S5 3, 4; WP-05. Async wrappers over the long-running services' pool (db/pool.py).

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


# ===================================================================== seeding: case ingest, candidates, allowlist
# S1 10.5, S2 3.1, S4 2.3; owner credential only (`scripts/seed_hosted.py`). Each wrapper is one idempotent S4
# function call: a repeated identical call returns the row that already exists rather than erroring (AR003 is a
# real conflict -- the same name reused with different content -- never a retry).


async def ingest_case_family(conn: Conn, bundle: Mapping[str, Any]) -> UUID:
    """`sealed.ingest_case_family(p_bundle)` (S1 4.4, 10.5; `arena_core.scenario.load.IngestBundle.as_json()`).
    Idempotent on `family_code`: an identical bundle returns the existing family's id; a `family_code` already
    ingested with different content raises (AR003, S4's own conflict, not retried here)."""
    async with conn.transaction():
        cur = await conn.execute("select sealed.ingest_case_family(%s)", (Jsonb(dict(bundle)),))
        row = await cur.fetchone()
    if row is None:
        msg = "sealed.ingest_case_family returned no row"
        raise GuardProtocolError(msg)
    return cast("UUID", row[0])


async def register_candidate(conn: Conn, *, kind: str, name: str, version: str, manifest: Mapping[str, Any]) -> UUID:
    """`arena.register_candidate(kind, name, version, manifest)` (S2 3.1, 3.2). Idempotent on `(kind, name,
    version)`: the same manifest returns the existing candidate's id; a reused version with a different
    manifest raises (AR003)."""
    async with conn.transaction():
        cur = await conn.execute(
            "select arena.register_candidate(%s, %s, %s, %s)", (kind, name, version, Jsonb(dict(manifest)))
        )
        row = await cur.fetchone()
    if row is None:
        msg = "arena.register_candidate returned no row"
        raise GuardProtocolError(msg)
    return cast("UUID", row[0])


async def allowlist_user(conn: Conn, *, user_id: UUID, email: str) -> None:
    """One allowlisted investigator (S4 2.3, S5 10.3): an `auth.users` row the operator creates directly, never
    through Supabase Auth (C-02, C-03 -- the browser never reaches Postgres). `user_id` is
    `arena_core.identity.user_id_for(email)`, the same mapping the dev-identity middleware and the hosted IAP
    mapping use, so this row and the allowlist entry (`ARENA_USERS_FILE`, operator-managed, outside this
    database) name the same actor. Idempotent: a repeated call with the same id is a no-op; a `user_id` already
    present under a different email is left exactly as it is (no update), since this never deletes or renames
    an existing allowlisted identity."""
    async with conn.transaction():
        await conn.execute(
            "insert into auth.users (id, email) values (%s, %s) on conflict (id) do nothing", (user_id, email)
        )


# ======================================================================================= observability mirror
# S4 8.4; WP-07. Sync wrappers for the mirror writer and the `make traces-push` pump.

# ops.mirror_spans refuses more than this many spans in one call (S4 8.4); PostgresMirrorSink chunks to it.
MIRROR_BATCH_LIMIT = 500


class SqlCursor(Protocol):
    def execute(self, query: str, params: Sequence[object] = ()) -> object: ...
    def fetchone(self) -> tuple[object, ...] | None: ...
    def fetchall(self) -> list[tuple[object, ...]]: ...


class SqlConnection(Protocol):
    """The slice of ``psycopg.Connection`` these wrappers use (tests pass a scripted stand-in)."""

    def cursor(self) -> SqlCursor: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...


def _run(conn: SqlConnection, query: str, params: Sequence[object]) -> SqlCursor:
    """Execute one statement and commit; on any failure, roll back first so the connection is usable again
    for the next call, then re-raise."""
    cur = conn.cursor()
    try:
        cur.execute(query, params)
    except Exception:
        conn.rollback()
        raise
    conn.commit()
    return cur


def _span_payload(row: SpanRow) -> dict[str, object]:
    return {
        "trace_id": row.trace_id,
        "span_id": row.span_id,
        "parent_span_id": row.parent_span_id,
        "trial_id": row.trial_id,
        "tournament_id": row.tournament_id,
        "split": row.split,
        "name": row.name,
        "kind": row.kind,
        "status": row.status,
        "started_at": row.started_at.isoformat(),
        "ended_at": row.ended_at.isoformat(),
        "otlp": row.otlp,
    }


def _chunks(rows: Sequence[SpanRow], size: int) -> list[Sequence[SpanRow]]:
    return [rows[i : i + size] for i in range(0, len(rows), size)]


def mirror_spans(conn: SqlConnection, service: str, rows: Sequence[SpanRow]) -> int:
    """``select ops.mirror_spans(%s, %s)`` (S4 8.4): an idempotent batch insert, chunked to at most
    ``MIRROR_BATCH_LIMIT`` spans per call (the function's own limit; a larger buffer would be refused
    outright). Returns the number of NEW rows across every chunk (a span already mirrored by an earlier,
    retried write does not count). A failure in one chunk leaves later chunks unsent; already-committed
    chunks stay mirrored (each chunk commits on its own)."""
    if not rows:
        return 0
    total = 0
    for chunk in _chunks(rows, MIRROR_BATCH_LIMIT):
        cur = _run(conn, "select ops.mirror_spans(%s, %s)", (service, Jsonb([_span_payload(r) for r in chunk])))
        written = cur.fetchone()
        total += cast(int, written[0]) if written is not None else 0
    return total


@dataclass(frozen=True)
class ExportableSpan:
    """One row of ``ops.v_exportable_spans`` (S4 8.4): a span the pump may export now -- pending, or held and
    now revealed -- with no span of its trace still held for an unrevealed tournament."""

    trace_id: str
    span_id: str
    parent_span_id: str | None
    service: str
    trial_id: str | None
    name: str
    kind: str
    status: str
    started_at: datetime
    ended_at: datetime
    otlp: dict[str, object]
    export_state: str


def exportable_spans(conn: SqlConnection, *, limit: int = MIRROR_BATCH_LIMIT) -> list[ExportableSpan]:
    """``select * from ops.v_exportable_spans`` (S4 8.4), oldest first so a pump run drains the backlog in
    commit order; bounded to ``limit`` per call. The caller loops (``pump.py``) until a call returns fewer
    rows than ``limit``."""
    cur = conn.cursor()
    cur.execute(
        "select trace_id, span_id, parent_span_id, service, trial_id, name, kind, status, started_at, "
        "ended_at, otlp, export_state from ops.v_exportable_spans order by started_at limit %s",
        (limit,),
    )
    return [_row_to_exportable(row) for row in cur.fetchall()]


def _row_to_exportable(row: tuple[object, ...]) -> ExportableSpan:
    trial_id, otlp = row[4], row[10]
    return ExportableSpan(
        trace_id=cast(str, row[0]),
        span_id=cast(str, row[1]),
        parent_span_id=cast("str | None", row[2]),
        service=cast(str, row[3]),
        trial_id=str(trial_id) if trial_id is not None else None,
        name=cast(str, row[5]),
        kind=cast(str, row[6]),
        status=cast(str, row[7]),
        started_at=cast(datetime, row[8]),
        ended_at=cast(datetime, row[9]),
        otlp=otlp if isinstance(otlp, dict) else {},
        export_state=cast(str, row[11]),
    )


def exported_unverified_spans(conn: SqlConnection, *, limit: int = MIRROR_BATCH_LIMIT) -> list[ExportableSpan]:
    """Full rows still ``exported`` (direct ``select`` against ``ops.trace_mirror``, not the
    ``ops.v_exportable_spans`` view, which never lists ``exported`` rows -- it has no path back from
    ``exported`` to ``pending``). S5 8.4: "Export is retried from the mirror" -- a row an earlier pass
    marked ``exported`` but never confirmed by read-back may really not be in Phoenix at all (OTLP returning
    SUCCESS only means Phoenix accepted the HTTP call; its own ingest queue is in memory and can still lose
    the span after that, S5 8.4's "Phoenix is a viewer, not the store"). The caller (``pump.py``) therefore
    RE-EXPORTS these rows, not just re-reads-back for them -- re-sending an already-ingested span is
    harmless (idempotent on trace and span id, same as ``ops.mirror_spans``)."""
    cur = conn.cursor()
    cur.execute(
        "select trace_id, span_id, parent_span_id, service, trial_id, name, kind, status, started_at, "
        "ended_at, otlp, export_state from ops.trace_mirror where export_state = 'exported' "
        "order by created_at limit %s",
        (limit,),
    )
    return [_row_to_exportable(row) for row in cur.fetchall()]


def set_export_state(conn: SqlConnection, keys: Sequence[tuple[str, str]], state: str) -> int:
    """``select ops.set_export_state(%s, %s)`` (S4 8.4): moves exactly the named ``(trace_id, span_id)`` pairs
    from pending/held to ``exported``, or from ``exported`` to ``verified`` -- and only the ones the function
    allows (a held span moves only once its tournament is revealed). Returns the number actually moved."""
    if not keys:
        return 0
    payload = [{"trace_id": trace_id, "span_id": span_id} for trace_id, span_id in keys]
    cur = _run(conn, "select ops.set_export_state(%s, %s)", (Jsonb(payload), state))
    moved = cur.fetchone()
    return cast(int, moved[0]) if moved is not None else 0


@dataclass(frozen=True)
class TraceSummary:
    """One ``ops.record_trace_summary`` row: spans expected vs mirrored for one request or job task."""

    trace_id: str
    scope: str
    trial_id: str | None
    expected: int
    mirrored: int
    failures: int


def record_trace_summary(conn: SqlConnection, summary: TraceSummary) -> None:
    """``select ops.record_trace_summary(%s, %s, %s, %s, %s, %s)`` (S4 8.4), once (a second call for the same
    ``(trace_id, scope)`` is ignored by the function)."""
    _run(
        conn,
        "select ops.record_trace_summary(%s, %s, %s, %s, %s, %s)",
        (summary.trace_id, summary.scope, summary.trial_id, summary.expected, summary.mirrored, summary.failures),
    )


def prune_trace_mirror(conn: SqlConnection, days: int) -> int:
    """``select ops.prune_trace_mirror(%s)`` (S4 8.4; referee admin task): drops verified, non-hidden spans
    older than ``days`` (>= 7). Returns the number of rows dropped."""
    cur = _run(conn, "select ops.prune_trace_mirror(%s)", (days,))
    dropped = cur.fetchone()
    return cast(int, dropped[0]) if dropped is not None else 0


class PostgresMirrorSink:
    """``observability.processors.MirrorSink`` over a live connection: every flush writes through
    ``mirror_spans`` (chunked to ``MIRROR_BATCH_LIMIT``)."""

    def __init__(self, conn: SqlConnection, service: str) -> None:
        self._conn = conn
        self._service = service

    def write(self, rows: Sequence[SpanRow]) -> int:
        return mirror_spans(self._conn, self._service, rows)
