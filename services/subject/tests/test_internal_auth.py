"""The internal-caller check (S5 5.5, 10.2 item 4, 10.3 "Internal policy"): a browser request is refused
outright; otherwise the bearer token's sha256 must name an allowed caller."""

from __future__ import annotations

from http import HTTPStatus

import pytest

from arena_subject.internal_auth import InternalCallerRefusedError, parse_callers, token_sha256, verify_internal_caller

FIXTURE_BEARER = "s3cr3t-caller-token"
ALLOWED = frozenset({token_sha256(FIXTURE_BEARER)})


def test_parse_callers_accepts_comma_or_space_separated_digests() -> None:
    a, b = token_sha256("a"), token_sha256("b")
    assert parse_callers(f"{a}, {b}") == {a, b}
    assert parse_callers(f"{a}   {b}") == {a, b}
    assert parse_callers("") == frozenset()
    assert parse_callers("   ") == frozenset()


def test_an_allowed_token_passes() -> None:
    verify_internal_caller({"authorization": f"Bearer {FIXTURE_BEARER}"}, ALLOWED)


def test_a_missing_token_is_refused_401() -> None:
    with pytest.raises(InternalCallerRefusedError) as exc_info:
        verify_internal_caller({}, ALLOWED)
    assert exc_info.value.status_code == HTTPStatus.UNAUTHORIZED


def test_a_wrong_token_is_refused_401() -> None:
    with pytest.raises(InternalCallerRefusedError) as exc_info:
        verify_internal_caller({"authorization": "Bearer nope"}, ALLOWED)
    assert exc_info.value.status_code == HTTPStatus.UNAUTHORIZED


def test_a_malformed_authorization_header_is_refused() -> None:
    with pytest.raises(InternalCallerRefusedError):
        verify_internal_caller({"authorization": FIXTURE_BEARER}, ALLOWED)


@pytest.mark.parametrize(
    "headers",
    [
        {"authorization": f"Bearer {FIXTURE_BEARER}", "origin": "https://evil.example"},
        {"authorization": f"Bearer {FIXTURE_BEARER}", "cookie": "a=b"},
    ],
)
def test_a_browser_request_is_refused_403_even_with_the_right_token(headers: dict[str, str]) -> None:
    with pytest.raises(InternalCallerRefusedError) as exc_info:
        verify_internal_caller(headers, ALLOWED)
    assert exc_info.value.status_code == HTTPStatus.FORBIDDEN
