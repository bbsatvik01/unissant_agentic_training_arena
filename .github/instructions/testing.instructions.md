---
applyTo: "**/tests/**"
description: "How this repo tests: pytest, 90% branch coverage floor, warnings are errors, no skips, gateproof tests for every gate."
---

# Testing

- pytest only. Warnings are errors (`-W error`); `--strict-markers`, `--strict-config`.
- Coverage: branch coverage, `--cov-fail-under=90` passed on the command line in the Makefile (`COVERAGE_MIN`), mirrored in `pyproject.toml`; `tools/check_ratchet.py` fails on drift or loosening.
- No `skip`, `skipif`, `xfail`, `importorskip`. `tools/pytest_guard.py` fails the run if one executes; `tools/check_no_rigging.py` fails on the static marker.
- Write the failing test first, run it, then the minimal implementation.
- Every gate has a gateproof test (`@pytest.mark.gateproof`) that seeds the defect the gate exists for and asserts the gate fails.
- Boot-check tests run the role as a real process (`python -m arena_<role>`) with a scrubbed environment.
- Tests use synthetic data only; no network, no GCP.
