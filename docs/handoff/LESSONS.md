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
