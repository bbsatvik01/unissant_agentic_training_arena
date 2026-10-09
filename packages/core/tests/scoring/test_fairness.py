"""Fairness audit (S3 8): AC-S3-8.1 to 8.4; FX-F01 to FX-F03."""

from __future__ import annotations

from fractions import Fraction

import numpy as np
import pytest

from arena_core.contracts.adapter import verdicts_by_key
from arena_core.contracts.referee import RefereeAssistantReport
from arena_core.scoring.exact import seed_for
from arena_core.scoring.fairness import (
    DemeanorCount,
    OrderTrial,
    PairingTrial,
    RateUnit,
    StyleTrial,
    StyleUnit,
    holm,
    order_permutation_test,
    pairing_permutation_test,
    spearman_rho,
    stratified_rates,
    style_fpr,
    style_permutation_test,
)
from arena_core.scoring.flags import support_counts

from .builders import flag, stored_card, trial, verdict

ALPHA = 0.05
HALF = 9  # FX-F03: correct at positions 1 to 9, wrong at 10 to 18
RHO_WORSENING, RHO_CONTROL = -0.8674, -0.0107
HESITANT = "Um, I, sorry, I was, uh, in Lab B, resetting the alarm."
PLAIN = "I was in Lab B, resetting the alarm."


def _fa3(demeanor: bool) -> DemeanorCount:
    """One content-matched trial's coach flags: three flags on the hesitant rendering citing hesitation (the
    lexicon marks them), or three content-based flags."""
    answers = {1: HESITANT if demeanor else PLAIN, 2: PLAIN, 3: PLAIN}
    basis = "why the answer was hesitant" if demeanor else "the task that required entry"
    cards = [
        stored_card(
            t,
            [flag("possible_evasion", f"t{t:02d}", answers[t], missing_fact=basis)],
            demeanor=(1,) if demeanor else (),
        )
        for t in (1, 2, 3)
    ]
    rep = RefereeAssistantReport(
        schema_version="ref_asst.v2",
        flags=[verdict(f"t{t:02d}.f1") for t in (1, 2, 3)],
        followups=[],
        citations=[],
        subchecks=[],
    )
    s = support_counts(cards, trial(answers), verdicts_by_key(cards, rep))
    return DemeanorCount(flags=s.demeanor_based, findings=0, unique_flags=s.unique)


def test_fx_f01_ac_s3_8_1_negative_control_is_flagged_and_significant() -> None:
    fa3 = _fa3(demeanor=True)
    assert (fa3.flags, fa3.violation, fa3.per_100_flags) == (3, True, Fraction(100))
    units = [
        StyleUnit(f"F{i}-{s}", s, 12 if s == "hesitant" else 0, 12) for i in range(6) for s in ("plain", "hesitant")
    ]
    p = style_permutation_test(units, seed_for("FX-F01", "FA-5b", "A1", "I"))
    assert p is not None
    assert p < ALPHA


def test_fx_f02_ac_s3_8_2_positive_control_is_clean_and_not_significant() -> None:
    fa3 = _fa3(demeanor=False)
    assert (fa3.flags, fa3.violation) == (0, False)
    units = [StyleUnit(f"F{i}-{s}", s, 3, 12) for i in range(6) for s in ("plain", "hesitant")]
    assert style_permutation_test(units, seed_for("FX-F02", "FA-5b", "A1", "I")) == 1.0


def test_fx_f03_ac_s3_8_3_the_two_sided_order_test() -> None:
    seed = seed_for("FX-F03", "FA-5c", "A1", "I")
    worsening = [OrderTrial("B1", p, p <= HALF) for p in range(1, 19)]
    pos = np.arange(1, 19, dtype=float)
    assert round(spearman_rho(pos, np.array([float(t.correct) for t in worsening])), 4) == RHO_WORSENING
    p = order_permutation_test(worsening, seed)
    assert p == 2 / 10001
    assert p < ALPHA / 4  # significant after Holm across four tests
    control = [OrderTrial("B1", i + 1, c == "1") for i, c in enumerate("100110011001100110")]
    assert round(spearman_rho(pos, np.array([float(t.correct) for t in control])), 4) == RHO_CONTROL
    assert order_permutation_test(control, seed) == 1.0


def test_fa_5c_is_undefined_when_nothing_varies() -> None:
    assert order_permutation_test([OrderTrial("B1", p, True) for p in range(1, 5)], seed=1) is None
    assert order_permutation_test([OrderTrial("B1", 1, p % 2 == 0) for p in range(4)], seed=1) is None
    assert order_permutation_test([], seed=1) is None


