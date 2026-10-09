"""Statistical machinery (S3 5.1, 5.4) and the port of `stats_contracts.py`: AC-S3-1.2, 1.3, 5.2, 5.4; FX-U01 to
FX-U03, FX-Z03, FX-Z04, FX-A01 to FX-A03."""

from __future__ import annotations

from fractions import Fraction

import numpy as np
import pytest

from arena_core.scoring.exact import GATE, ci_indices, seed_for
from arena_core.scoring.stats import (
    Cluster,
    attrition_sensitivity,
    clopper_pearson_upper,
    cluster_bootstrap,
    eligibility,
    families_needed,
    family_level_bound,
    paired_difference,
    planned_denominators,
    rank_sensitivity,
    ratio,
    trial_fpr,
    two_sided_zero_event_upper,
    unequal_family_statistic,
    unequal_size_counterexample,
    zero_event_upper_bound,
)

from .builders import ri

# ---------------------------------------------------------------- AC-S3-1.2, FX-Z03, FX-Z04


def test_ac_s3_1_2_the_gate_is_exact() -> None:
    assert Fraction(3, 60) <= GATE
    assert not Fraction(4, 79) <= GATE


def test_fx_z03_3_of_60_is_eligible_and_fx_z04_4_of_79_is_not() -> None:
    assert eligibility(3, 60, 0, isolation_pass=True).eligible is True
    assert eligibility(4, 79, 0, isolation_pass=True).eligible is False


# ---------------------------------------------------------------- AC-S3-5.4: stats_contracts.py __main__


def test_ac_s3_5_4_every_assertion_of_the_script_main() -> None:
    assert (
        planned_denominators(15)["interactive_subject_turns_per_subject_max"],
        planned_denominators(17)["interactive_truthful_per_assistant"],
    ) == (1080, 51)
    assert zero_event_upper_bound(60) == pytest.approx(0.048703, abs=1e-5)
    assert zero_event_upper_bound(30) == pytest.approx(0.095034, abs=1e-5)
    p_family, fpr = unequal_size_counterexample()
    assert fpr > p_family
    own = attrition_sensitivity(fp=9, valid_truthful=100, excluded_truthful=0)
    assert own.point is not None
    assert own.point > Fraction(1, 20)
    assert not own.provisional
    edge = attrition_sensitivity(fp=4, valid_truthful=100, excluded_truthful=9)
    assert edge.provisional
    empty = attrition_sensitivity(fp=0, valid_truthful=0, excluded_truthful=120)
    assert empty.status.startswith("insufficient")
    r = rank_sensitivity({"A": (30, 30, 90), "B": (110, 120, 0)})
    assert (r.order[0], r.provisional, r.low_coverage) == ("A", True, ("A",))


def test_attrition_and_rank_sensitivity_invariants_on_random_inputs() -> None:
    """The script's rules, stated as invariants: best <= point <= worst; provisional exactly when the three sit on
    different sides of the gate; candidates ordered by point; low coverage exactly below 90%."""
    rng = np.random.default_rng(20261009)
    for _ in range(2000):
        valid, exc = ri(rng, 0, 120), ri(rng, 0, 30)
        fp = min(ri(rng, 0, 12), valid)
        a = attrition_sensitivity(fp, valid, exc)
        if valid == 0:
            assert (a.point, a.provisional) == (None, True)
            continue
        assert a.point is not None
        assert a.worst is not None
        assert a.best is not None
        assert a.best <= a.point <= a.worst
        sides = {a.point <= GATE, a.worst <= GATE, a.best <= GATE}
        assert (a.provisional, a.status) == (len(sides) > 1, "provisional" if len(sides) > 1 else "definitive")
    for _ in range(500):
        cands = {n: (d := ri(rng, 0, 40), d + ri(rng, 0, 40), ri(rng, 0, 40)) for n in "ABCD"}
        r = rank_sensitivity(cands)
        points = [r.rows[n].point for n in r.order]
        assert points == sorted(points, key=lambda p: Fraction(-1) if p is None else p, reverse=True)
        assert set(r.low_coverage) == {n for n, (_, inc, exc) in cands.items() if inc < Fraction(9, 10) * (inc + exc)}
    assert (families_needed(0.05),) == (59,)
    assert zero_event_upper_bound(15) == 1 - 0.05 ** (1 / 15)
    assert two_sided_zero_event_upper(15) == zero_event_upper_bound(15, 0.025)


