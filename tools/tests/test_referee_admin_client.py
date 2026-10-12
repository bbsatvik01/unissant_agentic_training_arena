"""`scripts.referee_admin_client` (S5 10.3): the D10 double-submit dance against a mock transport -- no real
arena-referee process, no network."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any

import httpx
import pytest

from scripts.referee_admin_client import AdminCallError, admin_get, admin_post

BASE = "http://127.0.0.1:8082"
TOKEN = "t" * 64


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def _me_response(status: int = 200) -> httpx.Response:
    return httpx.Response(status, json={"csrf_token": TOKEN}, headers={"set-cookie": f"arena_csrf={TOKEN}"})


def test_admin_post_sends_the_csrf_cookie_and_header_from_get_me() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/me":
            return _me_response()
        return httpx.Response(200, json={"ok": True})

    result = run(
        admin_post("/api/admin/isolation-gate/run", {"a": 1}, base_url=BASE, transport=httpx.MockTransport(handler))
    )
    assert result == {"ok": True}
    get_me, post = seen
    assert (get_me.method, get_me.url.path) == ("GET", "/api/me")
    assert (post.method, post.url.path) == ("POST", "/api/admin/isolation-gate/run")
    assert post.headers["x-arena-csrf"] == TOKEN
    assert post.headers["origin"] == BASE
    assert f"arena_csrf={TOKEN}" in post.headers["cookie"]
    assert post.content == b'{"a":1}'


def test_admin_post_raises_on_a_non_200_from_get_me() -> None:
    handler = httpx.MockTransport(lambda _r: httpx.Response(httpx.codes.FORBIDDEN, text="admin role required"))
    with pytest.raises(AdminCallError) as exc_info:
        run(admin_post("/api/x", base_url=BASE, transport=handler))
    assert exc_info.value.status == httpx.codes.FORBIDDEN
    assert "admin role required" in exc_info.value.body


def test_admin_post_raises_on_a_non_200_from_the_post() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/me":
            return _me_response()
        return httpx.Response(httpx.codes.CONFLICT, json={"code": "already_revealed"})

    with pytest.raises(AdminCallError) as exc_info:
        run(admin_post("/api/admin/tournaments/t/reveal", base_url=BASE, transport=httpx.MockTransport(handler)))
    assert exc_info.value.status == httpx.codes.CONFLICT


def test_admin_get_sends_no_csrf_dance() -> None:
    """A GET is not state-changing (D10): no `/api/me` round trip, no cookie, no header."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"commit_sha": "a" * 40})

    result = run(admin_get("/api/admin/isolation-gate", base_url=BASE, transport=httpx.MockTransport(handler)))
    assert result == {"commit_sha": "a" * 40}
    [got] = seen
    assert (got.method, got.url.path) == ("GET", "/api/admin/isolation-gate")
    assert "x-arena-csrf" not in got.headers


def test_admin_get_raises_on_a_non_200() -> None:
    handler = httpx.MockTransport(lambda _r: httpx.Response(httpx.codes.FORBIDDEN, text="admin role required"))
    with pytest.raises(AdminCallError) as exc_info:
        run(admin_get("/api/admin/isolation-gate", base_url=BASE, transport=handler))
    assert exc_info.value.status == httpx.codes.FORBIDDEN


def test_admin_post_with_no_body_sends_none() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/me":
            return _me_response()
        assert request.content == b""
        return httpx.Response(200, json={})

    assert run(admin_post("/api/x", base_url=BASE, transport=httpx.MockTransport(handler))) == {}
