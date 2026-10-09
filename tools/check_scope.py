"""Effective-scope gate (S5 11.1 `scope-coverage`): the tests and coverage cover what they claim to.

  python -m tools.check_scope coverage .gates/coverage.json   # every measured Python file is in the report
  python -m tools.check_scope vitest   .gates/vitest.json     # every web test file ran; none skipped or todo

A module that is never imported, or a test file the runner never collected (for example a `.spec.ts`
the config does not include), would otherwise pass unnoticed.
"""

import argparse
import json
import sys
from pathlib import Path

from tools import proc

PY_SCOPE = ("packages/", "services/", "tools/", "scripts/")
PY_EXEMPT = ("tools/tests/", "tools/envs/")
WEB_TEST_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")


def python_required(files: list[str]) -> set[str]:
    """Measured Python: package sources, gate tools and scripts; not tests, not vendored envs."""
    return {
        f
        for f in files
        if f.endswith(".py") and f.startswith(PY_SCOPE) and not f.startswith(PY_EXEMPT) and "/tests/" not in f
    }


def web_tests_required(files: list[str]) -> set[str]:
    return {f for f in files if f.startswith("web/src/") and f.endswith(WEB_TEST_SUFFIXES)}


def missing(required: set[str], reported: set[str], tool: str) -> list[str]:
    return [
        f"{path}: not covered by {tool} (excluded by config or never discovered)"
        for path in sorted(required - reported)
    ]


def coverage_errors(report_text: str, root: Path, files: list[str]) -> list[str]:
    """Files in a coverage.py JSON report (repo-relative with ``relative_files = true``)."""
    reported = {str((root / name).resolve().relative_to(root.resolve())) for name in json.loads(report_text)["files"]}
    required = python_required(files)
    if not required:
        return ["coverage: no Python source files found to require; refusing to pass"]
    return missing(required, reported, "coverage")


def vitest_errors(report_text: str, root: Path, files: list[str]) -> list[str]:
    report = json.loads(report_text)
    errors: list[str] = []
    if not report.get("numTotalTests"):
        errors.append("vitest ran no tests")
    for key in ("numPendingTests", "numTodoTests", "numPendingTestSuites"):
        if report.get(key):
            errors.append(f"vitest {key} = {report[key]}: skipped or todo tests are not allowed")
    ran: set[str] = set()
    for suite in report.get("testResults", []):
        name = Path(suite.get("name", ""))
        if name.is_absolute():
            ran.add(str(name.resolve().relative_to(root.resolve())))
        errors.extend(
            f"vitest test {test.get('fullName')!r} status {test.get('status')!r}"
            for test in suite.get("assertionResults", [])
            if test.get("status") != "passed"
        )
    errors.extend(missing(web_tests_required(files), ran, "vitest"))
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tool", choices=["coverage", "vitest"])
    parser.add_argument("report", type=Path)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    root: Path = args.root
    try:
        text = args.report.read_text()
        files = proc.repo_files(root)
        errors = coverage_errors(text, root, files) if args.tool == "coverage" else vitest_errors(text, root, files)
    except (OSError, LookupError, ValueError, KeyError) as exc:
        sys.stderr.write(f"scope: FAIL: {args.tool}: {exc}\n")
        return 1
    for error in errors:
        sys.stderr.write(f"scope: FAIL: {error}\n")
    if errors:
        return 1
    sys.stdout.write(f"scope: OK ({args.tool})\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