def test_planned_denominators_match_the_s3_5_2_table() -> None:
    for n, per_role, turns in ((15, 45, 1080), (17, 51, 1224)):
        d = planned_denominators(n)
        assert d["interactive_truthful_per_assistant"] == d["interactive_deceptive_per_assistant"] == per_role
        assert d["interactive_trials_per_subject"] == 6 * n
        assert d["interactive_subject_turns_per_subject_max"] == turns
        assert (d["false_positives_passing_5pct_gate"],) == (2,)
    assert (round(zero_event_upper_bound(15) * 1000), round(zero_event_upper_bound(17) * 1000)) == (181, 162)


def test_zero_event_bound_needs_families() -> None:
    with pytest.raises(ValueError, match="without retained families"):
        zero_event_upper_bound(0)


# ---------------------------------------------------------------- FX-A01 to FX-A03


def test_fx_a01_own_valid_eligibility_keeps_nine_false_positives() -> None:
    e = eligibility(9, 100, 0, isolation_pass=True)
    assert (e.eligible, e.status) == (False, "definitive")


def test_fx_a02_truthful_attrition_makes_eligibility_provisional() -> None:
    e = eligibility(4, 100, 9, isolation_pass=True)
    assert (e.eligible, e.status) == (True, "provisional")
    assert (e.attrition.point, e.attrition.worst, e.attrition.best) == (
        Fraction(4, 100),
        Fraction(13, 109),
        Fraction(4, 109),
    )


def test_fx_a03_deceptive_attrition_ranks_a_above_b_provisionally_with_low_coverage() -> None:
    r = rank_sensitivity({"A": (30, 30, 90), "B": (110, 120, 0)})
    assert r.order == ("A", "B")
    assert (r.rows["A"].worst, r.rows["B"].point) == (Fraction(1, 4), Fraction(11, 12))
    assert (r.provisional, r.low_coverage) == (True, ("A",))


def test_eligibility_isolation_failure_and_no_truthful_trials() -> None:
    assert eligibility(0, 60, 0, isolation_pass=False).status == "isolation_failed"
    e = eligibility(0, 0, 45, isolation_pass=True)
    assert (e.eligible, e.status) == (False, "insufficient: no included truthful trials")


# ---------------------------------------------------------------- bootstrap (AC-S3-5.2, 1.3; FX-U02, FX-U03)


def test_ac_s3_5_2_the_bootstrap_never_divides_by_zero() -> None:
    rng = np.random.default_rng(7)
    for _ in range(200):
        clusters = [Cluster(f"F{i}", ri(rng, 0, 3), int(rng.choice([0, 0, 1, 2, 3]))) for i in range(ri(rng, 0, 8))]
        clusters = [Cluster(c.family_id, min(c.num, c.den), c.den) for c in clusters]
        iv = cluster_bootstrap(clusters, seed=ri(rng, 0, 2**62), b=500)
        pool = [c for c in clusters if c.den > 0]
        assert iv.pool == len(pool)
        if not pool:
            assert (iv.lo, iv.hi, iv.status) == (None, None, "undefined")
            continue
        rates = [c.num / c.den for c in pool]
        assert iv.lo is not None
        assert iv.hi is not None
        assert min(rates) - 1e-12 <= iv.lo <= iv.hi <= max(rates) + 1e-12


def test_ac_s3_1_3_the_same_seed_reproduces_every_interval_bit_for_bit() -> None:
    clusters = [Cluster(f"F{i}", i % 3, 3) for i in range(15)]
    seed = seed_for("a" * 64, "M02", "A1", "I")
    assert cluster_bootstrap(clusters, seed) == cluster_bootstrap(clusters, seed)
    assert seed == seed_for("a" * 64, "M02", "A1", "I") != seed_for("a" * 64, "M02", "A2", "I")
    assert ci_indices() == (250, 9749)


def test_fx_u02_families_with_no_trial_of_the_role_leave_the_pool() -> None:
    clusters = [Cluster("F1", 1, 3), Cluster("F2", 0, 0), Cluster("F3", 0, 3)]
    iv = cluster_bootstrap(clusters, seed=1, b=1000)
    assert (iv.pool, ratio(clusters)) == (2, Fraction(1, 6))


def test_fx_u03_zero_fp_in_12_families_is_degenerate_with_the_zero_event_bound() -> None:
    clusters = [Cluster(f"F{i}", 0, 3) for i in range(12)]
    iv = cluster_bootstrap(clusters, seed=3)
    assert (iv.lo, iv.hi, iv.status) == (0.0, 0.0, "degenerate")
    fb = family_level_bound([(f"F{i}", False) for i in range(12)])
    assert fb.bound is not None
    assert (round(fb.bound * 1000),) == (221,)
    assert fb.kind == "one-sided 95% zero-event bound (equal sizes)"


def test_ratio_is_none_on_a_zero_denominator_and_exact_otherwise() -> None:
    assert ratio([]) is None
    assert ratio([Cluster("F1", 0, 0)]) is None
    assert ratio([Cluster("F1", Fraction(7, 8), 1), Cluster("F2", Fraction(1, 2), 1)]) == Fraction(11, 16)


