# Critique round 6 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only; ran all three scripts.
- **Target:** `02-direction.md` v7 (commit 50403ca).
- **Verdict:** YELLOW. 0 blockers, 2 majors, 2 minors (rounds 1-5: 24, 12, 6, 5, 4 majors).
- **Confirmed:** published cost, voice, matrix and statistics figures reproduce; R5-02, F15, R5-03 fixed; F25 rebilling fixed; no regression in isolation, projections, playback grounding, trace durability, labeling, fidelity denominators, classification retention or attrition sensitivity. Disclosed token and voice-price assumptions accepted pending measurement.

## Dispositions

| ID | Real? | Change in v8 |
| --- | --- | --- |
| R5-01 non-model bound | Real. The $8 envelope was an estimate without enforced cumulative limits, and the window started after the first paid probe. | `NON_MODEL_CAPS`: every line is quantity x gross rate (no free tier assumed) with an enforced cap: an instance-seconds ledger in the API middleware (requests and 5-minute SSE/WebSocket leases reserve timeout x resources against global caps), job task count x timeout, cleanup policies, size limits, log exclusions and volume caps. Upper bound $10.32, set aside before any model work; window 2026-10-09 (first probe) to teardown 2026-11-09. |
| R6-01 voice meter | Real. A retrospective meter cannot be a strict ceiling, and coaching and retranscription sat outside it. | Whole-session reservation ($1.64) computed from enforced limits (12 exchanges, 480 s audio, maximum context rebilled every turn, rates x1.5, coaching, retranscription), reserved before the session opens; meter shutoff at $1.09; probes reserve $0.13 each the same way. |
| F01 simulation coverage (minor) | Real | Whole replay corpus produced and sealed before scoring; subjects rotate by case. The demo bucket is labeled an aggregate allocation (conservative usage plus one in-flight voice reservation) with per-call guards inside it; the first attempt to pre-reserve every future demo call at worst case ($37.76) was wrong in principle and replaced, since reservations cover only work in flight. |
| R6-02 stale statements (minor) | Real | Sections 0, 6.4, 8.1 and 13.1 aligned with the d009 lineup (Pro generation for all families; 3.8 Flash unused; benchmark ~$1). |

## Effect on the plan
With every liability reserved before it can be incurred, the largest plan that completes in the conservative case is 26 hidden cases (13 families): ~$43 expected, ~$72 conservative. 30 cases completes only in the expected case and becomes the pilot-gated extension.
