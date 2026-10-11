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

## Build wave 2 workflow
- **ID:** task `wr15p0y5x`, run `wf_9aced0c9-52d`; script `.../workflows/scripts/arena-build-wave2-wf_9aced0c9-52d.js`.
- **Dispatched:** 2026-10-08 ~22:23 EDT. **Expected:** ~2-3 h.
- **Agents:** gate:WP-01 (wt-wp01; self Codex on 7e484f4, add gitleaks/osv-scanner pinned by SHA), build:WP-08 (wt-wp08; port reference kit into arena_core/scenario with byte-identical seed regeneration and the 29-mutant suite), build:WP-03 (wt-wp03; supabase/migrations, PG17 container harness on a high port, capability fixture, fail-closed tests, parity check, make db-test); then one verifier per committed branch.
- **After:** orchestrator cold Codex per branch, merge into main.

## Spec fix round 1 workflow
- **ID:** task `w389ifutb`, run `wf_09e6717a-210`; script `.../workflows/scripts/arena-spec-fix-r1-wf_09e6717a-210.js`.
- **Dispatched:** 2026-10-08 ~22:40 EDT. **Expected:** ~1.5-2 h.
- **Agents:** fix:S1 (S1, schemas, seeds; kit copy s1v23), fix:S2-S3, fix:S4-SQL-S5 (PG17 container on 127.0.0.1:55497, smokes in s4v23), then fix:S6-S8 (reads the final backend). Each returns per-finding dispositions (real or false positive with evidence, rule, change).
- **Inputs:** Codex findings scratchpad `codex/spec1/g1..g4.json`; shared decisions D1-D11 in the script.
- **After:** dispositions into `docs/spec/review-codex-r1.md`; Codex spec round 2.

## 2026-10-11 active
- ac1b3a38666e87dcf WP-05 port (resumed): merge main, WP-10 helpers + parity test, D-019. wt-wp05-port. Gate: self Codex, then cold Codex.
- aef227ff5a791ab22 WP-04 pgTAP suite (Sonnet). wt-wp04-pgtap feat/wp04-pgtap. Gate: db-test green, self + cold Codex.
- a928b8a9c3a763c65 WP-07 observability (Sonnet). wt-wp07-obs feat/wp07-obs. Gate: S5 8.9, self + cold Codex.
- ac2a4c78d321feac9 UI lead stage 1 (Opus): 3D world + overlay + playback (D-020, D-021). wt-ui-world feat/ui-world. Gate: pnpm check, screenshots, one Codex round.
- ad9db92b288b7a8c1 Supabase migrations 0600-1100 via MCP (Sonnet), byte-exact check, advisors. No repo edits.
- a80b942018d564e81 WP-18b follow-up (2 rare-path fixes), fix/wp18b-followup. adb48fe0d3cc9a911 WP-11 rubric lexicon hash fix.
