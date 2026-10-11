"""`make traces-push` pump (S5 8.4, 8.6): exports every row ``ops.v_exportable_spans`` currently names --
pending spans a killed or offline exporter missed, and held spans of a tournament that was just revealed --
then reads them back from Phoenix and marks the confirmed ones ``verified``.

The rows are already sanitized (``SpanMirror`` only ever buffers a span after ``Redactor`` ran on it, S5
8.3), so the pump never re-derives a classification or runs the export boundary again: it rebuilds a
``ReadableSpan`` from the stored, already-redacted attributes and envelope fields, and ships it through the
same OTLP exporter the live services use (``tracing.otlp_exporter``).

Run as the referee admin task (operator-invoked locally; ``ARENA_REFEREE_DSN``, the only role whose grant
reaches ``ops.v_exportable_spans``) and, in the hosted variant, by the tournament job after each block for
non-hidden rows (S5 8.6) -- that caller wiring is outside WP-07's local-mode scope; this module provides the
pump itself.
"""

import argparse
import logging
import os
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

import psycopg
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import SpanContext, Status, StatusCode, TraceFlags

from arena_core.db.calls import ExportableSpan, SqlConnection, exportable_spans, set_export_state
from arena_core.observability.export_policy import AttributeValue
from arena_core.observability.phoenix import PhoenixReadError, PhoenixSpanReader
from arena_core.observability.tracing import TracingSettings, otlp_exporter

logger = logging.getLogger(__name__)

DEFAULT_BATCH_LIMIT = 500  # matches ops.mirror_spans's own batch cap
DEFAULT_READBACK_TIMEOUT_S = 5.0
_STATUS_CODES = {"UNSET": StatusCode.UNSET, "OK": StatusCode.OK, "ERROR": StatusCode.ERROR}


class SpanReader(Protocol):
    """The slice of ``PhoenixSpanReader`` the pump uses (tests pass a scripted stand-in)."""

    def span_ids(self, trace_id: str, *, timeout_s: float) -> set[str]: ...


@dataclass(frozen=True)
class PumpResult:
    read: int
    exported: int
    verified: int
    export_failed: bool


def _ns(moment: datetime) -> int:
    return int(moment.timestamp() * 1_000_000_000)


def _span_context(trace_id: str, span_id: str) -> SpanContext:
    return SpanContext(int(trace_id, 16), int(span_id, 16), is_remote=False, trace_flags=TraceFlags(TraceFlags.SAMPLED))


def rebuild_span(row: ExportableSpan) -> ReadableSpan:
    """A ``ReadableSpan`` reconstructed from one already-sanitized mirror row, for re-export."""
    attributes = row.otlp.get("attributes")
    attrs: dict[str, AttributeValue] = attributes if isinstance(attributes, dict) else {}
    parent = _span_context(row.trace_id, row.parent_span_id) if row.parent_span_id else None
    return ReadableSpan(
        name=row.name,
        context=_span_context(row.trace_id, row.span_id),
        parent=parent,
        resource=Resource({"service.name": row.service}),
        attributes=attrs,
        status=Status(_STATUS_CODES.get(row.status, StatusCode.UNSET)),
        start_time=_ns(row.started_at),
        end_time=_ns(row.ended_at),
    )


