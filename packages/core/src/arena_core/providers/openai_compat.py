"""Free-tier OpenAI-compatible chat endpoints for colleague NPC small talk only (UI v2; owner D-035).

Lifted from TechnoMile `bh_core/providers/routing.py` (`EndpointSpec`, the endpoint table, env-gated endpoints, the
loopback rule for the local gateway, OpenRouter `:free` models only), `adapters/openai_compat.py` (the chat
completions body and reply parsing) and `adapters/_http.py` plus `port.py` (Retry-After, the named daily and
per-minute 429 limits, and the cooldown that skips a limited endpoint until it resets); ATTRIBUTIONS.md.

D-035 allows any open model here, Chinese ones included, for NPC chat only: these endpoints never carry case data
(an NPC prompt holds its persona and the trainee's own small talk, nothing else), never spend (free tiers), and are
never used by the coach, the subject or the referee, which stay on Gemini through the agent port. An endpoint is
enabled only when its environment variables are set; `ARENA_MODEL_MODE=fake` enables none (no network in fake mode).
"""

from __future__ import annotations

import ipaddress
import json
import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

log = logging.getLogger("arena_core.providers.openai_compat")

HTTP_TOO_MANY = 429
HTTP_BAD_REQUEST = 400
QUOTA_COOLDOWN_S = 3600.0  # a daily-limit 429 without Retry-After: skip the endpoint for an hour
MINUTE_COOLDOWN_S = 30.0  # any other 429 without Retry-After
MAX_RETRY_AFTER_S = 86_400.0
_DAILY_LIMIT = ("tokens per day", "requests per day", "(tpd)", "(rpd)")
_MAX_ERROR_TEXT = 300


@dataclass(frozen=True)
class EndpointSpec:
    """One free endpoint: where it lives, which variables enable it and the open model it answers with."""

    name: str
    model: str
    api_key_env: str
    base_url: str = ""
    base_url_env: str = ""  # a local gateway names its own URL (freellmapi)
    loopback_only: bool = False  # the configured URL must be on this machine


# The order is the routing order (groq, nvidia, openrouter, freellmapi); Gemini on Vertex is the fallback after them.
ENDPOINTS: tuple[EndpointSpec, ...] = (
    EndpointSpec("groq", "llama-3.3-70b-versatile", "GROQ_API_KEY", base_url="https://api.groq.com/openai/v1"),
    EndpointSpec(
        "nvidia", "meta/llama-3.3-70b-instruct", "NVIDIA_API_KEY", base_url="https://integrate.api.nvidia.com/v1"
    ),
    EndpointSpec(
        "openrouter",
        "meta-llama/llama-3.3-70b-instruct:free",
        "OPENROUTER_API_KEY",
        base_url="https://openrouter.ai/api/v1",
    ),
    EndpointSpec(
        "freellmapi",
        "llama-3.3-70b-versatile",
        "FREELLMAPI_API_KEY",
        base_url_env="FREELLMAPI_BASE_URL",
        loopback_only=True,
    ),
)


def free_model(spec: EndpointSpec) -> bool:
    """OpenRouter serves paid models too: only a `:free` slug may be called there (TechnoMile policy)."""
    if spec.name != "openrouter":
        return True
    return spec.model.endswith(":free") and len(spec.model) > len(":free") and not spec.model.startswith("~")


