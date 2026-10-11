"""`make traces-push` pump (S5 8.4, 8.6). No network: a scripted exporter and span reader stand in for
Phoenix; a small in-memory fake stands in for the mirror's SQL surface (``arena_core.db.calls``)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import cast

import pytest
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from psycopg.types.json import Jsonb

from arena_core.db.calls import ExportableSpan
from arena_core.observability import pump
from arena_core.observability.phoenix import PhoenixReadError

TRACE_ID = "a" * 32
SPAN_A = "1" * 16
SPAN_B = "2" * 16
NOW = datetime(2026, 10, 10, tzinfo=UTC)
DRAIN_ROW_COUNT = 3


@dataclass
class _Row:
    trace_id: str
    span_id: str
    export_state: str = "pending"


@dataclass
class _FakeCursor:
    conn: _FakeMirror
    last: list[tuple[object, ...]] = field(default_factory=list)

    def execute(self, query: str, params: Sequence[object] = ()) -> _FakeCursor:
        if "ops.v_exportable_spans" in query:
            limit = cast(int, params[0])
            rows = [r for r in self.conn.rows if r.export_state == "pending"][:limit]
            self.last = [
                (
                    r.trace_id,
                    r.span_id,
                    None,
                    "arena-referee",
                    None,
                    "arena.turn",
                    "CHAIN",
                    "OK",
                    NOW,
                    NOW,
                    {"attributes": {}},
                    r.export_state,
                )
                for r in rows
            ]
        elif "ops.set_export_state" in query:
            payload, state = params[0], cast(str, params[1])
            assert isinstance(payload, Jsonb)
            moved = 0
            for key in payload.obj:
                for row in self.conn.rows:
                    if row.trace_id == key["trace_id"] and row.span_id == key["span_id"]:
                        allowed = (state == "exported" and row.export_state == "pending") or (
                            state == "verified" and row.export_state == "exported"
                        )
                        if allowed:
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
    commits: int = 0

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1


class _RecordingExporter(SpanExporter):
    def __init__(self, *, fail: bool = False) -> None:
        self.exported: list[ReadableSpan] = []
        self._fail = fail

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if self._fail:
            return SpanExportResult.FAILURE
        self.exported.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return timeout_millis >= 0


class _FakeReader:
    def __init__(self, confirmed: dict[str, set[str]] | None = None, *, raises: bool = False) -> None:
        self._confirmed = confirmed or {}
        self._raises = raises

    def span_ids(self, trace_id: str, *, timeout_s: float) -> set[str]:
        if self._raises:
            raise PhoenixReadError(f"{trace_id}:{timeout_s}")
        return self._confirmed.get(trace_id, set())


def test_rebuild_span_reconstructs_ids_and_attributes() -> None:
    row = ExportableSpan(
        trace_id=TRACE_ID,
        span_id=SPAN_A,
        parent_span_id=SPAN_B,
        service="arena-api",
        trial_id="trial-1",
        name="arena.turn",
        kind="CHAIN",
        status="OK",
        started_at=NOW,
        ended_at=NOW,
        otlp={"attributes": {"arena.turn.no": 1}},
        export_state="pending",
    )
    span = pump.rebuild_span(row)
    assert span.context is not None
    assert f"{span.context.trace_id:032x}" == TRACE_ID
    assert f"{span.context.span_id:016x}" == SPAN_A
    assert span.parent is not None
    assert f"{span.parent.span_id:016x}" == SPAN_B
    assert span.attributes == {"arena.turn.no": 1}


def test_fake_cursor_rejects_a_query_the_pump_never_issues() -> None:
    """Keeps the fake honest: if ``pump.py`` ever starts issuing a different query, this fake must fail
    loudly instead of silently returning nothing."""
    cursor = _FakeMirror(rows=[]).cursor()
    with pytest.raises(AssertionError):
        cursor.execute("select 1")


def test_pump_once_with_nothing_exportable_is_a_no_op() -> None:
    conn = _FakeMirror(rows=[])
    result = pump.pump_once(conn, _RecordingExporter(), _FakeReader())
    assert result == pump.PumpResult(read=0, exported=0, verified=0, export_failed=False)


def test_pump_once_exports_and_verifies_a_confirmed_span() -> None:
    conn = _FakeMirror(rows=[_Row(TRACE_ID, SPAN_A)])
    exporter = _RecordingExporter()
    reader = _FakeReader({TRACE_ID: {SPAN_A}})
    result = pump.pump_once(conn, exporter, reader)
    assert result.read == 1
    assert result.exported == 1
    assert result.verified == 1
    assert len(exporter.exported) == 1
    assert conn.rows[0].export_state == "verified"


def test_pump_once_leaves_rows_pending_when_export_fails() -> None:
    conn = _FakeMirror(rows=[_Row(TRACE_ID, SPAN_A)])
    result = pump.pump_once(conn, _RecordingExporter(fail=True), _FakeReader())
    assert result.export_failed is True
    assert result.exported == 0
    assert conn.rows[0].export_state == "pending"


def test_pump_once_marks_exported_but_not_verified_when_readback_fails() -> None:
    conn = _FakeMirror(rows=[_Row(TRACE_ID, SPAN_A)])
    result = pump.pump_once(conn, _RecordingExporter(), _FakeReader(raises=True))
    assert result.exported == 1
    assert result.verified == 0
    assert conn.rows[0].export_state == "exported"


def test_pump_once_does_not_verify_an_unconfirmed_span() -> None:
    conn = _FakeMirror(rows=[_Row(TRACE_ID, SPAN_A), _Row(TRACE_ID, SPAN_B)])
    reader = _FakeReader({TRACE_ID: {SPAN_A}})  # SPAN_B never confirmed
    result = pump.pump_once(conn, _RecordingExporter(), reader)
    assert result.verified == 1
    states = {row.span_id: row.export_state for row in conn.rows}
    assert states[SPAN_A] == "verified"
    assert states[SPAN_B] == "exported"


def test_drain_loops_until_the_backlog_is_empty() -> None:
    rows = [_Row(TRACE_ID, f"{i:016x}") for i in range(DRAIN_ROW_COUNT)]
    conn = _FakeMirror(rows=rows)
    exporter = _RecordingExporter()
    confirmed = {TRACE_ID: {row.span_id for row in rows}}
    result = pump.drain(conn, exporter, _FakeReader(confirmed), batch_limit=1)
    assert result.read == DRAIN_ROW_COUNT
    assert result.verified == DRAIN_ROW_COUNT
    assert all(row.export_state == "verified" for row in conn.rows)


def test_drain_stops_as_soon_as_a_pass_fails_to_export() -> None:
    rows = [_Row(TRACE_ID, f"{i:016x}") for i in range(DRAIN_ROW_COUNT)]
    conn = _FakeMirror(rows=rows)
    result = pump.drain(conn, _RecordingExporter(fail=True), _FakeReader(), batch_limit=1)
    assert result.export_failed is True
    assert result.exported == 0


def test_drain_falls_through_the_pass_bound_when_the_backlog_never_shrinks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every pass reads exactly ``batch_limit`` rows (never fewer) and never fails, so `drain` only stops via
    its `MAX_DRAIN_PASSES` fail-safe (pump.py's final `return totals`, after the loop)."""
    bounded_passes = 2
    monkeypatch.setattr(pump, "MAX_DRAIN_PASSES", bounded_passes)
    rows = [_Row(TRACE_ID, f"{i:016x}") for i in range(bounded_passes)]  # exactly MAX_DRAIN_PASSES * batch_limit(1)
    conn = _FakeMirror(rows=rows)
    confirmed = {TRACE_ID: {row.span_id for row in rows}}
    result = pump.drain(conn, _RecordingExporter(), _FakeReader(confirmed), batch_limit=1)
    assert result.read == bounded_passes
    assert result.export_failed is False


