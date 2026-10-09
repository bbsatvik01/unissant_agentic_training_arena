# Spec package

Build specification for the arena, in eight parts. Each part cites requirement IDs from `docs/challenge/REQUIREMENTS.md` and the direction sections it implements.

| Part | Scope |
| --- | --- |
| `S1-scenario-engine.md` (+ `schemas/`, `seed-families/`) | Case families, the three packets, release predicates, generation and validation |
| `S2-agents-and-prompts.md` | Agent port, candidates A1-A3 and S1-S3, referee, prompts, schemas |
| `S3-scoring-rubrics-metrics.md` | Rubrics, 9N metrics, statistics, leaderboard rules |
| `S4-data-layer.md` (+ `sql/`) | Schemas, roles, privileged functions, ledger, spend guard, trace mirror; pgTAP plan in `sql/TESTS.md` |
| `S5-backend-and-lift.md` | Services, routes, orchestration, voice relay, lift map from the reference repos |
| `S6-frontend-ux.md` | Screens, components, motion, voice surface, copy rules |
| `S7-demo-and-judging.md` | Demo script, judge paths, video and deck |
| `S8-build-plan.md` | Sequenced build plan to 2026-11-02 |

## Status

Version 1 (2026-10-08, workflow `wf_7986355a-2f8`) was written against direction v10; S8 section 9 lists 48 cross-part conflicts (C-01 to C-48). Reconciliation to the baseline below is in progress; Codex review follows.

## Governing sources (the spec follows these; where they disagree, these win)

1. `docs/research/synthesis/02-direction.md` v10.3 (Codex round 9 GREEN on v10; v10.3 re-costs the plan) with D-011 local-first.
2. `docs/research/synthesis/03-ui-direction.md` v2.1 (Codex UI round 2 GREEN).
3. `docs/handoff/DECISIONS.md` (D-001 to D-012).
4. Numbers come from scripts, never typed: dollar figures and bucket ceilings from `cost_model.py` (`budget_plan()`, `simulate_d009()`, `demo_ceiling()`), matrix totals from `decision_matrix.py`, statistical bounds from `stats_contracts.py`. A spec table that shows a figure names the function that produced it.

## Baseline facts the parts must agree on

- **Run mode:** local-first (D-011). Services run as separate local processes, each with its own database role and credential (`arena_public`, `arena_subject`, `arena_referee`); Phoenix runs locally; Vertex AI is the only GCP service billed. The Cloud Run and IAP design is the hosted variant, kept as an optional later phase, never the default path.
- **Plan (direction v10.3, `PLAN` in `cost_model.py`):** 24 hidden cases (12 matched families) x 1 repeat plus a 10-case dev pilot (5 families) and 4 more development families for KPI-1 (9 in total); 30 hidden cases only if the dev pilot's measured costs track the expected column (owner decision OD-8). Training: R3 (the two referee calls in investigator mode) on every scored training session; KPI-1 for up to 10 volunteers x 7 sessions; 20 calibration transcripts.
- **Spend guard (D-012):** the migrations seed the bucket tree with $0 ceilings (fail-closed: nothing can spend until the operator applies `budget_plan()`; `python3 cost_model.py --plan-json` prints it, and a test asserts the applied ceilings equal that output). Local plan: global $74.00 (cap $75 minus the $1 local allowance); children `demo`, `art` (character-art sub-budget), `training` (KPI-1 and calibration), and `build` with leaves `experiments`, `generation`, `dev_pilot`, `replay`, `interactive` (remainder). Hosting from day 1 does not fit the baseline; switching to hosted later requires that committed liability leaves the remaining work under $60.00 ($75 minus the $15 hosted allowance), checked by re-applying the hosted plan, which refuses any ceiling below current liability.
- **Demo allocation:** 40 text sessions, 8 voice sessions (whole-session reservation each), 62 character images within the art sub-budget.
- **UI:** one server-authorized event projection feeds every animation, caption, connector, pipeline detail and replay; coaching cards appear only when complete, validated and transcript-current; voice state combines connection, capture, server activity and playback; presentational work starts after the 2026-10-18 slice gate.
