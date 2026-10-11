"""Calibration protocol statistics (S3 7): quadratic-weighted kappa, Cohen's kappa, Gwet's AC1/AC2, the
calibration report (7.4-7.5) and the strata sampler (7.2, AC-S3-7.4).

Exact `Fraction` arithmetic throughout (S3 1.4; FX-C01's pinned values are exact rationals): no float rounding
can turn a 0.599999... into a passing 0.60. Reimplemented directly from the spec's own ~15-line formulas
(irrCAC is an R package, cross-checked once on FX-C01, S3 7.4) rather than adding a new dependency -- the same
choice `arena_core.scoring.fairness` made for its own statistics.
"""

from __future__ import annotations

import math
from collections.abc import Hashable, Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction

import numpy as np

UNINFORMATIVE = "not met: uninformative sample"
NOT_MET = "not met: calibration not met"
MET = "met"

# S3 7.4's predeclared thresholds: ordinal (EVL-7, quadratic weights) and nominal/binary (EVL-8, fidelity,
# flag support, identity weights) share the same numeric bar.
QWK_THRESHOLD = Fraction(3, 5)  # kappa >= 0.60
AC2_THRESHOLD = Fraction(7, 10)  # AC2 >= 0.70
KAPPA_THRESHOLD = QWK_THRESHOLD
AC1_THRESHOLD = AC2_THRESHOLD


def _confusion[R: Hashable](proxy: Sequence[R], consensus: Sequence[R], labels: Sequence[R]) -> list[list[int]]:
    if len(proxy) != len(consensus):
        msg = "proxy and consensus must rate the same items"
        raise ValueError(msg)
    index = {v: i for i, v in enumerate(labels)}
    k = len(labels)
    table = [[0] * k for _ in range(k)]
    for p, c in zip(proxy, consensus, strict=True):
        table[index[p]][index[c]] += 1
    return table


def weighted_kappa[R: Hashable](
    proxy: Sequence[R], consensus: Sequence[R], labels: Sequence[R], *, weights: str
) -> Fraction | None:
    """Cohen's weighted kappa (`weights` "quadratic" for EVL-7's QWK, "identity" for EVL-8's nominal kappa):
    `kappa = 1 - sum(w * observed) / sum(w * expected)`, `w(i, j) = (i - j)^2 / (k - 1)^2` (quadratic) or
    `1` off-diagonal, `0` on it (identity). `None` ("uninformative sample") when expected disagreement is
    zero -- never 1.0 (S3 7.4): a constant rating from one or both raters leaves nothing to disagree on, so
    perfect-looking agreement has not been tested."""
    n = len(proxy)
    if n == 0:
        return None
    table = _confusion(proxy, consensus, labels)
    k = len(labels)
    row = [sum(table[i]) for i in range(k)]
    col = [sum(table[i][j] for i in range(k)) for j in range(k)]

    def w(i: int, j: int) -> Fraction:
        if weights == "quadratic":
            return Fraction((i - j) ** 2, (k - 1) ** 2) if k > 1 else Fraction(0)
        return Fraction(0) if i == j else Fraction(1)

    observed = sum(w(i, j) * table[i][j] for i in range(k) for j in range(k))
    expected = sum(w(i, j) * Fraction(row[i] * col[j], n) for i in range(k) for j in range(k))
    if expected == 0:
        return None
    return 1 - Fraction(observed, 1) / expected


def gwet_ac[R: Hashable](
    proxy: Sequence[R], consensus: Sequence[R], labels: Sequence[R], *, weights: str
) -> Fraction | None:
    """Gwet's AC2 (`weights` "quadratic", agreement weight `w(k, l) = 1 - (k - l)^2 / (q - 1)^2`) or AC1
    (`weights` "identity", `w(k, l) = 1` iff `k == l`): `pa = mean(w(proxy_i, consensus_i))`;
    `pi_k = (count_proxy(k) + count_consensus(k)) / (2n)`; `pe = sum_kl(w(k, l)) / (q (q - 1)) * sum_k(pi_k
    (1 - pi_k))`; `AC = (pa - pe) / (1 - pe)` (S3 7.4). `None` when `pe == 1` (every item the same category
    both ways over all `q`: nothing left for chance to explain, so the ratio is undefined)."""
    n = len(proxy)
    if n == 0 or len(proxy) != len(consensus):
        return None
    q = len(labels)
    index = {v: i for i, v in enumerate(labels)}

    def w(a: int, b: int) -> Fraction:
        if weights == "quadratic":
            return 1 - Fraction((a - b) ** 2, (q - 1) ** 2) if q > 1 else Fraction(1)
        return Fraction(1) if a == b else Fraction(0)

    pa = Fraction(sum(w(index[p], index[c]) for p, c in zip(proxy, consensus, strict=True)), 1) / n
    count_proxy = [sum(1 for x in proxy if index[x] == k) for k in range(q)]
    count_consensus = [sum(1 for x in consensus if index[x] == k) for k in range(q)]
    pi = [Fraction(count_proxy[k] + count_consensus[k], 2 * n) for k in range(q)]
    sum_w = sum(w(a, b) for a in range(q) for b in range(q))
    if q <= 1:
        return None
    pe = Fraction(sum_w, q * (q - 1)) * sum(p * (1 - p) for p in pi)
    if pe == 1:
        return None
    return (pa - pe) / (1 - pe)


