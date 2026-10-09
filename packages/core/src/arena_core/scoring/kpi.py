"""KPI procedures (S3 6): KPI-1 improvement (M18), evidence coverage (M17), KPI-4 coaching latency (M16)."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from fractions import Fraction
from math import ceil, inf
from typing import Any

import numpy as np

from arena_core.contracts.common import turn_no
from arena_core.contracts.referee import RefereeSubjectReport
from arena_core.scoring.exact import B, ci_indices

KPI1_TARGET = Fraction(1, 5)
KPI4_LIMIT = timedelta(seconds=3)
KPI4_SHARE = Fraction(95, 100)
UNMEASURED_PROVISIONAL = Fraction(5, 100)
MISSES = ("timeout", "repair_failed", "client_invalid", "unmeasured_timeout")

# ---------------------------------------------------------------- KPI-1, 6.1, M18


Ci = tuple[float, float]
KPI1_ESTIMANDS = ("mean_rel", "median_rel", "share_ge_20pct", "mean_abs", "ratio_of_means")


@dataclass(frozen=True)
class Kpi1:
    mean_rel: Fraction | None  # primary: mean of r_i over participants with pre_i > 0
    ci: Ci | None  # the primary estimand's interval (cis["mean_rel"])
    cis: dict[str, Ci | None]  # participant bootstrap of every estimand (S3 6.1)
    excluded_pre_zero: list[str]
    mean_abs: Fraction | None  # mean of a_i = post_i - pre_i, every paired participant
    median_rel: Fraction | None
    share_ge_20pct: Fraction | None
    ratio_of_means: Fraction | None  # mean post / mean pre - 1
    attrition: list[str]  # participants with no scorable session in a phase
    met: bool


def _median(values: Sequence[Fraction]) -> Fraction:
    s = sorted(values)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def _percentiles(stats: np.ndarray) -> Ci | None:
    """The 1.4 percentile interval over the defined resamples (a resample can be undefined, e.g. every resampled
    pre-score zero for the ratio of means); None when none is defined."""
    defined = np.sort(stats[np.isfinite(stats)])
    if len(defined) == 0:
        return None
    lo_i, hi_i = ci_indices(len(defined))
    return float(defined[lo_i]), float(defined[hi_i])


def _kpi1_intervals(
    rel: Mapping[str, Fraction], pre_m: Mapping[str, Fraction], post_m: Mapping[str, Fraction], seed: int, b: int
) -> dict[str, Ci | None]:
    """Participant bootstrap per estimand: the relative estimands resample the participants with pre > 0, the
    absolute and ratio-of-means estimands every paired participant; each estimand has its own seeded stream."""
    out: dict[str, Ci | None] = dict.fromkeys(KPI1_ESTIMANDS)
    rel_ids, ids = sorted(rel), sorted(pre_m)
    if not ids:
        return out
    if rel_ids:
        r = np.array([float(rel[i]) for i in rel_ids])
        hit = np.array([float(rel[i] >= KPI1_TARGET) for i in rel_ids])
        idx = np.random.default_rng([seed, 0]).integers(0, len(rel_ids), size=(b, len(rel_ids)))
        out["mean_rel"] = _percentiles(r[idx].mean(axis=1))
        idx = np.random.default_rng([seed, 1]).integers(0, len(rel_ids), size=(b, len(rel_ids)))
        out["median_rel"] = _percentiles(np.median(r[idx], axis=1))
        idx = np.random.default_rng([seed, 2]).integers(0, len(rel_ids), size=(b, len(rel_ids)))
        out["share_ge_20pct"] = _percentiles(hit[idx].mean(axis=1))
    pre = np.array([float(pre_m[i]) for i in ids])
    post = np.array([float(post_m[i]) for i in ids])
    idx = np.random.default_rng([seed, 3]).integers(0, len(ids), size=(b, len(ids)))
    out["mean_abs"] = _percentiles((post - pre)[idx].mean(axis=1))
    idx = np.random.default_rng([seed, 4]).integers(0, len(ids), size=(b, len(ids)))
    pre_s, post_s = pre[idx].sum(axis=1), post[idx].sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        out["ratio_of_means"] = _percentiles(np.where(pre_s > 0, post_s / pre_s - 1, np.nan))
    return out


def kpi1(pre: Mapping[str, Sequence[int]], post: Mapping[str, Sequence[int]], seed: int, b: int = B) -> Kpi1:
    """`pre`, `post`: participant -> the scores of their scorable test sessions in that phase (an unscorable
    session has no score and is left out; a participant with none in a phase is attrition, SG2-38)."""
    everyone = sorted(set(pre) | set(post))
    ids = [i for i in everyone if pre.get(i) and post.get(i)]
    pre_m = {i: Fraction(sum(pre[i]), len(pre[i])) for i in ids}
    post_m = {i: Fraction(sum(post[i]), len(post[i])) for i in ids}
    rel = {i: (post_m[i] - pre_m[i]) / pre_m[i] for i in ids if pre_m[i] > 0}
    absd = {i: post_m[i] - pre_m[i] for i in ids}
    point = sum(rel.values(), Fraction(0)) / len(rel) if rel else None
    mean_pre = sum(pre_m.values(), Fraction(0)) / len(ids) if ids else None
    mean_post = sum(post_m.values(), Fraction(0)) / len(ids) if ids else None
    cis = _kpi1_intervals(rel, pre_m, post_m, seed, b)
    return Kpi1(
        mean_rel=point,
        ci=cis["mean_rel"],
        cis=cis,
        excluded_pre_zero=[i for i in ids if pre_m[i] == 0],
        mean_abs=sum(absd.values(), Fraction(0)) / len(absd) if absd else None,
        median_rel=_median(list(rel.values())) if rel else None,
        share_ge_20pct=Fraction(sum(v >= KPI1_TARGET for v in rel.values()), len(rel)) if rel else None,
        ratio_of_means=mean_post / mean_pre - 1 if mean_pre and mean_post is not None else None,
        attrition=[i for i in everyone if i not in ids],
        met=point is not None and point >= KPI1_TARGET,
    )


# ---------------------------------------------------------------- evidence coverage, 6.1, M17


def key_fact_ids(evaluator_packet: Mapping[str, Any]) -> tuple[str, ...]:
    """The sorted distinct `target_fact_ids` of the evaluator packet's `rubric.key_questions`."""
    return tuple(sorted({f for q in evaluator_packet["rubric"]["key_questions"] for f in q["target_fact_ids"]}))


