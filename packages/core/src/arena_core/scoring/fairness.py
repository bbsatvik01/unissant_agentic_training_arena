"""Fairness audit (S3 8; PRB-3, PRB-4, SCN-3, SCN-11, M24): FA-1 to FA-5d and Holm-Bonferroni.

Every FA-5 statistic is built so that larger means stronger evidence of the effect in either direction (a range,
or `abs(rho)` for FA-5c), so one upper tail serves all four: p = (1 + count(T_perm >= T_obs)) / (1 + B), seeded
per S3 1.4. Fairness results never change role metrics (R4-01).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction

import numpy as np

from arena_core.scoring.exact import B
from arena_core.scoring.stats import Cluster, FamilyBound, Interval, cluster_bootstrap, family_level_bound, ratio

MIN_BOOTSTRAP_FAMILIES = 5
FLOAT_TIE = 1e-12  # FA-5c: float ties of abs(rho) count as hits
MIN_SUBJECTS = 2
MIN_LEVELS = 2

# ---------------------------------------------------------------- FA-1, FA-2, FA-4: stratified rates


@dataclass(frozen=True)
class Stratum:
    """One stratum of a fairness table: its sample sizes and exact point; a family-cluster interval when the
    stratum has at least 5 families, else the exact family-level bound with the counts (AC-S3-8.4). A degenerate
    interval is accompanied by the bound too (S3 5.1)."""

    level: str
    families: int
    num: int
    den: int
    point: Fraction | None
    interval: Interval | None
    bound: FamilyBound | None


def _stratum(
    level: str, fams: Mapping[str, tuple[int, int]], bounded: Sequence[tuple[str, bool]], seed: int, b: int
) -> Stratum:
    """`bounded`: the (family, any event) pairs the family-level bound is computed over."""
    clusters = [Cluster(f, n, d) for f, (n, d) in fams.items()]
    num, den = sum(n for n, _ in fams.values()), sum(d for _, d in fams.values())
    interval = cluster_bootstrap(clusters, seed, b) if len(fams) >= MIN_BOOTSTRAP_FAMILIES else None
    bound = family_level_bound(bounded) if interval is None or interval.status == "degenerate" else None
    return Stratum(level, len(fams), num, den, ratio(clusters), interval, bound)


def _by_family(rows: Iterable[tuple[str, int, int]]) -> dict[str, tuple[int, int]]:
    """Per-family sums; a family with no observation (denominator 0) is not part of the stratum."""
    out: dict[str, tuple[int, int]] = {}
    for f, n, d in rows:
        a, c = out.get(f, (0, 0))
        out[f] = (a + n, c + d)
    return {f: v for f, v in out.items() if v[1] > 0}


@dataclass(frozen=True)
class StyleTrial:
    """One included truthful trial for FA-1 and FA-5a: its family, style level and whether it was a false
    positive (output deceptive)."""

    family_id: str
    style: str
    false_positive: bool


def style_fpr(trials: Sequence[StyleTrial], complete: frozenset[str], seed: int, b: int = B) -> list[Stratum]:
    """FA-1: M02 restricted to each style level. `complete`: families whose planned truthful cells are all
    included, the population of the bound (equal sizes, so it also bounds trial-weighted FPR)."""
    out = []
    for level in sorted({t.style for t in trials}):
        fams = _by_family((t.family_id, int(t.false_positive), 1) for t in trials if t.style == level)
        bounded = [(f, n > 0) for f, (n, _) in fams.items() if f in complete]
        out.append(_stratum(level, fams, bounded, seed, b))
    return out


@dataclass(frozen=True)
class RateUnit:
    """A per-family count for a rate by stratum: FA-2 (unique flags per subject turn) or FA-4 (EVA, stall or
    compliant turns among truthful turns)."""

    family_id: str
    level: str
    num: int
    den: int


def stratified_rates(units: Iterable[RateUnit], seed: int, b: int = B) -> list[Stratum]:
    """FA-2 and FA-4: a family-cluster bootstrap per level; a small or degenerate stratum carries the family-level
    statistic (share of families with any event) with its bound."""
    rows = list(units)
    out = []
    for level in sorted({u.level for u in rows}):
        fams = _by_family((u.family_id, u.num, u.den) for u in rows if u.level == level)
        out.append(_stratum(level, fams, [(f, n > 0) for f, (n, _) in fams.items()], seed, b))
    return out


# ---------------------------------------------------------------- FA-3


@dataclass(frozen=True)
class DemeanorCount:
    """FA-3 per candidate: demeanor-based flags and committed findings failing 5c; any count above 0 is a
    published violation next to the rank."""

    flags: int  # emitted flags marked demeanor_based
    findings: int  # committed findings failing 5c
    emitted_flags: int

    @property
    def per_100_flags(self) -> Fraction | None:
        return Fraction(100 * self.flags, self.emitted_flags) if self.emitted_flags else None

    @property
    def violation(self) -> bool:
        return self.flags + self.findings > 0


# ---------------------------------------------------------------- FA-5a, FA-5b: style permutation


@dataclass(frozen=True)
class StyleUnit:
    """A unit whose style is permuted: a family's variant (family-level style; its trials stay together), with
    the numerator and denominator it contributes (FA-5a: false positives over truthful trials; FA-5b: unique
    flags over subject turns)."""

    unit_id: str
    style: str
    num: int
    den: int


def _rates(units: Sequence[StyleUnit], styles: Sequence[str]) -> list[Fraction]:
    num: dict[str, int] = {}
    den: dict[str, int] = {}
    for u, s in zip(units, styles, strict=True):
        num[s] = num.get(s, 0) + u.num
        den[s] = den.get(s, 0) + u.den
    return [Fraction(num[s], den[s]) for s in den if den[s]]


def _range(units: Sequence[StyleUnit], styles: Sequence[str]) -> Fraction:
    rates = _rates(units, styles)
    return max(rates) - min(rates)


def style_permutation_test(units: Sequence[StyleUnit], seed: int, b: int = B) -> float | None:
    """FA-5a and FA-5b: statistic max minus min rate across style levels; style labels are permuted across units
    (S3 8 reference `style_permutation_test`, in exact rationals). None (undefined, published as such) when fewer
    than two style levels have an estimable rate."""
    ordered = sorted((u for u in units if u.den > 0), key=lambda u: u.unit_id)  # empty units carry no observation
    labels = [u.style for u in ordered]
    if len(_rates(ordered, labels)) < MIN_LEVELS:
        return None
    observed = _range(ordered, labels)
    rng = np.random.default_rng(seed)
    hits = sum(_range(ordered, list(rng.permutation(labels))) >= observed for _ in range(b))
    return (1 + hits) / (1 + b)


# ---------------------------------------------------------------- FA-5c: order effect


@dataclass(frozen=True)
class OrderTrial:
    block_id: str
    position: int
    correct: bool


def _avg_ranks(a: np.ndarray) -> np.ndarray:
    """Average ranks for ties (scipy `rankdata` 'average')."""
    less = (a[:, None] > a[None, :]).sum(axis=1)
    equal = (a[:, None] == a[None, :]).sum(axis=1)
    return np.asarray(less + (equal + 1) / 2, dtype=float)


def spearman_rho(x: np.ndarray, y: np.ndarray) -> float:
    """Spearman's rho with average ranks: the Pearson correlation of the ranks."""
    return float(np.corrcoef(_avg_ranks(x), _avg_ranks(y))[0, 1])


