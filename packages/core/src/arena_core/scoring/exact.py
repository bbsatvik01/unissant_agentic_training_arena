"""Numeric conventions (S3 1.4): exact rationals for points and gates, the rubric mapping, seeds, percentiles."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from fractions import Fraction
from math import floor

GATE = Fraction(1, 20)  # the FPR gate: Fraction(fp, n) <= GATE (S3 1.4 item 1)
B = 10_000  # bootstrap and permutation resamples (S3 1.4 item 4, S3-D7)
DIMENSIONS = ("D1", "D2", "D3", "D4", "D5")
QQ_DIMENSIONS = ("D1", "D2", "D3", "D4")  # S3-D2: closure is not a QQ key
MIN_APPLICABLE = 2
MAX_DIMENSION = 4


class RubricError(ValueError):
    """A rubric input the scorer must not score (fails closed)."""


def ci_indices(b: int = B) -> tuple[int, int]:
    """0-based indices of the 95% two-sided percentile interval in a sorted array of b statistics (250, 9749)."""
    lo = (25 * b) // 1000
    return lo, b - 1 - lo


def seed_for(manifest_hash: str, metric_id: str, candidate_or_subject_id: str, track: str) -> int:
    """S3 1.4 item 5: every interval's seed derives from the sealed manifest, so no seed is chosen after the fact."""
    text = f"{manifest_hash}|{metric_id}|{candidate_or_subject_id}|{track}"
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:16], 16)


def dimension_score(verdicts: Mapping[str, bool | None]) -> int:
    """S3 2.8: `floor(4 x passed / applicable + 1/2)` in exact rationals; None is a check that does not apply."""
    applicable = [v for v in verdicts.values() if v is not None]
    if len(applicable) < MIN_APPLICABLE:
        msg = "dimension has fewer than two applicable checks"
        raise RubricError(msg)
    return floor(Fraction(4 * sum(applicable), len(applicable)) + Fraction(1, 2))


def _check_dims(dims: Mapping[str, int], expected: tuple[str, ...]) -> None:
    if tuple(sorted(dims)) != expected or not all(0 <= v <= MAX_DIMENSION for v in dims.values()):
        msg = f"dimension scores must be exactly {list(expected)}, each 0-4: {dict(dims)}"
        raise RubricError(msg)


def investigator_score(dims: Mapping[str, int]) -> int:
    """5 x the sum of D1-D5, 0-100 (REQUIREMENTS section 11)."""
    _check_dims(dims, DIMENSIONS)
    return 5 * sum(dims.values())


def questioning_quality(dims: Mapping[str, int]) -> Fraction:
    """QQ = (D1 + D2 + D3 + D4) / 16, never a mean of defined dimensions (S3 2.8, 2.9; C-14)."""
    picked = {d: dims[d] for d in QQ_DIMENSIONS if d in dims}
    _check_dims(picked, QQ_DIMENSIONS)
    return Fraction(sum(picked.values()), 16)
