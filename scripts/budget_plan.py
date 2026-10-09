"""Apply or check the budget plan from cost_model.py --plan-json (S5 4.4; D-012). See arena_core.spend.plan.

Run it as a module from the repository root (the only supported form: the plan is read through tools/, which a direct
`python scripts/budget_plan.py` cannot import):

    ARENA_OWNER_DSN=... uv run --locked python -m scripts.budget_plan --apply --dsn-env ARENA_OWNER_DSN
    uv run --locked python -m scripts.budget_plan --check --dsn-env ARENA_PUBLIC_DSN

The plan is read exactly as the cost-parity gate reads it (tools.check_cost_parity: an isolated `python -I -B` run
of the cost model, parsed with Decimal), so the gate and the apply step cannot disagree on the figure.
"""

from pathlib import Path

from arena_core.spend.plan import Plan, main
from tools.check_cost_parity import parse_plan_json, run_plan_json

ROOT = Path(__file__).resolve().parents[1]


def load_plan() -> Plan:
    return parse_plan_json(run_plan_json(ROOT))


if __name__ == "__main__":
    raise SystemExit(main(load_plan))
