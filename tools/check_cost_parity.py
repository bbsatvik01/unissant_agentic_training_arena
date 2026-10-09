"""Cost-parity gate stub (S5 3.6, 4.9; WP-01 scope only).

The full gate (WP-05) asserts that every `ops.call_limits` / `ops.model_prices` row the database
enforces equals `cost_model.LIMITS` / `cost_model.LIABILITY_PRICES`, and that the ceilings the operator
applied with `scripts/budget_plan.py` equal `cost_model.budget_plan()` (D-012). None of that database
or ceiling state exists yet in WP-01, so this stub checks the one precondition everything later depends
on: `docs/research/synthesis/cost_model.py --plan-json` runs and prints parseable JSON. A cost_model.py
that no longer runs as a script, or whose --plan-json output breaks, fails closed here instead of
surfacing as a confusing failure once WP-05 builds the real parity check on top of it.
"""

import argparse
import json
import sys
from pathlib import Path

from tools import proc

COST_MODEL_PATH = "docs/research/synthesis/cost_model.py"


class CostParityError(ValueError):
    """cost_model.py --plan-json did not run, or did not print parseable JSON."""


def parse_plan_json(stdout: str) -> dict[str, object]:
    """The parsed ``--plan-json`` payload, or raise CostParityError."""
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError as exc:
        msg = f"cost_model.py --plan-json did not print valid JSON: {exc}"
        raise CostParityError(msg) from exc
    if not isinstance(parsed, dict) or not parsed:
        msg = f"cost_model.py --plan-json printed {parsed!r}, expected a non-empty JSON object"
        raise CostParityError(msg)
    return parsed


def run_plan_json(root: Path) -> str:
    """Invoke cost_model.py the way the spec documents it: ``python3 -I -B ... --plan-json``."""
    cost_model = root / COST_MODEL_PATH
    if not cost_model.is_file():
        msg = f"{COST_MODEL_PATH} is missing"
        raise CostParityError(msg)
    result = proc.run("python", ["-I", "-B", str(cost_model), "--plan-json"], cwd=root)
    if result.returncode != 0:
        msg = f"cost_model.py --plan-json exited {result.returncode}: {result.stderr.strip()}"
        raise CostParityError(msg)
    return result.stdout


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    try:
        parse_plan_json(run_plan_json(args.root))
    except CostParityError as exc:
        sys.stderr.write(f"cost-parity: FAIL: {exc}\n")
        return 1
    sys.stdout.write("cost-parity: OK (cost_model.py --plan-json parses; full ceiling parity is WP-05)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
