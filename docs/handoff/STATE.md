# State

- **Date:** 2026-10-08, ~21:45 EDT
- **Branch:** `main` (local only, no remote yet)
- **Phase:** 0, design and spec. Nothing built. GCP spend $0. Deadline 2026-11-02 (D-005).

## Where things stand
- **Direction** `docs/research/synthesis/02-direction.md` v10.3: Codex GREEN at v10 (round 9); v10.3 re-costed training work and moved the local baseline to 24 hidden cases (~$47 expected / ~$71 conservative). Codex round 10 on v10.3: **YELLOW** (6 majors; `critique-round-10.md`): paid evaluation work promised in the spec is uncosted (~$22-38), and `budget_plan()` sizes leaves from settled spend while the SQL guard admits per leaf (generation 17/21, dev pilot 4/5, replay 23/24 when replayed).
- **UI direction** `03-ui-direction.md` v2.1: **GREEN** (Codex UI round 2). Awaits owner review and DESIGN.md.
- **Spec package** `docs/spec/`: v1 (a75b362) plus v2 reconciliation of S2-S8 and SQL (c293bec). Cross-check **RED** (`docs/spec/review-v2-crosscheck.md`): S1 not reconciled (its agent stopped without editing), 8 majors, 8 minors. Draft SQL applies on fresh Postgres 16 with smokes passing (S4 owner, port 55491 scratch cluster, stopped).
- **Budget plan today** (`cost_model.py --plan-json`, 24 cases, local): global $74.00 = demo $10.55 + art $6.20 + training $6.19 + build $51.06 (experiments 6.96, generation 9.92, dev_pilot 8.07, replay 4.64, interactive 21.47). Ceilings, not spend.

## Paused, waiting on the owner (2026-10-08 ~21:30)
- Owner asked "what are these volunteers for" and "what is the project that you designed". Answered in plain terms and asked whether to trim scope to fit the $50 target. The spec has grown past the budget; no further cost-model or spec work until the owner steers. Do not resume the workload-manifest rewrite (round 10 fix) without that steer.
- Owner decisions open: scope trim; 24 vs 30 cases (OD-8) and volunteer count (OD-7); GCP project (never `kbg-production`); Supabase project; DESIGN.md; repo destination; voice exception rule; A2A exhibition track; team roster; plugin installs; pet name.

## Active subagents / workflows
- None.

## Next dispatch queue (after owner steer)
1. If trimming: cut the S2 section 11 acceptance suite and other paid evaluations to a size the budget funds; one workload manifest in `cost_model.py` (every paid activity: bucket, call list, count, spec reference) generates ceilings and is replayed through the guard's own leaf-and-ancestor admission rules; `--plan-json` emits only JSON.
2. Reconcile S1 (schema v1.1 fields C-21, family counts, LOCKED gates) and fix cross-check X-02..X-17.
3. Codex review of the spec package until green x green; then owner approval (gate G0) before any build.

## Standing facts
- Voice: gokbase/cloudforce use `gemini-3.1-flash-live-preview` on AI Studio (not on Vertex; shuts down 2026-11-17). Vertex GA Live models `gemini-3.8-live`, `gemini-live-2.5-flash-native-audio` may be allowlist-gated; day-1 probe needed.
- Gemini 2.5 retires on Vertex 2026-10-16 to 10-20; only 3.x remains; thinking floor MINIMAL.
- MCP servers needing reconnect or sign-in: context7, gcloud, github, cloud-run, observability, storage (failed); Sentry, mobbin, PostHog, Vercel (auth).

## Local commits ahead of origin
- No remote configured.

## Live infrastructure
- None.
