"""Span processors, in chain order (S5 8.3; lift target: TechnoMile T14, `observability/processors.py:240-284`
(``Redactor``), `:331-568` (``SpanRow``, ``PostgresMirrorSink``, ``SpanMirror``); adapted):

``LineagePropagator`` (on_start) -> ``Redactor`` -> ``SpanMirror`` -> the exporter (wrapped in ``ExportGate``).

Simplifications versus TechnoMile's T14, recorded here rather than built, because arena's span helpers
(``spans.py``) are plain nested context managers with a known data class and split at creation time, never
discovered later:

- No late ``bh.data_class=C`` mutation / ``_WatchedAttributes`` / export-time "recheck": a span's own
  sensitivity and split are both fully known the moment it starts (passed by the caller), and every span
  helper in ``spans.py`` nests its children inside its own ``with`` block, so by the time a span ends every
  sensitive descendant that will ever exist under it has already started and tainted it. TechnoMile needed the
  late-mutation path because ADK built spans generically before application code could label them; arena's
  spans are never built that way.
- No ``OpenInferenceSpanProcessor`` import from an unrelated instrumentation package (TechnoMile's chain used
  pydantic-ai's masking processor as a second, looser redaction pass): our own ``Redactor`` is already a
  stricter default-deny pass over the same attributes, so adding OpenInference's own masking processor ahead
  of it would be redundant, not additive.
- No ``RecordingExporter`` / ``EndedSpans`` / read-back-ack bookkeeping (TechnoMile's OBS-03 "every span of
  this request was confirmed delivered" proof): S5 8.9's durability acceptance only requires that a killed
  exporter still leaves every span in the mirror and that the pump can re-export and verify it later, which
  ``SpanMirror`` and ``pump.py`` provide without per-request delivery bookkeeping.
"""

import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol, override

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import Status

from arena_core.observability.export_policy import (
    BLOCK_ID_ATTR,
    DATA_CLASS_ATTR,
    SENSITIVE_CLASSES,
    SPAN_KIND_ATTR,
    SPLIT_ATTR,
    SPLITS,
    TOURNAMENT_ID_ATTR,
    TRIAL_ID_ATTR,
    AttributeValue,
    Sanitizer,
)
from arena_core.observability.redaction import REDACTED

logger = logging.getLogger(__name__)

_KINDS = frozenset(
    {"CHAIN", "AGENT", "LLM", "TOOL", "RETRIEVER", "EMBEDDING", "RERANKER", "GUARDRAIL", "EVALUATOR", "PROMPT"}
)
MAX_LINEAGE_SPANS = 65_536
_MAX_ANCESTRY = 4_096
HIDDEN = "hidden"


@dataclass(frozen=True)
class Classification:
    """How one span (re)classifies at the export boundary: ``sensitive`` is its OWN data class (subject_private
    or evaluator); ``tainted`` means a descendant already ended sensitive; ``split``, ``trial_id``,
    ``tournament_id`` and ``block_id`` are the request's binding, inherited down from the nearest ancestor that
    carried it explicitly (S5 8.5)."""

    sensitive: bool
    tainted: bool
    split: str
    trial_id: str | None
    tournament_id: str | None
    block_id: str | None

    @property
    def exposed(self) -> bool:
        return self.sensitive or self.tainted


FAIL_CLOSED = Classification(
    sensitive=True, tainted=True, split=HIDDEN, trial_id=None, tournament_id=None, block_id=None
)


@dataclass
class _Node:
    parent: int | None  # the parent's span id (always in the same trace when set)
    sensitive: bool
    split: str
    trial_id: str | None
    tournament_id: str | None
    block_id: str | None
    tainted: bool = False


def _str_attr(attrs: dict[str, AttributeValue], key: str) -> str | None:
    value = attrs.get(key)
    return value if isinstance(value, str) else None


