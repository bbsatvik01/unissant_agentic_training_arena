# Critique round 4 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only, live web search (12 searches; ran all three scripts).
- **Target:** `02-direction.md` v4 (commit c215399) with the three scripts.
- **Verdict:** YELLOW. 0 blockers, 5 majors, 3 minors (rounds 1-3: 24, 12, 6 majors).
- **Confirmed fixed from round 3:** F13, N01, F11, R3-02, R3-03. Spot checks of F02-F06, F08-F10, F16-F18, F20-F22, N02, N03 found no regression. All published figures matched script output.

## Non-convergence analysis (red-to-root-cause)
Spend feasibility (F01) has appeared in all four rounds; attrition and inclusion (F14, F15) in three; the batch fallback (R3-01) in two. Each fix added a mechanism (batch fallback, reservation layers, an assistant-invalid verdict), and each mechanism opened a new gap. The class bug is mechanism growth. v5 removes mechanisms instead of patching them:
- **No batch anywhere** in the tournament path. The referee runs online as each block finishes and replay runs in bounded online chunks, which removes turnaround risk, duplicate billing and queued reservations at once.
- **Assistants are scored, never invalidated.** The only synthetic outcome is `assistant_failed` (no valid classification).
- **One sealed inclusion manifest at reveal**, bound to each leaderboard version.
- **Feasibility is simulated, not asserted:** `simulate_admission()` runs the spend guard over the actual order of work.

## Dispositions

| ID | Real? | Change in v5 |
| --- | --- | --- |
| R4-01 assistant_invalid recoding | Real. It turned false accusations into abstentions. | Removed. Every schema-valid committed classification counts as committed; unsupported and demeanor-based findings are reported separately. Validity adjudication covers subjects only. |
| F01 reservation feasibility | Real. Queued batch referee work held ~$138 of reservations. | No batch. Sequential units with online settlement; `simulate_admission()` shows option B completes everything at expected usage and the replay track plus 34/40 interactive blocks at conservative usage; shortfall reported as `budget_skipped`, recoverable by tightening limits from pilot maxima. |
| R3-01 fallback duplicates | Real. Job-level fallback could bill completed rows twice. | Removed with batch. |
| F14 deceptive attrition in ranks | Real. Retaining only easy deceptive trials could inflate recall to a definitive top rank. | `rank_sensitivity()` imputes excluded deceptive trials as misses and detections and marks ranks provisional on possible reversal or own coverage below 90%; the round-4 counterexample is an assertion in `stats_contracts.py`. |
| F15 mutable inclusion | Real | `reveal()` seals the inclusion manifest (hashed adjudication IDs); leaderboards name their manifest; later adjudications publish a separately labeled corrected version. |
| R4-02 zero denominator (minor) | Real | `attrition_sensitivity()` returns "insufficient" with no included truthful trials; assertion added. |
| F07 freeze scope (minor) | Real | Finalization freezes execution artifacts only; adjudication and reveal follow their own lifecycle. |
| R4-03 DM-5 label (minor) | Real | Hosted option now described as trace mirror as the store with request-based CPU; CPU allocation is an optional, separately approved improvement. Scores unchanged (their assumptions did not change). |

## New facts surfaced by the fixes
- Following the sponsor's order (BKO-2: replay, then interactive) also fixes budget truncation: replay always completes first, and any shortfall falls on randomized interactive blocks, which the protocol already reports.
- The replay corpus is now defined: a fixed harness with a predeclared neutral script, one rotating subject per hidden case, referee-labeled, sealed by hash before any assistant scores it.
