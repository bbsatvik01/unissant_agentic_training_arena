"""Common statistical machinery (S3 5.1, 5.4) and the port of `docs/research/synthesis/stats_contracts.py`.

The port keeps the script's behavior and makes every gate comparison exact (`Fraction`, S3 1.4): attrition and
rank sensitivity return exact points. Bounds are float64 (they are published, never compared to a gate). The
one-sided Clopper-Pearson upper bound is computed by bisection on the exact binomial CDF, the same quantity
statsmodels' `proportion_confint(x, n, alpha=0.10, method="beta")` returns as its upper end.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from math import comb

import numpy as np

from arena_core.scoring.exact import GATE, B, ci_indices

# ---------------------------------------------------------------- port of stats_contracts.py


def zero_event_upper_bound(n_families: int, alpha: float = 0.05) -> float:
    """Exact one-sided (1 - alpha) Clopper-Pearson upper bound when 0 of n families fail: 1 - alpha^(1/n)."""
    if n_families <= 0:
        msg = "bound undefined without retained families"
        raise ValueError(msg)
    return float(1.0 - alpha ** (1.0 / n_families))


def two_sided_zero_event_upper(n_families: int, alpha: float = 0.05) -> float:
    return zero_event_upper_bound(n_families, alpha / 2)


def families_needed(target: float, alpha: float = 0.05) -> int:
    """Smallest n whose zero-event one-sided bound is at most `target`."""
    n = 1
    while zero_event_upper_bound(n, alpha) > target:
        n += 1
    return n


def trial_fpr(failing_family_sizes: Sequence[int], all_family_sizes: Sequence[int]) -> Fraction:
    return Fraction(sum(failing_family_sizes), sum(all_family_sizes))


def unequal_size_counterexample() -> tuple[float, float]:
    """60 retained families, 54 with 3 truthful trials and 6 with 1: if the bound's share of families fail and all
    are 3-trial families, trial FPR (5.22%) exceeds the family bound (4.87%)."""
    sizes = [3] * 54 + [1] * 6
    p_family = zero_event_upper_bound(60)
    fpr = (p_family * len(sizes) * 3) / sum(sizes)
    return p_family, fpr


@dataclass(frozen=True)
class Attrition:
    point: Fraction | None
    worst: Fraction | None
    best: Fraction | None
    provisional: bool
    status: str  # definitive, provisional, or insufficient


def attrition_sensitivity(fp: int, valid_truthful: int, excluded_truthful: int, gate: Fraction = GATE) -> Attrition:
    """Point FPR on own included trials plus worst (excluded imputed as false positives) and best (as clears);
    provisional when the three fall on different sides of the gate (F14)."""
    if valid_truthful == 0:
        return Attrition(None, None, None, True, "insufficient: no included truthful trials")
    total = valid_truthful + excluded_truthful
    point = Fraction(fp, valid_truthful)
    worst = Fraction(fp + excluded_truthful, total)
    best = Fraction(fp, total)
    provisional = len({point <= gate, worst <= gate, best <= gate}) > 1
    return Attrition(point, worst, best, provisional, "provisional" if provisional else "definitive")


@dataclass(frozen=True)
class RecallRange:
    point: Fraction | None
    worst: Fraction
    best: Fraction
    coverage: Fraction


@dataclass(frozen=True)
class RankSensitivity:
    order: tuple[str, ...]
    rows: Mapping[str, RecallRange]
    provisional: bool
    low_coverage: tuple[str, ...]


def rank_sensitivity(
    cands: Mapping[str, tuple[int, int, int]], min_coverage: Fraction = Fraction(9, 10)
) -> RankSensitivity:
    """Recall rank with deceptive attrition (F14): name -> (detected, included, excluded deceptive). Excluded
    trials are imputed as misses (worst) and detections (best); provisional when a lower-ranked candidate's best
    beats a higher-ranked one's worst, or any own deceptive coverage is below `min_coverage`."""
    rows: dict[str, RecallRange] = {}
    for name, (det, inc, exc) in cands.items():
        total = inc + exc
        if inc == 0:
            rows[name] = RecallRange(None, Fraction(0), Fraction(1), Fraction(0))
            continue
        rows[name] = RecallRange(
            Fraction(det, inc), Fraction(det, total), Fraction(det + exc, total), Fraction(inc, total)
        )

    def point_key(n: str) -> Fraction:
        p = rows[n].point
        return Fraction(-1) if p is None else p

    order = tuple(sorted(rows, key=point_key, reverse=True))
    reversible = any(rows[low].best > rows[high].worst for i, high in enumerate(order) for low in order[i + 1 :])
    low_coverage = tuple(n for n in rows if rows[n].coverage < min_coverage)
    return RankSensitivity(order, rows, reversible or bool(low_coverage), low_coverage)


