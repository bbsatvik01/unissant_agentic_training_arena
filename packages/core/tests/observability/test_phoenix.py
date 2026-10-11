"""Phoenix span read-back (lift target: TechnoMile T15; S5 8.4, 8.6). No real network: a scripted
``HttpGetter`` stands in for ``httpx.Client``."""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence

import httpx
import pytest

from arena_core.observability.phoenix import (
    _IN_FLIGHT,
    MAX_PAGES,
    MAX_READS_IN_FLIGHT,
    PhoenixReadError,
    PhoenixSpanReader,
)

TRACE_ID = "a" * 32
SPAN_A = "1" * 16
SPAN_B = "2" * 16


class _Call:
    def __init__(self, params: Mapping[str, str | int], headers: Mapping[str, str], timeout: float) -> None:
        self.params = dict(params)
        self.headers = dict(headers)
        self.timeout = timeout


class _ScriptedGetter:
    """Replays one ``httpx.Response`` per call, in order; records every call's params, headers and timeout."""

    def __init__(self, responses: Sequence[httpx.Response]) -> None:
        self._responses = list(responses)
        self.calls: list[_Call] = []

    def get(
        self, _url: str, *, params: Mapping[str, str | int], headers: Mapping[str, str], timeout: float
    ) -> httpx.Response:
        self.calls.append(_Call(params, headers, timeout))
        return self._responses.pop(0)

    def close(self) -> None:
        pass


def _response(status: int, body: object) -> httpx.Response:
    return httpx.Response(status, json=body, request=httpx.Request("GET", "http://phoenix.local"))


def test_spans_returns_well_formed_spans_of_the_requested_trace() -> None:
    body = {
        "data": [
            {"context": {"span_id": SPAN_A, "trace_id": TRACE_ID}, "parent_id": None, "name": "arena.trial"},
            {"context": {"span_id": SPAN_B, "trace_id": TRACE_ID}, "parent_id": SPAN_A, "name": "arena.request"},
        ],
        "next_cursor": None,
    }
    reader = PhoenixSpanReader(_ScriptedGetter([_response(200, body)]), "http://127.0.0.1:6006", "arena")
    spans = reader.spans(TRACE_ID)
    assert {s.span_id for s in spans} == {SPAN_A, SPAN_B}


def test_span_ids_returns_just_the_ids() -> None:
    body = {
        "data": [{"context": {"span_id": SPAN_A, "trace_id": TRACE_ID}, "parent_id": None, "name": "arena.trial"}],
        "next_cursor": None,
    }
    reader = PhoenixSpanReader(_ScriptedGetter([_response(200, body)]), "http://127.0.0.1:6006", "arena")
    assert reader.span_ids(TRACE_ID) == {SPAN_A}


EXPECTED_PAGES = 2


def test_raw_spans_paginates_through_next_cursor() -> None:
    page1 = {
        "data": [{"context": {"span_id": SPAN_A, "trace_id": TRACE_ID}, "parent_id": None, "name": "a"}],
        "next_cursor": "page2",
    }
    page2 = {
        "data": [{"context": {"span_id": SPAN_B, "trace_id": TRACE_ID}, "parent_id": None, "name": "b"}],
        "next_cursor": None,
    }
    getter = _ScriptedGetter([_response(200, page1), _response(200, page2)])
    reader = PhoenixSpanReader(getter, "http://127.0.0.1:6006", "arena")
    found = reader.raw_spans(TRACE_ID)
    assert len(found) == EXPECTED_PAGES
    assert getter.calls[1].params["cursor"] == "page2"
    assert getter.calls[0].timeout > 0


def test_not_found_project_returns_an_empty_set() -> None:
    reader = PhoenixSpanReader(_ScriptedGetter([_response(404, {})]), "http://127.0.0.1:6006", "arena")
    assert reader.span_ids(TRACE_ID) == set()


