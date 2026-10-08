# Critique round 8 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only; ran all three scripts.
- **Target:** `02-direction.md` v9 (commit 985da98).
- **Verdict:** YELLOW. 0 blockers, 2 majors, 1 minor. R7-01, F01, R6-02 confirmed fixed; no regressions.

## Recurrence: the class is the bug
R5-01 (a hard bound on non-model GCP costs) was raised in rounds 5, 6, 7 and 8, and each fix (an envelope, usage caps, an instance-seconds ledger, a watchdog) was correctly shown not to be a guarantee: GCP has no project-wide spend cap, billable-usage metrics lag, Cloud Run can briefly exceed max-instances, and the polling watchdog itself cost ~$3.50 at gross rates (R8-01). Per red-to-root-cause, v10 fixes the class instead of the site: it stops claiming a hard non-model bound.

## Dispositions

| ID | Real? | Change in v10 |
| --- | --- | --- |
| R5-01 non-model bound | Real, and structurally unachievable on GCP | Non-model costs are minimized by design (single IAP-protected public service, IAM-private services, size caps, log exclusions, teardown), itemized at gross rates ($2.88 expected, $9.67 high), and given a $15 allowance set aside before model work; backstop: budget alerts at $25/$50/$65 and an event-driven billing-disable at $70. Only model and voice liabilities are claimed as hard-capped. |
| R8-01 watchdog cost | Real ($3.49 at gross rates with the one-minute job minimum) | Polling watchdog removed; the billing-disable backstop is event-driven and invoked only by budget notifications. |
| R8-02 IAP and cross-origin preflight (minor) | Real | Static web is served same-origin by `arena-api` behind IAP, so REST, SSE and WebSocket calls carry the IAP cookie with no cross-origin preflight; Firebase Hosting dropped. |

## Effect on the plan
With the larger, honest allowance, the plan that completes in the conservative case is 20 hidden cases (10 families): ~$37 expected, ~$63 conservative. 26 cases completes in the expected case (~$42) and is the target if the dev pilot's measured costs track it.