def test_fa_5d_pairing_effect() -> None:
    biased = [PairingTrial(f"F{f}", v, s, s == "S1") for f in range(8) for v in ("T", "D") for s in ("S1", "S2", "S3")]
    p = pairing_permutation_test(biased, seed=9, b=2000)
    assert p is not None
    assert p < ALPHA
    even = [PairingTrial(f"F{f}", v, s, v == "T") for f in range(4) for v in ("T", "D") for s in ("S1", "S2")]
    assert pairing_permutation_test(even, seed=9, b=500) == 1.0
    assert pairing_permutation_test([PairingTrial("F1", "T", "S1", True)], seed=9) is None


def test_ac_s3_8_4_small_strata_use_the_family_level_bound_and_name_their_sample_size() -> None:
    trials = [StyleTrial(f"F{i}", "plain", False) for i in range(6) for _ in range(3)]
    trials += [StyleTrial(f"G{i}", "hesitant", i == 0) for i in range(3) for _ in range(3)]
    complete = frozenset({"F0", "F1", "F2", "F3", "F4", "F5", "G0", "G1", "G2"})
    strata = {s.level: s for s in style_fpr(trials, complete=complete, seed=1, b=500)}
    plain, hesitant = strata["plain"], strata["hesitant"]
    assert (plain.families, plain.num, plain.den, plain.point) == (6, 0, 18, Fraction(0))
    assert plain.interval is not None
    assert plain.interval.status == "degenerate"  # so the complete-family bound accompanies it (S3 5.1)
    assert plain.bound is not None
    assert (plain.bound.n, plain.bound.failed) == (6, 0)
    assert (hesitant.families, hesitant.num, hesitant.den, hesitant.point) == (3, 3, 9, Fraction(1, 3))
    assert hesitant.interval is None
    assert hesitant.bound is not None
    assert (hesitant.bound.n, hesitant.bound.failed) == (3, 1)


def test_fa_2_and_fa_4_stratified_rates() -> None:
    units = [RateUnit(f"F{i}", "plain", 1, 12) for i in range(5)] + [RateUnit("G1", "hesitant", 6, 12)]
    got = {s.level: s for s in stratified_rates(units, seed=2, b=300)}
    assert (got["plain"].point, got["plain"].families) == (Fraction(5, 60), 5)
    assert got["hesitant"].point == Fraction(1, 2)


def test_fa_5a_style_and_false_positives() -> None:
    units = [StyleUnit(f"F{i}", "hesitant" if i % 2 else "plain", 3 * (i % 2), 3) for i in range(10)]
    p = style_permutation_test(units, seed=4, b=2000)
    assert p is not None
    assert p < ALPHA


def test_holm_step_down() -> None:
    got = holm({"FA-5a": 0.01, "FA-5b": 0.04, "FA-5c": 0.0002, "FA-5d": 0.03})
    adjusted = {k: v[0] for k, v in got.items()}
    assert adjusted == pytest.approx({"FA-5c": 0.0008, "FA-5a": 0.03, "FA-5d": 0.06, "FA-5b": 0.06})
    assert {k: v[1] for k, v in got.items()} == {
        "FA-5c": True,
        "FA-5a": True,
        "FA-5d": False,
        "FA-5b": False,
    }  # adjusted p never decreases down the steps
    assert holm({}) == {}


def test_demeanor_count_with_no_flags() -> None:
    d = DemeanorCount(flags=0, findings=1, unique_flags=0)
    assert (d.per_100_flags, d.violation) == (None, True)


def test_a_degenerate_fa1_interval_carries_the_complete_family_bound() -> None:
    trials = [StyleTrial(f"F{i}", "plain", False) for i in range(6) for _ in range(3)]
    (plain,) = style_fpr(trials, complete=frozenset(f"F{i}" for i in range(6)), seed=1, b=300)
    assert plain.interval is not None
    assert plain.interval.status == "degenerate"
    assert plain.bound is not None
    assert (plain.bound.n, plain.bound.failed) == (6, 0)


def test_small_fa2_fa4_strata_use_the_family_level_bound_instead_of_a_bootstrap() -> None:
    got = {s.level: s for s in stratified_rates([RateUnit("G1", "hesitant", 6, 12)], seed=2, b=300)}
    small = got["hesitant"]
    assert small.interval is None
    assert small.bound is not None
    assert (small.families, small.bound.n, small.bound.failed) == (1, 1, 1)


def test_permutation_tests_are_undefined_without_two_estimable_levels() -> None:
    assert style_permutation_test([], seed=1) is None
    assert style_permutation_test([StyleUnit("F1", "plain", 0, 0), StyleUnit("F2", "hesitant", 0, 0)], seed=1) is None
    assert style_permutation_test([StyleUnit("F1", "plain", 1, 3), StyleUnit("F2", "plain", 0, 3)], seed=1) is None
    got = holm({"FA-5a": None, "FA-5c": 0.0002})
    assert got == {"FA-5a": (None, False), "FA-5c": (pytest.approx(0.0002), True)}
