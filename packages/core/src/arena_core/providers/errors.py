"""Typed agent-port failures: BudgetRefused, KillSwitchOn, PolicyRefused, ... (S5 3.1).

WP-02 lands `ConfigError`, which `structured.lint_schema` raises; the rest of the hierarchy lands in WP-05
(TechnoMile `providers/errors.py`, T5).
"""


class ProviderError(Exception):
    """Base of every agent-port failure."""


class ConfigError(ProviderError):
    """The port is misconfigured (for example an output schema that is not flat and bounded)."""
