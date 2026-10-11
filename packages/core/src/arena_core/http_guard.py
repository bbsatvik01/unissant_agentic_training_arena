"""The local HTTP boundary (D10, SG4-01, S5 10.3): Host allowlist, Origin check and CSRF double-submit for
the browser-facing services (`arena-api`, `arena-referee`). Binding to loopback and sending no CORS headers do
not stop a page on another site from posting to `127.0.0.1` with the acting user's identity, so this guard
runs first on every request: a path under `/internal/` gets the internal policy (a caller-token bearer check,
no browser credentials ever accepted); every other path gets the browser policy (Host, then Origin on a
state-changing method, then the CSRF double-submit).

Pure functions here decide each check from plain values (headers, cookies); `D10Middleware` is the one ASGI
wrapper both services install, parameterized by `GuardConfig` so each service's port and allowed origins are
its own.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

STATE_CHANGING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
CSRF_COOKIE = "arena_csrf"
CSRF_HEADER = "X-Arena-CSRF"
CSRF_TOKEN_BYTES = 32
INTERNAL_PREFIX = "/internal/"


class GuardRefusalError(Exception):
    """A D10 check failed; carries the HTTP status this refusal maps to (421, 401 or 403)."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def check_host(host_header: str | None, allowed_hosts: frozenset[str]) -> None:
    """Host: `127.0.0.1:<port>` or `localhost:<port>` for this service's configured port only; anything else
    is DNS rebinding (421, before routing)."""
    if host_header is None or host_header not in allowed_hosts:
        raise GuardRefusalError(421, f"Host {host_header!r} is not an allowed host for this service")


def is_browser_request(headers: Mapping[str, str]) -> bool:
    """A request carrying an `Origin` or a `Cookie` header is a browser request (S5 10.3 internal policy)."""
    return "origin" in headers or "cookie" in headers


def check_internal_caller(
    authorization: str | None, headers: Mapping[str, str], allowed_token_hashes: frozenset[str]
) -> None:
    """Internal policy (`/internal/*`): `Authorization: Bearer <token>` whose sha256 is an allowed caller of
    this route; a request carrying an Origin or a Cookie is a browser and is refused outright (S5 10.3: "a
    request that carries an Origin or a Cookie header is a browser and gets 403")."""
    if is_browser_request(headers):
        raise GuardRefusalError(403, "a browser credential (Origin or Cookie) was sent to an internal route")
    if authorization is None or not authorization.startswith("Bearer "):
        raise GuardRefusalError(401, "no caller token")
    token = authorization.removeprefix("Bearer ")
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    if not any(hmac.compare_digest(token_hash, allowed) for allowed in allowed_token_hashes):
        raise GuardRefusalError(401, "caller token is not allowed for this route")


def check_origin(method: str, origin: str | None, sec_fetch_site: str | None, allowed_origins: frozenset[str]) -> None:
    """Every state-changing browser request must carry an allowed `Origin`; `Sec-Fetch-Site: cross-site` is
    refused even with an allowed Origin header (defense in depth, S5 10.3 step 2)."""
    if method not in STATE_CHANGING_METHODS:
        return
    if sec_fetch_site == "cross-site":
        raise GuardRefusalError(403, "Sec-Fetch-Site: cross-site")
    if origin is None or origin not in allowed_origins:
        raise GuardRefusalError(403, f"Origin {origin!r} is not allowed")


def new_csrf_token() -> str:
    return secrets.token_hex(CSRF_TOKEN_BYTES)


def check_csrf(method: str, cookie_value: str | None, header_value: str | None) -> None:
    """Every state-changing browser request must carry `X-Arena-CSRF` equal to the `arena_csrf` cookie
    (constant-time comparison); a missing cookie or header, or a mismatch, is refused (S5 10.3 step 3)."""
    if method not in STATE_CHANGING_METHODS:
        return
    if not cookie_value or not header_value or not hmac.compare_digest(cookie_value, header_value):
        raise GuardRefusalError(403, "missing or mismatched X-Arena-CSRF")


@dataclass(frozen=True)
class GuardConfig:
    """One service's D10 parameters: the Host values its own port answers to, the browser Origins it accepts,
    and the caller-token hashes allowed per internal path prefix (checked by the longest matching prefix)."""

    allowed_hosts: frozenset[str]
    allowed_origins: frozenset[str]
    internal_caller_hashes: Callable[[str], frozenset[str]] = field(default=lambda _path: frozenset())


@dataclass(frozen=True)
class GuardDecision:
    """What the guard decided about one request, for the route layer to act on (never routing itself).
    `GET /api/me` mints and sets the CSRF cookie itself (`new_csrf_token`); the guard only checks it."""

    is_internal: bool


@dataclass(frozen=True, kw_only=True)
class RequestFacts:
    """The plain values `evaluate_request` decides from; a service's ASGI middleware reads these off the
    actual request object (headers are lower-cased, matching ASGI/Starlette's own convention)."""

    method: str
    path: str
    host_header: str | None
    headers: Mapping[str, str]
    authorization: str | None
    origin: str | None
    sec_fetch_site: str | None
    csrf_cookie: str | None
    csrf_header: str | None


def evaluate_request(config: GuardConfig, request: RequestFacts) -> GuardDecision:
    """The whole D10 sequence for one request (S5 10.3): Host first, then dispatch on the path. Raises
    `GuardRefusalError` for the route layer to turn into the matching HTTP status before any side effect runs."""
    check_host(request.host_header, config.allowed_hosts)
    if request.path.startswith(INTERNAL_PREFIX):
        check_internal_caller(request.authorization, request.headers, config.internal_caller_hashes(request.path))
        return GuardDecision(is_internal=True)
    check_origin(request.method, request.origin, request.sec_fetch_site, config.allowed_origins)
    check_csrf(request.method, request.csrf_cookie, request.csrf_header)
    return GuardDecision(is_internal=False)