def pump_once(
    conn: SqlConnection,
    exporter: SpanExporter,
    reader: SpanReader,
    *,
    batch_limit: int = DEFAULT_BATCH_LIMIT,
    readback_timeout_s: float = DEFAULT_READBACK_TIMEOUT_S,
) -> PumpResult:
    """One pass: export up to ``batch_limit`` exportable rows, mark them ``exported``, read each trace back
    from Phoenix, and mark the confirmed spans ``verified``. A failed export leaves every row ``pending`` or
    ``held`` for the next run (never marked ``exported``); a read-back failure for one trace simply confirms
    nothing for it this pass -- the next pump run tries again."""
    rows = exportable_spans(conn, limit=batch_limit)
    if not rows:
        return PumpResult(read=0, exported=0, verified=0, export_failed=False)
    result = exporter.export([rebuild_span(row) for row in rows])
    if result is not SpanExportResult.SUCCESS:
        return PumpResult(read=len(rows), exported=0, verified=0, export_failed=True)
    keys = [(row.trace_id, row.span_id) for row in rows]
    exported = set_export_state(conn, keys, "exported")
    by_trace: dict[str, set[str]] = {}
    for row in rows:
        by_trace.setdefault(row.trace_id, set()).add(row.span_id)
    verify_keys: list[tuple[str, str]] = []
    for trace_id, span_ids in by_trace.items():
        try:
            confirmed = reader.span_ids(trace_id, timeout_s=readback_timeout_s)
        except PhoenixReadError:
            logger.warning("pump: read-back failed for trace %s; left exported, not yet verified", trace_id)
            continue
        verify_keys.extend((trace_id, span_id) for span_id in span_ids & confirmed)
    verified = set_export_state(conn, verify_keys, "verified")
    return PumpResult(read=len(rows), exported=exported, verified=verified, export_failed=False)


MAX_DRAIN_PASSES = 1_000  # fail-safe bound against an unbounded loop


def drain(
    conn: SqlConnection,
    exporter: SpanExporter,
    reader: SpanReader,
    *,
    batch_limit: int = DEFAULT_BATCH_LIMIT,
    readback_timeout_s: float = DEFAULT_READBACK_TIMEOUT_S,
) -> PumpResult:
    """Run ``pump_once`` until a pass reads fewer than ``batch_limit`` rows (the backlog is drained) or a pass
    fails to export, bounded to ``MAX_DRAIN_PASSES`` (fail-safe against an unbounded loop)."""
    totals = PumpResult(read=0, exported=0, verified=0, export_failed=False)
    for _ in range(MAX_DRAIN_PASSES):
        result = pump_once(conn, exporter, reader, batch_limit=batch_limit, readback_timeout_s=readback_timeout_s)
        totals = PumpResult(
            read=totals.read + result.read,
            exported=totals.exported + result.exported,
            verified=totals.verified + result.verified,
            export_failed=totals.export_failed or result.export_failed,
        )
        if result.export_failed or result.read < batch_limit:
            return totals
    return totals


def _connect(dsn: str) -> psycopg.Connection:
    return psycopg.connect(dsn)


def main(
    argv: Sequence[str] | None = None,
    *,
    connect: Callable[[str], SqlConnection] = _connect,
    exporter_factory: Callable[[TracingSettings], SpanExporter] = otlp_exporter,
    reader_factory: Callable[[TracingSettings], SpanReader] = lambda s: PhoenixSpanReader.connect(
        s.endpoint, s.project, s.api_key
    ),
) -> int:
    """`make traces-push`: drain ``ops.v_exportable_spans`` into Phoenix and verify by read-back."""
    parser = argparse.ArgumentParser(description="export pending/held-and-revealed spans to Phoenix")
    parser.add_argument("--dsn", default=os.environ.get("ARENA_REFEREE_DSN", ""))
    parser.add_argument("--endpoint", default=os.environ.get("PHOENIX_OTLP_ENDPOINT", ""))
    parser.add_argument("--project", default=os.environ.get("PHOENIX_PROJECT", "arena"))
    parser.add_argument("--api-key", default=os.environ.get("PHOENIX_API_KEY", ""))
    args = parser.parse_args(argv)
    if not args.dsn:
        sys.stderr.write("traces-push: ARENA_REFEREE_DSN (or --dsn) is required\n")
        return 1
    if not args.endpoint:
        sys.stderr.write("traces-push: PHOENIX_OTLP_ENDPOINT (or --endpoint) is required\n")
        return 1
    settings = TracingSettings(
        service_name="arena-referee",
        mode="job",
        endpoint=args.endpoint,
        api_key=args.api_key,
        project=args.project,
    )
    conn = connect(args.dsn)
    result = drain(conn, exporter_factory(settings), reader_factory(settings))
    sys.stdout.write(f"traces-push: read {result.read}, exported {result.exported}, verified {result.verified}\n")
    return 1 if result.export_failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
