# Critique round 10 (Codex, cross-model): v10.3 re-costing

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only; ran `cost_model.py`, `--plan-json`, `stats_contracts.py`.
- **Target:** direction v10.3 and `cost_model.py` (e56c1bb). **Verdict:** YELLOW, 0 blockers, 6 majors, 2 minors. Reproduced: 24 cases $46.91 / $71.23; local table and zero-event bounds match; training and demo not double counted.

| ID | Finding | Status |
| --- | --- | --- |
| R10-01 major | `budget_plan()` sizes leaves from settled spend, but the SQL guard checks reservation and 1.5x unit admission per leaf and ancestor; replayed against the generated ceilings, generation stops at 17/21 families, dev pilot 4/5, replay 23/24 | Open |
| R10-02 major | S2 section 11 live acceptance evaluations (injection robustness, style pairs, negative controls, referee gold sets) are uncosted: ~$22 expected / ~$32 conservative at S2's run counts | Open; needs right-sizing (design grew past the budget) |
| R10-03 major | Calibration transcript production, disjoint retest and J1 packing check uncosted (~$2-3) | Open |
| R10-04 major | Semantic regeneration after validator failures not modeled (~$0.47 per extra attempt) | Open |
| R10-05 major | Hosted check mixes local simulation with hosted ceilings; hosted table stale | Open |
| R10-06 major | `--plan-json` prints tables before the JSON | Open |
| R10-07 minor | Voice-session R3 debriefs missing (~$0.10) | Open |
| R10-08 minor | Art high rate $0.10 is below the $0.134 Pro image price | Open |

Root cause (red-to-root-cause): the workload is not one manifest. Spec parts promised paid work in prose; the cost model costed only what it was told; the plan certified a different admission policy than the guard enforces. Proposed structural fix: one workload manifest (every paid activity: bucket, call list, count, spec reference) that generates the ceilings and is replayed through the guard's own leaf-and-ancestor admission rules; spec sections that imply model calls cite a manifest entry, otherwise they are out of scope. Paused pending owner steer on scope (2026-10-08).
