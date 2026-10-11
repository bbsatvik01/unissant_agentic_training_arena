"""The internal-caller check on `/internal/*` (S5 5.5, 10.2 item 4, 10.3 "Internal policy").

`arena-subject` serves internal routes only (S5 5.5: "never reachable from a browser"), so of S5 10.3's three
checks (Host, Origin, CSRF) only the bearer-token half of the internal policy applies here: a request carrying
`Origin` or `Cookie` is a browser and is refused outright; otherwise the token's sha256 must be one `run_local.py`
started this process with (`ARENA_LOCAL_CALLERS`, S5 10.2 item 4). The Host check and the browser-facing
Origin/CSRF policy are `arena_core.http_guard`'s (WP-13), shared by `arena-api` and `arena-referee`; this module
is the local stand-in for arena-subject's own slice of that policy until it lands, hosted IAM being out of scope
for the local demo (S5 9.3, out of this work package's scope).
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Set

CALLERS_VAR = "ARENA_LOCAL_CALLERS"
BEARER_PREFIX = "Bearer "


class InternalCallerRefusedError(Exception):
    """The request failed the internal-caller check; `status_code` is the HTTP response to send."""

    def __init__(self, status_code: int, reason: str) -> None:
        super().__init__(reason)
        self.status_code = status_code
        self.reason = reason


def parse_callers(raw: str) -> frozenset[str]:
    """`ARENA_LOCAL_CALLERS`: the sha256 hex digests of every allowed caller token, comma- or space-separated."""
    return frozenset(token for token in raw.replace(",", " ").split() if token)


def token_sha256(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


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
