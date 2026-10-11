"""Typed wrappers for S4 functions, under S4's own names (S4 section 12; S5 4.6's `db/calls.py`, C-30).

This file ships only what WP-07's mirror writer and `make traces-push` pump need: ``ops.mirror_spans``,
``ops.set_export_state``, ``ops.record_trace_summary``, ``ops.prune_trace_mirror`` (S4 8.4), a reader for
``ops.v_exportable_spans``, and a reader for already-``exported``-but-not-yet-``verified`` rows (direct
``ops.trace_mirror`` select; ``arena_referee``'s grant reaches the whole table, not just the view). Later
work packages add the rest of this file's wrappers (turn work, the spend guard, review queue, ...) under the
same S4 names as they need them.

A plain, synchronous connection (``SqlConnection``, satisfied by ``psycopg.Connection``): the async pool (S5
6.4, ``db/pool.py``) is for the long-running api/subject/referee services; ``make traces-push`` is a one-shot
CLI, so a throwaway sync connection per run is simplest (D-016) and needs no pool. Every wrapper here assumes
the connection's cursor returns plain tuple rows (``psycopg``'s default): a caller that configured a
non-tuple ``row_factory`` must pass a cursor-scoped override instead.

Every write runs through ``_run``: on a failed statement the connection is rolled back before the exception
propagates. PostgreSQL leaves a connection in "current transaction is aborted" after any failed statement; a
long-lived connection (``PostgresMirrorSink`` holds one across many flushes) that is never rolled back after
one failure would refuse every later statement too (verified via the psycopg docs, Context7
`/psycopg/psycopg`, "Transactions management").
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, cast

from psycopg.types.json import Jsonb

from arena_core.observability.processors import SpanRow

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


def exported_unverified_spans(conn: SqlConnection, *, limit: int = MIRROR_BATCH_LIMIT) -> list[tuple[str, str]]:
    """``(trace_id, span_id)`` pairs still ``exported`` (direct ``select`` against ``ops.trace_mirror``, not
    the ``ops.v_exportable_spans`` view, which never lists ``exported`` rows): a pump pass that marked these
    exported but could not confirm them by read-back (a timeout, Phoenix briefly down) must retry them on a
    later run, or they stay ``exported`` forever -- `ops.v_exportable_spans` has no path back from
    ``exported`` to ``pending``."""
    cur = conn.cursor()
    cur.execute(
        "select trace_id, span_id from ops.trace_mirror where export_state = 'exported' order by created_at limit %s",
        (limit,),
    )
    return [(cast(str, row[0]), cast(str, row[1])) for row in cur.fetchall()]


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
