# Critique round 1 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, model gpt-6-astra, reasoning xhigh, read-only sandbox, live web search (19 searches plus GDK and Context7 checks).
- **Target:** `02-direction.md` v1 (commit 7f0787c).
- **Verdict:** YELLOW. 0 blockers, 24 majors, 2 minors.
- **Raw output:** kept in the session scratchpad; findings reproduced below with dispositions.

## Root-cause classes (red-to-root-cause)

The 26 findings reduce to eight broken rules. v2 fixes each rule everywhere it applies, not only at the cited line.

| Class | Rule v1 broke | Findings |
| --- | --- | --- |
| R1 | Every number is reproducible from a script in the repo, for the lineup actually proposed | F01, F25 |
| R2 | Isolation is a credential boundary plus explicit projections; detectors are supplementary evidence, never proof | F02, F03, F06, F10, F21 |
| R3 | Locked owner constraints are pass/fail gates, not weighted criteria; a fallback that changes a locked decision needs owner sign-off | F05, F09, F19, F20 |
| R4 | Every metric states its estimand, independent unit, measurement point and edge-case handling before data exists | F08, F13, F14, F15, F16, F17, F18, F22 |
| R5 | Under request-based Cloud Run billing, all work finishes inside a request | F07 |
| R6 | Unmeasured quantities are carried as ranges, not scored as known | F08, F20 |
| R7 | Visibility rules are enforced in server projections, never by hiding UI | F21 |
| R8 | Ground truth is independent of the agent being scored | F16, F17 |

Findings F04, F11, F12, F23, F24 and F26 are single-instance fixes, recorded below.

## Dispositions

| ID | Real? | Change in v2 |
| --- | --- | --- |
| F01 cost arithmetic | Real. X8's Mix B is $0.0614/trial, not $0.0448 (recomputed). Full accounting is worse: the v1 lineup costs ~$190 expected. | `cost_model.py` added; section 8 rebuilt from its output; budget options put to the owner. |
| F02 release conditions | Real | Deterministic release predicates evaluated by a SECURITY DEFINER function that returns only newly authorized public evidence; the orchestrator's credential cannot read the predicates. |
| F03 isolation overclaimed | Real | Subject runtime moves to its own service and credential; the process that runs assistants holds a public-only credential; threat model added; canaries labeled supplementary. |
| F04 injection containment | Real | Containment claim removed; detected attacks stop and quarantine the trial, excluded from rankings; persistent-transcript attack tests; the harness only relays a single neutral question. |
| F05 external entrants | Real | Official leaderboard is arena-hosted Vertex candidates only; external A2A endpoints go to a labeled exhibition track. |
| F06 SSRF via A2A | Real | Manual HTTPS allowlist, resolved-IP checks, no redirects, byte and time limits, no credentials outbound, public-only process. |
| F07 async stage 2 | Real | Stage 2 runs inside the same open streaming request; results bound to the transcript version; finalized trials reject updates. |
| F08 latency claims | Real | KPI-4 measures a complete, validated card at the client, including cold starts, repairs and long contexts; one-call vs two-stage compared experimentally; latency carried as a range. |
| F09 voice probe and fallbacks | Real | Probe matrix (model x region x SDK x feature) with error classification; `gemini-live-2.5-flash-native-audio` is the compliant Live fallback; push-to-talk and Developer API both need an owner exception. |
| F10 voice leakage | Real | Voice runs on development cases only until a voice leakage policy passes; playback-aware transcript finalization; leaked sessions invalidated. |
| F11 Phoenix product and path | Real. The 25k-span free tier is Arize AX, a different product; hosted Phoenix Cloud status is contradictory across sources. | Self-hosted Phoenix on Cloud Run with Supabase Postgres; read-back verification after runs; tournament exports over OTLP/HTTP to that URL. |
| F12 spend guard | Real | One transactional reservation ledger for every model call; aggregate concurrency limits; invite-only judges; Pub/Sub budget alerts as secondary alarm only. |
| F13 statistics | Real | Estimand per metric; family is the cluster unit; zero-event fallback; one- and two-sided labels; bootstrap rank intervals; paired family bootstrap. |
| F14 partial repeats | Real | Complete, seeded, balanced blocks; budget reserved before a block starts; extra repeats preselected without outcomes; incomplete blocks reported. |
| F15 commitment protocol | Real | Canonical commitment payload defined; atomic finalization; reveal only after both tracks commit; hidden debriefs locked until reveal. |
| F16 self-reported tags | Real | Subject tags are proposals; an independent labeler labels every subject turn; one-to-one flag matching; duplicates count as false positives; budgeted. |
| F17 citation vs support | Real | Deterministic existence check plus a semantic support check; adversarial fixtures with real quotes and false claims. |
| F18 judge calibration | Real. The cited mapping gives 1-5, not 0-4. | Anchors authored and frozen on dev data; blinded human calibration with predeclared thresholds; 0-4 mapping; endpoints tested. |
| F19 straw baseline | Real | A3 becomes a credible contender (Conservative Corroborator); demeanor-driven outputs become negative-control fixtures outside the leaderboard. |
| F20 matrix bias | Real | Constraint gate first; anchored scores; equal protocol credit for in-process and A2A; ranges for unknowns; weight sensitivity shown. |
| F21 assessment visibility | Real | Mode-aware server projections withhold coaching and derived signals until assessment completes; tested on REST, SSE, reconnect, export. |
| F22 KPI-1 protocol | Real | Volunteer protocol with counterbalanced matched case sets, blinded scoring, participant-level results, baseline-zero rule. |
| F23 delivery feasibility | Real | Vertical slice first; dependency-gated schedule; explicit cut order; gokbase's Redis primitives replaced by Supabase transactions. |
| F24 A2A schema | Real (minor). X11 compared v1.0 with the v0.3 compatibility proto. | SDK 1.2.2 and spec v1.0 pinned separately; v1.0 `supportedInterfaces`; one conformance fixture before adoption. |
| F25 Live cost | Real. Live rebills accumulated context per turn. | Voice cost measured on a full 12-exchange session; caps enforced with conservative reservations. |
| F26 EX-4 and EVL-12 | Real (minor) | Acceptance criteria for the ground-rule statements and the NIST non-validation note. |

## Adopted alternatives
- Official competition uses arena-controlled Vertex candidates; A2A entrants go to an exhibition track.
- Benchmark one-call against two-stage coaching before committing to two stages.
- Try both Vertex Live models in documented regions before any exception.
- Static frontend on Firebase Hosting calling `arena-api` directly for SSE and WebSockets.
- Vertical slice with a few audited templates and deterministic disclosure rules before scaling domains.
- Narrow privileged operations and explicit projections; hash chains and canaries as supplementary audit evidence.

## Orchestrator verification
- Re-derived F01 by hand: subject 0.0117 + harness 0.00174 + labeling 0.0054 + assistant 0.0315 + final 0.0039375 + proxy 0.007125 = $0.0614025 per trial.
- Verified the Gemini 3.8 Live GA post (2026-09-24): Agent Platform, US and EU endpoints; prebuilt Live Avatar GA; custom avatars allowlist-only.
- Arize: AX Free (25k spans, 15-day retention) is a separate product from Phoenix; hosted Phoenix Cloud status is contradictory across sources, so v2 does not rely on it.
