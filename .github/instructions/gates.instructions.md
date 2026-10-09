---
applyTo: "{Makefile,pyproject.toml,conftest.py,.semgrepignore,tools/**,.github/workflows/**}"
description: "The CI and test gates are never softened. A failing gate means fix the code."
---

# Gates

`make check` is the single gate (S5 11.1): `deps-sync` and `tools-sync` (the pinned security binaries, which the gate proofs also use), then `py-check` (ruff check, ruff format --check, mypy strict, no-rigging, silent-except, roles, cost-parity, ratchet, deps-policy, push-clean, pytest `-W error` with the 90% branch-coverage floor, scope-coverage, diff-cover 90%), then `sec-check` (bandit two passes, Semgrep, CodeQL security-extended, gitleaks, TruffleHog, pip-audit `--require-hashes`, osv-scanner, licence gate). CI calls the same make targets for `py-check` and the Python scans; gitleaks, TruffleHog, osv-scanner and CodeQL run in CI through official Actions pinned to full commit SHAs, at the scanner versions `tools/ensure_tools.sh` pins.

- Thresholds live in `tools/gates/ratchet.toml` and only get stricter. Change a threshold in its source file and in the ratchet in the same commit, and only upward.
- What each gate looks at (ruff, mypy, coverage, pytest, bandit, Semgrep and CodeQL scopes) is pinned by `tools/tests/test_gate_scope.py`; narrowing a scope is a visible, reviewed change to that test.
- Suppressions are forbidden: `noqa`, `type: ignore`, `nosec`, `nosemgrep`, `gitleaks:allow` and `.gitleaksignore` entries, `trufflehog:ignore`, `osv-scanner.toml` ignores, `pragma: no cover`, skip/xfail, `continue-on-error`. The only exception is a proven false positive in `tools/gates/suppressions-allowlist.toml`: one file, one marker, the exact line, and a reason. Adding an entry is a gate change and needs its own review.
- Never add `continue-on-error`, remove a `needs:`, lower a timeout floor, or broaden an exclude.
- A new gate ships with a gateproof test (`@pytest.mark.gateproof`) that proves it fails on a seeded defect.
- Lifted files are recorded in `ATTRIBUTIONS.md` (source path, commit, sha256, changes) and pass every gate like new code.
