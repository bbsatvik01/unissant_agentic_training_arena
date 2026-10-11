"""Free-text PII redaction (lift target: cloudforce C1, `observability/redaction.py:1-136`; MIT, copyright
Satvik Balla; docs/ATTRIBUTIONS.md). Renamed from cloudforce's own `redaction.py` to `pii.py` here because this
repo's `observability/redaction.py` is TechnoMile's T16 credential masking; the two are independent passes
(8.3) and keeping cloudforce's original names (`redact_headers`, `redact_text`, `redact_json`) would collide.

Two stages:
1. ``redact_headers`` -- strip a denylist of authentication / session headers before persisting a request
   envelope.
2. ``redact_text`` / ``redact_json`` -- regex-replace email addresses, phone numbers, card-shaped digit runs
   and bearer tokens; cap string length.

Applied to investigator free text before it is logged or mirrored, and as a second pass inside the span
``Redactor`` (``export_policy``), ahead of TechnoMile's T16 credential masking (``redaction.py``): bearer-token
masking here runs before T16's generic prefix scan so a token embedded in free prose is not left half-masked by
one pass and missed by the other. Pure functions; no I/O.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

# Lower-cased header names that must never be persisted.
_HEADER_DENYLIST: frozenset[str] = frozenset(
    {
        "authorization",
        "cookie",
        "set-cookie",
        "proxy-authorization",
        "x-supabase-auth",
        "x-api-key",
        "x-auth-token",
        "x-csrf-token",
        "openai-api-key",
        "anthropic-api-key",
        "x-google-api-key",
    }
)

# Order of substitution matters: bearer-token replacement runs before the generic email/phone passes so that
# "Bearer foo@bar" tokens are redacted whole rather than partially via the email regex.
_BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.IGNORECASE)
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
# Tighter phone regex: requires at least one separator character (space, dash, dot, or parenthesis) within the
# digit sequence to distinguish phone numbers from pure digit runs such as UUID segments, long ids, and ISO
# timestamps. It reads as an optional leading country code with its own trailing separator, then one or two
# area or trunk code groups (optionally parenthesised, each followed by a mandatory separator), then a
# subscriber number of seven or eight digits split in two halves, at a word boundary.
#
# True positives: 415-555-0199, +1 (415) 555-0199, +44 20 7946 0958.
# False positives avoided: a plain date (2026-05-08), a dotted version (3.12.13), a UUID segment, a bare
# six-digit id -- none of these match.
_PHONE_RE = re.compile(r"\+?(\b[1-9]\d{0,2}[\s\-().])?(\(?\d{2,4}\)?[\s\-.]){1,2}\d{3,4}[\s\-.]?\d{3,4}\b")
_CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")

DEFAULT_TEXT_CAP = 80_000
DEFAULT_JSON_STRING_CAP = 4_000
DEFAULT_JSON_DEPTH = 8


HeaderInput = dict[str, str] | Iterable[tuple[bytes, bytes]]


def redact_headers(headers: HeaderInput) -> dict[str, str]:
    """Return a lower-cased header dict with denylisted keys removed.

    Accepts either a ``dict[str, str]`` or the ASGI ``[(name_bytes, value_bytes)]`` list form.
    Non-denylisted values are kept verbatim -- callers that want body-style redaction on header values
    must do it themselves.
    """
    pairs: Iterable[tuple[str, str]]
    if isinstance(headers, dict):
        pairs = headers.items()
    else:
        pairs = ((k.decode("latin-1"), v.decode("latin-1")) for k, v in headers)
    out: dict[str, str] = {}
    for k, v in pairs:
        kl = k.lower()
        if kl in _HEADER_DENYLIST:
            continue
        out[kl] = v
    return out


def redact_text(s: str | None, max_len: int = DEFAULT_TEXT_CAP) -> str | None:
    """Strip emails, phones, card-shaped runs, bearer tokens; cap length.

    Returns ``None`` if the input is ``None`` so callers can distinguish "no payload" from
    "redacted-empty payload".
    """
    if s is None:
        return None
    # Order: bearer -> email -> card -> phone. Card runs before phone because the phone pattern would
    # otherwise greedily swallow card-shaped digit runs ("4111 1111 1111 1111" matches the phone regex too).
    s = _BEARER_RE.sub(r"\1[token]", s)
    s = _EMAIL_RE.sub("[email]", s)
    s = _CARD_RE.sub("[card]", s)
    s = _PHONE_RE.sub("[phone]", s)
    if len(s) > max_len:
        truncated = len(s) - max_len
        s = s[:max_len] + f"\n…[truncated {truncated} chars]"
    return s


def redact_json(
    obj: object,
    max_depth: int = DEFAULT_JSON_DEPTH,
    max_string: int = DEFAULT_JSON_STRING_CAP,
) -> object:
    """Recursively walk a JSON-shaped structure and redact every string leaf.

    ``max_depth`` is a hard cycle/runaway guard -- beyond the limit the subtree is replaced with the
    sentinel ``"[max_depth]"``. Strings are capped at ``max_string`` chars (smaller than ``redact_text``'s
    default because JSON bodies tend to have many fields).
    """
    if max_depth <= 0:
        return "[max_depth]"
    if isinstance(obj, str):
        return redact_text(obj, max_len=max_string)
    if isinstance(obj, dict):
        return {k: redact_json(v, max_depth - 1, max_string) for k, v in obj.items()}
    if isinstance(obj, list | tuple):
        return [redact_json(v, max_depth - 1, max_string) for v in obj]
    # numbers, booleans, None -- no PII surface, keep verbatim.
    return obj
