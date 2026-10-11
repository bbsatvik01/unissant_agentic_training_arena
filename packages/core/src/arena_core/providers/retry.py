"""Transient-error backoff, exponential with full jitter (TechnoMile `providers/retry.py` lines 1-21, T2).

ATTRIBUTIONS.md.

Lifted with one change: `max_attempts` defaults to `ATTEMPTS` (4), the total the port enforces across first try,
repair and transient retries (S5 3.4). The port, not this policy, counts every send and stops at 4.
"""

import random
from dataclasses import dataclass

from arena_core.spend.limits import ATTEMPTS


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = ATTEMPTS  # every send of one logical call, whatever its reason
    base_delay_s: float = 0.5
    max_delay_s: float = 8.0

    def __post_init__(self) -> None:
        if not 1 <= self.max_attempts <= ATTEMPTS or self.base_delay_s < 0 or self.max_delay_s < 0:
            msg = f"max_attempts must be in 1..{ATTEMPTS} and delays non-negative"
            raise ValueError(msg)

    def delay_s(self, attempt: int, rng: random.Random) -> float:
        """Sleep before retry number ``attempt`` (1-based): uniform in [0, min(max, base * 2**(attempt-1))]."""
        ceiling = min(self.max_delay_s, self.base_delay_s * 2 ** (attempt - 1))
        return rng.uniform(0.0, ceiling)
