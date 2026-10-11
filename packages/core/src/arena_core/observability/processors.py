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

Out of WP-07's own scope (Codex self-gate round 2, major; raised again as a real gap, not edge-case
hardening, so recorded explicitly rather than silently dropped): S5 8.4's "the outcome goes to
``ops.record_trace_summary`` (spans expected, spans mirrored, export failures) with ``telemetry_incomplete``
derived" is never called from here. The DB wrapper is ready (``db.calls.record_trace_summary``,
``TraceSummary``), but "spans expected" for one request or job task is knowledge only the request/task
BOUNDARY has -- this module's helpers and ``Tracing.flush()`` are a library ``spans.py`` callers use, not
that boundary itself. ``Tracing.flush()``'s own return value cannot stand in for it either (its docstring
already says so: "best effort... never proof of delivery" -- the OTel SDK's own ``force_flush`` reports
only whether every processor finished within the deadline, never whether the exporter's calls inside that
window actually succeeded). Wiring ``record_trace_summary`` in belongs to whichever work package owns that
boundary (the api role's request middleware, the subject/referee services, the tournament job -- WP-05/12/14,
none built yet when this was written), the same way S5 8.9's KPI-4 bullet is explicitly the turn
orchestrator's (WP-13), not this module's.
"""

import json
import logging
import math
import threading
from collections.abc import Mapping, Sequence
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
        self._hidden_traces: set[int] = set()  # S5 8.5: once ANY span of a trace is hidden, the WHOLE trace
        # is -- consulted by classify() directly rather than by walking each node's ancestors, so an
        # already-registered sibling (open or not) started before the hidden span is covered too, not only
        # still-open ancestors (Codex self-gate round 3, blocker: ancestor-only escalation left a sibling
        # that started earlier under the same, now-hidden parent still classifying as its own old split).
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
        own_data_class = attrs.get(DATA_CLASS_ATTR)
        own_split = _str_attr(attrs, SPLIT_ATTR)
        with self._lock:
            nodes = self._touch(ctx.trace_id)
            same_trace = parent.is_valid and parent.trace_id == ctx.trace_id
            parent_id = parent.span_id if same_trace else None
            parent_node = nodes.get(parent_id) if parent_id is not None else None
            # A LOCAL parent exists (same trace, same process) but its own record is gone: forgotten under
            # the bound (_evict()), not a genuine root. Fail closed instead of defaulting to public/none
            # (Codex self-gate round 3, blocker): this span's real ancestry, sensitivity and hidden-ness are
            # simply unknown now. Excludes a REMOTE parent (``parent.is_remote``, S5 8.1's cross-process
            # agent_subject via W3C traceparent, ``spans.extract_context``): its record was never going to
            # be in THIS process's registry at all, by design -- a cross-process child's classification is
            # set explicitly by its own caller, never inherited through this process-local registry, so this
            # is not "forgotten," it is simply out of this Lineage's scope.
            ancestry_forgotten = same_trace and parent_node is None and not parent.is_remote
            # Sensitivity INHERITS downward (S5 8.1: llm.<call_type>'s data class is literally "inherits"):
            # a span with no data_class of its own takes its parent's, not a bare False default -- otherwise
            # an llm_call() nested under a subject_private agent_subject() would export public by default.
            if ancestry_forgotten:
                sensitive = True
            elif DATA_CLASS_ATTR in attrs:
                sensitive = own_data_class in SENSITIVE_CLASSES
            else:
                sensitive = parent_node.sensitive if parent_node is not None else False
            # split is monotonic (S4 11: "the database never lowers it"; S5 8.5): hidden wins over any own
            # or inherited value, never downgraded by a child naming a different split explicitly.
            parent_split = HIDDEN if ancestry_forgotten else (parent_node.split if parent_node is not None else "none")
            if HIDDEN in (own_split, parent_split):
                split = HIDDEN
            elif own_split in SPLITS:
                split = own_split
            else:
                split = parent_split
            node = _Node(
                parent=parent_id,
                sensitive=sensitive,
                split=split,
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
            if split == HIDDEN:
                self._hidden_traces.add(ctx.trace_id)
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
            split = HIDDEN if ctx.trace_id in self._hidden_traces else node.split
            return Classification(node.sensitive, node.tainted, split, node.trial_id, node.tournament_id, node.block_id)

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
            trace_id = next(iter(self._traces))
            self._size -= len(self._traces.pop(trace_id))
            self._hidden_traces.discard(trace_id)


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


def _otlp_scalar(value: object) -> str | bool | int | float:
    """One value, made safe for the mirror's JSONB column (regression, Codex self-gate round 3, major):
    NaN/Infinity have no JSON token -- ``json.dumps`` writes the literal ``NaN``/``Infinity``, which
    PostgreSQL's own jsonb parser rejects outright ("Token \"NaN\" is invalid"), failing the whole insert
    batch -- so they are kept visible as their string form instead; an embedded NUL byte is stripped from a
    string (PostgreSQL rejects ANY text-based value containing one: "invalid byte sequence for encoding
    \"UTF8\": 0x00", same whole-batch failure). Both verified against a real PostgreSQL 17."""
    if isinstance(value, bool):
        return value
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, str | int | float):
        return value
    return str(value)


def _otlp_value(value: AttributeValue) -> AttributeValue:
    if isinstance(value, list | tuple):
        return [_otlp_scalar(v) for v in value]
    return _otlp_scalar(value)


# S4's ops.trace_mirror.otlp column: "jsonb_typeof(otlp) = 'object' and pg_column_size(otlp) <= 32768"
# (migration 20261008000600_ops_budget_traces.sql). The Redactor already bounds one attribute value's own
# length, but a span with many attributes, or several sanitized events, can still sum past the row's cap;
# this budget is the backstop, with headroom under 32768 for jsonb's own on-disk framing.
MIRROR_OTLP_BUDGET = 30_000


def _payload_bytes(payload: Mapping[str, object]) -> int:
    return len(json.dumps(payload, default=str, ensure_ascii=False).encode())


def _value_bytes(value: object) -> int:
    return len(json.dumps(value, default=str, ensure_ascii=False).encode())


def _mirror_events(span: ReadableSpan) -> list[dict[str, object]]:
    return [
        {
            "name": ev.name,
            "attributes": {k: _otlp_value(v) for k, v in (ev.attributes or {}).items()},
            "timestamp": ev.timestamp,
        }
        for ev in span.events
    ]


def _mirror_links(span: ReadableSpan) -> list[dict[str, object]]:
    links: list[dict[str, object]] = []
    for link in span.links:
        ctx = link.context  # never None: Link's own constructor requires a SpanContext
        links.append(
            {
                "trace_id": f"{ctx.trace_id:032x}",
                "span_id": f"{ctx.span_id:016x}",
                "attributes": {k: _otlp_value(v) for k, v in (link.attributes or {}).items()},
            }
        )
    return links


def _bounded_otlp(
    attrs: dict[str, AttributeValue],
    *,
    status_description: str | None,
    events: list[dict[str, object]],
    links: list[dict[str, object]],
) -> dict[str, object]:
    """Builds the mirror row's ``otlp`` payload, cut down to ``MIRROR_OTLP_BUDGET`` bytes if it does not
    already fit. Cut order, least valuable first: links, then events, then the status description (a human-
    readable error message -- diagnostic, like events/links, not an identifier), then the largest attribute
    values (halved repeatedly, then dropped outright) -- attributes carry the identifiers and metrics S5 8.2
    needs the mirror for at all, so they are the last thing cut. A span this large is already a rare,
    pathological case (ordinary attribute values are far smaller, and ``Sanitizer.text()`` bounds a
    description by CHARACTERS, which a multi-byte-per-character string -- CJK, emoji -- can still turn into
    many more BYTES than that character bound); losing its events, links or description here is the fail-
    closed trade against the alternative, a whole mirror batch rejected by the DB's hard byte check."""
    otlp_attrs: dict[str, object] = {k: _otlp_value(v) for k, v in attrs.items()}
    payload: dict[str, object] = {"attributes": otlp_attrs}
    if status_description:
        payload["status_description"] = status_description
    if events:
        payload["events"] = events
    if links:
        payload["links"] = links
    for key in ("links", "events", "status_description"):
        if _payload_bytes(payload) <= MIRROR_OTLP_BUDGET:
            return payload
        payload.pop(key, None)
    while otlp_attrs and _payload_bytes(payload) > MIRROR_OTLP_BUDGET:
        key = max(otlp_attrs, key=lambda k: _value_bytes(otlp_attrs[k]))
        value = otlp_attrs[key]
        if isinstance(value, str) and len(value) > 1:
            otlp_attrs[key] = value[: len(value) // 2]
        else:
            del otlp_attrs[key]
    return payload


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
            otlp=_bounded_otlp(
                attrs,
                status_description=span.status.description,
                events=_mirror_events(span),
                links=_mirror_links(span),
            ),
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
