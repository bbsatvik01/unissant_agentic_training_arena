# Critique round 5 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only, live web search; ran all three scripts.
- **Target:** `02-direction.md` v6 (commit 4144da4), the first version planned for D-009 (total GCP spend hard cap $75, target $50). An earlier round-5 run against v5's $100 budget was stopped when the owner set D-009.
- **Verdict:** YELLOW. 0 blockers, 4 majors, 2 minors (rounds 1-4: 24, 12, 6, 5 majors).
- **Confirmed fixed from round 4:** R4-01, R3-01, F14, R4-02, F07, R4-03. No regression in credential isolation, assessment projections, playback grounding, trace durability, independent labeling or fidelity denominators. 30 cases is permitted by BKO-8 and its 18.1% bound is correct.

## Dispositions

| ID | Real? | Change in v7 |
| --- | --- | --- |
| F01 simulator vs policy | Real. `simulate_total` modeled aggregates, not the per-call guard; section 7.2 still described full-block reservations; the demo bucket lacked the retry reserve; the "~$2 unspent" claim was unconditional. | `simulate_d009()` walks the ordered stream of calls: soft admission per unit (1.5x conservative cost), hard admission per call (full worst-case reservation at liability rates), truncation recorded; preparation passes the same guard; demo text sessions carry the retry factor; voice uses its meter cap; 7.2 aligned; unspent claim removed. |
| R5-01 non-model liabilities | Real. A model-call ledger cannot cap Cloud Run, storage, logging or transfer, and GCP has no strict project-wide cap. | Finite window (2026-10-13 to 2026-11-09) with teardown; an itemized non-model envelope ($1.20 expected, $8.00 conservative) set aside before any model work; bounded by configuration (min 0, max-instances, timeouts, invite-only, rate limits, log exclusions); billing alerts as backup; the doc says plainly that this part is a bound by configuration, not a ledger guarantee. |
| F25 voice cost | Real. Constants ignored per-turn context rebilling. | `voice_session_cost()` models a 12-exchange reference session with accumulated audio context, system text, output audio, transcription, coaching and playback retranscription: $0.45 expected, $0.92 conservative, under the $1.00 meter cap; six sessions budgeted; Vertex 3.8 Live pricing to confirm. |
| R5-02 promotional rates | Real. The 3.8 Flash promotion is credits back. | Liability rates use the undiscounted $1.50/$7.50; promotional savings counted only as upside. The D-009 lineup removes 3.8 Flash from the bake-off path entirely (referee's subject-facing call on 3.1-flash-lite at LOW thinking, disclosed shared checkpoint with S1; all generation on Pro; validation on 3.5-flash-lite); the latency benchmark covers only lineup models. |
| F15 reveal precondition (minor) | Real | Restored: reveal requires every subject review resolved; the manifest lists every planned trial with its inclusion or exclusion reason. |
| R5-03 bound labels (minor) | Real | Table shows the bound if all planned families complete and the achieved bound in the conservative case. |

## Result
Recommended plan unchanged and now substantiated: 30 hidden cases plus a 10-case dev pilot, ~$44 expected / ~$72 conservative for everything on GCP, complete in both cases.
