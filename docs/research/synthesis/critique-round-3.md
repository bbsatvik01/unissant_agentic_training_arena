# Critique round 3 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only, live web search (12 web searches plus GDK and Context7 checks; ran all three scripts).
- **Target:** `02-direction.md` v3 (commit 368a759) with `cost_model.py`, `decision_matrix.py`, `stats_contracts.py`.
- **Verdict:** YELLOW. 0 blockers, 6 majors, 4 minors (round 2: 12 majors, 3 minors; round 1: 24 majors, 2 minors).
- **Confirmed fixed from round 2:** F02, F03, F08, F10, F16, F20, F23, N02, N03. Round-1 spot checks passed for F04-F06, F09, F17-F19, F21-F22, F24-F26. All published tables matched script output.

## Convergence
Majors fell 24 -> 12 -> 6. The remaining majors are deeper instances of two classes already named: R1 (numbers must be enforceable, not just reproducible) and R4 (metric contracts must hold under attrition and unequal weighting). One schedule risk (batch turnaround) was new.

## Dispositions

| ID | Real? | Change in v4 |
| --- | --- | --- |
| F01 reservations not enforceable | Real. `thinking_level` is qualitative; `max_output_tokens` caps thinking plus visible output; modeled calls exceeded the universal caps; retries were missing. | `cost_model.py`: per-call-type input and total-output limits matching request configuration, asserted against every modeled call at load (the assertion immediately caught S3 needing 1,250 output tokens against 1,200); four attempts per call; generator-enforced `MAX_RELEASES`. Block worst case now $15.30 (power-first) / $18.47 (full); parallel blocks need proportional headroom. |
| F13 weighting | Real. The family bound bounds trial FPR only when families contribute equal trial counts. | `stats_contracts.py` adds the unequal-size counterexample (4.87% family bound vs 5.22% trial FPR); the bound is computed on the complete-family subset and otherwise reported as a family-level statistic. |
| F14 attrition reversal | Real. A common-subset rule let one candidate's invalid cells erase another's false positives. | Eligibility uses each candidate's own included trials; common cells only for paired comparisons; worst/best imputation marks eligibility provisional (`attrition_sensitivity`, with the round-3 example as a test). |
| F15 execution vs validity | Real | Two layers: immutable execution records (including atomic `subject_quarantined` from `record_subject_turn`) and append-only referee validity adjudications through a new `adjudicate_validity()` granted only to `arena_referee`; inclusion depends on both; reveal requires adjudication complete. |
| N01 budget framing | Real. The sponsor's gate is a point estimate; D-007 caps the bake-off, not all spending. | Three buckets (bake-off, preparation, hosted demo). Option B (80 cases) fits the $100 bake-off cap even with online fallback; option A (120 cases) needs ~$145. The 59-family figure is presented as a precision fact, not a minimum for a compliant run. |
| R3-01 batch turnaround | Real. Batch has no SLA (up to 72 h queue plus 24 h processing). | Sealed run moved to Oct 22-25; batch cutoff Oct 25; online fallback switch Oct 27, costed per option. |
| F11 durability barrier (minor) | Real | The committed `ops.trace_mirror` row is the barrier; flush results checked; export retried from the mirror; Phoenix CPU allocation optional. |
| F07 stale writes (minor) | Real | Server-created work items and expected transcript versions on every state-changing write; retries resolve to the original result; stale and post-finalization writes rejected. |
| R3-02 relay protocol (minor) | Real | Only bounded audio and approved controls cross the relay; Live setup, prompts, tools and resume handles stay inside `arena-subject`, which re-checks ticket bindings. |
| R3-03 Phoenix reveal lock (minor) | Real | Unrevealed hidden-tournament spans stay in the restricted mirror and are exported to the judge-visible Phoenix only after reveal. |
