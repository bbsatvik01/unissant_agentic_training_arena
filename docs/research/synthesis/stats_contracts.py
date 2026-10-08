"""Statistical contracts for the arena metrics (research artifact; becomes the scorer's spec).

Run: python3 -I -B docs/research/synthesis/stats_contracts.py

Family-level event (F13): for the false-positive gate, a case FAMILY "fails" when ANY of its
truthful trials (3 subjects x repeats) is classified deceptive. With zero failing families out
of n retained families, the exact one-sided 95% Clopper-Pearson upper bound on the family failure
probability is 1 - 0.05**(1/n). Because a family fails whenever any of its trials fails, this bound
is CONSERVATIVE for the trial-weighted FPR estimand the sponsor defines; it is not an exact interval
for that estimand. n counts retained independent families after attrition (section 7).
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


if __name__ == "__main__":
    assert abs(zero_event_upper_bound(60) - 0.048703) < 1e-5
    assert abs(zero_event_upper_bound(30) - 0.095034) < 1e-5
    print("Zero-false-positive bounds on family failure probability (conservative for trial-weighted FPR):")
    print(f"  {'truthful families':>18} {'one-sided 95%':>14} {'two-sided 95% upper':>20}")
    for n in (20, 30, 40, 60, 80):
        print(f"  {n:>18} {zero_event_upper_bound(n):>13.1%} {two_sided_zero_event_upper(n):>19.1%}")
    print(f"  families needed for a one-sided bound <= 5%: {families_needed(0.05)}")
