"""Span processors in chain order (S5 8.3; lift target: TechnoMile T14, adapted)."""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import cast

import pytest
from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, Span, TracerProvider
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import SpanContext, Status, StatusCode, TraceFlags

from arena_core.observability import export_policy as ep
from arena_core.observability import processors as proc
from arena_core.observability.redaction import Redaction

PROVIDER = TracerProvider(resource=Resource({"service.name": "arena-test"}))
TRACER = PROVIDER.get_tracer("arena-test")
ROOT_CTX = otel_context.Context()


def _start(name: str, parent: otel_context.Context = ROOT_CTX, attributes: Mapping[str, object] | None = None) -> Span:
    span = TRACER.start_span(name, context=parent, attributes=attributes)
    assert isinstance(span, Span)
    return span


def _ctx_of(span: Span) -> otel_context.Context:
    return trace.set_span_in_context(span)


def _no_parent() -> SpanContext:
    return SpanContext(0, 0, is_remote=False, trace_flags=TraceFlags(0))


# ------------------------------------------------------------------------------------------------- Lineage
def test_lineage_classifies_an_untouched_root_as_public_untainted_none() -> None:
    lineage = proc.Lineage()
    span = _start("root")
    lineage.started(span, _no_parent())
    verdict = lineage.classify(span.get_span_context())
    assert verdict.sensitive is False
    assert verdict.tainted is False
    assert verdict.split == "none"


def test_lineage_inherits_split_and_binding_from_parent() -> None:
    lineage = proc.Lineage()
    root = _start("root", attributes={ep.SPLIT_ATTR: "dev", ep.TRIAL_ID_ATTR: "trial-1"})
    lineage.started(root, _no_parent())
    child = _start("child", parent=_ctx_of(root))
    lineage.started(child, root.get_span_context())
    verdict = lineage.classify(child.get_span_context())
    assert verdict.split == "dev"
    assert verdict.trial_id == "trial-1"


def test_lineage_explicit_split_on_a_child_overrides_the_parent() -> None:
    """A child's own explicit, non-escalating split value is used as its classification even though it
    differs from its parent's -- without forcing the parent to adopt it (unlike ``hidden``, "dev" is not an
    escalating value the ancestor chain must also carry; see the dedicated hidden-upward-taint tests)."""
    lineage = proc.Lineage()
    root = _start("root", attributes={ep.SPLIT_ATTR: "none"})
    lineage.started(root, _no_parent())
    child = _start("child", parent=_ctx_of(root), attributes={ep.SPLIT_ATTR: "dev"})
    lineage.started(child, root.get_span_context())
    assert lineage.classify(child.get_span_context()).split == "dev"
    assert lineage.classify(root.get_span_context()).split == "none"


def test_lineage_split_is_monotonic_a_child_cannot_downgrade_a_hidden_parent() -> None:
    """Regression (Codex self-gate round 1, blocker): S4 11 and S5 8.5 -- the database never lowers a
    span's classification, and no span of a hidden trace is exportable while any span of it is held.
    A child explicitly naming "dev" beneath a hidden parent must still classify hidden, not escape it."""
    lineage = proc.Lineage()
    root = _start("root", attributes={ep.SPLIT_ATTR: "hidden"})
    lineage.started(root, _no_parent())
    child = _start("child", parent=_ctx_of(root), attributes={ep.SPLIT_ATTR: "dev"})
    lineage.started(child, root.get_span_context())
    assert lineage.classify(child.get_span_context()).split == "hidden"


def test_lineage_sensitivity_inherits_downward_to_an_unlabeled_child() -> None:
    """Regression (Codex self-gate round 1, blocker): S5 8.1 -- llm.<call_type>'s data class is literally
    "inherits". A span with no data_class of its own (as every llm_call() is) must take its parent's, not
    default to public -- otherwise a subject's LLM payload under agent_subject() would export in clear."""
    lineage = proc.Lineage()
    subject = _start("arena.agent.subject", attributes={ep.DATA_CLASS_ATTR: ep.SUBJECT_PRIVATE})
    lineage.started(subject, _no_parent())
    llm = _start("llm.subject", parent=_ctx_of(subject))  # no data_class of its own
    lineage.started(llm, subject.get_span_context())
    assert lineage.classify(llm.get_span_context()).sensitive is True