class Lineage:
    """Process-local registry of every span's (parent, data class, split, binding), decided once at start and
    consulted again whenever a processor or the exporter needs this span's classification. Bounded: whole
    traces are forgotten least-recently-started first (their later spans then fail closed: sensitive, tainted
    and held)."""

    def __init__(self, max_spans: int = MAX_LINEAGE_SPANS) -> None:
        self._lock = threading.Lock()
        self._traces: dict[int, dict[int, _Node]] = {}
        self._size = 0
        self._max_spans = max_spans

    def __len__(self) -> int:
        with self._lock:
            return self._size

    def started(self, span: ReadableSpan, parent: trace.SpanContext) -> None:
        ctx = span.context
        if ctx is None:
            return
        attrs: dict[str, AttributeValue] = dict(span.attributes or {})
        own_split = _str_attr(attrs, SPLIT_ATTR)
        with self._lock:
            nodes = self._touch(ctx.trace_id)
            same_trace = parent.is_valid and parent.trace_id == ctx.trace_id
            parent_id = parent.span_id if same_trace else None
            parent_node = nodes.get(parent_id) if parent_id is not None else None
            node = _Node(
                parent=parent_id,
                sensitive=attrs.get(DATA_CLASS_ATTR) in SENSITIVE_CLASSES,
                split=own_split if own_split in SPLITS else (parent_node.split if parent_node is not None else "none"),
                trial_id=_str_attr(attrs, TRIAL_ID_ATTR) or (parent_node.trial_id if parent_node is not None else None),
                tournament_id=_str_attr(attrs, TOURNAMENT_ID_ATTR)
                or (parent_node.tournament_id if parent_node is not None else None),
                block_id=_str_attr(attrs, BLOCK_ID_ATTR) or (parent_node.block_id if parent_node is not None else None),
            )
            if ctx.span_id not in nodes:
                self._size += 1
            nodes[ctx.span_id] = node
            if node.sensitive:
                self._taint(nodes, parent_id)
            self._evict()

    def classify(self, ctx: trace.SpanContext | None) -> Classification:
        """Fail closed (never recorded, or forgotten under the bound): sensitive, tainted, held."""
        if ctx is None:
            return FAIL_CLOSED
        with self._lock:
            nodes = self._traces.get(ctx.trace_id)
            node = nodes.get(ctx.span_id) if nodes is not None else None
            if nodes is None or node is None:
                return FAIL_CLOSED
            return Classification(
                node.sensitive, node.tainted, node.split, node.trial_id, node.tournament_id, node.block_id
            )

    def _touch(self, trace_id: int) -> dict[int, _Node]:
        nodes = self._traces.pop(trace_id, None)
        self._traces[trace_id] = nodes if nodes is not None else {}
        return self._traces[trace_id]

    def _taint(self, nodes: dict[int, _Node], span_id: int | None) -> None:
        for _ in range(_MAX_ANCESTRY):
            node = nodes.get(span_id) if span_id is not None else None
            if node is None or node.tainted:
                return
            node.tainted = True
            span_id = node.parent

    def _evict(self) -> None:
        while self._size > self._max_spans and self._traces:
            self._size -= len(self._traces.pop(next(iter(self._traces))))


class LineagePropagator(SpanProcessor):
    """Records every starting span in ``Lineage`` (S5 8.3's first chain step)."""

    def __init__(self, lineage: Lineage) -> None:
        self._lineage = lineage

    @override
    def on_start(self, span: Span, parent_context: otel_context.Context | None = None) -> None:
        parent = trace.get_current_span(parent_context).get_span_context()
        self._lineage.started(span, parent)


class Redactor(SpanProcessor):
    """Runs every ended span through the export boundary (``export_policy.Sanitizer``). Fails CLOSED: on any
    error the span leaves with no attributes, events or links, a redacted name and a clean envelope."""

    def __init__(self, sanitizer: Sanitizer, lineage: Lineage) -> None:
        self.sanitizer = sanitizer
        self._lineage = lineage

    @override
    def on_end(self, span: ReadableSpan) -> None:
        try:
            verdict = self._lineage.classify(span.context)
            self.sanitizer.span(span, sensitive=verdict.sensitive, tainted=verdict.tainted)
        except Exception:
            logger.exception("span redaction failed; the span is exported with nothing but its ids")
            self._strip(span)

    def _strip(self, span: ReadableSpan) -> None:
        span._attributes = {}
        span._events = ()
        span._links = ()
        span._status = Status(span.status.status_code)
        span._name = REDACTED
        self.sanitizer.envelope(span)


# ---------------------------------------------------------------------------------------------- span mirror
@dataclass(frozen=True)
class SpanRow:
    """One span as ``ops.mirror_spans`` (S4 8.4) wants it: already sanitized by ``Redactor`` (this processor
    runs after it in the chain), so nothing unsanitized is ever stored. ``otlp`` holds the sanitized attributes
    only (resource and scope are fixed per S5 8.2 and reconstructed by ``pump.py`` from ``service``, not stored
    per span)."""

    trace_id: str
    span_id: str
    parent_span_id: str | None
    trial_id: str | None
    tournament_id: str | None
    split: str
    name: str
    kind: str
    status: str
    started_at: datetime
    ended_at: datetime
    otlp: dict[str, object] = field(default_factory=dict)


class MirrorSink(Protocol):
    def write(self, rows: Sequence[SpanRow]) -> int: ...


class InMemoryMirrorSink:
    """A fake mirror for tests: every row ``SpanMirror.flush()`` ever wrote, in order."""

    def __init__(self) -> None:
        self.rows: list[SpanRow] = []

    def write(self, rows: Sequence[SpanRow]) -> int:
        self.rows.extend(rows)
        return len(rows)


def _ts(ns: int | None) -> datetime:
    return datetime.fromtimestamp((ns or 0) / 1e9, tz=UTC)


def _otlp_value(value: AttributeValue) -> AttributeValue:
    if isinstance(value, list | tuple):
        return [v if isinstance(v, str | int | float | bool) else str(v) for v in value]
    return value


