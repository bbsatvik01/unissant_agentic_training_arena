"""S5 8.9 acceptance criteria (observability), WP-07's local-mode slice: seven of the eight bullets are
proven here end to end; the eighth (KPI-4) is WP-13's (the turn orchestrator owns ``ops.ack_card``); the
ninth line item (a `make dev` trial trace shown in local Phoenix, screenshot) is left documented as pending
for WP-24 (the vertical-slice integration gate), per the WP-07 scope note in docs/spec/S8-build-plan.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import cast

from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from psycopg.types.json import Jsonb

from arena_core.db.calls import SqlConnection
from arena_core.observability import processors as proc
from arena_core.observability import pump, spans, tracing
from arena_core.observability.export_policy import AttributeValue
from arena_core.observability.phoenix import PhoenixReadError

from .conftest import InstallTracing

TRIAL_ID = "3f2b8c1e-5a4d-4e8f-9b2a-1c0d7e6f5a41"
TOURNAMENT_ID = "9c6a0e3a-5d1a-4a4a-8e7e-7a0d4c6b1a22"
TURN_COUNT = 12


# ============================================================================================ bullet 1
def test_redaction_strips_canary_bearer_email_and_phone_and_the_mirror_matches(install_tracing: InstallTracing) -> None:
    """ "a span whose input contains a canary from a private packet, a bearer token, an email and a phone
    number exports with all four absent and the input hashed ...; the same span's mirror row contains the
    same sanitized content."""
    installed, exporter, sink = install_tracing()
    canary = "CANARY-f04r02f08"
    leak = (
        f"packet canary {canary}; Authorization: Bearer sk-ant-{'z' * 24}; "
        "contact investigator@example.com or 415-555-0199"
    )
    with spans.agent_subject(spans.extract_context({}), trial_id=TRIAL_ID):
        trace.get_current_span().set_attribute("output", leak)
    installed.flush()

    exported = exporter.get_finished_spans()
    assert len(exported) == 1
    exported_text = str(exported[0].attributes)
    for secret in (canary, "sk-ant-", "investigator@example.com", "415-555-0199"):
        assert secret not in exported_text

    assert len(sink.rows) == 1
    mirrored_text = str(sink.rows[0].otlp["attributes"])
    for secret in (canary, "sk-ant-", "investigator@example.com", "415-555-0199"):
        assert secret not in mirrored_text
    # the same sanitized content, not independently re-redacted to something else
    assert exported[0].attributes is not None
    assert mirrored_text == str(dict(exported[0].attributes.items()))


# ============================================================================================ bullet 2
def test_role_label_never_appears_on_any_span_across_a_full_fake_trial(install_tracing: InstallTracing) -> None:
    """ "A role label string never appears in any exported span or mirror row across a full fake 12-turn
    trial (search test)." Role labels never appear on any span (direction 10): this is a structural property
    (no span helper ever accepts or stamps one), proven here by driving a 12-turn trial with the role label
    deliberately smuggled into free text, the way a leaking prompt echo might carry it."""
    installed, exporter, sink = install_tracing()
    role_labels = ("truthful", "deceptive")
    ref = spans.start_trial_anchor(TRIAL_ID)
    for turn_no in range(1, TURN_COUNT + 1):
        label = role_labels[turn_no % 2]
        with spans.turn(ref, turn_no, trial_id=TRIAL_ID):
            with spans.agent_coach():
                pass
            with spans.llm_call("card", attempt=1, purpose="coach.card"):
                pass
        with spans.agent_subject(spans.extract_context({}), trial_id=TRIAL_ID):
            trace.get_current_span().set_attribute("role_context", f"the subject's role is {label}")
    installed.flush()

    exported_text = str([(s.name, dict(s.attributes or {})) for s in exporter.get_finished_spans()])
    mirrored_text = str([(r.name, r.otlp) for r in sink.rows])
    for label in role_labels:
        assert label not in exported_text
        assert label not in mirrored_text


# ============================================================================================ bullet 1 (cont.)
def test_llm_call_nested_under_agent_subject_inherits_subject_private(install_tracing: InstallTracing) -> None:
    """Regression (Codex self-gate round 1, blocker): "Both llm_call('subject') and an automatically created
    LLM span beneath agent_subject export and mirror input.value containing private canaries and role
    labels verbatim." llm.<call_type>'s data class is "inherits" (S5 8.1); with no data_class of its own it
    must take agent_subject's, hashing the subject's private payload."""
    installed, exporter, sink = install_tracing()
    canary = "CANARY-f04r02f08"
    with spans.agent_subject(spans.extract_context({}), trial_id=TRIAL_ID), spans.llm_call("subject", attempt=1):
        trace.get_current_span().set_attribute("input.value", f"the subject's canary is {canary}")
    installed.flush()

    exported_text = str([(s.name, dict(s.attributes or {})) for s in exporter.get_finished_spans()])
    mirrored_text = str([(r.name, r.otlp) for r in sink.rows])
    assert canary not in exported_text
    assert canary not in mirrored_text
    llm_span = next(
        s for s in exporter.get_finished_spans() if dict(s.attributes or {}).get("arena.call_type") == "subject"
    )
    llm_attrs: dict[str, AttributeValue] = dict(llm_span.attributes or {})
    assert llm_attrs.get("arena.data_class") != "public"
    input_value = llm_attrs.get("input.value")
    assert isinstance(input_value, str)
    assert input_value.startswith("sha256:")  # the key stays visible; the free-text value is hashed


# ============================================================================================ bullet 5
def test_one_turn_span_per_turn_even_with_a_repair_and_a_retry(install_tracing: InstallTracing) -> None:
    """ "One arena.turn span per turn even when the card needed a repair and a transient retry (nesting
    test, P2 pattern)." One arena.turn span stays open across every attempt; the retries are separate
    llm.card spans nested inside it, never separate turn spans."""
    installed, exporter, _sink = install_tracing()
    ref = spans.start_trial_anchor(TRIAL_ID)
    with spans.turn(ref, 1, trial_id=TRIAL_ID):
        with spans.llm_call("card", attempt=1):  # transient failure, retried
            pass
        with spans.llm_call("card", attempt=2):  # schema failure, one repair re-prompt
            pass
        with spans.llm_call("card", attempt=3):  # succeeds
            pass
    installed.flush()

    attempt_count = 3
    finished = exporter.get_finished_spans()
    turn_spans = [s for s in finished if s.name == "arena.turn"]
    llm_spans = [s for s in finished if s.name == "llm.card"]
    assert len(turn_spans) == 1
    assert len(llm_spans) == attempt_count
    turn_span_id = f"{turn_spans[0].context.span_id:016x}" if turn_spans[0].context else ""
    for llm_span in llm_spans:
        assert llm_span.parent is not None
        assert f"{llm_span.parent.span_id:016x}" == turn_span_id


# ============================================================================================ bullets 3, 4
@dataclass
class _Row:
    trace_id: str
    span_id: str
    name: str
    kind: str
    service: str = "arena-referee"
    otlp: dict[str, object] = field(default_factory=dict)
    export_state: str = "pending"


@dataclass
class _FakeCursor:
    conn: _FakeMirror
    last: list[tuple[object, ...]] = field(default_factory=list)

    def execute(self, query: str, params: Sequence[object] = ()) -> _FakeCursor:
        if "ops.v_exportable_spans" in query:
            now = datetime(2026, 10, 10, tzinfo=UTC)
            rows = [r for r in self.conn.rows if r.export_state == "pending"]
            self.last = [
                (r.trace_id, r.span_id, None, r.service, None, r.name, r.kind, "OK", now, now, r.otlp, r.export_state)
                for r in rows
            ]
        elif "ops.trace_mirror where export_state" in query:
            rows = [r for r in self.conn.rows if r.export_state == "exported"]
            self.last = [(r.trace_id, r.span_id) for r in rows]
        elif "ops.set_export_state" in query:
            payload, state = params[0], cast(str, params[1])
            assert isinstance(payload, Jsonb)
            moved = 0
            for key in payload.obj:
                for row in self.conn.rows:
                    if row.trace_id == key["trace_id"] and row.span_id == key["span_id"]:
                        row.export_state = state
                        moved += 1
            self.last = [(moved,)]
        else:
            raise AssertionError(query)
        return self

    def fetchone(self) -> tuple[object, ...] | None:
        return self.last[0] if self.last else None

    def fetchall(self) -> list[tuple[object, ...]]:
        return self.last


@dataclass
class _FakeMirror:
    rows: list[_Row]

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass


def _as_fake_mirror(sink_rows: Sequence[proc.SpanRow]) -> SqlConnection:
    """Loads ``InMemoryMirrorSink`` rows (what a real request's mirror write already committed) into the
    tiny SQL-shaped fake ``pump.py``'s own ``db.calls`` functions read and write."""
    return _FakeMirror([_Row(r.trace_id, r.span_id, r.name, r.kind, otlp=r.otlp) for r in sink_rows])


class _RecordingExporter(SpanExporter):
    def __init__(self) -> None:
        self.exported: list[ReadableSpan] = []

    def export(self, spans_batch: Sequence[ReadableSpan]) -> SpanExportResult:
        self.exported.extend(spans_batch)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return timeout_millis >= 0


class _ConfirmingReader:
    def __init__(self, confirmed: dict[str, set[str]]) -> None:
        self._confirmed = confirmed

    def span_ids(self, trace_id: str, *, timeout_s: float) -> set[str]:
        if timeout_s <= 0:
            raise PhoenixReadError(trace_id)
        return self._confirmed.get(trace_id, set())


def test_killed_exporter_leaves_spans_mirrored_and_the_pump_exports_and_verifies_them() -> None:
    """ "Durability: killing the exporter mid-request still leaves every span of the request in
    ops.trace_mirror when the response completes; the pump later exports them and read-back marks them
    verified." """

    class _Killed(SpanExporter):
        def export(self, spans_batch: Sequence[ReadableSpan]) -> SpanExportResult:
            raise RuntimeError(len(spans_batch))

        def shutdown(self) -> None:
            pass

        def force_flush(self, timeout_millis: int = 30000) -> bool:
            return timeout_millis >= 0

    sink = proc.InMemoryMirrorSink()
    settings = tracing.TracingSettings(service_name="arena-api", mode="api")
    installed = tracing.install(settings, exporter=_Killed(), mirror_sink=sink, instrument_genai=False)
    assert installed is not None
    with spans.referee_task("subject"):
        pass
    installed.flush()  # the direct export failed; the response still completes
    assert len(sink.rows) == 1

    # The pump: a working exporter and a reader that confirms the span, this time.
    conn = _as_fake_mirror(sink.rows)
    exporter = _RecordingExporter()
    confirmed = {sink.rows[0].trace_id: {sink.rows[0].span_id}}
    result = pump.drain(conn, exporter, _ConfirmingReader(confirmed))
    assert result.exported == 1
    assert result.verified == 1
    assert isinstance(conn, _FakeMirror)
    assert conn.rows[0].export_state == "verified"


def test_hidden_block_scoring_trace_held_through_exporter_and_pump_until_reveal(
    install_tracing: InstallTracing,
) -> None:
    """ "Hidden gating: with a hidden-split fake tournament, the fake Phoenix receives zero spans before
    reveal() and all held spans after the post-reveal export; the full trace of a hidden block-scoring
    request (its root arena.request span without a trial, the referee spans and a database span) is held in
    the mirror through both the direct exporter and the pump until reveal."
    """
    hidden_span_count = 3  # arena.request + arena.referee.subject + arena.database
    installed, exporter, sink = install_tracing(mode="job")
    with spans.request(tournament_id=TOURNAMENT_ID, block_id="blk-1", split="hidden"):
        with spans.referee_task("subject"):
            pass
        with spans.node("arena.database", attributes={"arena.purpose": "subject.answer"}):
            pass
    installed.flush()

    # Before reveal: the fake Phoenix (the direct exporter) receives nothing.
    assert exporter.get_finished_spans() == ()
    assert len(sink.rows) == hidden_span_count
    assert all(row.split == "hidden" for row in sink.rows)

    # The pump, run before reveal: the DB-side view would not list these rows at all (still held for an
    # unrevealed tournament); modelled here by a connection with nothing exportable yet.
    empty_conn = _as_fake_mirror([])
    pre_reveal = pump.drain(empty_conn, _RecordingExporter(), _ConfirmingReader({}))
    assert pre_reveal.read == 0

    # After reveal: the rows become exportable (``ops.v_exportable_spans`` would now list them); the pump
    # exports and verifies every one of them.
    conn = _as_fake_mirror(sink.rows)
    pump_exporter = _RecordingExporter()
    confirmed = {row.trace_id: {r.span_id for r in sink.rows if r.trace_id == row.trace_id} for row in sink.rows}
    post_reveal = pump.drain(conn, pump_exporter, _ConfirmingReader(confirmed))
    assert post_reveal.exported == len(sink.rows)
    assert post_reveal.verified == len(sink.rows)
    assert len(pump_exporter.exported) == len(sink.rows)
    assert isinstance(conn, _FakeMirror)
    assert all(row.export_state == "verified" for row in conn.rows)


def test_a_child_cannot_downgrade_out_of_a_hidden_request(install_tracing: InstallTracing) -> None:
    """Regression (Codex self-gate round 1, blocker): "Hidden gating is per-span and permits downgrades. A
    child explicitly marked dev beneath a hidden request reaches the direct exporter." S4 11: the database
    never lowers a span's classification; no span of a hidden trace may reach the direct exporter."""
    installed, exporter, sink = install_tracing()
    with (
        spans.request(tournament_id=TOURNAMENT_ID, split="hidden"),
        spans.referee_task("subject", split="dev"),  # an explicit, less-restrictive split
    ):
        pass
    installed.flush()
    assert exporter.get_finished_spans() == ()
    assert all(row.split == "hidden" for row in sink.rows)