def test_lineage_taints_ancestors_when_a_sensitive_child_starts() -> None:
    lineage = proc.Lineage()
    root = _start("root")
    lineage.started(root, _no_parent())
    child = _start("child", parent=_ctx_of(root), attributes={ep.DATA_CLASS_ATTR: ep.SUBJECT_PRIVATE})
    lineage.started(child, root.get_span_context())
    root_verdict = lineage.classify(root.get_span_context())
    assert root_verdict.sensitive is False  # the root itself is still public
    assert root_verdict.tainted is True  # but it is tainted by its sensitive child
    assert lineage.classify(child.get_span_context()).sensitive is True


def test_lineage_hidden_child_escalates_its_still_open_ancestor() -> None:
    """Regression (Codex self-gate round 2, blocker): hidden must also escalate UPWARD, not only inherit
    downward (S5 8.5's whole-trace withholding is otherwise one-directional). A request's hidden-ness is
    supposed to be set at its root before any child starts, but the span helpers let any caller pass
    split="hidden" deep in the tree; if one ever does, the still-open root must not export its own content
    directly just because it did not yet know its trace turned out to be hidden."""
    lineage = proc.Lineage()
    root = _start("root")  # no split of its own: inherits "none", unaware it will turn out hidden
    lineage.started(root, _no_parent())
    child = _start("child", parent=_ctx_of(root), attributes={ep.SPLIT_ATTR: "hidden"})
    lineage.started(child, root.get_span_context())
    assert lineage.classify(root.get_span_context()).split == "hidden"


def test_lineage_hidden_upward_taint_stops_at_an_already_hidden_ancestor() -> None:
    """The upward walk is bounded the same way sensitivity's is: it stops as soon as it reaches an ancestor
    already hidden, since everything above that ancestor was escalated when IT was."""
    lineage = proc.Lineage()
    root = _start("root", attributes={ep.SPLIT_ATTR: "hidden"})
    lineage.started(root, _no_parent())
    mid = _start("mid", parent=_ctx_of(root))
    lineage.started(mid, root.get_span_context())
    child = _start("child", parent=_ctx_of(mid), attributes={ep.SPLIT_ATTR: "hidden"})
    lineage.started(child, mid.get_span_context())  # redundant: mid already inherited hidden from root
    assert lineage.classify(mid.get_span_context()).split == "hidden"
    assert lineage.classify(root.get_span_context()).split == "hidden"


def test_lineage_a_sibling_started_after_a_hidden_child_inherits_hidden_from_the_escalated_root() -> None:
    """A sibling created AFTER the hidden descendant already escalated the still-open root inherits hidden
    through ordinary downward inheritance -- no separate mechanism needed for it. (A sibling that already
    ended, and in API mode already exported, BEFORE the hidden descendant started cannot be protected this
    way or any other: nothing can recall an export already sent, which is exactly why the real design puts
    hidden-ness on the root before any span of the request begins.)"""
    lineage = proc.Lineage()
    root = _start("root")
    lineage.started(root, _no_parent())
    hidden_child = _start("hidden-child", parent=_ctx_of(root), attributes={ep.SPLIT_ATTR: "hidden"})
    lineage.started(hidden_child, root.get_span_context())
    later_sibling = _start("later-sibling", parent=_ctx_of(root))
    lineage.started(later_sibling, root.get_span_context())
    assert lineage.classify(later_sibling.get_span_context()).split == "hidden"


def test_lineage_classify_fails_closed_for_an_unrecorded_span() -> None:
    lineage = proc.Lineage()
    span = _start("never-recorded")
    verdict = lineage.classify(span.get_span_context())
    assert verdict.sensitive is True
    assert verdict.tainted is True
    assert verdict.split == "hidden"


def test_lineage_classify_fails_closed_for_a_none_context() -> None:
    assert proc.Lineage().classify(None).sensitive is True


def test_lineage_evicts_the_oldest_trace_once_over_the_bound() -> None:
    bound = 2
    lineage = proc.Lineage(max_spans=bound)
    first = _start("first")
    lineage.started(first, _no_parent())
    second = _start("second")
    lineage.started(second, _no_parent())
    assert len(lineage) == bound
    third = _start("third")
    lineage.started(third, _no_parent())
    # the first trace (its one span) was evicted to make room; it now fails closed
    assert lineage.classify(first.get_span_context()).sensitive is True
    assert lineage.classify(third.get_span_context()).sensitive is False


def test_lineage_propagator_on_start_records_in_the_registry() -> None:
    lineage = proc.Lineage()
    propagator = proc.LineagePropagator(lineage)
    span = _start("root")
    propagator.on_start(span, parent_context=ROOT_CTX)
    assert len(lineage) == 1