MIRROR_WRITE_S = 5.0  # a flush at a request or stage boundary never blocks longer than this (S5 8.4)


class MirrorWriteTimeoutError(TimeoutError):
    """A mirror write outlived its budget (or an earlier one is still running); the rows stay buffered."""


class SpanMirror(SpanProcessor):
    """Buffers one sanitized row per span that ends; ``flush()`` writes them through ``MirrorSink`` (the
    request-or-task-boundary barrier, S5 8.4). Every write is bounded: it runs on a daemon worker and the
    caller waits at most its budget, so a stalled sink can hold neither a response nor a SIGTERM flush. Rows
    of an unfinished write stay buffered and are written again later (``ops.mirror_spans`` is idempotent by
    trace and span id); only one write runs at a time."""

    def __init__(self, sink: MirrorSink, lineage: Lineage, write_timeout_s: float = MIRROR_WRITE_S) -> None:
        self._sink = sink
        self._lineage = lineage
        self._write_timeout_s = write_timeout_s
        self._lock = threading.Lock()
        self._rows: list[SpanRow] = []
        self._writing = False

    @override
    def on_end(self, span: ReadableSpan) -> None:
        try:
            self._record(span)
        except Exception:
            logger.exception("span mirror could not record a span")

    def _record(self, span: ReadableSpan) -> None:
        ctx = span.context
        if ctx is None:
            return
        verdict = self._lineage.classify(ctx)
        attrs: dict[str, AttributeValue] = dict(span.attributes or {})
        kind = attrs.get(SPAN_KIND_ATTR)
        row = SpanRow(
            trace_id=f"{ctx.trace_id:032x}",
            span_id=f"{ctx.span_id:016x}",
            parent_span_id=f"{span.parent.span_id:016x}" if span.parent else None,
            trial_id=verdict.trial_id,
            tournament_id=verdict.tournament_id,
            split=verdict.split,
            name=span.name[:200],
            kind=kind if isinstance(kind, str) and kind in _KINDS else "UNKNOWN",
            status=span.status.status_code.name,
            started_at=_ts(span.start_time),
            ended_at=_ts(span.end_time),
            otlp={"attributes": {k: _otlp_value(v) for k, v in attrs.items()}},
        )
        with self._lock:
            self._rows.append(row)

    def flush(self, timeout_s: float | None = None) -> int:
        """Write the buffered rows within ``timeout_s`` (default: the mirror's write budget). On a sink failure
        or an overrun the rows stay buffered and the error propagates (``MirrorWriteTimeoutError`` for an
        overrun)."""
        budget = self._write_timeout_s if timeout_s is None else timeout_s
        outcome: list[Exception | None] = []
        with self._lock:
            if self._writing:
                msg = "an earlier span mirror write is still running; rows kept"
                raise MirrorWriteTimeoutError(msg)
            rows, self._rows = self._rows, []
            if not rows:
                return 0
            self._writing = True

        def write() -> None:
            try:
                self._sink.write(rows)
            except Exception as exc:
                logger.exception("span mirror write failed")
                outcome.append(exc)
            else:
                outcome.append(None)
            finally:
                with self._lock:
                    self._writing = False

        worker = threading.Thread(target=write, name="span-mirror-write", daemon=True)
        worker.start()
        worker.join(max(budget, 0.0))
        if outcome and outcome[0] is None:
            return len(rows)
        with self._lock:
            self._rows = rows + self._rows
        if outcome and outcome[0] is not None:
            raise outcome[0]
        msg = f"span mirror write took longer than {budget:.3f} s; rows kept"
        raise MirrorWriteTimeoutError(msg)

    @override
    def force_flush(self, timeout_millis: int = 30000) -> bool:
        try:
            self.flush(min(timeout_millis / 1000, self._write_timeout_s))
        except Exception:
            logger.exception("span mirror flush failed; rows kept for the next flush")
            return False
        return True

    @override
    def shutdown(self) -> None:
        self.force_flush()


# ---------------------------------------------------------------------------------------------- export gate
class ExportGate(SpanExporter):
    """Wraps the real exporter (S5 8.5): a span classified ``hidden`` never reaches it directly -- its
    sanitized copy already reached the mirror (``SpanMirror`` runs earlier in the processor chain, so this is
    purely an export-time filter, never a reason to skip the mirror write). In mirror-only mode (the
    tournament job, ``ARENA_TRACE_EXPORT=mirror_only``) every span is withheld, hidden or not."""

    def __init__(self, inner: SpanExporter, lineage: Lineage, *, mirror_only: bool = False) -> None:
        self._inner = inner
        self._lineage = lineage
        self._mirror_only = mirror_only

    @override
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if self._mirror_only:
            return SpanExportResult.SUCCESS
        visible = [s for s in spans if self._lineage.classify(s.context).split != HIDDEN]
        if not visible:
            return SpanExportResult.SUCCESS
        return self._inner.export(visible)

    @override
    def shutdown(self) -> None:
        self._inner.shutdown()

    @override
    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)
