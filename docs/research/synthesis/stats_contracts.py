"""Statistical contracts for the arena metrics (research artifact; becomes the scorer's spec).

Run: python3 -I -B docs/research/synthesis/stats_contracts.py

Family-level event (F13): a case FAMILY "fails" when ANY of its included truthful trials is
classified deceptive. With zero failing families out of n, the exact one-sided 95% Clopper-Pearson
upper bound on the family failure probability is 1 - 0.05**(1/n).

When every counted family contributes the SAME number of truthful trials, trial-weighted FPR is at most
the family failure probability (a family's false-positive share is at most 1 when it fails, 0 otherwise),
so the bound is conservative for the sponsor's trial-weighted FPR. With UNEQUAL retained family sizes this
guarantee fails (round 3): see unequal_size_counterexample(). The direction therefore applies the bound only
to the complete-family subset (all cells retained) and reports it elsewhere as a family-level statistic.

Attrition (F14): eligibility uses each candidate's OWN valid trials; the attrition-sensitivity rule
recomputes FPR with excluded truthful trials imputed as false positives (worst) and as clears (best), and
marks the eligibility decision provisional when the two disagree.
"""

from __future__ import annotations


def zero_event_upper_bound(n_families: int, alpha: float = 0.05) -> float:
    """Exact one-sided (1 - alpha) Clopper-Pearson upper bound when 0 of n families fail."""
    if n_families <= 0:
        raise ValueError("bound undefined without retained families")
    return 1.0 - alpha ** (1.0 / n_families)


def two_sided_zero_event_upper(n_families: int, alpha: float = 0.05) -> float:
    """Upper end of the exact two-sided (1 - alpha) interval when 0 of n families fail."""
    return zero_event_upper_bound(n_families, alpha / 2)


def families_needed(target: float, alpha: float = 0.05) -> int:
    """Smallest n whose zero-event one-sided bound is <= target."""
    n = 1
    while zero_event_upper_bound(n, alpha) > target:
        n += 1
    return n


def trial_fpr(failing_family_sizes: list[int], all_family_sizes: list[int]) -> float:
    """Trial-weighted FPR when every truthful trial of each failing family is a false positive."""
    return sum(failing_family_sizes) / sum(all_family_sizes)


def unequal_size_counterexample() -> tuple[float, float]:
    """60 retained families: 54 keep 3 truthful trials, 6 keep 1 (93.3% coverage).

    If the expected 4.87% of families that fail (the zero-event bound for n=60) all come from the
    3-trial families, trial-weighted FPR exceeds the family failure probability.
    """
    sizes = [3] * 54 + [1] * 6
    p_family = zero_event_upper_bound(60)
    expected_failing = p_family * len(sizes)
    fpr = (expected_failing * 3) / sum(sizes)
    return p_family, fpr


def attrition_sensitivity(fp: int, valid_truthful: int, excluded_truthful: int, gate: float = 0.05) -> dict:
    """Point FPR on own valid trials plus worst/best imputations of the excluded truthful trials."""
    point = fp / valid_truthful
    worst = (fp + excluded_truthful) / (valid_truthful + excluded_truthful)
    best = fp / (valid_truthful + excluded_truthful)
    decisions = {point <= gate, worst <= gate, best <= gate}
    return {"point": point, "worst": worst, "best": best, "provisional": len(decisions) > 1}


if __name__ == "__main__":
    assert abs(zero_event_upper_bound(60) - 0.048703) < 1e-5
    assert abs(zero_event_upper_bound(30) - 0.095034) < 1e-5
    print("Zero-false-positive bounds on family failure probability (a trial-FPR bound only for equal-size families):")
    print(f"  {'truthful families':>18} {'one-sided 95%':>14} {'two-sided 95% upper':>20}")
    for n in (20, 30, 40, 60, 80):
        print(f"  {n:>18} {zero_event_upper_bound(n):>13.1%} {two_sided_zero_event_upper(n):>19.1%}")
    print(f"  families needed for a one-sided bound <= 5%: {families_needed(0.05)}")

    p_family, fpr = unequal_size_counterexample()
    assert fpr > p_family, "counterexample must show the guarantee failing under unequal sizes"
    print(f"\nUnequal retained sizes (54 families x 3 trials, 6 x 1): family bound {p_family:.2%} "
          f"vs trial FPR {fpr:.2%} -> bound is not a trial-FPR guarantee; use the complete-family subset.")

    # Round-3 reversal example: 9 false positives among 100 own valid truthful trials. Under a common-subset
    # rule another candidate's invalid cells could erase all nine; own-valid eligibility keeps them.
    own = attrition_sensitivity(fp=9, valid_truthful=100, excluded_truthful=0)
    assert own["point"] > 0.05 and not own["provisional"]
    print(f"Own-valid eligibility keeps a 9% FPR visible: {own}")
    edge = attrition_sensitivity(fp=4, valid_truthful=100, excluded_truthful=9)
    assert edge["provisional"]
    print(f"4 FP / 100 valid with 9 excluded truthful trials -> provisional: {edge}")