def planned_denominators(
    n_families: int, assistants: int = 3, subjects: int = 3, repeats: int = 1, exchanges: int = 12
) -> dict[str, int]:
    """Planned per-candidate counts for n hidden families (S3 5.2 table, C-01)."""
    per_role = n_families * subjects * repeats
    trials_per_subject = n_families * 2 * assistants * repeats
    return {
        "interactive_truthful_per_assistant": per_role,
        "interactive_deceptive_per_assistant": per_role,
        "replay_per_role_per_assistant": n_families,
        "interactive_trials_per_subject": trials_per_subject,
        "interactive_subject_turns_per_subject_max": trials_per_subject * exchanges,
        "interactive_blocks": n_families,
        "false_positives_passing_5pct_gate": per_role // 20,
    }


# ---------------------------------------------------------------- clusters and bootstrap, 5.1


@dataclass(frozen=True)
class Cluster:
    """One family's contribution to a ratio-of-sums metric for one candidate and track."""

    family_id: str
    num: int | Fraction  # Fraction only for M09 (sum of trial QQ values)
    den: int


@dataclass(frozen=True)
class Interval:
    lo: float | None
    hi: float | None
    status: str  # ok, degenerate, undefined
    pool: int  # families with den > 0


def ratio(clusters: Sequence[Cluster]) -> Fraction | None:
    """The exact point estimate: sum of numerators over sum of denominators; None (undefined) when it is 0."""
    den = sum(c.den for c in clusters)
    return None if den == 0 else Fraction(sum((Fraction(c.num) for c in clusters), Fraction(0)), den)


def cluster_bootstrap(clusters: Sequence[Cluster], seed: int, b: int = B) -> Interval:
    """Percentile family-cluster bootstrap of a ratio of sums. Only families with den > 0 are resampled, so no
    resample divides by zero; the pool size is published."""
    pool = sorted((c for c in clusters if c.den > 0), key=lambda c: c.family_id)  # row order never matters
    if not pool:
        return Interval(None, None, "undefined", 0)
    rng = np.random.default_rng(seed)
    num = np.array([float(c.num) for c in pool], dtype=float)
    den = np.array([c.den for c in pool], dtype=float)
    idx = rng.integers(0, len(pool), size=(b, len(pool)))
    stats = np.sort(num[idx].sum(axis=1) / den[idx].sum(axis=1))
    lo_i, hi_i = ci_indices(b)
    lo, hi = float(stats[lo_i]), float(stats[hi_i])
    return Interval(lo, hi, "degenerate" if lo == hi else "ok", len(pool))


