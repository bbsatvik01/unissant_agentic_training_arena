"""Typed wrappers for S4's observability functions (S5 4.6, 8.4; S4 12, C-30)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

from psycopg.types.json import Jsonb

from arena_core.db import calls
from arena_core.observability.processors import SpanRow

TRACE_ID = "a" * 32
SPAN_ID = "1" * 16


class _FakeCursor:
    def __init__(self, results: list[tuple[object, ...] | None]) -> None:
        self._results = results
        self.executed: list[tuple[str, Sequence[object]]] = []

    def execute(self, query: str, params: Sequence[object] = ()) -> _FakeCursor:
        self.executed.append((query, params))
        return self

    def fetchone(self) -> tuple[object, ...] | None:
        return self._results.pop(0) if self._results else None

    def fetchall(self) -> list[tuple[object, ...]]:
        rows, self._results = self._results, []
        return [r for r in rows if r is not None]


class _FakeConnection:
    def __init__(self, results: list[tuple[object, ...] | None] | None = None) -> None:
        self._cursor = _FakeCursor(results or [])
        self.committed = 0

    def cursor(self) -> _FakeCursor:
        return self._cursor

    def commit(self) -> None:
        self.committed += 1


def _row() -> SpanRow:
    return SpanRow(
        trace_id=TRACE_ID,
        span_id=SPAN_ID,
        parent_span_id=None,
        trial_id="trial-1",
        tournament_id=None,
        split="dev",
        name="arena.turn",
        kind="CHAIN",
        status="OK",
        started_at=datetime(2026, 10, 10, tzinfo=UTC),
        ended_at=datetime(2026, 10, 10, 0, 0, 1, tzinfo=UTC),
        otlp={"attributes": {"arena.turn.no": 1}},
    )


def test_mirror_spans_sends_one_batch_call_and_commits() -> None:
    conn = _FakeConnection([(1,)])
    written = calls.mirror_spans(conn, "arena-api", [_row()])
    assert written == 1
    assert conn.committed == 1
    query, params = conn.cursor().executed[0]
    assert "ops.mirror_spans" in query
    assert params[0] == "arena-api"
    assert isinstance(params[1], Jsonb)


def test_mirror_spans_with_no_rows_is_a_no_op() -> None:
    conn = _FakeConnection()
    assert calls.mirror_spans(conn, "arena-api", []) == 0
    assert conn.committed == 0


def test_exportable_spans_maps_rows_into_the_dataclass() -> None:
    started = datetime(2026, 10, 10, tzinfo=UTC)
    ended = datetime(2026, 10, 10, 0, 0, 1, tzinfo=UTC)
    row: tuple[object, ...] = (
        TRACE_ID,
        SPAN_ID,
        None,
        "arena-referee",
        "trial-1",
        "arena.turn",
        "CHAIN",
        "OK",
        started,
        ended,
        {"attributes": {}},
        "pending",
    )
    conn = _FakeConnection([row])
    found = calls.exportable_spans(conn, limit=10)
    assert len(found) == 1
    assert found[0].trace_id == TRACE_ID
    assert found[0].trial_id == "trial-1"
    assert found[0].otlp == {"attributes": {}}


def test_exportable_spans_defaults_a_non_dict_otlp_to_empty() -> None:
    started = datetime(2026, 10, 10, tzinfo=UTC)
    row = (TRACE_ID, SPAN_ID, None, "arena-referee", None, "x", "CHAIN", "OK", started, started, None, "pending")
    conn = _FakeConnection([row])
    found = calls.exportable_spans(conn)
    assert found[0].otlp == {}
    assert found[0].trial_id is None


def test_set_export_state_sends_the_keys_as_jsonb_and_commits() -> None:
    moved_count = 2
    conn = _FakeConnection([(moved_count,)])
    moved = calls.set_export_state(conn, [(TRACE_ID, SPAN_ID), (TRACE_ID, "2" * 16)], "exported")
    assert moved == moved_count
    assert conn.committed == 1


def test_set_export_state_with_no_keys_is_a_no_op() -> None:
    conn = _FakeConnection()
    assert calls.set_export_state(conn, [], "exported") == 0
    assert conn.committed == 0


def test_record_trace_summary_passes_every_field_positionally() -> None:
    conn = _FakeConnection()
    summary = calls.TraceSummary(TRACE_ID, "arena.request", "trial-1", 6, 6, 0)
    calls.record_trace_summary(conn, summary)
    _query, params = conn.cursor().executed[0]
    assert tuple(params) == (TRACE_ID, "arena.request", "trial-1", 6, 6, 0)
    assert conn.committed == 1


def test_prune_trace_mirror_returns_the_dropped_count() -> None:
    dropped_count = 4
    conn = _FakeConnection([(dropped_count,)])
    assert calls.prune_trace_mirror(conn, 7) == dropped_count
    assert conn.committed == 1


def test_postgres_mirror_sink_delegates_to_mirror_spans() -> None:
    conn = _FakeConnection([(1,)])
    sink = calls.PostgresMirrorSink(conn, "arena-subject")
    assert sink.write([_row()]) == 1
    _query, params = conn.cursor().executed[0]
    assert params[0] == "arena-subject"