# ----------------------------------------------------------------------------------------------- Redactor
def _sanitizer() -> ep.Sanitizer:
    return ep.Sanitizer(Redaction(), 32_768, Resource({"service.name": "arena-test"}))


def test_redactor_sanitizes_an_ended_span_using_its_lineage_classification() -> None:
    lineage = proc.Lineage()
    redactor = proc.Redactor(_sanitizer(), lineage)
    span = _start("root", attributes={ep.DATA_CLASS_ATTR: ep.SUBJECT_PRIVATE, "output": "the real secret answer"})
    lineage.started(span, _no_parent())
    span.end()
    redactor.on_end(span)
    ended: ReadableSpan = span
    assert ended.attributes is not None
    assert "the real secret answer" not in str(ended.attributes.get("output"))


def test_redactor_fails_closed_when_sanitizing_raises() -> None:
    lineage = proc.Lineage()

    class _Boom(ep.Sanitizer):
        def span(self, span: ReadableSpan, *, sensitive: bool, tainted: bool) -> None:
            raise RuntimeError(f"boom:{span.name}:{sensitive}:{tainted}")

    redactor = proc.Redactor(_Boom(Redaction(), 32_768, Resource({})), lineage)
    span = _start("root", attributes={"payload": "still here"})
    lineage.started(span, _no_parent())
    span.end()
    redactor.on_end(span)
    ended: ReadableSpan = span
    assert ended.attributes == {}
    assert ended.name == "[redacted]"


# -------------------------------------------------------------------------------------------- SpanMirror
def test_span_mirror_buffers_a_sanitized_row_per_ended_span() -> None:
    lineage = proc.Lineage()
    sink = proc.InMemoryMirrorSink()
    mirror = proc.SpanMirror(sink, lineage)
    span = _start("root", attributes={ep.TRIAL_ID_ATTR: "trial-9", ep.SPLIT_ATTR: "dev"})
    lineage.started(span, _no_parent())
    span.end()
    mirror.on_end(span)
    written = mirror.flush()
    assert written == 1
    assert sink.rows[0].trial_id == "trial-9"
    assert sink.rows[0].split == "dev"


def test_span_mirror_flush_with_nothing_buffered_is_a_no_op() -> None:
    mirror = proc.SpanMirror(proc.InMemoryMirrorSink(), proc.Lineage())
    assert mirror.flush() == 0


def test_span_mirror_keeps_rows_when_the_sink_raises() -> None:
    lineage = proc.Lineage()

    class _FailingSink:
        def write(self, rows: Sequence[proc.SpanRow]) -> int:
            raise RuntimeError(len(rows))

    mirror = proc.SpanMirror(_FailingSink(), lineage)
    span = _start("root")
    lineage.started(span, _no_parent())
    span.end()
    mirror.on_end(span)
    with pytest.raises(RuntimeError):
        mirror.flush()
    # the row was never lost: force_flush (used at shutdown) reports failure, not silent data loss
    assert mirror.force_flush() is False


def test_span_mirror_force_flush_reports_timeout_as_failure_and_keeps_rows() -> None:
    lineage = proc.Lineage()

    class _SlowSink:
        def write(self, rows: Sequence[proc.SpanRow]) -> int:
            time.sleep(0.2)
            return len(rows)

    mirror = proc.SpanMirror(_SlowSink(), lineage, write_timeout_s=0.01)
    span = _start("root")
    lineage.started(span, _no_parent())
    span.end()
    mirror.on_end(span)
    assert mirror.force_flush(timeout_millis=10) is False


def test_span_mirror_otlp_keeps_the_sanitized_attributes_only() -> None:
    """The mirror runs AFTER the Redactor in the real chain; here it records whatever attributes the span
    carries at on_end time, proving the row's otlp payload is exactly those (already-sanitized) attributes."""
    lineage = proc.Lineage()
    redactor = proc.Redactor(_sanitizer(), lineage)
    sink = proc.InMemoryMirrorSink()
    mirror = proc.SpanMirror(sink, lineage)
    span = _start("root", attributes={ep.DATA_CLASS_ATTR: ep.SUBJECT_PRIVATE, "output": "never leaves in clear"})
    lineage.started(span, _no_parent())
    span.end()
    redactor.on_end(span)  # redact first, exactly as the real chain orders it
    mirror.on_end(span)
    mirror.flush()
    attrs = sink.rows[0].otlp["attributes"]
    assert isinstance(attrs, dict)
    assert "never leaves in clear" not in str(attrs.get("output", ""))