@dataclass(frozen=True)
class AgreementResult:
    """One instrument or dimension's proxy-vs-consensus agreement (S3 7.4): both coefficients against their
    own predeclared threshold. `status` is never "met" on a coefficient the sample could not produce."""

    kappa: Fraction | None
    ac: Fraction | None
    kappa_threshold: Fraction
    ac_threshold: Fraction

    @property
    def met(self) -> bool:
        if self.kappa is None or self.ac is None:
            return False
        return self.kappa >= self.kappa_threshold and self.ac >= self.ac_threshold

    @property
    def status(self) -> str:
        if self.kappa is None or self.ac is None:
            return UNINFORMATIVE
        return MET if self.met else NOT_MET


def agreement[R: Hashable](
    proxy: Sequence[R], consensus: Sequence[R], labels: Sequence[R], *, weights: str
) -> AgreementResult:
    """`weights` "quadratic" (EVL-7, QWK + AC2) or "identity" (EVL-8, fidelity, flag support: kappa + AC1);
    both share S3 7.4's 0.60 / 0.70 thresholds."""
    kappa = weighted_kappa(proxy, consensus, labels, weights=weights)
    ac = gwet_ac(proxy, consensus, labels, weights=weights)
    threshold = (QWK_THRESHOLD, AC2_THRESHOLD) if weights == "quadratic" else (KAPPA_THRESHOLD, AC1_THRESHOLD)
    return AgreementResult(kappa, ac, *threshold)


@dataclass(frozen=True)
class CalibrationReport:
    """S3 7.5: every dimension or label set of every instrument, keyed by its own name (for EVL-7, "D1".."D5";
    for EVL-8, "labels" and "eva"; "fidelity"; "flag_support"). `required` names every one calibration must
    cover for this run; AC-S3-7.3: never "met" while any required item misses either threshold OR is simply
    absent from `items` -- a dimension never run is exactly as uncalibrated as one that ran and failed, so an
    `items` map that merely omits the rest can never read as "met" by being silently incomplete."""

    items: Mapping[str, AgreementResult]
    required: frozenset[str]

    @property
    def met(self) -> bool:
        return self.required <= self.items.keys() and all(self.items[name].met for name in self.required)

    @property
    def status(self) -> str:
        return MET if self.met else "provisional: calibration not met"

    def failing(self) -> tuple[str, ...]:
        missing = self.required - self.items.keys()
        failed = {name for name in self.required if name in self.items and not self.items[name].met}
        return tuple(sorted(missing | failed))


# ---------------------------------------------------------------- 7.2 strata sampler (AC-S3-7.4)


@dataclass(frozen=True, kw_only=True)
class TurnStratum:
    """One subject turn's calibration-sampling metadata (S3 7.2). Deliberately carries no R1 label, no R2
    verdict and no proxy output of any kind: the sampler cannot read what this type has no field for, which
    is AC-S3-7.4 proved by construction rather than by a runtime check."""

    turn_ref: str
    tag_proposal: str | None  # the subject's own tag proposal (independent of R1); None: no proposal
    quality_level: str  # C-LAB's style level, or C-RUB's weak/medium/strong question script
    role: str
    noncompliant: bool  # a guard hit or a tag-proposal mismatch flagged at authoring time, never an R1 verdict


def sample_strata(
    items: Sequence[TurnStratum],
    *,
    seed: int,
    target_per_stratum: int,
    min_noncompliant_fraction: Fraction = Fraction(0),
) -> list[TurnStratum]:
    """Stratified sampling by `tag_proposal` (S3 7.2's C-LAB rule; the same function serves C-RUB and C-QQ's
    strata by quality level when the caller groups by that field instead): up to `target_per_stratum` per
    stratum, seeded, with at least `min_noncompliant_fraction` of the sample non-compliant where the pool
    allows it. Reads only `TurnStratum` fields -- AC-S3-7.4.

    Known gap (not fixed this round): a caller wanting BOTH `tag_proposal` and `quality_level`/`role`
    jointly stratified has to call this once per quality level/role itself and merge the results -- one
    call here only ever stratifies by one field (`tag_proposal`, or whatever the caller pre-grouped by). No
    production caller exists yet to say which S3 7.2 actually needs.
    """
    rng = np.random.default_rng(seed)
    by_stratum: dict[str | None, list[TurnStratum]] = {}
    for item in items:
        by_stratum.setdefault(item.tag_proposal, []).append(item)
    chosen: list[TurnStratum] = []
    for stratum in sorted(by_stratum, key=lambda s: (s is None, s)):
        pool = list(by_stratum[stratum])
        rng.shuffle(pool)
        noncompliant = [i for i in pool if i.noncompliant]
        compliant = [i for i in pool if not i.noncompliant]
        # Ceiling, not nearest-or-even `round()`: "at least `min_noncompliant_fraction`" must never under-
        # shoot its own floor just because the exact target lands on a round-to-even half (target=5,
        # fraction=1/10 -> 0.5, which `round()` gives as 0, not 1, even though one is available and owed).
        want = math.ceil(Fraction(target_per_stratum) * min_noncompliant_fraction)
        want_noncompliant = min(len(noncompliant), want)
        picked = noncompliant[:want_noncompliant]
        remaining = [*noncompliant[want_noncompliant:], *compliant]
        rng.shuffle(remaining)
        picked += remaining[: max(0, target_per_stratum - len(picked))]
        chosen.extend(picked)
    return chosen