def test_http_error_status_raises_phoenix_read_error() -> None:
    reader = PhoenixSpanReader(_ScriptedGetter([_response(500, {})]), "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError):
        reader.raw_spans(TRACE_ID)


def test_non_json_response_raises_phoenix_read_error() -> None:
    bad = httpx.Response(200, content=b"<html>not json</html>", request=httpx.Request("GET", "http://x"))
    reader = PhoenixSpanReader(_ScriptedGetter([bad]), "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError):
        reader.raw_spans(TRACE_ID)


def test_response_shaped_as_something_other_than_a_span_list_is_a_read_error() -> None:
    body = {"data": "not-a-list", "next_cursor": None}
    reader = PhoenixSpanReader(_ScriptedGetter([_response(200, body)]), "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError):
        reader.raw_spans(TRACE_ID)


def test_a_span_from_a_different_trace_fails_closed() -> None:
    body = {
        "data": [{"context": {"span_id": SPAN_A, "trace_id": "b" * 32}, "parent_id": None, "name": "x"}],
        "next_cursor": None,
    }
    reader = PhoenixSpanReader(_ScriptedGetter([_response(200, body)]), "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError):
        reader.spans(TRACE_ID)


def test_url_is_built_from_the_base_url_and_project_and_bearer_header() -> None:
    reader = PhoenixSpanReader(_ScriptedGetter([]), "http://127.0.0.1:6006/", "my project", "a-key")
    assert reader._url == "http://127.0.0.1:6006/v1/projects/my%20project/spans"
    assert reader._headers == {"authorization": "Bearer a-key"}


def test_a_non_string_cursor_is_a_read_error() -> None:
    body = {"data": [], "next_cursor": 123}
    reader = PhoenixSpanReader(_ScriptedGetter([_response(200, body)]), "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError):
        reader.raw_spans(TRACE_ID)


def test_connect_builds_a_real_client_and_close_closes_it() -> None:
    reader = PhoenixSpanReader.connect("http://127.0.0.1:6006", "arena")
    reader.close()  # no real request is made; this only tears down the idle httpx.Client


def test_a_deadline_already_passed_fails_before_any_request() -> None:
    reader = PhoenixSpanReader(_ScriptedGetter([]), "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError, match="deadline passed"):
        reader.raw_spans(TRACE_ID, timeout_s=0)


def test_more_than_max_reads_in_flight_fails_immediately() -> None:
    for _ in range(MAX_READS_IN_FLIGHT):
        _IN_FLIGHT.acquire()
    try:
        reader = PhoenixSpanReader(_ScriptedGetter([]), "http://127.0.0.1:6006", "arena")
        with pytest.raises(PhoenixReadError, match="too many reads"):
            reader.raw_spans(TRACE_ID)
    finally:
        for _ in range(MAX_READS_IN_FLIGHT):
            _IN_FLIGHT.release()


class _SlowGetter:
    """Never answers within the caller's deadline."""

    def get(
        self, _url: str, *, params: Mapping[str, str | int], headers: Mapping[str, str], timeout: float
    ) -> httpx.Response:
        assert params is not None
        assert headers is not None
        time.sleep(timeout + 1.0)
        return _response(200, {"data": [], "next_cursor": None})

    def close(self) -> None:
        pass


def test_a_read_slower_than_the_deadline_is_a_read_error() -> None:
    reader = PhoenixSpanReader(_SlowGetter(), "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError, match="deadline passed"):
        reader.raw_spans(TRACE_ID, timeout_s=0.05)


class _RaisingGetter:
    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    def get(
        self, _url: str, *, params: Mapping[str, str | int], headers: Mapping[str, str], timeout: float
    ) -> httpx.Response:
        assert params is not None
        assert headers is not None
        assert timeout >= 0
        raise self._exc

    def close(self) -> None:
        pass


def test_an_httpx_error_from_the_client_is_a_read_error() -> None:
    reader = PhoenixSpanReader(_RaisingGetter(httpx.ConnectError("refused")), "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError, match="ConnectError"):
        reader.raw_spans(TRACE_ID)


def test_an_unexpected_exception_from_the_client_is_re_raised() -> None:
    reader = PhoenixSpanReader(_RaisingGetter(RuntimeError("boom")), "http://127.0.0.1:6006", "arena")
    with pytest.raises(RuntimeError, match="boom"):
        reader.raw_spans(TRACE_ID)


def test_more_than_max_pages_is_a_read_error() -> None:
    page = {"data": [], "next_cursor": "more"}
    getter = _ScriptedGetter([_response(200, page) for _ in range(MAX_PAGES)])
    reader = PhoenixSpanReader(getter, "http://127.0.0.1:6006", "arena")
    with pytest.raises(PhoenixReadError, match="more than"):
        reader.raw_spans(TRACE_ID)
