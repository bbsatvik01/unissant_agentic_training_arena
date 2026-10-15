"""The free-tier OpenAI-compatible client for NPC chat (UI v2, D-035): which endpoints the environment enables, the
request it sends, how it reads a reply, and the cooldown a rate limit earns. The client's HTTP seam is answered in
memory; the one real send is checked against a loopback server this test starts. No test leaves this machine."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

import pytest

from arena_core.providers.openai_compat import (
    ENDPOINTS,
    MINUTE_COOLDOWN_S,
    QUOTA_COOLDOWN_S,
    ChatClient,
    ChatEndpoint,
    Cooldowns,
    EndpointSpec,
    FreeTierError,
    HttpReply,
    configured_endpoints,
    free_model,
    httpx_post,
    rate_limit_cooldown,
)

RETRY_AFTER_S = 7.0

ALL_KEYS = {
    "GROQ_API_KEY": "g",
    "NVIDIA_API_KEY": "n",
    "OPENROUTER_API_KEY": "o",
    "FREELLMAPI_BASE_URL": "http://127.0.0.1:3001/v1/",
    "FREELLMAPI_API_KEY": "f",
}


def test_each_endpoint_is_enabled_only_by_its_own_variables_in_routing_order() -> None:
    assert configured_endpoints({}) == []
    names = [e.name for e in configured_endpoints(ALL_KEYS)]
    assert names == ["groq", "nvidia", "openrouter", "freellmapi"]
    assert [e.name for e in configured_endpoints({"NVIDIA_API_KEY": "n"})] == ["nvidia"]
    # the local gateway needs its URL and its key
    assert configured_endpoints({"FREELLMAPI_BASE_URL": "http://localhost:3001/v1"}) == []
    gateway = configured_endpoints({"FREELLMAPI_BASE_URL": "http://localhost:3001/v1", "FREELLMAPI_API_KEY": "f"})
    assert [(e.name, e.base_url) for e in gateway] == [("freellmapi", "http://localhost:3001/v1")]


def test_a_gateway_off_this_machine_is_disabled() -> None:
    for url in ("https://freellmapi.example.com/v1", "http://10.0.0.5:3001/v1", "http://127.0.0.1.example.com/v1"):
        assert configured_endpoints({"FREELLMAPI_BASE_URL": url, "FREELLMAPI_API_KEY": "f"}) == []
    assert configured_endpoints({"FREELLMAPI_BASE_URL": "http://[::1]:3001/v1", "FREELLMAPI_API_KEY": "f"})


def test_openrouter_takes_free_models_only() -> None:
    assert all(free_model(spec) for spec in ENDPOINTS)
    paid = EndpointSpec("openrouter", "meta-llama/llama-3.3-70b-instruct", "OPENROUTER_API_KEY", base_url="https://x")
    assert not free_model(paid)
    assert not free_model(EndpointSpec("openrouter", ":free", "OPENROUTER_API_KEY"))
    assert not free_model(EndpointSpec("openrouter", "~router:free", "OPENROUTER_API_KEY"))
    assert free_model(EndpointSpec("groq", "anything", "GROQ_API_KEY"))


def test_the_api_key_never_appears_in_the_endpoint_repr() -> None:
    endpoint = configured_endpoints({"GROQ_API_KEY": "secret-value"})[0]
    assert "secret-value" not in repr(endpoint)


@pytest.mark.parametrize(
    ("status", "text", "retry_after", "expected"),
    [
        (200, "", None, None),
        (500, "boom", None, None),
        (429, "slow down", "12", 12.0),
        (429, "Rate limit reached on tokens per day (TPD)", None, QUOTA_COOLDOWN_S),
        (429, "requests per minute (RPM)", None, MINUTE_COOLDOWN_S),
        (429, "x", "Wed, 21 Oct 2015 07:28:00 GMT", MINUTE_COOLDOWN_S),
        (429, "x", "-5", MINUTE_COOLDOWN_S),
        (429, "x", "999999", MINUTE_COOLDOWN_S),
    ],
)
def test_rate_limit_cooldown(status: int, text: str, retry_after: str | None, expected: float | None) -> None:
    assert rate_limit_cooldown(status, text, retry_after) == expected


GROQ = ChatEndpoint(ENDPOINTS[0], "https://api.groq.com/openai/v1", "k")


@dataclass
class Post:
    """An in-memory HTTP answer for the client's `post` seam; records each request."""

    reply: HttpReply | Exception
    seen: list[tuple[str, dict[str, Any], dict[str, str], float]] = field(default_factory=list)

    async def __call__(self, url: str, body: dict[str, Any], headers: dict[str, str], timeout_s: float) -> HttpReply:
        self.seen.append((url, body, headers, timeout_s))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def _json(status: int, payload: object, headers: dict[str, str] | None = None) -> HttpReply:
    return HttpReply(status, json.dumps(payload), headers or {})


