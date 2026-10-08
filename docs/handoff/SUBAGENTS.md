# Subagents in flight

## Spec-package workflow
- **ID:** task `wvney9kpk`, run `wf_7986355a-2f8`
- **Script:** `~/.claude/projects/-Users-balla-Desktop-satvik-2026-Fall-Challenge-X-Unissant-Agent-trainign-arena/dc0e4a6d-a509-42da-9f0a-5ffc13175b6a/workflows/scripts/arena-spec-package-wf_7986355a-2f8.js`
- **Journal:** `.../subagents/workflows/wf_7986355a-2f8/journal.jsonl`
- **Dispatched:** 2026-10-08 ~21:00 EDT. **Expected:** ~45-90 min.
- **Agents:** S1-S6 Opus, S7 Sonnet (parallel), then S8 Opus build plan. General-purpose agents; write only `docs/spec/**`; reference repos read-only; no GCP calls.
- **Outputs:** `docs/spec/S1-scenario-engine.md` (+ `schemas/*.schema.json`, `seed-families/F01-F03.json`), `S2-agents-and-prompts.md`, `S3-scoring-rubrics-metrics.md`, `S4-data-layer.md` (+ `sql/0001-0006*.sql`, `sql/TESTS.md`), `S5-backend-and-lift.md`, `S6-frontend-ux.md`, `S7-demo-and-judging.md`, `S8-build-plan.md`.
- **Governing input:** direction v10. **Gate after:** Codex review of the spec package; owner approval of direction before any build.
- **If the session dies:** `Workflow({scriptPath, resumeFromRunId: "wf_7986355a-2f8"})`.

## UI/UX research-harness workflow
- **ID:** task `w93j11g8w`, run `wf_7304b52c-bcb`. Dispatched 2026-10-08 ~20:05 local; expected ~40-60 min.
- **Agents:** 5 Sonnet routes, max 3 concurrent (session cap ~8 with the spec workflow): U1 Claude skills and design tools (incl. Stitch MCP), U2 speaking avatars and companion pets (incl. Gemini Live Avatar), U3 motion system and agent-pipeline visuals (incl. no-jargon UX writing), U4 best-in-class references, U5 character asset pipeline.
- **Outputs:** `docs/research/ui/U1-U5*.md` written by the agents; compact summaries in the journal.
- **Gate after:** orchestrator UI synthesis (`docs/research/synthesis/03-ui-direction.md`), Codex critique.
- **If the session dies:** `Workflow({scriptPath, resumeFromRunId: "wf_7304b52c-bcb"})`.
