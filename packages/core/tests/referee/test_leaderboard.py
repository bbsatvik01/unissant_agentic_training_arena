"""Assistant leaderboard body assembly (S3 5.5-5.6): FX-I01 through the body builder, a normal ranking, an
ineligible candidate, and the binding fields every row carries."""

from __future__ import annotations

import json
from decimal import Decimal
from fractions import Fraction

from arena_core.referee.leaderboard import NOT_COMPUTED, Binding, CandidateInput, build_assistant_leaderboard
from arena_core.scoring.inclusion import AsstInc
from arena_core.scoring.metrics import TrialOutcome
from arena_core.scoring.ranking import IG_ITEMS, isolation_result

BOOTSTRAP_B = 10_000
DETECTED = 8

PASSING_ISOLATION = isolation_result({item: (True, f"{item}-hash") for item in IG_ITEMS})
FAILING_ISOLATION = isolation_result({item: (item != "IG-2", f"{item}-hash") for item in IG_ITEMS})

BINDING = Binding(
    manifest_sha256="m" * 64,
    manifest_version=1,
    scorer_git_sha="0" * 40,
    rubric_sha256="r" * 64,
    r1_prompt_sha256="p1" * 32,
    r2_prompt_sha256="p2" * 32,
    label_set_sha256="l" * 64,
    bootstrap_b=BOOTSTRAP_B,
)


def trials(*, family: str, role: str, output: str, n: int) -> list[TrialOutcome]:
    inc = AsstInc.INCLUDED_AS_INSUFFICIENT if output == "insufficient_evidence" else AsstInc.INCLUDED
    label = None if output == "insufficient_evidence" else output
    return [TrialOutcome(family, role, inc, label) for _ in range(n)]


def good_candidate(candidate_id: str) -> CandidateInput:
    # 10 truthful (all cleared, no false positives: eligible), 10 deceptive (8 detected -> recall 0.8).
    t = trials(family="F01", role="truthful", output="truthful", n=10)
    d = trials(family="F01", role="deceptive", output="deceptive", n=8) + trials(
        family="F01", role="deceptive", output="truthful", n=2
    )
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t + d,
        excluded_truthful_by_family={},
        reasons=["included"] * 20,
        own_cost_rows=[(Decimal("0.01"), True)] * 20,
        own_planned=20,
    )


def ineligible_candidate(candidate_id: str) -> CandidateInput:
    # 10 truthful with 3 false positives: FPR 30% > 5%, ineligible.
    t = trials(family="F01", role="truthful", output="deceptive", n=3) + trials(
        family="F01", role="truthful", output="truthful", n=7
    )
    d = trials(family="F01", role="deceptive", output="deceptive", n=5)
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t + d,
        excluded_truthful_by_family={},
        reasons=["included"] * 15,
        own_cost_rows=[(Decimal("0.01"), True)] * 15,
        own_planned=15,
    )


def test_fx_i01_isolation_fail_yields_not_ranked_with_no_rows() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1")], isolation=FAILING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    assert body["status"] == "not ranked: isolation gate failed"
    assert body["rows"] == []
    assert body["board"] == "assistant"


def test_an_eligible_candidate_is_ranked_with_m01_and_m02() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1")], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    [row] = body["rows"]
    assert row["rank"] == 1
    assert row["eligibility"]["eligible"] is True
    m01 = row["metrics"]["M01_deceptive_recall"]["point"]
    assert Fraction(m01["num"], m01["den"]) == Fraction(8, 10)
    assert row["metrics"]["M02_false_positive_rate"]["point"]["value"] == 0.0
    assert row["metrics"]["M05_count_matrix"]["deceptive"]["deceptive"] == DETECTED
    assert Decimal(row["metrics"]["M22_cost"]["total"]) == Decimal("0.20")


def test_an_ineligible_candidate_is_listed_never_ranked() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1"), ineligible_candidate("A2")],
        isolation=PASSING_ISOLATION,
        qq_calibrated=True,
        binding=BINDING,
    )
    by_id = {row["candidate_id"]: row for row in body["rows"]}
    assert by_id["A1"]["rank"] == 1
    assert by_id["A2"]["rank"] is None
    assert by_id["A2"]["eligibility"]["eligible"] is False


def test_every_row_carries_the_binding_fields_and_the_not_computed_list() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1")], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    assert body["binding"]["manifest_sha256"] == BINDING.manifest_sha256
    assert body["binding"]["bootstrap_b"] == BOOTSTRAP_B
    assert set(body["not_computed"]) == set(NOT_COMPUTED)


def test_the_body_is_json_serializable() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1"), ineligible_candidate("A2")],
        isolation=PASSING_ISOLATION,
        qq_calibrated=True,
        binding=BINDING,
    )
    json.dumps(body)  # raises on anything non-serializable (Fraction, Decimal left unconverted, etc.)
