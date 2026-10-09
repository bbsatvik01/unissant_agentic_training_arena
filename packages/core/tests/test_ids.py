"""Canonical JSON, sha256 and strict JSON reading (S1 8.4)."""

from __future__ import annotations

import hashlib
import json

import pytest

from arena_core import ids


def test_canonical_json_sorts_keys_compacts_and_keeps_non_ascii() -> None:
    assert ids.canonical_json({"b": 1, "a": ["é", {"d": 2, "c": 3}]}) == '{"a":["é",{"c":3,"d":2}],"b":1}'


def test_canonical_sha256_is_sha256_of_the_utf8_canonical_text() -> None:
    obj = {"title": "Café B-12", "n": [1, 2]}
    expected = hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()
    assert ids.canonical_sha256(obj) == expected
    assert ids.canonical_sha256({"n": [1, 2], "title": "Café B-12"}) == expected


def test_sha256_hex_accepts_text_and_bytes() -> None:
    assert ids.sha256_hex("abc") == ids.sha256_hex(b"abc") == hashlib.sha256(b"abc").hexdigest()


def test_canonical_json_refuses_non_finite_numbers() -> None:
    with pytest.raises(ValueError, match="JSON compliant"):
        ids.canonical_json({"x": float("nan")})


def test_read_json_text_parses_ordinary_json() -> None:
    assert ids.read_json_text('{"a": [1, 2.5, "x"], "b": null}') == {"a": [1, 2.5, "x"], "b": None}


def test_read_json_text_refuses_duplicate_keys_at_any_depth() -> None:
    with pytest.raises(ids.StrictJSONError, match="duplicate object key 'a'"):
        ids.read_json_text('{"a": 1, "a": 2}')
    with pytest.raises(ids.StrictJSONError, match="duplicate object key 'k'"):
        ids.read_json_text('{"outer": {"k": 1, "k": 1}}')


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_read_json_text_refuses_non_finite_constants(constant: str) -> None:
    with pytest.raises(ids.StrictJSONError, match="non-finite"):
        ids.read_json_text(f'{{"x": {constant}}}')


@pytest.mark.parametrize("number", ["1e9999", "-1e9999", "1.5e400", "-2.0E+999"])
def test_read_json_text_refuses_numbers_that_overflow_to_infinity(number: str) -> None:
    with pytest.raises(ids.StrictJSONError, match="non-finite"):
        ids.read_json_text(f'{{"x": {number}}}')


def test_read_json_text_keeps_finite_and_underflowing_numbers() -> None:
    assert ids.read_json_text('{"a": 1.5, "b": 1e-9999, "c": -2e10, "d": 12345678901234567890}') == {
        "a": 1.5,
        "b": 0.0,
        "c": -2e10,
        "d": 12345678901234567890,
    }


def test_read_json_text_refuses_nesting_deeper_than_the_parser_can_go() -> None:
    with pytest.raises(ids.StrictJSONError, match="nested too deeply"):
        ids.read_json_text("[" * 100_000 + "]" * 100_000)


def test_read_json_text_refuses_nesting_beyond_the_limit() -> None:
    """Deeper than any S1 file (11 levels) but shallow enough for the parser: refused by the depth limit."""
    deep = "[" * (ids.MAX_JSON_DEPTH + 1) + "]" * (ids.MAX_JSON_DEPTH + 1)
    with pytest.raises(ids.StrictJSONError, match="nested deeper than"):
        ids.read_json_text(deep)
    ok = "[" * ids.MAX_JSON_DEPTH + "]" * ids.MAX_JSON_DEPTH
    assert ids.read_json_text(ok) is not None
    assert ids.read_json_text('{"a": {"b": [1, {"c": 2}]}}') == {"a": {"b": [1, {"c": 2}]}}
