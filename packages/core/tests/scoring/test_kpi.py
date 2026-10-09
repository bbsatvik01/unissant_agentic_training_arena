"""KPI procedures (S3 6): AC-S3-6.1, 6.2, 6.5, 6.6; FX-K01 to FX-K05."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from fractions import Fraction
from math import ceil, inf
from pathlib import Path

import numpy as np
import pytest

from arena_core.scoring.kpi import (
    LatencyRow,
    evidence_coverage,
    harness_latency,
    key_fact_ids,
    kpi1,
    kpi4,
    kpi4_breakdowns,
    nearest_rank,
)

from .builders import judgment, report, ri

REPO = Path(__file__).resolve().parents[4]
T0 = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
TIMEOUT_SHARE = 0.05
LIMIT_S = 3

# ---------------------------------------------------------------- KPI-1 (FX-K01; AC-S3-6.1)


def test_fx_k01_pre_zero_is_out_of_the_relative_estimand_and_in_the_absolute() -> None:
    pre = {"p1": [0, 0], "p2": [50, 60], "p3": [40, 40]}
    post = {"p1": [30, 40], "p2": [66, 66], "p3": [50, 50]}
    r = kpi1(pre, post, seed=1, b=500)
    # p2: (66 - 55) / 55 = 1/5; p3: (50 - 40) / 40 = 1/4; mean 9/40
    assert r.mean_rel == Fraction(9, 40)
    assert r.excluded_pre_zero == ["p1"]
    assert r.mean_abs == Fraction(35 + 11 + 10, 3)
    assert r.median_rel == Fraction(9, 40)
    assert r.share_ge_20pct == 1
    assert r.ratio_of_means == Fraction(35 + 66 + 50, 3) / Fraction(0 + 55 + 40, 3) - 1
    assert r.met is True
    assert r.ci is not None
    assert r.ci[0] <= float(r.mean_rel) <= r.ci[1]


def test_kpi1_counts_attrition_and_is_not_met_below_20_percent() -> None:
    r = kpi1({"p1": [50], "p2": [50], "p3": []}, {"p1": [55], "p2": [60]}, seed=2, b=200)
    assert r.attrition == ["p3"]
    assert (r.mean_rel, r.met) == (Fraction(3, 20), False)
    assert r.median_rel == Fraction(3, 20)
    empty = kpi1({"p1": [0]}, {"p1": [10]}, seed=2, b=200)
    assert (empty.mean_rel, empty.ci, empty.met, empty.ratio_of_means) == (None, None, False, None)


# ---------------------------------------------------------------- evidence coverage (FX-K05; AC-S3-6.6)


def test_fx_k05_a_fact_unknown_to_the_subject_counts_as_addressed() -> None:
    family = json.loads((REPO / "docs/spec/seed-families/F02.json").read_text(encoding="utf-8"))
    truthful = family["variants"]["truthful"]
    key = key_fact_ids(truthful["evaluator_packet"])
    assert key == ("f:06", "f:09", "f:10", "f:20", "f:22", "f:23")
    assert "f:22" in {u["fact_id"] for u in truthful["private_packet"]["unknown_facts"]}
    r3 = report(
        [
            judgment(1, requested_fact_ids=["f:06"]),
            judgment(2),
            judgment(3, requested_fact_ids=["f:22"], asked_fact_status="unknown"),
            judgment(4, requested_fact_ids=["f:01"]),  # not a key fact
            judgment(5, requested_fact_ids=["f:22", "f:23"]),
        ]
    )
    c = evidence_coverage(r3, key)
    assert (c.addressed, c.key_facts, c.share) == (3, 6, Fraction(1, 2))
    assert c.by_fact["f:22"] == [3, 5]
    with pytest.raises(ValueError, match="at least one key fact"):
        evidence_coverage(r3, ())


# ---------------------------------------------------------------- KPI-4 (FX-K02, FX-K03, FX-K04; AC-S3-6.2, 6.5)


def row(trial: str, n: int, outcome: str, seconds: float | None, population: str = "practice_client") -> LatencyRow:
    ack = None if seconds is None else T0 + timedelta(seconds=seconds)
    return LatencyRow(trial, n, population, outcome, T0, ack)


def test_fx_k02_timeouts_are_misses_and_unacknowledged_cards_are_unmeasured() -> None:
    rows = [row(f"s{i % 10}", i, "delivered", 1.5) for i in range(92)]
    rows += [row("s1", 92, "delivered", 3.2), row("s2", 93, "delivered", 4.0)]
    rows += [row(f"s{i}", 94 + i, "timeout", None) for i in range(4)]
    rows += [row("s3", 98, "delivered", None), row("s4", 99, "delivered", None)]
    rows += [row("h1", 1, "delivered", 9.0, population="harness")]  # another population
    r = kpi4(rows, seed=4, b=500)
    assert (r.share_within_3s, r.met, r.unmeasured, r.provisional) == (Fraction(92, 98), False, 2, False)
    assert (r.p95_s, r.p50_s) == (4, Fraction(3, 2))  # the 94th of 98 sorted: 92 at 1.5 s, then 3.2, then 4.0
    assert r.ci_share is not None
    assert r.ci_share[0] <= 92 / 98 <= r.ci_share[1]


def test_exactly_3_000_seconds_is_within() -> None:
    r = kpi4([row("s1", 1, "delivered", 3.0), row("s1", 2, "delivered", 3.000001)], seed=1, b=100)
    assert r.share_within_3s == Fraction(1, 2)


def test_fx_k04_ac_s3_6_5_unmeasured_timeouts_stay_in_the_population_as_misses() -> None:
    rows = [row(f"s{i % 10}", i, "delivered", 2.0) for i in range(100)]
    rows += [row(f"s{i}", 100 + i, "unmeasured_timeout", None) for i in range(10)]
    r = kpi4(rows, seed=5, b=500)
    assert (r.share_within_3s, r.met, r.unmeasured, r.provisional) == (Fraction(100, 110), False, 10, True)


def test_a_pending_row_inside_its_deadline_is_in_flight_and_left_out() -> None:
    rows = [row("s1", 1, "delivered", 1.0), row("s1", 2, "pending", None), row("s2", 1, "client_invalid", 0.5)]
    r = kpi4(rows, seed=6, b=100)
    assert (r.share_within_3s, r.in_flight, r.measured, r.unmeasured) == (Fraction(1, 2), 1, 2, 0)
    nothing = kpi4([row("s1", 1, "pending", None)], seed=6, b=100)
    assert (nothing.share_within_3s, nothing.p95_s, nothing.met, nothing.ci_share) == (None, None, False, None)


def test_fx_k03_ac_s3_6_2_share_at_least_95_percent_iff_nearest_rank_p95_within_3_s() -> None:
    rng = np.random.default_rng(42)
    for _ in range(300):
        n = ri(rng, 1, 60)
        rows = []
        for i in range(n):
            pick = float(rng.random())
            if pick < TIMEOUT_SHARE:
                rows.append(row("s", i, "timeout", None))
            else:
                rows.append(row("s", i, "delivered", round(float(rng.uniform(0.2, 3.6)), 3)))
        r = kpi4(rows, seed=1, b=10)
        assert r.p95_s is not None
        assert (r.share_within_3s is not None and r.share_within_3s >= Fraction(95, 100)) == (r.p95_s <= LIMIT_S)
        lat = sorted(
            inf if x.client_ack_at is None else (x.client_ack_at - x.subject_commit_at).total_seconds() for x in rows
        )
        assert float(r.p95_s) == lat[ceil(0.95 * len(lat)) - 1]


def test_nearest_rank() -> None:
    values = [Fraction(i) for i in range(1, 21)]
    assert (nearest_rank(values, Fraction(95, 100)), nearest_rank(values, Fraction(1, 2))) == (19, 10)


def test_every_kpi1_estimand_has_a_participant_bootstrap_interval() -> None:
    pre = {"p1": [40], "p2": [50], "p3": [60], "p4": [0]}
    post = {"p1": [50], "p2": [55], "p3": [80], "p4": [20]}
    r = kpi1(pre, post, seed=3, b=500)
    assert set(r.cis) == {"mean_rel", "median_rel", "share_ge_20pct", "mean_abs", "ratio_of_means"}
    for name, point in (("mean_rel", r.mean_rel), ("mean_abs", r.mean_abs), ("ratio_of_means", r.ratio_of_means)):
        ci = r.cis[name]
        assert ci is not None
        assert point is not None
        assert ci[0] <= float(point) <= ci[1], name
    assert r.ci == r.cis["mean_rel"]


def test_with_every_pre_score_zero_the_absolute_estimand_keeps_its_interval() -> None:
    r = kpi1({"p1": [0], "p2": [0]}, {"p1": [10], "p2": [30]}, seed=3, b=300)
    assert (r.mean_rel, r.cis["mean_rel"], r.cis["ratio_of_means"]) == (None, None, None)
    assert r.mean_abs == Fraction(20)
    assert r.cis["mean_abs"] == (10.0, 30.0)


def test_kpi1_with_no_paired_participant_has_no_estimand() -> None:
    r = kpi1({"p1": [40]}, {}, seed=3, b=100)
    assert (r.mean_rel, r.mean_abs, r.attrition) == (None, None, ["p1"])
    assert set(r.cis.values()) == {None}


def test_harness_latency_uses_the_server_validation_time() -> None:
    rows = [
        LatencyRow("h1", 1, "harness", "delivered", T0, None, T0 + timedelta(seconds=2), False),
        LatencyRow("h1", 2, "harness", "delivered", T0, None, T0 + timedelta(seconds=4), False),
        LatencyRow("h2", 1, "harness", "timeout", T0, None, None, False),
        LatencyRow("s1", 1, "practice_client", "delivered", T0, T0 + timedelta(seconds=1), T0, False),
    ]
    r = harness_latency(rows, seed=1, b=100)
    assert (r.share_within_3s, r.measured, r.p50_s) == (Fraction(1, 3), 3, 4)


def test_kpi4_breakdowns_by_cold_start_and_turn_band() -> None:
    rows = [
        LatencyRow("s1", 1, "practice_client", "delivered", T0, T0 + timedelta(seconds=5), None, True),
        LatencyRow("s1", 2, "practice_client", "delivered", T0, T0 + timedelta(seconds=1), None, False),
        LatencyRow("s1", 6, "practice_client", "timeout", T0, None, None, False),
        LatencyRow("s1", 10, "practice_client", "delivered", T0, T0 + timedelta(seconds=2), None, False),
    ]
    b = kpi4_breakdowns(rows)
    assert b["cold"] == (Fraction(0), 1)
    assert b["warm"] == (Fraction(2, 3), 3)
    assert (b["turns 1-4"], b["turns 5-8"], b["turns 9-12"]) == (
        (Fraction(1, 2), 2),
        (Fraction(0), 1),
        (Fraction(1), 1),
    )
