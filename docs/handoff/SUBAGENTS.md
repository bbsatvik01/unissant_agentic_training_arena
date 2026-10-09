# Subagents in flight

## Spec v2.1 + WP-01 scaffold workflow
- **ID:** task `wco6osdfj` (resumed 22:05 after the session break; first launch `wdzxfq397`), run `wf_cedd150a-eec`; S1 agent cached, added S1-D014 step, integrator and WP-01 told to continue from partial edits
- **Script:** `~/.claude/projects/-Users-balla-Desktop-satvik-2026-Fall-Challenge-X-Unissant-Agent-trainign-arena/dc0e4a6d-a509-42da-9f0a-5ffc13175b6a/workflows/scripts/arena-spec-v21-and-scaffold-wf_cedd150a-eec.js`
- **Dispatched:** 2026-10-08 ~21:55 EDT. **Expected:** ~60-90 min.
- **Agents:** spec:S1 (Opus; S1, schemas, seeds; X-01), spec:S2-S8 (Opus; S2-S8 + sql; X-02..X-17 + D-013), build:WP-01 (Sonnet; uv workspace, Makefile gates, tools, .github, ATTRIBUTIONS, CLAUDE.md dev commands only). No agent commits; return schemas require non-empty files_written.
- **Verification baked in:** S1 seed validation + mutation suite; SQL re-applied on scratch Postgres 16 (port 55493) with smokes; make check + gateproofs.
- **Gate after:** my own make check, secret scan, separate commits, then Codex on spec v2.1 and scaffold until GREEN.
- **If the session dies:** `Workflow({scriptPath, resumeFromRunId: "wf_cedd150a-eec"})`.

## Dev case authoring workflow
- **ID:** task `wznwlwvt8`, run `wf_0246738e-32c`; script `.../workflows/scripts/arena-dev-case-authoring-wf_0246738e-32c.js`.
- **Dispatched:** 2026-10-08 ~22:15 EDT. **Expected:** ~2-3 h.
- **Agents:** kit (Opus) -> authors F04-F09 (Opus, 3 in flight) -> skeptic per family (Opus) -> fix + skeptic2 on fail -> final cross-family gate and commit on branch `data/dev-cases` (worktree `/private/tmp/wt-cases`).
- **Gates:** reference validators V1-V5 (kit in scratchpad `authoring/kit`), Codex CX-1..CX-4 per family (calibrated on F01-F03; gateproof with three mutants), skeptic lens (playability, fairness, subject-rule integrity, realism, novelty).
- **Seed plan:** `cases/dev/seed-plan.json` (eba6286).
- **After:** orchestrator cold Codex gate on the branch, merge into main.

## Web foundation workflow
- **ID:** task `wspgs42zb`, run `wf_20ff7f42-fb5`; script `.../workflows/scripts/arena-web-foundation-wf_20ff7f42-fb5.js`.
- **Dispatched:** 2026-10-08 ~22:18 EDT. **Expected:** ~1.5-2 h.
- **Agents:** build (Opus; writes only `web/` in worktree `/private/tmp/wt-web`, branch `feat/web-foundation`; self Codex gate to CORRECT; commits, no push) -> independent verify (Opus; pnpm check + mutation probes).
- **After:** orchestrator cold Codex gate, merge into main; Makefile integration after WP-01 merges.
