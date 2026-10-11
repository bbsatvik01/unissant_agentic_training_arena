"""MAD-z anomaly detectors (S5 8.8; lift target: cloudforce C2)."""

from __future__ import annotations

import math

from arena_core.observability import anomaly

BASELINE_MS = [100.0, 102.0, 98.0, 101.0, 99.0, 100.0]


def test_mad_z_none_with_too_few_samples() -> None:
    assert anomaly.mad_z(100.0, [1.0, 2.0]) is None


def test_mad_z_zero_for_a_value_at_the_median() -> None:
    assert anomaly.mad_z(100.0, BASELINE_MS) == 0.0


def test_mad_z_positive_for_a_high_outlier() -> None:
    z = anomaly.mad_z(10_000.0, BASELINE_MS)
    assert z is not None
    assert z > anomaly.HIGH_Z


def test_mad_z_flatline_baseline_returns_infinite_for_any_deviation() -> None:
    flat = [50.0, 50.0, 50.0, 50.0]
    assert anomaly.mad_z(50.0, flat) == 0.0
    assert anomaly.mad_z(51.0, flat) == math.inf
    assert anomaly.mad_z(49.0, flat) == -math.inf


def test_mad_z_ignores_none_entries_in_the_baseline() -> None:
    baseline: list[float | None] = [100.0, None, 99.0, 101.0, None]
    assert anomaly.mad_z(100.0, baseline) == 0.0


def test_severity_for_thresholds() -> None:
    assert anomaly.severity_for(None) is None
    assert anomaly.severity_for(1.0) is None
    assert anomaly.severity_for(anomaly.MEDIUM_Z) == "MEDIUM"
    assert anomaly.severity_for(anomaly.HIGH_Z) == "HIGH"


def test_candidate_latency_findings_high_severity() -> None:
    finding = anomaly.candidate_latency_findings("A1", "blk-1", 10_000.0, BASELINE_MS)
    assert finding is not None
    assert finding.severity == "HIGH"
    assert finding.detector == "candidate_latency"
    assert "A1" in finding.title
    assert "blk-1" in finding.body


def test_candidate_latency_findings_none_within_normal_range() -> None:
    assert anomaly.candidate_latency_findings("A1", "blk-1", 100.0, BASELINE_MS) is None


def test_candidate_latency_findings_none_with_an_empty_baseline() -> None:
    assert anomaly.candidate_latency_findings("A1", "blk-1", 100.0, []) is None


def test_block_cost_findings_uses_the_settled_over_expected_ratio() -> None:
    baseline_ratios = [1.0, 1.02, 0.98, 1.01, 0.99, 1.0]
    finding = anomaly.block_cost_findings("blk-9", settled_usd=50.0, expected_usd=1.0, baseline_ratios=baseline_ratios)
    assert finding is not None
    assert finding.severity == "HIGH"
    assert "blk-9" in finding.title
    assert "$50.0000" in finding.body


def test_block_cost_findings_zero_expected_cost_is_infinite_ratio() -> None:
    baseline_ratios = [1.0, 1.0, 1.0, 1.0]
    finding = anomaly.block_cost_findings("blk-0", settled_usd=0.01, expected_usd=0.0, baseline_ratios=baseline_ratios)
    assert finding is not None
    assert finding.severity == "HIGH"


def test_voice_spend_findings_high_severity() -> None:
    baseline = [3.0, 3.1, 2.9, 3.0, 3.05]
    finding = anomaly.voice_spend_findings("sess-1", 50.0, baseline)
    assert finding is not None
    assert finding.detector == "voice_spend"
    assert finding.severity == "HIGH"


def test_voice_spend_findings_none_when_unremarkable() -> None:
    baseline = [3.0, 3.1, 2.9, 3.0, 3.05]
    assert anomaly.voice_spend_findings("sess-1", 3.0, baseline) is None


def test_block_cost_findings_none_with_an_empty_baseline() -> None:
    assert anomaly.block_cost_findings("blk-1", settled_usd=1.0, expected_usd=1.0, baseline_ratios=[]) is None


def test_voice_spend_findings_none_with_an_empty_baseline() -> None:
    assert anomaly.voice_spend_findings("sess-1", 3.0, []) is None
