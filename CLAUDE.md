# Unissant Challenge X: Investigative AI Training Arena

Text-based training arena where investigators practice interviews with simulated subjects (Gemini agents playing truthful or deceptive roles from private profiles) while competing AI assistants coach them turn by turn. A scenario engine locks case facts and scripts evidence releases; an independent scorer compares locked findings with hidden case facts; a bake-off ranks assistant and subject candidates behind false-positive and isolation gates. Problem statement and line-by-line requirements: `docs/challenge/REQUIREMENTS.md`.

## Continuity / Handoff Discipline (MANDATORY for every session)

1. Read `docs/handoff/README.md` FIRST, then STATE -> HISTORY -> DECISIONS -> LESSONS -> PATTERNS -> SUBAGENTS.
2. Rewrite `docs/handoff/STATE.md` at the end of every significant action (dispatch, completion, decision, verdict, milestone, blocker).
3. Append to DECISIONS / LESSONS / HISTORY in the same turn as the event.
4. Enforce `docs/handoff/PATTERNS.md`.
5. Commit handoff updates as `docs(handoff): <change>`.

## Owner constraints

- LLMs: Gemini models via Vertex AI only. No Chinese models, no other providers.
- Reference repos are read-only; lift their patterns, never modify them: TechnoMile (`../TechnoMile Agentic Black Hat`), PangeaChat (`/Users/balla/PangeaChat`, assistant v2 worktree `adapi-av2`), gokbase (`/Users/balla/Desktop/satvik/gokbase-org`), cloudforce (`/Users/balla/Desktop/satvik/Summer Internship/cloudforce/backend`).
- Database: Supabase (owner-provided project). Observability: Arize Phoenix, end to end.
- Hosting: GCP, scale to zero. Never min-instances >= 1 or CPU always-allocated. 1-2 concurrent users.
- Simple, clean architecture that can scale. No over-engineering.
- UI follows the owner-provided DESIGN.md; agent avatars, companion pets, talking agents, visible agent work, virtual interrogation room.
- Synthetic cases only. A simulated score is never a finding about a real person.

## Dev commands

Python 3.12 uv workspace (`packages/core`, `services/{api,subject,referee,tournament}`); the web app lands in WP-18.

- `make bootstrap`: clean-clone setup. `uv sync --locked` for the workspace and the isolated Semgrep env (`tools/envs/semgrep`), the pinned sha256-verified security binaries into `.tools/bin` (`tools/ensure_tools.sh`: gitleaks, trufflehog, osv-scanner, CodeQL; cached in `$ARENA_TOOLS_CACHE`, default `~/.cache/arena-tools`; the CodeQL bundle unpacks to ~3.3 GB), and the pre-commit hook (`tools/githooks/install.sh`; in a git worktree it installs into the shared `.git/hooks`).
- `make check`: the full gate (S5 11.1). `py-check`: ruff check, ruff format --check, mypy strict, no-rigging, silent-except, roles, cost-parity, ratchet, deps-policy, push-clean, pytest `-W error` with the 90% branch-coverage floor, scope-coverage, diff-cover 90% against `BASE_REF` (default `main`). `sec-check`: bandit (`-ll -ii`, then `-t B105,B106,B107`), Semgrep, CodeQL security-extended, gitleaks, TruffleHog, pip-audit `--require-hashes`, osv-scanner, licence gate. CI (`.github/workflows/`) runs the same make targets for `py-check` (against the pre-change base, `tools/ci_base_ref.sh`), the Python scans (bandit, Semgrep, pip-audit, licences) and gitleaks (`make gitleaks`, whole history); TruffleHog, osv-scanner, CodeQL and a second gitleaks pass run there through their official SHA-pinned Actions at the same scanner versions, and CodeQL's SARIF goes through the local validator (`tools/check_codeql.py --sarif`). Never soften a gate; fix the code.
- `uv run --locked pytest -m gateproof`: only the seeded-defect proofs that each gate fails on what it exists for.
- `ARENA_ROLE=api ARENA_GCP_PROJECT=<arena-project> ARENA_PUBLIC_DSN=<dsn> uv run python -m arena_api`: run a role's boot checks (settings shape: `.env.local.example`; S5 1.3). Boot refuses `kbg-production`, Google/Gemini API keys, a missing or extra DSN, `ARENA_OWNER_DSN`, an unknown `ARENA_ENV`, `ARENA_ENV=local` on Cloud Run, and any `ARENA_BIND_HOST` other than 127.0.0.1 in local mode.
- Not yet in `make check`, each arriving with the tree it gates: `db-test` (WP-03/WP-04), `web-check` (WP-18), `dev` and `dev-check` (S5 10.4, with the local launcher).

Research outputs live in `docs/research/`.
