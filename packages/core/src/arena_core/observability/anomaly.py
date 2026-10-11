"""Coaching-latency and per-block cost anomaly detectors (S5 8.8; lift target: cloudforce C2,
`observability/anomaly_detectors.py:87-131` (``mad_z``, ``severity_for``, the 1.4826 scale, the 3.5 / 2.5
thresholds); MIT, copyright Satvik Balla; docs/ATTRIBUTIONS.md). The product-specific detectors
(cloudforce `:132-585`) are not lifted (S5 2.4): this module keeps only the MAD-z math and builds three
arena detectors on it -- per-candidate card latency per block, per-block settled cost versus the cost
model's expected unit cost, and Live voice spend per session -- each producing templated text (no model
call), for the admin console.

Wiring a HIGH finding on cost to "pause the next unit's admission until the operator acknowledges" (S5 8.8)
is the referee admin console's job, not this module's: this module only classifies and renders the finding.
"""

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

Severity = Literal["HIGH", "MEDIUM"]

# 1.4826 makes MAD an unbiased estimate of the standard deviation under a normal distribution; with this
# scaling z = (x - median) / scaled_mad is comparable to a z-score.
_MAD_SCALE = 1.4826

HIGH_Z = 3.5
MEDIUM_Z = 2.5
MIN_SAMPLES = 3  # fewer than this is insufficient signal (cloudforce C2)


def mad_z(value: float, samples: Sequence[float | None]) -> float | None:
    """The MAD-z of ``value`` against ``samples``.

    ``samples`` may hold ``None`` entries (a sparse real-data pull, e.g. a block with no prior candidate
    latency yet); they are dropped before the statistics run. ``None`` if fewer than ``MIN_SAMPLES`` clean
    values remain (insufficient signal). +-inf for any deviation when the baseline's MAD is exactly 0 (every
    sample identical): a flatline baseline that suddenly moves must still register.
    """
    clean = [s for s in samples if s is not None]
    if len(clean) < MIN_SAMPLES:
        return None
    med = statistics.median(clean)
    abs_dev = [abs(s - med) for s in clean]
    raw_mad = statistics.median(abs_dev)
    if raw_mad == 0:
        if value == med:
            return 0.0
        return math.inf if value > med else -math.inf
    scaled = _MAD_SCALE * raw_mad
    return (value - med) / scaled


def severity_for(z: float | None, *, high: float = HIGH_Z, medium: float = MEDIUM_Z) -> Severity | None:
    """Map a z-score onto a severity; ``None`` when ``z`` is unavailable or below ``medium``."""
    if z is None:
        return None
    if z >= high:
        return "HIGH"
    if z >= medium:
        return "MEDIUM"
    return None


@dataclass(frozen=True)
class Finding:
    """One anomaly card for the admin console (S5 8.8): templated text, no model call."""

    detector: str
    subject: str  # the candidate id, block id or session id the finding is about
    severity: Severity
    z: float
    value: float
    baseline_median: float
    title: str
    body: str


def _finding(detector: str, subject: str, value: float, samples: list[float], text: tuple[str, str]) -> Finding | None:
    z = mad_z(value, samples)
    severity = severity_for(z)
    if severity is None or z is None:
        return None
    title, body = text
    return Finding(detector, subject, severity, z, value, statistics.median(samples), title, body)


def candidate_latency_findings(
    candidate_id: str, block_id: str, latency_ms: float, baseline_ms: list[float]
) -> Finding | None:
    """Per-candidate card latency in one block, MAD-z'd against that candidate's recent blocks (S5 8.8)."""
    if not baseline_ms:
        return None
    title = f"{candidate_id}: card latency anomaly in block {block_id}"
    body = (
        f"{candidate_id}'s card latency in block {block_id} was {latency_ms:.0f} ms, versus a recent "
        f"median of {statistics.median(baseline_ms):.0f} ms."
    )
    return _finding("candidate_latency", candidate_id, latency_ms, baseline_ms, (title, body))


def block_cost_findings(
    block_id: str, settled_usd: float, expected_usd: float, baseline_ratios: list[float]
) -> Finding | None:
    """Per-block settled cost versus the cost model's expected unit cost (``expected_usd``, from
    ``cost_model.py``): MAD-z'd on the settled/expected ratio across recent blocks, not the raw dollar amount,
    so the baseline holds across unit costs that differ by call type. HIGH severity (z >= 3.5) is the signal
    S5 8.8 pauses the next unit's admission on."""
    if not baseline_ratios:
        return None
    ratio = settled_usd / expected_usd if expected_usd else math.inf
    title = f"block {block_id}: settled cost anomaly"
    body = (
        f"block {block_id} settled at ${settled_usd:.4f} against an expected unit cost of "
        f"${expected_usd:.4f} ({ratio:.2f}x), versus a recent median of {statistics.median(baseline_ratios):.2f}x."
    )
    return _finding("block_cost", block_id, ratio, baseline_ratios, (title, body))


def voice_spend_findings(session_id: str, spend_usd: float, baseline_usd: list[float]) -> Finding | None:
    """Live voice spend per session, MAD-z'd against recent sessions (S5 8.8)."""
    if not baseline_usd:
        return None
    title = f"session {session_id}: Live voice spend anomaly"
    body = (
        f"session {session_id} spent ${spend_usd:.4f} on Live voice, versus a recent median of "
        f"${statistics.median(baseline_usd):.4f}."
    )
    return _finding("voice_spend", session_id, spend_usd, baseline_usd, (title, body))