@dataclass(frozen=True)
class Coverage:
    addressed: int
    key_facts: int
    share: Fraction
    by_fact: dict[str, list[int]]


def evidence_coverage(r3_subject_report: RefereeSubjectReport, key: tuple[str, ...]) -> Coverage:
    """A key fact is addressed when at least one question asked for it (`requested_fact_ids` over every canonical
    fact, known to the subject or not, SG2-07)."""
    if not key:
        msg = "evidence coverage needs at least one key fact"
        raise ValueError(msg)
    by_fact: dict[str, list[int]] = {f: [] for f in key}
    for t in r3_subject_report.turns:
        for f in t.requested_fact_ids:
            if f in by_fact:
                by_fact[f].append(turn_no(t.turn_id))
    addressed = sum(1 for turns in by_fact.values() if turns)
    return Coverage(addressed, len(key), Fraction(addressed, len(key)), by_fact)


# ---------------------------------------------------------------- KPI-4, 6.4, M16


@dataclass(frozen=True)
class LatencyRow:
    """One row of S4 `ops.v_latency_report` (C-28): `report_outcome` reads `unmeasured_timeout` for a row still
    pending past the 120 s coaching deadline (SG2-23, SG3-30). `card_validated_server_at` is the server segment's
    end (the harness population's end; a diagnostic elsewhere)."""

    trial_id: str
    turn_no: int
    population: str  # practice_client, harness, assessment
    report_outcome: str  # pending, delivered, timeout, repair_failed, client_invalid, unmeasured_timeout
    subject_commit_at: datetime
    client_ack_at: datetime | None
    card_validated_server_at: datetime | None = None
    instance_cold: bool = False


Latency = Fraction | float  # seconds, exact; math.inf for a miss
TURN_BANDS = (("turns 1-4", 1, 4), ("turns 5-8", 5, 8), ("turns 9-12", 9, 12))


@dataclass(frozen=True)
class Kpi4:
    share_within_3s: Fraction | None
    p95_s: Latency | None
    p50_s: Latency | None
    met: bool
    measured: int
    unmeasured: int
    in_flight: int
    provisional: bool
    ci_share: tuple[float, float] | None
    ci_p95: tuple[float, float] | None


def _seconds(delta: timedelta) -> Fraction:
    return Fraction((delta.days * 86_400 + delta.seconds) * 1_000_000 + delta.microseconds, 1_000_000)


def nearest_rank(sorted_values: Sequence[Latency], q: Fraction) -> Latency:
    return sorted_values[ceil(q * len(sorted_values)) - 1]


def _within(x: Latency) -> bool:
    return x <= _seconds(KPI4_LIMIT)


def _client_end(t: LatencyRow) -> datetime | None:
    return t.client_ack_at


def _server_end(t: LatencyRow) -> datetime | None:
    return t.card_validated_server_at


