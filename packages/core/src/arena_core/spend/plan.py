"""Apply and check the budget plan (S5 4.4; D-012, D-013): the logic behind `scripts/budget_plan.py`.

The plan is whatever `python3 -I -B docs/research/synthesis/cost_model.py --plan-json` prints (`{"global": {"parent":
null, "ceiling_usd": ...}}`). This module imports nothing from the cost model and computes no figure: the loader it is
given (`scripts/budget_plan.py` passes the cost-parity gate's own `run_plan_json` and `parse_plan_json`, so the gate and
the apply step read the plan one way) runs the script in isolation and parses its output with `Decimal`; then

- `--apply --dsn-env ARENA_OWNER_DSN`: applies every entry with `ops.set_bucket_ceiling` (owner only, S4 6.3) in ONE
  transaction; S4 refuses a ceiling below current liability, and then nothing is applied and the exit code is 1;
- `--check --dsn-env <any role's DSN>`: reads `ops.v_budget_status` and exits 0 only when the bucket table (names,
  parents, ceilings) equals the plan exactly; 1 on any difference, a one-cent one included.

The DSN is read from the named environment variable only (never argv), so the owner credential stays in the
operator's shell for that one command (S5 10.2).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import Any

import psycopg

from arena_core.db import calls
from arena_core.db.pool import dsn_connector

PLAN_NOTE = "applied by scripts/budget_plan.py from cost_model.py --plan-json (D-012)"

Plan = dict[str, tuple[str | None, Decimal]]


PlanLoader = Callable[[], Plan]


async def apply_plan(conn: calls.Conn, plan: Plan) -> None:
    """Every entry in one transaction: a refused entry rolls all of them back."""
    async with conn.transaction():
        for name, (parent, ceiling) in plan.items():
            await calls.set_bucket_ceiling(conn, name=name, parent=parent, ceiling_usd=ceiling, note=PLAN_NOTE)


async def plan_differences(conn: calls.Conn, plan: Plan) -> list[str]:
    """Every difference between `ops.v_budget_status` and the plan (empty: they are equal)."""
    async with conn.transaction():
        cur = await conn.execute("select bucket, parent, ceiling_usd from ops.v_budget_status")
        rows: list[tuple[Any, ...]] = await cur.fetchall()
    applied: Plan = {str(r[0]): (None if r[1] is None else str(r[1]), Decimal(r[2])) for r in rows}
    problems = [f"bucket {name!r} is in the plan but not in the database" for name in sorted(set(plan) - set(applied))]
    problems += [f"bucket {name!r} is in the database but not in the plan" for name in sorted(set(applied) - set(plan))]
    for name in sorted(set(plan) & set(applied)):
        if applied[name][0] != plan[name][0]:
            problems.append(f"bucket {name!r}: parent {applied[name][0]!r}, plan {plan[name][0]!r}")
        if applied[name][1] != plan[name][1]:
            problems.append(f"bucket {name!r}: ceiling {applied[name][1]}, plan {plan[name][1]}")
    return problems


async def _run(mode: str, dsn: str, plan: Plan) -> list[str]:
    async with dsn_connector(dsn)() as conn:
        if mode == "apply":
            await apply_plan(conn, plan)
        return await plan_differences(conn, plan)


def main(load_plan: PlanLoader, argv: list[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="budget_plan.py", description="apply or check the cost model's budget plan")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true", help="apply the plan (owner credential)")
    mode.add_argument("--check", action="store_true", help="exit 0 only if the applied buckets equal the plan")
    parser.add_argument("--dsn-env", required=True, help="name of the environment variable holding the DSN")
    args = parser.parse_args(argv)
    resolved = os.environ if env is None else env
    dsn = resolved.get(args.dsn_env, "")
    if not dsn:
        sys.stderr.write(f"budget_plan: {args.dsn_env} is not set\n")
        return 1
    try:
        plan = load_plan()
        problems = asyncio.run(_run("apply" if args.apply else "check", dsn, plan))
    except (ValueError, psycopg.Error) as exc:
        sys.stderr.write(f"budget_plan: FAIL: {type(exc).__name__}: {exc}\n")
        return 1
    for problem in problems:
        sys.stderr.write(f"budget_plan: {problem}\n")
    if problems:
        return 1
    verb = "applied" if args.apply else "matches"
    sys.stdout.write(f"budget_plan: {verb}: {', '.join(f'{n}={c}' for n, (_, c) in sorted(plan.items()))}\n")
    return 0
