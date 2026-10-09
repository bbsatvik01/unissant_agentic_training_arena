# UI critique round 2 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only, live web search (9 searches; ran `decision_matrix.py` and `cost_model.py`).
- **Target:** `03-ui-direction.md` v2 (commit ecd95e3). **Verdict:** GREEN, 0 blockers, 0 majors, 3 minors. All eleven round-1 findings confirmed fixed or reduced to minor; no new disclosure path; PRB-4 and D-011 intact. Script output reproduced (30 cases $45.93 / $70.06, complete).

| ID | Real? | Change in v2.1 |
| --- | --- | --- |
| UI-03 residual: pet and avatar tables showed old point totals | Real | Tables now print the script's ranges (pet A 4.40-5.00; avatar A 3.70-4.70). |
| UI-08 residual: "no published video price" is outdated | Real | Avatar video is priced ($1 per million output tokens, 6,192 tokens per speaking second, about $1.04 per reference voice session); exclusion kept on spend, integration and access grounds. |
| UI2-01: week-one feasibility tests conflict with "nothing presentational before the slice" | Real | Avatar production test and GSAP spike move to right after the October 18 slice gate. |
| Suggestion: art dollar sub-budget | Adopted | 62 images and a $6.20 sub-budget covering reference-image input and text or thinking charges; approved assets reused when spent. |
| Suggestion: production-test fallback | Adopted | Hand-authored SVG with the same playback-driven mouth rig. |

Orchestrator: green. UI direction v2.1 awaits owner review and DESIGN.md.
