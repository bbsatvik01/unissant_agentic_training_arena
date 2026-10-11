"""Typed wrappers for S4's observability functions (S5 4.6, 8.4; S4 12, C-30)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import cast

import pytest
from psycopg.types.json import Jsonb

from arena_core.db import calls
from arena_core.observability.processors import SpanRow

TRACE_ID = "a" * 32
SPAN_ID = "1" * 16


class _FakeCursor:
    def __init__(self, results: list[tuple[object, ...] | None], *, fail_on: str | None = None) -> None:
        self._results = results
        self.executed: list[tuple[str, Sequence[object]]] = []
        self._fail_on = fail_on

    def execute(self, query: str, params: Sequence[object] = ()) -> _FakeCursor:
        self.executed.append((query, params))
        if self._fail_on is not None and self._fail_on in query:
            msg = "simulated write failure"
            raise RuntimeError(msg)
        return self

    def fetchone(self) -> tuple[object, ...] | None:
        return self._results.pop(0) if self._results else None

    def fetchall(self) -> list[tuple[object, ...]]:
        rows, self._results = self._results, []
        return [r for r in rows if r is not None]


class _FakeConnection:
    def __init__(self, results: list[tuple[object, ...] | None] | None = None, *, fail_on: str | None = None) -> None:
        self._cursor = _FakeCursor(results or [], fail_on=fail_on)
        self.committed = 0
        self.rolled_back = 0

    def cursor(self) -> _FakeCursor:
        return self._cursor

    def commit(self) -> None:
        self.committed += 1

    def rollback(self) -> None:
        self.rolled_back += 1


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


def test_mirror_spans_chunks_a_large_buffer_to_the_500_row_cap() -> None:
    """``ops.mirror_spans`` itself refuses more than 500 spans in one call; a buffer with 501 rows must be
    sent as two calls (500 then 1), never one oversized call the function would reject outright."""
    first_chunk_written, second_chunk_written, expected_calls = 300, 1, 2
    rows = [_row() for _ in range(calls.MIRROR_BATCH_LIMIT + 1)]
    conn = _FakeConnection([(first_chunk_written,), (second_chunk_written,)])
    written = calls.mirror_spans(conn, "arena-api", rows)
    assert written == first_chunk_written + second_chunk_written
    assert len(conn.cursor().executed) == expected_calls
    first_payload = cast(Jsonb, conn.cursor().executed[0][1][1])
    second_payload = cast(Jsonb, conn.cursor().executed[1][1][1])
    assert len(first_payload.obj) == calls.MIRROR_BATCH_LIMIT
    assert len(second_payload.obj) == 1
    assert conn.committed == expected_calls


def test_run_rolls_back_and_reraises_on_a_failed_write() -> None:
    """A failed statement leaves PostgreSQL's connection in an aborted-transaction state until rolled back;
    a long-lived connection (``PostgresMirrorSink`` holds one across many flushes) that is never rolled back
    after one failure would then refuse every later statement too."""
    conn = _FakeConnection(fail_on="ops.mirror_spans")
    with pytest.raises(RuntimeError):
        calls.mirror_spans(conn, "arena-api", [_row()])
    assert conn.rolled_back == 1
    assert conn.committed == 0


def test_exported_unverified_spans_reads_trace_mirror_directly() -> None:
    """Not ``ops.v_exportable_spans`` (it never lists ``exported`` rows): a direct select against
    ``ops.trace_mirror``, which ``arena_referee``'s grant also reaches. Returns full rows (not just the
    keys): the pump re-exports a stranded row, which needs the whole span, not only its ids."""
    query_limit = 10
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
        "exported",
    )
    conn = _FakeConnection([row])
    found = calls.exported_unverified_spans(conn, limit=query_limit)
    assert len(found) == 1
    assert found[0].trace_id == TRACE_ID
    assert found[0].span_id == SPAN_ID
    assert found[0].export_state == "exported"
    query, params = conn.cursor().executed[0]
    assert "ops.trace_mirror" in query
    assert "export_state = 'exported'" in query
    assert params[0] == query_limit


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
