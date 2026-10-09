"""Strict verdict on one pgTAP file's psql output (supabase/tests/harness/run_pgtap.sh; S4 sql/TESTS.md section 0).

A file passes only when psql exited 0 and its TAP stream is exactly well formed:

- exactly one plan line ``1..N`` with N >= 1 and no directive (``1..0 # skip`` runs nothing);
- test lines ``ok <n>`` numbered exactly 1..N, in order, each once (pgTAP numbers every test; a duplicate, a gap,
  a test beyond the plan or an unnumbered test line fails);
- no ``not ok``, no SKIP or TODO directive on any test line (global never-rig rule), no ``Bail out!``;
- no psql or server ERROR, FATAL or PANIC line, and no pgTAP "# Looks like ..." summary.

Other lines (psql command tags, values a fixture prints) are ignored, as TAP ignores lines it does not know.

run_pgtap.sh runs this file as a script with an isolated interpreter (``python3 -I -B tools/pgtap_verdict.py
--name <file> --psql-exit <code>``, the output on stdin), so it uses the standard library only.
"""

import argparse
import re
import sys
from dataclasses import dataclass

PLAN = re.compile(r"^1\.\.(\d+)(.*)$")
TEST = re.compile(r"^(not )?ok\b(.*)$")
NUMBER = re.compile(r"^ ([1-9]\d*)(?:[ \t].*)?$")
# Stricter than TAP parsers (no word boundary): "# Skipped", "# todo-later" fail too.
DIRECTIVE = re.compile(r"#\s*(skip|todo)", re.IGNORECASE)
BAIL_OUT = re.compile(r"^Bail out!")
LOOKS_LIKE = re.compile(r"^#\s*Looks like")
ERROR = re.compile(r"^(?:psql:.*:\d+:\s+)?(ERROR|FATAL|PANIC):")
SHOWN = re.compile(r"^(not ok|#|psql:|ERROR|FATAL|PANIC|Bail out!)|#\s*(skip|todo)", re.IGNORECASE)
MAX_SHOWN = 60


@dataclass(frozen=True)
class Verdict:
    planned: int | None
    ran: int
    problems: tuple[str, ...]

    @property
    def passed(self) -> bool:
        return not self.problems


def _test_line(line: str, test: re.Match[str], numbers: list[int]) -> list[str]:
    """Problems of one ``ok``/``not ok`` line; records its test number."""
    problems = [f"failed: {line}"] if test.group(1) else []
    if DIRECTIVE.search(test.group(2)):
        problems.append(f"skip/todo directive: {line}")
    if number := NUMBER.match(test.group(2)):
        numbers.append(int(number.group(1)))
    else:
        problems.append(f"unnumbered test line: {line}")
    return problems


def _line(line: str, plans: list[int], numbers: list[int]) -> list[str]:
    """Problems of one output line; records plans and test numbers as it goes."""
    if plan := PLAN.match(line):
        plans.append(int(plan.group(1)))
        return [f"plan with a directive: {line}"] if plan.group(2).strip() else []
    if test := TEST.match(line):
        return _test_line(line, test, numbers)
    if BAIL_OUT.match(line):
        return [f"bail out: {line}"]
    if LOOKS_LIKE.match(line):
        return [line.lstrip("# ").strip()]
    if ERROR.match(line):
        return [f"error: {line}"]
    return []


def _plan_problem(plans: list[int], numbers: list[int]) -> str | None:
    if len(plans) != 1:
        return f"{len(plans)} plan lines (need exactly one)"
    planned = plans[0]
    if planned == 0:
        return "plan 1..0 runs no test"
    if numbers == list(range(1, planned + 1)):
        return None
    shown = ", ".join(map(str, numbers[:MAX_SHOWN])) + (", ..." if len(numbers) > MAX_SHOWN else "")
    return f"test numbers [{shown}] do not run 1..{planned} once each, in order"


def judge(output: str, psql_exit: int) -> Verdict:
    problems: list[str] = [f"psql exited {psql_exit}"] if psql_exit != 0 else []
    plans: list[int] = []
    numbers: list[int] = []
    for line in output.splitlines():
        problems.extend(_line(line, plans, numbers))
    if problem := _plan_problem(plans, numbers):
        problems.append(problem)
    planned = plans[0] if len(plans) == 1 else None
    return Verdict(planned=planned, ran=len(numbers), problems=tuple(problems))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True, help="the test file, for the report")
    parser.add_argument("--psql-exit", type=int, required=True, help="psql's exit status for that file")
    args = parser.parse_args(argv)
    output = sys.stdin.read()
    verdict = judge(output, args.psql_exit)
    if verdict.passed:
        sys.stdout.write(f"PASS {args.name} ({verdict.ran}/{verdict.planned})\n")
        return 0
    sys.stdout.write(f"FAIL {args.name}: {'; '.join(verdict.problems)}\n")
    shown = [line for line in output.splitlines() if SHOWN.search(line)]
    sys.stdout.writelines(f"  {line}\n" for line in shown[:MAX_SHOWN])
    return 1


if __name__ == "__main__":
    sys.exit(main())
