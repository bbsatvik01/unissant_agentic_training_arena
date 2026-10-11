"""scripts/budget_plan.py (S5 4.4, D-012): the operator's entry point reads the plan exactly as the cost-parity gate
does, and refuses to run without a DSN. The apply and check against a real migrated database run in db-test
(packages/core/tests/db/it_spend_guard.py)."""

from decimal import Decimal

from scripts import budget_plan
from tools import proc
from tools.check_cost_parity import parse_plan_json, run_plan_json
from tools.tests.conftest import REPO_ROOT


def test_the_script_loads_the_plan_the_gate_reads() -> None:
    plan = budget_plan.load_plan()
    assert plan == parse_plan_json(run_plan_json(REPO_ROOT))
    assert set(plan) == {"global"}
    parent, ceiling = plan["global"]
    assert parent is None
    assert ceiling > Decimal(0)


def test_the_script_refuses_to_run_without_its_dsn() -> None:
    args = ["-m", "scripts.budget_plan", "--check", "--dsn-env", "ARENA_NO_SUCH_DSN"]
    result = proc.run("python", args, cwd=REPO_ROOT)
    assert result.returncode == 1
    assert "ARENA_NO_SUCH_DSN is not set" in result.stderr
