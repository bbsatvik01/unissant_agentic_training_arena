# Critique round 7 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only; ran all three scripts.
- **Target:** `02-direction.md` v8 (commit 4e0332e).
- **Verdict:** YELLOW. 0 blockers, 1 major, 3 minors (rounds 1-6: 24, 12, 6, 5, 4, 2 majors).
- **Confirmed:** v8 figures reproduce; R6-01's advance whole-session voice reservation fixes the enforcement rule; corpus sealing, subject rotation and demo-allocation disclosure fixed; no regression in isolation, projections, playback grounding, trace durability, sealed inclusion, classification retention, attrition sensitivity or undiscounted liability pricing.

## Dispositions

| ID | Real? | Change in v9 |
| --- | --- | --- |
| R5-01 uncovered billing paths | Real. Cloud Run bills startup and any request that reaches a container, including ones the middleware rejects; Firebase Hosting CDN transfer never touches the application. | Deployment-level liability contract: static web on a separate unbilled Firebase Spark project (no overage possible); public Cloud Run services behind Identity-Aware Proxy so only invited Google accounts reach containers; other services IAM-private; a 15-minute watchdog on Cloud Run's own billable instance time (includes startup and shutdown) turns public ingress off at the allocation; residual exposure between checks reserved; non-model bound recomputed to $9.83 at gross rates. |
| R7-01 voice duration (minor) | Real. The conservative reference session (630 s) exceeded the 480 s limit. | Reference session is 12 exchanges of 12 s in and 14 s out: 468 s conservative, asserted against the limit along with the dollar shutoff. |
| F01 order (minor) | Real | Simulation runs the dev pilot before producing the replay corpus. |
| R6-02 stale lines (minor) | Real | Risk entry says 13 families; experiments ~$4-7. |

## Effect on the plan
26 hidden cases plus a 10-case dev pilot: ~$42 expected, ~$70 conservative, complete in both, every liability reserved or bounded at gross rates before it can be incurred.
