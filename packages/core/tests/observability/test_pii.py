"""Free-text PII redaction (lift target: cloudforce C1; S5 8.3)."""

from __future__ import annotations

import time

from arena_core.observability import pii


def test_redact_text_masks_email_phone_card_and_bearer() -> None:
    text = (
        "Contact investigator@example.com or call 415-555-0199, card 4111 1111 1111 1111, "
        "Authorization: Bearer abc.def-123"
    )
    out = pii.redact_text(text)
    assert out is not None
    assert "investigator@example.com" not in out
    assert "415-555-0199" not in out
    assert "4111 1111 1111 1111" not in out
    assert "abc.def-123" not in out
    assert "[email]" in out
    assert "[phone]" in out
    assert "[card]" in out
    assert "[token]" in out


def test_redact_text_passes_through_dates_and_versions() -> None:
    text = "released on 2026-05-08, version 3.12.13, case f:24"
    out = pii.redact_text(text)
    assert out == text  # none of these look like a phone number


def test_redact_text_masks_a_parenthesised_area_code_with_no_trailing_separator() -> None:
    """Regression (Codex self-gate round 2, major): a parenthesised area code immediately followed by the
    exchange (no space, dash or dot after the closing paren) used to survive unredacted -- the parens alone
    already disambiguate it from a bare digit run, so a separator should not be required there too."""
    for text in ("(415)555-0199", "+1(415)555-0199", "call (415)555-0199 now"):
        out = pii.redact_text(text)
        assert out is not None
        assert "415" not in out
        assert "[phone]" in out


def test_redact_text_stays_fast_on_a_long_run_with_no_at_sign() -> None:
    """Regression (Codex self-gate round 3, major): the email regex's unbounded local-part quantifier made
    a dotted run with no "@" quadratic -- a 32,768-char attribute value took ~3.4s through this one regex
    alone, synchronously, on the thread ending the span. A generous 2s budget for a run nearly twice that
    size leaves a wide margin over the fixed (~0.02s) behavior while still catching a regression back to
    quadratic (which would take tens of seconds at this size)."""
    time_budget_s = 2.0
    text = "a." * 30_000
    start = time.perf_counter()
    pii.redact_text(text)
    assert time.perf_counter() - start < time_budget_s


def test_redact_text_none_stays_none() -> None:
    assert pii.redact_text(None) is None


def test_redact_text_truncates_past_the_cap() -> None:
    out = pii.redact_text("a" * 10, max_len=4)
    assert out is not None
    assert out.startswith("aaaa")
    assert "truncated" in out


def test_redact_headers_strips_denylisted_keys_and_lowercases() -> None:
    headers = {"Authorization": "Bearer xyz", "X-Trace-Id": "abc", "Cookie": "s=1"}
    out = pii.redact_headers(headers)
    assert "authorization" not in out
    assert "cookie" not in out
    assert out["x-trace-id"] == "abc"


def test_redact_headers_accepts_asgi_byte_pairs() -> None:
    headers = [(b"Authorization", b"Bearer xyz"), (b"X-Request-Id", b"1")]
    out = pii.redact_headers(headers)
    assert "authorization" not in out
    assert out["x-request-id"] == "1"


KEPT_NUMBER = 42


def test_redact_json_walks_nested_structures() -> None:
    payload = {"notes": "email me at a@b.com", "items": ["call 415-555-0199", KEPT_NUMBER, None]}
    out = pii.redact_json(payload)
    assert isinstance(out, dict)
    assert "[email]" in out["notes"]
    assert "[phone]" in out["items"][0]
    assert out["items"][1] == KEPT_NUMBER
    assert out["items"][2] is None


def test_redact_json_depth_limit_replaces_the_subtree() -> None:
    nested: dict[str, object] = {"v": "leaf"}
    for _ in range(5):
        nested = {"v": nested}
    out = pii.redact_json(nested, max_depth=2)
    assert out == "[max_depth]" or (isinstance(out, dict) and "[max_depth]" in str(out))
