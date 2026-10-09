# State

- **Date:** 2026-10-08, ~22:20 EDT
- **Branch:** `main` (local only, no remote yet)
- **Phase:** 1, build started (D-013). GCP spend $0. Deadline 2026-11-02 (D-005); slice gate 2026-10-18.

## Where things stand
- **Direction** `docs/research/synthesis/02-direction.md` v10.3: Codex GREEN at v10 (round 9); v10.3 re-costed training work and moved the local baseline to 24 hidden cases (~$47 expected / ~$71 conservative). Codex round 10 on v10.3: **YELLOW** (6 majors; `critique-round-10.md`): paid evaluation work promised in the spec is uncosted (~$22-38), and `budget_plan()` sizes leaves from settled spend while the SQL guard admits per leaf (generation 17/21, dev pilot 4/5, replay 23/24 when replayed).
- **UI direction** `03-ui-direction.md` v2.1: **GREEN** (Codex UI round 2). Awaits owner review and DESIGN.md.
- **Spec package** `docs/spec/`: v1 (a75b362) plus v2 reconciliation of S2-S8 and SQL (c293bec). Cross-check **RED** (`docs/spec/review-v2-crosscheck.md`): S1 not reconciled (its agent stopped without editing), 8 majors, 8 minors. Draft SQL applies on fresh Postgres 16 with smokes passing (S4 owner, port 55491 scratch cluster, stopped).
- **Plan (direction v10.4):** 30 hidden cases baseline, 34 pilot-gated; with offline case authoring (D-014) 30 cases is ~$44 expected / ~$66 conservative, complete in both. Spend guard: one global ceiling $74.00 (D-013), seeded at $0 until applied.

## Owner directive (2026-10-08 ~21:50, D-013)
- Build the pipeline end to end first; cost tuning later; one global $74 ceiling keeps the $75 cap; keep it simple; get Codex to GREEN on the spec.
- Owner decisions still open: 30 vs 34 cases (OD-8), volunteers (OD-7), GCP project (never `kbg-production`; the workstation gcloud default IS kbg-production, so never call gcloud without an explicit project), Supabase project, DESIGN.md, repo destination, voice exception rule, A2A track, team roster, plugin installs, pet name.

## Owner directives (2026-10-08 ~22:10)
- D-014: case families authored once by Claude agents + Codex review; Gemini 3.1 Pro dropped; other models kept.
- Supabase project `fzjgcwkvveetegpngujr` (owner-provided). Supabase MCP added at **project scope only** (`.mcp.json`, server name `supabase`); user-scope MCP config untouched so the owner's other project keeps its own Supabase. Owner approved and logged in; tools work in this session (verified: project URL https://fzjgcwkvveetegpngujr.supabase.co; database empty, no tables, no migrations). Destructive database operations through it need explicit owner approval.

## Active subagents / workflows
| agent_id | description | model | dispatched_at | expected_completion | output_path |
| --- | --- | --- | --- | --- | --- |
| task `wco6osdfj` / run `wf_cedd150a-eec` (resumed) | S1 D-014 update; S2-S8 integrator (X-02..X-17, D-013, D-014); WP-01 scaffold | Opus x2, Sonnet x1 | 22:05 EDT | ~23:15 EDT | main tree: `docs/spec/**`, root scaffold |
| task `wznwlwvt8` / run `wf_0246738e-32c` | Dev case authoring F04-F09: kit (CX sheets, Codex runner, calibration on F01-F03, gateproof), 3 authors at a time, skeptic + fix loop, final cross-family gate, commit on branch | Opus | 22:15 EDT | ~01:00 EDT | worktree `/private/tmp/wt-cases` branch `data/dev-cases` |
| task `wspgs42zb` / run `wf_20ff7f42-fb5` | WP-18 part 1 web foundation: Vite/React/TS scaffold + gates, ticketed SSE, voice machine, companion FSM; self Codex gate; independent verify | Opus | 22:18 EDT | ~00:00 EDT | worktree `/private/tmp/wt-web` branch `feat/web-foundation` |

## Next dispatch queue
1. When wf_cedd150a-eec lands: commit spec v2.1/v2.2 to main; move the WP-01 scaffold onto branch `feat/wp01-scaffold`, run `make check` myself and a cold Codex gate, merge on CORRECT.
1b. When the case and web branches land: cold Codex gate each (plus re-run validators / pnpm check), merge on CORRECT.
2. Codex review of spec v2.1 (buildability and consistency; cost accounting deferred by D-013) until GREEN; Codex review of the scaffold.
3. After spec Codex GREEN: hidden-family authoring (15, isolated agents, git-ignored `cases/hidden/`, codes-only reports), then seal.
4. WP-02 contracts package, then WP-03 migrations + WP-05 agent port and global guard, WP-08 scenario engine, WP-18 web foundation, toward the Oct 18 slice.

## Standing facts
- Voice: gokbase/cloudforce use `gemini-3.1-flash-live-preview` on AI Studio (not on Vertex; shuts down 2026-11-17). Vertex GA Live models `gemini-3.8-live`, `gemini-live-2.5-flash-native-audio` may be allowlist-gated; day-1 probe needed.
- Gemini 2.5 retires on Vertex 2026-10-16 to 10-20; only 3.x remains; thinking floor MINIMAL.
- MCP servers needing reconnect or sign-in: context7, gcloud, github, cloud-run, observability, storage (failed); Sentry, mobbin, PostHog, Vercel (auth).

## Local commits ahead of origin
- No remote configured.

## Live infrastructure
- None.