def test_span_mirror_otlp_carries_sanitized_events_links_and_status_description() -> None:
    """A span's events and links are already sanitized by the Redactor (it mutates them in place, S5 8.3)
    before the mirror runs; the mirror must still store them, or a trace that is only ever recoverable from
    the mirror (a killed exporter, or a hidden tournament before reveal) permanently loses its exception
    diagnostics and link context."""
    lineage = proc.Lineage()
    redactor = proc.Redactor(_sanitizer(), lineage)
    sink = proc.InMemoryMirrorSink()
    mirror = proc.SpanMirror(sink, lineage)
    span = _start("root")
    lineage.started(span, _no_parent())
    span.add_event("exception", attributes={"exception.type": "ValueError"})
    other_ctx = SpanContext(span.context.trace_id, 0xFEED, is_remote=False, trace_flags=TraceFlags(0))
    span.add_link(other_ctx, attributes={"k": "v"})
    span.set_status(Status(StatusCode.ERROR, "boom"))
    span.end()
    redactor.on_end(span)
    mirror.on_end(span)
    mirror.flush()
    otlp = sink.rows[0].otlp
    events = cast("list[dict[str, object]]", otlp["events"])
    links = cast("list[dict[str, object]]", otlp["links"])
    assert events[0]["name"] == "exception"
    assert "exception.type" in cast("dict[str, object]", events[0]["attributes"])
    link_attrs = cast("dict[str, object]", links[0]["attributes"])
    assert len(link_attrs) == 1  # sanitized (an unregistered key is hashed, S5 8.2)
    assert isinstance(otlp["status_description"], str)


def test_span_mirror_otlp_omits_empty_events_links_and_status_description() -> None:
    """An ordinary OK span with no events or links stays small: the optional keys are absent, not empty
    lists/strings, so they cost nothing of the row's 32 KB budget."""
    lineage = proc.Lineage()
    sink = proc.InMemoryMirrorSink()
    mirror = proc.SpanMirror(sink, lineage)
    span = _start("root")
    lineage.started(span, _no_parent())
    span.end()
    mirror.on_end(span)
    mirror.flush()
    otlp = sink.rows[0].otlp
    assert "events" not in otlp
    assert "links" not in otlp
    assert "status_description" not in otlp


def _attrs_of(payload: dict[str, object]) -> dict[str, object]:
    return cast("dict[str, object]", payload["attributes"])


def test_bounded_otlp_cuts_links_before_dropping_attributes() -> None:
    attrs: dict[str, ep.AttributeValue] = {"keep": "short"}
    links: list[dict[str, object]] = [{"trace_id": "a" * 32, "span_id": "b" * 16, "attributes": {"k": "v" * 40_000}}]
    payload = proc._bounded_otlp(attrs, status_description=None, events=[], links=links)
    assert "links" not in payload
    assert _attrs_of(payload) == {"keep": "short"}


def test_bounded_otlp_cuts_events_after_links_when_still_over_budget() -> None:
    attrs: dict[str, ep.AttributeValue] = {"keep": "short"}
    events: list[dict[str, object]] = [{"name": "big", "attributes": {"blob": "x" * 40_000}, "timestamp": 1}]
    payload = proc._bounded_otlp(attrs, status_description=None, events=events, links=[])
    assert "events" not in payload
    assert _attrs_of(payload) == {"keep": "short"}


def test_bounded_otlp_cuts_an_oversized_status_description_after_events_and_links() -> None:
    """Regression (Codex self-gate round 2, major): the limiter used to never touch status_description at
    all, so a long multi-byte-per-character description (CJK, emoji -- Sanitizer.text() bounds it by
    CHARACTERS, not bytes) alone could still blow the row's byte budget even with empty attrs/events/links."""
    attrs: dict[str, ep.AttributeValue] = {"keep": "short"}
    description = "中" * 20_000  # 3 bytes per char in UTF-8: ~60 KB, over budget on its own
    payload = proc._bounded_otlp(attrs, status_description=description, events=[], links=[])
    assert "status_description" not in payload
    assert proc._payload_bytes(payload) <= proc.MIRROR_OTLP_BUDGET
    assert _attrs_of(payload) == {"keep": "short"}


