# Critique round 2 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only, live web search (15 web searches plus GDK and Context7 checks; ran both scripts).
- **Target:** `02-direction.md` v2 (commit 28169a4) with `cost_model.py` and `decision_matrix.py`.
- **Verdict:** YELLOW. 0 blockers, 12 majors, 3 minors (round 1: 24 majors, 2 minors).
- **Confirmed fixed from round 1:** F04, F05, F06, F07, F09, F12, F17, F18, F19, F21, F22, F24, F25, F26. Both scripts executed and matched the published tables.

## Recurrence check (red-to-root-cause)

Five round-1 fixes were themselves flagged (F01, F02, F03, F11, F15). Per the skill, a fix found in the next round means the rule was not understood. The deeper rules applied in v3:

| Recurring finding | Rule v2 still broke | v3 structural fix |
| --- | --- | --- |
| F02 release, F15 finalization, F03 voice route | A privileged operation must derive every authorization input from committed server state and run as one narrow transaction; no secret-holding service accepts browser traffic | Section 4.2: five SECURITY DEFINER functions (EXECUTE revoked from PUBLIC, one grantee, state derived from rows, trial lock, idempotent, per-function attack tests); browser voice terminates in `arena-api` and is relayed to an IAM-private `arena-subject`; capability matrix (4.3) becomes a test fixture |
| F01 cost model | A lineup must be data shared by every costing path; estimates and enforceable reservations are different quantities; every promised experiment is costed | `cost_model.py` rebuilt: `Lineup` and `Assistant` data classes used by dev pilot, sealed run and replay; evidence-triggered deep stages; complete per-turn cards; itemized experiments; worst-case block reservation |
| F11 Phoenix | Durability needs an acknowledged barrier; a later read does not flush an in-memory queue | Producers flush per request; hosted Phoenix only with CPU allocated for the instance lifetime (owner sign-off); spans mirrored to `ops.trace_mirror`; read-back is verification only; all scores from Postgres |

## Dispositions

| ID | Real? | Change in v3 |
| --- | --- | --- |
| F01 workload inconsistent | Real | Lineups as data; A1 final model per lineup; evidence-triggered deep stages; replay uses the same schedule; experiments itemized; reservations separate. Result: sponsor-sized run ~$121 / ~$175; all-in-$100 option is 40 hidden cases |
| F02 release authorization | Real | `release_evidence()` derives the turn from the committed transcript, checks state, accepts only public requestable record IDs, locks, is idempotent; attack tests listed |
| F03 voice route and referee access | Real | Voice relayed through `arena-api` to IAM-private `arena-subject`; tickets bound to user, trial, split, mode; referee granted read on subject-private packets for labeling; capability matrix |
| F08 incomplete card | Real | One common card for every candidate every turn includes finding, confidence and last-revision turn; KPI-4 measures that card; cost model updated |
| F10 playback grounding | Real | Interrupted utterances excluded from scored citations; scored transcripts come from acknowledged played audio; voice stays outside scored results until tests pass |
| F11 Phoenix durability | Real | See recurrence table |
| F13 family event | Real (minor) | Family-level event defined; bound labeled conservative for the trial-weighted FPR; n = retained families; `stats_contracts.py` with boundary assertions |
| F14 attrition | Real | Terminal-state taxonomy; outcome-independent retries; matched (family, subject) cells; coverage rule (90%) for rankings and the FPR gate |
| F15 finalization | Real | `finalize_trial()`, `record_terminal()`, frozen roster, replay corpus seal, `reveal()` preconditions |
| F16 model separation | Real (minor) | Described as a separate blinded invocation with a frozen prompt; power-first referee checkpoint differs from all subject checkpoints; full-lineup overlap disclosed |
| F20 matrix inputs | Real | Equal fidelity when both designs meet the same contract (DM-3 now favors the single complete call); identical latency scores where an option does not affect latency; score-range check added to the script |
| F23 voice outside the slice | Real | Minimal dev-case voice session inside the Oct 18 slice; predeclared owner branches for access failure and integration failure |
| N01 budget grid | Real | Full grid across lineups and case counts; the all-in-$100 recommendation is the only option under $100 in the conservative case (40 x 1, power-first) |
| N02 fidelity denominator | Real | Primary fidelity over all evaluated subject turns, including invalid sessions; valid-session fidelity secondary |
| N03 accent claim | Real (minor) | Claim narrowed to "no acoustic features"; transcription and dialect effects acknowledged; matched-content voice fixtures before any voice fairness claim |

## New fact surfaced by the fixes
- `stats_contracts.py`: 59 truthful families are the minimum for a zero-false-positive one-sided 95% bound at or below 5%. The sponsor's 120-case plan (60 truthful families) is exactly that minimum, which now drives the budget recommendation.