def paired_difference(
    a: Mapping[str, Cluster], b_: Mapping[str, Cluster], seed: int, b: int = B
) -> tuple[Fraction | None, Interval]:
    """EVL-10 compare: candidates A and B on the cells both included, clustered by family (`a` and `b_` map family
    to that family's common-cell cluster); families are resampled jointly; statistic metric(A) - metric(B). A
    family counts when either candidate has a denominator there; a draw where either metric is undefined is left
    out of the percentiles."""
    fams = sorted(f for f in set(a) & set(b_) if a[f].den > 0 or b_[f].den > 0)
    ra, rb = ratio([a[f] for f in fams]), ratio([b_[f] for f in fams])
    if ra is None or rb is None:
        return None, Interval(None, None, "undefined", len(fams))
    rng = np.random.default_rng(seed)
    na, da = np.array([float(a[f].num) for f in fams]), np.array([float(a[f].den) for f in fams])
    nb, db = np.array([float(b_[f].num) for f in fams]), np.array([float(b_[f].den) for f in fams])
    idx = rng.integers(0, len(fams), size=(b, len(fams)))
    da_s, db_s = da[idx].sum(1), db[idx].sum(1)
    ok = (da_s > 0) & (db_s > 0)
    stats = np.sort(na[idx].sum(1)[ok] / da_s[ok] - nb[idx].sum(1)[ok] / db_s[ok])
    if len(stats) == 0:
        return ra - rb, Interval(None, None, "undefined", len(fams))
    lo_i, hi_i = ci_indices(len(stats))
    lo, hi = float(stats[lo_i]), float(stats[hi_i])
    return ra - rb, Interval(lo, hi, "degenerate" if lo == hi else "ok", len(fams))


# ---------------------------------------------------------------- family-level bound, 5.1, M21


def _binom_cdf(x: int, n: int, p: float) -> float:
    return float(sum(comb(n, k) * p**k * (1 - p) ** (n - k) for k in range(x + 1)))


def _bisect(f: Callable[[float], float], lo: float, hi: float) -> float:
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def clopper_pearson_upper(x: int, n: int, alpha: float = 0.05) -> float:
    """One-sided (1 - alpha) Clopper-Pearson upper bound: the p with P(X <= x | n, p) = alpha (1 when x = n)."""
    if not 0 <= x <= n or n == 0:
        msg = f"need 0 <= x <= n and n > 0, got x={x}, n={n}"
        raise ValueError(msg)
    if x == n:
        return 1.0
    return _bisect(lambda p: _binom_cdf(x, n, p) - alpha, 0.0, 1.0)


@dataclass(frozen=True)
class FamilyBound:
    bound: float | None
    kind: str
    n: int  # families
    failed: int


def family_level_bound(complete_families: Sequence[tuple[str, bool]]) -> FamilyBound:
    """`complete_families`: (family_id, failed) for families where all of the candidate's planned truthful cells
    are included (equal sizes, so the bound also bounds trial-weighted FPR); failed = any false positive. With
    `failed` meaning "any miss" the same function gives the symmetric bound for an all-detected recall."""
    n = len(complete_families)
    x = sum(failed for _, failed in complete_families)
    if n == 0:
        return FamilyBound(None, "undefined: no complete families", 0, 0)
    if x == 0:
        return FamilyBound(zero_event_upper_bound(n), "one-sided 95% zero-event bound (equal sizes)", n, 0)
    return FamilyBound(clopper_pearson_upper(x, n), "one-sided 95% family failure bound (family-level statistic)", n, x)


def unequal_family_statistic(families: Sequence[tuple[str, bool]]) -> FamilyBound:
    """The same bound over retained families of unequal sizes: labeled a family-level statistic, never an FPR
    guarantee (the script's counterexample)."""
    fb = family_level_bound(families)
    return FamilyBound(fb.bound, "family-level statistic (unequal sizes; not an FPR guarantee)", fb.n, fb.failed)


# ---------------------------------------------------------------- eligibility, 5.4, M19


@dataclass(frozen=True)
class Eligibility:
    attrition: Attrition
    eligible: bool
    status: str  # definitive, provisional, isolation_failed, insufficient: ...


def eligibility(fp: int, own_included_truthful: int, own_excluded_truthful: int, isolation_pass: bool) -> Eligibility:
    """FPR point on the candidate's own included truthful trials <= 5% and isolation pass (F14); another
    candidate's exclusions never enter. Attrition sensitivity marks it provisional when an imputation flips it."""
    s = attrition_sensitivity(fp, own_included_truthful, own_excluded_truthful)
    if not isolation_pass:
        return Eligibility(s, False, "isolation_failed")
    if s.point is None:
        return Eligibility(s, False, s.status)
    return Eligibility(s, Fraction(fp, own_included_truthful) <= GATE, s.status)