def _measure(
    pop: Sequence[LatencyRow], end: Callable[[LatencyRow], datetime | None]
) -> tuple[list[tuple[LatencyRow, Latency]], int, int]:
    """(measured rows with latency, unmeasured, in flight): misses are infinitely late; a delivered card with no
    end timestamp is unmeasured and left out; a row pending inside its deadline is in flight and left out."""
    measured: list[tuple[LatencyRow, Latency]] = []
    unmeasured = in_flight = 0
    for t in pop:
        stamp = end(t)
        if t.report_outcome == "pending":
            in_flight += 1
        elif t.report_outcome in MISSES:
            measured.append((t, inf))
            unmeasured += t.report_outcome == "unmeasured_timeout"
        elif stamp is None:
            unmeasured += 1
        else:
            measured.append((t, _seconds(stamp - t.subject_commit_at)))
    return measured, unmeasured, in_flight


def _summary(pop: Sequence[LatencyRow], end: Callable[[LatencyRow], datetime | None], seed: int, b: int) -> Kpi4:
    measured, unmeasured, in_flight = _measure(pop, end)
    lat = sorted(x for _, x in measured)
    share = Fraction(sum(_within(x) for x in lat), len(lat)) if lat else None
    ci_share, ci_p95 = session_bootstrap([(t.trial_id, x) for t, x in measured], seed, b)
    return Kpi4(
        share_within_3s=share,
        p95_s=nearest_rank(lat, Fraction(95, 100)) if lat else None,
        p50_s=nearest_rank(lat, Fraction(1, 2)) if lat else None,
        met=share is not None and share >= KPI4_SHARE,
        measured=len(lat),
        unmeasured=unmeasured,
        in_flight=in_flight,
        provisional=unmeasured > UNMEASURED_PROVISIONAL * (len(pop) - in_flight),
        ci_share=ci_share,
        ci_p95=ci_p95,
    )


def kpi4(turns: Iterable[LatencyRow], seed: int, b: int = B) -> Kpi4:
    """KPI-4 (the primary population, practice-client turns): share with latency <= 3.000 s from the subject
    commit to the client's acknowledgement; misses (timeouts, failed repairs, client-invalid cards, unmeasured
    timeouts) count as infinitely late; a delivered card with no acknowledgement is unmeasured and left out."""
    return _summary([t for t in turns if t.population == "practice_client"], _client_end, seed, b)


def harness_latency(turns: Iterable[LatencyRow], seed: int, b: int = B) -> Kpi4:
    """M16 for one candidate's bake-off harness turns (pass that candidate's rows): the server-side client, so the
    end is `card_validated_server_at` (BKO-9); not part of KPI-4."""
    return _summary([t for t in turns if t.population == "harness"], _server_end, seed, b)


def kpi4_breakdowns(turns: Iterable[LatencyRow]) -> dict[str, tuple[Fraction | None, int]]:
    """KPI-4's published breakdowns over the practice-client population: by `instance_cold` and by turn band;
    group -> (share within 3 s, measured turns)."""
    measured, _, _ = _measure([t for t in turns if t.population == "practice_client"], _client_end)
    groups: dict[str, list[Latency]] = {"cold": [], "warm": [], **{name: [] for name, _, _ in TURN_BANDS}}
    for t, x in measured:
        groups["cold" if t.instance_cold else "warm"].append(x)
        for name, lo, hi in TURN_BANDS:
            if lo <= t.turn_no <= hi:
                groups[name].append(x)
    return {k: (Fraction(sum(_within(x) for x in v), len(v)) if v else None, len(v)) for k, v in groups.items()}


def session_bootstrap(
    measured: Sequence[tuple[str, Latency]], seed: int, b: int = B
) -> tuple[tuple[float, float] | None, tuple[float, float] | None]:
    """Session-cluster bootstrap (one session = one training trial) of the share within 3 s and the nearest-rank
    p95: resample sessions with replacement."""
    sessions: dict[str, list[float]] = {}
    for trial, x in measured:
        sessions.setdefault(trial, []).append(float(x))
    if not sessions:
        return None, None
    keys = sorted(sessions)
    rng = np.random.default_rng(seed)
    limit = float(_seconds(KPI4_LIMIT))
    shares, p95s = np.empty(b), np.empty(b)
    for i in range(b):
        picked = rng.integers(0, len(keys), len(keys))
        xs = np.sort(np.concatenate([sessions[keys[j]] for j in picked]))
        shares[i] = float((xs <= limit).sum()) / len(xs)
        p95s[i] = xs[ceil(Fraction(95, 100) * len(xs)) - 1]
    lo_i, hi_i = ci_indices(b)
    s, p = np.sort(shares), np.sort(p95s)
    return (float(s[lo_i]), float(s[hi_i])), (float(p[lo_i]), float(p[hi_i]))
