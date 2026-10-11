"""Typed agent-port failures (S5 3.1). Every port call ends in a value or one of these; never ``None``.

Shape adapted from TechnoMile `bh_core/providers/errors.py` (T6/T7; ATTRIBUTIONS.md): the per-attempt
`ProviderCallError` with its `ErrorKind` and `maybe_billed` flag, and `kind_for_status` (explicit HTTP codes, no
message sniffing). The fail-over kinds, free-tier quota parsing and route errors are dropped (one Vertex route).

S5 3.1 names the terminal failures `BudgetRefused`, `KillSwitchOn`, `PolicyRefused`, `InputTooLarge`,
`StructuredOutputError`, `ProviderBlocked` and `ProviderFailed`; here each carries the `Error` suffix the repo's
lint requires (ruff N818), one class per name.
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from arena_core.providers.types import Usage


class ErrorKind(StrEnum):
    """How the port reacts to one failed attempt."""

    TRANSIENT = "transient"  # 429, 408, 5xx, timeout, transport error: retried while attempts remain
    BAD_REQUEST = "bad_request"  # other 4xx, credentials: our request or setup is wrong; never retried
    TRUNCATED = "truncated"  # finish_reason MAX_TOKENS: the one repair (S2 10)
    BLOCKED = "blocked"  # a safety or content stop: the one repair (S2 10)
    EMPTY = "empty"  # no candidate text: handled as a schema failure (the one repair)


_TRANSIENT_STATUSES = frozenset({408, 429})
_SERVER_ERROR_FLOOR = 500


def kind_for_status(status: int) -> ErrorKind:
    """Map an HTTP status to an error kind (explicit codes, no message sniffing)."""
    if status in _TRANSIENT_STATUSES or status >= _SERVER_ERROR_FLOOR:
        return ErrorKind.TRANSIENT
    return ErrorKind.BAD_REQUEST


class ProviderError(Exception):
    """Base of every agent-port failure."""


class ConfigError(ProviderError):
    """The port is misconfigured (for example an output schema that is not flat and bounded)."""


class PolicyRefusedError(ProviderError):
    """Refused before any reservation: model outside the call type's allowlist, purpose, timeout or manifest."""


class InputTooLargeError(ProviderError):
    """S2 10 `input_over_limit`: the request plus REPAIR_BYTES exceeds the call type's byte limit (raised before any
    reservation row exists), or a send would exceed the bytes reserved (never sent)."""

    def __init__(self, message: str, *, request_bytes: int, limit_bytes: int) -> None:
        super().__init__(message)
        self.request_bytes = request_bytes
        self.limit_bytes = limit_bytes


class BudgetRefusedError(ProviderError):
    """The spend guard refused the reservation (`cap`, `per_user_cap`, ...); nothing was sent."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"spend guard refused the reservation: {reason}")
        self.reason = reason


class KillSwitchOnError(ProviderError):
    """The kill switch is on (read at reservation and again at dispatch); nothing was sent."""


class StructuredOutputError(ProviderError):
    """No schema-valid reply after the one repair, or the attempt cap was reached first. `reply_text` is the
    last attempt's raw text (S2 6.10: a subject G0_schema quarantine stores it, or `""` when there was
    none), never echoed back to a provider."""

    def __init__(self, message: str, *, reply_text: str = "") -> None:
        super().__init__(message)
        self.reply_text = reply_text


class ProviderBlockedError(ProviderError):
    """The provider blocked the reply (safety or similar) and the one repair did not clear it. `reply_text`
    is whatever visible text the last blocked attempt carried (S2 6.10: a subject G0_blocked quarantine
    stores it, or `""` when there was none)."""

    def __init__(self, message: str, *, reply_text: str = "") -> None:
        super().__init__(message)
        self.reply_text = reply_text


class ProviderFailedError(ProviderError):
    """Any other terminal failure: transient errors past the attempt cap, a bad request, the deadline."""


class LedgerStalledError(ProviderFailedError):
    """A spend-guard write did not finish within the ledger timeout. Whatever it left stays charged: an unsettled
    hold counts at its full amount against the ceiling, so a stalled ledger can only over-count, never overspend."""


class StepInProgressError(ProviderFailedError):
    """The step key has an open reservation and the caller did not ask to recover it (S5 5.1): nothing was reserved,
    settled or sent, so a live call's hold is never settled from under it."""


class ProviderCallError(ProviderError):
    """One attempt failed. ``maybe_billed`` marks an attempt the provider may have charged for without reporting
    usage (a timeout, a dropped connection); the call then settles ``usage_unknown`` and keeps its full
    reservation (S5 3.2 step 6)."""

    def __init__(
        self,
        kind: ErrorKind,
        message: str,
        *,
        status: int | None = None,
        maybe_billed: bool = False,
        usage: Usage | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status
        self.maybe_billed = maybe_billed
        self.usage = usage
        self.reply_text = ""  # a cut-off or blocked reply's visible text, echoed by the one repair (S2 10)
