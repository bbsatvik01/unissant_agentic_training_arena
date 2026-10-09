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

- `make bootstrap`: `uv sync --locked` (clean-clone setup).
- `make check`: the full gate. ruff check, ruff format --check, mypy strict, no-rigging, roles, cost-parity, ratchet, pytest with the 90% branch coverage floor (`-W error`), bandit `-ll -ii`. CI runs the same targets. Never soften a gate; fix the code.
- `uv run --locked pytest -m gateproof`: only the seeded-defect proofs that each gate fails on what it exists for.
- `ARENA_ROLE=api ARENA_GCP_PROJECT=<arena-project> ARENA_PUBLIC_DSN=<dsn> uv run python -m arena_api`: run a role's boot checks (shape of the settings: `.env.local.example`). Boot refuses `kbg-production`, API keys, extra DSNs.

Research outputs live in `docs/research/`.
