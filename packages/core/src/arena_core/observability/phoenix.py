"""Read-back of exported spans from the operator's Phoenix (lift target: TechnoMile T15,
`observability/phoenix.py:1-174`; the pinned image is `arizephoenix/phoenix:version-20.16.0`, S5 8.6).

REST ``GET /v1/projects/{project}/spans``, checked against the OpenAPI document of the pinned image: filter
``trace_id`` (repeatable), ``limit`` <= 1000, pagination by ``next_cursor``; each span has
``context.span_id`` and ``parent_id`` as hex. The URL comes from operator configuration (``PHOENIX_BASE_URL``
/ the ``PHOENIX_OTLP_ENDPOINT`` base), never from run data.
"""

import logging
import re
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

PAGE_LIMIT = 1000
_HEX16 = re.compile(r"[0-9a-f]{16}")
DEFAULT_TIMEOUT_S = 5.0
MAX_READS_IN_FLIGHT = 4
_IN_FLIGHT = threading.BoundedSemaphore(MAX_READS_IN_FLIGHT)
MAX_PAGES = 50


@dataclass(frozen=True)
class StoredSpan:
    span_id: str
    parent_id: str | None
    name: str


class PhoenixReadError(RuntimeError):
    """Phoenix could not be read; the caller treats the span set as unconfirmed."""


def _page(response: httpx.Response) -> tuple[list[dict[str, Any]], str | None]:
    """One page of the documented span list (``data``: a list of objects, ``next_cursor``: a string or null).
    Anything else (an HTML page served with 200, another schema) is a read failure, never an exception."""
    try:
        body = response.json()
    except ValueError as exc:
        msg = "phoenix read failed: the response is not JSON"
        raise PhoenixReadError(msg) from exc
    data = body.get("data") if isinstance(body, dict) else None
    cursor = body.get("next_cursor") if isinstance(body, dict) else None
    if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
        msg = "phoenix read failed: the response is not a span list"
        raise PhoenixReadError(msg)
    if cursor is not None and not isinstance(cursor, str):
        msg = "phoenix read failed: the response cursor is not a string"
        raise PhoenixReadError(msg)
    return data, cursor


class HttpGetter(Protocol):
    """The slice of ``httpx.Client`` the reader uses (tests pass a scripted stand-in)."""

    def get(
        self, url: str, *, params: Mapping[str, str | int], headers: Mapping[str, str], timeout: float
    ) -> httpx.Response: ...

    def close(self) -> None: ...