def order_permutation_test(trials: Sequence[OrderTrial], seed: int, b: int = B) -> float | None:
    """FA-5c, two-sided: statistic abs(Spearman rho) between within-block position and correct classification;
    outcomes permuted within each block. None when nothing varies (published as undefined)."""
    blocks: dict[str, list[int]] = {}
    for i, t in enumerate(trials):
        blocks.setdefault(t.block_id, []).append(i)
    pos = np.array([t.position for t in trials], dtype=float)
    y = np.array([float(t.correct) for t in trials])
    if len(trials) == 0 or y.min() == y.max() or pos.min() == pos.max():
        return None
    observed = abs(spearman_rho(pos, y))
    rng = np.random.default_rng(seed)
    hits = 0
    for _ in range(b):
        yp = y.copy()
        for idx in blocks.values():
            yp[idx] = rng.permutation(y[idx])
        hits += abs(spearman_rho(pos, yp)) >= observed - FLOAT_TIE
    return (1 + hits) / (1 + b)


# ---------------------------------------------------------------- FA-5d: pairing effect


@dataclass(frozen=True)
class PairingTrial:
    family_id: str
    variant_id: str
    subject_id: str
    correct: bool


def _subject_range(trials: Sequence[PairingTrial], subjects: Sequence[str]) -> Fraction:
    num: dict[str, int] = {}
    den: dict[str, int] = {}
    for t, s in zip(trials, subjects, strict=True):
        num[s] = num.get(s, 0) + t.correct
        den[s] = den.get(s, 0) + 1
    rates = [Fraction(num[s], den[s]) for s in den]
    return max(rates) - min(rates)


def pairing_permutation_test(trials: Sequence[PairingTrial], seed: int, b: int = B) -> float | None:
    """FA-5d: range of per-subject correct-classification rates for one assistant; subject labels permuted within
    each (family, variant). None without at least two subjects."""
    if len({t.subject_id for t in trials}) < MIN_SUBJECTS:
        return None
    groups: dict[tuple[str, str], list[int]] = {}
    for i, t in enumerate(trials):
        groups.setdefault((t.family_id, t.variant_id), []).append(i)
    subjects = [t.subject_id for t in trials]
    observed = _subject_range(trials, subjects)
    rng = np.random.default_rng(seed)
    hits = 0
    for _ in range(b):
        perm = list(subjects)
        for idx in groups.values():
            for i, s in zip(idx, rng.permutation([subjects[i] for i in idx]), strict=True):
                perm[i] = str(s)
        hits += _subject_range(trials, perm) >= observed
    return (1 + hits) / (1 + b)


# ---------------------------------------------------------------- Holm-Bonferroni


def holm(pvalues: Mapping[str, float | None], alpha: float = 0.05) -> dict[str, tuple[float | None, bool]]:
    """Holm step-down across FA-5a to FA-5d within one candidate and track: name -> (adjusted p, significant).
    An undefined test (None) stays undefined and is not one of the m tests; the raw p-values are published
    beside these."""
    defined = {k: p for k, p in pvalues.items() if p is not None}
    order = sorted(defined, key=lambda k: (defined[k], k))
    m = len(order)
    out: dict[str, tuple[float | None, bool]] = {k: (None, False) for k, p in pvalues.items() if p is None}
    running = 0.0
    still = True
    for i, k in enumerate(order):
        running = max(running, min(1.0, (m - i) * defined[k]))
        still = still and defined[k] <= alpha / (m - i)
        out[k] = (running, still)
    return out