def test_bounded_otlp_cuts_both_links_and_events_when_dropping_either_alone_is_not_enough() -> None:
    attrs: dict[str, ep.AttributeValue] = {"keep": "short"}
    links: list[dict[str, object]] = [{"trace_id": "a" * 32, "span_id": "b" * 16, "attributes": {"k": "v" * 40_000}}]
    events: list[dict[str, object]] = [{"name": "big", "attributes": {"blob": "x" * 40_000}, "timestamp": 1}]
    payload = proc._bounded_otlp(attrs, status_description=None, events=events, links=links)
    assert "links" not in payload
    assert "events" not in payload
    assert _attrs_of(payload) == {"keep": "short"}


HUGE_ATTR_CHARS = 60_000


def test_bounded_otlp_shrinks_a_single_oversized_attribute_value() -> None:
    attrs: dict[str, ep.AttributeValue] = {"huge": "x" * HUGE_ATTR_CHARS, "small": "kept"}
    payload = proc._bounded_otlp(attrs, status_description=None, events=[], links=[])
    assert proc._payload_bytes(payload) <= proc.MIRROR_OTLP_BUDGET
    out = _attrs_of(payload)
    assert out["small"] == "kept"
    assert isinstance(out["huge"], str)
    assert len(out["huge"]) < HUGE_ATTR_CHARS  # cut down to fit, not dropped


def test_bounded_otlp_shrinks_attributes_when_dropping_links_events_and_description_is_still_not_enough() -> None:
    """Dropping links, then events, then the status description, each leaves the payload still over budget
    here (the oversized attribute alone is the problem): every deletion runs, and the final shrink-the-
    largest-value loop still has to."""
    attrs: dict[str, ep.AttributeValue] = {"huge": "x" * HUGE_ATTR_CHARS, "small": "kept"}
    links: list[dict[str, object]] = [{"trace_id": "a" * 32, "span_id": "b" * 16, "attributes": {"k": "v" * 40_000}}]
    events: list[dict[str, object]] = [{"name": "big", "attributes": {"blob": "x" * 40_000}, "timestamp": 1}]
    description = "中" * 20_000
    payload = proc._bounded_otlp(attrs, status_description=description, events=events, links=links)
    assert "links" not in payload
    assert "events" not in payload
    assert "status_description" not in payload
    assert proc._payload_bytes(payload) <= proc.MIRROR_OTLP_BUDGET
    out = _attrs_of(payload)
    assert out["small"] == "kept"
    assert isinstance(out["huge"], str)
    assert len(out["huge"]) < HUGE_ATTR_CHARS


def test_bounded_otlp_drops_attributes_outright_when_the_budget_cannot_be_met(monkeypatch: pytest.MonkeyPatch) -> None:
    """However small the budget, the cut loop always terminates: once every value is gone it returns an empty
    ``attributes`` object rather than looping forever trying to fit the impossible."""
    monkeypatch.setattr(proc, "MIRROR_OTLP_BUDGET", 1)
    attrs: dict[str, ep.AttributeValue] = {"a": "bb", "c": "dd"}
    payload = proc._bounded_otlp(attrs, status_description=None, events=[], links=[])
    assert payload == {"attributes": {}}


def test_bounded_otlp_within_budget_is_returned_unchanged() -> None:
    attrs: dict[str, ep.AttributeValue] = {"a": "b"}
    events: list[dict[str, object]] = [{"name": "e"}]
    links: list[dict[str, object]] = [{"k": "v"}]
    payload = proc._bounded_otlp(attrs, status_description="d", events=events, links=links)
    assert payload == {
        "attributes": {"a": "b"},
        "status_description": "d",
        "events": [{"name": "e"}],
        "links": [{"k": "v"}],
    }


# --------------------------------------------------------------------------------------------- ExportGate
class _Recording(SpanExporter):
    def __init__(self) -> None:
        self.exported: list[ReadableSpan] = []

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.exported.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return timeout_millis >= 0


def test_export_gate_forwards_a_visible_span() -> None:
    lineage = proc.Lineage()
    inner = _Recording()
    gate = proc.ExportGate(inner, lineage)
    span = _start("root", attributes={ep.SPLIT_ATTR: "dev"})
    lineage.started(span, _no_parent())
    span.end()
    assert gate.export([span]) is SpanExportResult.SUCCESS
    assert len(inner.exported) == 1


