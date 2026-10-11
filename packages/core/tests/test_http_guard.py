"""D10 (S5 10.3, 10.4): Host allowlist, Origin check, CSRF double-submit, internal caller policy."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import replace

import pytest

from arena_core.http_guard import (
    CSRF_TOKEN_BYTES,
    GuardConfig,
    GuardRefusalError,
    RequestFacts,
    evaluate_request,
    new_csrf_token,
)

DNS_REBINDING = 421
UNAUTHORIZED = 401
FORBIDDEN = 403

HOST = frozenset({"127.0.0.1:8082"})
ORIGIN = frozenset({"http://127.0.0.1:8082"})
# Fixture value only: a caller token this test hashes itself, never a password or a real secret.
CALLER_CREDENTIAL = "s3cr3t-caller-credential"
TOKEN_HASH = hashlib.sha256(CALLER_CREDENTIAL.encode()).hexdigest()
CONFIG = GuardConfig(
    allowed_hosts=HOST, allowed_origins=ORIGIN, internal_caller_hashes=lambda _path: frozenset({TOKEN_HASH})
)

_BROWSER_GET = RequestFacts(
    method="GET",
    path="/api/me",
    host_header="127.0.0.1:8082",
    headers={},
    authorization=None,
    origin=None,
    sec_fetch_site=None,
    csrf_cookie=None,
    csrf_header=None,
)
_BROWSER_POST = RequestFacts(
    method="POST",
    path="/api/admin/tournaments/t1/reveal",
    host_header="127.0.0.1:8082",
    headers={"origin": "http://127.0.0.1:8082"},
    authorization=None,
    origin="http://127.0.0.1:8082",
    sec_fetch_site="same-origin",
    csrf_cookie="tok",
    csrf_header="tok",
)
_INTERNAL_POST = RequestFacts(
    method="POST",
    path="/internal/trials/t1/score",
    host_header="127.0.0.1:8082",
    headers={},
    authorization=f"Bearer {CALLER_CREDENTIAL}",
    origin=None,
    sec_fetch_site=None,
    csrf_cookie=None,
    csrf_header=None,
)


def browser_get(
    *,
    host_header: str | None = _BROWSER_GET.host_header,
) -> RequestFacts:
    return replace(_BROWSER_GET, host_header=host_header)


def browser_post(
    *,
    origin: str | None = _BROWSER_POST.origin,
    headers: Mapping[str, str] | None = None,
    sec_fetch_site: str | None = _BROWSER_POST.sec_fetch_site,
    csrf_cookie: str | None = _BROWSER_POST.csrf_cookie,
    csrf_header: str | None = _BROWSER_POST.csrf_header,
) -> RequestFacts:
    return replace(
        _BROWSER_POST,
        origin=origin,
        headers=_BROWSER_POST.headers if headers is None else headers,
        sec_fetch_site=sec_fetch_site,
        csrf_cookie=csrf_cookie,
        csrf_header=csrf_header,
    )


def internal_post(
    *,
    authorization: str | None = _INTERNAL_POST.authorization,
    headers: Mapping[str, str] | None = None,
) -> RequestFacts:
    return replace(
        _INTERNAL_POST, authorization=authorization, headers=_INTERNAL_POST.headers if headers is None else headers
    )


# Host check: DNS rebinding refused with 421 before routing.


def test_foreign_host_refused_421_before_routing() -> None:
    with pytest.raises(GuardRefusalError) as exc:
        evaluate_request(CONFIG, browser_get(host_header="evil.example"))
    assert exc.value.status == DNS_REBINDING


def test_missing_host_refused() -> None:
    with pytest.raises(GuardRefusalError) as exc:
        evaluate_request(CONFIG, browser_get(host_header=None))
    assert exc.value.status == DNS_REBINDING


# Origin check on state-changing browser requests.


def test_get_needs_no_origin() -> None:
    evaluate_request(CONFIG, browser_get())  # no exception


def test_post_with_foreign_origin_refused() -> None:
    evil = "https://evil.example"
    with pytest.raises(GuardRefusalError) as exc:
        evaluate_request(CONFIG, browser_post(origin=evil, headers={"origin": evil}))
    assert exc.value.status == FORBIDDEN


def test_post_with_no_origin_refused() -> None:
    with pytest.raises(GuardRefusalError):
        evaluate_request(CONFIG, browser_post(origin=None, headers={}))


def test_post_cross_site_sec_fetch_refused_even_with_allowed_origin() -> None:
    with pytest.raises(GuardRefusalError):
        evaluate_request(CONFIG, browser_post(sec_fetch_site="cross-site"))


# CSRF double-submit on state-changing browser requests.


def test_post_without_csrf_header_refused() -> None:
    with pytest.raises(GuardRefusalError) as exc:
        evaluate_request(CONFIG, browser_post(csrf_header=None))
    assert exc.value.status == FORBIDDEN


def test_post_with_mismatched_csrf_refused() -> None:
    with pytest.raises(GuardRefusalError):
        evaluate_request(CONFIG, browser_post(csrf_cookie="a", csrf_header="b"))


def test_post_with_matching_origin_host_and_csrf_succeeds() -> None:
    evaluate_request(CONFIG, browser_post())  # no exception


def test_new_csrf_token_is_long_enough_and_alphanumeric() -> None:
    token = new_csrf_token()
    assert len(token) >= CSRF_TOKEN_BYTES
    assert token.isalnum()


# Internal policy on /internal/* routes: caller-token bearer, never a browser credential.


def test_internal_route_with_valid_token_succeeds() -> None:
    decision = evaluate_request(CONFIG, internal_post())
    assert decision.is_internal is True


def test_internal_route_with_no_token_refused() -> None:
    with pytest.raises(GuardRefusalError) as exc:
        evaluate_request(CONFIG, internal_post(authorization=None))
    assert exc.value.status == UNAUTHORIZED


def test_internal_route_with_wrong_token_refused() -> None:
    with pytest.raises(GuardRefusalError) as exc:
        evaluate_request(CONFIG, internal_post(authorization="Bearer wrong-token"))
    assert exc.value.status == UNAUTHORIZED


def test_internal_route_from_a_browser_refused_even_with_right_token() -> None:
    """S5 10.3: "a request that carries an Origin or a Cookie header is a browser and gets 403"."""
    with pytest.raises(GuardRefusalError) as exc:
        evaluate_request(CONFIG, internal_post(headers={"origin": "http://127.0.0.1:8082"}))
    assert exc.value.status == FORBIDDEN


def test_internal_route_with_cookie_refused() -> None:
    with pytest.raises(GuardRefusalError):
        evaluate_request(CONFIG, internal_post(headers={"cookie": "arena_csrf=x"}))
