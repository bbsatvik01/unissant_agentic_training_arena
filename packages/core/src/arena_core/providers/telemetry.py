"""One `llm.<call_type>` span per attempt (TechnoMile `providers/telemetry.py` lines 18-32, T4; ATTRIBUTIONS.md).

Adapted: the default tracer is the global OpenTelemetry API tracer (a no-op until WP-07 installs the arena's
provider), and a failed attempt is marked ERROR with the exception's type name only. The exception text is never
recorded on the span: provider errors can echo request content, and a `subject_private` or `evaluator` request must
not reach a span before WP-07's redactor exists. The span's ids are written to the attempt's `ops.model_calls` row.
"""

from collections.abc import Iterator
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode, Tracer

TRACER_NAME = "arena_core.providers"
_INVALID_TRACE_ID = 0


def default_tracer() -> Tracer:
    return trace.get_tracer(TRACER_NAME)


@contextmanager
def llm_span(tracer: Tracer, name: str, attributes: dict[str, str | int | float]) -> Iterator[Span]:
    """One span per attempt; ERROR with the exception type on any failure, which is re-raised unchanged."""
    with tracer.start_as_current_span(
        name, attributes=attributes, record_exception=False, set_status_on_exception=False
    ) as span:
        try:
            yield span
        except BaseException as exc:
            span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
            raise


def span_ids(span: Span) -> tuple[str | None, str | None]:
    """(trace_id, span_id) as the lower-hex strings ops.model_calls stores, or (None, None) without a recording span."""
    ctx = span.get_span_context()
    if ctx.trace_id == _INVALID_TRACE_ID:
        return None, None
    return f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}"