# ---------------------------------------------------------------- family-level bound (FX-U01, M21)


def test_fx_u01_the_bound_uses_complete_families_and_the_retained_value_is_a_statistic() -> None:
    complete = [(f"F{i}", False) for i in range(54)]
    assert family_level_bound(complete).bound == zero_event_upper_bound(54)
    retained = unequal_family_statistic(complete + [(f"G{i}", False) for i in range(6)])
    assert retained.kind.startswith("family-level statistic")
    p_family, fpr = unequal_size_counterexample()
    assert (round(p_family * 10000), round(fpr * 10000)) == (487, 522)
    assert trial_fpr([3, 3], [3] * 54 + [1] * 6) == Fraction(6, 168)


@pytest.mark.parametrize(
    ("x", "n", "upper"),  # pinned from scipy.stats.beta.ppf(0.95, x + 1, n - x), the statsmodels 'beta' upper end
    [
        (1, 10, 0.39416330243650466),
        (3, 54, 0.13737411779098135),
        (2, 5, 0.8107446225622291),
        (1, 60, 0.07663999493450441),
        (5, 5, 1.0),
    ],
)
def test_clopper_pearson_upper_matches_the_beta_quantile(x: int, n: int, upper: float) -> None:
    assert clopper_pearson_upper(x, n) == pytest.approx(upper, abs=1e-12)


def test_family_bound_with_failures_and_without_families() -> None:
    fb = family_level_bound([("F1", True)] + [(f"F{i}", False) for i in range(2, 11)])
    assert (fb.n, fb.failed, fb.kind) == (10, 1, "one-sided 95% family failure bound (family-level statistic)")
    assert fb.bound == pytest.approx(0.39416330243650466, abs=1e-12)
    assert family_level_bound([]).bound is None
    with pytest.raises(ValueError, match="0 <= x <= n"):
        clopper_pearson_upper(3, 2)


def test_zero_event_bound_equals_clopper_pearson_at_zero() -> None:
    for n in (5, 12, 15):
        assert clopper_pearson_upper(0, n) == pytest.approx(zero_event_upper_bound(n), abs=1e-12)


# ---------------------------------------------------------------- paired differences (5.1)


def test_paired_difference_uses_common_families_only() -> None:
    a = {"F1": Cluster("F1", 3, 3), "F2": Cluster("F2", 2, 3), "F3": Cluster("F3", 3, 3)}
    b = {"F1": Cluster("F1", 1, 3), "F2": Cluster("F2", 2, 3), "F9": Cluster("F9", 0, 3)}
    point, iv = paired_difference(a, b, seed=5, b=2000)
    assert point == Fraction(5, 6) - Fraction(3, 6)
    assert (iv.pool,) == (2,)
    assert iv.lo is not None
    assert iv.hi is not None
    assert iv.lo <= float(point) <= iv.hi
    assert paired_difference(a, {"F9": Cluster("F9", 0, 3)}, seed=5)[0] is None


def test_paired_difference_keeps_a_family_only_one_candidate_can_score() -> None:
    a = {"F1": Cluster("F1", 1, 1), "F2": Cluster("F2", 0, 0)}
    b = {"F1": Cluster("F1", 0, 1), "F2": Cluster("F2", 2, 2)}
    point, iv = paired_difference(a, b, seed=2, b=500)
    assert point == 1 - Fraction(2, 3)
    assert iv.pool == len(a)


def test_paired_difference_with_every_draw_undefined_has_no_interval() -> None:
    """A scores only in F1 and B only in F2: a draw of F1 alone or F2 alone leaves one metric undefined."""
    a = {"F1": Cluster("F1", 1, 1), "F2": Cluster("F2", 0, 0)}
    b = {"F1": Cluster("F1", 0, 0), "F2": Cluster("F2", 1, 2)}
    seed = next(s for s in range(100) if len(set(np.random.default_rng(s).integers(0, 2, size=2))) == 1)
    point, iv = paired_difference(a, b, seed=seed, b=1)
    assert point == Fraction(1, 2)
    assert (iv.lo, iv.hi, iv.status) == (None, None, "undefined")


def test_the_bootstrap_does_not_depend_on_the_order_rows_arrive_in() -> None:
    clusters = [Cluster(f"F{i:02d}", Fraction(i % 4, 4) + i % 3, 3 + i % 2) for i in range(15)]
    seed = seed_for("b" * 64, "M09", "A1", "I")
    assert cluster_bootstrap(clusters, seed) == cluster_bootstrap(list(reversed(clusters)), seed)
