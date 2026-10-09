---
applyTo: "**/tests/**"
description: "How this repo tests: pytest, 90% branch coverage floor, warnings are errors, no skips, gateproof tests for every gate."
---

# Testing

- pytest only. Warnings are errors (`-W error`); `--strict-markers`, `--strict-config`, `--import-mode=importlib`.
- Coverage: branch coverage, `--cov-fail-under=90` on the command line (`COVERAGE_MIN` in the Makefile), mirrored in `pyproject.toml`; diff-cover 90% on changed lines; `tools/check_ratchet.py` fails on drift or loosening, and `tools/check_scope.py` fails when a measured file is missing from the report (a package no test imports).
- No `skip`, `skipif`, `xfail`, `importorskip`. `tools/pytest_guard.py` fails the run if one executes; `tools/check_no_rigging.py` fails on the static marker.
- Test directories outside `tools/tests` carry no `__init__.py`: with importlib import mode, two `tests/test_main.py` files in packages named `tests` collapse into one module and one file silently runs the other's tests. `tools/pytest_guard.py` fails the session on such a collision.
- Write the failing test first, run it, then the minimal implementation.
- Every gate has a gateproof test (`@pytest.mark.gateproof`) that seeds the defect the gate exists for and asserts the gate fails.
- Boot-check tests run each role as a real process (`python -m arena_<role>`) with a fully replaced environment, and `main()` in process for coverage.
- Tests use synthetic data only; no GCP, no model calls.
