"""Liability rate table (S5 4.2) and the database's own amount formulas, mirrored for tests and planning only.

Adapted from TechnoMile `bh_core/providers/pricing.py` (`VERTEX_GLOBAL_PRICES`, `cost`; T8, ATTRIBUTIONS.md): the
table is replaced by the D-009 liability rates (`cost_model.LIABILITY_PRICES`, undiscounted, no promotional rate),
and the formulas are S4's (`ops.reserve_model_call` with draft fix 1, `ops.record_usage`), rounded the same way.

Nothing here is sent to the database: `ops.reserve_model_call` computes every reservation from `ops.model_prices` and
`ops.call_limits`, and `ops.record_usage` prices every receipt (S5 4.6: the caller supplies a size, never an amount).
These mirrors let tests assert the database's answer (S2 AT-PORT-2) and let the tournament size a unit's high cost
with the cost model's arithmetic (S5 4.5).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal

from arena_core.spend.limits import ATTEMPTS, LIMITS, CallType, VertexModel

MICRO = Decimal("0.000001")
PER_MILLION = Decimal(1_000_000)


@dataclass(frozen=True)
class Rate:
    text_in: Decimal  # USD per 1M input tokens
    text_out: Decimal  # USD per 1M output tokens, thinking included


# cost_model.LIABILITY_PRICES (verified 2026-10-08); the S4 seed rows equal these (tools/check_cost_parity.py).
LIABILITY_RATES: dict[VertexModel, Rate] = {
    VertexModel.FLASH_LITE_31: Rate(Decimal("0.25"), Decimal("1.50")),
    VertexModel.FLASH_LITE_35: Rate(Decimal("0.30"), Decimal("2.50")),
    VertexModel.FLASH_38: Rate(Decimal("1.50"), Decimal("7.50")),
}


def _ceil_micro_usd(micro_dollar_units: Decimal) -> Decimal:
    """``ceil(x) / 1e6`` as numeric(14, 6): x is in USD per 1M tokens times tokens (micro-dollars)."""
    return (micro_dollar_units.to_integral_value(rounding=ROUND_CEILING) / PER_MILLION).quantize(MICRO)


def model_call_reservation(model: VertexModel, call_type: CallType, input_bytes: int) -> Decimal:
    """What `ops.reserve_model_call` reserves: ATTEMPTS x ceil(input_bytes x in + output limit x out) / 1e6."""
    rate = LIABILITY_RATES[model]
    per_attempt = input_bytes * rate.text_in + LIMITS[call_type].output_tokens * rate.text_out
    return (ATTEMPTS * per_attempt.to_integral_value(rounding=ROUND_CEILING) / PER_MILLION).quantize(MICRO)


def receipt_usd(model: VertexModel, input_tokens: int, output_tokens: int) -> Decimal:
    """What `ops.record_usage` charges for one text attempt (output tokens include thinking)."""
    rate = LIABILITY_RATES[model]
    return _ceil_micro_usd(input_tokens * rate.text_in + output_tokens * rate.text_out)
