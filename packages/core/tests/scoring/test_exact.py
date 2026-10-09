"""Numeric conventions (S3 1.4): seeds, percentile indices and the score functions' input checks."""

from __future__ import annotations

import hashlib
from fractions import Fraction

import pytest

from arena_core.scoring.exact import RubricError, ci_indices, investigator_score, questioning_quality, seed_for


def test_the_seed_is_the_first_16_hex_digits_of_the_manifest_bound_text() -> None:
    expected = int(hashlib.sha256(b"abc|M01|A1|I").hexdigest()[:16], 16)
    assert seed_for("abc", "M01", "A1", "I") == expected


def test_percentile_indices() -> None:
    assert ci_indices(10_000) == (250, 9749)
    assert ci_indices(1000) == (25, 974)


def test_investigator_score_and_qq() -> None:
    dims = {"D1": 3, "D2": 4, "D3": 4, "D4": 3, "D5": 2}
    assert (investigator_score(dims), questioning_quality(dims)) == (80, Fraction(14, 16))


@pytest.mark.parametrize(
    "dims",
    [
        {"D1": 3, "D2": 4, "D3": 4, "D4": 3},
        {"D1": 5, "D2": 4, "D3": 4, "D4": 3, "D5": 0},
        {"D1": -1, "D2": 0, "D3": 0, "D4": 0, "D5": 0},
    ],
)
def test_investigator_score_refuses_a_missing_or_out_of_range_dimension(dims: dict[str, int]) -> None:
    with pytest.raises(RubricError):
        investigator_score(dims)


def test_qq_refuses_a_missing_dimension() -> None:
    with pytest.raises(RubricError):
        questioning_quality({"D1": 3, "D2": 4, "D3": 4})
