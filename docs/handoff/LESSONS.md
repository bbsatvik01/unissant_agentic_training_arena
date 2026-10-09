# Lessons (append-only)

Format per entry: date and one-line symptom; root cause; fix; prevention pattern.

## Imported from TechnoMile (2026-09-25 to 2026-10-05), applies here

### 2026-09-25 · A research session hung with too many concurrent agents
- **Root cause:** large multi-workflow fan-outs on a 16 GB machine froze agents in memory.
- **Fix:** cap concurrency.
- **Prevention pattern:** at most ~8 concurrent agents per session across all workflows; agents' outputs land on disk as each finishes; no Docker-heavy jobs while research runs. See PATTERNS.md.

## Arena

### 2026-10-08 · A research agent's cost table was wrong and the synthesis repeated it
- **Symptom:** X8 priced the "Flash assistant + Flash-Lite subject" mix at $0.0448/trial; the stated tokens and rates give $0.0614. Direction v1 then claimed the bake-off fit under $100. Codex round 1 caught it (F01). A complete accounting (independent scoring, stage-2 calls, thinking tokens, generation, dev pilot) put the v1 lineup at ~$190 expected. The same review pass found hand-computed decision-matrix totals off in six places.
- **Root cause:** numbers copied from agent reports or added by hand, never recomputed from their stated assumptions for the lineup actually proposed.
- **Fix:** `docs/research/synthesis/cost_model.py` and `decision_matrix.py` now produce every dollar figure, matrix total and sensitivity result in the direction; v2 tables are pasted from their output.
- **Prevention pattern:** any number that drives a decision comes from a script in the repo, re-run after every change to its inputs (PATTERNS: "Numbers come from scripts").

### 2026-10-08 · Critique rounds stalled because every fix added a mechanism
- **Symptom:** Codex majors fell 24 -> 12 -> 6 -> 5; spend feasibility recurred in all four rounds, attrition and inclusion in three. Each fix (batch fallback, reservation layers, an assistant-invalid verdict) opened a new gap.
- **Root cause:** patching by adding mechanism instead of asking whether the mechanism was needed; batch pricing saved little but brought turnaround, duplicate-billing and reservation problems.
- **Fix:** v5 removed batch from the tournament path, removed assistant invalidation, sealed one inclusion manifest, and replaced asserted feasibility with a simulation of the spend guard.
- **Prevention pattern:** when a finding class recurs, first try deleting the mechanism that produces it; prove feasibility claims with a simulation in the repo (PATTERNS: "Numbers come from scripts").

### 2026-10-08 · Four critique rounds chased an impossible guarantee
- **Symptom:** rounds 5-8 each rejected a new "hard bound" on non-model GCP costs (envelope, usage caps, middleware ledger, watchdog).
- **Root cause:** GCP has no project-wide spend cap and billing metrics lag, so no in-app mechanism can hard-bound Cloud Run, logging or egress; each attempt overclaimed.
- **Fix:** claim hard caps only where they are real (model and voice reservations); minimize non-model costs by design, give them an allowance with margin, and backstop with alerts and an automated billing-disable.
- **Prevention pattern:** before engineering a guarantee, check whether the platform can provide it at all; when it cannot, state the residual risk and size a margin instead.

### 2026-10-08 · Promised work was left out of the cost model until the spec package found it
- **Symptom:** direction v10.2 claimed 30 hidden cases complete at ~$46 / ~$70. The spec package (S3 OQ-1, S1 OQ-9, S8 C-15 and C-43) found R3 investigator scoring, KPI-1 sessions, calibration scoring and four KPI-1 development families uncosted. With them, 30 cases is ~$52 expected and stops at 11 of 15 interactive blocks in the conservative case.
- **Root cause:** the cost model was built from the bake-off's call lists; training-side promises (KPI-1, EVL-7 debriefs, calibration) lived in prose and never became call lists. Same rule as critique round 2 F01 ("every promised experiment is costed"), broken on the training side.
- **Fix:** `cost_model.py` adds `r3()`, `session_text()`, `training_bucket()`, `KPI1_EXTRA_DEV_FAMILIES` and a `training` bucket in `budget_plan()`; direction v10.3 re-plans to 24 hidden cases (complete in both, ~$47 / ~$71), 30 pilot-gated.
- **Prevention pattern:** every requirement that implies a model call (each KPI, debrief, calibration, validation pass) maps to a named call list in `cost_model.py`; spec reviews check that every call type in the spec appears there (S8 C-15 is the template).

### 2026-10-08 · Broad `git add docs` swept in-progress workflow output into unrelated commits
- **Symptom:** spec drafts S1-S7 and the draft SQL landed in commits 2da6fa8 and ecd95e3 (research commits) before their secret scan; the later scan was clean and nothing left the machine.
- **Root cause:** a background workflow was writing into `docs/spec/` while commits used `git add docs`.
- **Fix:** none needed beyond the clean scan; spec v1 completed in a75b362.
- **Prevention pattern:** while any workflow or agent writes into the tree, stage explicit paths only; scan workflow output before its first commit.