def test_export_gate_withholds_a_hidden_span() -> None:
    lineage = proc.Lineage()
    inner = _Recording()
    gate = proc.ExportGate(inner, lineage)
    span = _start("root", attributes={ep.SPLIT_ATTR: "hidden"})
    lineage.started(span, _no_parent())
    span.end()
    result = gate.export([span])
    assert result is SpanExportResult.SUCCESS  # the mirror already has it; this is not a failure
    assert inner.exported == []


def test_export_gate_mirror_only_withholds_everything() -> None:
    lineage = proc.Lineage()
    inner = _Recording()
    gate = proc.ExportGate(inner, lineage, mirror_only=True)
    span = _start("root", attributes={ep.SPLIT_ATTR: "none"})
    lineage.started(span, _no_parent())
    span.end()
    gate.export([span])
    assert inner.exported == []


def test_export_gate_force_flush_delegates_to_the_inner_exporter() -> None:
    gate = proc.ExportGate(_Recording(), proc.Lineage())
    assert gate.force_flush(timeout_millis=10) is True


def test_export_gate_shutdown_delegates_to_the_inner_exporter() -> None:
    inner = _Recording()
    proc.ExportGate(inner, proc.Lineage()).shutdown()


def test_span_mirror_force_flush_succeeds_and_shutdown_delegates_to_it() -> None:
    lineage = proc.Lineage()
    sink = proc.InMemoryMirrorSink()
    mirror = proc.SpanMirror(sink, lineage)
    span = _start("root")
    lineage.started(span, _no_parent())
    span.end()
    mirror.on_end(span)
    assert mirror.force_flush() is True
    assert len(sink.rows) == 1
    mirror.shutdown()  # nothing left buffered: a clean no-op force_flush


# -------------------------------------------------------------------------------------- more edge coverage
def test_classification_exposed_is_sensitive_or_tainted() -> None:
    assert proc.Classification(False, True, "none", None, None, None).exposed is True
    assert proc.Classification(False, False, "none", None, None, None).exposed is False


def test_lineage_started_with_no_context_is_a_no_op() -> None:
    lineage = proc.Lineage()
    span = _start("root")
    span._context = None
    lineage.started(span, _no_parent())
    assert len(lineage) == 0


def test_lineage_started_twice_for_the_same_span_does_not_grow_the_size() -> None:
    lineage = proc.Lineage()
    span = _start("root")
    lineage.started(span, _no_parent())
    lineage.started(span, _no_parent())  # re-recording the same span id: size does not double-count
    assert len(lineage) == 1


def test_span_mirror_record_with_no_context_is_a_no_op() -> None:
    lineage = proc.Lineage()
    mirror = proc.SpanMirror(proc.InMemoryMirrorSink(), lineage)
    span = _start("root")
    lineage.started(span, _no_parent())
    span.end()
    span._context = None
    mirror.on_end(span)
    assert mirror.flush() == 0


def test_span_mirror_on_end_fails_closed_when_recording_raises() -> None:
    lineage = proc.Lineage()
    sink = proc.InMemoryMirrorSink()

    class _Boom(proc.SpanMirror):
        def _record(self, span: ReadableSpan) -> None:
            raise RuntimeError(span.name)

    mirror = _Boom(sink, lineage)
    span = _start("root")
    lineage.started(span, _no_parent())
    span.end()
    mirror.on_end(span)  # the exception is logged, never raised
    assert mirror.flush() == 0


def test_span_mirror_otlp_keeps_a_list_attribute_as_a_list() -> None:
    lineage = proc.Lineage()
    sink = proc.InMemoryMirrorSink()
    mirror = proc.SpanMirror(sink, lineage)
    span = _start("root", attributes={"tags": ["a", "b"]})
    lineage.started(span, _no_parent())
    span.end()
    mirror.on_end(span)
    mirror.flush()
    attrs = sink.rows[0].otlp["attributes"]
    assert isinstance(attrs, dict)
    assert attrs["tags"] == ["a", "b"]


def test_span_mirror_flush_while_already_writing_raises_and_keeps_the_rows() -> None:
    lineage = proc.Lineage()
    mirror = proc.SpanMirror(proc.InMemoryMirrorSink(), lineage)
    span = _start("root")
    lineage.started(span, _no_parent())
    span.end()
    mirror.on_end(span)
    mirror._writing = True
    try:
        with pytest.raises(proc.MirrorWriteTimeoutError, match="still running"):
            mirror.flush()
    finally:
        mirror._writing = False
    assert mirror.flush() == 1  # the row was kept, not lost
