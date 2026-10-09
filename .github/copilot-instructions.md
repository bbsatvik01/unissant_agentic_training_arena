# Investigative AI Training Arena

Text-based training arena where investigators practice interviews with simulated subjects (Gemini agents on Vertex AI) while competing AI assistants coach them. Hidden case facts stay out of every assistant and investigator code path by construction.

## Tech stack
- Python 3.12, uv workspace: `packages/core` (arena_core) and `services/{api,subject,referee,tournament}`
- Gemini on Vertex AI only; Supabase Postgres; Arize Phoenix for traces
- Gates (S5 11.1): ruff (check + format, line length 120), mypy strict, pytest with a 90% branch-coverage floor and 90% diff-cover, tools/ gates (no-rigging, silent-except, roles, ratchet, deps-policy, push-clean, scope), bandit `-ll -ii` plus the B105-B107 pass, Semgrep, CodeQL, gitleaks, TruffleHog, pip-audit, osv-scanner, licence gate

## Common
```sh
make bootstrap   # uv envs, pinned security binaries, pre-commit hook
make check       # the full gate; CI runs the same make targets (plus SHA-pinned scanner Actions)
```

## Hard rules
- Never weaken a gate: no `noqa`, `type: ignore`, `nosec`, `nosemgrep`, `gitleaks:allow`, `pragma: no cover`, skip/xfail, `continue-on-error`, lowered thresholds, narrowed scopes. Fix the code.
- Role boundaries are enforced by `tools/check_roles.py`; boot checks by `arena_core.config`.
- Arena commands run against the `cna-guardian` GCP project only (D-015); the boot checks refuse any other, `kbg-production` included.
- Never commit `.env.local*` files or anything under `cases/hidden/`.
- Serverless scales to zero: never min-instances >= 1 or CPU always-allocated.
- Changing server, worker, rate-limit, timeout or health-check config needs owner approval first.

See [testing](instructions/testing.instructions.md), [gates](instructions/gates.instructions.md), [roles](instructions/roles.instructions.md).