def test_main_reports_a_missing_dsn() -> None:
    assert pump.main(["--endpoint", "http://127.0.0.1:6006"]) == 1


def test_main_reports_a_missing_endpoint() -> None:
    assert pump.main(["--dsn", "postgresql://x"]) == 1


def test_main_drains_through_injected_fakes() -> None:
    conn = _FakeMirror(rows=[_Row(TRACE_ID, SPAN_A)])
    exporter = _RecordingExporter()
    reader = _FakeReader({TRACE_ID: {SPAN_A}})
    code = pump.main(
        ["--dsn", "postgresql://x", "--endpoint", "http://127.0.0.1:6006"],
        connect=lambda _dsn: conn,
        exporter_factory=lambda _settings: exporter,
        reader_factory=lambda _settings: reader,
    )
    assert code == 0
    assert conn.rows[0].export_state == "verified"


def test_main_returns_nonzero_when_export_fails() -> None:
    conn = _FakeMirror(rows=[_Row(TRACE_ID, SPAN_A)])
    code = pump.main(
        ["--dsn", "postgresql://x", "--endpoint", "http://127.0.0.1:6006"],
        connect=lambda _dsn: conn,
        exporter_factory=lambda _settings: _RecordingExporter(fail=True),
        reader_factory=lambda _settings: _FakeReader(),
    )
    assert code == 1


def test_connect_delegates_to_psycopg_connect(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr("arena_core.observability.pump.psycopg.connect", calls.append)
    pump._connect("postgresql://fake-dsn")
    assert calls == ["postgresql://fake-dsn"]
