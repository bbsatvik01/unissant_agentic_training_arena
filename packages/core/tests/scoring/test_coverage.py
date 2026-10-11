"""Evidence coverage (S3 6.1): key_fact_ids, evidence_coverage. FX-K05 (S3 6.1)."""

from __future__ import annotations

from fractions import Fraction

from arena_core.scoring.coverage import evidence_coverage, key_fact_ids

from .builders import judgment, report


def test_key_fact_ids_sorted_distinct() -> None:
    packet = {
        "rubric": {"key_questions": [{"target_fact_ids": ["f:10", "f:06"]}, {"target_fact_ids": ["f:06", "f:22"]}]}
    }
    assert key_fact_ids(packet) == ("f:06", "f:10", "f:22")


def test_fx_k05_unknown_fact_question_counts_as_addressed() -> None:
    """FX-K05 (S3 6.1, F02 truthful): key facts f:06, f:09, f:10, f:20, f:22, f:23, where f:22 is unknown to
    the subject. Questions asking for f:06 (t01), f:22 (t03) and f:22, f:23 (t05) give 3 of 6 addressed, with
    f:22 addressed at turns 3 and 5 even though the subject does not know it."""
    key = ("f:06", "f:09", "f:10", "f:20", "f:22", "f:23")
    r = report(
        [
            judgment(1, requested_fact_ids=["f:06"]),
            judgment(2, requested_fact_ids=[]),
            judgment(3, requested_fact_ids=["f:22"], asked_fact_status="unknown"),
            judgment(4, requested_fact_ids=[]),
            judgment(5, requested_fact_ids=["f:22", "f:23"], asked_fact_status="unknown"),
        ]
    )
    cov = evidence_coverage(r, key)
    half = Fraction(1, 2)
    assert cov.addressed == len(key) * half
    assert cov.key_facts == len(key)
    assert cov.share == half
    assert cov.by_fact["f:22"] == (3, 5)
    assert cov.by_fact["f:06"] == (1,)
    assert cov.by_fact["f:09"] == ()


def test_no_key_facts_gives_zero_share_not_a_division_error() -> None:
    r = report([judgment(1)])
    cov = evidence_coverage(r, ())
    assert cov.key_facts == 0
    assert cov.addressed == 0
    assert cov.share == Fraction(0)
