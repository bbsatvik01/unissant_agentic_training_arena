# Investigative AI Training Arena

Text-based training arena where investigators practice interviews with simulated subjects (Gemini agents on Vertex AI) while competing AI assistants coach them. Hidden case facts stay out of every assistant and investigator code path by construction.

## Tech stack
- Python 3.12, uv workspace: `packages/core` (arena_core) and `services/{api,subject,referee,tournament}`
- Gemini on Vertex AI only; Supabase Postgres; Arize Phoenix for traces
- ruff (check + format, line length 120), mypy strict, pytest with branch coverage floor 90, bandit `-ll -ii`

## Common
```sh
make bootstrap   # uv sync --locked
make check       # the full gate; CI runs the same targets
```

## Hard rules
- Never weaken a gate: no `noqa`, `type: ignore`, `nosec`, `pragma: no cover`, skip/xfail, `continue-on-error`, lowered thresholds. Fix the code.
- Role boundaries are enforced by `tools/check_roles.py`.
- Never run arena commands against the `kbg-production` GCP project.
- Serverless scales to zero: never min-instances >= 1 or CPU always-allocated.
- Changing server, worker, rate-limit, timeout or health-check config needs owner approval first.

See [testing](instructions/testing.instructions.md), [gates](instructions/gates.instructions.md), [roles](instructions/roles.instructions.md).