def _loopback(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:  # silent-ok: a host name other than localhost is not loopback, which is the answer
        return False


@dataclass(frozen=True)
class ChatEndpoint:
    spec: EndpointSpec
    base_url: str
    api_key: str = field(repr=False)

    @property
    def name(self) -> str:
        return self.spec.name


def configured_endpoints(env: Mapping[str, str]) -> list[ChatEndpoint]:
    """The enabled endpoints, in routing order: each one whose key (and, for the local gateway, URL) is set. A local
    gateway URL off this machine, or a non-`:free` OpenRouter model, disables that endpoint with a warning."""
    out: list[ChatEndpoint] = []
    for spec in ENDPOINTS:
        key = env.get(spec.api_key_env, "").strip()
        url = (env.get(spec.base_url_env, "").strip() if spec.base_url_env else "") or spec.base_url
        if not key or not url:
            continue
        if spec.loopback_only and not _loopback(url):
            log.warning("npc: %s is disabled: its URL must be on this machine", spec.name)
            continue
        if not free_model(spec):
            log.warning("npc: %s is disabled: only ':free' models may be called there", spec.name)
            continue
        out.append(ChatEndpoint(spec, url.rstrip("/"), key))
    return out


class FreeTierError(Exception):
    """One failed call to a free endpoint. `cooldown_s` is set when the endpoint said it is rate limited."""

    def __init__(self, endpoint: str, message: str, *, cooldown_s: float | None = None) -> None:
        super().__init__(f"{endpoint}: {message}")
        self.endpoint = endpoint
        self.cooldown_s = cooldown_s


def _retry_after(value: str | None) -> float | None:
    """Retry-After in seconds (the delta form only), at most a day."""
    try:
        seconds = float(value) if value is not None else None
    except ValueError:  # silent-ok: an HTTP-date Retry-After is not read; the default cooldown applies
        return None
    return seconds if seconds is not None and 0 <= seconds <= MAX_RETRY_AFTER_S else None


def rate_limit_cooldown(status: int, text: str, retry_after: str | None) -> float | None:
    """How long to skip an endpoint after its answer: Retry-After when given, an hour for a named daily limit, 30 s
    for any other 429; None when the answer is not a rate limit."""
    if status != HTTP_TOO_MANY:
        return None
    waited = _retry_after(retry_after)
    if waited is not None:
        return waited
    lowered = text.lower()
    return QUOTA_COOLDOWN_S if any(phrase in lowered for phrase in _DAILY_LIMIT) else MINUTE_COOLDOWN_S


def _reply_text(data: object) -> str:
    choices = data.get("choices") if isinstance(data, dict) else None
    first = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
    if first is None:
        msg = "reply has no choices"
        raise ValueError(msg)
    if first.get("finish_reason") == "content_filter":
        msg = "reply was filtered"
        raise ValueError(msg)
    message = first.get("message")
    text = message.get("content") if isinstance(message, dict) else None
    if not isinstance(text, str) or not text.strip():
        msg = "empty reply"
        raise ValueError(msg)
    return text


@dataclass(frozen=True)
class HttpReply:
    status: int
    text: str
    headers: Mapping[str, str]  # lower-case names


# (url, JSON body, headers, timeout in seconds) -> the reply; raises ConnectionError when nothing came back
PostJson = Callable[[str, dict[str, Any], dict[str, str], float], Awaitable[HttpReply]]


async def httpx_post(url: str, body: dict[str, Any], headers: dict[str, str], timeout_s: float) -> HttpReply:
    """The one real HTTP send of NPC chat (this package holds the repo's HTTP clients, S5 1.1)."""
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise ConnectionError(type(exc).__name__) from exc
    return HttpReply(resp.status_code, resp.text, {k.lower(): v for k, v in resp.headers.items()})


@dataclass(frozen=True)
class ChatClient:
    """Chat completions against one endpoint. `post` is the HTTP seam (tests answer it in memory)."""

    timeout_s: float = 15.0
    max_tokens: int = 300
    post: PostJson = httpx_post

    async def complete(self, endpoint: ChatEndpoint, system: str, user: str) -> str:
        body: dict[str, Any] = {
            "model": endpoint.spec.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": self.max_tokens,
            "temperature": 0.8,
        }
        headers = {"Authorization": f"Bearer {endpoint.api_key}"}
        try:
            reply = await self.post(f"{endpoint.base_url}/chat/completions", body, headers, self.timeout_s)
        except (ConnectionError, TimeoutError) as exc:
            raise FreeTierError(endpoint.name, f"transport error: {exc}") from exc
        if reply.status >= HTTP_BAD_REQUEST:
            text = reply.text[:_MAX_ERROR_TEXT]
            cooldown = rate_limit_cooldown(reply.status, text, reply.headers.get("retry-after"))
            raise FreeTierError(endpoint.name, f"HTTP {reply.status}", cooldown_s=cooldown)
        try:
            return _reply_text(json.loads(reply.text))
        except ValueError as exc:
            raise FreeTierError(endpoint.name, str(exc)) from exc


@dataclass
class Cooldowns:
    """Endpoints skipped until their rate limit resets (per process, like TechnoMile's `COOLED_UNTIL`)."""

    clock: Callable[[], float]
    until: dict[str, float] = field(default_factory=dict)

    def cooled(self, endpoint: str) -> bool:
        return self.clock() < self.until.get(endpoint, 0.0)

    def cool(self, endpoint: str, seconds: float) -> None:
        self.until[endpoint] = max(self.until.get(endpoint, 0.0), self.clock() + seconds)
