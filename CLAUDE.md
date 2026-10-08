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

None yet (pre-build). Research outputs live in `docs/research/`.