def test_a_reply_is_the_first_choice_text_and_the_request_carries_model_messages_and_key() -> None:
    post = Post(_json(200, {"choices": [{"message": {"content": "Hi there."}, "finish_reason": "stop"}]}))
    text = asyncio.run(ChatClient(post=post).complete(GROQ, "sys", "user"))
    assert text == "Hi there."
    ((url, body, headers, timeout),) = post.seen
    assert url == "https://api.groq.com/openai/v1/chat/completions"
    assert headers == {"Authorization": "Bearer k"}
    assert timeout == ChatClient().timeout_s
    assert body["model"] == GROQ.spec.model
    assert body["messages"] == [{"role": "system", "content": "sys"}, {"role": "user", "content": "user"}]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": []},
        {"choices": ["x"]},
        {"choices": [{"message": {"content": "  "}}]},
        {"choices": [{"message": "no"}]},
        {"choices": [{"message": {"content": "x"}, "finish_reason": "content_filter"}]},
        [1, 2],
    ],
)
def test_an_unusable_reply_is_a_free_tier_error(payload: object) -> None:
    with pytest.raises(FreeTierError) as caught:
        asyncio.run(ChatClient(post=Post(_json(200, payload))).complete(GROQ, "s", "u"))
    assert caught.value.cooldown_s is None


def test_a_non_json_reply_is_a_free_tier_error() -> None:
    with pytest.raises(FreeTierError):
        asyncio.run(ChatClient(post=Post(HttpReply(200, "<html>", {}))).complete(GROQ, "s", "u"))


def test_a_429_carries_its_cooldown_and_a_500_none() -> None:
    limited = Post(HttpReply(429, "tokens per day (TPD)", {}))
    with pytest.raises(FreeTierError) as caught:
        asyncio.run(ChatClient(post=limited).complete(GROQ, "s", "u"))
    assert caught.value.cooldown_s == QUOTA_COOLDOWN_S
    assert caught.value.endpoint == "groq"
    waited = Post(HttpReply(429, "slow", {"retry-after": "7"}))
    with pytest.raises(FreeTierError) as caught:
        asyncio.run(ChatClient(post=waited).complete(GROQ, "s", "u"))
    assert caught.value.cooldown_s == RETRY_AFTER_S
    with pytest.raises(FreeTierError) as caught:
        asyncio.run(ChatClient(post=Post(HttpReply(503, "down", {}))).complete(GROQ, "s", "u"))
    assert caught.value.cooldown_s is None


@pytest.mark.parametrize("failure", [ConnectionError("ConnectError"), TimeoutError()])
def test_a_transport_failure_is_a_free_tier_error(failure: Exception) -> None:
    with pytest.raises(FreeTierError, match="transport error"):
        asyncio.run(ChatClient(post=Post(failure)).complete(GROQ, "s", "u"))


async def _one_http_answer(status_line: str, body: bytes, headers: str = "") -> tuple[asyncio.Server, int, list[bytes]]:
    """A loopback server that answers one request with a fixed response and keeps what it received."""
    got: list[bytes] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = await reader.readuntil(b"\r\n\r\n")
        length = next(
            (int(line.split(b":")[1]) for line in head.split(b"\r\n") if line.lower().startswith(b"content-length")), 0
        )
        got.append(head + await reader.readexactly(length))
        writer.write(
            f"HTTP/1.1 {status_line}\r\nContent-Length: {len(body)}\r\n{headers}Connection: close\r\n\r\n".encode()
            + body
        )
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, port, got


def test_the_real_post_sends_json_and_returns_status_text_and_lower_case_headers() -> None:
    async def go() -> tuple[HttpReply, list[bytes]]:
        server, port, got = await _one_http_answer("429 Too Many Requests", b'{"error": "x"}', "Retry-After: 3\r\n")
        async with server:
            reply = await httpx_post(f"http://127.0.0.1:{port}/v1/chat/completions", {"a": 1}, {"X-T": "y"}, 5.0)
        return reply, got

    reply, got = asyncio.run(go())
    assert (reply.status, reply.text, reply.headers["retry-after"]) == (429, '{"error": "x"}', "3")
    assert got[0].startswith(b"POST /v1/chat/completions ")
    assert got[0].endswith(b'{"a":1}')
    assert b"x-t: y" in got[0].lower()


def test_the_real_post_turns_a_refused_connection_into_connection_error() -> None:
    async def go() -> None:
        server = await asyncio.start_server(lambda _r, _w: None, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        server.close()
        await server.wait_closed()
        await httpx_post(f"http://127.0.0.1:{port}/x", {}, {}, 2.0)

    with pytest.raises(ConnectionError):
        asyncio.run(go())


def test_cooldowns_hold_until_their_time_and_never_shorten() -> None:
    now = [100.0]
    cool = Cooldowns(lambda: now[0])
    assert not cool.cooled("groq")
    cool.cool("groq", 60)
    cool.cool("groq", 5)  # a shorter later limit does not cut the longer one
    now[0] = 159.0
    assert cool.cooled("groq")
    now[0] = 160.0
    assert not cool.cooled("groq")