class PhoenixSpanReader:
    def __init__(self, client: HttpGetter, base_url: str, project: str, api_key: str = "") -> None:
        self._client = client
        self._url = f"{base_url.rstrip('/')}/v1/projects/{quote(project, safe='')}/spans"
        self._headers = {"authorization": f"Bearer {api_key}"} if api_key else {}

    @classmethod
    def connect(
        cls, base_url: str, project: str, api_key: str = "", timeout_s: float = DEFAULT_TIMEOUT_S
    ) -> "PhoenixSpanReader":
        """A reader with its own client (no proxies from the environment); ``close()`` it when done."""
        return cls(httpx.Client(timeout=timeout_s, trust_env=False), base_url, project, api_key)

    def close(self) -> None:
        self._client.close()

    def raw_spans(self, trace_id: str, *, timeout_s: float = DEFAULT_TIMEOUT_S) -> list[dict[str, Any]]:
        """Every stored span of one trace, as Phoenix returns it (context, parent_id, attributes, events).

        ``timeout_s`` bounds the whole read, every page included."""
        found: list[dict[str, Any]] = []
        cursor: str | None = None
        deadline = time.monotonic() + timeout_s
        for _ in range(MAX_PAGES):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                msg = "phoenix read failed: deadline passed"
                raise PhoenixReadError(msg)
            params: dict[str, str | int] = {"trace_id": trace_id, "limit": PAGE_LIMIT}
            if cursor:
                params["cursor"] = cursor
            response = self._get(params, remaining)
            if response.status_code == httpx.codes.NOT_FOUND:
                return found  # the project does not exist yet: nothing was stored
            if response.status_code != httpx.codes.OK:
                msg = f"phoenix read failed: HTTP {response.status_code}"
                raise PhoenixReadError(msg)
            items, cursor = _page(response)
            found.extend(items)
            if not cursor:
                return found
        msg = f"phoenix read failed: more than {MAX_PAGES * PAGE_LIMIT} spans in one trace"
        raise PhoenixReadError(msg)

    def _get(self, params: Mapping[str, str | int], timeout_s: float) -> httpx.Response:
        """One request, waited on for at most ``timeout_s``. httpx bounds each phase (connect, each body read),
        never the whole call, so it runs on a DAEMON worker (an abandoned read never holds up interpreter
        exit, unlike a pool's joined workers); at most ``MAX_READS_IN_FLIGHT`` run at once, beyond that the
        read fails at once."""
        if not _IN_FLIGHT.acquire(blocking=False):
            msg = "phoenix read failed: too many reads still running"
            raise PhoenixReadError(msg)
        outcome: list[httpx.Response | Exception] = []

        def run() -> None:
            try:
                outcome.append(self._client.get(self._url, params=params, headers=self._headers, timeout=timeout_s))
            except httpx.HTTPError as exc:  # a read failure: handed to the waiting caller below
                outcome.append(exc)
            except Exception as exc:
                logger.exception("phoenix read raised")
                outcome.append(exc)  # re-raised by the waiting caller
            finally:
                _IN_FLIGHT.release()

        worker = threading.Thread(target=run, name="phoenix-read", daemon=True)
        try:
            worker.start()
        except BaseException:
            _IN_FLIGHT.release()
            raise
        worker.join(timeout_s)
        if not outcome:
            msg = "phoenix read failed: deadline passed"
            raise PhoenixReadError(msg)
        result = outcome[0]
        if isinstance(result, httpx.HTTPError):
            msg = f"phoenix read failed: {type(result).__name__}"
            raise PhoenixReadError(msg) from result
        if isinstance(result, Exception):
            raise result
        return result

    def spans(self, trace_id: str, *, timeout_s: float = DEFAULT_TIMEOUT_S) -> list[StoredSpan]:
        """Stored spans of one trace. Every span must be a documented span of THIS trace (``context.trace_id``
        equal to ``trace_id``, hex ids, a string name); anything else is a read failure, never coerced."""
        out = []
        for item in self.raw_spans(trace_id, timeout_s=timeout_s):
            context = item.get("context")
            span_id = context.get("span_id") if isinstance(context, dict) else None
            span_trace = context.get("trace_id") if isinstance(context, dict) else None
            parent_id, name = item.get("parent_id"), item.get("name")
            if not (
                isinstance(span_id, str)
                and _HEX16.fullmatch(span_id)
                and span_trace == trace_id
                and (parent_id is None or (isinstance(parent_id, str) and _HEX16.fullmatch(parent_id)))
                and isinstance(name, str)
            ):
                msg = "phoenix read failed: a span that is not a well-formed span of this trace"
                raise PhoenixReadError(msg)
            out.append(StoredSpan(span_id, parent_id, name))
        return out

    def span_ids(self, trace_id: str, *, timeout_s: float = DEFAULT_TIMEOUT_S) -> set[str]:
        return {s.span_id for s in self.spans(trace_id, timeout_s=timeout_s)}


# ------------------------------------------------------------------ JSON writes (Coach Gym datasets, D-036)


class JsonResponse(Protocol):
    """The slice of ``httpx.Response`` the JSON client reads."""

    @property
    def status_code(self) -> int: ...

    def json(self) -> object: ...


class HttpRequester(Protocol):
    """The slice of ``httpx.Client`` the JSON client uses (tests pass a scripted stand-in)."""

    def request(
        self,
        method: str,
        url: str,
        *,
        json: object = None,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> JsonResponse: ...

    def close(self) -> None: ...


class PhoenixJsonClient:
    """The operator's Phoenix REST API for JSON calls (dataset upload, experiments): the same Phoenix, URL and key
    as the span reader above, and the only HTTP the Coach Gym makes (`scripts/coach_gym/phoenix.py` builds on it
    and imports no HTTP client of its own). Answers are `(status, parsed JSON or None when the body is not JSON)`."""

    def __init__(self, client: HttpRequester, base_url: str, api_key: str = "") -> None:
        self._client = client
        self._base = base_url.rstrip("/")
        self._headers = {"authorization": f"Bearer {api_key}"} if api_key else {}

    @classmethod
    def connect(cls, base_url: str, api_key: str = "", timeout_s: float = 30.0) -> "PhoenixJsonClient":
        """A client with its own httpx client (no proxies from the environment); ``close()`` it when done."""
        return cls(httpx.Client(timeout=timeout_s, trust_env=False), base_url, api_key)

    @property
    def base_url(self) -> str:
        return self._base

    @property
    def authorized(self) -> bool:
        return bool(self._headers)

    def close(self) -> None:
        self._client.close()

    def call(
        self, method: str, path: str, body: object = None, params: Mapping[str, str] | None = None
    ) -> tuple[int, object]:
        if not path.startswith("/v1/"):
            msg = f"phoenix: {path} is not a /v1/ REST path"
            raise PhoenixReadError(msg)
        response = self._client.request(method, f"{self._base}{path}", json=body, params=params, headers=self._headers)
        try:
            parsed: object = response.json()
        except ValueError as exc:  # an HTML error page or an empty body: the caller refuses a None answer
            logger.info("phoenix %s %s: the answer is not JSON (%s)", method, path, type(exc).__name__)
            parsed = None
        return response.status_code, parsed
