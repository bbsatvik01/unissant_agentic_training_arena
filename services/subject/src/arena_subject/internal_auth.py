"""The Host check and the internal-caller check on `/internal/*` (S5 5.5, 10.2 item 4, 10.3 "Internal policy").

`arena-subject` serves internal routes only (S5 5.5: "never reachable from a browser"), so of S5 10.3's three
checks (Host, Origin, CSRF) the Origin/CSRF half of the policy does not apply here (there is no browser route
to protect with it); the Host check does (10.3 applies it "to every request" before dispatching on the path,
DNS-rebinding protection that has nothing to do with who the caller is), so this module carries both of
arena-subject's own checks: Host, then the bearer-token internal policy (a request carrying `Origin` or
`Cookie` is a browser and is refused outright; otherwise the token's sha256 must be one `run_local.py` started
this process with, `ARENA_LOCAL_CALLERS`, S5 10.2 item 4). The full shared Host/Origin/CSRF module
(`arena_core.http_guard`) is WP-13's, built once both browser-facing services exist; this is the local
stand-in for arena-subject's own slice of it until then, hosted IAM being out of scope for the local demo
(S5 9.3, out of this work package's scope).
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Set

CALLERS_VAR = "ARENA_LOCAL_CALLERS"
BEARER_PREFIX = "Bearer "


class InternalCallerRefusedError(Exception):
    """The request failed the Host or internal-caller check; `status_code` is the HTTP response to send."""

    def __init__(self, status_code: int, reason: str) -> None:
        super().__init__(reason)
        self.status_code = status_code
        self.reason = reason


def parse_callers(raw: str) -> frozenset[str]:
    """`ARENA_LOCAL_CALLERS`: the sha256 hex digests of every allowed caller token, comma- or space-separated."""
    return frozenset(token for token in raw.replace(",", " ").split() if token)


def token_sha256(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_host(headers: Mapping[str, str], allowed_hosts: Set[str]) -> None:
    """S5 10.3 step 1: the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` for this service's
    own configured port; anything else is 421, before any other check (DNS rebinding)."""
    if headers.get("host") not in allowed_hosts:
        msg = f"Host {headers.get('host')!r} is not this service's own address"
        raise InternalCallerRefusedError(421, msg)


def verify_internal_caller(headers: Mapping[str, str], allowed: Set[str]) -> None:
    """Raise `InternalCallerRefusedError` unless `headers` carries an allowed caller's bearer token and nothing
    that marks it as a browser request."""
    if headers.get("origin") is not None or headers.get("cookie") is not None:
        msg = "a browser request (Origin or Cookie present) is refused on an internal route"
        raise InternalCallerRefusedError(403, msg)
    auth = headers.get("authorization")
    if auth is None or not auth.startswith(BEARER_PREFIX):
        raise InternalCallerRefusedError(401, "missing bearer token")
    token = auth.removeprefix(BEARER_PREFIX)
    if not token or token_sha256(token) not in allowed:
        raise InternalCallerRefusedError(401, "caller token is not allowed on this route")
