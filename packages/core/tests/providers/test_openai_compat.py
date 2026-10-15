"""The free-tier OpenAI-compatible client for NPC chat (UI v2, D-035): which endpoints the environment enables, the
request it sends, how it reads a reply, and the cooldown a rate limit earns. Every HTTP exchange is mocked
(httpx.MockTransport): no test reaches a network."""

from __future__ import annotations

import asyncio
import json

import httpx
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
    configured_endpoints,
    free_model,
    rate_limit_cooldown,
)

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


def _client(handler: httpx.MockTransport) -> ChatClient:
    return ChatClient(transport=handler)


def test_a_reply_is_the_first_choice_text_and_the_request_carries_model_messages_and_key() -> None:
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "Hi there."}, "finish_reason": "stop"}]})

    text = asyncio.run(_client(httpx.MockTransport(answer)).complete(GROQ, "sys", "user"))
    assert text == "Hi there."
    assert str(seen[0].url) == "https://api.groq.com/openai/v1/chat/completions"
    assert seen[0].headers["authorization"] == "Bearer k"
    body = json.loads(seen[0].content)
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
    ],
)
def test_an_unusable_reply_is_a_free_tier_error(payload: object) -> None:
    transport = httpx.MockTransport(lambda _r: httpx.Response(200, json=payload))
    with pytest.raises(FreeTierError) as caught:
        asyncio.run(_client(transport).complete(GROQ, "s", "u"))
    assert caught.value.cooldown_s is None


def test_a_non_json_reply_is_a_free_tier_error() -> None:
    transport = httpx.MockTransport(lambda _r: httpx.Response(200, text="<html>"))
    with pytest.raises(FreeTierError):
        asyncio.run(_client(transport).complete(GROQ, "s", "u"))


def test_a_429_carries_its_cooldown_and_a_500_none() -> None:
    limited = httpx.MockTransport(lambda _r: httpx.Response(429, text="tokens per day (TPD)"))
    with pytest.raises(FreeTierError) as caught:
        asyncio.run(_client(limited).complete(GROQ, "s", "u"))
    assert caught.value.cooldown_s == QUOTA_COOLDOWN_S
    assert caught.value.endpoint == "groq"
    broken = httpx.MockTransport(lambda _r: httpx.Response(503, text="down"))
    with pytest.raises(FreeTierError) as caught:
        asyncio.run(_client(broken).complete(GROQ, "s", "u"))
    assert caught.value.cooldown_s is None


def test_a_transport_failure_is_a_free_tier_error() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(FreeTierError, match="transport error"):
        asyncio.run(_client(httpx.MockTransport(refuse)).complete(GROQ, "s", "u"))


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
