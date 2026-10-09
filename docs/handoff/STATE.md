# State

- **Date:** 2026-10-08, ~22:00 EDT
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
- Supabase project `fzjgcwkvveetegpngujr` (owner-provided). Supabase MCP added at **project scope only** (`.mcp.json`, server name `supabase`); user-scope MCP config untouched so the owner's other project keeps its own Supabase. Owner approved and logged in (2026-10-08 ~22:15); its tools load in the next session (not in the current one). Destructive database operations through it need explicit owner approval.

## Active subagents / workflows
| agent_id | description | model | dispatched_at | expected_completion | output_path |
| --- | --- | --- | --- | --- | --- |
| task `wdzxfq397` / run `wf_cedd150a-eec` | Spec v2.1 (S1 owner + S2-S8 integrator) in parallel with WP-01 scaffold | Opus x2, Sonnet x1 | 2026-10-08 ~21:55 EDT | ~23:00 EDT | `docs/spec/**`; repo root scaffold (pyproject, Makefile, packages, tools, .github) |

## Next dispatch queue
1. When the workflow lands: verify `make check` myself, commit scaffold and spec v2.1 separately (explicit paths, secret scan first).
2. Codex review of spec v2.1 (buildability and consistency; cost accounting deferred by D-013) until GREEN; Codex review of the scaffold.
3. Apply D-014 to S1/S8/cost_model after the running workflow lands; then a case-authoring workflow (dev families first, hidden families isolated and sealed).
4. WP-02 contracts package, then WP-03 migrations + WP-05 agent port and global guard, WP-08 scenario engine, WP-18 web foundation, toward the Oct 18 slice.

## Standing facts
- Voice: gokbase/cloudforce use `gemini-3.1-flash-live-preview` on AI Studio (not on Vertex; shuts down 2026-11-17). Vertex GA Live models `gemini-3.8-live`, `gemini-live-2.5-flash-native-audio` may be allowlist-gated; day-1 probe needed.
- Gemini 2.5 retires on Vertex 2026-10-16 to 10-20; only 3.x remains; thinking floor MINIMAL.
- MCP servers needing reconnect or sign-in: context7, gcloud, github, cloud-run, observability, storage (failed); Sentry, mobbin, PostHog, Vercel (auth).

## Local commits ahead of origin
- No remote configured.

## Live infrastructure
- None.
